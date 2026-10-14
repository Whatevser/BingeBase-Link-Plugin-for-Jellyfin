(function () {
    'use strict';
    if (window.__bingebasePlugin) { return; }
    window.__bingebasePlugin = true;

    var TYPES = ['Movie', 'Series', 'Season', 'Episode', 'Person'];
    var FILTERS = { Movie: 'movies', Series: 'shows', Person: 'people' };
    var TITLE = 'BingeBase';
    var ICON = '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true" style="display:block;margin:auto">'
        + '<path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>';

    var items = new Map();  // id -> Promise<item>
    var urls = new Map();   // id -> url | null (resolved)

    function getItem(id) {
        if (!items.has(id)) {
            var api = window.ApiClient;
            var p = api.getItem(api.getCurrentUserId(), id);
            p.catch(function () { items.delete(id); });
            items.set(id, p);
        }
        return items.get(id);
    }

    function hasNonAsciiLetter(s) { return /(?![\u0000-\u007F])\p{L}/u.test(s); }

    // BingeBase titles are English (TMDB): prefer the original title when the library title is localized.
    function pickTitle(item) {
        var name = (item.Name || '').trim();
        var original = (item.OriginalTitle || '').trim();
        if (name && original && hasNonAsciiLetter(name) && !hasNonAsciiLetter(original)) { return original; }
        return name || original;
    }

    function resolveUrl(id) {
        if (urls.has(id)) { return Promise.resolve(urls.get(id)); }
        return getItem(id).then(function (item) {
            if ((item.Type === 'Season' || item.Type === 'Episode') && item.SeriesId) {
                return getItem(item.SeriesId);
            }
            return item;
        }).then(function (item) {
            var filter = FILTERS[item.Type];
            var title = filter ? pickTitle(item) : '';
            var url = title
                ? 'https://bingebase.com/search?query=' + encodeURIComponent(title) + '&filter=' + filter
                : null;
            urls.set(id, url);
            return url;
        });
    }

    function openFor(id) {
        if (!id) { return; }
        if (urls.has(id)) {
            var url = urls.get(id);
            if (url) { window.open(url, '_blank', 'noopener'); }
            return;
        }
        // Open synchronously (inside the click) so popup blockers allow it, then navigate.
        var win = window.open('about:blank', '_blank');
        resolveUrl(id).then(function (u) {
            if (!win) { if (u) { window.open(u, '_blank', 'noopener'); } return; }
            if (!u) { win.close(); return; }
            win.opener = null;
            win.location.href = u;
        }).catch(function (e) {
            if (win) { win.close(); }
            console.error('[BingeBase]', e);
        });
    }

    function stop(e) { e.preventDefault(); e.stopPropagation(); }

    // ---- Item detail page: next to the Played / Favorite buttons ----
    function currentDetailId() {
        var hash = window.location.hash || '';
        if (hash.indexOf('#/details') !== 0) { return null; }
        return new URLSearchParams(hash.split('?')[1] || '').get('id');
    }

    function syncDetail() {
        var id = currentDetailId();
        if (!id || !window.ApiClient) { return; }
        document.querySelectorAll('#itemDetailPage:not(.hide) .mainDetailButtons').forEach(function (row) {
            var btn = row.querySelector('.bingebaseButton');
            if (!btn) {
                btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'button-flat detailButton emby-button bingebaseButton hide';
                btn.title = TITLE;
                btn.setAttribute('aria-label', TITLE);
                btn.innerHTML = '<div class="detailButton-content"><span class="material-icons detailButton-icon" aria-hidden="true">' + ICON + '</span></div>';
                btn.addEventListener('click', function (e) { stop(e); openFor(btn.getAttribute('data-id')); });
                var fav = row.querySelector('.btnUserRating');
                row.insertBefore(btn, fav ? fav.nextSibling : null);
            }
            if (btn.getAttribute('data-id') === id) { return; }
            btn.setAttribute('data-id', id);
            btn.classList.add('hide');
            resolveUrl(id).then(function (url) {
                if (url && btn.getAttribute('data-id') === id) { btn.classList.remove('hide'); }
            }).catch(function (e) { console.error('[BingeBase]', e); });
        });
    }

    // ---- Cards in lists/grids: in the hover button group (Played / Favorite / More) ----
    function cardIdOf(el) {
        var card = el.closest('.card[data-id]');
        return card ? card.getAttribute('data-id') : null;
    }

    function syncCards() {
        document.querySelectorAll('div.cardOverlayButton-br:not([data-bingebase])').forEach(function (group) {
            group.setAttribute('data-bingebase', '');
            var card = group.closest('.card[data-id]');
            // Cast/crew cards have the role (Actor, Director...) as data-type but always the personCard class.
            if (!card || (TYPES.indexOf(card.getAttribute('data-type')) < 0 && !card.classList.contains('personCard'))) { return; }

            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'paper-icon-button-light cardOverlayButton cardOverlayButton-hover bingebaseButton';
            btn.title = TITLE;
            btn.setAttribute('aria-label', TITLE);
            btn.innerHTML = '<span class="material-icons cardOverlayButtonIcon cardOverlayButtonIcon-hover" aria-hidden="true">' + ICON + '</span>';
            btn.addEventListener('pointerenter', function () {
                var id = cardIdOf(btn);
                if (id) { resolveUrl(id).catch(function () {}); }
            });
            btn.addEventListener('click', function (e) { stop(e); openFor(cardIdOf(btn)); });
            // Keep the "more" (⋮) button last.
            group.insertBefore(btn, group.lastElementChild);
        });
    }

    var scheduled = false;
    function schedule() {
        if (scheduled) { return; }
        scheduled = true;
        requestAnimationFrame(function () {
            scheduled = false;
            try { syncDetail(); syncCards(); } catch (e) { console.error('[BingeBase]', e); }
        });
    }

    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('viewshow', schedule, true);
    window.addEventListener('hashchange', schedule);
    schedule();
})();
