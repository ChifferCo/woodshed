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
 * sends it, its template's `current` and `body` (a node), run through hostSettings.js.
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
    WoodshedLogins: require('./public/logins.cjs'), WoodshedSetup: require('./public/setupSteps.cjs'),
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
        : id === 'woodshed-host-page' && hostPage ? { getAttribute: (a) => (a === 'data-current' ? hostPage.current : null), content: { cloneNode: () => hostPage.body } }
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
  return { W, El, tabs, app, location, pushed, intervals, listeners, errors, shown, click, back, side, title, current, link: (href) => app.querySelectorAll('a').find((a) => a.getAttribute('href') === href) };
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
  assert.deepEqual(t.current(), ['/console-settings'], 'and Settings is the side list\'s current entry');
  assert.equal(t.click(t.link('/console-settings')), false, 'the console\'s tab is not on this page: the browser loads it');
});

test('someone who is not an admin sees the program\'s tabs alone, and Settings opens the first', async () => {
  const first = load('/nowhere');
  const t = load('/orgs/acme/credits', () => [], { me: { login: 'sam', admin: false, settingsTabs: HOST_TABS }, hostPage: { current: '/orgs/acme/credits', body: new first.El('p') } });
  await answered();
  assert.deepEqual(t.tabs(), [['Members', '/orgs/acme/members', null], ['Credits', '/orgs/acme/credits', 'page']]);
  assert.deepEqual(t.current(), ['/orgs/acme/members'], 'Settings, opening Members, is current on Credits');
  assert.equal(t.side().querySelectorAll('a.side-item').find((a) => a.textContent.endsWith('Settings') && a.textContent !== '◉My settings')?.textContent, '⚙Settings', 'with Settings\' own icon');
  assert.deepEqual([...t.W.consoleLinks().map((l) => l.label)], ['Settings'], 'no People or Webhook events');
});

test('with no tabs from a program, someone who is not an admin has no Console entries, as before', async () => {
  const t = load('/settings', () => [], { me: { login: 'sam', admin: false } });
  await answered();
  assert.equal(t.W.consoleLinks().length, 0);
});
