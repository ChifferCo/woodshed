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
  ]) {
    const refused = await call(reach);
    assert.equal(refused.status, 403);
    assert.match((await refused.json()).error.message, /production data/);
  }
  assert.equal(upstreamSeen.length, 1);
  assert.equal(serverSideReach(plain), null);
});

test('a tainted session\'s app opens for its owner alone, whatever was shared', () => {
  const session = { id: 'a', owner: 'joel', taintedAt: '2026-11-19T10:00:00Z' };
  assert.equal(canOpenApp(session, 'joel', null, true), true);
  assert.equal(canOpenApp(session, 'ana', null, true), false);
  assert.equal(canOpenApp({ ...session, taintedAt: undefined }, 'ana', null, true), true);
});
