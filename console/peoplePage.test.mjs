// The People page (public/people.js) behind a hosting proxy, on a tiny DOM: the program's note beside each person, and
// what its add says it did in place of the hint that nothing is sent. Both are drawn as text, never as markup.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./public/people.js', import.meta.url), 'utf8');

function element(tag) {
  return {
    tag, attrs: {}, listeners: {}, children: [], className: '', value: '', hidden: false,
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(k, fn) { this.listeners[k] = fn; },
    append(c) { this.children.push(c); },
    replaceChildren(...c) { this.children = c; },
    focus() {},
  };
}

const textOf = (el) => (typeof el === 'string' ? el : el.children.map(textOf).join(''));
function walk(el, out = []) {
  if (typeof el === 'string') return out;
  out.push(el);
  for (const c of el.children) walk(c, out);
  return out;
}

const person = (login, role, fields = {}) => ({ login, role, admin: role === 'owner', githubSessions: true, assignable: false, ...fields });

async function loadPage({ members, addReply }) {
  const app = element('div');
  const h = (tag, attrs, ...children) => {
    const el = element(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    // As common.js's h: anything that is not an element becomes a text node, so markup in a string stays text.
    for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(typeof c === 'object' ? c : String(c));
    return el;
  };
  const list = { members, requests: [], hosted: true, names: {}, slack: null };
  const posted = [];
  const W = {
    h, settingsTabs: () => element('nav'), scopePill: () => element('span'), sameLogin: (a, b) => String(a).toLowerCase() === String(b).toLowerCase(),
    personText: (l) => `@${l}`, ago: () => 'just now', shell: { toast() {} },
    settingsPage: (_match, start) => start(app, { nav: () => element('nav'), interval: () => {} }),
    getJson: async (path) => (path === '/api/me' ? { login: 'ana-owner' } : list),
    postJson: async (path, body) => { posted.push([path, body]); return addReply(body); },
  };
  const context = vm.createContext({ window: { Woodshed: W, confirm: () => true, alert() {} }, document: { activeElement: null } });
  vm.runInContext(source, context);
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  const find = (pred) => walk(app).find(pred);
  async function add(login) {
    find((e) => e.attrs.id === 'invite').value = login;
    await find((e) => e.attrs.id === 'invite-card').listeners.submit({ preventDefault() {} });
  }
  const hint = () => textOf(find((e) => e.attrs.id === 'add-hint'));
  const rowOf = (login) => find((e) => e.tag === 'tr' && textOf(e).includes(`@${login}`));
  return { app, add, hint, rowOf, posted };
}

const CORE_HINT = 'They can sign in straight away. An owner is an admin here. Nothing is sent to them: tell them the link.';

test('a note from the program is shown under the person, muted, as text', async () => {
  const { rowOf } = await loadPage({
    members: [person('ana-owner', 'owner'), person('lee-dev', 'member', { note: 'hasn\'t signed in yet' }), person('bo-dev', 'member', { note: '<img src=x onerror=alert(1)>' })],
    addReply: () => null,
  });
  const meta = (login) => walk(rowOf(login)).find((e) => e.className === 'meta');
  assert.equal(textOf(meta('lee-dev')), 'hasn\'t signed in yet');
  assert.deepEqual(meta('bo-dev').children, ['<img src=x onerror=alert(1)>'], 'one text child, no element made from it');
  assert.equal(textOf(meta('ana-owner')), '', 'nothing for someone the program notes nothing about');
});

test('after an add, what the program says it did stands in for core\'s hint; with nothing said, core\'s hint stays', async () => {
  let told = 'We emailed them a link.';
  const members = [person('ana-owner', 'owner')];
  const { add, hint, posted } = await loadPage({
    members,
    addReply: (body) => ({ members: [...members, person(body.login, body.role)], requests: [], hosted: true, names: {}, slack: null, told }),
  });
  assert.equal(hint(), CORE_HINT, 'before any add');
  await add('lee-dev');
  assert.deepEqual([posted[0][0], posted[0][1].login], ['/api/people/add', 'lee-dev']);
  assert.equal(hint(), 'They can sign in straight away. An owner is an admin here. We emailed them a link.');
  told = '<script>alert(1)</script>';
  await add('bo-dev');
  assert.match(hint(), /<script>alert\(1\)<\/script>$/, 'as text, since h makes a text node of it');
  told = null;
  await add('cy-dev');
  assert.equal(hint(), CORE_HINT, 'an add the program said nothing about');
});
