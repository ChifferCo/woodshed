// Start app, Stop app and the ⋯ menu's rows, read from public/common.js the way a page loads it, over a stand-in
// document whose elements keep their attributes, children and click handlers. What a tap shows before the console
// answers, what a second tap says, and what an error says. The phone's sheet that holds the rows is checked in
// style.css below: taller than the screen, its top rows were out of reach of a finger.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const read = (name) => fs.readFileSync(new URL(`./public/${name}`, import.meta.url), 'utf8');

class Node {}
class Text extends Node {
  constructor(text) { super(); this.text = String(text); }
  get textContent() { return this.text; }
}
class El extends Node {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.attrs = {};
    this.children = [];
    this.handlers = {};
    this.className = '';
    this.disabled = false;
  }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  getAttribute(key) { return this.attrs[key] ?? null; }
  addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes.map((n) => (n instanceof Node ? n : new Text(n))); }
  querySelector(tag) {
    for (const child of this.children) {
      if (!(child instanceof El)) continue;
      if (child.tagName === tag.toUpperCase()) return child;
      const deeper = child.querySelector(tag);
      if (deeper) return deeper;
    }
    return null;
  }
  get textContent() { return this.children.map((c) => c.textContent).join(''); }
  // A tap: the handlers, with the element as currentTarget, as the browser calls them.
  click() {
    const e = { currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} };
    return Promise.all((this.handlers.click ?? []).map((fn) => fn(e)));
  }
}

/**
 * common.js with a fetch that answers when the test says, and a shell whose toasts are kept.
 * @param {{shell?: boolean}} opts  `shell: false` is a page without the shell, which gets alerts instead
 */
function load({ shell = true } = {}) {
  // The page's own /api/me at load is left unanswered and out of `calls`.
  const calls = [];
  const toasts = [];
  const alerts = [];
  const waiting = [];
  const fetch = (url, init = {}) => {
    if (url === '/api/me') return new Promise(() => {});
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ?? null });
    return new Promise((resolve) => { waiting.push({ url, resolve }); });
  };
  // Answers the oldest call still waiting, or the oldest to `url` when given.
  const respond = (status, body, url = null) => {
    const at = waiting.findIndex((w) => url === null || w.url === url);
    const [{ resolve }] = waiting.splice(at, 1);
    resolve({ ok: status < 400, status, json: async () => body });
  };
  const window = { WoodshedLogins: require('./public/logins.cjs'), WoodshedSetup: require('./public/setupSteps.cjs'), alert: (text) => alerts.push(text) };
  const context = vm.createContext({
    window, console, Node, fetch,
    document: { addEventListener() {}, querySelector() {}, createElement: (tag) => new El(tag), createTextNode: (text) => new Text(text) },
    matchMedia: () => ({}),
  });
  vm.runInContext(read('common.js'), context);
  const W = window.Woodshed;
  if (shell) W.shell = { toast: (text, opts) => toasts.push({ text, ms: opts?.ms ?? null }) };
  return { W, calls, toasts, alerts, respond };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const halfUp = () => ({ id: 'f00dd00d', status: 'running', app: 'frontend-down', appServers: { frontend: false, backend: true } });

test('Start app again shows Starting… on the button, the app as starting and a toast before the console answers', async () => {
  const { W, calls, toasts, alerts, respond } = load();
  const s = halfUp();
  let redrawn = null;
  let done = 0;
  const ctl = W.appButton(s, { appDomain: 'apps.example', onDone: () => { done += 1; }, onChange: () => { redrawn = s.app; } });
  const start = ctl.children.find((c) => c instanceof El && c.textContent === 'Start app again');
  assert.ok(start, 'a half-up app offers Start app again');
  const tapped = start.click();
  // Nothing has answered yet.
  assert.equal(start.disabled, true);
  assert.equal(start.getAttribute('aria-busy'), 'true');
  assert.equal(start.textContent, 'Starting…');
  assert.equal(s.app, 'starting');
  assert.equal(redrawn, 'starting', 'the page is redrawn with the app starting');
  assert.deepEqual(toasts, [{ text: 'Starting the app: one to three minutes', ms: null }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/sessions/f00dd00d/app/start');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers['x-woodshed'], '1');
  assert.equal(done, 0);
  respond(200, { started: true, app: 'starting' });
  await tapped;
  await tick();
  assert.equal(done, 1);
  assert.equal(s.app, 'starting');
  assert.deepEqual(alerts, []);
});

test('a second tap while the first waits is told so, and sends nothing', async () => {
  const { W, calls, toasts, respond } = load();
  const s = halfUp();
  const first = W.runAppAction(s, 'start');
  // Another control for the same session: the sheet's row after the top bar's button.
  const second = await W.runAppAction({ ...s }, 'start');
  assert.equal(second, false);
  assert.equal(calls.length, 1);
  assert.equal(toasts.at(-1).text, 'Still starting the app: wait for the console to answer');
  respond(200, { app: 'starting' });
  assert.equal(await first, true);
  // Once it answered, a new tap is asked again.
  const third = W.runAppAction(s, 'stop');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, '/api/sessions/f00dd00d/app/stop');
  assert.equal(toasts.at(-1).text, 'Stopping the app');
  respond(200, { app: 'stopping' });
  await third;
});

test('a refresh that lands while Start app waits still shows the app starting', async () => {
  const { W, calls, respond } = load();
  const pressed = W.runAppAction(halfUp(), 'start');
  const refreshed = W.fetchSessions();
  assert.equal(calls[1].url, '/api/sessions');
  respond(200, { sessions: [halfUp(), { id: 'cafe7777', app: 'running' }] }, '/api/sessions');
  const body = await refreshed;
  assert.deepEqual(body.sessions.map((s) => s.app), ['starting', 'running']);
  respond(200, { app: 'starting' });
  await pressed;
  // Answered: the console's own state is shown again.
  const later = W.fetchSessions();
  respond(200, { sessions: [halfUp()] });
  assert.equal((await later).sessions[0].app, 'frontend-down');
});

test('a refused start puts the app back, and says why in a toast held longer, not an alert', async () => {
  const { W, toasts, alerts, respond } = load();
  const s = halfUp();
  let done = 0;
  const pressed = W.runAppAction(s, 'start', { onDone: () => { done += 1; } });
  respond(409, { error: 'the session is not running' });
  assert.equal(await pressed, false);
  assert.equal(s.app, 'frontend-down');
  assert.deepEqual(toasts.at(-1), { text: 'Could not start the app: the session is not running', ms: 6000 });
  assert.deepEqual(alerts, []);
  assert.equal(done, 1, 'the page refreshes either way');
});

test('a page without the shell says it in an alert', async () => {
  const { W, alerts, respond } = load({ shell: false });
  const pressed = W.runAppAction(halfUp(), 'start');
  assert.deepEqual(alerts, ['Starting the app: one to three minutes']);
  respond(500, {});
  await pressed;
  assert.deepEqual(alerts.at(-1), 'Could not start the app: start answered 500');
});

test('a pick of several apps names the app it starts', async () => {
  const { W, calls, toasts, respond } = load();
  const s = { ...halfUp(), apps: [{ name: 'web', label: 'Web' }, { name: 'admin', label: 'Admin' }] };
  const [web] = W.appChoiceItems(s, () => {});
  assert.equal(web.working, true, 'its row stays open on Starting…');
  const row = new El('button');
  row.append(new El('b'));
  const pressed = web.run(row);
  assert.equal(row.querySelector('b').textContent, 'Starting…');
  assert.equal(toasts.at(-1).text, 'Starting Web: one to three minutes');
  assert.equal(calls[0].body, JSON.stringify({ app: 'web' }));
  respond(200, { app: 'starting' });
  await pressed;
});

// The sheet's own handlers: what the menu is told to do, and the toast.
function menu() {
  const seen = [];
  return { seen, close: () => seen.push('close'), hold: () => seen.push('hold'), done: () => seen.push('done') };
}

test('a menu row with a link is a real link to a new tab, which a phone opens on a tap', () => {
  const { W } = load();
  const m = menu();
  const row = W.menuItem(halfUp(), { label: 'Open app ↗', note: 'The app in this session, in a new tab', href: 'https://box.example:7701/' }, m);
  assert.equal(row.tagName, 'A');
  assert.equal(row.getAttribute('href'), 'https://box.example:7701/');
  assert.equal(row.getAttribute('target'), '_blank');
  assert.equal(row.getAttribute('rel'), 'noopener');
  row.click();
  assert.deepEqual(m.seen, ['close']);
});

test('a working row keeps the menu open until its run is done, and a tap meanwhile is told so', async () => {
  const { W, toasts } = load();
  const s = halfUp();
  const m = menu();
  let finish;
  const ran = [];
  const start = W.menuItem(s, { label: 'Start app again', note: '', working: true, run: (row) => { ran.push(row); return new Promise((r) => { finish = r; }); } }, m);
  assert.equal(start.tagName, 'BUTTON');
  const tapped = start.click();
  assert.deepEqual(m.seen, ['hold']);
  assert.deepEqual(ran, [start], 'the run gets its row, to say what it is doing');
  const other = W.menuItem(s, { label: 'Pin', note: '', run: () => ran.push('pin') }, m);
  await other.click();
  assert.equal(ran.length, 1, 'nothing else runs for the session meanwhile');
  assert.equal(toasts.at(-1).text, 'Still busy with Start app again for this session: wait for it to finish');
  finish();
  await tapped;
  assert.deepEqual(m.seen, ['hold', 'close', 'done']);
  // Done: the next tap runs, closing the menu first as a plain row does.
  await other.click();
  assert.deepEqual(ran.at(-1), 'pin');
});

// The phone's sheet is pinned to the bottom of the screen. Holding more rows than the screen, its top rows (the app's,
// with Start app again and Open app) sat above the screen, where no tap reaches and the page does not scroll to.
test('the menu and the phone\'s sheet are held to the screen\'s height and scroll inside themselves', () => {
  const css = read('style.css');
  const rule = (selector, from = 0) => {
    const at = css.indexOf(`${selector} {`, from);
    assert.notEqual(at, -1, `${selector} has a rule`);
    return css.slice(at, css.indexOf('}', at));
  };
  const base = rule('.card-menu');
  assert.match(base, /max-height: calc\(100vh - 16px\)/);
  assert.match(base, /overflow-y: auto/);
  assert.match(base, /overscroll-behavior: contain/);
  assert.match(css, /\.card-menu > \* \{ flex: none; \}/, 'its rows keep their height and scroll, never squeezed');
  const phone = css.indexOf('@media (max-width: 720px)', css.indexOf('.card-menu {'));
  const sheet = rule('  .card-menu', phone);
  assert.match(sheet, /bottom: 0/);
  assert.match(sheet, /max-height: calc\(100dvh - 40px\)/);
});
