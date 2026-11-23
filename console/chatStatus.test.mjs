// Chat's status line over the composer (public/chat.js), run as the page loads it on a tiny DOM whose append and
// replaceChildren write a null as the text 'null', as the browser's do.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import thread from './public/chatThread.cjs';

const source = fs.readFileSync(new URL('./public/chat.js', import.meta.url), 'utf8');

// Node.append and replaceChildren take strings and nodes, and anything else as its String(): null becomes 'null'.
const asChild = (c) => (c && typeof c === 'object' ? c : String(c));

function element(tag) {
  return {
    tag, attrs: {}, children: [], className: '', value: '', hidden: false, style: {}, scrollTop: 0, scrollHeight: 0, innerHTML: '',
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener() {},
    append(...c) { this.children.push(...c.map(asChild)); },
    replaceChildren(...c) { this.children = c.map(asChild); },
    focus() {},
    get textContent() { return textOf(this); },
    set textContent(v) { this.children = [String(v)]; },
  };
}
const textOf = (el) => (typeof el === 'string' ? el : el.children.map(textOf).join(''));
const find = (el, cls) => {
  if (typeof el === 'string') return null;
  if (String(el.className).split(' ').includes(cls)) return el;
  for (const c of el.children) {
    const got = find(c, cls);
    if (got) return got;
  }
  return null;
};

function load() {
  const h = (tag, attrs, ...children) => {
    const el = element(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'hidden') el.hidden = true;
      else if (!k.startsWith('on')) el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c);
    return el;
  };
  const W = { h, agentOf: () => 'claude', agentTitle: () => 'Claude', shell: { toast() {} } };
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const window = { Woodshed: W, WoodshedChatThread: thread, matchMedia: () => ({ matches: false }), sessionStorage: storage };
  // Nothing is read from the session: the line is drawn from what the console said alone, as before the first read.
  const context = {
    window, document: { hidden: false, addEventListener() {} }, navigator: {}, console,
    fetch: () => new Promise(() => {}), setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  };
  vm.runInNewContext(source, context);
  return W.createChat({ openTerminal() {}, openDiff() {} });
}

test('Working with no turn start known yet reads Working, with no clock and no null', () => {
  const chat = load();
  chat.show({ id: 'c1a0de00', status: 'running', state: 'working', kind: 'task', owner: 'local' });
  const status = find(chat.el, 'chat-status');
  assert.equal(status.className, 'chat-status is-working');
  assert.equal(textOf(status), 'Working');
  assert.equal(find(status, 'chat-clock'), null);
});
