// The Set up Slack dialog (public/slackSetup.js), run as the page loads it on a tiny DOM: where it opens, what it
// checks, and what its save sends.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./public/slackSetup.js', import.meta.url), 'utf8');

function element(tag) {
  return {
    tag, attrs: {}, listeners: {}, children: [], className: '', value: '', open: false,
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(k, fn) { (this.listeners[k] ??= []).push(fn); },
    append(c) { this.children.push(c); },
    replaceChildren(...c) { this.children = c; },
    showModal() { this.open = true; },
    close() { this.open = false; for (const fn of this.listeners.close ?? []) fn(); },
    remove() { this.removed = true; },
    get textContent() { return textOf(this); },
    set textContent(v) { this.children = [String(v)]; },
  };
}

const textOf = (el) => (typeof el === 'string' ? el : el.children.map(textOf).join(''));
function walk(el, out = []) {
  if (typeof el === 'string') return out;
  out.push(el);
  for (const c of el.children) walk(c, out);
  return out;
}
const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r)); };
const fire = (el, type) => { for (const fn of el.listeners[type] ?? []) fn({ target: el }); };

const CHANNELS = { found: [{ id: 'C0APPPRS01', name: 'app-prs', private: false, member: true }], truncated: false, total: 1 };

function load({ refuse = null } = {}) {
  const body = element('body');
  const posted = [];
  const assigned = [];
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
  const W = {
    h, providerWords: { webhookReceiver: 'the webhook function', webhookUrlFix: 'run terraform apply, then open this again' },
    getJson: async () => structuredClone(CHANNELS),
    postJson: async (path, sent) => {
      posted.push({ path, body: JSON.parse(JSON.stringify(sent)) });
      if (path === '/api/console-settings/slack/channels') return structuredClone(CHANNELS);
      if (path === '/api/console-settings/slack/check') {
        if (sent.botToken.includes('bad')) throw new Error('Slack does not know this token.');
        return { team: 'Acme', name: 'shed-bot', missingScopes: [] };
      }
      if (refuse) throw refuse;
      return { connected: true };
    },
  };
  const context = vm.createContext({
    window: { Woodshed: W, alert: () => {} }, document: { body }, location: { assign: (href) => assigned.push(href) },
    navigator: { clipboard: { writeText: async () => {} } }, setTimeout: (fn) => setImmediate(fn), clearTimeout: () => {},
  });
  vm.runInContext(source, context);
  return { W, body, posted, assigned };
}

const VIEW = { connected: false, signingSecret: false, channel: '', channelName: null, eventsUrl: 'https://hooks.example/slack', manifest: 'display_information:\n  name: "Team Shed"\n', install: null };
const button = (el, text) => walk(el).find((e) => e.tag === 'button' && textOf(e) === text);
const byId = (el, id) => walk(el).find((e) => e.attrs.id === id);

test('with no install option it opens on the own app\'s four steps: the manifest with its Request URL, the token, the secret, the channel', async () => {
  const { W, body } = load();
  const dialog = W.openSlackSetup({ view: VIEW, onSaved: () => {} });
  await settle();
  assert.equal(dialog.open, true);
  const text = textOf(dialog);
  assert.match(text, /^Connect your Slack app/);
  assert.deepEqual(walk(dialog).filter((e) => e.tag === 'h3').map(textOf), ['Create the app from this manifest', 'Install it, then paste its bot token', 'Paste its signing secret', 'Choose a channel for pull requests']);
  assert.match(text, /this console's events Request URL, https:\/\/hooks\.example\/slack, which Slack checks/);
  assert.equal(textOf(walk(dialog).find((e) => e.tag === 'pre')), VIEW.manifest);
  assert.ok(button(dialog, 'Copy manifest'));
  assert.match(text, /Needed for questions only\. Without it, pull requests are still posted\./);
  assert.equal(byId(dialog, 'slack-bot-token').attrs.type, 'password');
  assert.match(text, /The channels are listed once Slack has taken the bot token above\./, 'with no token saved, the list waits for the pasted one');
  const connected = W.openSlackSetup({ view: { ...VIEW, connected: true }, mode: 'replace', onSaved: () => {} });
  await settle();
  assert.ok(walk(connected).some((e) => e.attrs.role === 'option' && /#app-prs/.test(textOf(e))), 'with one saved, the picker lists the channels at once');
  assert.equal(body.children[0], dialog);
});

test('a pasted token is checked with Slack, and Save and connect sends it with the secret and the picked channel', async () => {
  const { W, posted } = load();
  const saved = [];
  const dialog = W.openSlackSetup({ view: VIEW, onSaved: (v) => saved.push(v) });
  await settle();
  button(dialog, 'Save and connect').listeners.click[0]();
  assert.match(textOf(dialog), /Paste the bot token first\./);
  const token = byId(dialog, 'slack-bot-token');
  token.value = 'xoxb-bad-1111-2222';
  fire(token, 'input');
  await settle();
  assert.match(textOf(dialog), /Slack does not know this token\./);
  token.value = 'xoxb-1111-2222-abcdef';
  fire(token, 'input');
  await settle();
  assert.match(textOf(dialog), /✓ Acme workspace, bot @shed-bot\./);
  assert.ok(posted.some((p) => p.path === '/api/console-settings/slack/channels' && p.body.botToken === 'xoxb-1111-2222-abcdef'), 'listed with the token pasted, before it is saved');
  byId(dialog, 'slack-signing-secret').value = '0123456789abcdef0123456789abcdef';
  walk(dialog).find((e) => e.attrs.role === 'option').listeners.click[0]();
  button(dialog, 'Save and connect').listeners.click[0]();
  await settle();
  assert.deepEqual(posted.at(-1), { path: '/api/console-settings/slack', body: { botToken: 'xoxb-1111-2222-abcdef', signingSecret: '0123456789abcdef0123456789abcdef', channel: 'C0APPPRS01' } });
  assert.equal(dialog.open, false);
  assert.deepEqual(saved, [{ connected: true }]);
});

test('Replace keys folds the manifest away, starts with empty fields, and sends only what was filled in', async () => {
  const { W, posted } = load();
  const dialog = W.openSlackSetup({ view: { ...VIEW, connected: true, signingSecret: true, channel: 'C0APPPRS01' }, mode: 'replace', onSaved: () => {} });
  await settle();
  assert.match(textOf(dialog), /^Replace Slack's keys/);
  assert.ok(walk(dialog).find((e) => e.tag === 'details' && walk(e).some((x) => x.tag === 'pre')), 'the manifest is folded');
  assert.equal(byId(dialog, 'slack-bot-token').value, '');
  assert.equal(byId(dialog, 'slack-bot-token').attrs.placeholder, 'Empty keeps the saved token');
  byId(dialog, 'slack-signing-secret').value = 'fedcba9876543210fedcba9876543210';
  button(dialog, 'Save').listeners.click[0]();
  await settle();
  assert.deepEqual(posted.filter((p) => p.path === '/api/console-settings/slack'), [{ path: '/api/console-settings/slack', body: { signingSecret: 'fedcba9876543210fedcba9876543210' } }]);
});

test('a refused save stays in the dialog with the console\'s reason', async () => {
  const { W } = load({ refuse: new Error('Slack or the secret store did not answer.') });
  const dialog = W.openSlackSetup({ view: { ...VIEW, connected: true }, mode: 'replace', onSaved: () => {} });
  await settle();
  byId(dialog, 'slack-signing-secret').value = 'fedcba9876543210fedcba9876543210';
  button(dialog, 'Save').listeners.click[0]();
  await settle();
  assert.equal(dialog.open, true);
  assert.match(textOf(walk(dialog).find((e) => e.className === 'form-error')), /did not answer/);
});

test('with no events URL the manifest step says the address is unknown and how to find it', async () => {
  const { W } = load();
  const dialog = W.openSlackSetup({ view: { ...VIEW, eventsUrl: null }, onSaved: () => {} });
  await settle();
  assert.match(textOf(dialog), /does not know the address Slack should send its events to.*It is the webhook function's URL, at \/slack: run terraform apply, then open this again\. Pull requests are posted without it\./);
});

test('the program\'s install option is shown in its own words; not available, it is disabled and Coming soon', async () => {
  const { W, assigned } = load();
  const install = { label: 'Install the team app', description: 'One click, nothing to paste.', available: false, href: null, installed: false };
  const dialog = W.openSlackSetup({ view: { ...VIEW, install }, onSaved: () => {} });
  const options = walk(dialog).filter((e) => e.attrs.role === 'radio');
  assert.deepEqual(options.map(textOf), ['Use your own Slack appMake an app in your workspace from a manifest this console gives you, then paste its bot token and signing secret here.', 'Install the team appComing soonOne click, nothing to paste.']);
  assert.equal(options[1].attrs['aria-disabled'], 'true');
  options[1].listeners.click[0]();
  assert.equal(walk(dialog).filter((e) => e.attrs.role === 'radio')[0].attrs['aria-checked'], 'true', 'a disabled option cannot be picked');
  button(dialog, 'Continue').listeners.click[0]();
  await settle();
  assert.match(textOf(dialog), /^Connect your Slack app/);
  assert.ok(button(dialog, 'Back'), 'Back goes to the choice');
  assert.deepEqual(assigned, []);

  const live = load();
  const open = live.W.openSlackSetup({ view: { ...VIEW, install: { ...install, available: true, href: 'https://apps.example/install' } }, onSaved: () => {} });
  walk(open).filter((e) => e.attrs.role === 'radio')[1].listeners.click[0]();
  button(open, 'Continue').listeners.click[0]();
  assert.deepEqual(live.assigned, ['https://apps.example/install']);
});
