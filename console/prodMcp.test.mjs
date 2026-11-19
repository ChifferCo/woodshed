import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { DISCOVERY_PATH, JWKS_PATH, createOidcIssuer, issuerFrom, verifyJwt } from './oidcIssuer.mjs';
import { PROD_MCP_AUDIENCE, createProdMcpRelay, isProdMcpPath, prodMcpEligibility, prodMcpSettings } from './prodMcp.mjs';

const quietly = (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
};

function keyFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oidc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'key.pem');
}

test('prodMcpSettings is off without a URL, and reads who and which repos may use it', () => {
  assert.equal(prodMcpSettings({}, 'https://c.test'), null);
  const s = prodMcpSettings({ WOODSHED_PROD_MCP_URL: 'https://mcp.test/mcp/', WOODSHED_PROD_MCP_PEOPLE: 'Joel, ana', WOODSHED_PROD_MCP_REPOS: 'o/r' }, 'https://c.test/');
  assert.equal(s.url, 'https://mcp.test/mcp');
  assert.deepEqual([...s.people], ['joel', 'ana']);
  assert.deepEqual([...s.repos], ['o/r']);
  assert.equal(s.issuer, 'https://c.test');
  assert.equal(s.removeAfterMs, 24 * 3_600_000, 'a day after it stops, unless the installation says otherwise');
  assert.equal(prodMcpSettings({ WOODSHED_PROD_MCP_URL: 'https://mcp.test', WOODSHED_PROD_MCP_REMOVE_AFTER_HOURS: '2' }, 'https://c.test').removeAfterMs, 2 * 3_600_000);
  assert.equal(prodMcpSettings({ WOODSHED_PROD_MCP_URL: 'https://mcp.test', WOODSHED_OIDC_ISSUER: 'https://id.test' }, 'https://c.test').issuer, 'https://id.test');
  assert.throws(() => prodMcpSettings({ WOODSHED_PROD_MCP_URL: 'https://u:p@mcp.test' }, 'https://c.test'), /no credentials/);
  assert.throws(() => prodMcpSettings({ WOODSHED_PROD_MCP_URL: 'https://mcp.test', WOODSHED_PROD_MCP_REMOVE_AFTER_HOURS: '0' }, 'https://c.test'), /above 0/);
  assert.throws(() => issuerFrom('https://c.test/?x=1'), /no query/);
});

test('only a private claude session of an allowed person on an allowed repo may use production', () => {
  const s = prodMcpSettings({ WOODSHED_PROD_MCP_URL: 'https://mcp.test', WOODSHED_PROD_MCP_PEOPLE: 'joel', WOODSHED_PROD_MCP_REPOS: 'o/r' }, 'https://c.test');
  const mine = { id: 'a', owner: 'Joel', kind: 'task' };
  assert.deepEqual(prodMcpEligibility(mine, s, 'O/R'), { ok: true });
  assert.match(prodMcpEligibility(mine, null, 'o/r').why, /no production access/);
  assert.match(prodMcpEligibility({ id: 'b', kind: 'issue' }, s, 'o/r').why, /only a My Woodshed session/);
  assert.match(prodMcpEligibility({ id: 'c', kind: 'ask', owner: 'joel' }, s, 'o/r').why, /only a My Woodshed session/);
  assert.match(prodMcpEligibility({ ...mine, qa: { base: 'main' } }, s, 'o/r').why, /only a My Woodshed session/);
  assert.match(prodMcpEligibility({ ...mine, review: { base: 'main' } }, s, 'o/r').why, /only a My Woodshed session/);
  assert.match(prodMcpEligibility({ ...mine, options: { agent: 'codex' } }, s, 'o/r').why, /Codex/);
  assert.match(prodMcpEligibility({ ...mine, owner: 'ana' }, s, 'o/r').why, /@ana is not allowed/);
  assert.match(prodMcpEligibility(mine, s, 'o/other').why, /o\/other is not allowed/);
  assert.ok(isProdMcpPath('/prod-mcp') && isProdMcpPath('/prod-mcp/x') && !isProdMcpPath('/prod-mcpx'));
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

async function relayOn(t, { taint, settings }) {
  const issuer = createOidcIssuer({ issuer: 'https://c.test', keyFile: keyFile(t) });
  const relay = createProdMcpRelay({ settings, issuer, fleet: { taint }, repoOf: () => 'o/r' });
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
  const settings = prodMcpSettings({ WOODSHED_PROD_MCP_URL: mcp.url, WOODSHED_PROD_MCP_PEOPLE: 'joel', WOODSHED_PROD_MCP_REPOS: 'o/r' }, 'https://c.test');
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
  const settings = prodMcpSettings({ WOODSHED_PROD_MCP_URL: mcp.url, WOODSHED_PROD_MCP_PEOPLE: 'joel', WOODSHED_PROD_MCP_REPOS: 'o/r' }, 'https://c.test');
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
