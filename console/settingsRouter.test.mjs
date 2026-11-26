// The settings pages as one page (public/common.js, settingsPage): common.js run the way a page loads it, over a
// stand-in document whose nodes move as the browser's do (a node appended elsewhere leaves its old parent), with two
// made-up settings pages. Moving between them in place, what ends with a page left behind, the clicks left to the
// browser, a page that throws as it starts, Back and Forward, and the search's way in (goToSettings).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('./public/common.js', import.meta.url), 'utf8');
const hostSource = fs.readFileSync(new URL('./public/hostSettings.js', import.meta.url), 'utf8');
const ORIGIN = 'http://console.test';

class Node {
  constructor() { this.parent = null; }
  get isConnected() { let n = this; while (n.parent) n = n.parent; return n.isRoot === true; }
}
class Text extends Node {
  constructor(text) { super(); this.text = String(text); }
  get textContent() { return this.text; }
}

// `a.b.c[d]`: a tag, classes and attributes that must be there.
function matches(el, selector) {
  const m = /^([a-z][a-z0-9]*)?((?:\.[\w-]+)*)((?:\[[\w-]+\])*)$/.exec(selector);
  if (!m) throw new Error(`the stand-in cannot read ${selector}`);
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  const classes = el.className.split(/\s+/);
  if (m[2] && !m[2].split('.').slice(1).every((c) => classes.includes(c))) return false;
  return (m[3].match(/[\w-]+/g) ?? []).every((a) => a in el.attrs);
}

function makeDom(location) {
  class El extends Node {
    constructor(tag) {
      super();
      this.tagName = tag.toUpperCase();
      this.attrs = {};
      this.children = [];
      this.handlers = {};
      this.className = '';
    }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    getAttribute(key) { return this.attrs[key] ?? null; }
    removeAttribute(key) { delete this.attrs[key]; }
    hasAttribute(key) { return key in this.attrs; }
    addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); }
    removeEventListener(type, fn) { this.handlers[type] = (this.handlers[type] ?? []).filter((f) => f !== fn); }
    append(...nodes) {
      for (const n of nodes) {
        const node = n instanceof Node ? n : new Text(n);
        // As in a browser: a node put somewhere new leaves where it was.
        if (node.parent) node.parent.children = node.parent.children.filter((c) => c !== node);
        node.parent = this;
        this.children.push(node);
      }
    }
    replaceChildren(...nodes) {
      for (const c of this.children) c.parent = null;
      this.children = [];
      this.append(...nodes);
    }
    contains(other) { for (let n = other; n; n = n.parent) if (n === this) return true; return false; }
    matches(selector) { return matches(this, selector); }
    closest(selector) { for (let n = this; n instanceof El; n = n.parent) if (n.matches(selector)) return n; return null; }
    querySelectorAll(selector) {
      const direct = selector.startsWith(':scope > ');
      const sel = direct ? selector.slice(9) : selector;
      const found = [];
      const walk = (el) => {
        for (const c of el.children) {
          if (!(c instanceof El)) continue;
          if (c.matches(sel)) found.push(c);
          if (!direct) walk(c);
        }
      };
      walk(this);
      return found;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    get textContent() { return this.children.map((c) => c.textContent).join(''); }
    // What an anchor answers, resolved against the page's address.
    get url() { return new URL(this.attrs.href, location.href); }
    get href() { return this.url.href; }
    get pathname() { return this.url.pathname; }
    get search() { return this.url.search; }
    get hash() { return this.url.hash; }
    get origin() { return this.url.origin; }
    get target() { return this.attrs.target ?? ''; }
  }
  return El;
}

/**
 * common.js on a settings page at `path`, with the pages `makePages(W, window)` gives registered as the page scripts
 * would, then loaded. `me` is what /api/me answers (none: it never does); `hostPage`, a program's page as settingsFrame
 * sends it, its template's `current`, `body` (a node) and, for one of the program's own entries, `heading` and `tabs`,
 * run through hostSettings.js.
 */
function load(path, makePages = () => [], { me = null, hostPage = null } = {}) {
  const location = {};
  const setLocation = (url) => {
    const u = new URL(url, location.href ?? ORIGIN);
    Object.assign(location, { href: u.href, origin: u.origin, pathname: u.pathname, search: u.search, hash: u.hash });
  };
  setLocation(`${ORIGIN}${path}`);
  const El = makeDom(location);
  const root = new El('html');
  root.isRoot = true;
  const app = new El('div');
  root.append(app);
  const pushed = [];
  const history = { pushState(_s, _t, url) { pushed.push(String(url)); setLocation(url); } };
  const listeners = { document: {}, window: {} };
  const on = (where) => (type, fn) => { (listeners[where][type] ??= []).push(fn); };
  const off = (where) => (type, fn) => { listeners[where][type] = (listeners[where][type] ?? []).filter((f) => f !== fn); };
  const shown = [];
  const window = {
    WoodshedLogins: require('./public/logins.cjs'), WoodshedAgents: require('../shared/agents.cjs'), WoodshedSetup: require('./public/setupSteps.cjs'),
    addEventListener: on('window'), removeEventListener: off('window'),
    dispatchEvent(event) { if (event.type === 'woodshed:settings-shown') shown.push(location.pathname); for (const fn of listeners.window[event.type] ?? []) fn(event); },
    scrollTo() {},
  };
  const intervals = new Map();
  let nextId = 1;
  const errors = [];
  const context = vm.createContext({
    window, Node, URL, location, history,
    console: { ...console, error: (...args) => errors.push(args) },
    Event: class { constructor(type) { this.type = type; } },
    fetch: (url) => (me && url === '/api/me' ? Promise.resolve({ json: async () => me }) : new Promise(() => {})),
    setInterval: (fn, ms) => { const id = nextId++; intervals.set(id, ms); return id; },
    clearInterval: (id) => intervals.delete(id),
    setTimeout: () => nextId++, clearTimeout: () => {},
    document: {
      addEventListener: on('document'), removeEventListener: off('document'), querySelector() { return null; },
      getElementById: (id) => (id === 'app' ? app
        : id === 'woodshed-host-page' && hostPage ? {
          getAttribute: (a) => ({ 'data-current': hostPage.current, 'data-heading': hostPage.heading, 'data-tabs': hostPage.tabs && JSON.stringify(hostPage.tabs) })[a] ?? null,
          content: { cloneNode: () => hostPage.body },
        }
          : null),
      createElement: (tag) => new El(tag), createTextNode: (text) => new Text(text),
    },
    matchMedia: () => ({}),
  });
  vm.runInContext(source, context);
  const W = window.Woodshed;
  for (const [match, start] of makePages(W, window)) W.settingsPage(match, start);
  if (hostPage) vm.runInContext(hostSource, context);
  for (const fn of listeners.document.DOMContentLoaded ?? []) fn();
  // A click as the browser sends it: the anchor's own handlers, then the document's. `true` when the page took it.
  const click = (el, mods = {}) => {
    const event = { target: el, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, ...mods, preventDefault() { this.defaultPrevented = true; } };
    for (let n = el; n; n = n.parent) for (const fn of n.handlers?.click ?? []) fn(event);
    for (const fn of listeners.document.click ?? []) fn(event);
    return event.defaultPrevented;
  };
  const back = (url) => { setLocation(url); for (const fn of listeners.window.popstate ?? []) fn({}); };
  const side = () => app.querySelector('aside.settings-side');
  const title = () => app.querySelector('h1')?.textContent ?? null;
  const current = () => side()?.querySelectorAll('a.side-item').filter((a) => a.getAttribute('aria-current') === 'page').map((a) => a.getAttribute('href'));
  const tabs = () => app.querySelector('nav.settings-tabs')?.querySelectorAll('a').map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('aria-current')]);
  // Settings' tabs under its entry, in the side list and in the avatar menu: [label, href, aria-current] each.
  const subs = (cls) => [...(side()?.querySelectorAll(`a.${cls}`) ?? []).map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('aria-current')])];
  const settingsEntry = () => side()?.querySelectorAll('a.side-item').find((a) => a.textContent === '⚙Settings');
  return { W, El, tabs, subs, settingsEntry, app, location, pushed, intervals, listeners, errors, shown, click, back, side, title, current, link: (href) => app.querySelectorAll('a').find((a) => a.getAttribute('href') === href) };
}

/** A made-up settings page: its title, links to the others, a 5-second timer and a window listener, as events.js has. */
function page(name, path, started, W, window) {
  return [path, (app, life) => {
    const render = () => app.replaceChildren(W.h('div', { class: 'page' }, life.nav(path), W.h('h1', null, name),
      W.h('a', { href: '/settings' }, 'Mine'), W.h('a', { href: '/events' }, 'Events'), W.h('a', { href: '/events?show=acted' }, 'Acted on'),
      W.h('a', { href: `${path}#here` }, 'Here'), W.h('a', { href: '/events', target: '_blank' }, 'New tab'), W.h('a', { href: '/s/aaaa1111' }, 'A session')));
    started.push({ name, render, life });
    render();
    life.interval(render, 5000);
    life.on(window, 'woodshed:me', render);
  }];
}

function twoPages(path, extra = []) {
  const started = [];
  const t = load(path, (W, window) => [page('My settings', '/settings', started, W, window), page('Webhook events', '/events', started, W, window), ...extra]);
  return { ...t, started };
}

test('a settings page shows the page its address names, with the side list, once every script has run', () => {
  const t = twoPages('/settings');
  assert.equal(t.title(), 'My settings');
  assert.ok(t.side(), 'the side list is on the page');
  assert.deepEqual(t.current(), ['/settings']);
  assert.deepEqual(t.shown, ['/settings'], 'and the search hears a page was shown');
});

test('a click on another settings page shows it in place, and ends what the page left behind had running', () => {
  const t = twoPages('/settings');
  const list = t.side();
  assert.equal(t.intervals.size, 1);
  assert.equal(t.click(t.link('/events')), true, 'the click is the page\'s, not the browser\'s');
  assert.deepEqual(t.pushed, [`${ORIGIN}/events`]);
  assert.equal(t.title(), 'Webhook events');
  assert.equal(t.side(), list, 'the same side list, never drawn again');
  // The made-up console has no admin, so My settings is the list's only page: none is marked on Webhook events.
  assert.deepEqual(t.current(), [], 'My settings is no longer marked');
  assert.equal(t.intervals.size, 1, 'the first page\'s timer was cleared, the second\'s set');
  assert.equal(t.listeners.window['woodshed:me'].length, 1, 'and its listener taken off');
  assert.deepEqual(t.shown, ['/settings', '/events']);
});

test('a page left behind that draws again cannot take the side list or its mark', () => {
  const t = twoPages('/settings');
  t.click(t.link('/events'));
  const [mine] = t.started;
  assert.equal(mine.life.ended, true);
  // A read My settings made answers late, or its restore clock ticks: it draws into its own, unseen node.
  mine.render();
  assert.equal(t.title(), 'Webhook events');
  assert.ok(t.side()?.isConnected, 'the side list stays on the page shown');
  assert.deepEqual(t.current(), [], 'and My settings is not marked again');
  assert.equal(mine.life.nav('/settings'), null);
});

test('clicks the browser should handle are left to it', () => {
  const t = twoPages('/settings');
  for (const mods of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
    assert.equal(t.click(t.link('/events'), mods), false, `a click with ${Object.keys(mods)[0]}`);
  }
  assert.equal(t.click(t.app.querySelectorAll('a').find((a) => a.target === '_blank')), false, 'a link to a new tab');
  assert.equal(t.click(t.link('/settings#here')), false, 'a place on this same page');
  assert.equal(t.click(t.link('/s/aaaa1111')), false, 'a page that is not a settings page');
  assert.deepEqual(t.pushed, []);
  assert.equal(t.title(), 'My settings');
});

test('a link to another view of a page shows it again, and one to the page itself changes nothing', () => {
  const t = twoPages('/events');
  assert.equal(t.click(t.link('/events')), true);
  assert.deepEqual(t.pushed, [], 'the same address is not pushed again');
  assert.equal(t.click(t.link('/events?show=acted')), true);
  assert.deepEqual(t.pushed, [`${ORIGIN}/events?show=acted`]);
  assert.equal(t.title(), 'Webhook events');
});

test('a page that throws as it starts says so, and the others are still a click away in place', () => {
  const t = twoPages('/people', [['/people', () => { throw new Error('boom'); }]]);
  assert.match(t.app.textContent, /This page could not be drawn: boom/);
  assert.ok(t.side(), 'with the side list');
  assert.equal(t.errors.length, 1);
  assert.equal(t.click(t.side().querySelectorAll('a.side-item').find((a) => a.getAttribute('href') === '/settings')), true);
  assert.equal(t.title(), 'My settings');
});

test('Back and Forward show the page of the address, and a change of the hash alone redraws nothing', () => {
  const t = twoPages('/settings');
  t.click(t.link('/events'));
  t.back(`${ORIGIN}/settings`);
  assert.equal(t.title(), 'My settings');
  assert.equal(t.started.length, 3, 'started again, fresh');
  t.back(`${ORIGIN}/settings#here`);
  assert.equal(t.started.length, 3, 'the same page and query: not started again');
});

test('goToSettings shows a settings page in place, and loads anything else', () => {
  const t = twoPages('/settings');
  t.W.goToSettings('/events#events');
  assert.equal(t.title(), 'Webhook events');
  assert.deepEqual(t.pushed, [`${ORIGIN}/events#events`]);
  assert.deepEqual(t.shown, ['/settings', '/events'], 'the search reveals the section once the page is shown');
  t.W.goToSettings('/s/aaaa1111');
  assert.equal(t.location.href, `${ORIGIN}/s/aaaa1111`, 'not a settings page: the browser loads it');
  assert.equal(t.pushed.length, 1);
});

test('a page that is not a settings page has no switching at all', () => {
  const t = load('/s/aaaa1111');
  assert.equal(t.listeners.document.click, undefined);
  assert.equal(t.listeners.window.popstate, undefined);
});

const HOST_TABS = [{ label: 'Members', href: '/orgs/acme/members' }, { label: 'Credits', href: '/orgs/acme/credits' }];
const answered = () => new Promise((resolve) => setImmediate(resolve));

test('a program\'s page shows in the settings frame, under Settings and its tabs, with the program\'s own part as it sent it', async () => {
  // The template is read as the page starts, so the stand-in's node is made by a first load and handed to a second.
  const first = load('/nowhere');
  const part = new first.El('p');
  part.append('Compute credits: $40');
  const t = load('/orgs/acme/credits', () => [], { me: { login: 'sam', admin: true, settingsTabs: HOST_TABS }, hostPage: { current: '/orgs/acme/credits', body: part } });
  assert.equal(t.title(), 'Settings');
  assert.ok(t.side(), 'with the side list');
  assert.match(t.app.querySelector('div.host-page').textContent, /Compute credits: \$40/);
  assert.deepEqual(t.tabs(), [['General', '/console-settings', null], ['Secrets & webhooks', '/secrets', null]], 'the console\'s own until /api/me answers');
  await answered();
  assert.deepEqual(t.tabs(), [
    ['General', '/console-settings', null], ['Secrets & webhooks', '/secrets', null],
    ['Members', '/orgs/acme/members', null], ['Credits', '/orgs/acme/credits', 'page'],
  ], 'then the program\'s after them, the page\'s own marked, without the page drawing again');
  assert.deepEqual(t.current(), ['/orgs/acme/credits'], 'and in the side list Credits, under Settings, is the current entry');
  assert.equal(t.settingsEntry().getAttribute('aria-current'), 'true', 'Settings itself the set the page is in');
  assert.deepEqual(t.subs('side-sub'), [
    ['General', '/console-settings', null], ['Secrets & webhooks', '/secrets', null],
    ['Members', '/orgs/acme/members', null], ['Credits', '/orgs/acme/credits', 'page'],
  ]);
  assert.equal(t.click(t.link('/console-settings')), false, 'the console\'s tab is not on this page: the browser loads it');
});

test('someone who is not an admin sees the program\'s tabs alone, and Settings opens the first', async () => {
  const first = load('/nowhere');
  const t = load('/orgs/acme/credits', () => [], { me: { login: 'sam', admin: false, settingsTabs: HOST_TABS }, hostPage: { current: '/orgs/acme/credits', body: new first.El('p') } });
  await answered();
  assert.deepEqual(t.tabs(), [['Members', '/orgs/acme/members', null], ['Credits', '/orgs/acme/credits', 'page']]);
  assert.deepEqual(t.current(), ['/orgs/acme/credits'], 'Credits, under Settings, is current');
  assert.equal(t.settingsEntry().getAttribute('href'), '/orgs/acme/members', 'Settings opens Members');
  assert.deepEqual(t.subs('side-sub'), [['Members', '/orgs/acme/members', null], ['Credits', '/orgs/acme/credits', 'page']], 'the program\'s tabs alone under it');
  assert.deepEqual(t.subs('menu-sub'), [['Members', '/orgs/acme/members', null], ['Credits', '/orgs/acme/credits', 'page']], 'and in the menu');
  assert.equal(t.side().querySelectorAll('a.side-item').find((a) => a.textContent.endsWith('Settings') && a.textContent !== '◉My settings')?.textContent, '⚙Settings', 'with Settings\' own icon');
  assert.deepEqual([...t.W.consoleLinks().map((l) => l.label)], ['Settings'], 'no People or Webhook events');
});

test('with no tabs from a program, someone who is not an admin has no Console entries, as before', async () => {
  const t = load('/settings', () => [], { me: { login: 'sam', admin: false } });
  await answered();
  assert.equal(t.W.consoleLinks().length, 0);
  assert.deepEqual(t.subs('side-sub'), [], 'and no tabs under anything');
  assert.deepEqual(t.subs('menu-sub'), []);
});

// The console's own pages, for an admin: General and Secrets & webhooks, as made-up settings pages, and My settings.
function adminPages(path, me = { login: 'sam', admin: true, settingsTabs: HOST_TABS }) {
  const started = [];
  return load(path, (W, window) => [page('General', '/console-settings', started, W, window), page('Secrets', '/secrets', started, W, window),
    page('My settings', '/settings', started, W, window), page('Webhook events', '/events', started, W, window)], { me });
}

test('on one of Settings\' pages its tabs open under it in the side list, the page\'s marked, and move in place', async () => {
  const t = adminPages('/console-settings');
  assert.deepEqual(t.subs('side-sub'), [], 'none until /api/me answers');
  await answered();
  const list = t.side();
  assert.deepEqual(t.subs('side-sub'), [
    ['General', '/console-settings', 'page'], ['Secrets & webhooks', '/secrets', null],
    ['Members', '/orgs/acme/members', null], ['Credits', '/orgs/acme/credits', null],
  ], 'filled when /api/me answers, the page not drawn again');
  assert.equal(t.side(), list);
  assert.deepEqual(t.current(), ['/console-settings']);
  assert.equal(t.settingsEntry().getAttribute('aria-current'), 'true');
  const secrets = t.side().querySelectorAll('a.side-sub').find((a) => a.getAttribute('href') === '/secrets');
  assert.equal(t.click(secrets), true, 'a click on a console tab is the page\'s, in place');
  assert.equal(t.title(), 'Secrets');
  assert.equal(t.side(), list, 'the same side list');
  assert.deepEqual(t.subs('side-sub').map(([, href, mark]) => [href, mark]), [
    ['/console-settings', null], ['/secrets', 'page'], ['/orgs/acme/members', null], ['/orgs/acme/credits', null],
  ]);
  assert.deepEqual(t.subs('menu-sub').map(([, href, mark]) => [href, mark]), [
    ['/console-settings', null], ['/secrets', 'page'], ['/orgs/acme/members', null], ['/orgs/acme/credits', null],
  ], 'and the menu\'s mark moves with it');
  const members = t.side().querySelectorAll('a.side-sub').find((a) => a.getAttribute('href') === '/orgs/acme/members');
  assert.equal(t.click(members), false, 'a program\'s tab is not on this page: the browser loads it');
});

test('on the other settings pages Settings stays one entry, and the avatar menu lists its tabs always', async () => {
  for (const path of ['/settings']) {
    const t = adminPages(path);
    await answered();
    assert.deepEqual(t.subs('side-sub'), [
      ['Sign-ins', '/settings#set-signins', null], ['Sessions', '/settings#set-sessions', null], ['Kept for you', '/settings#set-kept', null],
      ['Repos and files', '/settings#repo-settings', null], ['Display', '/settings#my-display', null],
    ], `My settings' own groups under it on ${path}, and none under Settings`);
    assert.equal(t.settingsEntry().getAttribute('aria-current'), null);
    assert.deepEqual(t.subs('menu-sub'), [
      ['General', '/console-settings', null], ['Secrets & webhooks', '/secrets', null],
      ['Members', '/orgs/acme/members', null], ['Credits', '/orgs/acme/credits', null],
    ], `the menu has them on ${path}, none marked`);
    const sub = t.side().querySelectorAll('a.menu-sub')[0];
    assert.equal(sub.getAttribute('role'), 'menuitem');
  }
  const t = adminPages('/settings', { login: 'sam', admin: true });
  await answered();
  assert.deepEqual(t.subs('menu-sub').map(([label]) => label), ['General', 'Secrets & webhooks'], 'with no program, the console\'s two');
  t.click(t.side().querySelectorAll('a.side-item').find((a) => a.getAttribute('href') === '/console-settings'));
  assert.deepEqual(t.subs('side-sub').map(([label, , mark]) => [label, mark]), [['General', 'page'], ['Secrets & webhooks', null]], 'and opening Settings opens them');
});

test('Webhook events is under Settings, not an entry of its own, and Keyboard shortcuts is in the side list alone', async () => {
  const t = adminPages('/events');
  await answered();
  assert.equal(t.title(), 'Webhook events');
  const sideHrefs = t.side().querySelector('nav.side-list').querySelectorAll('a.side-item').map((a) => a.getAttribute('href'));
  assert.ok(!sideHrefs.includes('/events'), 'no Webhook events in the side list');
  const menu = t.side().querySelector('div.user-menu');
  assert.ok(!menu.querySelectorAll('a.menu-item').some((a) => a.getAttribute('href') === '/events'), 'nor in the avatar menu');
  assert.ok(!menu.querySelectorAll('a.menu-item').some((a) => /Webhook events/.test(a.textContent)));
  assert.deepEqual([...t.W.consoleLinks().map((l) => l.label)], ['Settings', 'Analytics'], 'People is a tab of Settings, not an entry; Analytics is one of its own');
  assert.equal(t.settingsEntry().getAttribute('aria-current'), 'true', 'Settings is the set the page is in');
  assert.deepEqual(t.subs('side-sub').map(([, href, mark]) => [href, mark]), [
    ['/console-settings', null], ['/secrets', null], ['/orgs/acme/members', null], ['/orgs/acme/credits', null],
  ], 'its tabs open under it, none of them the page');
  const menuEntry = menu.querySelectorAll('a.menu-item').find((a) => a.getAttribute('href') === '/console-settings' && !a.matches('a.menu-sub'));
  assert.equal(menuEntry.getAttribute('aria-current'), 'true', 'and in the menu');
  assert.ok(!menu.querySelectorAll('button.menu-item').some((b) => /Keyboard shortcuts/.test(b.textContent)), 'no Keyboard shortcuts in the avatar menu');
  assert.ok(t.side().querySelectorAll('button.side-item').some((b) => /Keyboard shortcuts/.test(b.textContent)), 'it stays under This browser');
  t.click(t.side().querySelectorAll('a.side-item').find((a) => a.getAttribute('href') === '/console-settings'));
  assert.equal(t.title(), 'General');
  assert.equal(t.settingsEntry().getAttribute('aria-current'), 'true');
});

test('a repo\'s own settings open Settings too, with General marked', async () => {
  const t = load('/console-settings/repos/app', (W) => [[/^\/console-settings\/repos\//, (app, life) => app.replaceChildren(W.h('div', { class: 'page' }, life.nav('/console-settings')))]],
    { me: { login: 'sam', admin: true } });
  await answered();
  assert.deepEqual(t.subs('side-sub'), [['General', '/console-settings', 'page'], ['Secrets & webhooks', '/secrets', null]]);
});

test('the user menu\'s Sign out: always on a console of its own, and behind a hosting proxy only when the program signs people out', async () => {
  const signOutIn = async (me) => {
    const mine = (W) => [['/settings', (app, life) => app.replaceChildren(W.h('div', { class: 'page' }, life.nav('/settings')))]];
    const t = load('/settings', mine, { me: { login: 'sam', admin: true, ...me } });
    await answered();
    return t.side().querySelector('form.menu-form')?.getAttribute('action') ?? null;
  };
  assert.equal(await signOutIn({}), '/auth/sign-out');
  assert.equal(await signOutIn({ hosted: true }), null);
  assert.equal(await signOutIn({ hosted: true, signOut: true }), '/auth/sign-out');
});

// What a program embedding the console gives /api/me (server.mjs, menuOf): the person's own page, a switcher, and a
// section of its own whose entry has pages under it.
const HOST_MENU = {
  login: 'sam', admin: true, hosted: true, signOut: true, settingsTabs: HOST_TABS,
  menuYou: [{ label: 'Your workspaces', href: '/account' }],
  menuGroups: [{ label: 'Organization', items: [{ label: 'Acme', href: null, current: true, note: 'Owner' }, { label: 'Globex', href: '/switch/globex', current: false, note: null }] }],
  menuSections: [{ label: 'Service', items: [{ label: 'Admin', href: '/admin', items: [{ label: 'Overview', href: '/admin' }, { label: 'Pool', href: '/admin/pool' }] }] }],
};

// The avatar menu, top to bottom: each heading, link and rule, and the sub-items' rows as `› label`.
function menuRows(t) {
  const rows = [];
  for (const el of t.side().querySelector('div.user-menu').children) {
    if (el.matches('div.menu-head')) rows.push('head');
    else if (el.matches('div.menu-rule')) rows.push('—');
    else if (el.matches('div.menu-label')) rows.push(`[${el.textContent}]`);
    else if (el.matches('div.menu-subs')) rows.push(...el.children.map((a) => `› ${a.textContent}`));
    else if (el.matches('form')) rows.push(el.textContent);
    else rows.push(el.querySelector('span.menu-choice-name')?.textContent ?? el.textContent);
  }
  return rows;
}

// The side list's groups and entries in order, each entry's mark after it, and This browser's buttons left out.
function sideRows(t) {
  const rows = [];
  const walk = (el) => {
    for (const c of el.children) {
      if (!c.matches) continue;
      if (c.matches('div.side-group')) rows.push(`[${c.textContent}]`);
      else if (c.matches('a.side-item')) rows.push(`${c.matches('a.side-sub') ? '› ' : ''}${c.textContent.replace(/^[^A-Za-z]+/, '')}${c.getAttribute('aria-current') ? ` (${c.getAttribute('aria-current')})` : ''}`);
      else if (c.matches('div')) walk(c);
    }
  };
  walk(t.side().querySelector('nav.side-list'));
  return rows;
}

test('the avatar menu: My settings and the program\'s pages under the name, its switcher, Console, its sections, Sign out', async () => {
  const t = load('/settings', (W) => [['/settings', (app, life) => app.replaceChildren(W.h('div', { class: 'page' }, life.nav('/settings')))]], { me: HOST_MENU });
  await answered();
  assert.deepEqual(menuRows(t), [
    'head', 'My settings', 'Your workspaces', '—',
    '[Organization]', 'Acme', 'Globex',
    '[Console]', 'Settings', '› General', '› Secrets & webhooks', '› Members', '› Credits', 'Analytics',
    '[Service]', 'Admin', '› Overview', '› Pool',
    'Sign out',
  ], 'the entry\'s own pages always listed in the menu, as Settings\' tabs are');
  const plain = load('/settings', (W) => [['/settings', (app, life) => app.replaceChildren(W.h('div', { class: 'page' }, life.nav('/settings')))]], { me: { login: 'sam', admin: true } });
  await answered();
  assert.deepEqual(menuRows(plain).slice(0, 4), ['head', 'My settings', '—', '[Console]'], 'with no program, My settings alone under the name');
});

test('the side list: You with the program\'s pages, Console, then the program\'s sections, an entry\'s pages open on its own', async () => {
  const t = load('/settings', (W) => [['/settings', (app, life) => app.replaceChildren(W.h('div', { class: 'page' }, life.nav('/settings')))]], { me: HOST_MENU });
  await answered();
  assert.deepEqual(sideRows(t), ['[You]', 'My settings (page)', '› Sign-ins', '› Sessions', '› Kept for you', '› Repos and files', '› Display', 'Your workspaces', '[Console]', 'Settings', 'Analytics', '[Service]', 'Admin', '[This browser]'],
    'Admin one entry away from its pages');

  const first = load('/nowhere');
  const part = new first.El('p');
  part.append('The pool');
  const admin = load('/admin/pool', () => [], { me: HOST_MENU, hostPage: { current: '/admin/pool', heading: 'Admin', tabs: [{ label: 'Overview', href: '/admin' }, { label: 'Pool', href: '/admin/pool' }], body: part } });
  await answered();
  assert.equal(admin.title(), 'Admin', 'the page\'s own heading, not Settings');
  assert.deepEqual(admin.tabs(), [['Overview', '/admin', null], ['Pool', '/admin/pool', 'page']], 'and the row of its entry\'s pages');
  assert.match(admin.app.querySelector('div.host-page').textContent, /The pool/);
  assert.deepEqual(sideRows(admin), ['[You]', 'My settings', 'Your workspaces', '[Console]', 'Settings', 'Analytics', '[Service]', 'Admin (true)', '› Overview', '› Pool (page)', '[This browser]'],
    'its pages open under it, the page marked, Settings closed');
  assert.deepEqual(menuRows(admin).slice(-4), ['Admin', '› Overview', '› Pool', 'Sign out']);
  const menu = admin.side().querySelector('div.user-menu');
  assert.deepEqual(menu.querySelectorAll('a.menu-item').filter((a) => a.getAttribute('aria-current')).map((a) => [a.textContent, a.getAttribute('aria-current')]),
    [['Admin', 'true'], ['Pool', 'page']], 'and in the menu');

  const account = load('/account', () => [], { me: HOST_MENU, hostPage: { current: '/account', heading: 'Your workspaces', tabs: [], body: new first.El('p') } });
  await answered();
  assert.equal(account.title(), 'Your workspaces');
  assert.equal(account.tabs(), undefined, 'with no row of tabs');
  assert.deepEqual(account.current(), ['/account'], 'the You entry marked');
});

test('People is Settings\' tab after Secrets & webhooks, before the program\'s, behind a hosting proxy and on a console of its own', async () => {
  const people = (W) => [['/people', (app, life) => app.replaceChildren(W.h('div', { class: 'page' }, life.nav('/people'), W.h('h1', null, 'Settings'), W.settingsTabs('/people')))]];
  const t = load('/people', people, { me: { login: 'sam', admin: true, hosted: true, people: true, settingsTabs: HOST_TABS } });
  await answered();
  const expected = [
    ['General', '/console-settings', null], ['Secrets & webhooks', '/secrets', null], ['People', '/people', 'page'],
    ['Members', '/orgs/acme/members', null], ['Credits', '/orgs/acme/credits', null],
  ];
  assert.deepEqual(t.tabs(), expected);
  assert.deepEqual(t.subs('side-sub'), expected, 'and under Settings in the side list, marked');
  assert.deepEqual(t.subs('menu-sub'), expected, 'and in the avatar menu');
  assert.equal(t.settingsEntry().getAttribute('aria-current'), 'true', 'Settings is the set People is in');
  assert.deepEqual([...t.W.consoleLinks().map((l) => l.href)], ['/console-settings', '/analytics'], 'no People entry of its own');

  const mine = (W) => [['/settings', (app, life) => app.replaceChildren(W.h('div', { class: 'page' }, life.nav('/settings')))]];
  const without = load('/settings', mine, { me: { login: 'sam', admin: true, hosted: true } });
  await answered();
  assert.deepEqual(without.subs('menu-sub').map(([label]) => label), ['General', 'Secrets & webhooks'], 'without the list, no People');
  assert.deepEqual([...without.W.consoleLinks().map((l) => l.href)], ['/console-settings', '/analytics']);

  const own = load('/settings', mine, { me: { login: 'sam', admin: true, people: true, asking: 2 } });
  await answered();
  assert.deepEqual(own.subs('menu-sub').map(([label]) => label), ['General', 'Secrets & webhooks', 'People2'], 'on a console of its own People is the same tab, with how many ask to join');
  assert.deepEqual([...own.W.consoleLinks().map((l) => l.href)], ['/console-settings', '/analytics'], 'and no entry of its own');
  const count = own.side().querySelectorAll('a.side-item').find((a) => a.getAttribute('href') === '/console-settings' && !a.matches('a.side-sub')).querySelector('span.menu-count');
  assert.deepEqual([count.textContent, count.getAttribute('title')], ['2', '2 asking to join'], 'Settings counts those asking, since People is under it');
});

test('someone who is not an owner behind a hosting proxy gets no People tab', async () => {
  const mine = (W) => [['/settings', (app, life) => app.replaceChildren(W.h('div', { class: 'page' }, life.nav('/settings')))]];
  const t = load('/settings', mine, { me: { login: 'sam', admin: false, hosted: true, people: true, settingsTabs: HOST_TABS } });
  await answered();
  assert.deepEqual(t.subs('menu-sub').map(([label]) => label), ['Members', 'Credits']);
});
