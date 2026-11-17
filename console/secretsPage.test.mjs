// The Secrets & webhooks page (public/secrets.js) on a tiny DOM: the Terraform env files' rows, which moved to Repo
// settings.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./public/secrets.js', import.meta.url), 'utf8');

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

const row = (name, fields) => ({ name, group: 'session', kind: 'env', readable: true, exists: true, set: true, description: '', changedAt: '2026-10-01T00:00:00Z', ...fields });

async function loadPage(secrets) {
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
  const answers = { '/api/secrets-manager': { canChoose: false, configured: true, kind: 'aws' }, '/api/secrets': { repo: 'acme/app', secrets, webhook: null } };
  const W = {
    h, nav: () => element('nav'), settingsTabs: () => element('nav'), when: (iso) => `at ${iso}`, providerWords: {}, capitalised: (s) => s,
    getJson: async (path) => answers[path],
  };
  const context = vm.createContext({ window: { Woodshed: W }, document: { getElementById: () => app }, setTimeout });
  vm.runInContext(source, context);
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  return app;
}

const section = (app, title) => walk(app).find((e) => e.tag === 'section' && textOf(e.children[0]) === title);

test('an env file\'s secret is listed only while Repo settings have no values for it, with a link there', async () => {
  const app = await loadPage([
    row('anthropic-api-key', { kind: 'line', readable: false }),
    row('api-env', { moved: { secret: 'api-env', path: 'api/.env', project: 'app', repo: 'acme/app', key: 'api-env', copiedAt: '2026-11-12T10:00:00.000Z', saved: true } }),
    row('web-env', { set: false, moved: { secret: 'web-env', path: 'web/.env.local', project: 'app', repo: 'acme/app', key: 'web-env', copiedAt: null, saved: false } }),
  ]);
  const moved = section(app, 'Not in Repo settings yet');
  assert.ok(moved);
  assert.doesNotMatch(textOf(app), /api-env/, 'a file Repo settings hold is not listed anywhere');
  assert.doesNotMatch(textOf(section(app, 'Session secrets')), /web-env/, 'it leaves the session secrets');
  assert.match(textOf(moved), /No values on acme\/app's Repo settings yet, so sessions still read this one\. Set them there instead\./);
  const links = walk(moved).filter((e) => e.tag === 'a').map((a) => a.attrs.href);
  assert.deepEqual(links, ['/console-settings/repos/app?file=web-env']);
  const rows = walk(moved).filter((e) => e.className?.startsWith('secret-row'));
  assert.deepEqual(rows.map((r) => walk(r).filter((e) => e.tag === 'button').map(textOf)), [['Set']]);
});

test('once Repo settings hold every env file there is no such section', async () => {
  const app = await loadPage([
    row('anthropic-api-key', { kind: 'line', readable: false }),
    row('api-env', { moved: { secret: 'api-env', path: 'api/.env', project: 'app', repo: 'acme/app', key: 'api-env', copiedAt: '2026-11-12T10:00:00.000Z', saved: true } }),
  ]);
  assert.equal(section(app, 'Not in Repo settings yet'), undefined);
  assert.doesNotMatch(textOf(app), /api-env/);
  assert.ok(section(app, 'Session secrets'));
});

test('without env files there is no Moved section', async () => {
  const app = await loadPage([row('anthropic-api-key', { kind: 'line', readable: false })]);
  assert.equal(section(app, 'Not in Repo settings yet'), undefined);
  assert.ok(section(app, 'Session secrets'));
});

test('a missing secret shows Set where the store makes it on its first write, and none, with the AWS wording, where it does not', async () => {
  const buttonsOf = (app, name) => walk(walk(app).find((e) => e.className?.startsWith('secret-row') && textOf(e).includes(name))).filter((e) => e.tag === 'button').map(textOf);
  const creates = await loadPage([row('openai-api-key', { kind: 'line', readable: false, exists: false, set: false, creatable: true, changedAt: null })]);
  assert.deepEqual(buttonsOf(creates, 'openai-api-key'), ['Set']);
  assert.match(textOf(creates), /No value yet/);
  const terraform = await loadPage([row('openai-api-key', { kind: 'line', readable: false, exists: false, set: false, changedAt: null })]);
  assert.deepEqual(buttonsOf(terraform, 'openai-api-key'), []);
  assert.match(textOf(terraform), /Missing in AWS: apply Terraform to create it/);
});
