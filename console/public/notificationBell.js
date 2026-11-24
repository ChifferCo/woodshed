// The rail head's bell, in the desktop app only: the notifications the app showed, newest first, each opening its
// session (desktop/notificationLog.mjs keeps them, desktop/preload.cjs hands them over as window.woodshedNotifications).
// A browser has no such bridge, and no bell. designSystem/components/NotificationBell.
(function () {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;
  const BELL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>';
  // Each kind's dot, in the rail's colours: yellow only for what needs the person, as on a card.
  const DOTS = { 'needs-you': 'is-needs', failed: 'is-failed', done: 'is-done', merged: 'is-done', review: 'is-done', qa: 'is-done' };

  function when(at) {
    const ms = Date.now() - at;
    return ms < 60_000 ? 'just now' : W.ago(new Date(at).toISOString());
  }

  /**
   * @param {{ navigate: (href: string) => void }} opts  how the page opens a session
   * @returns {HTMLElement|null}  the bell and its list, or null outside the desktop app
   */
  function create({ navigate }) {
    const bridge = window.woodshedNotifications;
    if (!bridge || typeof bridge.list !== 'function') return null;
    let list = { items: [], unread: 0 };
    // What was new when the list was opened: opening it marks everything read, and these keep their mark until it closes.
    let newOnOpen = new Set();
    const count = h('span', { class: 'bell-count', hidden: true });
    const button = h('button', { type: 'button', class: 'rail-bell', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'data-hint': 'Notifications' });
    button.innerHTML = BELL_ICON;
    button.append(count);
    const rows = h('div', { class: 'bell-rows' });
    const panel = h('div', { class: 'bell-list', role: 'region', 'aria-label': 'Notifications', hidden: true },
      h('div', { class: 'menu-label' }, 'Notifications'), rows);
    const el = h('div', { class: 'rail-bell-wrap' }, button, panel);

    function drawButton() {
      count.hidden = !list.unread;
      count.textContent = list.unread > 99 ? '99+' : String(list.unread);
      const label = list.unread ? `Notifications, ${list.unread} new` : 'Notifications';
      button.setAttribute('aria-label', label);
      button.dataset.hint = label;
    }
    function drawRows() {
      if (!list.items.length) {
        rows.replaceChildren(h('p', { class: 'bell-empty' }, 'Nothing yet. What this app notifies you of shows here too.'));
        return;
      }
      rows.replaceChildren(...list.items.map((n) => {
        const fresh = !n.read || newOnOpen.has(n.key);
        return h('a', {
          class: `bell-item${fresh ? ' is-new' : ''}`, href: `/s/${encodeURIComponent(n.id)}`,
          onclick: (e) => {
            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            setOpen(false);
            bridge.markRead(n.key);
            navigate(`/s/${encodeURIComponent(n.id)}`);
          },
        },
        h('span', { class: `bell-dot ${DOTS[n.kind] || 'is-other'}`, 'aria-hidden': 'true' }),
        h('span', { class: 'bell-text' },
          h('b', { class: 'bell-title' }, n.title),
          h('span', { class: 'bell-body' }, n.body),
          h('span', { class: 'bell-when' }, when(n.at))));
      }));
    }
    function show(next) {
      if (!next || !Array.isArray(next.items)) return;
      list = next;
      drawButton();
      if (!panel.hidden) drawRows();
    }
    function setOpen(open) {
      panel.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
      if (!open) {
        newOnOpen = new Set();
        return;
      }
      newOnOpen = new Set(list.items.filter((n) => !n.read).map((n) => n.key));
      drawRows();
      if (list.unread) bridge.markRead();
    }
    button.addEventListener('click', () => setOpen(panel.hidden));
    document.addEventListener('click', (e) => { if (!panel.hidden && !el.contains(e.target)) setOpen(false); });
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || panel.hidden) return;
      setOpen(false);
      button.focus();
    });
    bridge.onChange?.(show);
    bridge.list().then(show).catch(() => {});
    drawButton();
    return el;
  }

  W.notificationBell = create;
})();
