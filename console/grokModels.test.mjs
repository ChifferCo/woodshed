import test from 'node:test';
import assert from 'node:assert/strict';
import { createGrokModels, credentialOf, modelsFrom } from './grokModels.mjs';

// The shape cli-chat-proxy.grok.com/v1/models answers a login with, as measured, trimmed to the fields read here.
const effort = (value, extra = {}) => ({ id: value, value, label: value, description: '', default: false, ...extra });
const model = (id, name, efforts = ['low', 'high'], def = 'high') => ({
  id, name, description: `${name} model`, supports_reasoning_effort: true, reasoning_effort: def,
  reasoning_efforts: efforts.map((e) => effort(e, { default: e === def })),
});
const LOGIN_CATALOG = { object: 'list', data: [
  model('grok-4.7', 'Grok 4.7', ['low', 'medium', 'high', 'xhigh'], 'medium'),
  model('grok-4.7-build-fast', 'Grok 4.7 Build Fast'),
  model('grok-4.6', 'Grok 4.6'),
  model('grok-4.5', 'Grok 4.5', ['low', 'high', 'ludicrous'], 'high'),
] };
// api.x.ai/v1/models for a key: every xAI model, with fewer fields.
const KEY_CATALOG = { data: [
  { id: 'grok-4.7', object: 'model' }, { id: 'grok-imagine-image', object: 'model' }, { id: 'grok-imagine-video-1.5', object: 'model' },
  { id: 'grok-2-image-1212', object: 'model' }, { id: 'grok-4.6', object: 'model', name: 'Grok 4.6' }, { id: 'bad id; rm', object: 'model' },
] };
const EMAIL = 'ana@example.test';
const login = ({ key = 'access-token-secret', expires = '2030-01-01T00:00:00Z' } = {}) => JSON.stringify({
  'https://auth.x.ai::client-123': { key, refresh_token: 'refresh-token-secret', expires_at: expires, email: EMAIL, first_name: 'Ana', team_id: 't-1' },
});

function fakeFetch(answers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const next = answers.length > 1 ? answers.shift() : answers[0];
    if (next instanceof Error) throw next;
    return { ok: next.status === 200, status: next.status, text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body)) };
  };
  fn.calls = calls;
  return fn;
}

test('a login\'s catalog gives its models in its order, with their names and efforts', () => {
  const models = modelsFrom(LOGIN_CATALOG);
  assert.deepEqual(models.map((m) => m.slug), ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6', 'grok-4.5']);
  assert.deepEqual(models[0], { slug: 'grok-4.7', name: 'Grok 4.7', description: 'Grok 4.7 model', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' });
  assert.deepEqual(models[3].efforts, ['low', 'high'], 'only efforts the registry takes');
  assert.deepEqual(modelsFrom({ data: [{ id: 'grok-x', supports_reasoning_effort: false }] })[0].efforts, []);
  assert.deepEqual(modelsFrom({}), []);
  assert.deepEqual(modelsFrom({ data: 'no' }), []);
});

test('a key\'s catalog leaves out image and video models and odd ids, and falls back to the id', () => {
  const models = modelsFrom(KEY_CATALOG);
  assert.deepEqual(models.map((m) => [m.slug, m.name, m.efforts]), [['grok-4.7', 'grok-4.7', null], ['grok-4.6', 'Grok 4.6', null]]);
});

test('a saved sign-in reaches the right catalog, and an expired login is never sent', () => {
  assert.deepEqual(credentialOf('xai-abc', 0, { keyUpstream: 'https://k.test/v1' }), { url: 'https://k.test/v1/models', base: 'https://k.test/v1', authorization: 'Bearer xai-abc', source: 'key' });
  assert.deepEqual(credentialOf(login(), Date.parse('2029-01-01'), { loginUpstream: 'https://l.test/v1' }),
    { url: 'https://l.test/v1/models', base: 'https://l.test/v1', authorization: 'Bearer access-token-secret', source: 'login' });
  assert.deepEqual(credentialOf(login({ expires: '2020-01-01T00:00:00Z' }), Date.parse('2026-01-01')), { expired: true });
  assert.deepEqual(credentialOf(login({ expires: 'soon' })), { expired: true }, 'an expiry it cannot read is taken as passed');
  assert.equal(credentialOf(JSON.stringify({ x: { refresh_token: 'r' } })), null);
  assert.equal(credentialOf('{not json'), null);
});

test('the list is read with the person\'s login, kept ten minutes, and nothing of the sign-in is logged', async (t) => {
  const lines = [];
  for (const level of ['log', 'warn']) t.mock.method(console, level, (...args) => lines.push(JSON.stringify(args)));
  let now = Date.parse('2029-01-01');
  const fetch = fakeFetch([{ status: 200, body: LOGIN_CATALOG }, { status: 401, body: { error: `bad token for ${EMAIL}` } }, { status: 200, body: `<html>${EMAIL}` }]);
  const grokModels = createGrokModels({ userSettings: { agentAuth: async (who, id) => (who === 'ana' && id === 'grok' ? login() : null) }, fetch, loginUpstream: 'https://l.test/v1', now: () => now });
  const first = await grokModels.list('ana');
  assert.deepEqual([first.source, first.note, first.models.map((m) => m.name)], ['login', null, ['Grok 4.7', 'Grok 4.7 Build Fast', 'Grok 4.6', 'Grok 4.5']]);
  assert.equal(fetch.calls[0].url, 'https://l.test/v1/models');
  assert.equal(fetch.calls[0].headers.authorization, 'Bearer access-token-secret');
  now += 9 * 60_000;
  await grokModels.list('ana');
  assert.equal(fetch.calls.length, 1, 'kept');
  now += 2 * 60_000;
  const refused = await grokModels.list('ana');
  assert.equal(fetch.calls.length, 2, 'read again');
  assert.equal(refused.models.length, 4, 'the last list kept');
  assert.match(refused.note, /since then xAI answered 401/);
  now += 61_000;
  await grokModels.list('ana');
  assert.equal(fetch.calls.length, 3, 'tried again after a minute: an answer that is not JSON');
  assert.ok(lines.some((l) => l.includes('grokModels: catalog read') && l.includes('"models":4') && l.includes('"source":"login"')));
  assert.ok(lines.some((l) => l.includes('grokModels: xAI refused the catalog') && l.includes('"status":401')));
  assert.ok(lines.some((l) => l.includes('grokModels: catalog not read') && l.includes('the answer is not JSON')));
  for (const secret of ['access-token-secret', 'refresh-token-secret', EMAIL, 'Ana"', 'client-123']) {
    assert.ok(!lines.some((l) => l.includes(secret)), `${secret} logged`);
  }
});

test('a key reads api.x.ai\'s list', async (t) => {
  t.mock.method(console, 'log', () => {});
  const fetch = fakeFetch([{ status: 200, body: KEY_CATALOG }]);
  const grokModels = createGrokModels({ userSettings: { agentAuth: async () => 'xai-own-key-0123456789' }, fetch, keyUpstream: 'https://k.test/v1' });
  const got = await grokModels.list('ana');
  assert.deepEqual([got.source, got.models.map((m) => m.slug)], ['key', ['grok-4.7', 'grok-4.6']]);
  assert.deepEqual([fetch.calls[0].url, fetch.calls[0].headers.authorization], ['https://k.test/v1/models', 'Bearer xai-own-key-0123456789']);
});

test('an expired login is not sent, and says a Grok session refreshes it', async (t) => {
  t.mock.method(console, 'log', () => {});
  const fetch = fakeFetch([new Error('not called')]);
  const grokModels = createGrokModels({ userSettings: { agentAuth: async () => login({ expires: '2020-01-01T00:00:00Z' }) }, fetch, now: () => Date.parse('2026-01-01') });
  const got = await grokModels.list('ana');
  assert.equal(fetch.calls.length, 0);
  assert.deepEqual([got.models, got.source], [[], null]);
  assert.match(got.note, /type a model name, since your saved Grok Build login has expired: a Grok session refreshes it when it stops/);
});

test('no sign-in, a timeout or an empty list gives no list and says why', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const nobody = createGrokModels({ userSettings: { agentAuth: async () => null }, fetch: fakeFetch([new Error('not called')]) });
  assert.match((await nobody.list('cy')).note, /no Grok Build sign-in is saved/);
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const slow = createGrokModels({ userSettings: { agentAuth: async () => 'xai-own-key-0123456789' }, fetch: fakeFetch([timeout]) });
  const got = await slow.list('bo');
  assert.deepEqual(got.models, []);
  assert.match(got.note, /xAI could not be reached/);
  const empty = createGrokModels({ userSettings: { agentAuth: async () => 'xai-own-key-0123456789' }, fetch: fakeFetch([{ status: 200, body: { data: [{ id: 'grok-imagine-image' }] } }]) });
  assert.match((await empty.list('bo')).note, /xAI listed no models/);
  const huge = createGrokModels({ userSettings: { agentAuth: async () => 'xai-own-key-0123456789' }, fetch: fakeFetch([{ status: 200, body: 'x'.repeat(3 * 1024 * 1024) }]) });
  assert.match((await huge.list('bo')).note, /xAI could not be reached/);
});

test('a changed sign-in is read again at once', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  let own = null;
  const fetch = fakeFetch([{ status: 200, body: KEY_CATALOG }]);
  const grokModels = createGrokModels({ userSettings: { agentAuth: async () => own }, fetch });
  assert.deepEqual((await grokModels.list('ana')).models, []);
  own = 'xai-own-key-0123456789';
  assert.deepEqual((await grokModels.list('ana')).models, [], 'kept until told');
  grokModels.forget('ana');
  assert.equal((await grokModels.list('ana')).source, 'key');
});

test('a token no header can carry is never sent, and no error of another\'s reaches the log with what was sent', async (t) => {
  const lines = [];
  for (const level of ['log', 'warn']) t.mock.method(console, level, (...args) => lines.push(JSON.stringify(args)));
  const MARK = 'INERT-MARKER-NOT-A-TOKEN';
  // A pasted auth.json whose key holds a line break: fetch would refuse its header in an error quoting it.
  let saved = login({ key: `${MARK}\nmore` });
  const userSettings = { agentAuth: async () => saved };
  const unsent = fakeFetch([{ status: 200, body: LOGIN_CATALOG }]);
  const first = await createGrokModels({ userSettings, fetch: unsent }).list('ana');
  assert.equal(unsent.calls.length, 0, 'never sent');
  assert.deepEqual(first.models, []);
  assert.match(first.note, /cannot be sent: save it again/);
  // Any failure but this module's own is logged by its name alone, whatever its message holds.
  saved = login({ key: MARK });
  const quoting = fakeFetch([Object.assign(new TypeError(`Headers.append: "Bearer ${MARK}" is an invalid header value`), {})]);
  await createGrokModels({ userSettings, fetch: quoting }).list('ana');
  assert.equal(quoting.calls.length, 1);
  assert.ok(lines.some((l) => l.includes('catalog not read') && l.includes('TypeError')), lines.join('\n'));
  assert.ok(lines.every((l) => !l.includes(MARK)), lines.join('\n'));
});
