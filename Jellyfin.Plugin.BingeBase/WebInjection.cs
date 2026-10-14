using System;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Net.Http.Headers;

namespace Jellyfin.Plugin.BingeBase;

/// <summary>Puts the middleware in front of Jellyfin's whole pipeline.</summary>
public class WebInjectionStartupFilter : IStartupFilter
{
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
    {
        return app =>
        {
            app.UseMiddleware<WebInjectionMiddleware>();
            next(app);
        };
    }
}

/// <summary>Adds the BingeBase script to web/index.html as it is served. Files on disk are untouched.</summary>
public class WebInjectionMiddleware
{
    private const string Marker = "data-bingebase-plugin";
    private static readonly Lazy<string> ScriptTag = new(() =>
    {
        using var stream = typeof(WebInjectionMiddleware).Assembly
            .GetManifestResourceStream("Jellyfin.Plugin.BingeBase.bingebase.js")
            ?? throw new InvalidOperationException("bingebase.js resource missing");
        using var reader = new StreamReader(stream, Encoding.UTF8);
        return "<script " + Marker + ">" + reader.ReadToEnd() + "</script>";
    });

    private readonly RequestDelegate _next;

    public WebInjectionMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        if (!IsIndexRequest(context.Request))
        {
            await _next(context).ConfigureAwait(false);
            return;
        }

        // Get the plain file: no compression, no 304, no ranges.
        var headers = context.Request.Headers;
        headers.Remove(HeaderNames.AcceptEncoding);
        headers.Remove(HeaderNames.IfNoneMatch);
        headers.Remove(HeaderNames.IfModifiedSince);
        headers.Remove(HeaderNames.Range);

        var original = context.Response.Body;
        using var buffer = new MemoryStream();
        context.Response.Body = buffer;
        try
        {
            await _next(context).ConfigureAwait(false);
        }
        finally
        {
            context.Response.Body = original;
        }

        buffer.Position = 0;
        var response = context.Response;
        bool isHtml = response.StatusCode == StatusCodes.Status200OK
            && (response.ContentType?.StartsWith("text/html", StringComparison.OrdinalIgnoreCase) ?? false);

        if (!isHtml)
        {
            await buffer.CopyToAsync(original, context.RequestAborted).ConfigureAwait(false);
            return;
        }

        string html = Encoding.UTF8.GetString(buffer.GetBuffer(), 0, (int)buffer.Length);
        if (!html.Contains(Marker, StringComparison.Ordinal))
        {
            int idx = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
            html = idx >= 0 ? html.Insert(idx, ScriptTag.Value) : html + ScriptTag.Value;
        }

        byte[] bytes = Encoding.UTF8.GetBytes(html);
        response.ContentLength = bytes.Length;
        response.Headers.Remove(HeaderNames.ETag);
        response.Headers.Remove(HeaderNames.LastModified);
        await original.WriteAsync(bytes, context.RequestAborted).ConfigureAwait(false);
    }

    private static bool IsIndexRequest(HttpRequest request)
    {
        if (!HttpMethods.IsGet(request.Method))
        {
            return false;
        }

        string path = request.Path.Value ?? string.Empty;
        return path.EndsWith("/web/index.html", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith("/web/", StringComparison.OrdinalIgnoreCase);
    }
}
