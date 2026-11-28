import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';

import { CONSOLE_FAILED, createAuth } from './auth.mjs';
import { createAddedProjects, createHostProjects } from './addedProjects.mjs';
import { createConsoleSettings, liveConfig } from './consoleSettings.mjs';
import { createProjectColors } from './projectColors.mjs';
import { createTunnel } from './dbTunnel.mjs';
import { createCliSignIn } from './cliSignIn.mjs';
import { createConsoleUpgrade, createHandler } from './server.mjs';
import { createTrustedIdentity, IDENTITY_HEADER, signIdentity } from './trustedIdentity.mjs';
import { createClaudeSettings } from './claudeSettings.mjs';
import agentsRegistry from '../shared/agents.cjs';
import { createSlack } from './slack.mjs';
import { createUserSettings } from './userSettings.mjs';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(port, { method = 'GET', path, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the console refuses unknown hosts and cross-origin writes', async (t) => {
  const stopped = [];
  const session = { id: '0a1b2c3d', status: 'running', title: 't' };
  const fleet = {
    sessions: () => [session],
    find: (id) => (id === session.id ? session : null),
    stop: async (s) => { stopped.push(s.id); },
  };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const handle = createHandler({ config, fleet });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());

  assert.equal(await request(port, { path: '/api/sessions', headers: { host: `localhost:${port}` } }), 200);
  assert.equal(await request(port, { path: '/api/sessions', headers: { host: 'console.example' } }), 200);
  assert.equal(await request(port, { path: '/api/sessions', headers: { host: 'rebound.evil.example' } }), 421);
  assert.equal(await request(port, { path: '/term/0a1b2c3d/', headers: { host: 'rebound.evil.example' } }), 421);

  const stop = { method: 'POST', path: '/api/sessions/0a1b2c3d/stop' };
  assert.equal(await request(port, { ...stop, headers: { host: `localhost:${port}` } }), 403);
  assert.equal(await request(port, { ...stop, headers: { host: `localhost:${port}`, 'x-woodshed': '1', origin: 'https://evil.example' } }), 403);
  assert.deepEqual(stopped, []);
  assert.equal(await request(port, { ...stop, headers: { host: `localhost:${port}`, 'x-woodshed': '1', origin: `http://localhost:${port}` } }), 200);
  assert.deepEqual(stopped, ['0a1b2c3d']);
});

test('a console nobody signs in to is one person\'s, with one list of sessions, unless WOODSHED_ONE_PERSON=0 says otherwise', async (t) => {
  const fleet = { sessions: () => [], find: () => null };
  const base = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const onePerson = async (config) => {
    const server = http.createServer(createHandler({ config, fleet }));
    const port = await listen(server);
    t.after(() => server.close());
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { host: `localhost:${port}` } });
    return (await res.json()).onePerson;
  };
  assert.equal(await onePerson(base), true, 'loopback with no sign-in: one person');
  assert.equal(await onePerson({ ...base, onePerson: false }), false, 'the setting at 0: Mine and Everyone, as the dev console shows them');
  assert.equal(await onePerson({ ...base, onePerson: true }), true);
});

function post(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path,
      headers: { host: `localhost:${port}`, origin: `http://localhost:${port}`, 'x-woodshed': '1', 'content-type': 'application/json', ...headers },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('a secrets change needs the name typed, from the console\'s own origin', async (t) => {
  const done = [];
  const settings = {
    async replace(name, value) { done.push(['replace', name, value]); },
    async reveal(name) { done.push(['reveal', name]); return 'the-value'; },
    async rotateWebhookSecret() { done.push(['rotate']); },
    async applyWebhook() { done.push(['apply']); },
    async setWebhookUrl(url) {
      done.push(['url', url]);
      throw Object.assign(new Error('GitHub must post over https'), { shown: true });
    },
  };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const handle = createHandler({ config, fleet: { sessions: () => [] }, settings });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());

  assert.equal((await post(port, '/api/secrets/registry-token', { value: 'v', confirm: 'registry-token' }, { origin: 'https://evil.example' })).status, 403);
  assert.deepEqual(await post(port, '/api/secrets/registry-token', { value: 'v', confirm: 'npm' }), { status: 400, body: { error: 'type registry-token to confirm' } });
  assert.equal((await post(port, '/api/webhook/rotate', { confirm: 'webhook' })).status, 400);
  assert.equal((await post(port, '/api/webhook/apply', null)).status, 400);
  assert.deepEqual(done, []);

  assert.equal((await post(port, '/api/secrets/registry-token', { value: 'v', confirm: 'registry-token' })).status, 200);
  assert.deepEqual(await post(port, '/api/secrets/registry-token/reveal', {}), { status: 200, body: { value: 'the-value' } });
  assert.equal((await post(port, '/api/webhook/rotate', { confirm: 'github-webhook-secret' })).status, 200);
  assert.equal((await post(port, '/api/webhook/apply', { confirm: 'webhook' })).status, 200);
  assert.deepEqual(await post(port, '/api/webhook/url', { url: 'http://x', confirm: 'webhook' }), { status: 409, body: { error: 'GitHub must post over https' } });
  assert.deepEqual(done, [['replace', 'registry-token', 'v'], ['reveal', 'registry-token'], ['rotate'], ['apply'], ['url', 'http://x']]);
});

function getWith(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('a QA recording plays only for someone signed in who may open its session, while its still needs no sign-in', async (t) => {
  const session = { id: '0a1b2c3d', status: 'stopped', kind: 'pr', number: 7, title: 'QA', qa: { base: 'main' } };
  const fleet = { sessions: () => [session], find: (id) => (id === session.id ? session : null) };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => (String(cookie).includes('woodshed_session=good') ? { login: 'octo' } : null) };
  const served = [];
  const qaRecordings = {
    serveVideo: async (_req, res, which) => { served.push(['video', which]); res.writeHead(200, { 'content-type': 'video/webm' }).end('webm'); },
    servePoster: async (_req, res, which) => { served.push(['poster', which]); res.writeHead(200, { 'content-type': 'image/png' }).end('png'); },
    gone: (res) => { res.writeHead(410, { 'content-type': 'text/plain' }).end('no longer kept'); },
  };
  const handle = createHandler({ config, fleet, auth, qaRecordings });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const good = { cookie: 'woodshed_session=good' };
  const secret = 'f'.repeat(32);

  // A link clicked in the QA comment goes to sign in, and back to the video after.
  assert.deepEqual(await getWith(port, '/qa/0a1b2c3d/video/1', { accept: 'text/html' }), { status: 302, location: '/login?next=%2Fqa%2F0a1b2c3d%2Fvideo%2F1' });
  assert.equal(served.length, 0);
  assert.equal((await getWith(port, '/qa/0a1b2c3d/video/1', good)).status, 200);
  assert.equal((await getWith(port, '/qa/99999999/video/1', good)).status, 410, 'no session listed, no recording, said as for one past its days');
  assert.equal((await getWith(port, `/qa-poster/0a1b2c3d/${secret}.png`)).status, 200, 'GitHub\'s image proxy signs in nowhere');
  assert.equal((await getWith(port, '/qa-poster/0a1b2c3d/short.png')).status, 401, 'anything else under it is behind sign-in');
  assert.deepEqual(served, [['video', { id: '0a1b2c3d', n: 1 }], ['poster', { id: '0a1b2c3d', secret }]]);
});

test('a QA run\'s log reads only for an admin or whoever started it, and for anyone else who may open the session it is refused', async (t) => {
  const log = '## test\nEnded: ran out of turns\nLast said: PRIVATE-WORDS\n';
  const sessions = [
    { id: '0a1b2c3d', status: 'stopped', kind: 'pr', number: 7, title: 'QA', startedBy: 'starter', qa: { base: 'main', log } },
    { id: '0a1b2c3e', status: 'stopped', kind: 'pr', number: 7, title: 'QA', qa: { base: 'main' } },
    { id: '0a1b2c3f', status: 'stopped', kind: 'pr', number: 7, title: 'Work' },
    { id: '0a1b2c40', status: 'stopped', kind: 'pr', number: 7, title: 'Theirs', owner: 'someone-else', qa: { base: 'main', log: 'SECRET' } },
  ];
  const fleet = { sessions: () => sessions, find: (id) => sessions.find((x) => x.id === id) ?? null };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const logins = { admin: 'admin', starter: 'starter', plain: 'plain' };
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => {
    const who = Object.keys(logins).find((k) => String(cookie).includes(`woodshed_session=${k}`));
    return who ? { login: logins[who] } : null;
  } };
  const members = { hasAdmin: () => true, isAdmin: (login) => login === 'admin', hasGithubSessions: () => true, isMember: () => true, currentRole: () => 'member', hosted: false };
  const handle = createHandler({ config, fleet, auth, members });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = (who) => (who ? { cookie: `woodshed_session=${who}` } : {});
  const read = (id, headers) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: `/api/sessions/${id}/qa-log`, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], nosniff: res.headers['x-content-type-options'], body }));
    }).on('error', reject);
  });

  const asAdmin = await read('0a1b2c3d', as('admin'));
  assert.deepEqual([asAdmin.status, asAdmin.type, asAdmin.nosniff, asAdmin.body], [200, 'text/plain; charset=utf-8', 'nosniff', log]);
  assert.equal((await read('0a1b2c3d', as('starter'))).body, log, 'whoever started the run');
  const plain = await read('0a1b2c3d', as('plain'));
  assert.deepEqual([plain.status, plain.body.includes('PRIVATE-WORDS')], [403, false], 'a member who is neither reads nothing of it');
  assert.equal((await read('0a1b2c3e', as('admin'))).status, 404, 'a QA session that sent no log');
  // A review session's log is read the same way, at its own name: the starter reads it, others do not.
  sessions.push({ id: '0a1b2c41', status: 'stopped', kind: 'pr', number: 7, title: 'Review', startedBy: 'starter', review: { base: 'main', log } });
  const readReview = (id, headers) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: `/api/sessions/${id}/review-log`, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
  assert.equal((await readReview('0a1b2c41', as('starter'))).body, log);
  const plainReview = await readReview('0a1b2c41', as('plain'));
  assert.deepEqual([plainReview.status, plainReview.body.includes('PRIVATE-WORDS')], [403, false]);
  assert.equal((await readReview('0a1b2c3d', as('admin'))).status, 404, 'a QA session is not read at the review name');
  assert.equal((await read('0a1b2c3f', as('admin'))).status, 404, 'a session that is not QA');
  const hidden = await read('0a1b2c40', as('plain'));
  assert.deepEqual([hidden.status, hidden.body.includes('SECRET')], [404, false], 'a session this person cannot open');
  assert.equal((await read('0a1b2c3d', as(null))).status, 401, 'signed out');
});

test('a public repo\'s QA video plays with no sign-in at its run\'s secret name, and no other name opens it', async (t) => {
  const share = 'c'.repeat(32);
  const session = { id: '0a1b2c3d', status: 'stopped', kind: 'pr', number: 7, title: 'QA', qa: { base: 'main', share, videos: [{ n: 1, bytes: 4 }] } };
  const asked = [];
  const fleet = {
    sessions: () => [session], find: (id) => (id === session.id ? session : null),
    publicQaVideo: (id, secret, n) => { asked.push([id, secret, n]); return id === session.id && secret === share && n === 1 ? session : null; },
  };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const auth = { enabled: () => true, available: () => true, sessionFor: async () => null };
  const served = [];
  const qaRecordings = {
    serveVideo: async (_req, res, which) => { served.push(which); res.writeHead(200, { 'content-type': 'video/webm' }).end('webm'); },
    gone: (res) => { res.writeHead(410, { 'content-type': 'text/plain' }).end('no longer kept'); },
  };
  const handle = createHandler({ config, fleet, auth, qaRecordings });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());

  assert.equal((await getWith(port, `/qa-video/0a1b2c3d/${share}/1.webm`, { accept: 'text/html' })).status, 200, 'a reader of the comment, signed in nowhere');
  assert.equal((await getWith(port, `/qa-video/0a1b2c3d/${'d'.repeat(32)}/1.webm`)).status, 410, 'another secret');
  assert.equal((await getWith(port, `/qa-video/0a1b2c3d/${share}/2.webm`)).status, 410, 'a video it never sent');
  assert.equal((await getWith(port, `/qa-video/0a1b2c3d/${share}/1.mp4`)).status, 401, 'anything else under it is behind sign-in');
  assert.equal((await getWith(port, '/qa/0a1b2c3d/video/1')).status, 401, 'the signed-in name stays behind sign-in');
  assert.deepEqual(served, [{ id: '0a1b2c3d', n: 1 }]);
  assert.equal(asked.length, 3);
});

test('the Diff tab\'s read goes to the running session\'s statusd, with its token, and a stopped session is refused', async (t) => {
  const asked = [];
  const statusd = http.createServer((req, res) => {
    asked.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, base: 'master', files: [] }));
  });
  const statusPort = await listen(statusd);
  t.after(() => statusd.close());
  const running = { id: '0a1b2c3d', status: 'running', title: 't', token: 'tok', endpoint: { host: '127.0.0.1', termPort: 1, statusPort } };
  const stopped = { id: '1b2c3d4e', status: 'stopped', title: 's', token: 'tok2' };
  const fleet = { sessions: () => [running, stopped], find: (id) => [running, stopped].find((s) => s.id === id) ?? null, stop: async () => {} };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const handle = createHandler({ config, fleet });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());

  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/0a1b2c3d/diff`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, base: 'master', files: [] });
  assert.deepEqual(asked, [{ method: 'GET', url: '/diff', authorization: 'Bearer tok' }]);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/sessions/1b2c3d4e/diff`)).status, 409);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/sessions/ffffffff/diff`)).status, 404);
  assert.equal(asked.length, 1, 'nothing asked for a stopped or unknown session');
});

test('the transcript a phone scrolls is read from the running session\'s statusd, with only a number for its limit', async (t) => {
  const asked = [];
  const statusd = http.createServer((req, res) => {
    asked.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ agent: 'claude', entries: [{ role: 'user', text: 'hi', at: null }], partial: false, writtenAt: 1 }));
  });
  const statusPort = await listen(statusd);
  t.after(() => statusd.close());
  const running = { id: '0a1b2c3d', status: 'running', title: 't', token: 'tok', endpoint: { host: '127.0.0.1', termPort: 1, statusPort } };
  const stopped = { id: '1b2c3d4e', status: 'stopped', title: 's', token: 'tok2' };
  const fleet = { sessions: () => [running, stopped], find: (id) => [running, stopped].find((s) => s.id === id) ?? null, stop: async () => {} };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const server = http.createServer(createHandler({ config, fleet }));
  const port = await listen(server);
  t.after(() => server.close());

  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/0a1b2c3d/transcript?limit=50`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).entries[0].text, 'hi');
  await fetch(`http://127.0.0.1:${port}/api/sessions/0a1b2c3d/transcript?limit=50%26pane%3Dx`);
  await fetch(`http://127.0.0.1:${port}/api/sessions/0a1b2c3d/transcript`);
  // The Chat tab's `since`, the last answer's writtenAt (a file's mtimeMs, which can have a fraction), and only that.
  await fetch(`http://127.0.0.1:${port}/api/sessions/0a1b2c3d/transcript?limit=300&since=1763550000123.456`);
  await fetch(`http://127.0.0.1:${port}/api/sessions/0a1b2c3d/transcript?since=1%26limit%3D9`);
  assert.deepEqual(asked.map((a) => a.url), ['/transcript?limit=50', '/transcript', '/transcript', '/transcript?limit=300&since=1763550000123.456', '/transcript']);
  assert.ok(asked.every((a) => a.method === 'GET' && a.authorization === 'Bearer tok'));
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/sessions/1b2c3d4e/transcript`)).status, 409);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/sessions/ffffffff/transcript`)).status, 404);
  assert.equal(asked.length, 5, 'nothing asked for a stopped or unknown session');
});

test('a stopped session\'s Chat reads the conversation it kept, only for whoever may open it, and never a tainted one\'s', async (t) => {
  const conversation = { agent: 'claude', entries: [{ role: 'user', text: 'Fix it', at: null }, { role: 'assistant', text: 'Fixed.', at: null }], partial: false, writtenAt: 1764064800000 };
  const texts = new Map([
    ['octocat/sessions/0a1b2c3d/conversation.json', JSON.stringify({ ...conversation, savedAt: '2026-11-25T10:00:00.000Z' })],
    ['_sessions/1b2c3d4e/conversation.json', JSON.stringify(conversation)],
    ['octocat/sessions/3d4e5f6a/conversation.json', JSON.stringify(conversation)],
  ]);
  const read = [];
  const homes = { getText: async (key) => { read.push(key); if (key.includes('broken')) throw new Error('S3 down'); return texts.get(key) ?? null; } };
  const at = '2026-11-25T10:00:00.000Z';
  const sessions = [
    { id: '0a1b2c3d', status: 'stopped', title: 'mine', owner: 'octocat', conversationSavedAt: at },
    { id: '1b2c3d4e', status: 'stopped', title: 'shared', owner: null, kept: true, conversationSavedAt: at },
    { id: '2c3d4e5f', status: 'stopped', title: 'nothing kept', owner: 'octocat' },
    { id: '3d4e5f6a', status: 'stopped', title: 'tainted', owner: 'octocat', taintedAt: at, conversationSavedAt: at },
    { id: '4e5f6a7b', status: 'stopped', title: 'gone from the store', owner: 'octocat', conversationSavedAt: at },
    { id: '5f6a7b8c', status: 'starting', title: 'resuming', owner: 'octocat', conversationSavedAt: at },
    { id: '6a7b8c9d', status: 'stopped', title: 'theirs', owner: 'mia-dev', conversationSavedAt: at },
  ];
  const fleet = { sessions: () => sessions, find: (id) => sessions.find((s) => s.id === id) ?? null };
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => ({ login: /woodshed_session=([\w-]+)/.exec(cookie)[1] }) };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const server = http.createServer(createHandler({ config, fleet, auth, homes }));
  const port = await listen(server);
  t.after(() => server.close());
  const get = async (id, query = '') => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/transcript${query}`, { headers: { cookie: 'woodshed_session=octocat' } });
    return { status: res.status, body: await res.json() };
  };

  assert.deepEqual(await get('0a1b2c3d'), { status: 200, body: { ...conversation, saved: true, savedAt: at } });
  assert.deepEqual(await get('0a1b2c3d', '?since=1764064800000'), { status: 200, body: { agent: 'claude', unchanged: true, writtenAt: 1764064800000, savedAt: at } });
  assert.equal((await get('0a1b2c3d', '?since=5')).body.entries.length, 2, 'another since: the whole of it');
  assert.equal((await get('1b2c3d4e')).body.savedAt, at, 'a shared session\'s, with the record\'s time when the file has none');
  assert.equal((await get('2c3d4e5f')).status, 409, 'nothing kept: not running, as before');
  assert.equal((await get('3d4e5f6a')).status, 409, 'a tainted session\'s is never shown');
  assert.equal((await get('4e5f6a7b')).status, 404, 'marked, but gone from the store');
  assert.equal((await get('5f6a7b8c')).status, 409, 'one starting again reads the live one once it runs');
  assert.equal((await get('6a7b8c9d')).status, 404, 'a teammate\'s private session is never found');
  assert.ok(!read.some((k) => /3d4e5f6a|5f6a7b8c|6a7b8c9d/.test(k)), 'and none of those was read');
});

test('the Chat tab\'s Stop is an interrupt sent to the running session\'s statusd, and nothing else', async (t) => {
  const asked = [];
  const statusd = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      asked.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const statusPort = await listen(statusd);
  t.after(() => statusd.close());
  const running = { id: '0a1b2c3d', status: 'running', title: 't', token: 'tok', endpoint: { host: '127.0.0.1', termPort: 1, statusPort } };
  const stopped = { id: '1b2c3d4e', status: 'stopped', title: 's', token: 'tok2' };
  const fleet = { sessions: () => [running, stopped], find: (id) => [running, stopped].find((s) => s.id === id) ?? null, stop: async () => {} };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const server = http.createServer(createHandler({ config, fleet }));
  const port = await listen(server);
  t.after(() => server.close());
  const post = (id, headers = { 'x-woodshed': '1' }) => fetch(`http://127.0.0.1:${port}/api/sessions/${id}/interrupt`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{"keys":"rm -rf /"}',
  });

  assert.equal((await post('0a1b2c3d')).status, 200);
  assert.deepEqual(asked, [{ method: 'POST', url: '/interrupt', authorization: 'Bearer tok', body: '{}' }], 'only Esc: no text of the page\'s reaches the session');
  assert.equal((await post('1b2c3d4e')).status, 409);
  assert.equal((await post('ffffffff')).status, 404);
  assert.notEqual((await post('0a1b2c3d', {})).status, 200, 'a cross-site form cannot send it');
  assert.equal(asked.length, 1);
});

test('the Chat tab\'s answer goes to the running session\'s statusd with only the fields it checks, and its prompt is read there', async (t) => {
  const asked = [];
  let answerStatus = 200;
  const statusd = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      asked.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
      if (req.url === '/prompt') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"prompt":{"kind":"approval","title":"Do you want to proceed?","detail":["ls"]}}');
      }
      res.writeHead(answerStatus, { 'content-type': 'application/json' });
      res.end(answerStatus === 200 ? '{"ok":true}' : '{"error":"the agent\'s terminal shows another question","why":"other-question"}');
    });
  });
  const statusPort = await listen(statusd);
  t.after(() => statusd.close());
  const running = { id: '0a1b2c3d', status: 'running', title: 't', token: 'tok', endpoint: { host: '127.0.0.1', termPort: 1, statusPort } };
  const stopped = { id: '1b2c3d4e', status: 'stopped', title: 's', token: 'tok2' };
  const fleet = { sessions: () => [running, stopped], find: (id) => [running, stopped].find((s) => s.id === id) ?? null, stop: async () => {} };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const server = http.createServer(createHandler({ config, fleet }));
  const port = await listen(server);
  t.after(() => server.close());
  const post = (id, body, headers = { 'x-woodshed': '1' }) => fetch(`http://127.0.0.1:${port}/api/sessions/${id}/answer`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const question = { kind: 'question', questions: [{ question: 'Which colour?', options: ['Red', 'Blue'], pick: 1, keys: 'x' }], text: 'rm' };
  const lines = [];
  const log = console.log;
  console.log = (...args) => { lines.push(args); };
  let first;
  try {
    first = await post('0a1b2c3d', question);
  } finally {
    console.log = log;
  }
  assert.equal(first.status, 200);
  assert.deepEqual(JSON.parse(asked[0].body), { kind: 'question', questions: [{ question: 'Which colour?', options: ['Red', 'Blue'], pick: 1 }] }, 'nothing else of the page\'s reaches the session');
  assert.equal(asked[0].url, '/answer');
  assert.equal(asked[0].authorization, 'Bearer tok');
  const logged = JSON.stringify(lines);
  assert.match(logged, /answer typed in from the page/);
  assert.doesNotMatch(logged, /Which colour|Blue/, 'the log says which pick, never its text');

  const approval = { kind: 'approval', decision: 'deny', key: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
  answerStatus = 409;
  const refused = await post('0a1b2c3d', approval);
  assert.equal(refused.status, 409, 'statusd\'s refusal reaches the page as it said it');
  assert.match((await refused.json()).error, /another question/);
  assert.deepEqual(JSON.parse(asked[1].body), approval);
  // Only the key: what the page showed is no part of the answer, the pane's own text is.
  await post('0a1b2c3d', { ...approval, title: 'Do you want to proceed?', detail: ['ls'] });
  assert.deepEqual(JSON.parse(asked[2].body), approval);

  assert.equal((await post('0a1b2c3d', { kind: 'approval', decision: 'yes', key: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })).status, 400);
  assert.equal((await post('0a1b2c3d', { kind: 'approval', decision: 'deny', title: 'Do you want to proceed?', detail: ['ls'] })).status, 400, 'no key');
  assert.equal((await post('0a1b2c3d', { kind: 'approval', decision: 'deny', key: 'abc' })).status, 400, 'not a key');
  assert.equal((await post('0a1b2c3d', { kind: 'question', questions: [{ question: 'q', options: ['a'], pick: 3 }] })).status, 400);
  assert.equal((await post('1b2c3d4e', approval)).status, 409);
  assert.equal((await post('ffffffff', approval)).status, 404);
  assert.notEqual((await post('0a1b2c3d', approval, {})).status, 200, 'a cross-site form cannot send it');
  assert.equal(asked.length, 3);

  const prompt = await fetch(`http://127.0.0.1:${port}/api/sessions/0a1b2c3d/prompt`);
  assert.equal(prompt.status, 200);
  assert.equal((await prompt.json()).prompt.kind, 'approval');
  assert.deepEqual(asked[3], { method: 'GET', url: '/prompt', authorization: 'Bearer tok', body: '' });
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/sessions/1b2c3d4e/prompt`)).status, 409);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/sessions/ffffffff/prompt`)).status, 404);
  assert.equal(asked.length, 4);
});

test('with sign-in on, everything but the sign-in pages needs a session', async (t) => {
  const session = { id: '0a1b2c3d', status: 'running', title: 't', endpoint: { host: '127.0.0.1', termPort: 1, statusPort: 2 } };
  const fleet = { sessions: () => [session], find: (id) => (id === session.id ? session : null), stop: async () => {} };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  let on = true;
  let callbackError = Object.assign(new Error('That sign-in link has expired'), { shown: true });
  const auth = {
    enabled: () => on,
    available: () => true,
    sessionFor: async (cookie) => (String(cookie).includes('woodshed_session=good') ? { login: 'octo' } : null),
    start: async () => ({ location: 'https://github.com/login/oauth/authorize?x=1', setCookie: 'woodshed_oauth_state=s' }),
    callback: async () => { throw callbackError; },
    signOut: () => 'woodshed_session=; Max-Age=0',
  };
  const handle = createHandler({ config, fleet, auth });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const page = { accept: 'text/html' };
  const good = { cookie: 'woodshed_session=good' };

  assert.deepEqual(await getWith(port, '/events?show=acted', page), { status: 302, location: '/login?next=%2Fevents%3Fshow%3Dacted' });
  assert.equal((await getWith(port, '/api/sessions')).status, 401);
  assert.equal((await getWith(port, '/term/0a1b2c3d/', page)).status, 302, 'a terminal frame goes to sign-in, never to the session');
  assert.equal((await getWith(port, '/redis/0a1b2c3d/')).status, 401);
  const stop = { method: 'POST', path: '/api/sessions/0a1b2c3d/stop', headers: { host: `localhost:${port}`, 'x-woodshed': '1', origin: `http://localhost:${port}` } };
  assert.equal(await request(port, stop), 401);
  for (const open of ['/login', '/api/me', '/healthz', '/static/style.css']) assert.equal((await getWith(port, open)).status, 200, open);

  assert.equal((await getWith(port, '/events', { ...page, ...good })).status, 200);
  assert.equal((await getWith(port, '/api/sessions', good)).status, 200);

  assert.deepEqual(await getWith(port, '/auth/start?next=/events'), { status: 302, location: 'https://github.com/login/oauth/authorize?x=1' });
  assert.deepEqual(await getWith(port, '/auth/callback?code=c&state=s'), { status: 302, location: '/login?error=That%20sign-in%20link%20has%20expired' });
  callbackError = Object.assign(new Error('spawn gh ENOENT'), { step: 'write access', next: '/events' });
  const failed = await getWith(port, '/auth/callback?code=c&state=s');
  assert.equal(failed.location, `/login?error=${encodeURIComponent(CONSOLE_FAILED)}&next=%2Fevents`, 'the console\'s own failure says so, and never what it was');
  const signOut = (origin) => ({ method: 'POST', path: '/auth/sign-out', headers: { host: `localhost:${port}`, origin, ...good } });
  assert.equal(await request(port, signOut('https://evil.example')), 403);
  assert.equal(await request(port, signOut(`http://localhost:${port}`)), 303);

  on = false;
  assert.equal((await getWith(port, '/api/sessions')).status, 200, 'until the client secret is set, nothing is gated');
});

test('once sign-in can be used, the bare IP sends a page to the console\'s name', async (t) => {
  const fleet = { sessions: () => [], find: () => null, stop: async () => {} };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: ['203.0.113.7'], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  let available = false;
  let on = false;
  const auth = { enabled: () => on, available: () => available, sessionFor: async () => null };
  const handle = createHandler({ config, fleet, auth });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const onIp = { host: '203.0.113.7' };

  assert.equal((await getWith(port, '/events', onIp)).status, 200, 'with no client secret the IP works as before');
  available = true;
  assert.deepEqual(await getWith(port, '/events?show=acted', onIp), { status: 302, location: 'https://console.example/events?show=acted' });
  assert.deepEqual(await getWith(port, '/login?next=%2Fs%2F0a1b2c3d', onIp), { status: 302, location: 'https://console.example/login?next=%2Fs%2F0a1b2c3d' });
  assert.equal((await getWith(port, '/healthz', onIp)).status, 200, 'health checks stay on any name');
  assert.equal((await getWith(port, '/events')).status, 200, 'localhost is not a public name');
});

// Every route the console serves, signed out, on a console that always requires sign-in. Nothing may reach
// a session, a secret or GitHub, whether the client secret is missing or set and not yet proven by a sign-in.
test('with sign-in always required, no route but sign-in\'s own answers a signed-out browser', async (t) => {
  const reached = [];
  const session = { id: '0a1b2c3d', status: 'running', title: 't', token: 'tok', endpoint: { host: '127.0.0.1', termPort: 1, statusPort: 2 } };
  const fleet = {
    sessions: () => { reached.push('sessions'); return [session]; },
    find: (id) => { reached.push(`find ${id}`); return id === session.id ? session : null; },
    stop: async () => { reached.push('stop'); },
    startApp: async () => { reached.push('startApp'); },
    stopApp: async () => { reached.push('stopApp'); },
    create: async () => { reached.push('create'); },
  };
  const settings = new Proxy({}, { get: (_, name) => async () => { reached.push(`settings.${String(name)}`); return {}; } });
  const review = async () => { reached.push('review'); return {}; };
  const events = { list: () => { reached.push('events'); return []; } };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: ['203.0.113.7'], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 }, appDomain: 'console.example', launcher: { kind: 'ecs' },
  };

  for (const secret of [null, 'cs']) {
    const store = { state: {}, save() {} };
    const auth = createAuth({
      publicUrl: config.publicUrl, store, clientId: async () => 'Iv1.app', clientSecret: () => secret,
      canWrite: async () => true, fetchImpl: async () => { throw new Error('no GitHub call while signed out'); }, required: true,
    });
    assert.equal(auth.enabled(), true, `required with secret ${secret}`);
    auth.disarm();
    assert.equal(auth.enabled(), true, 'a new client secret never makes sign-in optional');
    const handle = createHandler({ config, fleet, settings, events, auth, review });
    const server = http.createServer((req, res) => { handle(req, res); });
    const port = await listen(server);
    t.after(() => server.close());
    const write = { host: 'console.example', 'x-woodshed': '1', origin: 'https://console.example', 'content-type': 'application/json' };

    const gets = ['/', '/s/0a1b2c3d', '/events', '/secrets', '/api/sessions', '/api/sessions/0a1b2c3d/review', '/api/sessions/0a1b2c3d/diff',
      '/api/webhook-events', '/api/secrets', '/api/webhook/deliveries', '/term/0a1b2c3d/', '/term/0a1b2c3d/token', '/shell/0a1b2c3d/',
      '/redis/0a1b2c3d/', '/pg/0a1b2c3d/', '/mongo/0a1b2c3d/', '/auth/app?id=0a1b2c3d&next=/', '/nope'];
    for (const path of gets) {
      for (const accept of ['text/html', 'application/json']) {
        const { status, location } = await getWith(port, path, { host: 'console.example', accept });
        assert.ok(status === 401 || (status === 302 && location.startsWith('/login?')), `GET ${path} (${accept}) answered ${status} ${location ?? ''}`);
      }
    }
    const posts = ['/api/sessions', '/api/sessions/0a1b2c3d/stop', '/api/sessions/0a1b2c3d/app/start', '/api/sessions/0a1b2c3d/app/stop',
      '/api/sessions/0a1b2c3d/resume', '/api/sessions/0a1b2c3d/delete',
      '/api/secrets/registry-token', '/api/secrets/registry-token/reveal', '/api/webhook/rotate', '/api/webhook/apply', '/api/webhook/url', '/term/0a1b2c3d/'];
    for (const path of posts) assert.equal(await request(port, { method: 'POST', path, headers: write }), 401, `POST ${path}`);
    for (const method of ['PUT', 'DELETE', 'PATCH']) assert.equal(await request(port, { method, path: '/api/sessions', headers: write }), 401, method);

    const app = { host: '0a1b2c3d.console.example', accept: 'text/html' };
    const appPage = await getWith(port, '/workflows', app);
    assert.equal(appPage.status, 302);
    assert.match(appPage.location, /^https:\/\/console\.example\/auth\/app\?id=0a1b2c3d/, 'an app page goes through the console');
    assert.equal(await request(port, { method: 'POST', path: '/api-proxy/x', headers: { host: '0a1b2c3d.console.example' } }), 401);
    assert.equal((await getWith(port, '/__woodshed/auth?code=guess&next=/', app)).status, 403, 'a made-up app code');

    for (const open of ['/login', '/api/me', '/healthz', '/static/style.css']) {
      assert.equal((await getWith(port, open, { host: 'console.example' })).status, 200, open);
    }
    const me = await (await fetch(`http://127.0.0.1:${port}/api/me`, { headers: { host: 'console.example' } })).json();
    assert.deepEqual(me, { supported: true, signIn: true, available: Boolean(secret), login: null, visitor: null, asked: null, admin: false, asking: 0, people: false, names: {}, repo: null, workflows: [] });
  }
  assert.deepEqual(reached.filter((r) => r !== 'find ffffffff'), [], 'nothing reached a session, a secret or GitHub');
});

test('an admin invites, accepts and removes on the People page, a member who is not one cannot, and a visitor can only ask to join', async (t) => {
  const { createMembers } = await import('./members.mjs');
  const store = { state: { members: { 'mia-dev': { addedBy: null, addedAt: '2026-10-01T00:00:00.000Z', how: 'first to sign in', admin: true } } }, save() {} };
  const members = createMembers({ store });
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const loginOf = (cookie) => /woodshed_session=(\w[\w-]*)/.exec(String(cookie))?.[1] ?? null;
  const auth = {
    enabled: () => true,
    available: () => true,
    sessionFor: async (cookie) => (members.isMember(loginOf(cookie)) ? { login: loginOf(cookie) } : null),
    visitorFor: async (cookie) => (loginOf(cookie) ? { login: loginOf(cookie) } : null),
  };
  const github = { canWrite: async (login) => login !== 'outsider' };
  const revoked = [];
  const tunnel = { revoke: (login) => revoked.push(login) };
  const cliRevoked = [];
  const cli = { revokeAll: (login) => cliRevoked.push(login), list: () => [] };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth, members, github, tunnel, cli });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const mia = { cookie: 'woodshed_session=mia-dev' };
  const sam = { cookie: 'woodshed_session=sam-ops' };

  assert.equal((await getWith(port, '/api/people', sam)).status, 401, 'a visitor sees nobody on the list');
  assert.equal((await post(port, '/api/people/invite', { login: 'sam-ops' }, sam)).status, 401, 'nor changes it');
  const me = await (await fetch(`http://127.0.0.1:${port}/api/me`, { headers: sam })).json();
  assert.deepEqual([me.login, me.visitor, me.asked], [null, 'sam-ops', null]);
  const asked = await post(port, '/api/access/ask', {}, sam);
  assert.equal(asked.status, 200);
  assert.ok(asked.body.asked);
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/me`, { headers: mia })).json()).asking, 1, 'an admin sees someone is asking');

  const accepted = await post(port, '/api/people/accept', { login: 'sam-ops' }, mia);
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.body.requests, []);
  const samMe = await (await fetch(`http://127.0.0.1:${port}/api/me`, { headers: sam })).json();
  assert.deepEqual([samMe.login, samMe.admin], ['sam-ops', false], 'accepted, they are in, as a member who is not an admin');
  assert.equal((await getWith(port, '/api/people', sam)).status, 403, 'only an admin reads the list');
  for (const action of ['invite', 'remove', 'assignable', 'github-sessions', 'admin', 'slack']) {
    assert.equal((await post(port, `/api/people/${action}`, { login: 'sam-ops', admin: true, on: true }, sam)).status, 403, `${action} is an admin's`);
  }
  assert.equal(members.isAdmin('sam-ops'), false, 'nobody makes themselves an admin');
  assert.deepEqual((await post(port, '/api/people/invite', { login: '@outsider' }, mia)).status, 400, 'a handle without write access could never sign in');
  const invited = await post(port, '/api/people/invite', { login: '@ana-k' }, mia);
  assert.equal(invited.status, 200);
  assert.deepEqual(invited.body.members.find((m) => m.login === 'ana-k'), { login: 'ana-k', addedBy: 'mia-dev', addedAt: invited.body.members.find((m) => m.login === 'ana-k').addedAt, how: 'invited', access: 'private', accessDiffers: null });
  assert.equal((await post(port, '/api/people/admin', { login: 'mia-dev', admin: false }, mia)).status, 409, 'the last admin keeps it');
  assert.equal((await post(port, '/api/people/admin', { login: 'sam-ops', admin: true }, mia)).status, 200);
  assert.equal((await getWith(port, '/api/people', sam)).status, 200, 'made an admin, they open People');
  assert.equal((await post(port, '/api/people/remove', { login: 'mia-dev' }, mia)).status, 409, 'nobody removes themselves');
  assert.equal((await post(port, '/api/people/remove', { login: 'sam-ops' }, mia)).status, 200);
  assert.equal((await getWith(port, '/api/people', sam)).status, 401, 'removed, they are out at once');
  assert.deepEqual(revoked, ['sam-ops'], 'and their database tunnels with them, the open ones too');
  assert.deepEqual(cliRevoked, ['sam-ops'], 'and their command line sign-ins');
  assert.equal((await post(port, '/api/access/ask', {}, { ...sam, origin: 'https://evil.example' })).status, 403);
});

test('People names the personal tokens each member saved on My settings, never a value', async (t) => {
  const { createMembers } = await import('./members.mjs');
  const store = {
    state: {
      members: {
        'mia-dev': { addedBy: null, addedAt: '2026-10-01T00:00:00.000Z', how: 'first to sign in', admin: true },
        'sam-ops': { addedBy: 'mia-dev', addedAt: '2026-10-02T00:00:00.000Z', how: 'invited' },
      },
      people: {
        'mia-dev': { claudeTokenAt: '2026-10-03T00:00:00.000Z', codexAuthAt: '2026-10-03T00:00:00.000Z', agentAuthAt: { grok: '2026-10-03T00:00:00.000Z' }, github: { connectedAt: '2026-10-03T00:00:00.000Z' } },
      },
    },
    save() {},
  };
  const members = createMembers({ store });
  const userSettings = createUserSettings({ store, secrets: null });
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const auth = {
    enabled: () => true, available: () => true,
    sessionFor: async () => ({ login: 'mia-dev' }), visitorFor: async () => ({ login: 'mia-dev' }),
  };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth, members, userSettings });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const people = await fetch(`http://127.0.0.1:${port}/api/people`, { headers: { cookie: 'woodshed_session=mia-dev' } });
  assert.equal(people.status, 200);
  const body = await people.json();
  assert.deepEqual(Object.fromEntries(body.members.map((m) => [m.login, m.signIns])), {
    'mia-dev': ['Claude', 'Codex', 'Grok Build', 'GitHub'],
    'sam-ops': [],
  });
});

test('on a console with no list of people, everyone signed in reaches the Secrets & webhooks and Webhook events pages', async (t) => {
  const reached = [];
  const settings = new Proxy({}, { get: (_, name) => async () => { reached.push(`settings.${String(name)}`); return {}; } });
  const events = { list: () => { reached.push('events'); return []; } };
  const fleet = {
    sessions: () => [], find: () => null,
    startManual: async () => { reached.push('startManual'); return { id: '0a1b2c3d' }; },
  };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const auth = {
    enabled: () => true,
    available: () => true,
    sessionFor: async (cookie) => {
      const login = /woodshed_session=(\w[\w-]*)/.exec(String(cookie))?.[1];
      return login ? { login } : null;
    },
  };
  const handle = createHandler({ config, fleet, settings, events, auth });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = { cookie: 'woodshed_session=mia-dev' };

  const reads = ['/events', '/secrets', '/api/webhook-events', '/api/secrets', '/api/webhook/deliveries'];
  const writes = [['/api/secrets/registry-token', { value: 'v', confirm: 'registry-token' }], ['/api/secrets/registry-token/reveal', {}],
    ['/api/webhook/rotate', { confirm: 'github-webhook-secret' }], ['/api/webhook/apply', { confirm: 'webhook' }],
    ['/api/webhook/url', { url: 'https://x', confirm: 'webhook' }], ['/api/sessions', { number: 1, startedBy: 'mia-dev' }]];
  for (const path of reads) assert.equal((await getWith(port, path, { ...as, accept: 'text/html' })).status, 200, `GET ${path}`);
  for (const [path, body] of writes) assert.ok([200, 201].includes((await post(port, path, body, as)).status), `POST ${path}`);
  assert.ok(reached.includes('events') && reached.includes('startManual'));
  const me = await (await fetch(`http://127.0.0.1:${port}/api/me`, { headers: as })).json();
  assert.deepEqual(me, { supported: true, signIn: true, available: true, login: 'mia-dev', visitor: null, asked: null, admin: true, asking: 0, people: false, names: {}, repo: 'o/r', workflows: [] });
});

test('a member who is not an admin loads the console\'s own pages, and every call behind them answers 403', async (t) => {
  const { createMembers } = await import('./members.mjs');
  const store = { state: { members: { 'mia-dev': { addedBy: null, addedAt: '2026-10-01T00:00:00.000Z', how: 'first to sign in', admin: true }, 'sam-ops': { addedBy: 'mia-dev', addedAt: '2026-10-02T00:00:00.000Z', how: 'invited' } } }, save() {} };
  const members = createMembers({ store });
  const reached = [];
  const settings = new Proxy({}, { get: (_, name) => async () => { reached.push(`settings.${String(name)}`); return {}; } });
  const events = { list: () => { reached.push('events'); return []; } };
  const consoleSettings = { view: () => { reached.push('consoleSettings.view'); return {}; }, check() {}, setMany: () => { reached.push('consoleSettings.setMany'); } };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const auth = {
    enabled: () => true,
    available: () => true,
    sessionFor: async (cookie) => {
      const login = /woodshed_session=(\w[\w-]*)/.exec(String(cookie))?.[1];
      return members.isMember(login) ? { login } : null;
    },
  };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, settings, events, auth, members, consoleSettings });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const sam = { cookie: 'woodshed_session=sam-ops' };
  const mia = { cookie: 'woodshed_session=mia-dev' };

  for (const page of ['/people', '/secrets', '/events', '/console-settings', '/console-settings/repos/app', '/settings']) {
    assert.equal((await getWith(port, page, { ...sam, accept: 'text/html' })).status, 200, `${page} loads, and says what its calls answer`);
  }
  const repoPage = await fetch(`http://127.0.0.1:${port}/console-settings/repos/app`, { headers: mia });
  assert.match(await repoPage.text(), /<script src="\/static\/repoSettings\.js\?v=[0-9a-f]+"><\/script>/, 'a repo\'s settings page, by its own URL');
  assert.equal((await getWith(port, '/console-settings/repos/Not_A_Name', { ...mia, accept: 'text/html' })).status, 404, 'only a project\'s name');
  const reads = ['/api/people', '/api/people/slack-search?q=ana', '/api/secrets', '/api/webhook/deliveries', '/api/webhook-events', '/api/console-settings', '/api/console-settings/updates', '/api/console-settings/repos/app', '/api/console-settings/slack', '/api/console-settings/slack/channels?q=a'];
  for (const path of reads) assert.equal((await getWith(port, path, sam)).status, 403, `GET ${path}`);
  const writes = ['/api/secrets/registry-token', '/api/secrets/registry-token/reveal', '/api/webhook/rotate', '/api/webhook/apply', '/api/webhook/url',
    '/api/console-settings', '/api/console-settings/clean', '/api/console-settings/projects/color', '/api/console-settings/projects/slack-channel', '/api/console-settings/projects/triggers', '/api/people/invite',
    '/api/console-settings/updates/check', '/api/console-settings/updates/update', '/api/console-settings/webhooks', '/api/console-settings/reviews', '/api/console-settings/slack', '/api/console-settings/slack/check', '/api/console-settings/slack/channels', '/api/console-settings/slack/disconnect'];
  for (const path of writes) assert.equal((await post(port, path, { confirm: 'x', login: 'ana-k', values: {} }, sam)).status, 403, `POST ${path}`);
  assert.deepEqual(reached, [], 'nothing behind the pages was reached');
  const samMe = await (await fetch(`http://127.0.0.1:${port}/api/me`, { headers: sam })).json();
  assert.equal(samMe.admin, false, 'the menu hides the Console links');

  for (const path of ['/api/secrets', '/api/webhook-events', '/api/console-settings', '/api/people']) {
    assert.equal((await getWith(port, path, mia)).status, 200, `an admin reads ${path}`);
  }
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/me`, { headers: mia })).json()).admin, true);
});

test('the setup page\'s Restart is an admin\'s, from the console\'s own origin, and says who asked', async (t) => {
  const { createMembers } = await import('./members.mjs');
  const store = { state: { members: { 'mia-dev': { addedBy: null, addedAt: '2026-10-01T00:00:00.000Z', how: 'first to sign in', admin: true }, 'sam-ops': { addedBy: 'mia-dev', addedAt: '2026-10-02T00:00:00.000Z', how: 'invited' } } }, save() {} };
  const members = createMembers({ store });
  const asked = [];
  const githubSetup = { restart: ({ by }) => { asked.push(by); return { restarting: true }; } };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const auth = {
    enabled: () => true,
    available: () => true,
    sessionFor: async (cookie) => {
      const login = /woodshed_session=(\w[\w-]*)/.exec(String(cookie))?.[1];
      return members.isMember(login) ? { login } : null;
    },
  };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth, members, githubSetup });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const sam = { cookie: 'woodshed_session=sam-ops' };
  const mia = { cookie: 'woodshed_session=mia-dev' };

  assert.equal((await post(port, '/api/setup/github/restart', {}, sam)).status, 403, 'a member who is not an admin');
  assert.equal((await post(port, '/api/setup/github/restart', {}, { ...mia, origin: 'https://evil.example' })).status, 403, 'cross-origin');
  assert.equal((await post(port, '/api/setup/github/restart', {}, { ...mia, 'x-woodshed': '' })).status, 403, 'no x-woodshed header');
  assert.deepEqual(asked, []);
  const ok = await post(port, '/api/setup/github/restart', {}, mia);
  assert.deepEqual([ok.status, ok.body], [202, { restarting: true }]);
  assert.deepEqual(asked, ['mia-dev']);
});

test('the reviewer App\'s setup is an admin\'s: its view and its Create, from the console\'s own origin', async (t) => {
  const { createMembers } = await import('./members.mjs');
  const store = { state: { members: { 'mia-dev': { addedBy: null, addedAt: '2026-10-01T00:00:00.000Z', how: 'first to sign in', admin: true }, 'sam-ops': { addedBy: 'mia-dev', addedAt: '2026-10-02T00:00:00.000Z', how: 'invited' } } }, save() {} };
  const members = createMembers({ store });
  const started = [];
  const reviewerApp = {
    view: async () => ({ available: true, appId: null, slug: null, login: null, installUrl: null }),
    startManifest: ({ ownerType }) => { started.push(ownerType); return { url: 'https://github.com/organizations/o/settings/apps/new?state=s', manifest: {} }; },
  };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const auth = {
    enabled: () => true, available: () => true,
    sessionFor: async (cookie) => {
      const login = /woodshed_session=(\w[\w-]*)/.exec(String(cookie))?.[1];
      return members.isMember(login) ? { login } : null;
    },
  };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth, members, reviewerApp });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const sam = { cookie: 'woodshed_session=sam-ops' };
  const mia = { cookie: 'woodshed_session=mia-dev' };

  assert.equal((await post(port, '/api/setup/github/reviewer/manifest', { ownerType: 'Organization' }, sam)).status, 403, 'a member who is not an admin');
  assert.equal((await post(port, '/api/setup/github/reviewer/manifest', {}, { ...mia, origin: 'https://evil.example' })).status, 403, 'cross-origin');
  assert.deepEqual(started, []);
  const ok = await post(port, '/api/setup/github/reviewer/manifest', { ownerType: 'Organization' }, mia);
  assert.deepEqual([ok.status, started], [200, ['Organization']]);
});

test('on a list with no admin yet every member is one, until the first is switched on', async (t) => {
  const { createMembers } = await import('./members.mjs');
  const store = { state: { members: { 'mia-dev': { addedBy: null, addedAt: '2026-10-01T00:00:00.000Z', how: 'already using the console' }, 'sam-ops': { addedBy: null, addedAt: '2026-10-01T00:00:00.000Z', how: 'already using the console' } } }, save() {} };
  const members = createMembers({ store });
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const auth = {
    enabled: () => true,
    available: () => true,
    sessionFor: async (cookie) => {
      const login = /woodshed_session=(\w[\w-]*)/.exec(String(cookie))?.[1];
      return members.isMember(login) ? { login } : null;
    },
  };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth, members });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const mia = { cookie: 'woodshed_session=mia-dev' };
  const sam = { cookie: 'woodshed_session=sam-ops' };

  assert.equal((await getWith(port, '/api/people', sam)).status, 200, 'nobody is an admin yet, so everyone is');
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/me`, { headers: sam })).json()).admin, true);
  assert.equal((await post(port, '/api/people/admin', { login: 'mia-dev', admin: true }, mia)).status, 200, 'the first admin is switched on');
  assert.equal((await getWith(port, '/api/people', sam)).status, 403, 'from then on, only admins');
  assert.equal((await getWith(port, '/api/people', mia)).status, 200);
});

test('with sign-in available but not turned on, the menu and the server agree that everyone is an admin', async (t) => {
  const { createMembers } = await import('./members.mjs');
  const store = { state: { members: { 'mia-dev': { addedBy: null, addedAt: '2026-10-01T00:00:00.000Z', how: 'first to sign in', admin: true }, 'sam-ops': { addedBy: 'mia-dev', addedAt: '2026-10-02T00:00:00.000Z', how: 'invited' } } }, save() {} };
  const members = createMembers({ store });
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const auth = { enabled: () => false, available: () => true, sessionFor: async () => ({ login: 'sam-ops' }), visitorFor: async () => null };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth, members });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const sam = { cookie: 'woodshed_session=sam-ops' };

  const me = await (await fetch(`http://127.0.0.1:${port}/api/me`, { headers: sam })).json();
  assert.deepEqual([me.login, me.admin], ['sam-ops', true], 'a member who is not an admin still gets the Console links');
  assert.equal((await getWith(port, '/api/people', sam)).status, 200, 'because the server lets them through');
});

// A private session, swept as a teammate who is signed in: every route answers exactly as it does for an id that
// never existed, and nothing reaches the session. Its owner gets through on each.
test('a teammate gets the unknown-id answer on every route of someone\'s private session', async (t) => {
  const reached = [];
  // The session's ttyd: whoever's terminal websocket reaches it.
  const ttyd = net.createServer((conn) => {
    conn.once('data', (d) => reached.push(`ttyd ${d.toString().split(' ')[1]}`));
    conn.on('error', () => {});
    conn.end();
  });
  const termPort = await listen(ttyd);
  t.after(() => ttyd.close());
  const mine = { id: '3f9a1c20', status: 'running', title: 'mine', owner: 'octocat', startedBy: 'octocat', token: 'tok', terminalToken: 'tt', endpoint: { host: '127.0.0.1', termPort, statusPort: 1, shellPort: 1 } };
  const shared = { id: '7c21e0d4', status: 'running', title: 'shared', owner: null, startedBy: 'sam-ops' };
  const fleet = {
    sessions: () => [mine, shared],
    find: (id) => [mine, shared].find((s) => s.id === id) ?? null,
    stop: async (s) => { reached.push(`stop ${s.id}`); },
    startApp: async (s) => { reached.push(`startApp ${s.id}`); return s; },
    stopApp: async (s) => { reached.push(`stopApp ${s.id}`); return s; },
    extend: (s) => { reached.push(`extend ${s.id}`); return s; },
    setLimits: (s) => { reached.push(`setLimits ${s.id}`); return s; },
  };
  const review = async (s) => { reached.push(`review ${s.id}`); return {}; };
  const loginOf = (cookie) => /woodshed_session=([\w-]+)/.exec(String(cookie))?.[1] ?? null;
  const auth = {
    enabled: () => true,
    available: () => true,
    sessionFor: async (cookie) => (loginOf(cookie) ? { login: loginOf(cookie) } : null),
    appSessionFor: async ({ cookieHeader }) => (loginOf(cookieHeader) ? { login: loginOf(cookieHeader) } : null),
    appCode: async () => { reached.push('appCode'); return 'code'; },
  };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 }, appDomain: 'console.example',
  };
  const handle = createHandler({ config, fleet, auth, review });
  const server = http.createServer((req, res) => { handle(req, res); });
  server.on('upgrade', createConsoleUpgrade({ config, fleet, auth }));
  const port = await listen(server);
  t.after(() => server.close());

  // A terminal's websocket, the only way into one: its answer's first line, or what came back before it closed.
  function websocket(login, id, kind = 'term') {
    return new Promise((resolve) => {
      const client = net.connect(port, '127.0.0.1', () => {
        client.write([`GET /${kind}/${id}/ws HTTP/1.1`, 'Host: console.example', 'Origin: https://console.example', `Cookie: woodshed_session=${login}`,
          'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Protocol: tty', '', ''].join('\r\n'));
      });
      let got = '';
      client.on('data', (d) => { got += d; });
      client.on('error', () => {});
      client.on('close', () => resolve(got.split('\r\n')[0]));
    });
  }

  async function answer(login, id, { method = 'GET', path, host = 'console.example' }) {
    const headers = { host, cookie: `woodshed_session=${login}`, accept: 'text/html', 'x-woodshed': '1', origin: 'https://console.example' };
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path: path.replaceAll('ID', id), headers }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location ?? null, body }));
      });
      req.on('error', reject);
      req.end(method === 'POST' ? '{}' : undefined);
    });
  }
  const routes = [
    { path: '/api/sessions/ID/review' }, { path: '/term/ID/' }, { path: '/term/ID/token' }, { path: '/shell/ID/' }, { path: '/redis/ID/' },
    { path: '/auth/app?id=ID&next=/' },
    { method: 'POST', path: '/api/sessions/ID/stop' }, { method: 'POST', path: '/api/sessions/ID/app/start' }, { method: 'POST', path: '/api/sessions/ID/app/stop' },
    { method: 'POST', path: '/api/sessions/ID/resume' }, { method: 'POST', path: '/api/sessions/ID/delete' },
    { method: 'POST', path: '/api/sessions/ID/pin' }, { method: 'POST', path: '/api/sessions/ID/rename' }, { method: 'POST', path: '/api/sessions/ID/group' },
    { method: 'POST', path: '/api/sessions/ID/extend' }, { method: 'POST', path: '/api/sessions/ID/limits' },
    { method: 'POST', path: '/api/sessions/ID/upload?name=a.png' }, { path: '/api/sessions/ID/image?path=shot.png' }, { method: 'POST', path: '/api/sessions/ID/scroll' },
    { method: 'POST', path: '/api/sessions/ID/send' }, { method: 'POST', path: '/api/sessions/ID/interrupt' }, { method: 'POST', path: '/api/sessions/ID/answer' }, { path: '/api/sessions/ID/prompt' },
    { path: '/api/sessions/ID/applog' }, { path: '/api/sessions/ID/diff' }, { path: '/api/sessions/ID/transcript' }, { method: 'POST', path: '/api/sessions/ID/review/diff' }, { path: '/api/sessions/ID/review/analysis' },
    { method: 'POST', path: '/api/sessions/ID/review/chat' }, { path: '/api/sessions/ID/review/answer/0123456789abcdef' },
    { path: '/api/sessions/ID/github/draft' }, { method: 'POST', path: '/api/sessions/ID/github/merge' }, { method: 'POST', path: '/api/sessions/ID/github/comment' },
    { path: '/workflows', host: 'ID.console.example' }, { method: 'POST', path: '/api-proxy/x', host: 'ID.console.example' },
    { path: '/__woodshed/code/', host: 'ID.console.example' }, { method: 'POST', path: '/__woodshed/code/x', host: 'ID.console.example' },
  ];
  for (const route of routes) {
    const theirs = await answer('mia-dev', mine.id, { ...route, host: route.host?.replace('ID', mine.id) });
    const nobody = await answer('mia-dev', 'ffffffff', { ...route, host: route.host?.replace('ID', 'ffffffff') });
    assert.deepEqual(theirs, nobody, `${route.method ?? 'GET'} ${route.host ?? ''}${route.path}`);
  }
  for (const kind of ['term', 'shell']) {
    assert.equal(await websocket('mia-dev', mine.id, kind), await websocket('mia-dev', 'ffffffff', kind), `${kind} websocket`);
  }
  assert.deepEqual(reached, [], 'nothing reached the private session for a teammate');

  const listed = JSON.parse((await answer('mia-dev', '', { path: '/api/sessions' })).body).sessions.map((s) => s.id);
  assert.deepEqual(listed, ['7c21e0d4'], 'the list leaves it out');
  const own = JSON.parse((await answer('octocat', '', { path: '/api/sessions' })).body).sessions.map((s) => s.id).sort();
  assert.deepEqual(own, ['3f9a1c20', '7c21e0d4']);

  assert.equal((await answer('octocat', mine.id, { method: 'POST', path: '/api/sessions/ID/stop' })).status, 200);
  assert.equal((await answer('octocat', mine.id, { path: '/api/sessions/ID/review' })).status, 200);
  assert.equal((await answer('octocat', mine.id, { path: '/auth/app?id=ID&next=/' })).status, 302);
  await websocket('octocat', mine.id);
  assert.deepEqual(reached.splice(-1), ['ttyd /term/3f9a1c20/ws'], 'the owner reaches the terminal, by its websocket');
  assert.equal((await answer('octocat', mine.id, { method: 'POST', path: '/api/sessions/ID/extend' })).status, 200);
  assert.equal((await answer('octocat', mine.id, { method: 'POST', path: '/api/sessions/ID/limits' })).status, 200);
  assert.deepEqual(reached, ['stop 3f9a1c20', 'review 3f9a1c20', 'appCode', 'extend 3f9a1c20', 'setLimits 3f9a1c20']);
});

test('pins are the signed-in person\'s, a rename is the session\'s, and the app\'s icons need no sign-in', async (t) => {
  const session = { id: '0a1b2c3d', status: 'running', title: 'Old name', owner: null, startedBy: 'octocat' };
  // Two of mia-dev's own, for the rail's groups.
  const main = { id: '1a1a1a1a', kind: 'task', status: 'running', title: 'Main', owner: 'mia-dev', startedBy: 'mia-dev' };
  const piece = { id: '2b2b2b2b', kind: 'task', status: 'running', title: 'Piece', owner: 'mia-dev', startedBy: 'mia-dev' };
  const all = [session, main, piece];
  const regrouped = [];
  const fleet = {
    sessions: () => all,
    find: (id) => all.find((x) => x.id === id) ?? null,
    regroup(s, under) {
      regrouped.push([s.id, under?.id ?? null]);
      s.startedFrom = under?.id ?? s.startedFrom;
      return s;
    },
    rename(s, title) {
      if (!String(title ?? '').trim()) throw Object.assign(new Error('a name cannot be empty'), { shown: true });
      s.title = title;
      return s;
    },
    extend(s, by) {
      if (by === 'sam-ops') throw Object.assign(new Error('only octocat, who has this session, can change when it pauses or stops'), { shown: true, forbidden: true });
      if (s.extendedBy) throw Object.assign(new Error('Extend is offered in the last 15 min before it pauses'), { shown: true });
      s.extendedBy = by;
      return s;
    },
    setLimits(s, values) {
      if (values.idleHours > 24) throw Object.assign(new Error('must be from 0.25 to 24 hours'), { shown: true });
      s.limits = values;
      return s;
    },
  };
  const auth = {
    enabled: () => true, available: () => true,
    sessionFor: async (cookie) => { const login = /woodshed_session=([\w-]+)/.exec(String(cookie))?.[1]; return login ? { login } : null; },
  };
  const config = {
    host: '127.0.0.1', publicUrl: `http://localhost`, extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const { createViewPrefs } = await import('./viewPrefs.mjs');
  const handle = createHandler({ config, fleet, auth, viewPrefs: createViewPrefs({ state: {}, save() {} }) });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = (login) => ({ cookie: `woodshed_session=${login}` });

  assert.equal((await post(port, '/api/sessions/0a1b2c3d/pin', { on: true }, as('octocat'))).status, 200);
  const sessions = async (login) => JSON.parse(await getBody(port, '/api/sessions', as(login)));
  const chat = { desktop: 'chat', phone: 'chat' };
  assert.deepEqual((await sessions('octocat')).viewPrefs, { pinned: ['0a1b2c3d'], sessionView: chat });
  assert.deepEqual((await sessions('mia-dev')).viewPrefs, { pinned: [], sessionView: chat }, 'nobody else\'s pins');

  // The tab a session opens on when none was picked: the person's own, on a desktop and on a phone.
  const saved = await post(port, '/api/my/session-view', { phone: 'tui' }, as('octocat'));
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, { desktop: 'chat', phone: 'tui' });
  assert.deepEqual(JSON.parse(await getBody(port, '/api/my/session-view', as('octocat'))), { desktop: 'chat', phone: 'tui' });
  assert.deepEqual((await sessions('octocat')).viewPrefs.sessionView, { desktop: 'chat', phone: 'tui' });
  assert.deepEqual((await sessions('mia-dev')).viewPrefs.sessionView, chat, 'nobody else\'s view');
  assert.equal((await post(port, '/api/my/session-view', { phone: 'terminal' }, as('octocat'))).status, 400);
  assert.equal((await post(port, '/api/my/session-view', { tablet: 'tui' }, as('octocat'))).status, 400);
  assert.equal((await post(port, '/api/my/session-view', {}, as('octocat'))).status, 400);

  assert.equal((await post(port, '/api/sessions/0a1b2c3d/rename', { title: 'New name' }, as('mia-dev'))).status, 200);
  assert.equal(session.title, 'New name');
  assert.equal((await post(port, '/api/sessions/0a1b2c3d/rename', { title: '  ' }, as('mia-dev'))).status, 400);
  assert.equal((await post(port, '/api/sessions/0a1b2c3d/rename', { title: 'x' })).status, 401, 'signed out');
  // Its group on the rail is a private session's owner's alone: a shared session is in none.
  assert.equal((await post(port, '/api/sessions/0a1b2c3d/group', { under: null }, as('mia-dev'))).status, 403);
  const moved = await post(port, '/api/sessions/2b2b2b2b/group', { under: '1a1a1a1a' }, as('mia-dev'));
  assert.equal(moved.status, 200);
  assert.equal(moved.body.startedFrom, '1a1a1a1a');
  assert.equal((await post(port, '/api/sessions/2b2b2b2b/group', { under: null }, as('mia-dev'))).status, 200);
  assert.deepEqual(regrouped, [['2b2b2b2b', '1a1a1a1a'], ['2b2b2b2b', null]], 'its owner\'s two moves, through the fleet');
  assert.equal((await post(port, '/api/sessions/2b2b2b2b/group', { under: 'nope' }, as('mia-dev'))).status, 400);
  assert.equal((await post(port, '/api/sessions/2b2b2b2b/group', { under: 'ffffffff' }, as('mia-dev'))).status, 404);
  assert.equal((await post(port, '/api/sessions/2b2b2b2b/group', { under: null }, as('octocat'))).status, 404, 'someone else\'s private session is no session');
  assert.equal(regrouped.length, 2);

  // Extend and a session's own limits are the session's too, for whoever can open it; the fleet's refusals are 400s.
  assert.equal((await post(port, '/api/sessions/0a1b2c3d/extend', {}, as('mia-dev'))).status, 200);
  assert.equal(session.extendedBy, 'mia-dev');
  assert.equal((await post(port, '/api/sessions/0a1b2c3d/extend', {}, as('mia-dev'))).status, 400);
  assert.equal((await post(port, '/api/sessions/0a1b2c3d/limits', { idleHours: 3 }, as('octocat'))).status, 200);
  assert.deepEqual(session.limits, { idleHours: 3 });
  assert.equal((await post(port, '/api/sessions/0a1b2c3d/limits', { idleHours: 30 }, as('octocat'))).status, 400);
  assert.equal((await post(port, '/api/sessions/0a1b2c3d/extend', {})).status, 401, 'signed out');
  assert.equal((await post(port, '/api/sessions/0a1b2c3d/extend', {}, as('sam-ops'))).status, 403, 'the fleet\'s refusal of someone who does not have it');

  // Shared and My Woodshed are the rail's two tabs, each its own page of the same shell as a session's.
  for (const page of ['/', '/all', '/s/0a1b2c3d']) {
    const scripts = [...(await getBody(port, page, as('octocat'))).matchAll(/<script src="\/static\/([\w.]+)\?v=[0-9a-f]{12}"/g)].map((m) => m[1]);
    // Whose page it is, so the rail draws from what it kept only for the same person.
    assert.match(await getBody(port, page, as('octocat')), /<meta name="woodshed-login" content="octocat">/, `${page} names who it is for`);
    // The same scripts on each, since session.js moves between them in place.
    assert.deepEqual(scripts.slice(-9), ['dictation.js', 'launcher.js', 'sharedHome.js', 'messageBox.js', 'chatThread.cjs', 'chat.js', 'appShare.js', 'keptMachine.cjs', 'session.js'], `${page} is the shell`);
    // The notifications on every page, ahead of the shell that opens them on ⌘J: the browser's own list, then the bell.
    assert.deepEqual(scripts.slice(scripts.indexOf('keys.cjs'), scripts.indexOf('keys.cjs') + 4), ['keys.cjs', 'browserNotifications.js', 'notificationBell.js', 'shell.js'], `${page} has the notifications`);
  }
  // The browser's bell runs the desktop app's own rule for what notifies, served from desktop/ under the page's version.
  const attentionUrl = /data-attention="(\/static\/attention\.mjs\?v=[0-9a-f]{12})"/.exec(await getBody(port, '/', as('octocat')))?.[1];
  assert.ok(attentionUrl, 'the page names the rule');
  const rule = await fetch(`http://127.0.0.1:${port}${attentionUrl}`);
  assert.equal(rule.status, 200);
  assert.match(rule.headers.get('content-type'), /javascript/);
  assert.equal(await rule.text(), fs.readFileSync(new URL('../desktop/attention.mjs', import.meta.url), 'utf8'));
  assert.match(await getBody(port, '/static/sharedHome.js', as('octocat')), /createSharedHome/);
  assert.match(await getBody(port, '/static/messageBox.js', as('octocat')), /createMessageBox/);
  assert.match(await getBody(port, '/static/chatThread.cjs', as('octocat')), /WoodshedChatThread/);
  assert.match(await getBody(port, '/static/chat.js', as('octocat')), /createChat/);
  assert.match(await getBody(port, '/static/dictation.js', as('octocat')), /W\.dictation = /);
  // The settings pages are one page: each address loads every settings page's script, so common.js moves between
  // them in place. My settings' Repo settings card draws its layers with the repo page's parts, loaded before both.
  const SETTINGS = ['settingsRows.js', 'hostRows.js', 'dbRestoreStates.js', 'dbRestore.js', 'repoLayers.js', 'myRepoSettings.js', 'mySettings.js', 'slackSetup.js', 'consoleSettings.js', 'repoSettings.js', 'webhookSetup.js', 'secrets.js', 'people.js', 'events.js', 'analyticsDays.js', 'analytics.js'];
  for (const page of ['/settings', '/console-settings', '/console-settings/repos/app', '/secrets', '/people', '/events']) {
    const settingsScripts = [...(await getBody(port, page, as('octocat'))).matchAll(/<script src="\/static\/([\w.]+)\?v=[0-9a-f]{12}"/g)].map((m) => m[1]);
    assert.deepEqual(settingsScripts.slice(-SETTINGS.length), SETTINGS, `${page} is the settings page`);
    // Whose page it is too, so common.js drops what another login kept in the browser tab.
    assert.match(await getBody(port, page, as('octocat')), /<meta name="woodshed-login" content="octocat">/, `${page} names who it is for`);
  }
  // Each script a page names is served: one missing from the static list would load as a 404.
  for (const script of SETTINGS) assert.equal((await fetch(`http://127.0.0.1:${port}/static/${script}`, { headers: { host: `localhost:${port}`, ...as('octocat') } })).status, 200, script);
  assert.match(await getBody(port, '/static/repoLayers.js', as('octocat')), /WoodshedRepoLayers = /);
  assert.match(await getBody(port, '/static/myRepoSettings.js', as('octocat')), /WoodshedMyRepoSettings = /);

  // The version a page names is kept by the browser; any other is asked for again, so a deploy is never stale.
  const named = /href="(\/static\/style\.css\?v=[0-9a-f]{12})"/.exec(await getBody(port, '/', as('octocat')))[1];
  const cacheOf = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`, { headers: { host: `localhost:${port}`, ...as('octocat') } })).headers.get('cache-control');
  assert.equal(await cacheOf(named), 'public, max-age=31536000, immutable');
  assert.equal(await cacheOf('/static/style.css?v=000000000000'), 'no-cache', 'an old version');
  assert.equal(await cacheOf('/static/style.css'), 'no-cache', 'no version, as the woodshed-db.mjs download is');
  assert.equal(await request(port, { path: '/static/sessions.js', headers: { host: `localhost:${port}`, ...as('octocat') } }), 404, 'the old page is gone');

  const manifest = JSON.parse(await getBody(port, '/manifest.webmanifest', {}));
  assert.equal(manifest.name, 'Woodshed');
  assert.equal(await request(port, { path: '/icon-192.png', headers: { host: `localhost:${port}` } }), 200, 'icons before sign-in');
});

function getBody(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve(raw));
    });
    req.on('error', reject);
    req.end();
  });
}

test('My Woodshed writes act for the signed-in login, and need a saved Claude token to start', async (t) => {
  const started = [];
  const fleet = {
    sessions: () => [], find: () => null,
    startPrivate: async (args) => { started.push(args); return { id: '0a1b2c3d', owner: args.owner, token: 'secret', status: 'queued' }; },
  };
  const saved = new Set();
  const userSettings = {
    view: (login) => ({ claudeToken: { set: saved.has(login), savedAt: null }, setUp: saved.has(login), available: true }),
    setClaudeToken: async (login, value) => {
      if (!String(value).startsWith('sk-ant-')) throw Object.assign(new Error('this is not a token from claude setup-token'), { shown: true });
      saved.add(login);
    },
    removeClaudeToken: async (login) => { saved.delete(login); },
  };
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => ({ login: /woodshed_session=([\w-]+)/.exec(cookie)[1] }) };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const handle = createHandler({ config, fleet, auth, userSettings });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = { cookie: 'woodshed_session=mia-dev' };

  assert.deepEqual(await post(port, '/api/my/sessions', { prompt: 'go', owner: 'octocat' }, as), { status: 409, body: { error: 'save your Claude token on My settings first' } });
  assert.equal((await post(port, '/api/my/claude-token', { value: 'nope' }, as)).status, 409);
  const set = await post(port, '/api/my/claude-token', { value: 'sk-ant-oat01-x' }, as);
  assert.equal(set.status, 200);
  assert.equal(set.body.login, 'mia-dev');
  assert.equal(set.body.claudeToken.set, true);
  assert.equal(JSON.stringify(set.body).includes('sk-ant'), false, 'the token never comes back');
  const made = await post(port, '/api/my/sessions', { prompt: 'go', owner: 'octocat', model: 'opus' }, as);
  assert.equal(made.status, 201);
  assert.equal(made.body.token, undefined, 'no session token in the answer');
  assert.equal(started[0].owner, 'mia-dev', 'the body cannot say whose it is');
  assert.equal(started[0].background, true, 'the page does not wait for the container');
  assert.equal((await post(port, '/api/my/claude-token/remove', {}, as)).body.claudeToken.set, false);
});

test('New session offers only the agents set up to run, and a Codex start needs a sign-in or the team key', async (t) => {
  const fleet = {
    sessions: () => [], find: () => null,
    startPrivate: async (args) => ({ id: '0a1b2c3d', owner: args.owner, token: 'secret', status: 'queued' }),
  };
  const claude = new Set(['mia-dev']);
  const codex = new Set();
  const userSettings = {
    view: (login) => ({ claudeToken: { set: claude.has(login), savedAt: null }, codexAuth: { set: codex.has(login), savedAt: null }, setUp: true, available: true }),
    setCodexAuth: async (login) => { codex.add(login); },
  };
  let teamKey = null;
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => ({ login: /woodshed_session=([\w-]+)/.exec(cookie)[1] }) };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const handle = createHandler({ config, fleet, auth, userSettings, openaiTeamKey: async () => teamKey });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = { cookie: 'woodshed_session=mia-dev' };
  const agents = async () => JSON.parse(await getBody(port, '/api/my', as)).agents;

  const none = Object.fromEntries(agentsRegistry.OWN_SIGN_IN_AGENTS.map((id) => [id, false]));
  assert.deepEqual(await agents(), { claude: true, codex: false, ...none }, 'no Codex sign-in and no team key');
  assert.deepEqual(await post(port, '/api/my/sessions', { prompt: 'go', agent: 'codex' }, as),
    { status: 409, body: { error: 'save your Codex sign-in on My settings first: the console has no OpenAI key' } });
  teamKey = 'sk-team';
  assert.deepEqual(await agents(), { claude: true, codex: true, ...none }, 'the team key runs Codex');
  assert.equal((await post(port, '/api/my/sessions', { prompt: 'go', agent: 'codex' }, as)).status, 201);
  teamKey = null;
  await post(port, '/api/my/codex-auth', { value: 'sk-own' }, as);
  assert.deepEqual(await agents(), { claude: true, codex: true, ...none }, 'their own sign-in runs Codex');
  claude.delete('mia-dev');
  assert.deepEqual(await agents(), { claude: false, codex: true, ...none }, 'no Claude token, no Claude');
});

test('a stopped private session\'s kept machine is read for its owner, and Resume on the latest image reaches the fleet', async (t) => {
  t.mock.method(console, 'log', () => {});
  const resumed = [];
  const stopped = { id: '0a1b2c3d', owner: 'mia-dev', status: 'stopped', options: {} };
  const fleet = {
    sessions: () => [], find: (id) => (id === stopped.id ? stopped : null),
    resumePrivate: async (args) => { resumed.push(args); return stopped; },
    keptMachine: async ({ owner, id }) => {
      if (owner !== stopped.owner || id !== stopped.id) throw Object.assign(new Error('no session you can open with that id'), { shown: true });
      return { kept: true, outdated: true };
    },
  };
  const userSettings = {
    refresh: async () => {},
    view: () => ({ claudeToken: { set: true, savedAt: null }, codexAuth: { set: false, savedAt: null }, setUp: true, available: true, agentAuth: {} }),
  };
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => ({ login: /woodshed_session=([\w-]+)/.exec(cookie)[1] }) };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const server = http.createServer(createHandler({ config, fleet, auth, userSettings }));
  const port = await listen(server);
  t.after(() => server.close());
  const as = (login) => ({ cookie: `woodshed_session=${login}` });

  assert.deepEqual(JSON.parse(await getBody(port, `/api/my/sessions/${stopped.id}/machine`, as('mia-dev'))), { kept: true, outdated: true });
  assert.deepEqual(JSON.parse(await getBody(port, `/api/my/sessions/${stopped.id}/machine`, as('joel'))), { error: 'no session you can open with that id' }, 'someone else\'s answers as none');
  assert.equal((await post(port, `/api/my/sessions/${stopped.id}/resume`, { latestImage: true }, as('mia-dev'))).status, 201);
  assert.equal((await post(port, `/api/my/sessions/${stopped.id}/resume`, {}, as('mia-dev'))).status, 201);
  assert.equal((await post(port, `/api/my/sessions/${stopped.id}/resume`, { latestImage: 'yes' }, as('mia-dev'))).status, 201);
  assert.deepEqual(resumed.map((r) => r.latestImage), [true, false, false], 'only a true asks for it');
});

test('Grok Build and OpenCode are offered and start only on their owner\'s own sign-in', async (t) => {
  t.mock.method(console, 'log', () => {});
  const started = [];
  const stopped = { id: '0a1b2c3d', owner: 'mia-dev', status: 'stopped', options: { agent: 'grok' } };
  const fleet = {
    sessions: () => [], find: (id) => (id === stopped.id ? stopped : null),
    startPrivate: async (args) => { started.push(args); return { id: '0a1b2c3e', owner: args.owner, token: 'secret', status: 'queued' }; },
    resumePrivate: async () => stopped,
  };
  const own = new Map();
  const userSettings = {
    refresh: async () => {},
    view: () => ({
      claudeToken: { set: false, savedAt: null }, codexAuth: { set: false, savedAt: null }, setUp: true, available: true,
      agentAuth: Object.fromEntries(agentsRegistry.OWN_SIGN_IN_AGENTS.map((id) => [id, { set: own.has(id), savedAt: null }])),
    }),
    setAgentAuth: async (login, id, value) => { own.set(id, value); },
    removeAgentAuth: async (login, id) => { own.delete(id); },
  };
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => ({ login: /woodshed_session=([\w-]+)/.exec(cookie)[1] }) };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const handle = createHandler({ config, fleet, auth, userSettings });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = { cookie: 'woodshed_session=mia-dev' };
  const me = async () => JSON.parse(await getBody(port, '/api/my', as));

  assert.deepEqual((await me()).agents, { claude: false, codex: false, ...Object.fromEntries(agentsRegistry.OWN_SIGN_IN_AGENTS.map((id) => [id, false])) });
  assert.deepEqual(await post(port, '/api/my/sessions', { prompt: 'go', agent: 'grok' }, as),
    { status: 409, body: { error: 'save your Grok Build sign-in on My settings first' } });
  assert.deepEqual(await post(port, `/api/my/sessions/${stopped.id}/resume`, {}, as),
    { status: 409, body: { error: 'save your Grok Build sign-in on My settings first' } }, 'a resume needs it too');
  // A session starting or resuming one of its person's goes through the same checks (sessionStarts.mjs).
  assert.deepEqual(await handle.startMine('mia-dev', { prompt: 'go', agent: 'grok' }, { startedFrom: 'aaaa0001' }),
    { status: 409, body: { error: 'save your Grok Build sign-in on My settings first' } });
  assert.deepEqual(await handle.resumeMine('mia-dev', stopped.id), { status: 409, body: { error: 'save your Grok Build sign-in on My settings first' } });
  assert.equal(started.length, 0);
  const saved = await post(port, '/api/my/agent-auth/grok', { value: 'xai-own-key-0123456789' }, as);
  assert.equal(saved.status, 200);
  assert.deepEqual([saved.body.agents.grok, saved.body.agentAuth.grok.set], [true, true]);
  assert.equal((await post(port, '/api/my/sessions', { prompt: 'go', agent: 'grok', model: 'grok-build' }, as)).status, 201, 'no Claude token needed');
  assert.equal(started[0].agent, 'grok');
  assert.equal((await handle.startMine('mia-dev', { prompt: 'go', agent: 'grok' }, { startedFrom: 'aaaa0001' })).status, 201);
  assert.deepEqual([started[1].agent, started[1].startedFrom], ['grok', 'aaaa0001']);
  assert.equal((await handle.startMine('mia-dev', { prompt: 'go', agent: 'opencode' }, { startedFrom: 'aaaa0001' })).status, 409, 'opencode\'s sign-in is not saved');
  assert.equal((await post(port, '/api/my/sessions', { prompt: 'go', agent: 'opencode' }, as)).status, 409);
  for (const id of ['codex', 'claude', 'nope']) assert.equal((await post(port, `/api/my/agent-auth/${id}`, { value: 'x' }, as)).status, 404, id);
  assert.equal((await post(port, '/api/my/agent-auth/grok/remove', {}, as)).body.agents.grok, false);
  assert.equal((await post(port, '/api/my/agent-auth/grok', { value: 'x' }, { ...as, origin: 'https://evil.example' })).status, 403);
  // A multi-provider auth.json past the usual 16 KiB body, within the registry's limit: held to that limit, not the body's.
  const big = JSON.stringify(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`provider${i}`, { type: 'api', key: `"k${i}"-${'x'.repeat(400)}` }])));
  assert.ok(big.length > 16 * 1024 && big.length < agentsRegistry.agent('opencode').signIn.maxChars, String(big.length));
  const bigSaved = await post(port, '/api/my/agent-auth/opencode', { value: big }, as);
  assert.equal(bigSaved.status, 200, JSON.stringify(bigSaved.body));
  assert.equal(bigSaved.body.agents.opencode, true);
  // The request itself stays bounded (the registry's limit on the decoded value is checkSignIn's, in shared/agents.test.mjs).
  assert.deepEqual(await post(port, '/api/my/agent-auth/opencode', { value: 'x'.repeat(170 * 1024) }, as), { status: 400, body: { error: 'body too large' } });
});

test('New session\'s Grok Build models are the owner\'s own list, forgotten when the sign-in changes', async (t) => {
  t.mock.method(console, 'log', () => {});
  const forgot = [];
  const listed = { models: [{ slug: 'grok-4.7', name: 'Grok 4.7', description: '', efforts: ['low', 'high'], defaultEffort: 'high' }], source: 'login', note: null };
  const grokModels = { list: async (login) => ({ ...listed, login }), forget: (login) => forgot.push(login) };
  const own = new Map();
  const userSettings = {
    refresh: async () => {},
    view: () => ({
      claudeToken: { set: false, savedAt: null }, codexAuth: { set: false, savedAt: null }, setUp: true, available: true,
      agentAuth: Object.fromEntries(agentsRegistry.OWN_SIGN_IN_AGENTS.map((id) => [id, { set: own.has(id), savedAt: null }])),
    }),
    setAgentAuth: async (login, id, value) => { own.set(id, value); },
    removeAgentAuth: async (login, id) => { own.delete(id); },
  };
  const started = [];
  const fleet = { sessions: () => [], find: () => null, startPrivate: async (args) => { started.push(args); return { id: '0a1b2c3e', owner: args.owner, token: 'secret', status: 'queued' }; } };
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => ({ login: /woodshed_session=([\w-]+)/.exec(cookie)[1] }) };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const handle = createHandler({ config, fleet, auth, userSettings, grokModels });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = { cookie: 'woodshed_session=mia-dev' };

  assert.deepEqual(JSON.parse(await getBody(port, '/api/my/grok-models', as)), { ...listed, login: 'mia-dev' });
  assert.equal((await post(port, '/api/my/agent-auth/grok', { value: 'xai-own-key-0123456789' }, as)).status, 200);
  assert.deepEqual(forgot, ['mia-dev'], 'saving forgets the list');
  // A model the list does not have still starts: the registry's shape is the check, as when the list cannot be read.
  assert.equal((await post(port, '/api/my/sessions', { prompt: 'go', agent: 'grok', model: 'grok-typed-by-hand', effort: 'xhigh' }, as)).status, 201);
  assert.equal(started[0].model, 'grok-typed-by-hand');
  await post(port, '/api/my/agent-auth/opencode', { value: JSON.stringify({ p: { type: 'api', key: 'k' } }) }, as);
  assert.deepEqual(forgot, ['mia-dev'], 'another agent\'s sign-in leaves it');
  assert.equal((await post(port, '/api/my/agent-auth/grok/remove', {}, as)).status, 200);
  assert.deepEqual(forgot, ['mia-dev', 'mia-dev'], 'removing forgets it too');

  const handleWithout = createHandler({ config, fleet, auth, userSettings });
  const without = http.createServer((req, res) => { handleWithout(req, res); });
  const otherPort = await listen(without);
  t.after(() => without.close());
  const none = JSON.parse(await getBody(otherPort, '/api/my/grok-models', as));
  assert.deepEqual([none.models, none.source], [[], null]);
  assert.match(none.note, /type a model name/);
});

test('the first Claude token starts your own databases, and New session waits for them', async (t) => {
  const fleet = {
    sessions: () => [], find: () => null,
    startPrivate: async (args) => ({ id: '0a1b2c3d', owner: args.owner, token: 'secret', status: 'queued' }),
    removePrivate: async () => ({ stopped: 0, removed: 0 }),
  };
  const saved = new Set();
  const userSettings = {
    view: (login) => ({ claudeToken: { set: saved.has(login), savedAt: null }, setUp: saved.has(login), available: true }),
    setClaudeToken: async (login) => { saved.add(login); },
    removeAll: async (login) => { saved.delete(login); },
  };
  const states = new Map();
  const asked = [];
  const databases = {
    available: true,
    view: (login) => ({ available: true, status: states.get(login) ?? 'none', name: `woodshed_${login}` }),
    create: async (login) => { asked.push(`create ${login}`); states.set(login, 'working'); },
    remove: async (login) => { asked.push(`remove ${login}`); },
  };
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => ({ login: /woodshed_session=([\w-]+)/.exec(cookie)[1] }) };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const handle = createHandler({ config, fleet, auth, userSettings, databases });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = { cookie: 'woodshed_session=mia-dev' };

  const set = await post(port, '/api/my/claude-token', { value: 'sk-ant-oat01-x' }, as);
  assert.equal(set.body.databases.status, 'working');
  assert.deepEqual(asked, ['create mia-dev']);
  await post(port, '/api/my/claude-token', { value: 'sk-ant-oat01-y' }, as);
  assert.deepEqual(asked, ['create mia-dev'], 'a second token starts nothing more');

  const early = await post(port, '/api/my/sessions', { prompt: 'go' }, as);
  assert.equal(early.status, 409);
  assert.match(early.body.error, /databases are not ready/);
  states.set('mia-dev', 'ready');
  assert.equal((await post(port, '/api/my/sessions', { prompt: 'go' }, as)).status, 201);

  assert.deepEqual(await post(port, '/api/my/databases', {}, as), { status: 400, body: { error: 'type reset to confirm: your data goes' } });
  assert.equal((await post(port, '/api/my/databases', { confirm: 'reset' }, as)).status, 200);
  assert.deepEqual(asked, ['create mia-dev', 'create mia-dev']);

  await post(port, '/api/my/remove', { confirm: 'mia-dev' }, as);
  assert.deepEqual(asked.at(-1), 'remove mia-dev');
});

test('a dump is restored from My settings as the signed-in person, and Apply needs the word typed', async (t) => {
  const fleet = { sessions: () => [], find: () => null };
  const asked = [];
  let restoring = false;
  const databases = {
    available: true,
    view: (login) => ({ available: true, status: 'ready', name: `woodshed_${login}` }),
    create: async (login) => { asked.push(`reset ${login}`); },
  };
  const dbRestore = {
    view: (login) => ({ available: true, status: restoring ? 'restoring' : 'none', name: `woodshed_${login}_restore` }),
    busy: () => restoring,
    upload: async (req, { login, name }) => {
      let bytes = 0;
      for await (const chunk of req) bytes += chunk.length;
      asked.push(`upload ${login} ${name} ${bytes}`);
      restoring = true;
      return dbRestore.view(login);
    },
    apply: async (login) => { asked.push(`apply ${login}`); },
    discard: async (login) => { asked.push(`discard ${login}`); },
    forget: (login) => { asked.push(`forget ${login}`); },
  };
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => ({ login: /woodshed_session=([\w-]+)/.exec(cookie)[1] }) };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const handle = createHandler({ config, fleet, auth, databases, dbRestore });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = { cookie: 'woodshed_session=mia-dev' };

  const sent = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/api/my/databases/restore?name=prod.dump',
      headers: { host: `localhost:${port}`, origin: `http://localhost:${port}`, 'x-woodshed': '1', 'content-type': 'application/octet-stream', ...as },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.end(Buffer.alloc(1000));
  });
  assert.equal(sent.status, 202);
  assert.equal(sent.body.restore.status, 'restoring');
  assert.deepEqual(asked, ['upload mia-dev prod.dump 1000']);

  const reset = await post(port, '/api/my/databases', { confirm: 'reset' }, as);
  assert.equal(reset.status, 409, 'no reset while a restore runs');
  restoring = false;
  assert.deepEqual(await post(port, '/api/my/databases/restore/apply', {}, as), { status: 400, body: { error: 'type apply to confirm: your database is replaced' } });
  assert.equal((await post(port, '/api/my/databases/restore/apply', { confirm: 'apply' }, as)).status, 200);
  assert.equal((await post(port, '/api/my/databases/restore/discard', {}, as)).status, 200);
  assert.equal((await post(port, '/api/my/databases', { confirm: 'reset' }, as)).status, 200);
  assert.deepEqual(asked.slice(1), ['apply mia-dev', 'discard mia-dev', 'reset mia-dev', 'forget mia-dev'], 'a reset drops the copy with the rest');
});

test('a tunnel token comes from My settings, signed in; woodshed-db.mjs reads its details with the token alone', async (t) => {
  const fleet = { sessions: () => [], find: () => null, removePrivate: async () => ({ stopped: 0, removed: 0 }) };
  const databases = {
    available: true,
    view: (login) => ({ available: true, status: login === 'mia-dev' ? 'ready' : 'working', name: `woodshed_${login}` }),
    credentials: async (login) => ({ user: `woodshed_${login}`, password: 'secret', name: `woodshed_${login}` }),
    remove: async () => {},
  };
  const tunnel = createTunnel({ store: { state: {}, save() {} }, targets: { pg: '127.0.0.1:1', mongo: '127.0.0.1:2' }, databases });
  const cli = createCliSignIn({ store: { state: {}, save() {} } });
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => (cookie ? { login: /woodshed_session=([\w-]+)/.exec(cookie)[1] } : null) };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const handle = createHandler({ config, fleet, auth, databases, tunnel, cli });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = { cookie: 'woodshed_session=mia-dev' };
  const details = (token) => fetch(`http://127.0.0.1:${port}/api/tunnel/connection`, { headers: { host: `localhost:${port}`, authorization: `Bearer ${token}` } });

  assert.equal((await post(port, '/api/my/tunnel-token', {}, { cookie: 'woodshed_session=octocat' })).status, 409, 'not before the databases are ready');
  assert.equal((await post(port, '/api/my/tunnel-token', {})).status, 401, 'signed in only');
  const made = await post(port, '/api/my/tunnel-token', {}, as);
  assert.equal(made.status, 200);
  assert.match(made.body.tunnelToken, /^wt_[0-9a-f]{64}$/);
  assert.ok(made.body.tunnel.expiresAt);
  assert.equal((await details(made.body.tunnelToken)).status, 200, 'no cookie needed with the token');
  const { deviceCode, userCode } = cli.start({ name: 'laptop' });
  cli.decide({ code: userCode, login: 'mia-dev', approve: true });
  const { token: cliToken } = cli.poll(deviceCode);
  const cliMe = () => fetch(`http://127.0.0.1:${port}/api/cli/me`, { headers: { host: `localhost:${port}`, authorization: `Bearer ${cliToken}` } });
  assert.equal((await cliMe()).status, 200);
  assert.equal((await post(port, '/api/my/remove', { confirm: 'mia-dev' }, as)).status, 200);
  assert.equal((await details(made.body.tunnelToken)).status, 401, 'Remove My Woodshed revokes it');
  assert.equal((await cliMe()).status, 401, 'and the command line\'s sign-ins');

  const again = await post(port, '/api/my/tunnel-token', {}, as);
  const revoked = await post(port, '/api/my/tunnel-token/remove', {}, as);
  assert.equal(revoked.body.tunnel.expiresAt, null);
  assert.equal((await details(again.body.tunnelToken)).status, 401);
});

test('Remove My Woodshed needs your login typed, and removes only yours; the rail\'s pull requests are yours alone', async (t) => {
  const done = [];
  let listed = [];
  const fleet = {
    sessions: () => listed, find: () => null,
    removePrivate: async (owner) => { done.push(`sessions ${owner}`); return { stopped: 1, removed: 2 }; },
  };
  const userSettings = {
    view: () => ({ claudeToken: { set: false, savedAt: null }, setUp: false, available: true }),
    removeAll: async (login) => { done.push(`settings ${login}`); },
    noteHome: () => {},
  };
  const homes = {
    remove: async (login) => { done.push(`home ${login}`); },
    removeSessionsOf: async (login) => { done.push(`session homes ${login}`); return 0; },
  };
  const claudeSettings = { remove: async (login) => { done.push(`shared settings ${login}`); } };
  const repoSettings = { forgetPerson: async (login) => { done.push(`repo settings ${login}`); } };
  let asked = 0;
  const github = { openPullsFor: async (login) => { asked++; return [{ number: 7, title: `${login}'s PR`, why: 'yours' }]; } };
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => ({ login: /woodshed_session=([\w-]+)/.exec(cookie)[1] }) };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const githubUser = { disconnect: async (login) => { done.push(`github ${login}`); } };
  const handle = createHandler({ config, fleet, auth, userSettings, github, homes, githubUser, claudeSettings, repoSettings });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = { cookie: 'woodshed_session=mia-dev' };

  assert.deepEqual(await post(port, '/api/my/remove', { confirm: 'octocat' }, as), { status: 400, body: { error: 'type mia-dev to confirm' } });
  assert.equal((await post(port, '/api/my/remove', {}, { ...as, origin: 'https://evil.example' })).status, 403);
  assert.deepEqual(done, []);
  const removed = await post(port, '/api/my/remove', { confirm: 'mia-dev' }, as);
  assert.equal(removed.status, 200);
  assert.deepEqual([removed.body.stopped, removed.body.removed], [1, 2]);
  assert.deepEqual(done, ['github mia-dev', 'repo settings mia-dev', 'settings mia-dev', 'sessions mia-dev', 'session homes mia-dev', 'home mia-dev', 'shared settings mia-dev'],
    'GitHub is disconnected, so its token ends at GitHub, then the settings, then the sessions, and the homes last, after their stops tried to save them');

  done.length = 0;
  listed = [{ id: 'aaaa1111', owner: 'mia-dev', status: 'running' }];
  assert.equal((await post(port, '/api/my/home/forget', {}, as)).status, 409, 'a running session would save it again');
  assert.deepEqual(done, []);
  listed = [{ id: 'aaaa1111', owner: 'mia-dev', status: 'queued' }];
  assert.equal((await post(port, '/api/my/home/forget', {}, as)).status, 409, 'one waiting in line would start on the home it deletes');
  assert.deepEqual(done, []);
  listed = [{ id: 'aaaa1111', owner: 'mia-dev', status: 'stopped' }, { id: 'bbbb2222', owner: 'octocat', status: 'running' }];
  assert.equal((await post(port, '/api/my/home/forget', {}, as)).status, 200);
  assert.deepEqual(done, ['session homes mia-dev', 'home mia-dev', 'shared settings mia-dev'],
    'Forget takes every session\'s copy too, so no Resume brings it back, and the owner\'s last, so a failure leaves its size on the page true');

  const pulls = async () => (await (await fetch(`http://127.0.0.1:${port}/api/my/pulls`, { headers: as })).json()).pulls;
  assert.deepEqual(await pulls(), [{ number: 7, title: "mia-dev's PR", why: 'yours', project: 'r', repo: 'o/r' }]);
  await pulls();
  assert.equal(asked, 1, 'kept for a minute');
});

test('/api/my names each agent\'s default as the person\'s shared settings have it, and only theirs', async (t) => {
  const b64 = (text) => Buffer.from(text).toString('base64');
  const objects = new Map([
    ['mia-dev/claude-settings.json', JSON.stringify({ version: 3, items: {
      '.claude/settings.json': b64(JSON.stringify({ model: 'opus', effortLevel: 'high' })),
      '.codex/config.toml': b64('model = "gpt-5.5"\n'),
    } })],
    ['broken/claude-settings.json', '{not json'],
  ]);
  let puts = 0;
  const store = { getText: async (key) => objects.get(key) ?? null, putText: async () => { puts++; }, removeKey: async () => {} };
  const claudeSettings = createClaudeSettings({ store });
  const fleet = { sessions: () => [], find: () => null };
  const userSettings = { view: () => ({ claudeToken: { set: true, savedAt: null }, codexAuth: { set: false, savedAt: null }, setUp: true, available: true }) };
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => ({ login: /woodshed_session=([\w-]+)/.exec(cookie)[1] }) };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const handle = createHandler({ config, fleet, auth, userSettings, claudeSettings });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const me = async (login) => JSON.parse(await getBody(port, '/api/my', { cookie: `woodshed_session=${login}` }));

  assert.deepEqual((await me('mia-dev')).agentDefaults, {
    claude: { read: true, model: 'opus', effort: 'high' }, codex: { read: true, model: 'gpt-5.5', effort: null }, grok: null, opencode: null,
  });
  assert.deepEqual((await me('octocat')).agentDefaults, {
    claude: { read: true, model: null, effort: null }, codex: { read: true, model: null, effort: null }, grok: null, opencode: null,
  }, 'nothing saved: each agent picks its own, and nobody else\'s is shown');
  const unread = { claude: { read: false, model: null, effort: null }, codex: { read: false, model: null, effort: null }, grok: null, opencode: null };
  const warned = t.mock.method(console, 'warn', () => {});
  const broken = await me('broken');
  assert.equal(broken.login, 'broken', '/api/my still answers');
  assert.deepEqual(broken.agentDefaults, unread, 'a copy that does not read names nothing');
  assert.deepEqual((await me('broken')).agentDefaults, unread);
  const lines = warned.mock.calls.filter((c) => c.arguments[0] === 'console: shared Claude settings not read for New session');
  assert.equal(lines.length, 1, 'warned of once, not on every poll');
  assert.equal(lines[0].arguments[1].login, 'broken');
  assert.equal(puts, 0, 'reading writes nothing');
});

test('a person\'s files are read and written for the signed-in login only', async (t) => {
  const calls = [];
  const userSettings = {
    view: () => ({ claudeToken: { set: false }, files: {}, setUp: true, available: true }),
    file: async (login, key) => { calls.push(['file', login, key]); return { key, text: `${login}'s ${key}`, custom: true }; },
    saveFile: async (login, key, text) => { calls.push(['save', login, key, text]); },
    resetFile: async (login, key) => { calls.push(['reset', login, key]); },
  };
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => ({ login: /woodshed_session=([\w-]+)/.exec(cookie)[1] }) };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth, userSettings });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = { cookie: 'woodshed_session=mia-dev' };

  const read = await (await fetch(`http://127.0.0.1:${port}/api/my/files/api-env`, { headers: as })).json();
  assert.equal(read.text, "mia-dev's api-env");
  assert.equal((await post(port, '/api/my/files/api-env', { text: 'A=1', login: 'octocat' }, as)).status, 200);
  assert.equal((await post(port, '/api/my/files/tmux-conf/reset', {}, as)).status, 200);
  assert.equal((await post(port, '/api/my/files/tmux-conf', { text: 'x' }, { ...as, origin: 'https://evil.example' })).status, 403);
  assert.deepEqual(calls.filter((c) => c[0] !== 'file'), [['save', 'mia-dev', 'api-env', 'A=1'], ['reset', 'mia-dev', 'tmux-conf']]);
  assert.ok(calls.every((c) => c[1] === 'mia-dev'));
});

test('Connect GitHub starts a sign-in that keeps its token, and the git identity is the signed-in person\'s', async (t) => {
  const started = [];
  const done = [];
  const auth = {
    enabled: () => true, available: () => true,
    sessionFor: async (cookie) => {
      const login = /woodshed_session=([\w-]+)/.exec(String(cookie))?.[1];
      return login ? { login } : null;
    },
    start: async (next, opts) => { started.push([next, opts]); return { location: 'https://github.com/login/oauth/authorize?x=1', setCookie: 's=1' }; },
  };
  const userSettings = {
    view: () => ({ claudeToken: { set: false }, github: { connected: true }, files: {}, setUp: true, available: true }),
    setGitIdentity: async (login, identity) => {
      if (!String(identity.email).includes('@')) throw Object.assign(new Error('that is not an email address'), { shown: true });
      done.push(['identity', login, identity.name]);
    },
    forgetGitHub: async () => {},
  };
  const githubUser = { disconnect: async (login) => { done.push(['disconnect', login]); } };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth, userSettings, githubUser });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = { cookie: 'woodshed_session=mia-dev' };

  assert.deepEqual(await getWith(port, '/auth/connect', as), { status: 302, location: 'https://github.com/login/oauth/authorize?x=1' });
  assert.deepEqual(started, [['/settings?connected=1', { connect: true }]]);
  assert.equal((await getWith(port, '/auth/connect')).status, 401, 'only someone signed in connects');
  assert.deepEqual(await post(port, '/api/my/github/identity', { name: 'Mia', email: 'nope' }, as), { status: 409, body: { error: 'that is not an email address' } },
    'a refused identity is answered, not thrown after a 200');
  assert.equal((await post(port, '/api/my/github/identity', { name: 'Mia', email: 'mia@example.com' }, as)).status, 200);
  assert.equal((await post(port, '/api/my/github/disconnect', {}, as)).status, 200);
  assert.deepEqual(done, [['identity', 'mia-dev', 'Mia'], ['disconnect', 'mia-dev']]);
});

test('Resume and Delete now act on a shared session, with the message, and say why they cannot', async (t) => {
  const done = [];
  const session = { id: '0a1b2c3d', status: 'stopped', title: 't', kept: true, token: 'secret' };
  const fleet = {
    sessions: () => [session],
    find: (id) => (id === session.id ? session : null),
    async resumeShared(s, args) { done.push(['resume', s.id, args]); return { ...s, status: 'queued' }; },
    async deleteShared() { throw Object.assign(new Error('stop the session first'), { shown: true }); },
  };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const handle = createHandler({ config, fleet });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());

  const resumed = await post(port, '/api/sessions/0a1b2c3d/resume', { message: 'Use the URL' });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.status, 'queued');
  assert.equal(resumed.body.token, undefined, 'no token goes to the browser');
  assert.deepEqual(done, [['resume', '0a1b2c3d', { text: 'Use the URL', by: 'console', why: 'console' }]]);
  const refused = await post(port, '/api/sessions/0a1b2c3d/delete', {});
  assert.deepEqual(refused, { status: 409, body: { error: 'stop the session first' } });
  assert.equal((await post(port, '/api/sessions/ffffffff/resume', {})).status, 404);
  assert.equal((await post(port, '/api/sessions/0a1b2c3d/resume', {}, { origin: 'https://evil.example' })).status, 403);
});

test('Console settings: a card\'s values and the channel saved together, refused out of bounds or cross-origin', async (t) => {
  const store = { state: {}, save() {} };
  const base = { maxRunning: 5, limits: { idleMs: 3_600_000, lifetimeMs: 8 * 3_600_000 } };
  const consoleSettings = createConsoleSettings({ store, config: base });
  const slack = createSlack({ store, secrets: { read: async () => null } });
  const cleaned = [];
  const heldData = { async report() { return { held: [], stalled: [], homesListed: true, totals: { databases: 0, homes: 0, homeBytes: 0 } }; }, async clean(args) { cleaned.push(args); } };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const handle = createHandler({ config, fleet: { sessions: () => [] }, slack, consoleSettings, heldData });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());

  const saved = await post(port, '/api/console-settings', { values: { slackGiveUpDays: 10 }, slackChannel: 'C0123456789' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.settings.find((x) => x.key === 'slackGiveUpDays').value, 10);
  assert.deepEqual(saved.body.slack, { channel: 'C0123456789', canPost: true });

  const bad = await post(port, '/api/console-settings', { values: { maxRunning: 50, idleHours: 2 }, slackChannel: '' });
  assert.deepEqual(bad, { status: 400, body: { error: 'Shared sessions running at once must be from 1 to 20 sessions.' } });
  assert.equal(store.state.settings.idleHours, undefined, 'nothing from a refused card is kept');
  assert.equal(store.state.settings.slackChannel, 'C0123456789', 'not even its channel');
  const name = await post(port, '/api/console-settings', { values: { idleHours: 2 }, slackChannel: '#dev-test' });
  assert.equal(name.status, 400);
  assert.equal(store.state.settings.idleHours, undefined);
  assert.equal((await post(port, '/api/console-settings', { values: { maxRunning: 6 } }, { origin: 'https://evil.example' })).status, 403);

  assert.equal((await post(port, '/api/console-settings/clean', { kind: 'all', id: 'aaaaaaaa' })).status, 400);
  assert.equal((await post(port, '/api/console-settings/clean', { kind: 'home', id: 'aaaaaaaa' })).status, 200);
  assert.deepEqual(cleaned, [{ kind: 'home', id: 'aaaaaaaa', by: 'console' }]);
});

test('Console settings: the Woodshed card reads, checks and starts an update, and says why one is refused', async (t) => {
  const calls = [];
  let refusal = null;
  const woodshedUpdate = {
    behindBy: () => 3,
    async view() { return { clone: '/srv/woodshed', behindBy: 3, job: calls.includes('update by console') ? { state: 'running' } : null }; },
    async check() { calls.push('check'); },
    async update({ by }) {
      calls.push(`update by ${by}`);
      if (refusal) throw Object.assign(new Error(refusal), { shown: true });
    },
  };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const handle = createHandler({ config, fleet: { sessions: () => [] }, woodshedUpdate });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());

  assert.deepEqual(JSON.parse(await getBody(port, '/api/console-settings/updates')), { clone: '/srv/woodshed', behindBy: 3, job: null });
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/me`)).json()).updates, 3, 'the menu counts the newer commits for an admin');
  assert.equal((await post(port, '/api/console-settings/updates/check', {})).status, 200);
  const started = await post(port, '/api/console-settings/updates/update', {});
  assert.equal(started.status, 202);
  assert.deepEqual(started.body.job, { state: 'running' });
  refusal = 'An update is already running.';
  assert.deepEqual(await post(port, '/api/console-settings/updates/update', {}), { status: 409, body: { error: refusal } });
  assert.equal((await post(port, '/api/console-settings/updates/update', {}, { origin: 'https://evil.example' })).status, 403);
  assert.deepEqual(calls, ['check', 'update by console', 'update by console']);

  const none = createHandler({ config, fleet: { sessions: () => [] }, woodshedUpdate: { ...woodshedUpdate, view: async () => null } });
  const noneServer = http.createServer((req, res) => { none(req, res); });
  const nonePort = await listen(noneServer);
  t.after(() => noneServer.close());
  assert.match(await getBody(nonePort, '/api/console-settings/updates'), /does not run from a git clone/);
});

test('Console settings: with no Woodshed update service, as an embedding program\'s woodshedUpdate: false, there is no card nor count', async (t) => {
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const handle = createHandler({ config, fleet: { sessions: () => [] }, woodshedUpdate: null });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());

  assert.equal((await fetch(`http://127.0.0.1:${port}/api/console-settings/updates`)).status, 404);
  assert.equal((await post(port, '/api/console-settings/updates/check', {})).status, 404);
  assert.equal((await post(port, '/api/console-settings/updates/update', {})).status, 404);
  const me = await (await fetch(`http://127.0.0.1:${port}/api/me`)).json();
  assert.equal('updates' in me, false, 'no dot on the avatar');
});

test('Console settings: a repo is added and removed on the page, with its sessions counted, and a refused one says why', async (t) => {
  const store = { state: { sessions: [] }, save() {} };
  const config = liveConfig({
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 }, projects: [{ name: 'r', repo: 'o/r', default: true }],
  }, store);
  const check = async (repo) => {
    if (repo === 'o/missing') throw Object.assign(new Error('The GitHub App is not installed on o/missing.'), { shown: true });
    if (repo === 'o/uninstalled') {
      throw Object.assign(new Error('The GitHub App is not installed on o/uninstalled.'), { shown: true, link: { href: 'https://github.com/apps/w/installations/new', text: 'Install w on GitHub' } });
    }
    return { installationId: null };
  };
  const addedProjects = createAddedProjects({ store, config, check });
  const forgotten = [];
  let failForget = false;
  const repoSettings = {
    forget: async (name) => {
      if (failForget) throw Object.assign(new Error(`1 of ${name}'s repo settings could not be deleted: the console log says why`), { shown: true, status: 502 });
      forgotten.push(name);
    },
  };
  const handle = createHandler({ config, fleet: { sessions: () => [] }, consoleSettings: createConsoleSettings({ store, config }), addedProjects, repoSettings });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());

  const added = await post(port, '/api/console-settings/projects', { repo: 'o/api' });
  assert.equal(added.status, 200);
  assert.deepEqual(added.body.projects.map((p) => [p.name, p.removable]), [['r', false], ['api', true]]);
  assert.deepEqual(config.projects.map((p) => p.name), ['r', 'api'], 'the live config has it, with no restart');
  assert.deepEqual(await post(port, '/api/console-settings/projects', { repo: 'o/missing' }), { status: 400, body: { error: 'The GitHub App is not installed on o/missing.' } });
  assert.deepEqual(await post(port, '/api/console-settings/projects', { repo: 'o/uninstalled' }), {
    status: 400, body: { error: 'The GitHub App is not installed on o/uninstalled.', link: { href: 'https://github.com/apps/w/installations/new', text: 'Install w on GitHub' } },
  }, 'the App\'s install page goes with the reason');
  assert.equal((await post(port, '/api/console-settings/projects', { repo: 'o/api' })).status, 400, 'twice');
  assert.equal((await post(port, '/api/console-settings/projects', { repo: 'o/x' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(port, '/api/console-settings/projects/remove', { name: 'r' })).status, 400, 'the installation\'s own stays');
  assert.deepEqual(forgotten, [], 'a refused removal keeps the settings');
  store.state.sessions.push({ id: 'live0001', repo: 'o/api', project: 'api', status: 'running' });
  const busy = await post(port, '/api/console-settings/projects/remove', { name: 'api' });
  assert.equal(busy.status, 400);
  assert.match(busy.body.error, /still running/);
  assert.deepEqual(forgotten, [], 'a repo with a live session keeps its settings');
  store.state.sessions.length = 0;
  failForget = true;
  const failed = await post(port, '/api/console-settings/projects/remove', { name: 'api' });
  assert.equal(failed.status, 502, 'a failed delete is said');
  assert.deepEqual(config.projects.map((p) => p.name), ['r', 'api'], 'and the repo stays, so Remove can be tried again');
  failForget = false;
  const removed = await post(port, '/api/console-settings/projects/remove', { name: 'api' });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.projects.map((p) => p.name), ['r']);
  assert.deepEqual(forgotten, ['api'], 'its repo settings go with it');
});

test('Console settings: Add a repo\'s list is the App\'s repos less the projects, null with no App, and a 502 when GitHub did not answer', async (t) => {
  const store = { state: { sessions: [] }, save() {} };
  const config = liveConfig({
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 }, projects: [{ name: 'r', repo: 'o/r', default: true }],
  }, store);
  let fail = false;
  const list = async () => {
    if (fail) throw Object.assign(new Error('GitHub did not list the App\'s repos.'), { shown: true });
    return { repos: [{ repo: 'o/R', private: true }, { repo: 'o/web', private: false }], grant: [{ account: 'o', href: 'https://github.com/settings/installations/1' }], install: null };
  };
  const serve = (addedProjects) => {
    const handle = createHandler({ config, fleet: { sessions: () => [] }, consoleSettings: createConsoleSettings({ store, config }), addedProjects });
    const server = http.createServer((req, res) => { handle(req, res); });
    t.after(() => server.close());
    return listen(server);
  };
  const port = await serve(createAddedProjects({ store, config, check: async () => ({ installationId: null }), list }));
  const ask = async (p) => {
    const res = await fetch(`http://127.0.0.1:${p}/api/console-settings/projects/repos`);
    return { status: res.status, body: await res.json() };
  };
  assert.deepEqual(await ask(port), { status: 200, body: { repos: [{ repo: 'o/web', private: false }], grant: [{ account: 'o', href: 'https://github.com/settings/installations/1' }], install: null } });
  fail = true;
  assert.deepEqual(await ask(port), { status: 502, body: { error: 'GitHub did not list the App\'s repos.' } });
  const noApp = await serve(createAddedProjects({ store, config, check: async () => ({ installationId: null }) }));
  assert.deepEqual(await ask(noApp), { status: 200, body: { repos: null, grant: [], install: null } });
});

test('Console settings: with an embedder\'s repos hook, its list is offered, an add and a removal go to it, and its refusal links to the fix', async (t) => {
  const store = { state: { sessions: [] }, save() { throw new Error('nothing of the repo list is the console\'s to save'); } };
  const hostProjects = createHostProjects();
  const config = liveConfig({
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 }, projects: [{ name: 'r', repo: 'o/r', default: true }],
  }, store, { hostProjects });
  const kept = ['o/r'];
  const grant = { account: 'o', href: 'https://github.com/organizations/o/settings/installations/9' };
  const repos = {
    names: false,
    list: async () => ({ repos: ['o/r', 'o/api', 'o/web'].filter((r) => !kept.includes(r)), grant: [grant], install: null }),
    async add({ repo }) {
      if (repo === 'o/secret') throw Object.assign(new Error('The App may not reach o/secret.'), { shown: true, link: { href: grant.href, text: 'Give the App access to o/secret on GitHub' } });
      kept.push(repo);
      return { name: repo.split('/')[1], repo };
    },
    async remove({ repo }) { kept.splice(kept.indexOf(repo), 1); },
  };
  const addedProjects = createAddedProjects({ store, config, check: async () => { throw new Error('not asked'); }, host: repos, hostProjects });
  const handle = createHandler({ config, fleet: { sessions: () => [] }, consoleSettings: createConsoleSettings({ store, config }), addedProjects });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());

  const page = JSON.parse(await getBody(port, '/api/console-settings'));
  assert.equal(page.repoNames, false, 'the page asks for no name');
  assert.deepEqual(page.projects.map((p) => [p.name, p.source, p.removable]), [['r', 'host', false]]);
  const choices = JSON.parse(await getBody(port, '/api/console-settings/projects/repos'));
  assert.deepEqual(choices, { repos: [{ repo: 'o/api', private: false }, { repo: 'o/web', private: false }], grant: [grant], install: null, via: 'host' });

  const added = await post(port, '/api/console-settings/projects', { repo: 'o/api' });
  assert.equal(added.status, 200);
  assert.deepEqual(added.body.projects.map((p) => [p.name, p.removable]), [['r', false], ['api', true]], 'the answer has it at once');
  assert.deepEqual(kept, ['o/r', 'o/api']);
  assert.deepEqual(await post(port, '/api/console-settings/projects', { repo: 'o/secret' }), {
    status: 400, body: { error: 'The App may not reach o/secret.', link: { href: grant.href, text: 'Give the App access to o/secret on GitHub' } },
  }, 'a typed repo the App cannot reach says where to give it access');
  assert.equal((await post(port, '/api/console-settings/projects/remove', { name: 'r' })).status, 400, 'the default stays');
  const removed = await post(port, '/api/console-settings/projects/remove', { name: 'api' });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.projects.map((p) => p.name), ['r']);
  assert.deepEqual(kept, ['o/r']);
});

test('Console settings: a repo\'s colour is picked from the palette, never one another repo has, and the rail gets it', async (t) => {
  const store = { state: { sessions: [], addedProjects: [{ name: 'web', repo: 'o/web', default: false }] }, save() {} };
  const config = liveConfig({
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 }, projects: [{ name: 'r', repo: 'o/r', default: true }, { name: 'api', repo: 'o/api', default: false }],
  }, store);
  const addedProjects = createAddedProjects({ store, config, check: async () => ({ installationId: null }) });
  const handle = createHandler({
    config, fleet: { sessions: () => [] }, consoleSettings: createConsoleSettings({ store, config }), addedProjects,
    projectColors: createProjectColors({ store, config }),
  });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());

  const page = JSON.parse(await getBody(port, '/api/console-settings'));
  assert.deepEqual(page.projects.map((p) => [p.name, p.color]), [['r', 'teal'], ['api', 'plum'], ['web', 'sienna']], 'the environment\'s repos and the added one, each a colour of its own');
  assert.deepEqual(page.palette, ['teal', 'plum', 'sienna', 'rose', 'violet', 'moss']);

  const picked = await post(port, '/api/console-settings/projects/color', { name: 'api', color: 'moss' });
  assert.equal(picked.status, 200);
  assert.deepEqual(picked.body.projects.map((p) => [p.name, p.color]), [['r', 'teal'], ['api', 'moss'], ['web', 'sienna']]);
  assert.deepEqual(await post(port, '/api/console-settings/projects/color', { name: 'web', color: 'teal' }), { status: 400, body: { error: 'r has teal already: pick another colour, or change r\'s first.' } });
  assert.equal((await post(port, '/api/console-settings/projects/color', { name: 'web', color: 'red' })).status, 400, 'not in the palette');
  assert.equal((await post(port, '/api/console-settings/projects/color', { name: 'gone', color: 'rose' })).status, 400, 'no such project');
  assert.equal((await post(port, '/api/console-settings/projects/color', { name: 'web', color: 'rose' }, { origin: 'https://evil.example' })).status, 403);

  const rail = JSON.parse(await getBody(port, '/api/sessions'));
  assert.deepEqual(rail.projects, [{ name: 'r', color: 'teal', default: true }, { name: 'api', color: 'moss', default: false }, { name: 'web', color: 'sienna', default: false }]);

  assert.equal((await post(port, '/api/console-settings/projects/remove', { name: 'web' })).status, 200);
  assert.deepEqual(store.state.projectColors, { r: 'teal', api: 'moss' }, 'a removed repo\'s colour is not kept for its name');
});

test('Console settings: a repo\'s own Slack channel, for the installation\'s repos and added ones, an admin\'s alone', async (t) => {
  const { createMembers } = await import('./members.mjs');
  const store = {
    state: {
      sessions: [],
      members: { 'mia-dev': { addedBy: null, addedAt: '2026-10-01T00:00:00.000Z', how: 'first to sign in', admin: true }, 'sam-ops': { addedBy: 'mia-dev', addedAt: '2026-10-02T00:00:00.000Z', how: 'invited' } },
      addedProjects: [{ name: 'api', repo: 'o/api', default: false, addedBy: 'mia-dev', addedAt: '2026-10-03T00:00:00.000Z' }],
    },
    save() {},
  };
  const members = createMembers({ store });
  const config = liveConfig({
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 }, projects: [{ name: 'r', repo: 'o/r', default: true }],
  }, store);
  const addedProjects = createAddedProjects({ store, config, check: async () => ({ installationId: null }) });
  const slack = createSlack({ store, secrets: { read: async () => null } });
  const auth = {
    enabled: () => true,
    available: () => true,
    sessionFor: async (cookie) => {
      const login = /woodshed_session=(\w[\w-]*)/.exec(String(cookie))?.[1];
      return members.isMember(login) ? { login } : null;
    },
  };
  // The repo's settings page reads its channel from its view; its records are not what this test is about.
  const repoSettings = { view: async (project) => ({ project, envFiles: [] }), forget: async () => {} };
  const handle = createHandler({ config, fleet: { sessions: () => [] }, auth, members, slack, consoleSettings: createConsoleSettings({ store, config }), addedProjects, repoSettings });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const mia = { cookie: 'woodshed_session=mia-dev' };
  const sam = { cookie: 'woodshed_session=sam-ops' };
  const path = '/api/console-settings/projects/slack-channel';
  const repoView = async (name, who = mia) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/console-settings/repos/${name}`, { headers: { host: `localhost:${port}`, ...who } });
    return { status: res.status, body: await res.json() };
  };

  assert.equal((await post(port, path, { name: 'api', channel: 'C0APIPRS01' }, sam)).status, 403, 'not an admin');
  assert.equal(store.state.settings?.projectSlackChannels, undefined, 'nothing kept from a refused call');
  const own = await post(port, path, { name: 'r', channel: 'C0ACMEPRS1' }, mia);
  assert.equal(own.status, 200, 'the installation\'s own repo');
  const added = await post(port, path, { name: 'api', channel: ' C0APIPRS01 ' }, mia);
  assert.deepEqual(added.body.projects.map((p) => [p.name, p.slackChannel]), [['r', 'C0ACMEPRS1'], ['api', 'C0APIPRS01']]);
  assert.deepEqual(added.body.slack, { channel: '', canPost: true }, 'the console\'s channel is left alone');
  const name = await post(port, path, { name: 'api', channel: '#acme-prs' }, mia);
  assert.equal(name.status, 400);
  assert.match(name.body.error, /channel's ID/, 'a name is refused as the console\'s channel is');
  assert.deepEqual(await post(port, path, { name: 'nope', channel: 'C0APIPRS01' }, mia), { status: 400, body: { error: 'There is no project called nope.' } });
  assert.equal((await post(port, path, { name: 'api', channel: 'C0APIPRS01' }, { ...mia, origin: 'https://evil.example' })).status, 403);
  assert.deepEqual((await repoView('api')).body.slack, { channel: 'C0APIPRS01', consoleChannel: '', canPost: true }, 'the repo\'s settings page reads it with its view');
  assert.equal((await repoView('api', sam)).status, 403);
  const cleared = await post(port, path, { name: 'r', channel: '' }, mia);
  assert.deepEqual(cleared.body.projects.map((p) => p.slackChannel), ['', 'C0APIPRS01'], 'empty goes back to the console\'s channel');
  await post(port, '/api/console-settings/projects/remove', { name: 'api' }, mia);
  assert.deepEqual(store.state.settings.projectSlackChannels, {}, 'a removed repo\'s channel goes with it');
});

test('Console settings: a repo\'s label and its switches for labels and comments, an admin\'s alone', async (t) => {
  const { createMembers } = await import('./members.mjs');
  const { createRepoTriggers } = await import('./repoTriggers.mjs');
  const store = {
    state: {
      sessions: [],
      members: { 'mia-dev': { addedBy: null, addedAt: '2026-10-01T00:00:00.000Z', how: 'first to sign in', admin: true }, 'sam-ops': { addedBy: 'mia-dev', addedAt: '2026-10-02T00:00:00.000Z', how: 'invited' } },
      addedProjects: [{ name: 'api', repo: 'o/api', default: false, addedBy: 'mia-dev', addedAt: '2026-10-03T00:00:00.000Z' }],
    },
    save() {},
  };
  const members = createMembers({ store });
  const config = liveConfig({
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 }, projects: [{ name: 'r', repo: 'o/r', default: true }],
  }, store);
  const addedProjects = createAddedProjects({ store, config, check: async () => ({ installationId: null }) });
  const auth = {
    enabled: () => true,
    available: () => true,
    sessionFor: async (cookie) => {
      const login = /woodshed_session=(\w[\w-]*)/.exec(String(cookie))?.[1];
      return members.isMember(login) ? { login } : null;
    },
  };
  const repoTriggers = createRepoTriggers({ store, config, qaLabelOf: async (name) => (name === 'api' ? 'qa' : null) });
  const repoSettings = { view: async (project) => ({ project, envFiles: [] }), forget: async () => {} };
  const fleet = { sessions: () => [] };
  const handle = createHandler({ config, fleet, auth, members, consoleSettings: createConsoleSettings({ store, config }), addedProjects, repoSettings, repoTriggers });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const mia = { cookie: 'woodshed_session=mia-dev' };
  const sam = { cookie: 'woodshed_session=sam-ops' };
  const path = '/api/console-settings/projects/triggers';
  const repoView = async (name, who = mia) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/console-settings/repos/${name}`, { headers: { host: `localhost:${port}`, ...who } });
    return { status: res.status, body: await res.json() };
  };

  assert.deepEqual((await repoView('api')).body.triggers, { label: 'woodshed', labels: true, comments: true, labelSet: false, consoleLabel: 'woodshed' });
  assert.equal((await post(port, path, { name: 'api', labels: false }, sam)).status, 403, 'not an admin');
  assert.equal(store.state.repoTriggers, undefined, 'nothing kept from a refused call');
  const saved = await post(port, path, { name: 'api', label: 'agent', comments: false }, mia);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.triggers, { label: 'agent', labels: true, comments: false, labelSet: true, consoleLabel: 'woodshed' });
  assert.equal((await post(port, path, { name: 'api', label: 'QA' }, mia)).status, 400, 'the repo\'s QA label');
  assert.deepEqual(await post(port, path, { name: 'nope', labels: false }, mia), { status: 400, body: { error: 'There is no project called nope.' } });
  assert.equal((await post(port, path, { name: 'r', labels: false }, { ...mia, origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(port, path, { name: 'r', labels: false }, mia)).status, 200, 'the installation\'s own repo');
  assert.equal((await repoView('api', sam)).status, 403);
  const sessions = await (await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { host: `localhost:${port}`, ...mia } })).json();
  assert.deepEqual(sessions.projects.map((p) => [p.name, p.label]), [['r', 'woodshed'], ['api', 'agent']], 'each session names its repo\'s label');
  await post(port, '/api/console-settings/projects/remove', { name: 'api' }, mia);
  assert.equal(store.state.repoTriggers.api, undefined, 'a removed repo\'s settings go with it');
});

test('the switch for shared sessions is set for the signed-in person alone, behind the same write checks', async (t) => {
  const done = [];
  const userSettings = {
    view: () => ({ claudeToken: { set: true, savedAt: null }, ownTokenForShared: done.at(-1)?.[1] ?? false, setUp: true, available: true }),
    setOwnTokenForShared(login, on) {
      if (login === 'nobody') throw Object.assign(new Error('save your Claude token first'), { shown: true });
      done.push([login, on]);
    },
  };
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => ({ login: /woodshed_session=([\w-]+)/.exec(cookie)[1] }) };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth, userSettings });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = { cookie: 'woodshed_session=mia-dev' };

  const on = await post(port, '/api/my/claude-token/shared', { on: true, login: 'joel' }, as);
  assert.equal(on.status, 200);
  assert.equal(on.body.ownTokenForShared, true);
  assert.deepEqual(done, [['mia-dev', true]], 'the body cannot say whose it is');
  assert.equal((await post(port, '/api/my/claude-token/shared', { on: 'yes' }, as)).status, 400);
  assert.equal((await post(port, '/api/my/claude-token/shared', { on: true }, { ...as, origin: 'https://evil.example' })).status, 403);
  assert.deepEqual(await post(port, '/api/my/claude-token/shared', { on: true }, { cookie: 'woodshed_session=nobody' }),
    { status: 409, body: { error: 'save your Claude token first' } });
  assert.equal(done.length, 1);
});

test('the switch for reviews on your own Codex sign-in is set for the signed-in person alone', async (t) => {
  const done = [];
  const userSettings = {
    view: () => ({ claudeToken: { set: false, savedAt: null }, codexAuth: { set: true, savedAt: null }, ownCodexForReviews: done.at(-1)?.[1] ?? false, setUp: true, available: true }),
    setOwnCodexForReviews(login, on) {
      if (login === 'nobody') throw Object.assign(new Error('save your Codex sign-in first'), { shown: true });
      done.push([login, on]);
    },
  };
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => ({ login: /woodshed_session=([\w-]+)/.exec(cookie)[1] }) };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth, userSettings });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = { cookie: 'woodshed_session=mia-dev' };

  const on = await post(port, '/api/my/codex-auth/reviews', { on: true, login: 'joel' }, as);
  assert.equal(on.status, 200);
  assert.equal(on.body.ownCodexForReviews, true);
  assert.deepEqual(done, [['mia-dev', true]], 'the body cannot say whose it is');
  assert.equal((await post(port, '/api/my/codex-auth/reviews', { on: 'yes' }, as)).status, 400);
  assert.equal((await post(port, '/api/my/codex-auth/reviews', { on: true }, { ...as, origin: 'https://evil.example' })).status, 403);
  assert.deepEqual(await post(port, '/api/my/codex-auth/reviews', { on: true }, { cookie: 'woodshed_session=nobody' }),
    { status: 409, body: { error: 'save your Codex sign-in first' } });
});

test('a manual start is the signed-in person\'s, whatever login the body names', async (t) => {
  const started = [];
  const fleet = { sessions: () => [], async startManual(args) { started.push(args); return { id: '0a1b2c3d', status: 'queued', title: 't' }; } };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => (/woodshed_session=mallory/.test(String(cookie)) ? { login: 'mallory' } : null) };
  const handle = createHandler({ config, fleet, auth });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  assert.equal((await post(port, '/api/sessions', { number: 123, startedBy: 'joel' }, { cookie: 'woodshed_session=mallory' })).status, 201);
  assert.equal(started[0].startedBy, 'mallory');
});

test('the pages get the display name of each handle they show: the signed-in person, starters and plans, webhook senders', async (t) => {
  const shared = { id: '0a1b2c3d', status: 'running', title: 't', startedBy: 'joel', plan: 'joel' };
  const other = { id: '1a1b2c3d', status: 'stopped', title: 't', startedBy: 'nameless' };
  const fleet = { sessions: () => [shared, other] };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const auth = { enabled: () => true, available: () => true, sessionFor: async () => ({ login: 'mia-dev' }) };
  const asked = [];
  const people = {
    names(logins) {
      const list = [...logins];
      asked.push(list);
      const known = { joel: 'Mona Octocat', 'mia-dev': 'Mia', octo: 'Octo Cat' };
      return Object.fromEntries(list.filter((l) => known[l]).map((l) => [l, known[l]]));
    },
  };
  const events = { list: () => [{ login: 'octo' }] };
  const handle = createHandler({ config, fleet, auth, people, events });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const get = async (path) => (await fetch(`http://127.0.0.1:${port}${path}`, { headers: { cookie: 'woodshed_session=x' } })).json();

  assert.deepEqual((await get('/api/sessions')).names, { 'mia-dev': 'Mia', joel: 'Mona Octocat' });
  assert.ok(asked.at(-1).includes('nameless'), 'a handle with no name is asked too, so a name set later shows');
  assert.deepEqual((await get('/api/me')).names, { 'mia-dev': 'Mia' });
  assert.deepEqual((await get('/api/webhook-events')).names, { octo: 'Octo Cat' });
});

test('Console settings turns each source\'s webhooks off and on, says who did, and whether any reach the console', async (t) => {
  const { createWebhookSwitch } = await import('./webhookSwitch.mjs');
  const store = { state: {}, save() {} };
  const webhookSwitch = createWebhookSwitch({ store });
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const handle = createHandler({ config, fleet: { sessions: () => [] }, webhookSwitch, asks: { names: () => ({}) }, consoleSettings: createConsoleSettings({ store, config }) });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const get = async () => (await fetch(`http://127.0.0.1:${port}/api/webhook-events`)).json();

  assert.equal((await get()).queue, false, 'nothing said webhooks arrive');
  webhookSwitch.receiving('delivered');
  const before = await get();
  assert.equal(before.queue, true, 'a console its host hands webhooks to says so, with no queue of its own');
  assert.equal(before.webhooks.github.off, false);
  assert.equal(before.webhooks.slack.off, false);
  const off = await post(port, '/api/console-settings/webhooks', { source: 'slack', off: true });
  assert.equal(off.status, 200);
  assert.equal(off.body.webhooks.slack.off, true);
  assert.equal(off.body.webhooks.slack.by, 'console');
  assert.equal(off.body.webhooks.github.off, false);
  assert.equal(webhookSwitch.off('slack'), true);
  assert.equal((await post(port, '/api/console-settings/webhooks', { source: 'github', off: 'please' })).status, 400);
  assert.equal((await post(port, '/api/console-settings/webhooks', { off: true })).status, 400, 'a source is named');
  assert.equal((await post(port, '/api/console-settings/webhooks', { source: 'github', off: true })).body.webhooks.github.off, true);
  const settingsPage = await (await fetch(`http://127.0.0.1:${port}/api/console-settings`)).json();
  assert.deepEqual([settingsPage.webhooks.receiving, settingsPage.webhooks.github.off, settingsPage.webhooks.slack.off], [true, true, true], 'Console settings shows the switches');
  assert.equal((await get()).webhooks.github.off, true, 'and Webhook events says what is off');
});

test('My settings\' Reviews card: each person picks who reviews their pull requests, from what can run for them', async (t) => {
  const { createReviewAgents } = await import('./reviewAgents.mjs');
  const { createUserSettings } = await import('./userSettings.mjs');
  const secrets = { values: new Map(), async read(n) { return this.values.get(n) ?? null; }, async write(n, v) { this.values.set(n, v); }, async save(n, v) { this.values.set(n, v); }, async remove(n) { this.values.delete(n); }, async list() { return [...this.values.keys()]; } };
  const userSettings = createUserSettings({ store: { state: {}, save() {} }, secrets });
  const reviewAgents = createReviewAgents({ userSettings, connected: async () => ({ claude: true, codex: false }) });
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => ({ login: /woodshed_session=([\w-]+)/.exec(cookie)[1] }) };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth, userSettings, reviewAgents });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = { cookie: 'woodshed_session=mia-dev' };
  const get = async () => (await fetch(`http://127.0.0.1:${port}/api/my/reviews`, { headers: as })).json();

  const off = { grok: false, opencode: false };
  assert.deepEqual(await get(), { available: { claude: true, codex: false, ...off }, own: { claude: false, codex: false, ...off }, ownWhy: { grok: null, opencode: null }, best: 'claude', expanded: true, choice: null, models: {}, modelDefaults: { claude: 'opus' }, claudeModels: ['opus', 'sonnet', 'haiku', 'fable'] },
    'the team Anthropic key alone: Claude Code is the most there is');
  const none = await post(port, '/api/my/reviews', { choice: 'none', login: 'joel' }, as);
  assert.equal(none.status, 200);
  assert.equal(none.body.choice, 'none');
  assert.equal(userSettings.reviewAgents('mia-dev'), 'none', 'the body cannot say whose it is');
  assert.equal(userSettings.reviewAgents('joel'), null);
  assert.equal((await post(port, '/api/my/reviews', { choice: 'everyone' }, as)).status, 400);
  assert.equal((await post(port, '/api/my/reviews', { choice: null }, as)).body.choice, null, 'back to the default');
  assert.equal((await post(port, '/api/my/reviews', { choice: 'both' }, { ...as, origin: 'https://evil.example' })).status, 403);

  // Grok Build reviews only on the person's own sign-in, switched on for reviews: offered once one is saved.
  assert.equal((await post(port, '/api/my/agent-auth/grok/reviews', { on: true }, as)).status, 409, 'no sign-in saved yet');
  assert.equal((await post(port, '/api/my/agent-auth/grok', { value: 'xai-made-up-mia-0123456789' }, as)).status, 200);
  const withGrok = await get();
  assert.deepEqual([withGrok.available.grok, withGrok.own.grok, withGrok.choice, withGrok.best], [true, true, null, 'claude+grok'], 'the default includes Grok Build once its sign-in is on for reviews');
  const picked = await post(port, '/api/my/reviews', { choice: 'grok+claude' }, as);
  assert.equal(picked.body.choice, 'claude+grok');
  const offNow = await post(port, '/api/my/agent-auth/grok/reviews', { on: false }, as);
  assert.deepEqual([offNow.status, offNow.body.ownAgentForReviews.grok, (await get()).available.grok], [200, false, false]);
  assert.equal((await post(port, '/api/my/agent-auth/claude/reviews', { on: true }, as)).status, 404, 'Claude Code has no own sign-in here');
});

test('My settings\' Agent terminal: each person picks tmux or Herdr for their own private sessions, tmux by default', async (t) => {
  const { createUserSettings } = await import('./userSettings.mjs');
  const secrets = { values: new Map(), async read(n) { return this.values.get(n) ?? null; }, async write(n, v) { this.values.set(n, v); }, async remove(n) { this.values.delete(n); }, async list() { return [...this.values.keys()]; } };
  const userSettings = createUserSettings({ store: { state: {}, save() {} }, secrets });
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => ({ login: /woodshed_session=([\w-]+)/.exec(cookie)[1] }) };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth, userSettings });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = { cookie: 'woodshed_session=mia-dev' };

  assert.equal(userSettings.view('mia-dev').terminal, 'tmux', 'nothing picked: tmux, as every session');
  const herdr = await post(port, '/api/my/terminal', { terminal: 'herdr', login: 'joel' }, as);
  assert.deepEqual([herdr.status, herdr.body], [200, { terminal: 'herdr' }]);
  assert.equal(userSettings.terminal('mia-dev'), 'herdr', 'the body cannot say whose it is');
  assert.equal(userSettings.terminal('joel'), 'tmux');
  assert.equal(userSettings.view('mia-dev').terminal, 'herdr', 'My settings shows it');
  assert.equal((await post(port, '/api/my/terminal', { terminal: 'screen' }, as)).status, 400);
  assert.equal((await post(port, '/api/my/terminal', {}, as)).status, 400);
  assert.equal((await post(port, '/api/my/terminal', { terminal: 'tmux' }, { ...as, origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(port, '/api/my/terminal', { terminal: 'tmux' }, as)).body.terminal, 'tmux', 'back to tmux');
  assert.equal(userSettings.terminal('mia-dev'), 'tmux');
});

test('a console that borrows its GitHub access shows no webhook switches, unless its host delivers webhooks', async (t) => {
  const { createWebhookSwitch } = await import('./webhookSwitch.mjs');
  const base = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 }, webhookQueue: 'https://sqs.example/queue',
  };
  async function webhooksOf(config, setUp = () => {}) {
    const store = { state: {}, save() {} };
    const webhookSwitch = createWebhookSwitch({ store });
    setUp(webhookSwitch);
    const handle = createHandler({ config, fleet: { sessions: () => [] }, webhookSwitch, consoleSettings: createConsoleSettings({ store, config }) });
    const server = http.createServer((req, res) => { handle(req, res); });
    const port = await listen(server);
    t.after(() => server.close());
    const settings = await (await fetch(`http://127.0.0.1:${port}/api/console-settings`)).json();
    const events = await (await fetch(`http://127.0.0.1:${port}/api/webhook-events`)).json();
    return { settings: settings.webhooks, queue: events.queue };
  }

  const own = await webhooksOf(base);
  assert.equal(own.settings.receiving, true, 'a queue with no broker is read once the App key loads');
  const borrowed = await webhooksOf({ ...base, githubBroker: { url: 'https://host.example' } });
  assert.equal(borrowed.settings.receiving, false, 'a broker console never reads its queue, so the card hides its switches');
  assert.equal(borrowed.queue, false, 'and Webhook events says no webhooks reach it');
  const delivered = await webhooksOf({ ...base, githubBroker: { url: 'https://host.example' } }, (sw) => sw.receiving('delivered'));
  assert.equal(delivered.settings.receiving, true, 'one its host hands webhooks to still shows them');
  const offBefore = await webhooksOf({ ...base, githubBroker: { url: 'https://host.example' } }, (sw) => sw.set({ source: 'github', off: true, by: 'joel' }));
  assert.equal(offBefore.settings.github.off, true, 'a switch already off is still there to turn back on');
});

test('Remove on a private session acts for the signed-in person, from the console\'s own origin', async (t) => {
  const removed = [];
  const fleet = { sessions: () => [], async removePrivateSession(args) { removed.push(args); } };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => (/woodshed_session=joel/.test(String(cookie)) ? { login: 'joel' } : null) };
  const handle = createHandler({ config, fleet, auth });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = { cookie: 'woodshed_session=joel' };
  const answer = await post(port, '/api/my/sessions/0a1b2c3d/remove', { owner: 'mia' }, as);
  assert.deepEqual([answer.status, answer.body], [200, { removed: '0a1b2c3d' }]);
  assert.deepEqual(removed, [{ owner: 'joel', id: '0a1b2c3d' }], 'the body cannot say whose');
  assert.equal((await post(port, '/api/my/sessions/0a1b2c3d/remove', {}, { ...as, origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(port, '/api/my/sessions/0a1b2c3d/remove', {})).status, 401);
  assert.equal(removed.length, 1);
});

// The phone's message box: its text reaches the session's statusd as one /send, and its files are saved untyped.
test('the message box types its text into the owner\'s session, and its files are saved without typing their path', async (t) => {
  const seen = [];
  const statusd = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(req.url.startsWith('/upload') ? '{"path":"/tmp/uploads/1-shot.png","bytes":3}' : '{"ok":true}');
    });
  });
  const statusPort = await listen(statusd);
  t.after(() => statusd.close());
  const mine = { id: '3f9a1c20', status: 'running', safeSend: true, title: 'mine', owner: 'octocat', startedBy: 'octocat', token: 'tok', terminalToken: 'tt', endpoint: { host: '127.0.0.1', termPort: 1, statusPort, shellPort: 1 } };
  // The fleet sends it, or holds it in the session's saved pendingMessages while the agent is busy (fleet.mjs).
  const sent = [];
  let outcome = 'sent';
  const ids = [];
  const fleet = { sessions: () => [mine], find: (id) => (id === mine.id ? mine : null), send: async (session, text, opts) => { sent.push({ id: session.id, text }); ids.push(opts?.id); return outcome; } };
  const auth = { enabled: () => true, available: () => true, sessionFor: async () => ({ login: 'octocat' }) };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const server = http.createServer(createHandler({ config, fleet, auth }));
  const port = await listen(server);
  t.after(() => server.close());
  const headers = { cookie: 'woodshed_session=x', 'x-woodshed': '1', origin: `http://localhost:${port}` };
  const post = (path, body, type) => fetch(`http://localhost:${port}${path}`, { method: 'POST', headers: { ...headers, 'content-type': type }, body });

  const text = 'Both. Polling for the watcher\n\nand the app only on Start app';
  const first = await post(`/api/sessions/${mine.id}/send`, JSON.stringify({ text }), 'application/json');
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, held: false });
  assert.deepEqual(sent, [{ id: mine.id, text }], 'the whole text, newlines kept, as one message, through the fleet');
  assert.match(ids[0], /^[0-9a-f-]{36}$/, 'a message with no id of the page\'s (the phone\'s box) gets one: it is a person\'s');
  await post(`/api/sessions/${mine.id}/send`, JSON.stringify({ text: 'mine', id: 'page-id-0042' }), 'application/json');
  assert.equal(ids[1], 'page-id-0042');
  sent.pop();
  ids.pop();
  outcome = 'queued';
  assert.deepEqual(await (await post(`/api/sessions/${mine.id}/send`, JSON.stringify({ text: 'later' }), 'application/json')).json(), { ok: true, held: true }, 'held while the agent is busy');
  // A statusd from before the guarded send types blind: the page's message is refused, not typed or held, and not
  // passed to the fleet.
  mine.safeSend = false;
  const blind = await post(`/api/sessions/${mine.id}/send`, JSON.stringify({ text: 'yes do it' }), 'application/json');
  assert.equal(blind.status, 409);
  assert.match((await blind.json()).error, /started before Chat could send safely: type it in the TUI tab/);
  assert.equal(sent.length, 2, 'never reached the fleet');
  // Not read since the console started: said as not known yet, not as an old session.
  delete mine.safeSend;
  const unread = await post(`/api/sessions/${mine.id}/send`, JSON.stringify({ text: 'yes do it' }), 'application/json');
  assert.equal(unread.status, 409);
  assert.match((await unread.json()).error, /has not read this session since it started: try again in a few seconds/);
  assert.equal(sent.length, 2);
  mine.safeSend = true;
  // No answer in time: it may have gone in, said as not known.
  outcome = 'unknown';
  assert.deepEqual(await (await post(`/api/sessions/${mine.id}/send`, JSON.stringify({ text: 'maybe' }), 'application/json')).json(), { ok: true, held: false, unknown: true });
  // Typed with no Enter, a prompt having come up: not sent, said so, for the page not to put it back in its own box.
  outcome = 'in-box';
  const inBox = await post(`/api/sessions/${mine.id}/send`, JSON.stringify({ text: 'boxed' }), 'application/json');
  assert.equal(inBox.status, 409);
  const said = await inBox.json();
  assert.equal(said.typed, true);
  assert.match(said.error, /not sent/);

  assert.equal((await post(`/api/sessions/${mine.id}/send`, '{"text":"  "}', 'application/json')).status, 400);
  // Over statusd's own limit: said now, never queued to fail and hold every message behind it.
  const long = await post(`/api/sessions/${mine.id}/send`, JSON.stringify({ text: 'x'.repeat(8001) }), 'application/json');
  assert.equal(long.status, 400);
  assert.match((await long.json()).error, /at most 8000 characters/);
  assert.equal(sent.length, 4, 'nothing to send, or too much, reaches nothing');
  assert.equal(seen.length, 0, 'the page never types into statusd itself');

  const up = await post(`/api/sessions/${mine.id}/upload?name=shot.png&pane=none`, 'png', 'application/octet-stream');
  assert.equal((await up.json()).path, '/tmp/uploads/1-shot.png');
  assert.equal(seen[0].url, '/upload?name=shot.png', 'no pane, so statusd types nothing');
  await post(`/api/sessions/${mine.id}/upload?name=shot.png`, 'png', 'application/octet-stream');
  assert.equal(seen[1].url, '/upload?name=shot.png&pane=agent', 'a paste on the terminal still types its path, as before');
});

test('a member links a member to a Slack user on the People page, and the page lists the link', async (t) => {
  const { createMembers } = await import('./members.mjs');
  const { createSlackPeople } = await import('./slackPeople.mjs');
  const store = {
    state: { members: { 'mia-dev': { addedBy: null, addedAt: '2026-10-01T00:00:00.000Z', how: 'first to sign in', admin: true } } }, save() {},
  };
  const members = createMembers({ store });
  const slack = {
    person: async (id) => (id === 'U01ANA00001' ? { id, name: 'Ana K', reachable: true } : null),
    search: async (q) => (q === 'ana' ? { found: [{ id: 'U01ANA00001', name: 'Ana K', handle: 'ana' }], truncated: false } : null),
  };
  const slackPeople = createSlackPeople({ store, slack });
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const auth = {
    enabled: () => true,
    available: () => true,
    sessionFor: async (cookie) => (/mia-dev/.test(String(cookie)) ? { login: 'mia-dev' } : null),
    visitorFor: async () => null,
  };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth, members, slackPeople });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const mia = { cookie: 'woodshed_session=mia-dev' };

  const before = await (await fetch(`http://127.0.0.1:${port}/api/people`, { headers: mia })).json();
  assert.deepEqual(before.slack, {}, 'nobody linked yet');
  const bad = await post(port, '/api/people/slack', { login: 'mia-dev', slack: 'U0NOSUCH999' }, mia);
  assert.equal(bad.status, 400, 'an ID Slack does not know is refused');
  assert.equal((await post(port, '/api/people/slack', { login: 'nobody', slack: 'U01ANA00001' }, mia)).status, 404, 'only members are linked');
  const ok = await post(port, '/api/people/slack', { login: 'mia-dev', slack: 'U01ANA00001' }, mia);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.slack, { 'mia-dev': { slackId: 'U01ANA00001', name: 'Ana K', how: 'manual' } });
  assert.equal(slackPeople.slackUserFor('mia-dev'), 'U01ANA00001');
  const searched = await (await fetch(`http://127.0.0.1:${port}/api/people/slack-search?q=ana`, { headers: mia })).json();
  assert.deepEqual(searched.found, [{ id: 'U01ANA00001', name: 'Ana K', handle: 'ana' }]);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/people/slack-search?q=zzz`, { headers: mia })).status, 400, 'Slack refusing is said, not shown as no matches');
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/people/slack-search?q=ana`)).status, 401, 'a visitor cannot list the workspace');
  assert.equal((await post(port, '/api/people/slack', { login: 'mia-dev', slack: 'U01ANA00001' }, {})).status, 401);
});

test('an admin turns on sessions from GitHub, then Can be assigned, and only then is a shared session seen and assigned', async (t) => {
  const { createMembers } = await import('./members.mjs');
  const store = { state: { members: { 'mia-dev': { addedBy: null, addedAt: '2026-10-01T00:00:00.000Z', how: 'first to sign in', admin: true }, 'sam-ops': { addedBy: 'mia-dev', addedAt: '2026-10-02T00:00:00.000Z', how: 'invited' } } }, save() {} };
  const members = createMembers({ store });
  const shared = { id: '0a1b2c3d', owner: null, kind: 'issue', status: 'running', title: 'shared', startedBy: 'sam-ops' };
  const theirs = { id: '1b2c3d4e', owner: 'sam-ops', kind: 'task', status: 'running', title: 'private', startedBy: 'sam-ops' };
  const assigned = [];
  const released = [];
  const fleet = {
    releaseAssignments: (args) => { released.push(args); },
    sessions: () => [shared, theirs],
    find: (id) => [shared, theirs].find((s) => s.id === id) ?? null,
    assign: ({ id, by, to }) => {
      if (!members.isAssignable(by)) throw Object.assign(new Error('only someone who can be assigned sessions can assign one'), { shown: true });
      assigned.push({ id, by, to });
    },
  };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
  };
  const auth = {
    enabled: () => true,
    available: () => true,
    sessionFor: async (cookie) => (/mia-dev/.test(String(cookie)) ? { login: 'mia-dev' } : null),
    visitorFor: async () => null,
  };
  const handle = createHandler({ config, fleet, auth, members });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const mia = { cookie: 'woodshed_session=mia-dev' };

  const hidden = await (await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: mia })).json();
  assert.deepEqual([hidden.sessions.length, hidden.shared], [0, false], 'without sessions from GitHub no shared session is listed, and there is no Everyone');
  assert.equal((await post(port, `/api/sessions/${shared.id}/assign`, { to: 'mia-dev' }, mia)).status, 404, 'nor found by its id');
  assert.equal((await getWith(port, `/api/sessions/${shared.id}/review`, mia)).status, 404);
  assert.equal((await post(port, '/api/sessions', { number: 7 }, mia)).status, 403, 'nor started from the console');
  const early = await post(port, '/api/people/assignable', { login: 'mia-dev', on: true }, mia);
  assert.deepEqual([early.status, early.body.error], [409, '@mia-dev needs sessions from GitHub first']);
  assert.equal((await post(port, '/api/people/github-sessions', { login: 'mia-dev', on: 'yes' }, mia)).status, 400, 'on or off, not a word');
  assert.equal((await post(port, '/api/people/github-sessions', { login: 'nobody', on: true }, mia)).status, 409, 'only members');
  const github = await post(port, '/api/people/github-sessions', { login: 'mia-dev', on: true }, mia);
  assert.equal(github.status, 200);
  assert.equal(github.body.members.find((m) => m.login === 'mia-dev').githubSessions, true);

  const notYet = await post(port, `/api/sessions/${shared.id}/assign`, { to: 'mia-dev' }, mia);
  assert.equal(notYet.status, 409, 'seen now, but not someone who can be assigned');
  assert.match(notYet.body.error, /only someone who can be assigned/);
  const on = await post(port, '/api/people/assignable', { login: 'mia-dev', on: true }, mia);
  assert.equal(on.status, 200);
  assert.equal(on.body.members.find((m) => m.login === 'mia-dev').assignable, true);

  const listed = await (await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: mia })).json();
  assert.deepEqual([listed.assignables, listed.assignable, listed.shared, listed.sessions.length], [['mia-dev'], true, true, 1], 'the rail learns who may be assigned, whether you are one, and that Everyone shows');
  assert.equal(listed.onePerson, false, 'two people on the list: Mine and Everyone');
  const sam = store.state.members['sam-ops'];
  delete store.state.members['sam-ops'];
  const alone = await (await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: mia })).json();
  assert.equal(alone.onePerson, true, 'one person on the list: one list of every session');
  store.state.members['sam-ops'] = sam;

  assert.equal((await post(port, `/api/sessions/${shared.id}/assign`, { to: 'mia-dev' }, mia)).status, 200);
  assert.equal((await post(port, `/api/sessions/${shared.id}/assign`, { to: null }, mia)).status, 200, 'null unassigns');
  assert.equal((await post(port, `/api/sessions/${shared.id}/assign`, { to: 5 }, mia)).status, 400);
  assert.equal((await post(port, `/api/sessions/${theirs.id}/assign`, { to: 'mia-dev' }, mia)).status, 404, 'a private session is not even found');
  assert.equal((await post(port, `/api/sessions/${shared.id}/assign`, { to: 'mia-dev' }, {})).status, 401);
  assert.deepEqual(assigned, [{ id: shared.id, by: 'mia-dev', to: 'mia-dev' }, { id: shared.id, by: 'mia-dev', to: null }]);

  const off = await post(port, '/api/people/github-sessions', { login: 'mia-dev', on: false }, mia);
  assert.equal(off.status, 200);
  assert.equal(members.isAssignable('mia-dev'), false, 'off for GitHub is off for Can be assigned');
  assert.equal((await post(port, '/api/people/remove', { login: 'sam-ops' }, mia)).status, 200);
  assert.deepEqual(released, [{ login: 'mia-dev', by: 'mia-dev' }, { login: 'sam-ops', by: 'mia-dev' }], 'turning it off, or removing a member, gives their sessions back');

  assert.equal((await post(port, '/api/people/admin', { login: 'mia-dev', admin: 'yes' }, mia)).status, 400, 'Admin is on or off, not a word');
  assert.equal((await post(port, '/api/people/admin', { login: 'nobody', admin: true }, mia)).status, 409, 'only members can be admins');
  const admin = await post(port, '/api/people/admin', { login: 'mia-dev', admin: true }, mia);
  assert.equal(admin.status, 200);
  assert.equal(admin.body.members.find((m) => m.login === 'mia-dev').admin, true);
  assert.equal((await post(port, '/api/people/admin', { login: 'mia-dev', admin: true }, {})).status, 401);
});

test('a People role sets the three switches at once, and reads back from them; an invite may name one', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { createMembers } = await import('./members.mjs');
  const store = { state: { members: { 'mia-dev': { addedBy: null, addedAt: '2026-10-01T00:00:00.000Z', how: 'first to sign in', admin: true }, 'sam-ops': { addedBy: 'mia-dev', addedAt: '2026-10-02T00:00:00.000Z', how: 'invited' } } }, save() {} };
  const members = createMembers({ store });
  const released = [];
  const fleet = { releaseAssignments: (args) => { released.push(args); }, sessions: () => [], find: () => null };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => (/mia-dev/.test(String(cookie)) ? { login: 'mia-dev' } : null), visitorFor: async () => null };
  const handle = createHandler({ config, fleet, auth, members });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const mia = { cookie: 'woodshed_session=mia-dev' };
  const switches = (body, login) => {
    const m = body.members.find((x) => x.login === login);
    return [m.access, Boolean(m.admin), Boolean(m.githubSessions), Boolean(m.assignable), m.accessDiffers];
  };

  const listed = await (await fetch(`http://127.0.0.1:${port}/api/people`, { headers: mia })).json();
  assert.deepEqual(listed.roles.map((r) => r.id), ['owner', 'member', 'contributor', 'private']);
  assert.ok(listed.roles.every((r) => r.label && r.explain), 'each role comes with what it gives');
  assert.deepEqual(switches(listed, 'sam-ops'), ['private', false, false, false, null], 'every switch off reads as Private only');
  assert.deepEqual(switches(listed, 'mia-dev'), ['owner', true, false, false, 'Opens these settings pages, no sessions from GitHub, never assigned a shared session'],
    'an admin from before roles is an Owner, and says what it lacks');

  const member = await post(port, '/api/people/access', { login: 'sam-ops', access: 'member' }, mia);
  assert.deepEqual(switches(member.body, 'sam-ops'), ['member', false, true, true, null]);
  const contributor = await post(port, '/api/people/access', { login: 'sam-ops', access: 'contributor' }, mia);
  assert.deepEqual(switches(contributor.body, 'sam-ops'), ['contributor', false, true, false, null]);
  assert.deepEqual(released, [{ login: 'sam-ops', by: 'mia-dev' }], 'no longer assignable: their shared sessions go back');
  const owner = await post(port, '/api/people/access', { login: 'sam-ops', access: 'owner' }, mia);
  assert.deepEqual(switches(owner.body, 'sam-ops'), ['owner', true, true, true, null]);
  const back = await post(port, '/api/people/access', { login: 'sam-ops', access: 'private' }, mia);
  assert.deepEqual(switches(back.body, 'sam-ops'), ['private', false, false, false, null]);

  assert.equal((await post(port, '/api/people/access', { login: 'sam-ops', access: 'admin' }, mia)).status, 400, 'only the roles People offers');
  assert.equal((await post(port, '/api/people/access', { login: 'nobody', access: 'member' }, mia)).status, 409, 'only members');
  const last = await post(port, '/api/people/access', { login: 'mia-dev', access: 'member' }, mia);
  assert.deepEqual([last.status, last.body.error], [409, 'the console needs an admin: make someone else one first']);
  assert.equal(members.hasGithubSessions('mia-dev'), false, 'a refused admin change changes nothing else');

  const invited = await post(port, '/api/people/invite', { login: 'lee-dev', access: 'contributor' }, mia);
  assert.deepEqual(switches(invited.body, 'lee-dev'), ['contributor', false, true, false, null]);
  assert.equal((await post(port, '/api/people/invite', { login: 'bo-dev', access: 'boss' }, mia)).status, 400);
  assert.equal(members.isMember('bo-dev'), false, 'a role that is not one invites nobody');
});

test('a local console with no sign-in and no GitHub App gives the person at the keyboard a login of their own', async () => {
  const { soloLoginOf } = await import('./server.mjs');
  assert.equal(soloLoginOf({ launcher: { kind: 'docker' }, githubApp: null, localLogin: 'local' }), 'local');
  assert.equal(soloLoginOf({ launcher: { kind: 'docker' }, githubApp: { appId: '1' }, localLogin: 'local' }), null, 'a GitHub App means sign-in tells people apart');
  assert.equal(soloLoginOf({ launcher: { kind: 'ecs' }, githubApp: null, localLogin: 'local' }), null, 'AWS never guesses who is asking');
});

test('My settings saves the signed-in login\'s own session limits, and refuses one out of range', async (t) => {
  const fleet = { sessions: () => [], find: () => null };
  const userSettings = createUserSettings({ store: { state: {}, save() {} }, secrets: null });
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => ({ login: /woodshed_session=([\w-]+)/.exec(cookie)[1] }) };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 3_600_000, lifetimeMs: 8 * 3_600_000 } };
  const handle = createHandler({ config, fleet, auth, userSettings });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = { cookie: 'woodshed_session=mia-dev' };

  const set = await post(port, '/api/my/limits', { limits: { idleHours: 3 } }, as);
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.limits, { idleHours: 3 });
  assert.deepEqual(set.body.limitDefaults, { idleHours: 1, lifetimeHours: 8 });
  const bad = await post(port, '/api/my/limits', { limits: { lifetimeHours: 99 } }, as);
  assert.equal(bad.status, 409);
  assert.match(bad.body.error, /from 1 to 24 hours/);
});

test('the editor is on the session\'s app name, for whoever can open the session, and never on the console\'s', async (t) => {
  let seen = null;
  const statusd = http.createServer((req, res) => {
    seen = { url: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie ?? null };
    res.end('workbench');
  });
  const statusPort = await listen(statusd);
  const session = { id: '3f9a1c20', status: 'running', title: 'mine', owner: 'octocat', startedBy: 'octocat', token: 'tok', editor: true, endpoint: { host: '127.0.0.1', statusPort } };
  const fleet = { sessions: () => [session], find: (id) => (id === session.id ? session : null) };
  const loginOf = (cookie) => /woodshed_app=([\w-]+)/.exec(String(cookie))?.[1] ?? /woodshed_session=([\w-]+)/.exec(String(cookie))?.[1] ?? null;
  const auth = {
    enabled: () => true, available: () => true,
    sessionFor: async (cookie) => (loginOf(cookie) ? { login: loginOf(cookie) } : null),
    appSessionFor: async ({ cookieHeader }) => (/woodshed_app=/.test(String(cookieHeader)) ? { login: loginOf(cookieHeader) } : null),
  };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 }, appDomain: 'console.example',
  };
  const handle = createHandler({ config, fleet, auth });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => { server.close(); statusd.close(); });
  function get(path, { host, cookie }) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, headers: { host, cookie, accept: 'text/html', 'sec-fetch-site': 'none' } }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location ?? null, body }));
      });
      req.on('error', reject);
      req.end();
    });
  }
  const appHost = `${session.id}.console.example`;

  const owner = await get('/__woodshed/code/', { host: appHost, cookie: 'woodshed_app=octocat' });
  assert.equal(owner.body, 'workbench');
  assert.deepEqual(seen, { url: '/__woodshed/code/', authorization: 'Bearer tok', cookie: null }, 'statusd\'s token, and no cookie');

  seen = null;
  const signedOut = await get('/__woodshed/code/?folder=x', { host: appHost, cookie: '' });
  assert.equal(signedOut.status, 302);
  assert.equal(signedOut.location, `https://console.example/auth/app?id=${session.id}&next=${encodeURIComponent('/__woodshed/code/?folder=x')}`);
  assert.equal((await get('/__woodshed/code/', { host: appHost, cookie: 'woodshed_app=mia-dev' })).status, 404, 'someone the app may be shared with, but not the session');
  assert.equal(seen, null);

  session.editor = false;
  assert.equal((await get('/__woodshed/code/', { host: appHost, cookie: 'woodshed_app=octocat' })).status, 404, 'a session whose statusd says it has no editor');
  assert.equal(seen, null);
  session.editor = true;

  const onConsole = await get(`/code/${session.id}/`, { host: 'console.example', cookie: 'woodshed_session=octocat' });
  assert.notEqual(onConsole.body, 'workbench', 'the console\'s own name never serves the editor');
  assert.equal(seen, null);
});

test('New session lists the projects you can write to, saves your default, and refuses a start on another', async (t) => {
  const { createProjectAccess } = await import('./projectAccess.mjs');
  const { createViewPrefs } = await import('./viewPrefs.mjs');
  const started = [];
  const fleet = {
    sessions: () => [], find: () => null,
    startPrivate: async (args) => { started.push(args); return { id: '0a1b2c3d', owner: args.owner, token: 'secret', status: 'queued' }; },
  };
  const userSettings = { view: () => ({ claudeToken: { set: true, savedAt: null }, setUp: true, available: true }) };
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => ({ login: /woodshed_session=([\w-]+)/.exec(cookie)[1] }) };
  const projects = [
    { name: 'app', repo: 'acme/app', default: true },
    { name: 'tools', repo: 'acme/tools', default: false },
    { name: 'secret', repo: 'acme/secret', default: false },
  ];
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], projects, label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const asked = [];
  // Mia writes to tools, not to secret; the default's repo is what she signed in with.
  const githubFor = (project) => ({ canWrite: async (login) => { asked.push(`${login}:${project.name}`); return project.name === 'tools'; } });
  const viewPrefs = createViewPrefs({ state: {}, save() {} });
  const handle = createHandler({ config, fleet, auth, userSettings, viewPrefs, projectAccess: createProjectAccess({ config, githubFor, viewPrefs }) });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = { cookie: 'woodshed_session=mia-dev' };
  const get = async (path) => JSON.parse(await getBody(port, path, as));

  assert.deepEqual(await get('/api/my/projects'), {
    projects: [{ name: 'app', repo: 'acme/app' }, { name: 'tools', repo: 'acme/tools' }], defaultProject: 'app', saved: false,
  });
  await get('/api/my/projects');
  assert.deepEqual(asked.sort(), ['mia-dev:secret', 'mia-dev:tools'], 'each answer kept: GitHub is asked once');

  assert.deepEqual(await post(port, '/api/my/projects/default', { project: 'secret' }, as), { status: 403, body: { error: 'you cannot start sessions on a project named secret' } });
  const saved = await post(port, '/api/my/projects/default', { project: 'tools' }, as);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.defaultProject, 'tools');
  assert.equal(saved.body.saved, true);
  assert.equal((await get('/api/my/projects')).defaultProject, 'tools', 'kept for the next New session');

  assert.equal((await post(port, '/api/my/sessions', { prompt: 'go', project: 'secret' }, as)).status, 403);
  assert.equal((await post(port, '/api/my/sessions', { prompt: 'go', project: 'nope' }, as)).status, 403);
  assert.equal(started.length, 0);
  assert.equal((await post(port, '/api/my/sessions', { prompt: 'go', project: 'tools' }, as)).status, 201);
  assert.equal(started[0].project.repo, 'acme/tools');
  assert.equal((await post(port, '/api/my/sessions', { prompt: 'go' }, as)).status, 201);
  assert.equal(started[1].project.name, 'app', 'a page from before projects starts on the installation\'s default');
});

test('/api/my names each of your projects that cannot start sessions, and only yours, with why and how to fix it', async (t) => {
  const { createProjectAccess } = await import('./projectAccess.mjs');
  const { createViewPrefs } = await import('./viewPrefs.mjs');
  const { createDatabaseGate } = await import('./databaseGate.mjs');
  t.mock.method(console, 'warn', () => {});
  const userSettings = { view: () => ({ claudeToken: { set: true, savedAt: null }, setUp: true, available: true }) };
  const auth = { enabled: () => true, available: () => true, sessionFor: async () => ({ login: 'mia-dev' }) };
  const projects = [
    { name: 'app', repo: 'acme/app', default: true },
    { name: 'tools', repo: 'acme/tools', default: false },
    { name: 'secret', repo: 'acme/secret', default: false },
  ];
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], projects, label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const githubFor = (project) => ({ canWrite: async () => project.name !== 'secret' });
  const viewPrefs = createViewPrefs({ state: {}, save() {} });
  // The default needs Mongo, which is not hosted; secret, which Mia cannot see, is blocked by the program's hook.
  const files = { app: [{ engine: 'mongo' }], tools: [{ engine: 'postgres' }], secret: [] };
  const databaseGate = createDatabaseGate({
    projectDatabases: async (p) => files[p.name], hosted: ['postgres'], provider: 'aws', admins: () => ['ana'],
    readiness: async (p) => (p.name === 'secret' ? { reason: 'acme/secret is not built.', fix: [] } : null),
  });
  const consoleSettings = { view: () => ({}) };
  const addedProjects = { view: () => projects.map((p) => ({ ...p, sessions: 0 })), names: true };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth, userSettings, viewPrefs, databaseGate, consoleSettings, addedProjects, projectAccess: createProjectAccess({ config, githubFor, viewPrefs }) });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const me = JSON.parse(await getBody(port, '/api/my', { cookie: 'woodshed_session=mia-dev' }));
  assert.deepEqual(Object.keys(me.projectBlockers), ['app'], 'tools starts; secret is not hers to see');
  assert.equal(me.projectBlockers.app.reason, 'acme/app\'s project file asks for a Mongo database, and this console only runs Postgres.');
  assert.equal(me.projectBlockers.app.fix.at(-1).href, 'https://github.com/acme/app/blob/HEAD/.woodshed/project.yaml');
  assert.deepEqual(me.projectBlockers.app.ask.who, ['ana']);
  assert.match(me.databasesRefusal, /^acme\/app's project file asks for a Mongo database/, 'older pages still get the default project\'s');
  const settings = JSON.parse(await getBody(port, '/api/console-settings', { cookie: 'woodshed_session=mia-dev' }));
  assert.deepEqual(settings.projects.map((p) => [p.name, p.blocker?.reason ?? null]), [
    ['app', me.projectBlockers.app.reason], ['tools', null], ['secret', 'acme/secret is not built.'],
  ], 'Console settings shows each repo\'s readiness');
});

test('Resume asks again whether the person may start on the session\'s project', async (t) => {
  const { createProjectAccess } = await import('./projectAccess.mjs');
  const { createViewPrefs } = await import('./viewPrefs.mjs');
  const sessions = {
    aaaa0001: { id: 'aaaa0001', owner: 'mia-dev', project: 'tools', status: 'paused' },
    aaaa0002: { id: 'aaaa0002', owner: 'mia-dev', project: 'secret', status: 'paused' },
    aaaa0003: { id: 'aaaa0003', owner: 'mia-dev', status: 'paused' },
    aaaa0004: { id: 'aaaa0004', owner: 'ana', project: 'secret', status: 'paused' },
  };
  const resumed = [];
  const fleet = {
    sessions: () => Object.values(sessions), find: (id) => sessions[id] ?? null,
    resumePrivate: async ({ owner, id }) => {
      if (sessions[id]?.owner !== owner) throw Object.assign(new Error('no session you can open with that id'), { shown: true });
      resumed.push(id);
      return { ...sessions[id], token: 'secret', status: 'queued' };
    },
  };
  const userSettings = { view: () => ({ claudeToken: { set: true, savedAt: null }, setUp: true, available: true }) };
  const auth = { enabled: () => true, available: () => true, sessionFor: async () => ({ login: 'mia-dev' }) };
  const projects = [
    { name: 'app', repo: 'acme/app', default: true },
    { name: 'tools', repo: 'acme/tools', default: false },
    { name: 'secret', repo: 'acme/secret', default: false },
  ];
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], projects, label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  // Mia started a session on secret, then lost write access to its repo.
  const githubFor = (project) => ({ canWrite: async () => project.name === 'tools' });
  const viewPrefs = createViewPrefs({ state: {}, save() {} });
  const handle = createHandler({ config, fleet, auth, userSettings, viewPrefs, projectAccess: createProjectAccess({ config, githubFor, viewPrefs }) });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const as = { cookie: 'woodshed_session=mia-dev' };

  const refused = await post(port, '/api/my/sessions/aaaa0002/resume', {}, as);
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /no longer start sessions on secret/);
  assert.equal((await post(port, '/api/my/sessions/aaaa0001/resume', {}, as)).status, 201);
  assert.equal((await post(port, '/api/my/sessions/aaaa0003/resume', {}, as)).status, 201, 'a session from before projects is on the default');
  const notMine = await post(port, '/api/my/sessions/aaaa0004/resume', {}, as);
  assert.equal(notMine.status, 409, 'someone else\'s session gets the usual answer, not its project\'s name');
  assert.equal(notMine.body.error, 'no session you can open with that id');
  assert.doesNotMatch(JSON.stringify(notMine.body), /secret/);
  assert.deepEqual(resumed, ['aaaa0001', 'aaaa0003']);
});

test('a console with one project offers it alone, and a saved default it no longer has falls back', async (t) => {
  const { createProjectAccess } = await import('./projectAccess.mjs');
  const { createViewPrefs } = await import('./viewPrefs.mjs');
  const auth = { enabled: () => true, available: () => true, sessionFor: async () => ({ login: 'mia-dev' }) };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const viewPrefs = createViewPrefs({ state: { viewPrefs: { 'mia-dev': { pinned: [], defaultProject: 'gone' } } }, save() {} });
  const githubFor = () => assert.fail('one project needs no write check');
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth, viewPrefs, projectAccess: createProjectAccess({ config, githubFor, viewPrefs }) });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  assert.deepEqual(JSON.parse(await getBody(port, '/api/my/projects', { cookie: 'woodshed_session=x' })), { projects: [{ name: 'r', repo: 'o/r' }], defaultProject: 'r', saved: false });
});

test('the session list names each session\'s project, and the projects there are, for the rail', async (t) => {
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'acme/app', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
    projects: [{ name: 'app', repo: 'acme/app', default: true }, { name: 'tools', repo: 'acme/tools', default: false }],
  };
  const sessions = [
    { id: 'aaaa0001', status: 'running', title: 'on tools', project: 'tools', repo: 'acme/tools' },
    { id: 'aaaa0002', status: 'running', title: 'from before projects', repo: 'acme/tools' },
    { id: 'aaaa0003', status: 'running', title: 'on the default' },
  ];
  const handle = createHandler({ config, fleet: { sessions: () => sessions, find: () => null } });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const body = JSON.parse(await getBody(port, '/api/sessions'));
  assert.deepEqual(body.projects, [{ name: 'app', color: 'teal', default: true }, { name: 'tools', color: 'plum', default: false }]);
  assert.deepEqual(Object.fromEntries(body.sessions.map((s) => [s.id, s.project])), { aaaa0001: 'tools', aaaa0002: 'tools', aaaa0003: 'app' });
});

test('New session\'s / list is the picked project\'s skills, or the default project\'s', async (t) => {
  const projects = [{ name: 'app', repo: 'acme/app', default: true }, { name: 'tools', repo: 'acme/tools', default: false }];
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], projects, label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const read = [];
  const github = { skills: async () => { read.push('app'); return [{ name: 'deploy', desc: 'app skill' }]; } };
  const tools = { skills: async () => { read.push('tools'); return [{ name: 'release', desc: 'tools skill' }]; } };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, github, githubFor: (p) => (p.name === 'tools' ? tools : null) });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const names = async (path) => JSON.parse(await getBody(port, path)).skills.map((s) => s.name);
  assert.deepEqual(await names('/api/skills'), ['deploy']);
  assert.deepEqual(await names('/api/skills?project=tools'), ['release']);
  assert.deepEqual(await names('/api/skills?project=gone'), ['deploy'], 'a project the console does not have: the default\'s');
  await names('/api/skills?project=tools');
  assert.deepEqual(read, ['app', 'tools'], 'each project\'s list is kept');
});

test('another project\'s / list is only for someone who may start sessions on it', async (t) => {
  const projects = [{ name: 'app', repo: 'acme/app', default: true }, { name: 'tools', repo: 'acme/tools', default: false }];
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], projects, label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const github = { skills: async () => [{ name: 'deploy', desc: 'app skill' }] };
  const tools = { skills: async () => [{ name: 'release', desc: 'tools skill' }] };
  const asked = [];
  // Mia writes to the default repo only.
  const projectAccess = { forStart: async (login, name) => { asked.push([login, name]); return name === 'app' ? projects[0] : null; } };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, github, githubFor: (p) => (p.name === 'tools' ? tools : null), projectAccess });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const names = async (path) => JSON.parse(await getBody(port, path)).skills.map((s) => s.name);
  assert.deepEqual(await names('/api/skills?project=tools'), ['deploy'], 'refused: the default project\'s list, never the other repo\'s');
  assert.deepEqual(await names('/api/skills?project=app'), ['deploy']);
  assert.deepEqual(asked.map(([, name]) => name), ['tools', 'app']);
});

test('Work on\'s open pull requests are the picked project\'s, each read once a minute', async (t) => {
  const projects = [{ name: 'app', repo: 'acme/app', default: true }, { name: 'tools', repo: 'acme/tools', default: false }];
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], projects, label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const read = [];
  const client = (repo, number) => ({ openPulls: async () => {
    read.push(repo);
    return { pulls: [{ number, title: repo, branch: `b${number}`, author: 'ann', draft: false, updatedAt: null }], total: 1 };
  } });
  const github = client('acme/app', 1);
  const tools = client('acme/tools', 2);
  const projectAccess = { forStart: async (_login, name) => projects.find((p) => p.name === name) ?? null };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, github, githubFor: (p) => (p.name === 'tools' ? tools : null), projectAccess });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const ask = async (path) => JSON.parse(await getBody(port, path));
  assert.deepEqual(await ask('/api/pulls'), { pulls: [{ number: 1, title: 'acme/app', branch: 'b1', author: 'ann', draft: false, updatedAt: null }], total: 1, stale: false });
  assert.deepEqual((await ask('/api/pulls?project=tools')).pulls.map((p) => p.number), [2]);
  assert.deepEqual((await ask('/api/pulls?project=gone')).pulls.map((p) => p.number), [1], 'a project the console does not have: the default\'s');
  assert.deepEqual(read, ['acme/app', 'acme/tools'], 'each project read once in its minute');
});

test('another project\'s open pull requests are only for someone who may start sessions on it', async (t) => {
  const projects = [{ name: 'app', repo: 'acme/app', default: true }, { name: 'tools', repo: 'acme/tools', default: false }];
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], projects, label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const github = { openPulls: async () => ({ pulls: [{ number: 1 }], total: 1 }) };
  const tools = { openPulls: async () => ({ pulls: [{ number: 2 }], total: 1 }) };
  const projectAccess = { forStart: async (_login, name) => (name === 'app' ? projects[0] : null) };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, github, githubFor: (p) => (p.name === 'tools' ? tools : null), projectAccess });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const numbers = async (path) => JSON.parse(await getBody(port, path)).pulls.map((p) => p.number);
  assert.deepEqual(await numbers('/api/pulls?project=tools'), [1], 'refused: the default project\'s list, never the other repo\'s');
});

test('a failed read of the open pull requests keeps the last list, marked stale', async (t) => {
  const projects = [{ name: 'app', repo: 'acme/app', default: true }];
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], projects, label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  let failing = false;
  const github = { openPulls: async () => {
    if (failing) throw new Error('HTTP 502');
    return { pulls: [{ number: 1 }], total: 1 };
  } };
  const now = Date.now;
  let at = now();
  Date.now = () => at;
  t.after(() => { Date.now = now; });
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, github });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const ask = async () => JSON.parse(await getBody(port, '/api/pulls'));
  assert.deepEqual(await ask(), { pulls: [{ number: 1 }], total: 1, stale: false });
  failing = true;
  at += 61_000;
  assert.deepEqual(await ask(), { pulls: [{ number: 1 }], total: 1, stale: true });
});

test('the rail\'s pull requests are read from each repo the person may start on, on that project\'s own client', async (t) => {
  const projects = [{ name: 'shop', repo: 'acme/shop', default: true }, { name: 'app', repo: 'acme/app' }, { name: 'ops', repo: 'acme/ops' }];
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'acme/shop', projects, label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const asked = [];
  const client = (repo, updatedAt) => ({ openPullsFor: async (login) => { asked.push(`${repo} ${login}`); return [{ number: 1, title: repo, why: 'yours', updatedAt }]; } });
  const github = client('acme/shop', '2026-11-01T00:00:00Z');
  const others = { app: client('acme/app', '2026-11-02T00:00:00Z'), ops: client('acme/ops', '2026-11-03T00:00:00Z') };
  // mia may start on shop and app, not ops.
  const projectAccess = { view: async () => ({ projects: projects.slice(0, 2).map(({ name, repo }) => ({ name, repo })), defaultProject: 'shop', saved: false }) };
  const fleet = { sessions: () => [], find: () => null };
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => ({ login: /woodshed_session=([\w-]+)/.exec(cookie)[1] }) };
  const handle = createHandler({ config, fleet, auth, github, githubFor: (p) => others[p.name], projectAccess });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());

  const answer = await (await fetch(`http://127.0.0.1:${port}/api/my/pulls`, { headers: { cookie: 'woodshed_session=mia' } })).json();
  assert.deepEqual(asked.sort(), ['acme/app mia', 'acme/shop mia'], 'a repo the person may not start on is not asked');
  assert.deepEqual(answer.pulls.map((p) => `${p.project} ${p.repo}#${p.number}`), ['app acme/app#1', 'shop acme/shop#1'], 'newest first, each with its repo');
  // Whose they are, so a page drawn for someone else neither draws nor keeps them; the kept answer says so too.
  assert.equal(answer.login, 'mia');
  const again = await (await fetch(`http://127.0.0.1:${port}/api/my/pulls`, { headers: { cookie: 'woodshed_session=mia' } })).json();
  assert.equal(again.login, 'mia', 'from the minute it is kept');
});

test('the setup card offers the reviewer App to an admin of a console with its App, never to a member who could not open the page', async (t) => {
  const { createMembers } = await import('./members.mjs');
  const store = { state: { members: { 'mia-dev': { addedBy: null, addedAt: '2026-10-01T00:00:00.000Z', how: 'first to sign in', admin: true }, 'sam-ops': { addedBy: 'mia-dev', addedAt: '2026-10-02T00:00:00.000Z', how: 'invited' } } }, save() {} };
  const members = createMembers({ store });
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 }, githubApp: { appId: '1' },
  };
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => ({ login: /woodshed_session=(\w[\w-]*)/.exec(String(cookie))?.[1] }) };
  let made = false;
  const reviewerApp = { configured: () => made };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth, members, secrets: {}, reviewerApp });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const me = async (login) => (await fetch(`http://127.0.0.1:${port}/api/my`, { headers: { cookie: `woodshed_session=${login}` } })).json();
  assert.equal((await me('mia-dev')).reviewerSetupNeeded, true);
  assert.equal((await me('sam-ops')).reviewerSetupNeeded, false, '/setup/github answers them 403');
  made = true;
  assert.equal((await me('mia-dev')).reviewerSetupNeeded, false, 'once it is made');
  made = false;
  for (const [what, options] of [['no App of its own', { config: { ...config, githubApp: null } }], ['no secret store to keep its key', { secrets: null }]]) {
    const other = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth, members, secrets: {}, reviewerApp, ...options });
    const otherServer = http.createServer((req, res) => { other(req, res); });
    const otherPort = await listen(otherServer);
    t.after(() => otherServer.close());
    const view = await (await fetch(`http://127.0.0.1:${otherPort}/api/my`, { headers: { cookie: 'woodshed_session=mia-dev' } })).json();
    assert.equal(view.reviewerSetupNeeded, false, `a console with ${what}`);
  }
});

// The desktop app signs in through the person's browser (desktopSignIn.mjs): the browser, signed in, gets a woodshed://
// link with a one-time code, and the app claims a session of its own with the verifier behind the challenge.
test('a browser signed in to the console signs the desktop app in, through the console\'s own routes', async (t) => {
  const crypto = await import('node:crypto');
  let handle;
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const base = `http://localhost:${port}`;
  const config = { host: '127.0.0.1', publicUrl: base, extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const github = async (url) => {
    if (url.endsWith('/login/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'ghu_user' }));
    if (url.endsWith('/user')) return new Response(JSON.stringify({ login: 'octo', id: 1 }));
    return new Response('[]');
  };
  const auth = createAuth({ publicUrl: base, store: { state: {}, save() {} }, clientId: async () => 'Iv1.app', clientSecret: () => 'cs', canWrite: async () => true, fetchImpl: github, required: true });
  handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth });
  const get = (path, cookie = '') => fetch(`${base}${path}`, { redirect: 'manual', headers: { accept: 'text/html', cookie } });
  const cookieOf = (res) => res.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');

  assert.deepEqual(await (await get('/auth/desktop/ready')).json(), { desktop: true, available: true, required: true, signInPaths: ['/auth/start'] });
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const desktop = `/auth/desktop?challenge=${challenge}&next=%2Fs%2F0a1b2c3d`;
  assert.equal((await get('/auth/desktop?challenge=short')).status, 400);

  // Signed out, the browser signs in with GitHub first, and comes back to the same desktop page.
  const out = await get(desktop);
  assert.equal(out.status, 302);
  assert.equal(out.headers.get('location'), `/auth/start?next=${encodeURIComponent(desktop)}`);
  const start = await get(out.headers.get('location'));
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const back = await get(`/auth/callback?code=c0de&state=${state}`, cookieOf(start));
  assert.equal(back.headers.get('location'), desktop);
  const browser = cookieOf(back);

  // Signed in, the browser asks first: no code is made until the person presses the button on the console's page.
  const ask = await get(desktop, browser);
  assert.equal(ask.status, 200);
  assert.equal(ask.headers.get('x-frame-options'), 'DENY');
  assert.equal(ask.headers.get('referrer-policy'), 'same-origin', 'no-referrer would make Chrome send the form with Origin: null');
  const askPage = await ask.text();
  assert.match(askPage, /Sign in to the Woodshed app\?/);
  assert.match(askPage, /as <strong>@octo<\/strong>/);
  assert.doesNotMatch(askPage, /woodshed:\/\//);
  assert.match(askPage, /name="login" value="octo"/, 'the form carries the account it names');
  const form = new URLSearchParams({ login: 'octo', challenge, next: '/s/0a1b2c3d' }).toString();
  // A page left open from another account's sign-in asks again, naming the account this browser is now.
  const stale = await fetch(`${base}/auth/desktop`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: browser, origin: base }, body: new URLSearchParams({ login: 'someone-else', challenge, next: '/' }).toString() });
  assert.equal(stale.status, 303);
  assert.equal(stale.headers.get('location'), `/auth/desktop?${new URLSearchParams({ challenge, next: '/' })}`);
  const press = (headers) => fetch(`${base}/auth/desktop`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: browser, ...headers }, body: form });
  assert.equal((await press({})).status, 403, 'no Origin: not the console\'s form');
  assert.equal((await press({ origin: 'https://evil.example' })).status, 403, 'another site\'s form');
  const signedOut = await fetch(`${base}/auth/desktop`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base }, body: form });
  assert.equal(signedOut.status, 303, 'a signed-out press goes back to sign in');
  const page = await press({ origin: base });
  assert.equal(page.status, 200);
  const link = /url=(woodshed:\/\/signed-in\?[^"]+)"/.exec(await page.text())?.[1].replaceAll('&amp;', '&');
  const code = new URL(link).searchParams.get('code');
  assert.equal(new URL(link).searchParams.get('next'), '/s/0a1b2c3d');

  const claim = (body, headers = { 'x-woodshed': '1' }) => fetch(`${base}/auth/desktop/claim`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await claim({ code, verifier }, {})).status, 403, 'only the app sends the header');
  // A malformed claim is refused, never thrown on: an object whose toString is not a function, a number, nothing.
  for (const bad of [{ code: { toString: 1 }, verifier }, { code, verifier: { toString: 1 } }, { code: 7, verifier }, {}, null]) {
    assert.equal((await claim(bad)).status, 400, JSON.stringify(bad));
  }
  const claimed = await claim({ code, verifier });
  assert.equal(claimed.status, 200);
  assert.deepEqual(await claimed.json(), { login: 'octo' });
  const app = cookieOf(claimed);
  assert.notEqual(app, browser);
  const sessions = await fetch(`${base}/api/sessions`, { headers: { cookie: app } });
  assert.equal(sessions.status, 200, 'the app is signed in');
  assert.equal((await claim({ code, verifier })).status, 401, 'a code works once');
});

test('the console\'s limit on one message is statusd\'s own, so nothing it accepts is refused for good later', async () => {
  const { MAX_MESSAGE_CHARS } = await import('./server.mjs');
  const statusdSource = await (await import('node:fs/promises')).readFile(new URL('../session/statusd.mjs', import.meta.url), 'utf8');
  assert.match(statusdSource, new RegExp(`const MAX_SEND_CHARS = ${MAX_MESSAGE_CHARS};`));
});

test('another agent in a private session: its owner\'s alone, checked as New session checks it, and each one\'s Chat routes go to statusd', async (t) => {
  const asked = [];
  const statusd = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      asked.push({ method: req.method, url: req.url, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const statusPort = await listen(statusd);
  t.after(() => statusd.close());
  const mine = { id: '0a1b2c3d', status: 'running', title: 't', token: 'tok', owner: 'local', endpoint: { host: '127.0.0.1', termPort: 1, statusPort } };
  const theirs = { ...mine, id: '1b2c3d4e', owner: 'octocat' };
  const tainted = { ...mine, id: '2c3d4e5f', taintedAt: '2026-11-23T10:00:00Z' };
  const grok = { ...mine, id: '3d4e5f6a', options: { agent: 'grok' } };
  const all = [mine, theirs, tainted, grok];
  const allowed = [];
  const fleet = {
    sessions: () => all, find: (id) => all.find((s) => s.id === id) ?? null, isLocked: () => false,
    allowAgent: (s, agent) => allowed.push([s.id, agent]) > 0,
  };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 }, launcher: { kind: 'docker' }, localLogin: 'local',
  };
  let hasClaude = false;
  let hasGrok = false;
  const userSettings = {
    claudeToken: async () => hasClaude ? 'dummy-owner-claude-token' : null,
    agentAuth: async (owner, agent) => {
      if (owner !== 'local') return null;
      if (agent === 'grok' && hasGrok) return 'xai-dummy-owner-grok-key';
      return null;
    },
  };
  const server = http.createServer(createHandler({ config, fleet, userSettings }));
  const port = await listen(server);
  t.after(() => server.close());
  const call = (path, body, method = 'POST') => fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { 'content-type': 'application/json', 'x-woodshed': '1' }, ...(body !== undefined && { body: JSON.stringify(body) }),
  });

  assert.equal((await call('/api/sessions/0a1b2c3d/agents', { agent: 'claude', model: 'opus', prompt: 'look' })).status, 200);
  assert.deepEqual(allowed, [['0a1b2c3d', 'claude']]);
  assert.deepEqual(JSON.parse(asked[0].body), { agent: 'claude', model: 'opus', effort: '', permissionMode: 'auto', prompt: 'look' });
  assert.equal(asked[0].url, '/agents');
  assert.equal((await call('/api/sessions/0a1b2c3d/agents', { agent: 'claude', model: 'opus; rm -rf /' })).status, 400, 'a model New session does not offer');
  assert.equal((await call('/api/sessions/0a1b2c3d/agents', { agent: 'bash' })).status, 400);
  assert.equal((await call('/api/sessions/1b2c3d4e/agents', { agent: 'claude' })).status, 404, 'someone else\'s session');
  assert.equal((await call('/api/sessions/2c3d4e5f/agents', { agent: 'claude' })).status, 409, 'a tainted session starts none');
  const missingGrok = await call('/api/sessions/0a1b2c3d/agents', { agent: 'grok' });
  assert.equal(missingGrok.status, 409);
  assert.match((await missingGrok.json()).error, /save an xAI API key on My settings/);
  assert.equal((await call('/api/sessions/0a1b2c3d/agents', { agent: 'opencode', model: 'openai/gpt-5' })).status, 409);
  const missingClaude = await call('/api/sessions/3d4e5f6a/agents', { agent: 'claude' });
  assert.equal(missingClaude.status, 409);
  assert.match((await missingClaude.json()).error, /save your Claude token on My settings/);
  assert.equal(asked.length, 1, 'nothing refused reached the session');
  hasClaude = true;
  assert.equal((await call('/api/sessions/3d4e5f6a/agents', { agent: 'claude' })).status, 200);
  assert.equal((await call('/api/sessions/3d4e5f6a/agents', undefined, 'GET')).status, 200);
  assert.deepEqual(allowed.at(-1), ['3d4e5f6a', 'claude']);
  assert.equal(asked[1].url, '/agents/with-claude-token');
  assert.equal(JSON.parse(asked[1].body).claudeToken, 'dummy-owner-claude-token');

  assert.equal((await call('/api/sessions/0a1b2c3d/agents', undefined, 'GET')).status, 200);
  assert.equal((await call('/api/sessions/0a1b2c3d/agents/agent-2/transcript?limit=50&since=x', undefined, 'GET')).status, 200);
  assert.equal((await call('/api/sessions/0a1b2c3d/agents/agent-2/send', { text: 'hi', id: 'msg-00000001', extra: 1 })).status, 200);
  assert.equal((await call('/api/sessions/0a1b2c3d/agents/agent-2/interrupt', { keys: 'rm -rf /' })).status, 200);
  assert.equal((await call('/api/sessions/0a1b2c3d/agents/agent-2/stop', {})).status, 200);
  assert.equal((await call('/api/sessions/0a1b2c3d/agents/agent-1/stop', {})).status, 404, 'not an agent beside the session\'s own');
  assert.deepEqual(asked.slice(3).map((a) => [a.method, a.url, a.body]), [
    ['GET', '/agents', ''],
    ['GET', '/agents/agent-2/transcript?limit=50', ''],
    ['POST', '/agents/agent-2/send', '{"text":"hi","id":"msg-00000001"}'],
    ['POST', '/agents/agent-2/interrupt', '{}'],
    ['POST', '/agents/agent-2/stop', '{}'],
  ]);
  hasGrok = true;
  assert.equal((await call('/api/sessions/0a1b2c3d/agents', { agent: 'grok', permissionMode: 'plan' })).status, 200);
  assert.deepEqual(allowed.at(-1), ['0a1b2c3d', 'grok']);
  assert.equal(asked.at(-1).url, '/agents/with-grok-proxy');
  assert.deepEqual(JSON.parse(asked.at(-1).body), { agent: 'grok', model: '', effort: '', permissionMode: 'plan', prompt: '' });
  assert.equal((await call('/api/sessions/3d4e5f6a/agents', { agent: 'grok' })).status, 200);
  assert.equal(JSON.parse(asked.at(-1).body).grokAuth, undefined, 'a Grok session already has its owner’s sign-in');
  const calls = asked.length;
  assert.equal((await call('/api/sessions/0a1b2c3d/agents', { agent: 'opencode' })).status, 409);
  assert.equal(asked.length, calls, 'OpenCode credentials never enter this session');
});

test('a Codex agent beside claude is started with its owner\'s sign-in, and allowed the team key only once it started', async (t) => {
  const asked = [];
  let answer = 409;
  const statusd = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      asked.push(JSON.parse(body));
      res.writeHead(answer, { 'content-type': 'application/json' });
      res.end(answer === 200 ? '{"agent":{"id":"agent-2"}}' : '{"error":"at most 3 agents beside the session\'s own: stop one first"}');
    });
  });
  const statusPort = await listen(statusd);
  t.after(() => statusd.close());
  const mine = { id: '0a1b2c3d', status: 'running', title: 't', token: 'tok', owner: 'local', options: { agent: 'claude' }, endpoint: { host: '127.0.0.1', termPort: 1, statusPort } };
  const allowed = [];
  const fleet = {
    sessions: () => [mine], find: (id) => (id === mine.id ? mine : null), isLocked: () => false,
    allowAgent: (s, agent) => allowed.push(agent) > 0,
  };
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed',
    maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 }, launcher: { kind: 'docker' }, localLogin: 'local',
  };
  const userSettings = { codexAuth: async (login) => (login === 'local' ? 'sk-own-key' : null), limitsFor: () => ({}) };
  const server = http.createServer(createHandler({ config, fleet, userSettings }));
  const port = await listen(server);
  t.after(() => server.close());
  const start = (agent) => fetch(`http://127.0.0.1:${port}/api/sessions/0a1b2c3d/agents`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-woodshed': '1' }, body: JSON.stringify({ agent }),
  });

  const refused = await start('codex');
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /at most 3/);
  assert.equal(asked[0].codexAuth, 'sk-own-key', 'the owner\'s own sign-in goes with the start');
  assert.deepEqual(allowed, [], 'a start the session refused is allowed nothing');
  answer = 200;
  assert.equal((await start('codex')).status, 200);
  assert.deepEqual(allowed, ['codex']);
  assert.equal((await start('claude')).status, 200);
  assert.equal(asked[2].codexAuth, undefined, 'a claude agent is sent no Codex sign-in');
  // A lockdown that starts while the owner's sign-in is read: nothing is sent into the session.
  let locked = false;
  fleet.isLocked = () => locked;
  userSettings.codexAuth = async () => { locked = true; return 'sk-own-key'; };
  assert.equal((await start('codex')).status, 409);
  assert.equal(asked.length, 3, 'the sign-in never reached the session');
  mine.taintedAt = '2026-11-23T10:00:00Z';
  assert.equal((await start('codex')).status, 409, 'a tainted session starts none');
  assert.equal(asked.length, 3);
});

test('the live session list needs a sign-in, shows only what that person may open, and pushes a change', async (t) => {
  const shared = { id: '0a1b2c3d', status: 'running', state: 'done', title: 'Shared', endpoint: { host: '127.0.0.1', termPort: 1, statusPort: 2 } };
  const theirs = { id: '9f8e7d6c', status: 'running', state: 'done', title: 'Someone else\'s', owner: 'someone' };
  const listeners = [];
  const fleet = { sessions: () => [shared, theirs], find: (id) => [shared, theirs].find((s) => s.id === id) ?? null, onChange: (fn) => listeners.push(fn) };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => (String(cookie).includes('woodshed_session=good') ? { login: 'octo' } : null) };
  const handle = createHandler({ config, fleet, auth });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => { handle.liveSessions.closeAll(); server.close(); });

  assert.equal((await getWith(port, '/api/sessions/live')).status, 401);
  const events = [];
  let got;
  const res = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/sessions/live', headers: { host: `localhost:${port}`, cookie: 'woodshed_session=good' } }, resolve);
    req.on('error', reject);
    req.end();
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
  let buffer = '';
  res.setEncoding('utf8');
  res.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      const event = /^event: (\w+)\ndata: (.*)$/s.exec(block);
      if (event) events.push({ event: event[1], data: JSON.parse(event[2]) });
      got?.();
    }
  });
  const next = (n) => new Promise((resolve) => { got = () => events.length >= n && resolve(); got(); });
  await next(1);
  assert.equal(events[0].event, 'full');
  assert.deepEqual(events[0].data.sessions.map((s) => s.id), ['0a1b2c3d'], 'another person\'s private session is not in it');

  shared.state = 'working';
  for (const fn of listeners) fn(shared.id);
  await next(2);
  assert.equal(events[1].event, 'patch');
  assert.deepEqual(events[1].data.sessions.map((s) => [s.id, s.state]), [['0a1b2c3d', 'working']]);
  res.destroy();
});

test('someone taken off People with the live list open gets no more of their private session, and the stream ends', async (t) => {
  const mine = { id: '0a1b2c3d', status: 'running', state: 'done', title: 'Mine', owner: 'octo' };
  const listeners = [];
  const fleet = { sessions: () => [mine], find: (id) => (id === mine.id ? mine : null), onChange: (fn) => listeners.push(fn) };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  let member = true;
  // As auth.mjs: someone taken off the list is no longer signed in to the console.
  const auth = { enabled: () => true, available: () => true, sessionFor: async (cookie) => (member && String(cookie).includes('woodshed_session=good') ? { login: 'octo' } : null) };
  const handle = createHandler({ config, fleet, auth });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => { handle.liveSessions.closeAll(); server.close(); });

  const res = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/sessions/live', headers: { host: `localhost:${port}`, cookie: 'woodshed_session=good' } }, resolve);
    req.on('error', reject);
    req.end();
  });
  assert.equal(res.statusCode, 200);
  res.setEncoding('utf8');
  let body = '';
  res.on('data', (chunk) => { body += chunk; });
  const ended = new Promise((resolve) => res.on('end', resolve));
  await new Promise((resolve) => { const check = () => (body.includes('event: full') ? resolve() : setTimeout(check, 10)); check(); });

  member = false;
  mine.state = 'working';
  mine.lastMessage = 'something private';
  for (const fn of listeners) fn(mine.id);
  const outcome = await Promise.race([ended.then(() => 'ended'), new Promise((resolve) => { setTimeout(() => resolve('still open'), 2000).unref(); })]);
  res.destroy();
  assert.equal(outcome, 'ended', 'the stream ends');
  assert.ok(!body.includes('event: patch'), 'no change reached the stream');
  assert.ok(!body.includes('something private'));
  assert.equal((await getWith(port, '/api/sessions/live', { cookie: 'woodshed_session=good' })).status, 401);
});

// A live list stream on a test console: its events as they come, and a way to wait for one or for its end.
async function openLiveStream(port, headers = {}) {
  const res = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/sessions/live', headers: { host: `localhost:${port}`, ...headers } }, resolve);
    req.on('error', reject);
    req.end();
  });
  let body = '';
  let ended = false;
  res.setEncoding('utf8');
  res.on('data', (chunk) => { body += chunk; });
  res.on('end', () => { ended = true; });
  const until = async (check, ms = 2000) => {
    const at = Date.now();
    while (!check() && Date.now() - at < ms) await new Promise((resolve) => setTimeout(resolve, 10));
    return check();
  };
  return { res, body: () => body, ended: () => ended, until };
}

test('a live list opened before the console required sign-in ends once it does, with nothing more sent', async (t) => {
  const shared = { id: '0a1b2c3d', status: 'running', state: 'done', title: 'Shared' };
  const listeners = [];
  const fleet = { sessions: () => [shared], find: (id) => (id === shared.id ? shared : null), onChange: (fn) => listeners.push(fn) };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  let on = false;
  const auth = { enabled: () => on, available: () => true, sessionFor: async () => null };
  const handle = createHandler({ config, fleet, auth });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => { handle.liveSessions.closeAll(); server.close(); });

  const stream = await openLiveStream(port);
  assert.equal(stream.res.statusCode, 200, 'no sign-in yet: anyone on loopback');
  assert.ok(await stream.until(() => stream.body().includes('event: full')));
  shared.state = 'working';
  for (const fn of listeners) fn(shared.id);
  assert.ok(await stream.until(() => stream.body().includes('event: patch')), 'changes come while sign-in is off');

  on = true;
  shared.state = 'done';
  shared.title = 'Renamed after sign-in';
  for (const fn of listeners) fn(shared.id);
  const ended = await stream.until(() => stream.ended());
  stream.res.destroy();
  assert.equal(ended, true, 'the stream ends');
  assert.ok(!stream.body().includes('Renamed after sign-in'), 'nothing after sign-in was required');
  assert.equal((await getWith(port, '/api/sessions/live')).status, 401);
});

test('a hosted console pushes the live list only when its host says who is still signed in, and ends a revoked one at once', async (t) => {
  const mine = { id: '0a1b2c3d', status: 'running', state: 'done', title: 'Mine', owner: 'octo' };
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: 'o/r', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  let clock = Date.now();
  const secret = 'test-secret-for-the-hosting-proxy';
  const trusted = createTrustedIdentity({ secret, now: () => clock });
  const serve = async (opts) => {
    const listeners = [];
    const fleet = { sessions: () => [mine], find: (id) => (id === mine.id ? mine : null), onChange: (fn) => listeners.push(fn) };
    const handle = createHandler({ config, fleet, trusted, ...opts });
    const server = http.createServer((req, res) => { handle(req, res); });
    const port = await listen(server);
    t.after(() => { handle.liveSessions.closeAll(); server.close(); });
    return { port, changed: () => { for (const fn of listeners) fn(mine.id); } };
  };
  const identity = () => signIdentity({ secret, login: 'octo', role: 'member', exp: clock + 60_000 });

  const unasked = await serve({});
  assert.equal((await getWith(unasked.port, '/api/sessions/live', { [IDENTITY_HEADER]: identity() })).status, 404, 'no hook: the page polls');
  assert.equal((await getWith(unasked.port, '/api/sessions', { [IDENTITY_HEADER]: identity() })).status, 200);

  const asked = [];
  let signedIn = false;
  const hosted = await serve({ stillSignedIn: async ({ login, headers }) => { asked.push({ login, identity: Boolean(headers[IDENTITY_HEADER]) }); return signedIn; } });
  // Signed by the proxy just before the program took them out: the identity checks out, the program says no.
  const refused = await openLiveStream(hosted.port, { [IDENTITY_HEADER]: identity() });
  assert.equal(refused.res.statusCode, 401);
  assert.ok(await refused.until(() => refused.ended()));
  assert.ok(!refused.body().includes(mine.id), 'no session in the answer');
  signedIn = true;
  const stream = await openLiveStream(hosted.port, { [IDENTITY_HEADER]: identity() });
  assert.equal(stream.res.statusCode, 200);
  assert.ok(await stream.until(() => stream.body().includes('event: full')));
  mine.state = 'working';
  hosted.changed();
  assert.ok(await stream.until(() => stream.body().includes('event: patch')), 'pushed while the host says so');
  assert.deepEqual(asked.at(-1), { login: 'octo', identity: true }, 'asked with who and the request that opened it');

  // Taken out by the host, with the identity still good for most of its minute.
  signedIn = false;
  mine.state = 'done';
  mine.lastMessage = 'after the host took them out';
  hosted.changed();
  const ended = await stream.until(() => stream.ended());
  stream.res.destroy();
  assert.equal(ended, true, 'the stream ends');
  assert.ok(!stream.body().includes('after the host took them out'));

  // And, with the host saying yes, the identity's own expiry still ends it.
  signedIn = true;
  const second = await openLiveStream(hosted.port, { [IDENTITY_HEADER]: identity() });
  assert.ok(await second.until(() => second.body().includes('event: full')));
  clock += 60_001;
  mine.lastMessage = 'after the identity expired';
  hosted.changed();
  const expired = await second.until(() => second.ended());
  second.res.destroy();
  assert.equal(expired, true);
  assert.ok(!second.body().includes('after the identity expired'));
});
