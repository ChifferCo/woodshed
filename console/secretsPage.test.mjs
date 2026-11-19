// The Secrets & webhooks page (public/secrets.js) on a tiny DOM: its groups, and each row's buttons.

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

const row = (name, fields) => ({ name, group: 'session', kind: 'line', readable: true, exists: true, set: true, description: '', changedAt: '2026-10-01T00:00:00Z', ...fields });

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
    h, nav: () => element('nav'), settingsTabs: () => element('nav'), scopePill: () => element('span'), when: (iso) => `at ${iso}`, providerWords: {}, capitalised: (s) => s,
    settingsPage: (_match, start) => start(app, { nav: () => element('nav'), interval: (fn, ms) => context.setInterval?.(fn, ms), timeout: (fn, ms) => context.setTimeout(fn, ms), on: (target, type, fn) => target.addEventListener?.(type, fn) }),
    getJson: async (path) => answers[path],
  };
  const context = vm.createContext({ window: { Woodshed: W }, document: { getElementById: () => app }, setTimeout });
  vm.runInContext(source, context);
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  return app;
}

const section = (app, title) => walk(app).find((e) => e.tag === 'section' && textOf(e.children[0]) === title);

test('each session secret is listed under Session secrets with Replace, Show for a readable one, and Set for one with no value', async () => {
  const app = await loadPage([
    row('anthropic-api-key', { readable: false }),
    row('registry-token'),
    row('other-token', { set: false }),
  ]);
  const rows = walk(section(app, 'Session secrets')).filter((e) => e.className?.startsWith('secret-row'));
  const actions = rows.map((r) => walk(r).filter((e) => e.tag === 'button').map(textOf));
  assert.deepEqual(actions, [['Replace'], ['Show', 'Replace'], ['Set']]);
});

test('there is no Moved to Repo settings section: the env files are Repo settings alone', async () => {
  const app = await loadPage([row('anthropic-api-key', { readable: false })]);
  assert.equal(section(app, 'Moved to Repo settings'), undefined);
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

test('Slack\'s two keys are not listed: one line points to the Slack card, where they are set', async () => {
  const app = await loadPage([
    row('github-app-key', { group: 'console', kind: 'pem', readable: false }),
    row('slack-bot-token', { group: 'console', readable: false }),
    row('slack-signing-secret', { group: 'console', readable: false }),
  ]);
  const group = section(app, 'Console only');
  assert.deepEqual(walk(group).filter((e) => e.className === 'secret-name').map(textOf), ['github-app-key']);
  const note = walk(group).find((e) => e.className === 'sub slack-moved');
  assert.equal(textOf(note), 'Slack\'s bot token and signing secret are set on Settings → Slack.');
  assert.equal(walk(note).find((e) => e.tag === 'a').attrs.href, '/console-settings#slack');
});
