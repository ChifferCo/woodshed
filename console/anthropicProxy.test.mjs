import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createAnthropicProxy, proxyCredential } from './anthropicProxy.mjs';
import { createSessionApi } from './sessionApi.mjs';

const SESSIONS = [
  { id: 'aaaaaaaa', status: 'running', token: 'shared-team', owner: null, startedBy: 'mia', plan: null },
  { id: 'bbbbbbbb', status: 'running', token: 'joel-private', owner: 'joel' },
  { id: 'cccccccc', status: 'running', token: 'joel-shared', owner: null, startedBy: 'joel', plan: 'joel' },
  { id: 'dddddddd', status: 'running', token: 'mismatch', owner: null, startedBy: 'mia', plan: 'joel' },
  { id: 'eeeeeeee', status: 'stopped', token: 'stopped', owner: 'joel' },
  { id: 'ffffffff', status: 'running', token: 'sam-private', owner: 'sam' },
];

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// Anthropic, as far as the proxy can tell: it answers with what it was sent.
async function fakeAnthropic(t) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_1' });
      res.end('event: message_stop\n\n');
    });
  });
  const port = await listen(server);
  t.after(() => server.close());
  return { seen, url: `http://127.0.0.1:${port}` };
}

function fakeUserSettings({ tokens, savedAt = '2026-10-28T10:00:00.000Z' }) {
  const reads = [];
  return {
    reads,
    saved: { at: savedAt },
    view(login) {
      return { claudeToken: { savedAt: tokens[login] ? this.saved.at : null } };
    },
    async claudeToken(login) {
      reads.push(login);
      return tokens[login] ?? null;
    },
  };
}

async function setup(t, { userSettings, secrets = null, teamKey = null }) {
  const anthropic = await fakeAnthropic(t);
  const proxy = createAnthropicProxy({ userSettings, secrets, teamKey, upstream: anthropic.url });
  const handle = createSessionApi({ fleet: { sessions: () => SESSIONS }, tokens: { token: async () => ({}) }, anthropic: proxy });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const call = (headers, { method = 'POST', path = '/anthropic/v1/messages?beta=true', body = '{"model":"claude"}' } = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: method === 'POST' ? body : undefined });
  return { seen: anthropic.seen, call };
}

test('each session\'s first call on a route is logged once per caller, with whose credential it went out on', async (t) => {
  const lines = [];
  t.mock.method(console, 'log', (message, context) => { if (message === 'anthropicProxy: first call') lines.push(context); });
  const { call } = await setup(t, { userSettings: fakeUserSettings({ tokens: { joel: 'sk-ant-oat01-joel' } }), teamKey: 'sk-ant-api03-team' });

  const claude = { 'user-agent': 'claude-cli/2.1.312 (external, cli)' };
  await call({ ...claude, 'x-api-key': 'shared-team' });
  await call({ ...claude, 'x-api-key': 'shared-team' });
  await call({ ...claude, authorization: 'Bearer joel-private' });
  await call({ ...claude, authorization: 'Bearer joel-private' });
  await call({ ...claude, authorization: 'Bearer shared-team' });
  await call({ 'user-agent': 'Anthropic/JS 0.120.0', 'x-api-key': 'shared-team' });
  assert.deepEqual(lines, [
    { sessionId: 'aaaaaaaa', via: 'teamKey', plan: null, caller: 'claude-cli' },
    { sessionId: 'bbbbbbbb', via: 'plan', plan: 'joel', caller: 'claude-cli' },
    { sessionId: 'aaaaaaaa', via: 'teamKey', plan: null, caller: 'Anthropic' },
  ], 'a refused call is not a first call; another caller on the same route is');
});

test('proxyCredential reads the session token from either header', () => {
  assert.deepEqual(proxyCredential({ 'x-api-key': 'abc' }), { token: 'abc', via: 'apiKey' });
  assert.deepEqual(proxyCredential({ authorization: 'Bearer abc' }), { token: 'abc', via: 'plan' });
  assert.equal(proxyCredential({ authorization: 'Basic abc' }), null);
  assert.equal(proxyCredential({}), null);
});

test('the team key is added here, and the session token never reaches Anthropic', async (t) => {
  const secrets = { reads: 0, async read(name) { this.reads++; return name === 'anthropic-api-key' ? 'sk-ant-api03-team' : null; } };
  const { seen, call } = await setup(t, { userSettings: fakeUserSettings({ tokens: {} }), secrets });

  const res = await call({ 'x-api-key': 'shared-team', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'x' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('request-id'), 'req_1', 'Anthropic\'s headers come back');
  assert.equal(await res.text(), 'event: message_stop\n\n');
  assert.equal(seen[0].url, '/v1/messages?beta=true', 'the prefix is the console\'s alone');
  assert.equal(seen[0].body, '{"model":"claude"}');
  assert.equal(seen[0].headers['x-api-key'], 'sk-ant-api03-team');
  assert.equal(seen[0].headers['anthropic-beta'], 'x');
  assert.equal(seen[0].headers.authorization, undefined);
  assert.ok(!JSON.stringify(seen[0].headers).includes('shared-team'), 'no trace of the session token');

  await call({ 'x-api-key': 'joel-private' });
  assert.equal(seen[1].headers['x-api-key'], 'sk-ant-api03-team', 'any session\'s backend runs on the team key');
  assert.equal(secrets.reads, 1, 'read once, then kept a while');
});

test('a bearer gets the Claude plan the session runs on, and no other', async (t) => {
  const userSettings = fakeUserSettings({ tokens: { joel: 'sk-ant-oat01-joel' } });
  const { seen, call } = await setup(t, { userSettings, teamKey: 'sk-ant-api03-team' });

  assert.equal((await call({ authorization: 'Bearer joel-private' })).status, 200);
  assert.equal(seen.at(-1).headers.authorization, 'Bearer sk-ant-oat01-joel', 'a private session: its owner\'s');
  assert.equal(seen.at(-1).headers['x-api-key'], undefined);
  assert.equal((await call({ authorization: 'Bearer joel-shared' })).status, 200);
  assert.equal(seen.at(-1).headers.authorization, 'Bearer sk-ant-oat01-joel', 'a shared one: its starter\'s');

  assert.equal((await call({ authorization: 'Bearer shared-team' })).status, 403, 'a team-key session has no plan to use');
  assert.equal((await call({ authorization: 'Bearer mismatch' })).status, 403, 'a plan that is not the starter\'s');
  assert.equal((await call({ authorization: 'Bearer sam-private' })).status, 401, 'an owner with no token saved');
  assert.equal(seen.length, 2, 'none of those reached Anthropic');
  assert.deepEqual(userSettings.reads, ['joel'], 'the token is read once and kept');

  userSettings.saved.at = '2026-10-28T11:00:00.000Z';
  await call({ authorization: 'Bearer joel-private' });
  assert.deepEqual(userSettings.reads, ['joel', 'joel'], 'a token saved again is read again');
});

test('a stopped session, an unknown token or none at all reach nothing; the connectivity check needs none', async (t) => {
  const { seen, call } = await setup(t, { userSettings: fakeUserSettings({ tokens: { joel: 'sk-ant-oat01-joel' } }), teamKey: 'sk-ant-api03-team' });
  assert.equal((await call({ authorization: 'Bearer stopped' })).status, 401);
  assert.equal((await call({ 'x-api-key': 'sk-ant-api03-guess' })).status, 401);
  assert.equal((await call({})).status, 401);
  assert.equal((await call({}, { method: 'HEAD', path: '/anthropic/api/hello' })).status, 200);
  assert.equal(seen.length, 0);
});

test('no team key, or Secrets Manager failing, fails the call and not the console', async (t) => {
  const missing = await setup(t, { userSettings: fakeUserSettings({ tokens: {} }), secrets: { read: async () => null } });
  assert.equal((await missing.call({ 'x-api-key': 'shared-team' })).status, 503);
  const failing = await setup(t, { userSettings: fakeUserSettings({ tokens: {} }), secrets: { read: async () => { throw new Error('AccessDenied'); } } });
  assert.equal((await failing.call({ 'x-api-key': 'shared-team' })).status, 502);
  assert.equal(missing.seen.length + failing.seen.length, 0);
});

test('calls during a team key read share it, and a failed read is tried again on the next call', async () => {
  let reads = 0;
  let release;
  const secrets = { read: () => { reads += 1; return new Promise((resolve, reject) => { release = { resolve, reject }; }); } };
  const { teamCredential } = createAnthropicProxy({ secrets });
  const both = Promise.all([teamCredential(), teamCredential()]);
  release.resolve('sk-ant-api03-team');
  assert.deepEqual(await both, ['sk-ant-api03-team', 'sk-ant-api03-team']);
  assert.equal(await teamCredential(), 'sk-ant-api03-team');
  assert.equal(reads, 1);

  const failing = createAnthropicProxy({ secrets });
  const first = failing.teamCredential();
  release.reject(new Error('AccessDenied'));
  await assert.rejects(first, /AccessDenied/);
  const second = failing.teamCredential();
  release.resolve('k');
  assert.equal(await second, 'k');
  assert.equal(reads, 3);
});
