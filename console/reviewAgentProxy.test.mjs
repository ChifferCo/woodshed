import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createReviewAgentProxy, reviewAgentRoute, reviewAgentTokenOf } from './reviewAgentProxy.mjs';
import { createSessionApi, sessionTokenOf } from './sessionApi.mjs';

const NOW = Date.parse('2026-11-18T10:00:00Z');
const review = (agents, ownSignIns) => ({ trigger: 'review', review: { base: 'main', agents, ownSignIns } });
const SESSIONS = [
  { id: 'aaaaaaaa', status: 'running', token: 'review-gil', ...review(['claude', 'grok'], { grok: { login: 'gil', via: 'key' } }) },
  { id: 'bbbbbbbb', status: 'running', token: 'review-lou', ...review(['grok'], { grok: { login: 'lou', via: 'login' } }) },
  { id: 'cccccccc', status: 'running', token: 'review-old', ...review(['grok'], { grok: { login: 'old', via: 'login' } }) },
  { id: 'dddddddd', status: 'running', token: 'review-oto', ...review(['claude', 'opencode'], { opencode: { login: 'oto', provider: 'anthropic' } }) },
  { id: 'eeeeeeee', status: 'running', token: 'review-claude', ...review(['claude']) },
  { id: 'ffffffff', status: 'running', token: 'private-grok', owner: 'gil', options: { agent: 'grok' } },
  { id: '11111111', status: 'stopped', token: 'review-stopped', ...review(['grok'], { grok: { login: 'gil', via: 'key' } }) },
  { id: '22222222', status: 'running', token: 'review-tainted', taintedAt: '2026-11-18T09:00:00Z', ...review(['grok'], { grok: { login: 'gil', via: 'key' } }) },
  { id: '33333333', status: 'running', token: 'review-ovi', ...review(['opencode'], { opencode: { login: 'ovi', provider: 'openai' } }) },
  // A review that lists grok but recorded no author's sign-in for it: there is no team key to fall back on.
  { id: '44444444', status: 'running', token: 'review-nobody', ...review(['claude', 'grok']) },
];

// Made-up sign-ins: an xAI key, a login and an expired one, and OpenCode's auth.json with API keys.
const SIGN_INS = {
  grok: {
    gil: 'xai-made-up-gil-0123456789',
    lou: JSON.stringify({ 'https://auth.x.ai::made-up': { key: 'made-up-lou-access', refresh_token: 'made-up-lou-refresh', expires_at: '2026-11-18T12:00:00Z' } }),
    old: JSON.stringify({ 'https://auth.x.ai::made-up': { key: 'made-up-old-access', refresh_token: 'made-up-old-refresh', expires_at: '2026-11-18T09:00:00Z' } }),
  },
  opencode: {
    oto: JSON.stringify({ anthropic: { type: 'api', key: 'sk-ant-made-up-oto' }, openai: { type: 'api', key: 'sk-made-up-oto' } }),
    ovi: JSON.stringify({ openai: { type: 'api', key: 'sk-made-up-ovi' } }),
  },
};

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function setup(t, { on = { grok: ['gil', 'lou', 'old'], opencode: ['oto', 'ovi'] }, signIns = SIGN_INS } = {}) {
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
  const up = `http://127.0.0.1:${await listen(upstream)}`;
  const userSettings = {
    usesOwnAgentForReviews: (login, id) => (on[id] ?? []).includes(login),
    agentAuth: async (login, id) => signIns[id]?.[login] ?? null,
  };
  const reviewAgentProxy = createReviewAgentProxy({
    userSettings, now: () => NOW,
    grokUpstreams: { key: `${up}/xai/v1`, login: `${up}/grok-login/v1` }, opencodeUpstreams: { anthropic: `${up}/anthropic`, openai: `${up}/openai` },
  });
  const handle = createSessionApi({ fleet: { sessions: () => SESSIONS }, tokens: { token: async () => ({}) }, reviewAgentProxy });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => { server.close(); upstream.close(); });
  // As sent, with no tidying of `..` (fetch would resolve it before sending).
  const call = (token, path = '/grok/v1/chat/completions', { method = 'POST', header = 'authorization' } = {}) => new Promise((resolve, reject) => {
    const auth = token ? { [header]: header === 'authorization' ? `Bearer ${token}` : token } : {};
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', 'x-grok-client-mode': 'headless', ...auth } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    r.on('error', reject);
    r.end(method === 'POST' ? '{"model":"grok-build"}' : undefined);
  });
  return { seen, call };
}

function logged(t) {
  const lines = [];
  for (const level of ['log', 'warn']) t.mock.method(console, level, (...args) => lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')));
  return lines;
}

test('a review\'s grok goes out on its author\'s xAI key, and its session token never reaches xAI', async (t) => {
  const lines = logged(t);
  const { seen, call } = await setup(t);
  const res = await call('review-gil');
  assert.equal(res.status, 200);
  assert.equal(seen[0].url, '/xai/v1/chat/completions', 'the console\'s prefix is dropped, under the key\'s API');
  assert.equal(seen[0].headers.authorization, 'Bearer xai-made-up-gil-0123456789');
  assert.equal(seen[0].headers['x-grok-client-mode'], 'headless', 'grok\'s own headers go along');
  assert.equal(seen[0].body, '{"model":"grok-build"}');
  assert.ok(!JSON.stringify(seen[0].headers).includes('review-gil'));
  assert.equal((await call('review-gil', '/grok/v1/models', { method: 'GET' })).status, 200);
  assert.equal((await call('review-gil', '/grok/v1/responses')).status, 200);
  assert.ok(lines.some((l) => l.includes('reviewAgentProxy: first call on the author\'s Grok Build sign-in') && l.includes('"via":"key"')));
  assert.ok(!lines.join('\n').includes('made-up-gil'), 'no sign-in is logged');
});

test('a review on its author\'s Grok login goes to the login\'s API with its access token, and never refreshes it', async (t) => {
  const { seen, call } = await setup(t);
  assert.equal((await call('review-lou')).status, 200);
  assert.equal(seen[0].url, '/grok-login/v1/chat/completions');
  assert.equal(seen[0].headers.authorization, 'Bearer made-up-lou-access');
  assert.ok(!seen.some((s) => s.body.includes('refresh')), 'the refresh token goes nowhere');
});

test('an expired Grok login is refused, and says so to the review', async (t) => {
  const lines = logged(t);
  const { seen, call } = await setup(t);
  const res = await call('review-old');
  assert.equal(res.status, 403);
  assert.match(JSON.parse(res.body).error.message, /@old's saved Grok Build login has expired/);
  assert.equal(seen.length, 0);
  assert.ok(lines.some((l) => l.includes('reviewAgentProxy: refused, the author\'s sign-in not usable')));
});

test('a switch turned off, or a sign-in removed, since the review started stops it at the next call', async (t) => {
  const off = await setup(t, { on: { grok: [] } });
  const res = await off.call('review-gil');
  assert.equal(res.status, 403);
  assert.match(JSON.parse(res.body).error.message, /@gil no longer has their Grok Build sign-in on for reviews/);
  const gone = await setup(t, { signIns: { grok: {}, opencode: {} } });
  assert.match(JSON.parse((await gone.call('review-gil')).body).error.message, /@gil has no Grok Build sign-in saved/);
  assert.equal(off.seen.length + gone.seen.length, 0);
});

test('only a review that runs the agent on its author\'s sign-in gets through: no other session, and no one else\'s', async (t) => {
  const lines = logged(t);
  const { seen, call } = await setup(t);
  assert.equal((await call('private-grok')).status, 403, 'a private Grok session runs on its own sign-in, never through here');
  assert.equal((await call('review-claude')).status, 403, 'a review that does not run grok');
  assert.equal((await call('review-nobody')).status, 403, 'a review with no author\'s sign-in recorded: no team key to fall back on');
  assert.equal((await call('review-oto')).status, 403, 'a review whose OpenCode runs, asking for grok');
  assert.equal((await call('review-stopped')).status, 401, 'a stopped session');
  assert.equal((await call(null)).status, 401, 'no token');
  assert.equal((await call('review-tainted')).status, 403, 'a tainted session');
  assert.equal(seen.length, 0, 'nothing reached xAI');
  assert.ok(lines.some((l) => l.includes('reviewAgentProxy: refused, not a review session')));
  assert.ok(lines.some((l) => l.includes('reviewAgentProxy: refused, the review does not run it')));
});

test('the author\'s sign-in is the review\'s recorded author\'s, whoever else has one on', async (t) => {
  // gil's review: lou's login is on for reviews too, and never used for it.
  const { seen, call } = await setup(t);
  await call('review-gil');
  await call('review-lou');
  assert.deepEqual(seen.map((s) => s.headers.authorization), ['Bearer xai-made-up-gil-0123456789', 'Bearer made-up-lou-access']);
});

test('only the calls a review\'s agent makes pass, in their plain form', async (t) => {
  const { seen, call } = await setup(t);
  for (const path of ['/grok/v1/files', '/grok/v1/../v1/files', '/grok/v1/chat/completions/../../files', '/grok/v1/%2e%2e/files', '/grok//v1/models',
    '/grok/v1/batches', '/opencode/anthropic/v1/files', '/opencode/openrouter/v1/chat/completions', '/opencode/openai/v1/files', '/opencode']) {
    assert.equal((await call('review-gil', path)).status, 404, path);
  }
  for (const path of ['/opencode/anthropic/v1/files', '/opencode/anthropic/v1/messages/../../v1/files']) assert.equal((await call('review-oto', path, { header: 'x-api-key' })).status, 404, path);
  assert.equal(seen.length, 0);
  assert.deepEqual(reviewAgentRoute('/grok/v1/models?x=1'), { agent: 'grok', provider: null, path: '/v1/models?x=1' });
  assert.equal(reviewAgentRoute('/elsewhere'), null);
});

test('a review\'s OpenCode reaches Anthropic on its author\'s API key, from opencode\'s own x-api-key', async (t) => {
  const { seen, call } = await setup(t);
  const res = await call('review-oto', '/opencode/anthropic/v1/messages', { header: 'x-api-key' });
  assert.equal(res.status, 200);
  assert.equal(seen[0].url, '/anthropic/v1/messages');
  assert.equal(seen[0].headers['x-api-key'], 'sk-ant-made-up-oto');
  assert.equal(seen[0].headers.authorization, undefined);
  assert.equal((await call('review-oto', '/opencode/openai/v1/responses')).status, 403, 'only the provider the review started on');
});

test('a review\'s OpenCode reaches OpenAI on its author\'s API key, and loses it when the key is gone from auth.json', async (t) => {
  const { seen, call } = await setup(t);
  assert.equal((await call('review-ovi', '/opencode/openai/v1/responses')).status, 200);
  assert.equal(seen[0].url, '/openai/v1/responses');
  assert.equal(seen[0].headers.authorization, 'Bearer sk-made-up-ovi');
  const swapped = await setup(t, { signIns: { opencode: { ovi: JSON.stringify({ anthropic: { type: 'api', key: 'sk-ant-made-up-ovi' } }) } } });
  const res = await swapped.call('review-ovi', '/opencode/openai/v1/responses');
  assert.equal(res.status, 403);
  assert.match(JSON.parse(res.body).error.message, /no longer have the openai API key this review started on/);
  const login = await setup(t, { signIns: { opencode: { ovi: JSON.stringify({ openai: { type: 'oauth', access: 'made-up', refresh: 'made-up', expires: 0 } }) } } });
  assert.equal((await login.call('review-ovi', '/opencode/openai/v1/responses')).status, 403, 'never a login');
  assert.equal(swapped.seen.length + login.seen.length, 0);
});

test('the session API knows the token a review\'s agent sends, as a bearer or as Anthropic\'s x-api-key', () => {
  assert.equal(reviewAgentTokenOf({ authorization: 'Bearer abc' }), 'abc');
  assert.equal(reviewAgentTokenOf({ 'x-api-key': 'abc' }), 'abc');
  assert.equal(reviewAgentTokenOf({}), null);
  assert.equal(sessionTokenOf({ url: '/opencode/anthropic/v1/messages', headers: { 'x-api-key': 'tok' } }), 'tok');
  assert.equal(sessionTokenOf({ url: '/grok/v1/models', headers: { authorization: 'Bearer tok' } }), 'tok');
});
