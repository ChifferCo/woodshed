// The bell and ⌘J's list (public/notificationBell.js), run as the page loads it on a tiny DOM, over a stand-in of the
// desktop app's list (window.woodshedNotifications; the browser's has the same calls): one row per session, its count of
// sessions with something new, New before Earlier, and opening a row marking every unread notification of its session.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./public/notificationBell.js', import.meta.url), 'utf8');

function element(tag) {
  const el = {
    tag, attrs: {}, listeners: {}, children: [], className: '', hidden: false, dataset: {}, innerHTML: '',
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(k, fn) { (this.listeners[k] ??= []).push(fn); },
    append(...c) { this.children.push(...c.filter((x) => x !== '')); },
    replaceChildren(...c) { this.children = c.filter((x) => x !== ''); },
    contains(other) { return walk(this).includes(other); },
    querySelector() { return null; },
    focus() {},
    remove() {},
    get textContent() { return textOf(this); },
    set textContent(v) { this.children = [String(v)]; },
  };
  return el;
}
const textOf = (el) => (typeof el === 'string' ? el : el.children.map(textOf).join(''));
const walk = (el, out = []) => {
  if (typeof el === 'string') return out;
  out.push(el);
  for (const c of el.children) walk(c, out);
  return out;
};
const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r)); };
const click = (el) => { for (const fn of el.listeners.click ?? []) fn({ target: el, button: 0, preventDefault() {}, stopPropagation() {} }); };

const at = Date.now();
// Two sessions that notified twice each, one of them half read, and one read session; newest first, as the app keeps it.
const ITEMS = [
  { key: 'n5', id: 'aaaa1111', kind: 'done', title: 'Fix routing', body: 'Done: claude finished its turn.', at: at - 1_000, read: false },
  { key: 'n4', id: 'bbbb2222', kind: 'needs-you', title: 'Ping-pong', body: 'Needs you: claude is asking a question.', at: at - 2_000, read: false },
  { key: 'n3', id: 'cccc3333', kind: 'merged', title: 'Spawn children', body: 'Pull request merged: PR 7.', at: at - 3_000, read: true },
  { key: 'n2', id: 'bbbb2222', kind: 'done', title: 'Ping-pong', body: 'Done: claude finished its turn.', at: at - 4_000, read: false },
  { key: 'n1', id: 'aaaa1111', kind: 'done', title: 'Fix routing', body: 'Done: claude finished its turn.', at: at - 5_000, read: true },
];

async function load(items = ITEMS) {
  const marked = [];
  const navigated = [];
  const h = (tag, attrs, ...children) => {
    const el = element(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'hidden') el.hidden = true;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false && c !== '') el.append(c);
    return el;
  };
  let current = structuredClone(items);
  const changeFns = [];
  const snapshot = () => ({ items: structuredClone(current), unread: current.filter((e) => !e.read).length });
  const bridge = {
    list: async () => snapshot(),
    // No key is every one, as preload.cjs and browserNotifications.js read it.
    markRead: async (given) => {
      const key = typeof given === 'string' ? given : null;
      marked.push(key);
      for (const e of current) if (key === null || e.key === key) e.read = true;
      const list = snapshot();
      for (const fn of changeFns) fn(list);
    },
    onChange: (fn) => changeFns.push(fn),
    onArrived: () => {},
  };
  const body = element('body');
  const document = { body, activeElement: null, addEventListener() {} };
  const context = {
    document, location: { pathname: '/all' }, CSS: { escape: (s) => s }, console, Date, Number, String, Array, Set, Map, Promise,
    woodshedNotifications: bridge,
    Woodshed: { h, ago: () => '5 min ago', navigate: (to) => navigated.push(to) },
    addEventListener() {},
  };
  context.window = context;
  vm.runInContext(source, vm.createContext(context));
  const bell = context.Woodshed.notificationBell();
  await settle();
  const [button, panel] = bell.children;
  const count = button.children.find((c) => c.className === 'bell-count');
  const open = async () => { click(button); await settle(); };
  // The open list as text: a part's name in brackets, then each row's name, (new) when new, and when.
  const rows = () => walk(panel).filter((e) => e.className === 'bell-part' || e.className?.startsWith('bell-item'));
  const read = () => rows().map((e) => (e.className === 'bell-part'
    ? `[${e.textContent}]`
    : `${walk(e).find((x) => x.className === 'bell-title').textContent}${e.className.includes('is-new') ? ' (new)' : ''} | ${walk(e).find((x) => x.className === 'bell-when').textContent}`));
  return { bell, button, panel, count, open, rows, read, marked, navigated };
}

test('the bell counts the sessions with something new, not the notifications', async () => {
  const page = await load();
  assert.equal(page.count.hidden, false);
  assert.equal(page.count.textContent, '2', '3 unread notifications, from 2 sessions');
  assert.match(page.button.attrs['aria-label'], /2 sessions with something new/);
  const none = await load(ITEMS.map((e) => ({ ...e, read: true })));
  assert.equal(none.count.hidden, true);
});

test('one row per session, its latest notification and how many it had, New before Earlier', async () => {
  const page = await load();
  await page.open();
  assert.deepEqual(page.read(), [
    '[New]',
    'Fix routing (new) | just now · 2 notifications',
    'Ping-pong (new) | just now · 2 notifications',
    '[Earlier]',
    'Spawn children | just now',
  ]);
  assert.deepEqual(page.marked, [], 'opening the list marks nothing');
  // With nothing new, no parts are named.
  const quiet = await load(ITEMS.map((e) => ({ ...e, read: true })));
  await quiet.open();
  assert.deepEqual(quiet.read().filter((r) => r.startsWith('[')), []);
});

test('opening a row marks every unread notification of its session, and no other, and opens the session', async () => {
  const page = await load();
  await page.open();
  const pingPong = page.rows().find((e) => e.textContent.includes('Ping-pong'));
  click(pingPong);
  await settle();
  assert.deepEqual(page.marked.sort(), ['n2', 'n4']);
  assert.deepEqual(page.navigated, ['/s/bbbb2222']);
  assert.equal(page.count.textContent, '1');
  // A session already read marks nothing more.
  await page.open();
  const done = page.rows().find((e) => e.textContent.includes('Spawn children'));
  page.marked.length = 0;
  click(done);
  await settle();
  assert.deepEqual(page.marked, []);
});

test('Mark all read marks them all, and the count goes', async () => {
  const page = await load();
  await page.open();
  click(walk(page.panel).find((e) => e.className === 'bell-mark'));
  await settle();
  assert.deepEqual(page.marked, [null]);
  assert.equal(page.count.hidden, true);
});
