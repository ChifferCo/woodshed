// The desktop app's notifications, for the console in a browser: the same bridge the app's preload hands the page
// (desktop/preload.cjs: list, markRead, onChange, onArrived), so the bell, ⌘J and the cards (notificationBell.js) work
// here too. The desktop app has its own, and this does nothing there.
//
// What notifies is the app's rule, desktop/attention.mjs, served as /static/attention.mjs and read on the same
// /api/sessions every 20 s. One tab of the browser reads (a Web Lock; another takes over when it closes), and every tab
// shares the list through localStorage, for this person alone. A notification shows as a card in the tab that has the
// focus; with none, as the browser's own notification once the person has allowed them (askPermission), and nowhere
// else. Opening a session, in any tab, marks its notifications read.
(function () {
  'use strict';
  const W = window.Woodshed;
  if (window.woodshedNotifications) return;
  const login = document.querySelector('meta[name="woodshed-login"]')?.content;
  const attentionUrl = document.currentScript?.dataset.attention;
  if (!login || !attentionUrl) return;
  try {
    localStorage.getItem('woodshed-probe');
  } catch {
    // No storage (a private window that refuses it): no list to share, and no bell.
    return;
  }
  const STORE = `woodshed-notifications:${login}`;
  const POLL_MS = 20_000;
  const MAX = 50;
  // Another tab took a notification for a card within this long: the browser's own is not shown.
  const CLAIM_MS = 600;
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(STORE) : null;
  const changeFns = new Set();
  const arrivedFns = new Set();

  // ---- the list, in localStorage: every tab of this person's reads and marks it ----
  function load() {
    try {
      const items = JSON.parse(localStorage.getItem(STORE) || 'null')?.items;
      return Array.isArray(items) ? items.filter((e) => e && typeof e.key === 'string') : [];
    } catch {
      return [];
    }
  }
  function save(items) {
    try {
      localStorage.setItem(STORE, JSON.stringify({ items }));
    } catch {
      // Full or refused: the list stays as it was.
    }
  }
  const snapshot = (items = load()) => ({ items: items.map((e) => ({ ...e })), unread: items.filter((e) => !e.read).length });
  function changed() {
    const list = snapshot();
    for (const fn of changeFns) fn(list);
  }
  // Another tab's change arrives as a storage event; this tab's own is told here.
  window.addEventListener('storage', (e) => { if (e.key === STORE) changed(); });
  function update(change) {
    const items = load();
    if (!change(items)) return;
    save(items);
    changed();
  }
  function markRead(key = null) {
    update((items) => {
      let any = false;
      for (const e of items) {
        if (e.read || (key !== null && e.key !== key)) continue;
        e.read = true;
        any = true;
      }
      return any;
    });
  }

  // ---- what this tab shows ----
  const shownId = () => /^\/s\/([0-9a-f]{8})$/.exec(location.pathname)?.[1] ?? null;
  const looking = () => document.visibilityState === 'visible' && document.hasFocus();
  // The session this tab shows, opened: its notifications are read, here and in the browser's list.
  function opened() {
    const id = shownId();
    if (!id || document.visibilityState !== 'visible') return;
    update((items) => {
      let any = false;
      for (const e of items) {
        if (e.read || e.id !== id) continue;
        e.read = true;
        any = true;
      }
      return any;
    });
    closeShown(id);
    channel?.postMessage({ type: 'opened', id });
  }
  window.addEventListener('woodshed:route', opened);
  window.addEventListener('focus', opened);
  document.addEventListener('visibilitychange', opened);

  // A notification that arrived: a card in the tab that has the focus, or nothing for the session it already shows.
  function arrivedHere(entry) {
    if (!looking()) return;
    channel?.postMessage({ type: 'claimed', key: entry.key });
    claimed.add(entry.key);
    if (shownId() === entry.id) return markRead(entry.key);
    for (const fn of arrivedFns) fn({ ...entry });
  }
  const claimed = new Set();
  channel?.addEventListener('message', (e) => {
    const m = e.data;
    if (m?.type === 'arrived' && m.entry) arrivedHere(m.entry);
    else if (m?.type === 'claimed') claimed.add(m.key);
    else if (m?.type === 'opened') closeShown(m.id);
  });

  // ---- the browser's own notifications, once allowed, for what no tab in front took ----
  const canNotify = () => typeof Notification === 'function';
  const shown = new Map();
  function closeShown(id) {
    for (const [n, of] of shown) {
      if (of !== id) continue;
      shown.delete(n);
      n.close();
    }
  }
  function notify(entry) {
    if (!canNotify() || Notification.permission !== 'granted' || claimed.has(entry.key)) return;
    if (load().find((e) => e.key === entry.key)?.read) return;
    let n;
    try {
      n = new Notification(entry.title, { body: entry.body, tag: entry.key, icon: '/favicon-32.png' });
    } catch {
      // Some browsers allow them only from a service worker (Chrome on Android): the list and the cards still have it.
      return;
    }
    shown.set(n, entry.id);
    n.onclose = () => shown.delete(n);
    n.onclick = () => {
      window.focus();
      n.close();
      markRead(entry.key);
      (W.navigate ?? ((to) => { window.location.href = to; }))(`/s/${encodeURIComponent(entry.id)}`);
    };
  }

  // ---- the reading, in one tab ----
  let seen = null;
  let first = true;
  let rules = null;
  async function poll() {
    try {
      rules ??= await import(attentionUrl);
      const res = await fetch('/api/sessions', { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
      if (!res.ok || !String(res.headers.get('content-type')).includes('json')) return;
      const body = await res.json();
      if (!body || !Array.isArray(body.sessions)) return;
      const { now, notify: rings } = rules.attention(body, seen, { first, enabled: rules.enabledKinds() });
      seen = now;
      first = false;
      for (const n of rings) {
        const entry = {
          key: `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
          id: String(n.id), kind: String(n.kind), title: String(n.title), body: String(n.body), at: Date.now(), read: false,
        };
        update((items) => {
          items.unshift(entry);
          items.splice(MAX);
          return true;
        });
        channel?.postMessage({ type: 'arrived', entry });
        arrivedHere(entry);
        setTimeout(() => notify(entry), CLAIM_MS);
      }
    } catch {
      // The console not answering, or an answer the rules could not read: the next read tries again.
    } finally {
      setTimeout(poll, POLL_MS);
    }
  }
  // One tab reads for the browser: the one holding the lock, until it closes. A browser with no Web Locks reads in each.
  if (navigator.locks?.request) navigator.locks.request(STORE, () => { poll(); return new Promise(() => {}); }).catch(() => {});
  else poll();
  opened();

  W.browserNotifications = {
    list: async () => snapshot(),
    markRead: async (key) => markRead(typeof key === 'string' ? key : null),
    onChange: (fn) => { changeFns.add(fn); return () => changeFns.delete(fn); },
    onArrived: (fn) => { arrivedFns.add(fn); return () => arrivedFns.delete(fn); },
    // Whether the browser's own notifications can still be asked for, and asking: once, from a click (notificationBell.js).
    canAsk: () => canNotify() && Notification.permission === 'default',
    askPermission: async () => (canNotify() ? Notification.requestPermission() : 'denied'),
  };
})();
