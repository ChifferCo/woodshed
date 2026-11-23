// The Secrets & webhooks page (public/secrets.js) on a tiny DOM: its groups, and each row's pill and buttons.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./public/secrets.js', import.meta.url), 'utf8');
const rowsSource = fs.readFileSync(new URL('./public/settingsRows.js', import.meta.url), 'utf8');

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

async function loadPage(secrets, webhook = null, { hash = '', manager = { canChoose: false, configured: true, kind: 'aws' }, checks = { active: true, secret: true, url: true, missingEvents: [] } } = {}) {
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
  const answers = { '/api/secrets-manager': manager, '/api/secrets': { repo: 'acme/app', secrets, webhook }, '/api/webhook/deliveries': { deliveries: [] } };
  const W = {
    h, nav: () => element('nav'), settingsTabs: () => element('nav'), scopePill: () => element('span'), when: (iso) => `at ${iso}`, providerWords: {}, capitalised: (s) => s,
    settingsPage: (_match, start) => start(app, { nav: () => element('nav'), interval: (fn, ms) => context.setInterval?.(fn, ms), timeout: (fn, ms) => context.setTimeout(fn, ms), on: (target, type, fn) => target.addEventListener?.(type, fn) }),
    getJson: async (path) => answers[path],
    webhookChecks: () => checks, eventName: (e) => e,
  };
  const context = vm.createContext({ window: { Woodshed: W, location: { hash } }, document: { getElementById: () => app, activeElement: null }, setTimeout });
  vm.runInContext(rowsSource, context);
  vm.runInContext(source, context);
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  return app;
}

// A group is its label over the box of its rows; a row is a section with its id.
const groupOf = (app, label) => walk(app).find((e) => e.className === 'set-group' && textOf(e.children[0]) === label);
const rowOf = (app, id) => walk(app).find((e) => e.tag === 'section' && e.attrs.id === id);
const rowsOf = (group) => walk(group).filter((e) => e.tag === 'section' && e.className?.startsWith('set-fold'));
const buttonsIn = (el) => walk(el).filter((e) => e.tag === 'button' && e.className !== 'set-fold-head').map(textOf);
const pillOf = (el) => textOf(walk(el).find((e) => e.className?.startsWith('pill')));
const openRow = async (app, id) => {
  walk(rowOf(app, id)).find((e) => e.className === 'set-fold-head').listeners.click();
  await new Promise((r) => setImmediate(r));
};

const SECRETS = [
  row('anthropic-api-key', { readable: false }),
  row('registry-token', { description: 'For the installs' }),
  row('other-token', { set: false }),
];

test('each session secret is a row under Session secrets that says what it is, whether it is set and when it changed', async () => {
  const app = await loadPage(SECRETS);
  const rows = rowsOf(groupOf(app, 'Session secrets'));
  assert.deepEqual(rows.map((r) => r.attrs.id), ['secret-anthropic-api-key', 'secret-registry-token', 'secret-other-token']);
  assert.deepEqual(rows.map(pillOf), ['Set', 'Set', 'Not set']);
  assert.match(textOf(rows[1]), /registry-tokenFor the installs · Changed at 2026-10-01/);
  assert.match(textOf(rows[2]), /No value yet/);
  // Closed, a row shows no value and no form.
  assert.deepEqual(rows.map(buttonsIn), [[], [], []]);
  assert.ok(rows.every((r) => !r.className.includes('is-open')));
});

test('an open row has Show for a readable secret, the write-only note for the others, and the form that replaces or sets it', async () => {
  const app = await loadPage(SECRETS);
  for (const s of SECRETS) await openRow(app, `secret-${s.name}`);
  const [key, token, other] = SECRETS.map((s) => rowOf(app, `secret-${s.name}`));
  assert.ok([key, token, other].every((r) => r.className.includes('is-open')), 'several rows are open at once');
  assert.deepEqual(buttonsIn(key), ['Review change', 'Cancel']);
  assert.match(textOf(key), /Write-only: sessions never see this key/);
  assert.match(textOf(key), /Replace it/);
  assert.deepEqual(buttonsIn(token), ['Show', 'Review change', 'Cancel']);
  assert.match(textOf(token), /hidden/);
  assert.deepEqual(buttonsIn(other), ['Review change', 'Cancel']);
  assert.match(textOf(other), /Set it/);
  // Cancel empties the form and closes the row.
  walk(other).find((e) => e.tag === 'button' && textOf(e) === 'Cancel').listeners.click();
  assert.ok(!rowOf(app, 'secret-other-token').className.includes('is-open'));
});

test('a link that names a secret opens its row', async () => {
  const app = await loadPage(SECRETS, null, { hash: '#secret-registry-token' });
  assert.ok(rowOf(app, 'secret-registry-token').className.includes('is-open'));
  assert.ok(!rowOf(app, 'secret-other-token').className.includes('is-open'));
});

test('there is no Moved to Repo settings section: the env files are Repo settings alone', async () => {
  const app = await loadPage([row('anthropic-api-key', { readable: false })]);
  assert.equal(groupOf(app, 'Moved to Repo settings'), undefined);
  assert.ok(groupOf(app, 'Session secrets'));
});

test('a missing secret has its form where the store makes it on its first write, and none, with the AWS wording, where it does not', async () => {
  const opened = async (fields) => {
    const app = await loadPage([row('openai-api-key', { kind: 'line', readable: false, exists: false, set: false, changedAt: null, ...fields })]);
    await openRow(app, 'secret-openai-api-key');
    return rowOf(app, 'secret-openai-api-key');
  };
  const creates = await opened({ creatable: true });
  assert.deepEqual(buttonsIn(creates), ['Review change', 'Cancel']);
  assert.match(textOf(creates), /No value yet/);
  const terraform = await opened({});
  assert.deepEqual(buttonsIn(terraform), []);
  assert.match(textOf(terraform), /Missing in AWS: apply Terraform to create it/);
});

test('Slack\'s two keys are not listed: one row points to the Slack card, where they are set', async () => {
  const app = await loadPage([
    row('github-app-key', { group: 'console', kind: 'pem', readable: false }),
    row('slack-bot-token', { group: 'console', readable: false }),
    row('slack-signing-secret', { group: 'console', readable: false }),
  ]);
  const group = groupOf(app, 'Console only');
  assert.deepEqual(walk(group).filter((e) => e.className === 'secret-name').map(textOf), ['github-app-key']);
  const note = rowOf(app, 'secret-slack-keys');
  assert.equal(note.className, 'set-fold is-plain', 'nothing to open');
  assert.equal(textOf(note), 'Slack\'s bot token and signing secret' + 'Set on Settings → Slack.');
  assert.equal(walk(note).find((e) => e.tag === 'a').attrs.href, '/console-settings#slack');
});

test('Webhook events is a row of the GitHub webhook group, or a link in the page\'s note when there is no webhook', async () => {
  const eventsLinks = (app) => walk(app).filter((e) => e.tag === 'a' && e.attrs.href === '/events');
  const noHook = await loadPage([row('API_KEY')]);
  const [inNote] = eventsLinks(noHook);
  assert.equal(textOf(inNote), 'Webhook events');
  assert.equal(eventsLinks(noHook).length, 1, 'once');
  const note = walk(noHook).find((e) => e.tag === 'header').children[0].children.find((e) => e.tag === 'p');
  assert.ok(eventsLinks(note).length === 1, 'in the note under the tabs');
  assert.equal(groupOf(noHook, 'GitHub webhook'), undefined);

  const hooked = await loadPage([row('API_KEY')], { events: ['issues'], github: {}, expectedUrl: 'https://hooks.test/' });
  assert.equal(eventsLinks(hooked).length, 1, 'once, on its row alone');
  const events = rowOf(hooked, 'hook-events');
  assert.equal(eventsLinks(events).length, 1);
  assert.equal(textOf(events), 'Webhook events' + 'What came in and what the console did with each.');
  assert.equal(groupOf(hooked, 'GitHub webhook').attrs.id, 'hook-title', 'where the search lands');
});

test('the webhook\'s rows say where the setup stands, and open on the checks and on the payload URL and secret', async () => {
  const hook = { events: ['issues'], github: { url: 'https://hooks.test/', slug: 'shed' }, expectedUrl: 'https://hooks.test/' };
  const secrets = [row('github-webhook-secret', { group: 'console', kind: 'webhook' })];
  const app = await loadPage(secrets, hook);
  // No delivery yet, so the last check fails and the closed row says so.
  assert.equal(pillOf(rowOf(app, 'hook-connection')), 'Needs setup');
  assert.match(textOf(rowOf(app, 'hook-connection')), /No deliveries from GitHub yet/);
  assert.equal(pillOf(rowOf(app, 'hook-payload')), 'Secret set');
  assert.match(textOf(rowOf(app, 'hook-payload')), /The GitHub App posts to the webhook receiver\./);
  assert.equal(walk(app).filter((e) => e.className === 'secret-name' && textOf(e) === 'github-webhook-secret').length, 0, 'the webhook secret is not a row of its own');

  await openRow(app, 'hook-connection');
  await openRow(app, 'hook-payload');
  assert.equal(walk(rowOf(app, 'hook-connection')).filter((e) => e.tag === 'li').length, 4, 'the four checks');
  assert.deepEqual(buttonsIn(rowOf(app, 'hook-connection')), ['Set up webhook']);
  assert.deepEqual(buttonsIn(rowOf(app, 'hook-payload')), ['Copy', 'Change', 'Show', 'Rotate secret', 'Set on the GitHub App']);
  assert.deepEqual(walk(rowOf(app, 'hook-payload')).filter((e) => e.tag === 'a').map(textOf), ['Open GitHub App settings', 'Recent deliveries']);

  const bare = await loadPage([row('github-webhook-secret', { group: 'console', kind: 'webhook', set: false })], { ...hook, github: {} }, { checks: { active: false, secret: false, url: false, missingEvents: ['issues'] } });
  assert.equal(pillOf(rowOf(bare, 'hook-payload')), 'No secret');
  assert.match(textOf(rowOf(bare, 'hook-connection')), /The App’s webhook is switched off in GitHub/);
  await openRow(bare, 'hook-payload');
  assert.deepEqual(buttonsIn(rowOf(bare, 'hook-payload')), ['Copy', 'Change', 'Make a secret']);
});

test('the secrets manager is a row where the console lets it be chosen, open until one is', async () => {
  const fixed = await loadPage(SECRETS);
  assert.equal(groupOf(fixed, 'Where secrets are kept'), undefined);
  const local = { canChoose: true, configured: true, kind: 'local', dir: '/state/secrets', defaultPrefix: 'woodshed/' };
  const chosen = await loadPage(SECRETS, null, { manager: local });
  assert.equal(groupOf(chosen, 'Where secrets are kept').attrs.id, 'group-manager');
  const manager = rowOf(chosen, 'secrets-manager');
  assert.equal(pillOf(manager), 'In use');
  assert.match(textOf(manager), /In use: sealed files in \/state\/secrets\./);
  assert.ok(!manager.className.includes('is-open'));
  await openRow(chosen, 'secrets-manager');
  assert.deepEqual(buttonsIn(rowOf(chosen, 'secrets-manager')), ['Switch']);

  const none = await loadPage(SECRETS, null, { manager: { canChoose: true, configured: false, kind: null, defaultPrefix: 'woodshed/' } });
  assert.equal(pillOf(rowOf(none, 'secrets-manager')), 'Not chosen');
  assert.ok(rowOf(none, 'secrets-manager').className.includes('is-open'));
  assert.deepEqual(buttonsIn(rowOf(none, 'secrets-manager')), ['Use this']);
});
