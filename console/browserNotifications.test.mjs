// The console's notifications in a browser (public/browserNotifications.js), run as the page loads it, in tabs of one
// made-up browser: a shared localStorage that tells the other tabs of each write, a BroadcastChannel, one Web Lock, the
// browser's Notification recorded rather than shown, and timers the test runs by hand. The rule for what notifies is
// the real desktop/attention.mjs, loaded by the script's own import().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./public/browserNotifications.js', import.meta.url), 'utf8');
const ATTENTION = new URL('../desktop/attention.mjs', import.meta.url).href;
const wait = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function until(check, what) {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await wait();
  }
  assert.fail(`timed out waiting for ${what}`);
}

function events() {
  const listeners = {};
  return {
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    dispatch(type, ev = {}) { for (const fn of listeners[type] ?? []) fn(ev); },
  };
}

function makeBrowser({ permission = 'default' } = {}) {
  const store = new Map();
  const tabs = [];
  const channels = new Set();
  const lock = { held: null, queue: [] };
  const browser = {
    permission,
    shown: [],
    sessions: [{ id: 'aaaa1111', title: 'Fix CSV upload', status: 'running', state: 'working', owner: 'octocat' }],
    tabs,
    stored: () => JSON.parse(store.get('woodshed-notifications:octocat') ?? '{"items":[]}').items,
    open,
  };

  function open(pathname, { focused = false } = {}) {
    const tab = { focused, timers: [], cards: [], changes: [], navigated: [] };
    const win = events();
    const doc = events();
    const localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => {
        store.set(k, String(v));
        // As a browser does: every other tab of the origin hears of it, never the one that wrote.
        for (const other of tabs) if (other !== tab) other.win.dispatch('storage', { key: k });
      },
    };
    class BroadcastChannel {
      constructor(name) {
        this.name = name;
        this.listeners = [];
        this.tab = tab;
        channels.add(this);
      }
      addEventListener(type, fn) { if (type === 'message') this.listeners.push(fn); }
      postMessage(data) {
        for (const c of channels) {
          if (c === this || c.name !== this.name || c.tab.closed) continue;
          queueMicrotask(() => { for (const fn of c.listeners) fn({ data: structuredClone(data) }); });
        }
      }
    }
    const locks = {
      request(name, fn) {
        if (lock.held) return new Promise(() => lock.queue.push({ tab, fn }));
        lock.held = tab;
        return Promise.resolve(fn());
      },
    };
    class Notification {
      constructor(title, opts) {
        this.title = title;
        this.opts = opts;
        this.closed = false;
        browser.shown.push(this);
      }
      close() { this.closed = true; }
      static get permission() { return browser.permission; }
      static async requestPermission() { browser.permission = 'granted'; return 'granted'; }
    }
    const fetch = async (url) => {
      assert.equal(url, '/api/sessions');
      const body = { login: 'octocat', sessions: structuredClone(browser.sessions) };
      return { ok: true, headers: { get: () => 'application/json; charset=utf-8' }, json: async () => body };
    };
    const location = { pathname };
    const document = {
      ...doc,
      visibilityState: 'visible',
      hasFocus: () => tab.focused,
      currentScript: { dataset: { attention: ATTENTION } },
      querySelector: (sel) => (sel === 'meta[name="woodshed-login"]' ? { content: 'octocat' } : null),
    };
    const Woodshed = { navigate: (to) => { tab.navigated.push(to); location.pathname = to; } };
    const context = {
      ...win, document, location, localStorage, BroadcastChannel, Notification, fetch, Woodshed,
      navigator: { locks },
      focus() {},
      setTimeout: (fn, ms) => { tab.timers.push({ fn, ms }); return tab.timers.length; },
      queueMicrotask, structuredClone, console, Date, JSON, Math, Promise, String, Array, Set, Map, Number, Boolean,
    };
    context.window = context;
    Object.assign(tab, { win, document, location, context });
    tabs.push(tab);
    vm.runInContext(source, vm.createContext(context), { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
    tab.api = context.Woodshed.browserNotifications;
    tab.api.onArrived((n) => tab.cards.push(n));
    tab.api.onChange((list) => tab.changes.push(list));
    // Runs this tab's timers set for `ms`, as if that long went by.
    tab.run = (ms) => {
      const due = tab.timers.filter((t) => t.ms === ms);
      tab.timers = tab.timers.filter((t) => t.ms !== ms);
      for (const t of due) t.fn();
    };
    tab.go = (path) => {
      location.pathname = path;
      win.dispatch('woodshed:route');
    };
    return tab;
  }
  return browser;
}

// The reading tab has read once (the baseline, which notifies of nothing) and waits for its next read.
const firstReadDone = (tab) => until(() => tab.timers.some((t) => t.ms === 20_000), 'the first read');
// The reading tab reads again, after the session turned to needs you.
async function needsYou(browser, reader) {
  browser.sessions[0].state = 'needs-you';
  const before = browser.stored().length;
  reader.run(20_000);
  await until(() => browser.stored().length > before, 'the new notification');
  await wait();
}

test('one tab reads; a session that starts needing you is listed, new, in every tab, and each tab is told', async () => {
  const browser = makeBrowser();
  const reader = browser.open('/s/bbbb2222');
  const other = browser.open('/all');
  await firstReadDone(reader);
  assert.equal(other.timers.some((t) => t.ms === 20_000), false, 'the second tab waits for the lock, and reads nothing');
  assert.deepEqual(browser.stored(), [], 'the first read notifies of nothing');
  await needsYou(browser, reader);
  for (const tab of [reader, other]) {
    const { items, unread } = await tab.api.list();
    assert.equal(unread, 1);
    assert.deepEqual(items.map((e) => [e.id, e.kind, e.title, e.read]), [['aaaa1111', 'needs-you', 'Fix CSV upload', false]]);
    assert.equal(tab.changes.at(-1)?.unread, 1, 'onChange was called with the new list');
  }
});

test('a card shows only in the tab that has the focus, and then the browser\'s own notification is not shown', async () => {
  const browser = makeBrowser({ permission: 'granted' });
  const reader = browser.open('/s/bbbb2222');
  const focused = browser.open('/all', { focused: true });
  await firstReadDone(reader);
  await needsYou(browser, reader);
  assert.deepEqual(focused.cards.map((n) => n.id), ['aaaa1111']);
  assert.deepEqual(reader.cards, [], 'not in the tab behind');
  reader.run(600);
  assert.deepEqual(browser.shown, [], 'a tab in front took it');
});

test('with no tab in front, one browser notification, once allowed; its click opens the session and reads it', async () => {
  const browser = makeBrowser({ permission: 'granted' });
  const reader = browser.open('/s/bbbb2222');
  const other = browser.open('/all');
  await firstReadDone(reader);
  await needsYou(browser, reader);
  assert.deepEqual([reader.cards, other.cards], [[], []]);
  reader.run(600);
  other.run(600);
  assert.equal(browser.shown.length, 1, 'one, from the reading tab alone');
  assert.equal(browser.shown[0].title, 'Fix CSV upload');
  assert.match(browser.shown[0].opts.body, /^Needs you/);
  browser.shown[0].onclick();
  assert.deepEqual(reader.navigated, ['/s/aaaa1111']);
  assert.equal(browser.shown[0].closed, true);
  assert.equal((await other.api.list()).unread, 0);

  // Not allowed yet: nothing shown, and the list can ask.
  const asking = makeBrowser();
  const tab = asking.open('/all');
  await firstReadDone(tab);
  await needsYou(asking, tab);
  tab.run(600);
  assert.deepEqual(asking.shown, []);
  assert.equal(tab.api.canAsk(), true);
  assert.equal(await tab.api.askPermission(), 'granted');
  assert.equal(tab.api.canAsk(), false);
});

test('opening a session, in any tab, marks its notifications read and closes the browser\'s', async () => {
  const browser = makeBrowser({ permission: 'granted' });
  const reader = browser.open('/s/bbbb2222');
  const other = browser.open('/all');
  await firstReadDone(reader);
  await needsYou(browser, reader);
  reader.run(600);
  assert.equal(browser.shown.length, 1);
  other.go('/s/aaaa1111');
  await wait();
  for (const tab of [reader, other]) assert.equal((await tab.api.list()).unread, 0);
  assert.equal(browser.shown[0].closed, true, 'the reading tab closed it, told by the other');

  // A tab in front already showing the session: read at once, and no card.
  const looking = makeBrowser();
  const tab = looking.open('/s/aaaa1111', { focused: true });
  await firstReadDone(tab);
  await needsYou(looking, tab);
  assert.deepEqual(tab.cards, []);
  assert.equal((await tab.api.list()).unread, 0);
});

test('Mark all read and one entry\'s read reach every tab', async () => {
  const browser = makeBrowser();
  const reader = browser.open('/s/bbbb2222');
  const other = browser.open('/all');
  await firstReadDone(reader);
  await needsYou(browser, reader);
  const [entry] = (await other.api.list()).items;
  await other.api.markRead(entry.key);
  assert.equal((await reader.api.list()).unread, 0);
  assert.equal(reader.changes.at(-1).unread, 0, 'the reading tab was told by the storage event');
});
