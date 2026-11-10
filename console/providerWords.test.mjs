// What the pages say about where sessions run: each provider's words, carried by pageShell's meta tag and read by
// public/common.js the way a page loads it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';
import { createRequire } from 'node:module';

import { AWS_WORDS } from '../providers/aws/index.mjs';
import { localWords } from '../providers/local/index.mjs';
import { DEFAULT_WORDS, providerMetaContent, providerWords } from './providerWords.mjs';
import { createHandler, pageShell } from './server.mjs';

const require = createRequire(import.meta.url);
const read = (name) => fs.readFileSync(new URL(`./public/${name}`, import.meta.url), 'utf8');

function unescapeAttribute(text) {
  return text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** common.js loaded under the page pageShell renders for this provider, as a browser reads its meta tag */
function pageFor(provider) {
  const shell = pageShell({ title: 'Woodshed Cloud', script: 'session.js', provider });
  const content = unescapeAttribute(shell.match(/<meta name="woodshed-provider" content="([^"]*)">/)[1]);
  const window = { WoodshedLogins: require('./public/logins.cjs'), WoodshedSetup: require('./public/setupSteps.cjs') };
  const context = vm.createContext({
    window, console,
    document: {
      addEventListener() {}, createElement: () => ({}),
      querySelector: (selector) => (selector === 'meta[name="woodshed-provider"]' ? { content } : null),
    },
    matchMedia: () => ({}),
    fetch: () => new Promise(() => {}),
  });
  vm.runInContext(read('common.js'), context);
  return window.Woodshed;
}

const STARTED = '2026-11-08T10:00:00.000Z';
const at = (seconds) => new Date(Date.parse(STARTED) + seconds * 1000).toISOString();
const starting = (startSteps) => ({ status: 'starting', startedAt: STARTED, startSteps });
const noRoom = { status: 'queued', retryAt: new Date(Date.now() + 60_000).toISOString() };
// Plain values from the page's realm, so deepEqual compares what they hold.
const plain = (value) => JSON.parse(JSON.stringify(value));
const labels = (W, s) => plain(W.startProgress(s, Date.parse(at(30))).steps.map((step) => [step.key, step.label, step.short]));
const LOCAL = localWords({ memory: '6g', cpus: '2' });

test('on AWS the start checklist and the wait for room read as they always have', () => {
  const W = pageFor({ name: 'aws', words: AWS_WORDS });
  assert.deepEqual(labels(W, starting({})).slice(0, 4), [
    ['machine', 'Getting a machine from AWS', 'getting a machine'],
    ['pullStarted', 'Waiting for AWS to start it', 'waiting for AWS'],
    ['container', 'Pulling the session image', 'pulling the image'],
    ['settings', 'Fetching its settings', 'settings'],
  ]);
  assert.deepEqual(plain(W.lastLine(noRoom)), { who: 'console', text: 'Waiting for AWS to have room.' });
  assert.equal(W.providerWords.noRoom.title, 'Waiting for AWS');
  assert.equal(W.providerWords.noRoom.detail, 'AWS has no room for another session right now. The console tries again every minute.');
  assert.match(W.providerWords.capacityNote, /^AWS has a ceiling of its own: the account's Fargate vCPU quota/);
});

test('on the local provider the checklist names a container, and has no wait for a pull docker never reports', () => {
  const W = pageFor({ name: 'local', words: LOCAL });
  const steps = labels(W, starting({}));
  assert.deepEqual(steps.slice(0, 3), [
    ['machine', 'Starting a container', 'starting a container'],
    ['container', 'Booting the container', 'booting'],
    ['settings', 'Fetching its settings', 'settings'],
  ]);
  assert.ok(!steps.some(([, label]) => /AWS/.test(label)), 'no step names AWS');
  assert.equal(W.startProgress(starting({ machine: at(8) }), Date.parse(at(9))).current.label, 'Booting the container');
  assert.equal(W.startProgress(starting({ machine: at(8), container: at(9) }), Date.parse(at(10))).current.label, 'Fetching its settings');
  assert.doesNotMatch(W.lastLine(noRoom).text, /AWS/);
  assert.equal(W.providerWords.capacityNote,
    'Sessions are containers on the console\'s own machine, each held to 6 GB of memory and 2 CPUs. Docker refuses none of them for room, so keep the limits to what the machine can hold.');
  assert.equal(W.providerWords.homesPlace, 'the homes folder');
});

test('nothing in the local provider\'s words names AWS, Fargate, S3, RDS or a Lambda', () => {
  assert.doesNotMatch(JSON.stringify(providerWords({ name: 'local', words: LOCAL })), /AWS|Fargate|\bS3\b|\bRDS\b|Lambda|[Tt]erraform/);
});

test('a provider with no words of its own gets ones that name none, and its own replace them a group at a time', () => {
  assert.deepEqual(providerWords({ name: 'next' }), { name: 'next', words: DEFAULT_WORDS });
  const { words } = providerWords({ name: 'next', words: { startSteps: { machine: ['Renting a VM', 'renting'] }, noRoom: { title: 'Full' } } });
  assert.deepEqual(words.startSteps.machine, ['Renting a VM', 'renting']);
  assert.deepEqual(words.startSteps.pullStarted, DEFAULT_WORDS.startSteps.pullStarted);
  assert.equal(words.noRoom.title, 'Full');
  assert.equal(words.noRoom.detail, DEFAULT_WORDS.noRoom.detail);
  const W = pageFor(null);
  assert.equal(labels(W, starting({}))[0][1], 'Getting a machine');
});

test('the meta tag holds the words as an attribute that cannot be closed early', () => {
  const content = providerMetaContent({ name: 'x', words: { capacityNote: '"><script>alert(1)</script>&' } });
  assert.doesNotMatch(content, /["<>]/);
  assert.equal(JSON.parse(unescapeAttribute(content)).words.capacityNote, '"><script>alert(1)</script>&');
});

test('a page whose meta tag is missing still draws, leaving out the steps only a provider names', () => {
  const window = { WoodshedLogins: require('./public/logins.cjs'), WoodshedSetup: require('./public/setupSteps.cjs') };
  const context = vm.createContext({
    window, console, document: { addEventListener() {}, createElement: () => ({}) }, matchMedia: () => ({}), fetch: () => new Promise(() => {}),
  });
  vm.runInContext(read('common.js'), context);
  assert.equal(window.Woodshed.startProgress(starting({}), Date.parse(at(1))).steps[0].key, 'settings');
});

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers: { host: `localhost:${port}` } }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve(raw));
    }).on('error', reject);
  });
}

test('the console hands its provider\'s words to each page, and names its fixed secret store by the provider', async (t) => {
  const fleet = { sessions: () => [], find: () => null };
  const config = { host: '127.0.0.1', publicUrl: 'http://localhost', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const secrets = { list: async () => [], read: async () => null };
  const handle = createHandler({ config, fleet, secrets, provider: { name: 'local', words: LOCAL } });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  t.after(() => server.close());

  for (const path of ['/s/aaaa1111', '/console-settings', '/secrets', '/events']) {
    const page = await get(port, path);
    const content = unescapeAttribute(page.match(/<meta name="woodshed-provider" content="([^"]*)">/)?.[1] ?? 'null');
    assert.equal(JSON.parse(content)?.words.startSteps.machine[0], 'Starting a container', path);
  }
  assert.deepEqual(JSON.parse(await get(port, '/api/secrets-manager')), { canChoose: false, configured: true, kind: 'local' });
});
