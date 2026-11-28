import test from 'node:test';
import assert from 'node:assert/strict';
import { createGrokLogin, describeLogin } from './grokLogin.mjs';
import agents from '../shared/agents.cjs';

const NOW = Date.parse('2026-11-18T10:00:00Z');
const SCOPE = 'https://auth.x.ai::client-123';
const login = ({ key = 'old-access', refresh = 'old-refresh', expires = '2026-11-18T09:00:00Z', extra = {} } = {}) =>
  JSON.stringify({ [SCOPE]: { key, refresh_token: refresh, expires_at: expires, email: 'ana@example.test', ...extra } });

// A userSettings with the one sign-in, the turn that serialises the changes to it, and a record of its saves.
function store(initial) {
  let saved = initial;
  const saves = [];
  let turns = Promise.resolve();
  const api = {
    saves,
    get saved() { return saved; },
    agentAuth: async () => saved,
    agentAuthTurn(l, id, fn) {
      const run = turns.then(() => fn({ read: async () => saved, save: async (v) => { if (api.failSave) throw new Error('store down'); saved = v; saves.push(v); } }));
      turns = run.catch(() => {});
      return run;
    },
  };
  return api;
}

// xAI as measured: discovery names the token endpoint, which rotates the refresh token.
function xai({ token = { status: 200, body: { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, token_type: 'Bearer' } }, discovery } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method ?? 'GET', body: init.body ?? null });
    if (u.endsWith('/.well-known/openid-configuration')) {
      const d = discovery ?? { issuer: 'https://auth.x.ai', token_endpoint: 'https://auth.x.ai/oauth2/token' };
      return { ok: true, status: 200, text: async () => JSON.stringify(d) };
    }
    if (token instanceof Error) throw token;
    return { ok: token.status < 300, status: token.status, text: async () => JSON.stringify(token.body) };
  };
  fn.calls = calls;
  return fn;
}

const make = (userSettings, fetch, sessions = []) => createGrokLogin({ userSettings, sessions: () => sessions, fetch, now: () => NOW });
const noTokensIn = (lines) => assert.doesNotMatch(lines.join('\n'), /old-access|old-refresh|new-access|new-refresh|ana@example/);

function capture(t) {
  const lines = [];
  for (const m of ['log', 'warn', 'error']) t.mock.method(console, m, (...a) => lines.push(a.map((x) => JSON.stringify(x)).join(' ')));
  return lines;
}

test('describeLogin reads how long a saved sign-in lasts', () => {
  assert.equal(describeLogin(null).kind, 'none');
  assert.equal(describeLogin('xai-abc').kind, 'key');
  assert.deepEqual(describeLogin(login(), NOW), { kind: 'login', endsAt: Date.parse('2026-11-18T09:00:00Z'), refreshable: true, expired: true });
  assert.equal(describeLogin(login({ expires: '2030-01-01T00:00:00Z' }), NOW).expired, false);
  assert.equal(describeLogin(login({ expires: 'soon' }), NOW).expired, true);
});

test('an expired login is refreshed with xAI\'s token endpoint and the rotated pair is saved, keeping the rest of the file', async (t) => {
  const lines = capture(t);
  const us = store(login({ extra: { first_name: 'Ana' } }));
  const fetch = xai();
  const got = await make(us, fetch).fresh('lou');
  assert.equal(got.state, 'refreshed');
  const entry = JSON.parse(us.saved)[SCOPE];
  assert.deepEqual([entry.key, entry.refresh_token, entry.expires_at, entry.first_name], ['new-access', 'new-refresh', '2026-11-18T11:00:00.000Z', 'Ana']);
  assert.equal(got.saved, us.saved);
  assert.deepEqual(fetch.calls.map((c) => [c.method, c.url]), [['GET', 'https://auth.x.ai/.well-known/openid-configuration'], ['POST', 'https://auth.x.ai/oauth2/token']]);
  const sent = new URLSearchParams(fetch.calls[1].body);
  assert.deepEqual([sent.get('grant_type'), sent.get('refresh_token'), sent.get('client_id'), sent.has('client_secret')], ['refresh_token', 'old-refresh', 'client-123', false]);
  noTokensIn(lines);
  assert.ok(lines.some((l) => l.includes('grokLogin: login refreshed')));
});

test('a login ending within ten minutes is refreshed, one with longer left, a key, or none is left alone', async () => {
  const soon = store(login({ expires: '2026-11-18T10:05:00Z' }));
  assert.equal((await make(soon, xai()).fresh('lou')).state, 'refreshed');
  for (const [saved, state] of [[login({ expires: '2026-11-18T12:00:00Z' }), 'ok'], ['xai-abc', 'key'], [null, 'none']]) {
    const us = store(saved);
    const fetch = xai();
    assert.equal((await make(us, fetch).fresh('lou')).state, state);
    assert.equal(fetch.calls.length, 0, 'xAI is not asked');
    assert.equal(us.saves.length, 0);
  }
});

test('no refresh while a Grok session of the owner is queued, starting, running or stopping: it holds the refresh token', async (t) => {
  capture(t);
  for (const status of ['queued', 'starting', 'running', 'stopping']) {
    const us = store(login());
    const fetch = xai();
    const got = await make(us, fetch, [{ owner: 'Lou', status, options: { agent: 'grok' } }]).fresh('lou');
    assert.equal(got.state, 'expired', status);
    assert.match(got.why, /a Grok session of the author's is running/);
    assert.equal(fetch.calls.length, 0);
    assert.equal(us.saved, login(), 'what is saved is untouched');
  }
  // Another person's, a stopped one, and another agent's do not hold it.
  for (const s of [{ owner: 'sam', status: 'running', options: { agent: 'grok' } }, { owner: 'lou', status: 'stopped', options: { agent: 'grok' } }, { owner: 'lou', status: 'running', options: { agent: 'codex' } }]) {
    assert.equal((await make(store(login()), xai(), [s]).fresh('lou')).state, 'refreshed');
  }
});

test('a session\'s write-back and a refresh by the console never lose each other\'s tokens', async (t) => {
  capture(t);
  const us = store(login());
  const sessions = [{ owner: 'lou', status: 'running', options: { agent: 'grok' } }];
  const grok = make(us, xai(), sessions);
  // The session runs: the console leaves the saved login alone, so the session's write-back still matches what it was given.
  assert.equal((await grok.fresh('lou')).state, 'expired');
  const given = agents.signInDigest(us.saved);
  // The session stops and writes back its refreshed login, in the turn, as sessionApi does.
  const written = login({ key: 'session-access', refresh: 'session-refresh', expires: '2026-11-18T14:00:00Z' });
  await us.agentAuthTurn('lou', 'grok', async ({ read, save }) => {
    assert.equal(agents.signInDigest(await read()), given, 'accepted: the console did not refresh meanwhile');
    await save(written);
  });
  sessions.length = 0;
  // With the session gone and a login that is good, the console uses what the session wrote, not its own older copy.
  assert.equal((await grok.fresh('lou')).state, 'ok');
  assert.equal(us.saved, written);
});

test('a refresh and a start\'s read of the login run one after the other, so a session is never given a token the refresh killed', async (t) => {
  capture(t);
  const us = store(login());
  const slow = xai();
  const inner = slow;
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetch = async (url, init) => { if (init?.method === 'POST') await gate; return inner(url, init); };
  const refreshing = make(us, fetch).fresh('lou');
  const handedOut = us.agentAuthTurn('lou', 'grok', ({ read }) => read());
  release();
  await refreshing;
  assert.equal(JSON.parse(await handedOut)[SCOPE].refresh_token, 'new-refresh');
});

test('xAI refusing the refresh is final for that login: it is not tried again until a new one is saved', async (t) => {
  const lines = capture(t);
  const us = store(login());
  const fetch = xai({ token: { status: 400, body: { error: 'invalid_grant', error_description: 'old-refresh was used' } } });
  const grok = make(us, fetch);
  const first = await grok.fresh('lou');
  assert.equal(first.state, 'expired');
  assert.match(first.why, /xAI refused to refresh it: save a new one/);
  await grok.fresh('lou');
  assert.equal(fetch.calls.filter((c) => c.method === 'POST').length, 1, 'the dead token is not sent twice');
  assert.ok(lines.some((l) => l.includes('invalid_grant')));
  noTokensIn(lines);
  // A new login saved: tried again.
  us.agentAuthTurn('lou', 'grok', ({ save }) => save(login({ refresh: 'another' })));
  assert.equal(JSON.parse((await grok.fresh('lou')).saved ?? '{}')[SCOPE] !== undefined, true);
  assert.equal(fetch.calls.filter((c) => c.method === 'POST').length, 2);
});

test('a token call that never left this machine leaves the login as it is and is tried again after a minute', async (t) => {
  const lines = capture(t);
  const us = store(login());
  let at = NOW;
  const down = xai({ token: Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) });
  const grok = createGrokLogin({ userSettings: us, fetch: down, now: () => at });
  assert.equal((await grok.fresh('lou')).state, 'expired');
  assert.equal(us.saved, login());
  await grok.fresh('lou');
  assert.equal(down.calls.filter((c) => c.method === 'POST').length, 1, 'not on every call');
  at += 61_000;
  await grok.fresh('lou');
  assert.equal(down.calls.filter((c) => c.method === 'POST').length, 2);
  noTokensIn(lines);
});

test('a 5xx or 429 is not a refusal: the token may still be good, so it is tried again later', async (t) => {
  capture(t);
  for (const status of [429, 503]) {
    let at = NOW;
    let posts = 0;
    const good = xai();
    const fetch = async (url, init) => {
      if (init?.method !== 'POST') return good(url, init);
      posts += 1;
      return posts === 1 ? { ok: false, status, text: async () => '{}' } : good(url, init);
    };
    const grok = createGrokLogin({ userSettings: store(login()), fetch, now: () => at });
    assert.equal((await grok.fresh('lou')).state, 'expired', String(status));
    at += 61_000;
    assert.equal((await grok.fresh('lou')).state, 'refreshed', `${status} is retried`);
  }
});

test('a refreshed login that cannot be saved is tried once more, then reported without a token', async (t) => {
  const lines = capture(t);
  const us = store(login());
  us.failSave = true;
  const fetch = xai();
  const grok = make(us, fetch);
  const got = await grok.fresh('lou');
  assert.equal(got.state, 'expired');
  assert.match(got.why, /could not save its refresh, which used up the saved login: save a new one/);
  const posts = () => fetch.calls.filter((c) => c.method === 'POST').length;
  await grok.fresh('lou');
  assert.equal(posts(), 1, 'the spent token is not sent again');
  assert.ok(lines.some((l) => l.includes('could not be saved')));
  noTokensIn(lines);
});

test('an issuer or token endpoint that is not xAI\'s is never called, so a saved file cannot aim the console elsewhere', async (t) => {
  capture(t);
  const evil = store(JSON.stringify({ 'https://evil.test::c': { key: 'k', refresh_token: 'r', expires_at: '2026-11-18T09:00:00Z' } }));
  const fetch = xai();
  assert.equal((await make(evil, fetch).fresh('lou')).state, 'expired');
  assert.equal(fetch.calls.length, 0);
  // The entry's own oidc_issuer is read the same way.
  const named = store(login({ extra: { oidc_issuer: 'https://evil.test' } }));
  assert.equal((await make(named, fetch).fresh('lou')).state, 'expired');
  assert.equal(fetch.calls.length, 0);
  // Discovery that names another host's endpoint is refused before the token is sent.
  const sneaky = xai({ discovery: { token_endpoint: 'https://evil.test/token' } });
  assert.equal((await make(store(login()), sneaky).fresh('lou')).state, 'expired');
  assert.equal(sneaky.calls.filter((c) => c.method === 'POST').length, 0);
});

test('a login with no refresh token cannot be refreshed, and says so', async () => {
  const got = await make(store(JSON.stringify({ [SCOPE]: { key: 'k', expires_at: '2026-11-18T09:00:00Z' } })), xai()).fresh('lou');
  assert.equal(got.state, 'expired');
  assert.match(got.why, /no refresh token/);
});

test('status is read from the store at most every 30 s, and forget drops it', async (t) => {
  capture(t);
  let reads = 0;
  const us = store(login({ expires: '2030-01-01T00:00:00Z' }));
  const counted = { ...us, agentAuthTurn: (l, id, fn) => { reads += 1; return us.agentAuthTurn(l, id, fn); } };
  let at = NOW;
  const grok = createGrokLogin({ userSettings: counted, fetch: xai(), now: () => at });
  assert.equal(grok.cached('lou'), null);
  assert.equal((await grok.status('lou')).state, 'ok');
  await grok.status('lou');
  assert.equal(reads, 1);
  assert.equal(grok.cached('lou').state, 'ok');
  at += 31_000;
  await grok.status('lou');
  assert.equal(reads, 2);
  grok.forget('lou');
  assert.equal(grok.cached('lou'), null);
});

test('a token call that may have been sent and got no answer is never sent again: xAI may have rotated the token', async (t) => {
  const lines = capture(t);
  const us = store(login());
  const timeout = xai({ token: Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }) });
  let at = NOW;
  const grok = createGrokLogin({ userSettings: us, fetch: timeout, now: () => at });
  const first = await grok.fresh('lou');
  assert.equal(first.state, 'expired');
  assert.match(first.why, /cannot tell whether xAI took its refresh: save a new one/);
  at += 10 * 60_000;
  assert.equal((await grok.fresh('lou')).why, first.why, 'the same reason on later reads');
  assert.equal(timeout.calls.filter((c) => c.method === 'POST').length, 1, 'not even after a while');
  assert.ok(lines.some((l) => l.includes('"ambiguous":true')));
  noTokensIn(lines);
});

test('a success whose body cannot be read, or holds no token, is ambiguous too: the token was rotated and is never sent again', async (t) => {
  capture(t);
  for (const text of [async () => { throw new Error('body timed out'); }, async () => '{"token_type":"Bearer"}', async () => '{"access_to']) {
    const good = xai();
    let posts = 0;
    const fetch = async (url, init) => (init?.method === 'POST' ? (posts += 1, { ok: true, status: 200, text }) : good(url, init));
    let at = NOW;
    const grok = createGrokLogin({ userSettings: store(login()), fetch, now: () => at });
    assert.match((await grok.fresh('lou')).why, /cannot tell whether xAI took its refresh/);
    at += 10 * 60_000;
    await grok.fresh('lou');
    assert.equal(posts, 1);
  }
});
