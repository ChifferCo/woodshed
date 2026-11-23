// The Webhook events page, run from public/events.js the way a page loads it, on a tiny DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const rowsSource = fs.readFileSync(new URL('./public/settingsRows.js', import.meta.url), 'utf8');
const source = fs.readFileSync(new URL('./public/events.js', import.meta.url), 'utf8');

function element(tag) {
  return {
    tag, attrs: {}, listeners: {}, children: [], className: '',
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(k, fn) { this.listeners[k] = fn; },
    append(c) { this.children.push(c); },
    replaceChildren(...c) { this.children = c; },
  };
}

const textOf = (el) => (typeof el === 'string' ? el : el.children.map(textOf).join(''));

function walk(el, out = []) {
  if (typeof el === 'string') return out;
  out.push(el);
  for (const c of el.children) walk(c, out);
  return out;
}

const tick = () => new Promise((r) => setImmediate(r));

async function loadPage(answer, { search = '' } = {}) {
  const app = element('div');
  const h = (tag, attrs, ...children) => {
    const el = element(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(typeof c === 'object' ? c : String(c));
    return el;
  };
  const location = { pathname: '/events', search, hash: '' };
  const history = { replaceState(_s, _t, url) { location.search = String(url).startsWith('?') ? String(url) : ''; } };
  const W = {
    h, scopePill: () => element('span'), providerWords: {},
    when: (iso) => `at ${iso}`, ref: (e) => (e.kind === 'pr' ? `PR #${e.number}` : `#${e.number}`),
    issueUrl: (repo, e) => `https://github.test/${repo}/issues/${e.number}`,
    person: (login) => h('span', { class: 'person' }, `@${login}`),
    settingsPage: (_match, start) => start(app, { nav: () => element('nav'), interval: () => {}, on: () => {} }),
    getJson: async () => {
      if (answer instanceof Error) throw answer;
      return structuredClone(answer);
    },
  };
  const context = vm.createContext({ window: { Woodshed: W, location, history }, console, URLSearchParams, document: { getElementById: () => null, activeElement: null } });
  vm.runInContext(rowsSource, context);
  vm.runInContext(source, context);
  await tick();
  return { app };
}

const event = (fields) => ({ receivedAt: '2026-11-20T10:00:00.000Z', handledAt: '2026-11-20T10:00:01.000Z', deliveryId: 'abcdef12-3456', type: 'label', number: 41, kind: 'issue', login: 'mia-dev', detail: 'woodshed', sessionId: null, reason: null, ...fields });

const ANSWER = {
  repo: 'acme/app', queue: true, webhooks: {},
  events: [
    event({ outcome: 'failed', type: 'comment', detail: '/woodshed again', reason: 'the session could not be resumed' }),
    event({ outcome: 'ignored', type: 'mention', number: null, login: 'slack:U1', detail: 'how?', reason: null }),
    event({ outcome: 'duplicate', reason: 'the poll already started this one' }),
    event({ outcome: 'refreshed', type: 'pr', number: 57, kind: 'pr', detail: 'review submitted', reason: 'the chip' }),
    event({ outcome: 'started', sessionId: 'aaaa1111' }),
  ],
};

const lines = (app) => walk(app).filter((e) => /\bevent-line\b/.test(e.className));
const part = (line, cls) => walk(line).find((e) => new RegExp(`\\b${cls}\\b`).test(e.className));
const pillOf = (line) => { const p = part(line, 'pill'); return [textOf(p), p.className]; };

test('each delivery is one plain line in a box, with no table: its time, what the console did, its meta line and a status word', async () => {
  const { app } = await loadPage(ANSWER);
  assert.deepEqual(walk(app).filter((e) => ['table', 'tr', 'td', 'th'].includes(e.tag)), []);
  const box = walk(app).find((e) => e.className === 'set-rows-box');
  assert.equal(box.children.length, 5);
  assert.ok(lines(app).every((l) => /\bset-fold is-plain\b/.test(l.className) && !walk(l).some((e) => e.tag === 'button')), 'nothing to open');
  assert.deepEqual(lines(app).map((l) => textOf(part(l, 'set-name'))), [
    'The session could not be resumed', 'Nothing to do', 'The poll already started this one', 'Read again: the chip', 'Started session aaaa1111',
  ]);
  assert.deepEqual(lines(app).map(pillOf), [
    ['Failed', 'pill is-bad'], ['Ignored', 'pill'], ['Skipped', 'pill'], ['Acted on', 'pill is-ok'], ['Acted on', 'pill is-ok'],
  ]);
  assert.ok(!walk(app).some((e) => /\bdot\b/.test(e.className)), 'a status is a word, never a dot alone');
  const [failed, , , pull, started] = lines(app);
  assert.equal(textOf(part(failed, 'event-when')), 'at 2026-11-20T10:00:00.000Z');
  assert.deepEqual(part(failed, 'event-meta').children.map(textOf), ['comment', '#41 /woodshed again', '@mia-dev', 'abcdef12']);
  assert.equal(part(failed, 'event-id').attrs.title, 'Delivery abcdef12-3456', 'the whole id is on the short one');
  assert.equal(walk(pull).find((e) => e.tag === 'a').attrs.href, 'https://github.test/acme/app/issues/57');
  assert.equal(walk(part(started, 'set-name')).find((e) => e.tag === 'a').attrs.href, '/s/aaaa1111');
});

test('the filter keeps its three choices, reads ?show= and narrows the lines', async () => {
  const { app } = await loadPage(ANSWER, { search: '?show=problems' });
  const buttons = () => walk(app).filter((e) => e.tag === 'button');
  assert.deepEqual(buttons().map((b) => [textOf(b), b.attrs['aria-pressed']]), [['All', 'false'], ['Acted on', 'false'], ['Ignored or failed', 'true']]);
  assert.deepEqual(lines(app).map((l) => pillOf(l)[0]), ['Failed', 'Ignored', 'Skipped']);
  buttons()[1].listeners.click();
  assert.deepEqual(lines(app).map((l) => pillOf(l)[0]), ['Acted on', 'Acted on']);
  buttons()[0].listeners.click();
  assert.equal(lines(app).length, 5);
});

test('with nothing to list the page says which kind of nothing, and a source switched off is said above the list', async () => {
  const none = await loadPage({ ...ANSWER, queue: false, events: [] });
  assert.match(textOf(none.app), /No webhook events yet\./);
  assert.match(textOf(none.app), /No webhooks reach this console, so it only polls GitHub\./);
  const filtered = await loadPage({ ...ANSWER, events: ANSWER.events.slice(0, 3), webhooks: { github: { off: true } } }, { search: '?show=acted' });
  assert.match(textOf(filtered.app), /No events match this filter\./);
  assert.match(textOf(filtered.app), /GitHub webhooks are switched off on Settings, so the console drops them\./);
  assert.match(textOf(filtered.app), /Newest first\. The last 7 days are kept\./);
  assert.match(textOf(filtered.app), /Recent Deliveries page shows those as 401\./);
  const failed = await loadPage(new Error('only an admin can do this'));
  assert.match(textOf(failed.app), /Could not load events: only an admin can do this/);
});
