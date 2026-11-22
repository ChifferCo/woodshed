// The Share the app dialog (public/appShare.js), run as the page loads it on a tiny DOM whose append writes a null as
// the text 'null', as the browser's does: what it shows with no link yet and with links, and what the bar's Shared reads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./public/appShare.js', import.meta.url), 'utf8');

// Node.append and replaceChildren take strings and nodes, and anything else as its String(): null becomes 'null'.
const asChild = (c) => (c && typeof c === 'object' ? c : String(c));

function element(tag) {
  return {
    tag, attrs: {}, listeners: {}, children: [], className: '', value: '', open: false, hidden: false,
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(k, fn) { (this.listeners[k] ??= []).push(fn); },
    append(...c) { this.children.push(...c.map(asChild)); },
    replaceChildren(...c) { this.children = c.map(asChild); },
    showModal() { this.open = true; },
    close() { this.open = false; for (const fn of this.listeners.close ?? []) fn(); },
    remove() { this.removed = true; },
    get textContent() { return textOf(this); },
    set textContent(v) { this.children = [String(v)]; },
  };
}

const textOf = (el) => (typeof el === 'string' ? el : el.children.map(textOf).join(''));
const walk = (el, out = []) => {
  if (typeof el === 'string') return out;
  out.push(el);
  for (const c of el.children) walk(c, out);
  return out;
};
const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r)); };
const click = (el) => { for (const fn of el.listeners.click ?? []) fn({ target: el }); };

function load({ view = { members: false, links: [] } } = {}) {
  const body = element('body');
  const reads = [];
  const h = (tag, attrs, ...children) => {
    const el = element(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c);
    return el;
  };
  let current = structuredClone(view);
  let made = 0;
  const W = {
    h,
    when: () => 'in 1 day',
    getJson: async (path) => {
      reads.push(path);
      return structuredClone({ ...current, appUrl: 'https://aaaa1111.apps.example.com/' });
    },
    postJson: async (path, sent) => {
      if (path.endsWith('/links')) {
        made += 1;
        current.links.unshift({ id: `l${made}`, createdAt: Date.now(), expiresAt: Date.now() + sent.hours * 3_600_000 });
        return { ...structuredClone(current), appUrl: 'https://aaaa1111.apps.example.com/', url: `https://aaaa1111.apps.example.com/__woodshed/share?t=secret${made}`, created: `l${made}` };
      }
      if (path.endsWith('/members')) current.members = sent.on;
      return structuredClone(current);
    },
  };
  const window = { Woodshed: W };
  vm.runInNewContext(source, { window, document: { body }, navigator: {}, console });
  return { W, body, reads };
}

const dialogOf = (body) => body.children.find((c) => c.tag === 'dialog');
const button = (dialog, words) => walk(dialog).find((el) => el.tag === 'button' && textOf(el) === words);
// The browser's select holds its selected option's value; the tiny DOM's is set as a person would leave it.
function makeLink(dialog) {
  walk(dialog).find((el) => el.tag === 'select').value = '24';
  click(button(dialog, 'Make a link'));
}

test('with no link yet, nothing in the dialog reads null', async () => {
  const { W, body } = load();
  W.shareApp({ id: 'aaaa1111' });
  const dialog = dialogOf(body);
  assert.match(textOf(dialog), /Loading…/);
  await settle();
  const text = textOf(dialog);
  assert.match(text, /Make a link/);
  assert.match(text, /Off: only you can open the app/);
  assert.doesNotMatch(text, /null|undefined/, text);
});

test('with a fresh link and links listed, nothing reads null either', async () => {
  const { W, body } = load({ view: { members: true, links: [{ id: 'old1', createdAt: 1, expiresAt: Date.now() + 3_600_000 }] } });
  W.shareApp({ id: 'aaaa1111' });
  const dialog = dialogOf(body);
  await settle();
  makeLink(dialog);
  await settle();
  const text = textOf(dialog);
  assert.match(text, /It is shown once/);
  assert.match(text, /Link l1/);
  assert.match(text, /Link old1/);
  assert.doesNotMatch(text, /null|undefined/, text);
  const field = walk(dialog).find((el) => el.tag === 'input');
  assert.equal(field.attrs.value, 'https://aaaa1111.apps.example.com/__woodshed/share?t=secret1');
});

test('the bar reads who it is shared with, and the dialog tells it when that changes', async () => {
  const { W, body, reads } = load();
  let redrawn = 0;
  const onChange = () => { redrawn += 1; };
  const s = { id: 'aaaa1111' };
  assert.equal(W.appShared(s, onChange), null, 'not read yet');
  await settle();
  assert.equal(redrawn, 1);
  assert.deepEqual({ ...W.appShared(s, onChange) }, { members: false, links: 0 });
  assert.equal(W.appSharedWords(W.appShared(s, onChange)), null, 'nobody else: Share, not Shared');
  assert.equal(reads.length, 1, 'read once within the minute');

  W.shareApp(s, { onChange });
  await settle();
  const dialog = dialogOf(body);
  makeLink(dialog);
  await settle();
  assert.deepEqual({ ...W.appShared(s, onChange) }, { members: false, links: 1 });
  assert.equal(W.appSharedWords(W.appShared(s, onChange)), '1 link');
  click(walk(dialog).find((el) => el.attrs.role === 'switch'));
  await settle();
  assert.equal(W.appSharedWords(W.appShared(s, onChange)), 'the console\'s members and 1 link');
  assert.ok(redrawn >= 3, 'each change redrew the bar');
});

test('a link that ran out no longer counts as shared', () => {
  const { W } = load();
  assert.equal(W.appSharedWords({ members: false, links: 0 }), null);
  assert.equal(W.appSharedWords({ members: true, links: 0 }), 'the console\'s members');
  assert.equal(W.appSharedWords({ members: false, links: 2 }), '2 links');
});
