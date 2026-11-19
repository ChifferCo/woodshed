import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createOpenAiProxy } from './openaiProxy.mjs';
import { createSessionApi } from './sessionApi.mjs';

const SESSIONS = [
  { id: 'aaaaaaaa', status: 'running', token: 'codex-private', owner: 'joel', options: { agent: 'codex' } },
  { id: 'bbbbbbbb', status: 'running', token: 'claude-private', owner: 'joel', options: { agent: 'claude' } },
  { id: 'cccccccc', status: 'stopped', token: 'stopped', owner: 'joel', options: { agent: 'codex' } },
  { id: 'dddddddd', status: 'running', token: 'review-both', trigger: 'review', review: { base: 'main', agents: ['claude', 'codex'] } },
  { id: 'eeeeeeee', status: 'running', token: 'review-claude', trigger: 'review', review: { base: 'main', agents: ['claude'] } },
  { id: 'ffffffff', status: 'running', token: 'review-ana', trigger: 'review', review: { base: 'main', agents: ['claude', 'codex'], codexLogin: 'ana', codexVia: 'chatgpt' } },
  { id: '11111111', status: 'running', token: 'review-cy', trigger: 'review', review: { base: 'main', agents: ['claude', 'codex'], codexLogin: 'cy', codexVia: 'key' } },
];

const jwt = (exp) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;
const NOW = Date.parse('2026-11-18T10:00:00Z');
const SIGN_INS = {
  ana: JSON.stringify({ tokens: { access_token: jwt(NOW / 1000 + 86400), refresh_token: 'rt-ana', account_id: 'acct-ana' } }),
  cy: 'sk-cy',
};

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function setup(t, { teamKey = 'sk-team', own = ['ana', 'cy'], signIns = SIGN_INS } = {}) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {}\n\n');
    });
  });
  const upPort = await listen(upstream);
  const userSettings = { usesOwnCodexForReviews: (login) => own.includes(login), codexAuth: async (login) => signIns[login] ?? null };
  const openai = createOpenAiProxy({ teamKey, userSettings, upstream: `http://127.0.0.1:${upPort}`, chatgptUpstream: `http://127.0.0.1:${upPort}`, now: () => NOW });
  const handle = createSessionApi({ fleet: { sessions: () => SESSIONS }, tokens: { token: async () => ({}) }, openai });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => { server.close(); upstream.close(); });
  const call = (token) => fetch(`http://127.0.0.1:${port}/openai/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: '{"model":"gpt-5.5"}',
  });
  const chatgpt = (token, p = '/backend-api/codex/responses', headers = {}) => fetch(`http://127.0.0.1:${port}/chatgpt${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers }, body: '{"model":"gpt-6.1-sol"}',
  });
  // As sent, with no tidying of `..` (fetch would resolve it before sending).
  const raw = (token, p, prefix = '/chatgpt', method = 'POST') => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: `${prefix}${p}`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    r.on('error', reject);
    r.end(method === 'POST' ? '{}' : undefined);
  });
  return { seen, call, chatgpt, raw };
}

test('a Codex session\'s call goes out on the team key, and its session token never reaches OpenAI', async (t) => {
  const { seen, call } = await setup(t);
  const res = await call('codex-private');
  assert.equal(res.status, 200);
  assert.equal(seen[0].url, '/v1/responses', 'the console\'s prefix is dropped');
  assert.equal(seen[0].headers.authorization, 'Bearer sk-team');
  assert.equal(seen[0].body, '{"model":"gpt-5.5"}');
  assert.ok(!JSON.stringify(seen[0].headers).includes('codex-private'));
});

test('only an active Codex session may use the team key', async (t) => {
  const { seen, call } = await setup(t);
  assert.equal((await call('claude-private')).status, 403, 'a Claude session');
  assert.equal((await call('stopped')).status, 401, 'a stopped session');
  assert.equal((await call(null)).status, 401, 'no token');
  assert.equal(seen.length, 0, 'nothing reached OpenAI');
});

test('a review session reaches the team key only when Codex reviews in it too', async (t) => {
  const { seen, call } = await setup(t);
  assert.equal((await call('review-both')).status, 200, 'Codex beside Claude Code');
  assert.equal(seen[0].headers.authorization, 'Bearer sk-team');
  assert.equal((await call('review-claude')).status, 403, 'Claude Code alone');
  assert.equal(seen.length, 1);
});

test('with no team key saved the session is told where to save one', async (t) => {
  const { call } = await setup(t, { teamKey: null });
  const res = await call('codex-private');
  assert.equal(res.status, 503);
  assert.match((await res.json()).error.message, /openai-api-key/);
});

test('a review on its author\'s ChatGPT login reaches ChatGPT with that login, which never reaches the session', async (t) => {
  const { seen, chatgpt } = await setup(t);
  const res = await chatgpt('review-ana', '/backend-api/codex/responses', { 'chatgpt-account-id': 'woodshed-stand-in', cookie: 'x=1' });
  assert.equal(res.status, 200);
  assert.equal(seen[0].url, '/backend-api/codex/responses', 'the console\'s prefix is dropped');
  assert.equal(seen[0].headers.authorization, `Bearer ${JSON.parse(SIGN_INS.ana).tokens.access_token}`);
  assert.equal(seen[0].headers['chatgpt-account-id'], 'acct-ana', 'the author\'s account, not the stand-in\'s');
  assert.equal(seen[0].headers.cookie, undefined);
  assert.ok(!JSON.stringify(seen[0].headers).includes('review-ana'), 'the session token stays here');
  assert.ok(!JSON.stringify(seen[0].headers).includes('rt-ana'), 'the refresh token never leaves the console');
  assert.equal((await chatgpt('review-ana', '/backend-api/wham/accounts/check')).status, 200, 'codex\'s account check');
});

test('ChatGPT is only Codex\'s API, and only for a review on its author\'s ChatGPT login', async (t) => {
  const { seen, chatgpt } = await setup(t);
  assert.equal((await chatgpt('review-ana', '/backend-api/conversations')).status, 404, 'the author\'s chats are not Codex\'s');
  assert.equal((await chatgpt('review-ana', '/backend-api/ps/plugins/installed')).status, 404);
  assert.equal((await chatgpt('review-both')).status, 403, 'a review on the team key');
  assert.equal((await chatgpt('review-cy')).status, 403, 'a review on its author\'s API key');
  assert.equal((await chatgpt('codex-private')).status, 403, 'a private Codex session');
  assert.equal(seen.length, 0, 'nothing reached ChatGPT');
});

test('a review on its author\'s API key goes to OpenAI on that key, not the team\'s', async (t) => {
  const { seen, call } = await setup(t);
  assert.equal((await call('review-cy')).status, 200);
  assert.equal(seen[0].headers.authorization, 'Bearer sk-cy');
});

test('an author who turned it off, or whose login expired, since the review started is refused at the next call', async (t) => {
  const off = await setup(t, { own: [] });
  const res = await off.chatgpt('review-ana');
  assert.equal(res.status, 403);
  assert.match((await res.json()).error.message, /no longer has their Codex sign-in on for reviews/);
  const expired = await setup(t, { signIns: { ana: JSON.stringify({ tokens: { access_token: jwt(NOW / 1000 - 60), account_id: 'acct-ana' } }) } });
  const old = await expired.chatgpt('review-ana');
  assert.equal(old.status, 403);
  assert.match((await old.json()).error.message, /has expired/);
  assert.equal(off.seen.length + expired.seen.length, 0);
});

test('a path that climbs out of Codex\'s API, plainly or escaped, never reaches ChatGPT', async (t) => {
  const { seen, raw } = await setup(t);
  for (const p of ['/backend-api/codex/../conversations', '/backend-api/codex/%2e%2e/conversations', '/backend-api/codex/..%2Fconversations',
    '/backend-api/codex/./../conversations', '/backend-api/codex//../conversations', '/backend-api/codex/..\\conversations',
    '/backend-api/wham/accounts/check/../../conversations']) {
    assert.equal(await raw('review-ana', p), 404, p);
  }
  assert.equal(seen.length, 0, 'nothing reached ChatGPT');
  assert.equal(await raw('review-ana', '/backend-api/codex/models?client_version=1'), 200);
  assert.equal(seen[0].url, '/backend-api/codex/models?client_version=1', 'what was checked is what is forwarded');
});

test('a review on a key reaches Codex\'s calls alone, never the key\'s files or anything else, while a private Codex session is unchanged', async (t) => {
  const { seen, raw } = await setup(t);
  for (const token of ['review-cy', 'review-both']) {
    for (const p of ['/v1/files', '/v1/files/file-abc', '/v1/vector_stores', '/v1/fine_tuning/jobs', '/v1/responses/../files',
      '/v1/%72esponses', '/v1/responses/resp_123', '/v1//responses']) {
      assert.equal(await raw(token, p, '/openai', p === '/v1/files/file-abc' ? 'DELETE' : 'POST'), 404, `${token} ${p}`);
    }
  }
  assert.equal(seen.length, 0, 'nothing reached OpenAI');
  assert.equal(await raw('review-cy', '/v1/responses', '/openai'), 200, 'the author\'s key');
  assert.equal(seen[0].headers.authorization, 'Bearer sk-cy');
  assert.equal(await raw('review-both', '/v1/responses/compact', '/openai'), 200, 'the team key');
  assert.equal(await raw('review-both', '/v1/models', '/openai', 'GET'), 200);
  assert.equal(await raw('codex-private', '/v1/files', '/openai', 'GET'), 200, 'a private Codex session is its owner\'s, as before');
});
