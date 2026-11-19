// The search at the top of the settings pages' rail: it lists every section of every settings page, narrows as you type
// (settingsIndex.cjs says what each is called and what people call it), and takes you to the section, on its page.
(function () {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;
  const Index = window.WoodshedSettingsIndex;

  // A page the person cannot open is left out: the console's own pages are an admin's, and People is not there behind a
  // hosting proxy unless the program hands over its list. A page under Settings (its tabs, People behind a proxy among
  // them, Webhook events) is in its entry's `also`.
  const allowed = (page) => !Index.PAGES[page].admin
    || (W.isAdmin() && W.consoleLinks().some((link) => link.href === page || Boolean(link.also?.includes(page))));

  /**
   * Scrolls to a section's card and outlines it for a moment; once the page has drawn it, since its cards come late. A
   * page draws itself again as its reads come back (Settings when its repos arrive), with a new card each time, so the
   * outline is put on each new one until its moment is over.
   */
  function reveal(id) {
    let shown = false;
    const mark = () => {
      const target = document.getElementById(id);
      if (!target) return;
      // Some cards carry the id on their heading.
      const el = target.closest('section, form') ?? target;
      el.classList.add('is-found');
      if (shown) return;
      shown = true;
      el.scrollIntoView({ block: 'start' });
      setTimeout(stop, 2500);
    };
    const watch = new MutationObserver(mark);
    const stop = () => {
      watch.disconnect();
      document.getElementById(id)?.closest('section, form')?.classList.remove('is-found');
      document.getElementById(id)?.classList.remove('is-found');
    };
    watch.observe(document.getElementById('app'), { childList: true, subtree: true });
    mark();
    setTimeout(() => { if (!shown) stop(); }, 8000);
  }

  // Arriving from the search (or a link) on another page, whether loaded or shown in place (common.js, settingsPage):
  // its section, once drawn.
  window.addEventListener('woodshed:settings-shown', () => {
    if (window.location.hash && Index.ENTRIES.some((e) => e.page === window.location.pathname && `#${e.id}` === window.location.hash)) {
      reveal(window.location.hash.slice(1));
    }
  });

  /** @param {string} page  a settings page's path, for the words that say whose sessions it changes */
  function scopePill(page) {
    const you = Index.PAGES[page].scope === 'you';
    return h('span', { class: 'pill', title: you ? 'Changes your My Woodshed sessions only' : 'Changes every shared session, and the console' },
      you ? 'Only you' : 'Everyone');
  }

  let node = null;
  let keepFocus = null;
  /**
   * One search for the page, kept between its redraws so what is typed stays. A redraw takes the box out of the page
   * and puts it back, which drops its focus; pages that redraw on a timer (Webhook events, People) would close it under
   * someone typing, so a redraw that finds it focused gives the focus, the caret and the open list back once it is in.
   */
  function settingsSearch() {
    if (node) {
      if (node.contains(document.activeElement)) keepFocus();
      return node;
    }
    let active = -1;
    let results = [];
    const input = h('input', {
      id: 'settings-search', class: 'field ssearch-input', type: 'search', autocomplete: 'off', spellcheck: 'false',
      placeholder: 'Find a setting…', role: 'combobox', 'aria-expanded': 'false',
      'aria-controls': 'settings-search-list', 'aria-label': 'Find a setting',
    });
    const list = h('div', { id: 'settings-search-list', class: 'ssearch-list', role: 'listbox', hidden: true });
    node = h('div', { class: 'ssearch' }, input, list);
    let redrawing = false;
    keepFocus = () => {
      if (redrawing) return;
      redrawing = true;
      const open = !list.hidden;
      const { selectionStart, selectionEnd } = input;
      queueMicrotask(() => {
        redrawing = false;
        if (!input.isConnected) return;
        if (document.activeElement !== input) {
          input.focus({ preventScroll: true });
          try { input.setSelectionRange(selectionStart, selectionEnd); } catch { /* a type that has no caret */ }
        }
        setOpen(open);
      });
    };

    function go(entry, event) {
      if (entry.page === window.location.pathname) {
        event?.preventDefault();
        window.history.replaceState(null, '', `#${entry.id}`);
        setOpen(false);
        reveal(entry.id);
      } else if (!event) {
        setOpen(false);
        W.goToSettings(entry.href);
      }
    }
    function setOpen(open) {
      list.hidden = !open;
      input.setAttribute('aria-expanded', String(open));
    }
    function draw() {
      results = Index.search(input.value, { allowed });
      active = results.length ? Math.min(Math.max(active, 0), results.length - 1) : -1;
      if (!results.length) {
        list.replaceChildren(h('p', { class: 'ssearch-none' }, `Nothing matches "${input.value.trim()}". Try one word: repo, token, slack, database, timeout.`));
        return;
      }
      const typed = input.value.trim() !== '';
      let lastPage = null;
      list.replaceChildren(...results.flatMap((entry, i) => {
        const head = !typed && entry.page !== lastPage ? [h('div', { class: 'ssearch-group' }, entry.pageLabel, h('span', { class: 'pill' }, entry.scope === 'you' ? 'Only you' : 'Everyone'))] : [];
        lastPage = entry.page;
        return [...head, h('a', {
          class: 'ssearch-item', href: entry.href, role: 'option', id: `ssearch-${i}`, 'aria-selected': String(i === active),
          onclick: (e) => go(entry, e), onmousemove: () => { if (active !== i) { active = i; mark(); } },
        },
          h('span', { class: 'ssearch-title' }, entry.title, typed && h('span', { class: 'pill' }, `${entry.pageLabel} · ${entry.scope === 'you' ? 'only you' : 'everyone'}`)),
          h('span', { class: 'ssearch-note' }, entry.note))];
      }));
      mark();
    }
    function mark() {
      list.querySelectorAll('.ssearch-item').forEach((el, i) => {
        el.setAttribute('aria-selected', String(i === active));
        if (i === active) { input.setAttribute('aria-activedescendant', el.id); el.scrollIntoView({ block: 'nearest' }); }
      });
    }
    input.addEventListener('focus', () => { draw(); setOpen(true); });
    input.addEventListener('input', () => { active = 0; draw(); setOpen(true); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { setOpen(false); input.blur(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (list.hidden) { draw(); setOpen(true); }
        if (results.length) active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
        mark();
      } else if (e.key === 'Enter' && results[active]) {
        e.preventDefault();
        go(results[active]);
      }
    });
    node.addEventListener('focusout', (e) => { if (!redrawing && !node.contains(e.relatedTarget)) setOpen(false); });
    // A page learns it is an admin's late: the list is drawn again then.
    window.addEventListener('woodshed:me', () => { if (!list.hidden) draw(); });
    return node;
  }

  W.settingsSearch = settingsSearch;
  W.scopePill = scopePill;
  W.revealSection = reveal;
})();
