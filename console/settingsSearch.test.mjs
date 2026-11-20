// The settings search's own script, public/settingsSearch.js, run the way a page loads it on a tiny DOM that drops
// focus when a focused element is taken out of the page, as browsers do.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const source = fs.readFileSync(new URL('./public/settingsSearch.js', import.meta.url), 'utf8');
const Index = createRequire(import.meta.url)('./public/settingsIndex.cjs');

function loadSearch({ consoleLinks = [{ href: '/console-settings' }, { href: '/secrets' }, { href: '/people' }, { href: '/events' }] } = {}) {
  const document = { activeElement: null };
  const element = (tag) => {
    const el = {
      tag, attrs: {}, listeners: {}, children: [], parent: null, hidden: false, value: '', selectionStart: 0, selectionEnd: 0,
      setAttribute(k, v) { this.attrs[k] = v; },
      addEventListener(k, fn) { (this.listeners[k] ??= []).push(fn); },
      dispatch(k, event = {}) { for (let n = this; n; n = n.parent) for (const fn of n.listeners[k] ?? []) fn({ preventDefault() {}, ...event }); },
      append(c) { if (typeof c === 'object') c.parent = this; this.children.push(c); },
      replaceChildren(...c) {
        for (const old of this.children) if (typeof old === 'object') old.parent = null;
        this.children = [];
        // A focused element taken out of the page loses its focus, with a focusout and no relatedTarget.
        const focused = document.activeElement;
        if (focused && !focused.isConnected) { document.activeElement = null; focused.dispatch('focusout', { relatedTarget: null }); }
        for (const n of c) this.append(n);
      },
      contains(other) { for (let n = other; n; n = n.parent) if (n === this) return true; return false; },
      get isConnected() { let n = this; while (n.parent) n = n.parent; return n === app; },
      focus() { if (document.activeElement === this) return; document.activeElement = this; this.dispatch('focus'); },
      blur() { if (document.activeElement === this) { document.activeElement = null; this.dispatch('focusout', { relatedTarget: null }); } },
      setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; },
      querySelectorAll() { return []; },
      scrollIntoView() { this.scrolled = true; },
      closest() { return null; },
      classList: { names: new Set(), add(c) { this.names.add(c); }, remove(c) { this.names.delete(c); } },
    };
    return el;
  };
  const app = element('div');
  const h = (tag, attrs, ...children) => {
    const el = element(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'hidden') el.hidden = Boolean(v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, String(v));
    }
    for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(typeof c === 'object' ? c : String(c));
    return el;
  };
  // Where the search sent the page (common.js, goToSettings, which shows a settings page in place).
  const went = [];
  const W = { h, isAdmin: () => true, consoleLinks: () => consoleLinks, goToSettings: (href) => went.push(href) };
  const heard = {};
  const location = { pathname: '/events', hash: '' };
  // The sections the search asked their page to open (My settings' rows listen for it).
  const revealed = [];
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } }
  const window = {
    Woodshed: W, WoodshedSettingsIndex: Index, location, addEventListener(type, fn) { (heard[type] ??= []).push(fn); }, history: { replaceState() {} },
    dispatchEvent(e) { if (e.type === 'woodshed:settings-reveal') revealed.push(e.detail.id); },
  };
  // The section a search result names, found by its id in what the page drew.
  const byId = (id, n = app) => (n.attrs?.id === id ? n : (n.children ?? []).map((c) => byId(id, c)).find(Boolean) ?? null);
  document.getElementById = (id) => byId(id);
  class MutationObserver { observe() {} disconnect() {} }
  vm.runInContext(source, vm.createContext({ window, document, queueMicrotask, setTimeout, console, MutationObserver, CustomEvent }));
  // A page that redraws on a timer, as Webhook events does every 5 s.
  const redraw = () => app.replaceChildren(h('div', { class: 'page' }, h('nav'), W.settingsSearch(), h('table')));
  // A settings page shown, on load or in place: what common.js says once it is (woodshed:settings-shown).
  const shown = (path, hash, ...children) => {
    Object.assign(location, { pathname: path, hash });
    app.replaceChildren(h('div', { class: 'page' }, ...children));
    for (const fn of heard['woodshed:settings-shown'] ?? []) fn();
  };
  return { W, h, document, redraw, went, shown, revealed };
}

const settle = () => new Promise((r) => setImmediate(r));

test('the search box keeps its focus across the page redrawing on a timer', async () => {
  const { W, document, redraw } = loadSearch();
  redraw();
  const node = W.settingsSearch();
  const [input, list] = node.children;
  input.focus();
  input.value = 'slack';
  input.selectionStart = input.selectionEnd = 3;
  input.dispatch('input');
  assert.equal(list.hidden, false);

  redraw();
  await settle();
  assert.equal(document.activeElement, input, 'the box has the focus again');
  assert.equal(list.hidden, false, 'the list stays open');
  assert.equal(input.value, 'slack');
  assert.deepEqual([input.selectionStart, input.selectionEnd], [3, 3], 'the caret is where it was');
});

test('a redraw does not take the focus to the search when it was elsewhere, and Esc still closes it', async () => {
  const { W, document, redraw } = loadSearch();
  redraw();
  const [input, list] = W.settingsSearch().children;
  redraw();
  await settle();
  assert.equal(document.activeElement, null);
  assert.equal(list.hidden, true);

  input.focus();
  input.dispatch('keydown', { key: 'Escape' });
  assert.equal(list.hidden, true);
  assert.equal(document.activeElement, null);
  redraw();
  await settle();
  assert.equal(document.activeElement, null, 'a box left with Esc is not focused again');
});

test('Enter on a result on another page shows it in place, through goToSettings, and closes the list', () => {
  const { W, redraw, went } = loadSearch();
  redraw();
  const [input, list] = W.settingsSearch().children;
  input.focus();
  input.value = 'members';
  input.dispatch('input');
  const [first] = Index.search('members', { allowed: () => true });
  assert.equal(first.page, '/people', 'a result on another page than Webhook events');
  input.dispatch('keydown', { key: 'Enter' });
  assert.deepEqual(went, [first.href]);
  assert.equal(list.hidden, true);
});

test('a page shown with a section in its address has that section outlined and scrolled to', () => {
  const { h, shown, revealed } = loadSearch();
  const members = h('section', { id: 'members' });
  shown('/people', '#members', members);
  assert.deepEqual(revealed, ['members'], 'its page is asked to open it, where sections are rows that open');
  assert.equal(members.classList.names.has('is-found'), true);
  assert.equal(members.scrolled, true);
  const other = h('section', { id: 'members' });
  shown('/people', '', other);
  assert.equal(other.classList.names.has('is-found'), false, 'no section in the address: nothing outlined');
});

test('a page under Settings\'s entry, as Webhook events and Secrets & webhooks are, is still found by an admin', () => {
  // What common.js's consoleLinks gives an admin: Webhook events is no entry of its own, it is in Settings' `also`.
  const { W, h, went, shown } = loadSearch({ consoleLinks: [{ href: '/console-settings', also: ['/secrets', '/events'] }, { href: '/people' }] });
  shown('/settings', '', h('nav'), W.settingsSearch());
  const [input] = W.settingsSearch().children;
  input.focus();
  input.value = 'webhook events';
  input.dispatch('input');
  input.dispatch('keydown', { key: 'Enter' });
  assert.deepEqual(went, ['/events#events']);
});
