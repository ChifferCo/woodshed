// Two tenants in one multi-tenant console (hosted.mjs), each a real installation on real local secret and home stores,
// with sessions served by stand-in statusd and ttyd servers. Every test reads as one tenant's person and fails when
// anything of the other tenant comes back: sessions, secrets, homes, members, settings, session API tokens, websockets
// and app-proxy cookies. The same login, octocat, is in both orgs, so the tenant is the only thing telling them apart.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { startMultiTenantConsole, checkIdentity } from './hosted.mjs';
import { secretSpecs } from './secrets.mjs';
import { createHomeStore } from '../providers/local/homeStore.mjs';
import { createSecretStore } from '../providers/local/secretStore.mjs';

// Every GitHub call goes through gh: here one that answers its version and a repo's default branch, refuses the rest,
// and notes which token each call came with, so nothing leaves the machine and a token used on the wrong repo shows.
const ghDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-gh-'));
const ghCalls = path.join(ghDir, 'calls');
fs.writeFileSync(path.join(ghDir, 'gh'), [
  '#!/bin/sh',
  '[ "$1" = --version ] && { echo "gh version 0"; exit 0; }',
  `echo "$GH_TOKEN $2" >> "${ghCalls}"`,
  'case "$2" in repos/*/*/*) ;; repos/*/*) echo \'{"default_branch":"main"}\'; exit 0 ;; esac',
  'echo "HTTP 404: Not Found (stand-in gh)" >&2',
  'exit 1',
].join('\n'), { mode: 0o755 });
process.env.PATH = `${ghDir}:${process.env.PATH}`;

const PUBLIC = 'console.test';
const APPS = 'apps.test';
const MEMBERS = {
  octocat: { acme: 'owner', globex: 'member' },
  'ana-dev': { acme: 'member' },
  'priya-dev': { globex: 'owner' },
};

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));
}

// A session's statusd and both ttyds on one port, saying whose they are.
async function standInSession(t, org) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    if (req.url === '/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ state: 'working' }));
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end(`${org}'s session`);
  });
  server.on('upgrade', (req, socket) => {
    seen.push(`upgrade ${req.url}`);
    socket.end(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nx-org: ${org}\r\n\r\n`);
  });
  const port = await listen(server);
  t.after(() => server.close());
  return { port, seen };
}

function session(id, extra) {
  const now = new Date().toISOString();
  return {
    id, kind: 'pr', number: 1, title: id, startedBy: 'octocat', trigger: 'console', prompt: '', owner: null, options: null, branch: `woodshed/${id}`,
    status: 'running', state: 'working', createdAt: now, startedAt: now, stoppedAt: null, lastActiveAt: now, checkedAt: null, stopReason: null,
    error: null, head: null, prUrl: null, lastMessage: null, commentId: null, ref: `woodshed-${id}`, pendingMessages: [], editor: true, ...extra,
  };
}

async function tenant(t, { id, name, repo, sessions, secrets: values, home, settings = {}, sessionApiHost }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hosted-${id}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const secrets = createSecretStore({ dir: path.join(dir, 'secrets'), key: crypto.randomBytes(32), specs: secretSpecs({ envFiles: [{ secret: 'api-env', path: 'api/.env' }] }) });
  for (const [key, value] of Object.entries(values)) await secrets.write(key, value);
  const homes = createHomeStore({ dir: path.join(dir, 'homes') });
  await homes.put('octocat', fs.createReadStream(writeFile(dir, 'home', home)));
  let saved = { sessions, github: null };
  const asked = [];
  const started = [];
  return {
    id, name,
    settings: {
      projects: [{ name: repo.split('/')[1], repo }], sessionApiUrl: `http://${sessionApiHost}`, pollGitHub: false,
      envFiles: [{ secret: 'api-env', path: 'api/.env' }], ...settings,
    },
    services: {
      store: { load: async () => saved, save: async (state) => { saved = state; } },
      secrets, homes,
      github: { token: async ({ repo: r, permissions }) => { asked.push(r); return { token: `ghs_${id}`, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: permissions ?? {} }; } },
      launcher: {
        kind: 'docker', refFor: (s) => `woodshed-${s}`, isAlive: async () => true, logTail: async () => '', stop: async () => {},
        // A start records what it was given and comes up nowhere: the tick then finds no statusd, which is fine here.
        start: async (sessionId, env) => { started.push({ sessionId, env }); return { ref: `woodshed-${sessionId}`, host: '127.0.0.1', termPort: 1, statusPort: 1, shellPort: 1 }; },
      },
      dbAdmin: null, databases: null, projectFiles: null,
    },
    saved: () => saved,
    asked,
    started,
  };
}

function writeFile(dir, name, text) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
}

// The host: who is asking, by a test header standing in for its own sign-in, and which org is current for them.
function tenancyOf(list) {
  return {
    async tenants() { return list.filter(Boolean); },
    async identify(req) {
      const [login, current] = String(req.headers['x-test-person'] ?? '').split('@');
      const mine = MEMBERS[login];
      if (!mine || !mine[current]) return null;
      return { login, role: mine[current], tenantId: current, tenants: Object.entries(mine).map(([tid, role]) => ({ id: tid, name: tid.toUpperCase(), role })) };
    },
    signInUrl: (req) => `https://host.test/sign-in?next=${encodeURIComponent(req.url)}`,
    switchUrl: (tenantId, returnTo) => `https://host.test/switch?org=${tenantId}&next=${encodeURIComponent(returnTo)}`,
    menuLinks: () => [{ label: 'Members', href: 'https://host.test/members' }, { label: 'Bad', href: 'javascript:alert(1)' }],
  };
}

function send(port, { method = 'GET', path: p, host = PUBLIC, person, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: p,
      headers: { host, ...(person ? { 'x-test-person': person } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* a page or a file */ }
        resolve({ status: res.statusCode, headers: res.headers, location: res.headers.location, body: json, text: raw });
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
}

const WRITE = { origin: `http://${PUBLIC}`, 'x-woodshed': '1' };
const PAGE = { accept: 'text/html' };

function upgrade(port, { path: p, host = PUBLIC, person, origin = `http://${PUBLIC}` }) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write([`GET ${p} HTTP/1.1`, `Host: ${host}`, 'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', `Origin: ${origin}`, ...(person ? [`x-test-person: ${person}`] : []), '', ''].join('\r\n'));
    });
    let raw = '';
    socket.on('data', (c) => { raw += c; });
    socket.on('close', () => resolve(raw));
    socket.on('error', () => resolve(raw));
    setTimeout(() => socket.destroy(), 1500);
  });
}

async function twoTenants(t, { extra = [], quiet = true } = {}) {
  const lines = [];
  const sink = { log: (...a) => lines.push(['log', ...a]), info: (...a) => lines.push(['info', ...a]), warn: (...a) => lines.push(['warn', ...a]), error: (...a) => lines.push(['error', ...a]) };
  const acmeSession = await standInSession(t, 'acme');
  const globexSession = await standInSession(t, 'globex');
  // Each tenant's sessions reach the session API at an address of its own: here, one name each for 127.0.0.1.
  const sessionApiPort = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
  const endpoint = (s) => ({ host: '127.0.0.1', termPort: s.port, statusPort: s.port, shellPort: s.port });
  const acme = await tenant(t, {
    id: 'acme', name: 'Acme', repo: 'acme/app', sessionApiHost: `acme.wg:${sessionApiPort}`,
    sessions: [
      session('acac0001', { endpoint: endpoint(acmeSession), token: 'tok-acme-shared', terminalToken: 'term-acme' }),
      session('acac0002', { kind: 'task', trigger: 'my-woodshed', owner: 'octocat', endpoint: endpoint(acmeSession), token: 'tok-acme-private', terminalToken: 'term-acme-2' }),
    ],
    secrets: { 'api-env': 'SECRET=acme', 'users/octocat/claude-token': 'sk-ant-acme-octocat' },
    home: 'acme home of octocat',
    settings: { maxRunning: 2 },
  });
  const globex = await tenant(t, {
    id: 'globex', name: 'Globex', repo: 'globex/billing', sessionApiHost: `globex.wg:${sessionApiPort}`,
    sessions: [
      session('9e0e0001', { endpoint: endpoint(globexSession), token: 'tok-globex-shared', terminalToken: 'term-globex' }),
      session('9e0e0002', { kind: 'task', trigger: 'my-woodshed', owner: 'octocat', endpoint: endpoint(globexSession), token: 'tok-globex-private', terminalToken: 'term-globex-2' }),
    ],
    secrets: { 'api-env': 'SECRET=globex', 'users/octocat/claude-token': 'sk-ant-globex-octocat' },
    home: 'globex home of octocat',
    settings: { maxRunning: 4 },
  });
  const tenants = [acme, globex, ...extra];
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-state-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const hosted = await startMultiTenantConsole({
    config: { host: '127.0.0.1', port: 0, publicUrl: `http://${PUBLIC}`, appDomain: APPS, sessionApi: { host: '127.0.0.1', port: sessionApiPort }, stateDir },
    tenancy: tenancyOf(tenants),
    log: quiet ? sink : null,
  });
  t.after(() => hosted.close());
  return { hosted, port: hosted.server.address().port, sessionApiPort, acme, globex, acmeSession, globexSession, lines, tenants };
}

const ids = (body) => body.sessions.map((s) => s.id).sort();

test('each person sees their current org\'s sessions alone, and another org\'s ids are unknown there', async (t) => {
  const { port } = await twoTenants(t);
  assert.deepEqual(ids((await send(port, { path: '/api/sessions', person: 'octocat@acme' })).body), ['acac0001', 'acac0002']);
  assert.deepEqual(ids((await send(port, { path: '/api/sessions', person: 'octocat@globex' })).body), ['9e0e0001', '9e0e0002']);
  assert.deepEqual(ids((await send(port, { path: '/api/sessions', person: 'ana-dev@acme' })).body), ['acac0001'], 'not octocat\'s private one');
  for (const p of ['/api/sessions/9e0e0001/review', '/api/sessions/9e0e0001/diff', '/api/sessions/9e0e0002/app-share']) {
    assert.equal((await send(port, { path: p, person: 'ana-dev@acme' })).status, 404, p);
    assert.equal((await send(port, { path: p, person: 'octocat@acme' })).status, 404, `${p}, even for a member of both while in acme`);
  }
  const stop = await send(port, { method: 'POST', path: '/api/sessions/9e0e0001/stop', person: 'octocat@acme', headers: WRITE, body: {} });
  assert.equal(stop.status, 404);
  assert.equal((await send(port, { path: '/api/sessions', person: 'priya-dev@globex' })).body.sessions.find((s) => s.id === '9e0e0001').status, 'running');
});

test('a link to another of the person\'s orgs switches them there through the host; a link to an org they are not in does not', async (t) => {
  const { port } = await twoTenants(t);
  const page = await send(port, { path: '/s/9e0e0001', person: 'octocat@acme', headers: PAGE });
  assert.equal(page.status, 302);
  assert.equal(page.location, 'https://host.test/switch?org=globex&next=%2Fs%2F9e0e0001');
  const named = await send(port, { path: '/?new=1&org=globex', person: 'octocat@acme', headers: PAGE });
  assert.equal(named.location, 'https://host.test/switch?org=globex&next=%2F%3Fnew%3D1%26org%3Dglobex');
  assert.equal((await send(port, { path: '/?org=globex', person: 'octocat@globex', headers: PAGE })).status, 200, 'already there');
  const outsider = await send(port, { path: '/s/9e0e0001?org=globex', person: 'ana-dev@acme', headers: PAGE });
  assert.equal(outsider.status, 200, 'ana stays in acme, where the id is unknown');
  assert.equal((await send(port, { path: '/api/sessions/9e0e0001/review', person: 'ana-dev@acme' })).status, 404);
  const signedOut = await send(port, { path: '/s/9e0e0001', headers: PAGE });
  assert.equal(signedOut.location, 'https://host.test/sign-in?next=%2Fs%2F9e0e0001');
  assert.equal((await send(port, { path: '/api/sessions' })).status, 401);
});

test('secrets, settings and the menu are the current org\'s, and an owner in one org is a member in the other', async (t) => {
  const { port } = await twoTenants(t);
  const reveal = (person) => send(port, { method: 'POST', path: '/api/secrets/api-env/reveal', person, headers: WRITE, body: {} });
  assert.deepEqual((await reveal('octocat@acme')).body, { value: 'SECRET=acme' });
  assert.equal((await reveal('octocat@globex')).status, 403, 'a member of globex');
  assert.deepEqual((await reveal('priya-dev@globex')).body, { value: 'SECRET=globex' });
  assert.equal((await send(port, { path: '/api/console-settings', person: 'octocat@acme' })).body.settings.find((s) => s.key === 'maxRunning').value, 2);
  assert.equal((await send(port, { path: '/api/console-settings', person: 'priya-dev@globex' })).body.settings.find((s) => s.key === 'maxRunning').value, 4);

  const me = (await send(port, { path: '/api/me', person: 'octocat@acme' })).body;
  assert.deepEqual([me.login, me.admin, me.repo, me.org], ['octocat', true, 'acme/app', { id: 'acme', name: 'Acme' }]);
  assert.deepEqual(me.orgs.map((o) => [o.id, o.role, o.current, o.href]), [
    ['acme', 'owner', true, null], ['globex', 'member', false, 'https://host.test/switch?org=globex&next=%2F'],
  ]);
  assert.deepEqual(me.hostLinks, [{ label: 'Members', href: 'https://host.test/members' }], 'a link that is not the web\'s is dropped');
  const ana = (await send(port, { path: '/api/me', person: 'ana-dev@acme' })).body;
  assert.deepEqual(ana.orgs.map((o) => o.id), ['acme'], 'nobody is told of an org they are not in');
});

test('a Claude token the host wrote straight into the secret store counts as set, in that org alone', async (t) => {
  const { port, acme } = await twoTenants(t);
  const my = async (person) => (await send(port, { path: '/api/my', person })).body;
  assert.equal((await my('octocat@acme')).claudeToken.set, true);
  assert.equal((await my('ana-dev@acme')).claudeToken.set, false);
  await acme.services.secrets.write('users/ana-dev/claude-token', 'sk-ant-ana');
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  assert.equal((await my('ana-dev@acme')).claudeToken.set, true, 'found on her next look');
  assert.equal(acme.saved().people['ana-dev'].claudeTokenAt !== null, true);
});

test('the session API knows a session by its token, at its own tenant\'s address alone', async (t) => {
  const { sessionApiPort: port } = await twoTenants(t);
  const call = (p, token, host) => send(port, { method: 'POST', path: p, host, headers: { authorization: `Bearer ${token}` } });
  const acmeHost = `acme.wg:${port}`;
  const globexHost = `globex.wg:${port}`;
  assert.equal((await call('/settings', 'tok-acme-private', acmeHost)).body.claudeToken, 'sk-ant-acme-octocat');
  assert.equal((await call('/settings', 'tok-globex-private', globexHost)).body.claudeToken, 'sk-ant-globex-octocat');
  assert.equal((await call('/settings', 'tok-acme-private', globexHost)).status, 401, 'acme\'s token at globex\'s address');
  assert.equal((await call('/settings', 'tok-nobodys', acmeHost)).status, 401);
  const home = await call('/home/restore', 'tok-acme-private', acmeHost);
  assert.equal(home.text, 'acme home of octocat');
  assert.deepEqual((await call('/github-token', 'tok-globex-shared', globexHost)).body.token, 'ghs_globex');
  assert.deepEqual((await call('/github-token', 'tok-acme-shared', acmeHost)).body.token, 'ghs_acme');
  const anthropic = await send(port, { method: 'POST', path: '/anthropic/v1/messages', host: acmeHost, headers: { 'x-api-key': 'tok-globex-shared' }, body: {} });
  assert.equal(anthropic.status, 401, 'globex\'s token at acme\'s address');
  const unknown = await send(port, { method: 'POST', path: '/anthropic/v1/messages', host: acmeHost, headers: { 'x-api-key': 'nobody' }, body: {} });
  assert.equal(unknown.body.error.type, 'authentication_error', 'the refusal claude knows');
});

test('a terminal websocket opens on the current org\'s sessions, and never on another org\'s', async (t) => {
  const { port, acmeSession, globexSession } = await twoTenants(t);
  assert.match(await upgrade(port, { path: '/term/9e0e0001/ws', person: 'priya-dev@globex' }), /101 Switching Protocols[\s\S]*x-org: globex/);
  const refused = await upgrade(port, { path: '/term/9e0e0001/ws', person: 'ana-dev@acme' });
  assert.doesNotMatch(refused, /101/);
  const crossed = await upgrade(port, { path: '/term/9e0e0001/ws', person: 'octocat@acme' });
  assert.doesNotMatch(crossed, /101/, 'a member of both, while in acme');
  assert.doesNotMatch(await upgrade(port, { path: '/term/acac0001/ws' }), /101/, 'nobody signed in');
  assert.equal(globexSession.seen.filter((u) => u.startsWith('upgrade')).length, 1, 'globex\'s session got priya\'s alone');
  assert.equal(acmeSession.seen.filter((u) => u.startsWith('upgrade')).length, 0);
});

test('a session\'s app is open to its org\'s members, and a share link\'s cookie opens that one app alone', async (t) => {
  const { port, globexSession } = await twoTenants(t);
  const app = (id, person, headers = {}) => send(port, { path: '/', host: `${id}.${APPS}`, person, headers });
  assert.equal((await app('9e0e0001', 'priya-dev@globex')).text, 'globex\'s session');
  assert.equal((await app('9e0e0001', 'octocat@acme')).text, 'globex\'s session', 'octocat is a member of globex');
  const ana = await app('9e0e0001', 'ana-dev@acme');
  assert.notEqual(ana.text, 'globex\'s session');
  assert.ok([302, 401, 403].includes(ana.status), `ana is no member of globex: ${ana.status}`);
  assert.equal((await app('9e0e0002', 'octocat@acme')).text, 'globex\'s session', 'the owner\'s private session');
  assert.notEqual((await app('9e0e0002', 'priya-dev@globex')).text, 'globex\'s session', 'not someone else\'s private one');
  assert.equal((await app('ffffffff', 'octocat@acme')).status, 404);

  const made = await send(port, { method: 'POST', path: '/api/sessions/acac0002/app-share/links', person: 'octocat@acme', headers: WRITE, body: { hours: 1 } });
  assert.equal(made.status, 201);
  const claim = await send(port, { path: new URL(made.body.url).pathname + new URL(made.body.url).search, host: `acac0002.${APPS}` });
  const cookie = String(claim.headers['set-cookie']).split(';')[0];
  assert.equal((await app('acac0002', null, { cookie })).text, 'acme\'s session');
  const before = globexSession.seen.length;
  assert.notEqual((await app('9e0e0002', null, { cookie })).text, 'globex\'s session');
  assert.notEqual((await app('9e0e0001', null, { cookie })).text, 'globex\'s session');
  assert.equal(globexSession.seen.length, before);
});

test('GitHub events go to the tenant named, every line says whose it is, and a tenant that cannot start leaves the others running', async (t) => {
  const broken = {
    id: 'initech', name: 'Initech', settings: {},
    services: { store: { load: async () => { throw new Error('the host\'s database is down'); }, save: async () => {} }, github: { token: async () => ({}) }, launcher: { start() {} } },
  };
  MEMBERS['milton-dev'] = { initech: 'owner' };
  t.after(() => delete MEMBERS['milton-dev']);
  const { hosted, port, lines } = await twoTenants(t, { extra: [broken] });
  assert.equal((await send(port, { path: '/api/sessions', person: 'priya-dev@globex' })).status, 200);
  assert.equal((await send(port, { path: '/api/sessions', person: 'milton-dev@initech' })).status, 503);
  assert.ok(lines.some(([level, message, fields]) => level === 'error' && message === 'hosted: tenant not started' && fields.tenant === 'initech'));

  assert.equal(await hosted.dispatchGitHub('acme', { event: 'push', deliveryId: 'd1', payload: {} }), true, 'nothing to do');
  assert.equal(await hosted.dispatchGitHub('globex', { event: 'pull_request', deliveryId: 'd2', payload: { action: 'closed', repository: { full_name: 'acme/app' }, pull_request: { number: 3 } } }), true);
  assert.ok(lines.some(([, message, fields]) => message === 'webhooks: message from a repo that is not a project, dropped' && fields.tenant === 'globex'),
    'acme\'s repo is not a globex project');
  await assert.rejects(hosted.dispatchGitHub('initech', { event: 'push', payload: {} }), /no running tenant initech/);

  await send(port, { path: '/api/my', person: 'octocat@globex' });
  const tenantLines = lines.filter(([, message]) => typeof message === 'string' && /^(userSettings|githubBroker|webhooks|hosted: tenant running)/.test(message));
  assert.ok(tenantLines.length > 3);
  for (const [, message, fields] of tenantLines) assert.ok(['acme', 'globex'].includes(fields?.tenant), `${message} names its tenant`);
  for (const [, , fields] of lines) assert.ok(fields && 'tenant' in fields, 'every line has the field');
});

test('reload takes a tenant\'s new settings and keeps its sessions; remove drops it, its tokens with it', async (t) => {
  const { hosted, port, sessionApiPort, acme } = await twoTenants(t);
  acme.settings.maxRunning = 3;
  await hosted.reload('acme');
  assert.equal((await send(port, { path: '/api/console-settings', person: 'octocat@acme' })).body.settings.find((s) => s.key === 'maxRunning').value, 3);
  assert.deepEqual(ids((await send(port, { path: '/api/sessions', person: 'octocat@acme' })).body), ['acac0001', 'acac0002']);
  await hosted.remove('acme');
  assert.equal((await send(port, { path: '/api/sessions', person: 'octocat@acme' })).status, 503);
  const token = await send(sessionApiPort, { method: 'POST', path: '/github-token', host: `acme.wg:${sessionApiPort}`, headers: { authorization: 'Bearer tok-acme-shared' } });
  assert.equal(token.status, 401);
  assert.deepEqual(ids((await send(port, { path: '/api/sessions', person: 'octocat@globex' })).body), ['9e0e0001', '9e0e0002'], 'globex runs on');
  await assert.rejects(hosted.reload('nobody'), /no tenant nobody/);
});

test('a session starts on its own org\'s launcher, with that org\'s session API address and a link naming the org', async (t) => {
  const { port, acme, globex, sessionApiPort } = await twoTenants(t);
  const start = await send(port, { method: 'POST', path: '/api/my/sessions', person: 'octocat@globex', headers: WRITE, body: { prompt: 'hello', name: 'A globex task' } });
  assert.equal(start.status, 201, JSON.stringify(start.body));
  for (let i = 0; i < 50 && !globex.started.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(acme.started.length, 0, 'nothing started on acme\'s machine');
  assert.equal(globex.started.length, 1);
  const { sessionId, env } = globex.started[0];
  assert.equal(sessionId, start.body.id);
  assert.equal(env.WOODSHED_CONSOLE_URL, `http://globex.wg:${sessionApiPort}`);
  assert.equal(env.SESSION_URL, `http://${PUBLIC}/s/${sessionId}?org=globex`);
  assert.equal(env.SESSION_KIND, 'private');
  assert.deepEqual(ids((await send(port, { path: '/api/sessions', person: 'octocat@acme' })).body), ['acac0001', 'acac0002'], 'acme\'s list is as it was');
  assert.ok(globex.saved().sessions.some((s) => s.id === sessionId), 'kept in globex\'s store');
  assert.equal(acme.saved().sessions.some((s) => s.id === sessionId), false);
  const calls = fs.readFileSync(ghCalls, 'utf8').trim().split('\n').map((line) => line.split(' '));
  assert.ok(calls.some(([token, p]) => token === 'ghs_globex' && p.startsWith('repos/globex/')), 'globex\'s repo read');
  assert.deepEqual(calls.filter(([token, p]) => (token === 'ghs_acme') !== p.startsWith('repos/acme/') && p.startsWith('repos/')), [], 'each repo read with its own org\'s token');
});

test('an identity that is not one signs nobody in', () => {
  assert.equal(checkIdentity(null), null);
  assert.equal(checkIdentity({ login: 'Octocat', role: 'owner', tenantId: 'acme' }), null, 'GitHub logins come lowercase');
  assert.equal(checkIdentity({ login: 'octocat', role: 'admin', tenantId: 'acme' }), null);
  assert.equal(checkIdentity({ login: 'octocat', role: 'owner', tenantId: '../acme' }), null);
  assert.deepEqual(checkIdentity({ login: 'octocat', role: 'owner', tenantId: 'acme' }).tenants, [{ id: 'acme', name: 'acme', role: 'owner' }]);
  const listed = checkIdentity({ login: 'octocat', role: 'member', tenantId: 'acme', tenants: [{ id: 'x/y', role: 'owner' }, { id: 'globex', name: 'Globex', role: 'owner' }] });
  assert.deepEqual(listed.tenants.map((x) => x.id), ['acme', 'globex'], 'a bad entry dropped, the current one added');
});
