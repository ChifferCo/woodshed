import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createGeminiProxy, geminiPathAllowed, serverSideReach } from './geminiProxy.mjs';
import { createSessionApi, sessionTokenOf } from './sessionApi.mjs';

const SESSIONS = [
  { id: 'aaaaaaaa', status: 'running', token: 'agy-private', owner: 'joel', options: { agent: 'antigravity' } },
  { id: 'bbbbbbbb', status: 'running', token: 'claude-private', owner: 'joel', options: { agent: 'claude' } },
  { id: 'cccccccc', status: 'stopped', token: 'stopped', owner: 'joel', options: { agent: 'antigravity' } },
  // A claude session whose owner started an Antigravity agent beside it (fleet.allowAgent), and one that then saw production.
  { id: 'dddddddd', status: 'running', token: 'agy-beside', owner: 'joel', options: { agent: 'claude' }, extraAgents: ['antigravity'] },
  { id: 'eeeeeeee', status: 'running', token: 'agy-tainted-beside', owner: 'joel', options: { agent: 'claude' }, extraAgents: ['antigravity'], taintedAt: 1 },
  { id: 'ffffffff', status: 'running', token: 'agy-tainted', owner: 'joel', options: { agent: 'antigravity' }, taintedAt: 1 },
  { id: '11111111', status: 'running', token: 'shared', options: { agent: 'antigravity' } },
];

const STREAM = '/v1beta/models/gemini-3.1-pro-low:streamGenerateContent?alt=sse';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function setup(t, { teamKey = 'AIza-team', secrets = null } = {}) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {}\r\n\r\n');
    });
  });
  const upPort = await listen(upstream);
  const gemini = createGeminiProxy({ teamKey, secrets, upstream: `http://127.0.0.1:${upPort}` });
  const handle = createSessionApi({ fleet: { sessions: () => SESSIONS }, tokens: { token: async () => ({}) }, gemini });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => { server.close(); upstream.close(); });
  // As agy sends it: the session token is its API key, in x-goog-api-key.
  const call = (token, { path = STREAM, method = 'POST', body = '{"contents":[]}', headers = {} } = {}) => fetch(`http://127.0.0.1:${port}/gemini${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { 'x-goog-api-key': token } : {}), ...headers }, ...(method === 'POST' ? { body } : {}),
  });
  // As sent, with no tidying of `..` (fetch would resolve it before sending).
  const raw = (token, path, method = 'POST') => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: `/gemini${path}`, headers: { 'x-goog-api-key': token, 'content-type': 'application/json' } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    r.on('error', reject);
    r.end(method === 'POST' ? '{}' : undefined);
  });
  return { seen, call, raw, gemini };
}

test('an Antigravity session\'s call goes out on the team key, and its session token never reaches Google', async (t) => {
  const { seen, call } = await setup(t);
  const res = await call('agy-private');
  assert.equal(res.status, 200);
  assert.equal(seen[0].url, STREAM, 'the console\'s prefix is dropped, the query kept');
  assert.equal(seen[0].headers['x-goog-api-key'], 'AIza-team');
  assert.equal(seen[0].body, '{"contents":[]}');
  assert.ok(!JSON.stringify(seen[0].headers).includes('agy-private'));
});

test('the session token is read from x-goog-api-key, and from nowhere else', async (t) => {
  assert.equal(sessionTokenOf({ url: '/gemini/v1beta/models', headers: { 'x-goog-api-key': 'tok' } }), 'tok');
  assert.equal(sessionTokenOf({ url: '/gemini/v1beta/models', headers: { authorization: 'Bearer tok' } }), null);
  const { seen, call } = await setup(t);
  assert.equal((await call('')).status, 401, 'no key');
  assert.equal((await call(null, { headers: { authorization: 'Bearer agy-private' } })).status, 401, 'a bearer is not the key');
  assert.equal(seen.length, 0);
});

test('only an active Antigravity session may use the team key', async (t) => {
  const { seen, call } = await setup(t);
  assert.equal((await call('claude-private')).status, 403, 'a Claude session');
  assert.equal((await call('stopped')).status, 401, 'a stopped session');
  assert.equal((await call('nobody')).status, 401, 'an unknown token');
  assert.equal((await call('agy-tainted-beside')).status, 403, 'an Antigravity agent beside another, once the session saw production data');
  assert.equal(seen.length, 0, 'none of them reached Google');
  assert.equal((await call('agy-beside')).status, 200, 'an Antigravity agent beside claude');
  assert.equal(seen.length, 1);
});

test('only the calls a model turn needs pass, each with its one method', async (t) => {
  const { seen, call, raw } = await setup(t);
  assert.equal((await call('agy-private', { path: '/v1beta/models/gemini-3.1-pro-low:generateContent', body: '{}' })).status, 200);
  assert.equal((await call('agy-private', { path: '/v1beta/models/gemini-3.1-pro-low:countTokens', body: '{}' })).status, 200);
  assert.equal((await call('agy-private', { path: '/v1beta/models', method: 'GET' })).status, 200);
  assert.equal((await call('agy-private', { path: '/v1beta/models/gemini-3.1-pro-low', method: 'GET' })).status, 200);
  assert.equal(seen.length, 4);
  // What the team's key could also do, and a method that makes a path another call.
  for (const path of ['/upload/v1beta/files', '/v1beta/files', '/v1beta/cachedContents', '/v1beta/tunedModels', '/v1beta/batches', '/v1beta/models/x:batchEmbedContents', '/v1beta/models/x:streamGenerateContent/extra']) {
    assert.equal((await call('agy-private', { path, body: '{}' })).status, 404, path);
  }
  assert.equal((await call('agy-private', { path: STREAM, method: 'GET' })).status, 404, 'a GET of a generate call');
  assert.equal((await call('agy-private', { path: '/v1beta/models', body: '{}' })).status, 404, 'a POST of the model list');
  // A key in the query, a query that turns a call into another, and every way to walk out of the path.
  assert.equal((await call('agy-private', { path: `${STREAM}&key=AIza-mine` })).status, 404);
  assert.equal((await call('agy-private', { path: `${STREAM.split('?')[0]}?alt=json&$fields=name` })).status, 404);
  for (const path of ['/v1beta/models/../files', '/v1beta/models/%2e%2e/files', '/v1beta/models/x:countTokens/%2e%2e', '/v1beta//models', '/v1beta/models\\..\\files']) {
    assert.equal(await raw('agy-private', path), 404, path);
  }
  assert.equal(seen.length, 4, 'none of those reached Google');
});

test('a call that carries the team\'s key header or a user project is sent on with only the team\'s', async (t) => {
  const { seen, call } = await setup(t);
  await call('agy-private', { headers: { 'x-goog-user-project': 'someone-elses', authorization: 'Bearer ya29.mine', cookie: 'a=b', 'x-goog-api-client': 'gl-go/1' } });
  assert.equal(seen[0].headers['x-goog-api-key'], 'AIza-team');
  assert.equal(seen[0].headers['x-goog-user-project'], undefined);
  assert.equal(seen[0].headers.authorization, undefined);
  assert.equal(seen[0].headers.cookie, undefined);
  assert.equal(seen[0].headers['x-goog-api-client'], 'gl-go/1', 'the client\'s own version header goes on');
});

test('with no team key saved the call says so, and nothing goes to Google', async (t) => {
  const { seen, call } = await setup(t, { teamKey: null });
  const res = await call('agy-private');
  assert.equal(res.status, 503);
  assert.match((await res.json()).error.message, /gemini-api-key/);
  assert.equal(seen.length, 0);
});

test('the team key is read from the secret store, kept for a few minutes, and a failed read fails the call', async (t) => {
  let reads = 0;
  let fail = false;
  const secrets = { read: async (name) => { reads += 1; assert.equal(name, 'gemini-api-key'); if (fail) throw new Error('store down'); return 'AIza-stored'; } };
  const { seen, call, gemini } = await setup(t, { secrets, teamKey: 'AIza-env' });
  await call('agy-private');
  await call('agy-private');
  assert.equal(seen[0].headers['x-goog-api-key'], 'AIza-stored', 'the stored key wins over the environment\'s');
  assert.equal(reads, 1, 'read once for both');
  assert.equal(await gemini.teamCredential(), 'AIza-stored');
  const down = createGeminiProxy({ secrets: { read: async () => { throw new Error('store down'); } } });
  await assert.rejects(down.teamCredential(), /store down/);
  fail = true;
});

test('a session is an Antigravity session by its options, as a Codex one is; fleet starts none without an owner', async (t) => {
  const { seen, call } = await setup(t);
  assert.equal((await call('shared')).status, 200);
  assert.equal(seen.length, 1);
});

test('a session that has seen production data has each call read first', async (t) => {
  const { seen, call } = await setup(t);
  assert.equal((await call('agy-tainted', { body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }] }) })).status, 200, 'a plain turn goes');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].body, JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }] }), 'the body sent on is the one read');
  for (const body of [
    { tools: [{ googleSearch: {} }] },
    { tools: [{ functionDeclarations: [] }, { urlContext: {} }] },
    { tools: [{ google_search_retrieval: {} }] },
    { cachedContent: 'cachedContents/abc' },
    { contents: [{ parts: [{ fileData: { fileUri: 'https://example.com/a.pdf' } }] }] },
    { contents: [{ parts: [{ file_data: { file_uri: 'https://www.youtube.com/watch?v=x' } }] }] },
  ]) {
    const res = await call('agy-tainted', { body: JSON.stringify(body) });
    assert.equal(res.status, 403, JSON.stringify(body).slice(0, 60));
    assert.match((await res.json()).error.message, /seen production data/);
  }
  assert.equal((await call('agy-tainted', { body: 'not json' })).status, 400);
  assert.equal((await call('agy-tainted', { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal(seen.length, 1, 'none of those reached Google');
  // A session that has not seen it is not read at all.
  assert.equal((await call('agy-private', { body: 'not json' })).status, 200);
});

test('serverSideReach names what would have Google reach out, and nothing else', () => {
  assert.equal(serverSideReach({ contents: [], tools: [{ functionDeclarations: [{ name: 'run_command' }] }] }), null);
  assert.equal(serverSideReach({ tools: [{ googleSearch: {} }] }), 'the googleSearch tool');
  assert.equal(serverSideReach({ contents: [{ parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }] }] }), null, 'inline data is the session\'s own');
  assert.equal(serverSideReach(null), null);
});

test('geminiPathAllowed returns the path and query as they go on', () => {
  assert.equal(geminiPathAllowed('/v1beta/models/m:streamGenerateContent?alt=sse', 'POST'), '/v1beta/models/m:streamGenerateContent?alt=sse');
  assert.equal(geminiPathAllowed('/v1/models/m:generateContent', 'POST'), '/v1/models/m:generateContent');
  assert.equal(geminiPathAllowed('/v1beta/models?pageSize=50', 'GET'), '/v1beta/models?pageSize=50');
  assert.equal(geminiPathAllowed('/v1beta/models/m:generateContent', 'GET'), null);
  assert.equal(geminiPathAllowed('/v1beta/models/m:generateContent#x', 'POST'), null);
});

test('lockdown cuts the calls of a session still on their way', async (t) => {
  const open = [];
  const upstream = http.createServer((req) => { open.push(req); });
  const upPort = await listen(upstream);
  const gemini = createGeminiProxy({ teamKey: 'AIza-team', upstream: `http://127.0.0.1:${upPort}` });
  const handle = createSessionApi({ fleet: { sessions: () => SESSIONS }, tokens: { token: async () => ({}) }, gemini });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => { server.close(); upstream.close(); });
  const pending = fetch(`http://127.0.0.1:${port}/gemini${STREAM}`, { method: 'POST', headers: { 'x-goog-api-key': 'agy-private' }, body: '{}' }).catch((err) => err);
  while (!open.length) await new Promise((r) => setTimeout(r, 10));
  gemini.cut('aaaaaaaa');
  const result = await pending;
  assert.ok(result instanceof Error || result.status >= 500, 'the call ended with no answer');
});
