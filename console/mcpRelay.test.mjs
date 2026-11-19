import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { DISCOVERY_PATH, JWKS_PATH, createOidcIssuer, issuerFrom, verifyJwt } from './oidcIssuer.mjs';
import { createMcpRelay, isMcpPath, serverOfPath } from './mcpRelay.mjs';
import { PROD_MCP_AUDIENCE, checkServer, createMcpServers, mcpSettings, serverEligibility } from './mcpServers.mjs';

const quietly = (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
};

function keyFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oidc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'key.pem');
}

test('mcpSettings reads the environment\'s production server, the issuer and how long a tainted session is kept', () => {
  const none = mcpSettings({}, 'https://c.test');
  assert.equal(none.environment, null);
  assert.equal(none.taintedRemoveAfterMs, 24 * 3_600_000, 'a day after it stops, unless the installation says otherwise');
  const s = mcpSettings({ WOODSHED_PROD_MCP_URL: 'https://mcp.test/mcp/', WOODSHED_PROD_MCP_PEOPLE: 'Joel, ana', WOODSHED_PROD_MCP_REPOS: 'o/r' }, 'https://c.test/');
  assert.equal(s.environment.url, 'https://mcp.test/mcp');
  assert.equal(s.environment.name, 'woodshed-prod');
  assert.equal(s.environment.audience, PROD_MCP_AUDIENCE);
  assert.deepEqual(s.environment.people, ['joel', 'ana']);
  assert.deepEqual(s.environment.repos, ['o/r']);
  assert.equal(s.issuer, 'https://c.test');
  assert.equal(mcpSettings({ WOODSHED_PROD_MCP_REMOVE_AFTER_HOURS: '2' }, 'https://c.test').taintedRemoveAfterMs, 2 * 3_600_000);
  assert.equal(mcpSettings({ WOODSHED_OIDC_ISSUER: 'https://id.test' }, 'https://c.test').issuer, 'https://id.test');
  assert.throws(() => mcpSettings({ WOODSHED_PROD_MCP_URL: 'https://u:p@mcp.test' }, 'https://c.test'), /no credentials/);
  assert.throws(() => mcpSettings({ WOODSHED_PROD_MCP_REMOVE_AFTER_HOURS: '0' }, 'https://c.test'), /above 0/);
  assert.throws(() => issuerFrom('https://c.test/?x=1'), /no query/);
});

test('only a private claude session of an allowed person on an allowed repo may use production', () => {
  const s = mcpSettings({ WOODSHED_PROD_MCP_URL: 'https://mcp.test', WOODSHED_PROD_MCP_PEOPLE: 'joel', WOODSHED_PROD_MCP_REPOS: 'o/r' }, 'https://c.test').environment;
  const mine = { id: 'a', owner: 'Joel', kind: 'task' };
  assert.deepEqual(serverEligibility(s, mine, 'O/R'), { ok: true });
  assert.match(serverEligibility(s, { id: 'b', kind: 'issue' }, 'o/r').why, /only a My Woodshed session/);
  assert.match(serverEligibility(s, { id: 'c', kind: 'ask', owner: 'joel' }, 'o/r').why, /only a My Woodshed session/);
  assert.match(serverEligibility(s, { ...mine, qa: { base: 'main' } }, 'o/r').why, /QA run or a review/);
  assert.match(serverEligibility(s, { ...mine, review: { base: 'main' } }, 'o/r').why, /QA run or a review/);
  assert.match(serverEligibility(s, { ...mine, options: { agent: 'codex' } }, 'o/r').why, /Codex/);
  assert.match(serverEligibility(s, { ...mine, owner: 'ana' }, 'o/r').why, /@ana is not allowed/);
  assert.match(serverEligibility(s, mine, 'o/other').why, /o\/other is not allowed/);
  assert.ok(isMcpPath('/prod-mcp') && isMcpPath('/prod-mcp/x') && !isMcpPath('/prod-mcpx') && isMcpPath('/mcp/docs') && !isMcpPath('/mcp/'));
  assert.deepEqual(serverOfPath('/mcp/docs/sse'), { name: 'docs', suffix: '/sse' });
  assert.deepEqual(serverOfPath('/prod-mcp'), { name: 'woodshed-prod', suffix: '' });
});

test('an ordinary server goes to whom it names, a shared session only when it says so, and a tainted session never', () => {
  const docs = checkServer({ name: 'docs', url: 'https://docs.test', shared: true });
  const mine = checkServer({ name: 'mine', url: 'https://mine.test', people: ['joel'], repos: ['o/r'] });
  assert.deepEqual(serverEligibility(docs, { id: 's', kind: 'issue' }, 'o/x'), { ok: true });
  assert.deepEqual(serverEligibility(docs, { id: 'k', kind: 'ask' }, 'o/x'), { ok: true }, 'a question from Slack is a shared session');
  assert.match(serverEligibility(mine, { id: 's', kind: 'issue' }, 'o/r').why, /My Woodshed sessions only/);
  assert.deepEqual(serverEligibility(mine, { id: 'p', owner: 'joel' }, 'o/r'), { ok: true });
  assert.match(serverEligibility(mine, { id: 'p', owner: 'joel', taintedAt: 'x' }, 'o/r').why, /seen production data/);
});

test('checkServer keeps what a server may be, and refuses the rest', () => {
  assert.deepEqual(checkServer({ name: 'Sentry', url: 'https://mcp.sentry.test/mcp/', auth: 'header' }), {
    name: 'sentry', url: 'https://mcp.sentry.test/mcp', production: false, shared: false, people: '*', repos: '*', auth: 'header', audience: null, header: 'authorization',
  });
  const prod = checkServer({ name: 'orders', url: 'https://orders.test', production: true, shared: true, people: 'joel', repos: ['o/r'] });
  assert.equal(prod.shared, false, 'a production server is never a shared session\'s');
  assert.equal(prod.auth, 'oidc');
  assert.equal(prod.audience, PROD_MCP_AUDIENCE);
  assert.equal(checkServer({ name: 'x', url: 'https://x.test', auth: 'oidc' }).audience, 'x');
  for (const [input, message] of [
    [{ name: 'woodshed-prod', url: 'https://x.test' }, /environment/],
    [{ name: 'Bad Name', url: 'https://x.test' }, /lowercase/],
    [{ name: 'x', url: 'ftp://x.test' }, /http\(s\)/],
    [{ name: 'x', url: 'https://u:p@x.test' }, /no credentials/],
    [{ name: 'x', url: 'https://x.test', auth: 'magic' }, /none, oidc or header/],
    [{ name: 'x', url: 'https://x.test', auth: 'header', header: 'cookie' }, /cannot be cookie/],
    [{ name: 'x', url: 'https://x.test', repos: ['nope'] }, /owner\/name/],
    [{ name: 'x', url: 'https://x.test', production: true, people: [] }, /at least one person/],
  ]) assert.throws(() => checkServer(input), message);
});

test('the issuer makes its key once, keeps it, and signs tokens its own JWKS checks', async (t) => {
  quietly(t);
  const file = keyFile(t);
  const issuer = createOidcIssuer({ issuer: 'https://c.test', keyFile: file });
  const { token, expiresAt } = await issuer.sign({ audience: 'aud', subject: 'private:joel', ttlSeconds: 300, claims: { session_id: 'abc', sub: 'not this', iss: 'nor this' } });
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  const checked = verifyJwt(token, await issuer.jwks());
  assert.equal(checked.payload.sub, 'private:joel', 'the caller\'s claims never replace the issuer\'s own');
  assert.equal(checked.payload.iss, 'https://c.test');
  assert.equal(checked.payload.session_id, 'abc');
  assert.equal(expiresAt, checked.payload.exp * 1000);
  const again = createOidcIssuer({ issuer: 'https://c.test', keyFile: file });
  assert.deepEqual((await again.jwks()).keys.map((k) => k.kid), (await issuer.jwks()).keys.map((k) => k.kid), 'the same key after a restart');
  assert.equal(verifyJwt(token, { keys: [] }), null);
  assert.equal(issuer.discovery().jwks_uri, `https://c.test${JWKS_PATH}`);
  assert.equal(DISCOVERY_PATH, '/.well-known/openid-configuration');
});

// woodshed-prod-mcp, as far as the relay sees it: Streamable HTTP, a JSON answer or an event stream.
async function fakeMcp(t) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'm-1', 'set-cookie': 'x=1' });
        res.end('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/ping"}\n\n');
        return;
      }
      const msg = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'm-1' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'query' }] } }));
    });
  });
  // An odd high port on loopback, as no installation uses.
  await new Promise((resolve) => server.listen(47913, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { url: 'http://127.0.0.1:47913/mcp', seen };
}

async function relayOn(t, { taint, settings, servers: kept = [], secrets = null }) {
  const issuer = createOidcIssuer({ issuer: 'https://c.test', keyFile: keyFile(t) });
  const servers = createMcpServers({ store: { state: { mcpServers: kept }, save() {} }, settings, secrets, lockdown: () => ({ available: true }) });
  const relay = createMcpRelay({ servers, issuer, fleet: { taint }, repoOf: () => 'o/r' });
  let session = null;
  const server = http.createServer((req, res) => relay.handle(req, res, session));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return { issuer, base, as: (s) => { session = s; } };
}

test('the relay taints the session before its first call goes on, adds a token the MCP server can check, and passes the answer back', async (t) => {
  quietly(t);
  const mcp = await fakeMcp(t);
  const settings = mcpSettings({ WOODSHED_PROD_MCP_URL: mcp.url, WOODSHED_PROD_MCP_PEOPLE: 'joel', WOODSHED_PROD_MCP_REPOS: 'o/r' }, 'https://c.test');
  const order = [];
  const session = { id: 'a1b2c3d4', owner: 'joel', kind: 'task' };
  const { issuer, base, as } = await relayOn(t, {
    settings,
    taint: async (s) => { order.push(`taint (forwarded so far: ${mcp.seen.length})`); s.taintedAt = '2026-11-19T10:00:00.000Z'; return s; },
  });
  as(session);
  const res = await fetch(`${base}/prod-mcp`, {
    method: 'POST', headers: { authorization: 'Bearer SESSION-TOKEN', 'content-type': 'application/json', accept: 'application/json, text/event-stream', cookie: 'c=1' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('mcp-session-id'), 'm-1');
  assert.deepEqual((await res.json()).result.tools, [{ name: 'query' }]);
  assert.deepEqual(order, ['taint (forwarded so far: 0)'], 'initialize itself taints, before anything reaches the server');

  const call = mcp.seen[0];
  assert.equal(call.url, '/mcp');
  assert.equal(call.headers.cookie, undefined);
  const token = /^Bearer (.+)$/.exec(call.headers.authorization)[1];
  assert.notEqual(token, 'SESSION-TOKEN', 'the session\'s own token never reaches the server');
  const { payload } = verifyJwt(token, await issuer.jwks());
  assert.equal(payload.aud, PROD_MCP_AUDIENCE);
  assert.equal(payload.sub, 'private:joel');
  assert.equal(payload.session_id, 'a1b2c3d4');
  assert.equal(payload.repo, 'o/r');
  assert.ok(payload.exp - payload.iat <= 300);

  // A second call, and the server's event stream: no second taint, the stream passed through as it came.
  const stream = await fetch(`${base}/prod-mcp`, { headers: { authorization: 'Bearer SESSION-TOKEN', accept: 'text/event-stream', 'mcp-session-id': 'm-1' } });
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  assert.equal(stream.headers.get('set-cookie'), null);
  assert.match(await stream.text(), /notifications\/ping/);
  assert.equal(order.length, 1);
  assert.equal(mcp.seen[1].headers['mcp-session-id'], 'm-1');
});

test('the relay refuses a session it may not serve, and one it could not lock down, sending nothing on', async (t) => {
  quietly(t);
  const mcp = await fakeMcp(t);
  const settings = mcpSettings({ WOODSHED_PROD_MCP_URL: mcp.url, WOODSHED_PROD_MCP_PEOPLE: 'joel', WOODSHED_PROD_MCP_REPOS: 'o/r' }, 'https://c.test');
  const { base, as } = await relayOn(t, {
    settings,
    taint: async () => { throw Object.assign(new Error('the session could not be locked down: docker said no'), { shown: true }); },
  });
  const post = () => fetch(`${base}/prod-mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });

  as(null);
  assert.equal((await post()).status, 401);
  as({ id: 's', kind: 'issue' });
  assert.equal((await post()).status, 403, 'a shared session');
  as({ id: 'p', owner: 'ana', kind: 'task' });
  assert.equal((await post()).status, 403, 'someone not listed');
  as({ id: 'q', owner: 'joel', kind: 'task' });
  const refused = await post();
  assert.equal(refused.status, 503);
  assert.match((await refused.json()).error, /docker said no.*was not sent/);
  assert.equal(mcp.seen.length, 0, 'nothing reached the MCP server');
});

test('an ordinary server\'s calls go on with no taint, carrying the header the console holds or nothing, and a tainted session is refused them', async (t) => {
  quietly(t);
  const mcp = await fakeMcp(t);
  const secrets = { read: async (name) => (name === 'mcp-servers/tracker/header' ? 'Token team-secret' : null) };
  const servers = [
    { ...checkServer({ name: 'tracker', url: mcp.url, auth: 'header', header: 'x-api-key', shared: true }), headerSavedAt: '2026-11-19T00:00:00.000Z' },
    checkServer({ name: 'docs', url: mcp.url, shared: true }),
    checkServer({ name: 'unset', url: mcp.url, auth: 'header', shared: true }),
  ];
  let tainted = 0;
  const { base, as } = await relayOn(t, { settings: mcpSettings({}, 'https://c.test'), servers, secrets, taint: async () => { tainted += 1; } });
  const post = (name) => fetch(`${base}/mcp/${name}`, { method: 'POST', headers: { authorization: 'Bearer SESSION-TOKEN', 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  as({ id: 's1', kind: 'issue' });
  assert.equal((await post('tracker')).status, 200);
  assert.equal(mcp.seen[0].headers['x-api-key'], 'Token team-secret');
  assert.equal(mcp.seen[0].headers.authorization, undefined, 'the session\'s own token never reaches the server');
  assert.equal((await post('docs')).status, 200);
  assert.equal(mcp.seen[1].headers.authorization, undefined);
  const unset = await post('unset');
  assert.equal(unset.status, 503);
  assert.match((await unset.json()).error, /has no value yet/);
  assert.equal((await post('nope')).status, 404);
  assert.equal(tainted, 0, 'an ordinary server taints nothing');
  as({ id: 'p1', owner: 'joel', taintedAt: '2026-11-19T10:00:00.000Z' });
  assert.equal((await post('docs')).status, 403);
  assert.equal(mcp.seen.length, 2);
});

test('an ordinary server\'s stream open as the session\'s lockdown starts is cut, and none opens while it runs; the server\'s own query is kept', async (t) => {
  quietly(t);
  const seen = [];
  let streams = 0;
  const upstream = http.createServer((req, res) => {
    seen.push(req.url);
    if (req.method === 'GET') {
      streams += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message\ndata: {}\n\n');
      return;
    }
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const url = `http://127.0.0.1:${upstream.address().port}/mcp?tenant=acme`;
  const issuer = createOidcIssuer({ issuer: 'https://c.test', keyFile: keyFile(t) });
  const servers = createMcpServers({ store: { state: { mcpServers: [checkServer({ name: 'docs', url, shared: true })] }, save() {} }, settings: mcpSettings({}, 'https://c.test'), lockdown: () => ({ available: true }) });
  let locking = false;
  const relay = createMcpRelay({ servers, issuer, fleet: { taint: async () => {}, isLocked: () => locking }, repoOf: () => 'o/r' });
  const session = { id: 's1', kind: 'issue' };
  const server = http.createServer((req, res) => relay.handle(req, res, session));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;

  await (await fetch(`${base}/mcp/docs?tenant=other&x=1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).text();
  assert.equal(seen[0], '/mcp?tenant=acme&x=1', 'the server\'s tenant stays; the client\'s other parameter is added');

  const stream = await fetch(`${base}/mcp/docs`, { headers: { accept: 'text/event-stream' } });
  const reader = stream.body.getReader();
  await reader.read();
  assert.equal(streams, 1);
  locking = true;
  assert.equal(relay.cut('s1'), 1);
  await assert.rejects(async () => { for (;;) { const { done } = await reader.read(); if (done) throw new Error('ended'); } });
  const refused = await fetch(`${base}/mcp/docs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /being locked down/);
  assert.equal(seen.length, 2);
});
