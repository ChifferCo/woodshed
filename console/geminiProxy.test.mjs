import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createGeminiProxy, geminiPathAllowed, serverSideReach, storedResource } from './geminiProxy.mjs';
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
  // The sessions whose lockdown has started (fleet.isLocked), which the proxy asks as a call arrives and again before it goes.
  const locked = new Set();
  const handle = createSessionApi({ fleet: { sessions: () => SESSIONS, isLocked: (s) => locked.has(s.id) }, tokens: { token: async () => ({}) }, gemini });
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
  return { seen, call, raw, gemini, locked, port };
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

test('the team\'s Gemini key is read from the secret store alone, never from the environment the fleet copies into sessions', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('./installation.mjs', import.meta.url), 'utf8');
  const wiring = source.split('\n').filter((line) => line.includes('createGeminiProxy(')).join('\n');
  assert.ok(wiring, 'the installation makes the proxy');
  // `config.sessionEnv` is the map every launch gets (the docker launcher passes it as it is): a key read from it is every
  // session's. An embedding program that keeps the key itself passes `teamKey`; the console never does.
  assert.ok(!/sessionEnv|GEMINI_API_KEY|teamKey/.test(wiring), `the installation wires the proxy to ${wiring}`);
  // With nothing in the store the proxy has no key, whatever a session's environment holds.
  const proxy = createGeminiProxy({ secrets: { read: async () => null } });
  assert.equal(await proxy.teamCredential(), null);
});

test('a session is an Antigravity session by its options, as a Codex one is; fleet starts none without an owner', async (t) => {
  const { seen, call } = await setup(t);
  assert.equal((await call('shared')).status, 200);
  assert.equal(seen.length, 1);
});

// What names something stored under the team's key, in the shapes a call can carry it.
const STORED = [
  { name: 'a file by its Files API name', body: { contents: [{ role: 'user', parts: [{ fileData: { fileUri: 'https://generativelanguage.googleapis.com/v1beta/files/abc123', mimeType: 'text/plain' } }] }] } },
  { name: 'a file by snake_case', body: { contents: [{ parts: [{ file_data: { file_uri: 'files/abc123' } }] }] } },
  { name: 'a file by any address', body: { contents: [{ parts: [{ fileData: { fileUri: 'https://example.com/a.pdf' } }] }] } },
  { name: 'a file in the system instruction', body: { systemInstruction: { parts: [{ fileData: { fileUri: 'files/abc123' } }] }, contents: [] } },
  { name: 'a file in a count\'s wrapped request', body: { generateContentRequest: { model: 'models/m', contents: [{ parts: [{ fileData: { fileUri: 'files/abc123' } }] }] } } },
  { name: 'a cached content', body: { cachedContent: 'cachedContents/abc123', contents: [] } },
  { name: 'a cached content by snake_case', body: { cached_content: 'cachedContents/abc123', contents: [] } },
  { name: 'a cached content in a count\'s wrapped request', body: { generateContentRequest: { model: 'models/m', cachedContent: 'cachedContents/abc123' } } },
  { name: 'a file search store', body: { contents: [], tools: [{ fileSearch: { fileSearchStoreNames: ['fileSearchStores/abc'] } }] } },
];

test('an ordinary session\'s call that names a file, a cache or a store under the team key is refused, and a plain one still goes', async (t) => {
  const { seen, call } = await setup(t);
  const text = JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hello' }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } }] }], tools: [{ functionDeclarations: [{ name: 'run_command' }] }] });
  assert.equal((await call('agy-private', { body: text })).status, 200, 'text, inline data and function tools go');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].body, text, 'the body sent on is the one read');
  for (const { name, body } of STORED) {
    for (const [who, token] of [['an Antigravity session', 'agy-private'], ['an agent beside claude', 'agy-beside']]) {
      const res = await call(token, { body: JSON.stringify(body) });
      assert.equal(res.status, 403, `${name}, from ${who}`);
      assert.match((await res.json()).error.message, /whoever stored it/);
    }
    assert.equal((await call('agy-private', { path: '/v1beta/models/m:countTokens', body: JSON.stringify(body) })).status, 403, `${name}, in a count`);
  }
  assert.equal(seen.length, 1, 'none of those reached Google');
  // A call the console cannot read does not go either, whoever sends it.
  assert.equal((await call('agy-private', { body: 'not json' })).status, 400);
  assert.equal((await call('agy-private', { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal(seen.length, 1);
});

test('a session that has seen production data is also refused what has Google reach out for it', async (t) => {
  const { seen, call } = await setup(t);
  assert.equal((await call('agy-tainted', { body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }] }) })).status, 200, 'a plain turn goes');
  assert.equal(seen.length, 1);
  for (const body of [
    { tools: [{ googleSearch: {} }] },
    { tools: [{ functionDeclarations: [] }, { urlContext: {} }] },
    { tools: [{ google_search_retrieval: {} }] },
    ...STORED.map((s) => s.body),
  ]) {
    const res = await call('agy-tainted', { body: JSON.stringify(body) });
    assert.equal(res.status, 403, JSON.stringify(body).slice(0, 60));
  }
  assert.equal((await call('agy-tainted', { body: 'not json' })).status, 400);
  assert.equal((await call('agy-tainted', { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal(seen.length, 1, 'none of those reached Google');
  // Google Search grounding is an ordinary session's to use: it reaches out only for a session that holds production data.
  assert.equal((await call('agy-private', { body: JSON.stringify({ tools: [{ googleSearch: {} }] }) })).status, 200);
});

test('serverSideReach names what would have Google reach out, and storedResource what is stored under the key', () => {
  assert.equal(serverSideReach({ contents: [], tools: [{ functionDeclarations: [{ name: 'run_command' }] }] }), null);
  assert.equal(serverSideReach({ tools: [{ googleSearch: {} }] }), 'the googleSearch tool');
  assert.equal(serverSideReach(null), null);
  assert.equal(storedResource({ contents: [{ parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }] }] }), null, 'inline data is the session\'s own');
  assert.equal(storedResource({ contents: [{ parts: [{ text: 'a cachedContent mention in text' }] }] }), null, 'only a field, not a word');
  assert.equal(storedResource(null), null);
  for (const { body } of STORED) assert.ok(storedResource(body), JSON.stringify(body).slice(0, 60));
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
  const pending = fetch(`http://127.0.0.1:${port}/gemini${STREAM}`, { method: 'POST', headers: { 'x-goog-api-key': 'agy-private', 'content-type': 'application/json' }, body: '{}' }).catch((err) => err);
  for (let waited = 0; !open.length; waited += 10) {
    assert.ok(waited < 3000, 'the call reached the upstream');
    await new Promise((r) => setTimeout(r, 10));
  }
  gemini.cut('aaaaaaaa');
  const result = await pending;
  assert.ok(result instanceof Error || result.status >= 500, 'the call ended with no answer');
});

// A call whose body is held open: its head sent, its body not finished, until `finish` is called.
function heldCall(port, token, { path = STREAM, chunks = ['{"contents":[{"role":"user","parts":[', '{"text":"hello"}]}]}'] } = {}) {
  let resolve;
  const outcome = new Promise((r) => { resolve = r; });
  const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: `/gemini${path}`, headers: { 'x-goog-api-key': token, 'content-type': 'application/json', 'transfer-encoding': 'chunked' } },
    (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); });
  r.on('error', (err) => resolve({ error: err.code ?? err.message }));
  r.write(chunks[0]);
  return { outcome, finish: () => { try { r.end(chunks[1]); } catch { /* the connection is gone: that is the point */ } } };
}
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

test('a call still uploading when its session\'s lockdown starts is cut, and nothing of it reaches Google', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const { seen, gemini, port } = await setup(t);
  // The first part of the body is sent and the proxy has authorized the call, which waits for the rest.
  const held = heldCall(port, 'agy-beside');
  await settle();
  gemini.cut('dddddddd');
  held.finish();
  const result = await held.outcome;
  assert.ok(result.error || result.status >= 400, `the call ended with no answer from Google: ${JSON.stringify(result)}`);
  await settle();
  assert.equal(seen.length, 0, 'the stand-in for Google received nothing');
});

test('a call whose body finishes after the lockdown began is refused when it would go, even if nothing cut it', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const { seen, locked, port } = await setup(t);
  const held = heldCall(port, 'agy-beside');
  await settle();
  // The lockdown started (fleet.isLocked) but the cut did not reach this call: the last check before it goes still refuses.
  locked.add('dddddddd');
  held.finish();
  const result = await held.outcome;
  assert.equal(result.status, 403);
  await settle();
  assert.equal(seen.length, 0, 'none of it reached Google');
  // A call that arrives locked is refused at once.
  assert.equal((await fetch(`http://127.0.0.1:${port}/gemini${STREAM}`, { method: 'POST', headers: { 'x-goog-api-key': 'agy-beside', 'content-type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal(seen.length, 0);
});

test('a session tainted while its body arrives has that call checked as a tainted one', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const sessions = [{ id: '22222222', status: 'running', token: 'agy-late', owner: 'joel', options: { agent: 'antigravity' } }];
  const upstream = http.createServer((req) => { req.resume(); });
  const upPort = await listen(upstream);
  let reached = 0;
  upstream.on('request', () => { reached += 1; });
  const gemini = createGeminiProxy({ teamKey: 'AIza-team', upstream: `http://127.0.0.1:${upPort}` });
  const handle = createSessionApi({ fleet: { sessions: () => sessions }, tokens: { token: async () => ({}) }, gemini });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => { server.close(); upstream.close(); });
  const held = heldCall(port, 'agy-late', { chunks: ['{"tools":[{"google', 'Search":{}}],"contents":[]}'] });
  await settle();
  sessions[0].taintedAt = 1;
  held.finish();
  const result = await held.outcome;
  assert.equal(result.status, 403, 'Google Search is off for a session that has seen production data, as the call finished');
  assert.equal(reached, 0);
});

test('a file search store or a reach tool inside a count\'s wrapped request is found too', () => {
  const wrapped = (tool) => ({ generateContentRequest: { model: 'models/m', contents: [], tools: [tool] } });
  assert.equal(storedResource(wrapped({ fileSearch: { fileSearchStoreNames: ['fileSearchStores/a'] } })), 'a file search store');
  assert.equal(storedResource(wrapped({ file_search: {} })), 'a file search store');
  assert.equal(storedResource(wrapped({ functionDeclarations: [] })), null);
  assert.equal(serverSideReach(wrapped({ googleSearch: {} })), 'the googleSearch tool');
  assert.equal(serverSideReach(wrapped({ urlContext: {} })), 'the urlContext tool');
  assert.equal(serverSideReach(wrapped({ functionDeclarations: [] })), null);
});

test('the bodies of calls held at once are bounded for the whole console: past it a call is told to try again, and the room comes back', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const seen = [];
  const upstream = http.createServer((req, res) => { req.resume(); req.on('end', () => { seen.push(req.url); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {}\r\n\r\n'); }); });
  const upPort = await listen(upstream);
  // Room for 500 bytes of bodies at once.
  const gemini = createGeminiProxy({ teamKey: 'AIza-team', upstream: `http://127.0.0.1:${upPort}`, maxInflightBytes: 500 });
  const handle = createSessionApi({ fleet: { sessions: () => SESSIONS }, tokens: { token: async () => ({}) }, gemini });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => { server.close(); upstream.close(); });
  const part = (n) => `{"contents":[{"parts":[{"text":"${'x'.repeat(n)}`;
  const rest = '"}]}]}';

  // One call has sent 400 bytes of its body and waits to send the rest.
  const first = heldCall(port, 'agy-private', { chunks: [part(400), rest] });
  await settle();
  // Another that would take it past 500 is told to try again, and nothing of it goes to Google.
  const busy = await new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: `/gemini${STREAM}`, headers: { 'x-goog-api-key': 'agy-beside', 'content-type': 'application/json' } },
      (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, retryAfter: res.headers['retry-after'] })); });
    r.on('error', reject);
    r.end(part(300) + rest);
  });
  assert.equal(busy.status, 503);
  assert.equal(busy.retryAfter, '5');
  assert.equal(seen.length, 0);
  // The first one finishes and goes: what it held, and what the refused one counted, are given back.
  first.finish();
  assert.equal((await first.outcome).status, 200);
  assert.equal(seen.length, 1);
  await settle();
  const again = await fetch(`http://127.0.0.1:${port}/gemini${STREAM}`, { method: 'POST', headers: { 'x-goog-api-key': 'agy-beside', 'content-type': 'application/json' }, body: part(300) + rest });
  assert.equal(again.status, 200, 'there is room again');
  // A call that gives up mid-body gives its bytes back too: after one that sent 400 bytes and was dropped, one this size fits.
  const aborted = http.request({ host: '127.0.0.1', port, method: 'POST', path: `/gemini${STREAM}`, headers: { 'x-goog-api-key': 'agy-beside', 'content-type': 'application/json', 'transfer-encoding': 'chunked' } });
  aborted.on('error', () => {});
  aborted.write(part(400));
  await settle();
  aborted.destroy();
  await settle();
  const afterAbort = await fetch(`http://127.0.0.1:${port}/gemini${STREAM}`, { method: 'POST', headers: { 'x-goog-api-key': 'agy-beside', 'content-type': 'application/json' }, body: part(300) + rest });
  assert.equal(afterAbort.status, 200, 'the dropped call\'s bytes were given back');
});
