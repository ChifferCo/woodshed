import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BUILT_IN, CODEX_CLIENT_VERSION, createCodexModels, credentialOf, modelsFrom } from './codexModels.mjs';

// The shape OpenAI's Codex backend answers with (codex's ModelInfo), trimmed to the fields read here.
const model = (slug, extra = {}) => ({
  slug, display_name: slug.toUpperCase(), description: `${slug} model`, visibility: 'list', supported_in_api: true, priority: 1,
  supported_reasoning_levels: [{ effort: 'low', description: '' }, { effort: 'high', description: '' }], default_reasoning_level: 'low', ...extra,
});
const CATALOG = { models: [
  model('gpt-7-nova', { priority: 2 }),
  model('gpt-7-sol', { priority: 1, supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'ultra' }], default_reasoning_level: 'medium' }),
  model('codex-auto-review', { visibility: 'hide' }),
  model('chatgpt-only', { supported_in_api: false, priority: 3 }),
  model('bad slug; rm', { priority: 0 }),
] };

const jwt = (payload) => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;

function fakeFetch(answers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const next = answers.length > 1 ? answers.shift() : answers[0];
    if (next instanceof Error) throw next;
    return { ok: next.status === 200, status: next.status, text: async () => JSON.stringify(next.body) };
  };
  fn.calls = calls;
  return fn;
}

test('the codex version asked about is the session image\'s', () => {
  const dockerfile = fs.readFileSync(new URL('../session/Dockerfile', import.meta.url), 'utf8');
  assert.equal(/ARG CODEX_VERSION=(\S+)/.exec(dockerfile)?.[1], CODEX_CLIENT_VERSION, 'refresh BUILT_IN from `codex debug models --bundled` too');
});

test('a catalog gives the listed models in codex\'s order, each with its efforts', () => {
  assert.deepEqual(modelsFrom(CATALOG, { apiKey: false }).map((m) => m.slug), ['gpt-7-sol', 'gpt-7-nova', 'chatgpt-only'], 'hidden ones and odd names left out');
  assert.deepEqual(modelsFrom(CATALOG, { apiKey: true }).map((m) => m.slug), ['gpt-7-sol', 'gpt-7-nova'], 'an API key runs only the API\'s');
  assert.deepEqual(modelsFrom(CATALOG, { apiKey: false })[0], { slug: 'gpt-7-sol', name: 'GPT-7-SOL', description: 'gpt-7-sol model', efforts: ['medium', 'ultra'], defaultEffort: 'medium' });
  assert.deepEqual(modelsFrom({}, { apiKey: false }), []);
  assert.deepEqual(modelsFrom({ models: 'no' }, { apiKey: false }), []);
});

test('a saved sign-in reaches the catalog as codex does', () => {
  assert.deepEqual(credentialOf('sk-abc'), { headers: { authorization: 'Bearer sk-abc' }, apiKey: true });
  assert.deepEqual(credentialOf(JSON.stringify({ OPENAI_API_KEY: 'sk-k' })), { headers: { authorization: 'Bearer sk-k' }, apiKey: true });
  const access = jwt({ exp: 2_000 });
  assert.deepEqual(credentialOf(JSON.stringify({ tokens: { access_token: access, account_id: 'acc', refresh_token: 'r' } }), 1_000_000),
    { headers: { authorization: `Bearer ${access}`, 'chatgpt-account-id': 'acc' }, apiKey: false });
  assert.deepEqual(credentialOf(JSON.stringify({ tokens: { access_token: access, refresh_token: 'r' } }), 3_000_000), { expired: true }, 'never refreshed here');
  assert.equal(credentialOf(JSON.stringify({ tokens: { refresh_token: 'r' } })), null);
  assert.equal(credentialOf('{not json'), null);
});

test('the list is read with the person\'s own sign-in, and kept for ten minutes', async () => {
  let t = 1_000;
  const fetch = fakeFetch([{ status: 200, body: CATALOG }]);
  const codexModels = createCodexModels({ userSettings: { codexAuth: async () => 'sk-own' }, teamCredential: async () => 'sk-team', fetch, upstream: 'https://up.test/codex', now: () => t });
  const first = await codexModels.list('ana');
  assert.deepEqual([first.source, first.note, first.models.map((m) => m.slug)], ['own', null, ['gpt-7-sol', 'gpt-7-nova']]);
  assert.equal(fetch.calls[0].url, `https://up.test/codex/models?client_version=${CODEX_CLIENT_VERSION}`);
  assert.equal(fetch.calls[0].headers.authorization, 'Bearer sk-own');
  t += 9 * 60_000;
  await codexModels.list('ana');
  assert.equal(fetch.calls.length, 1, 'kept');
  t += 2 * 60_000;
  await codexModels.list('ana');
  assert.equal(fetch.calls.length, 2, 'read again');
});

test('with no sign-in of their own, the team key reads it', async () => {
  const fetch = fakeFetch([{ status: 200, body: CATALOG }]);
  const codexModels = createCodexModels({ userSettings: { codexAuth: async () => null }, teamCredential: async () => 'sk-team', fetch });
  assert.equal((await codexModels.list('ana')).source, 'team');
  assert.equal(fetch.calls[0].headers.authorization, 'Bearer sk-team');
});

test('a failed read keeps the last list, or gives codex\'s built-in one, and waits a minute to try again', async () => {
  let t = 0;
  const fetch = fakeFetch([{ status: 200, body: CATALOG }, { status: 503, body: {} }]);
  const codexModels = createCodexModels({ userSettings: { codexAuth: async () => 'sk-own' }, fetch, now: () => t });
  await codexModels.list('ana');
  t = 11 * 60_000;
  const stale = await codexModels.list('ana');
  assert.deepEqual(stale.models.map((m) => m.slug), ['gpt-7-sol', 'gpt-7-nova']);
  assert.match(stale.note, /since then OpenAI answered 503/);
  t += 30_000;
  await codexModels.list('ana');
  assert.equal(fetch.calls.length, 2, 'no new try within the minute');

  const down = createCodexModels({ userSettings: { codexAuth: async () => 'sk-own' }, fetch: fakeFetch([new Error('ECONNRESET')]) });
  const builtIn = await down.list('bo');
  assert.deepEqual([builtIn.source, builtIn.models], ['built-in', BUILT_IN]);
  assert.match(builtIn.note, /OpenAI could not be reached/);

  const nobody = createCodexModels({ userSettings: { codexAuth: async () => null }, teamCredential: async () => null, fetch: fakeFetch([new Error('not called')]) });
  assert.match((await nobody.list('cy')).note, /no Codex sign-in is saved/);
});

test('an expired ChatGPT sign-in is not sent', async () => {
  const fetch = fakeFetch([new Error('not called')]);
  const saved = JSON.stringify({ tokens: { access_token: jwt({ exp: 1 }), refresh_token: 'r' } });
  const codexModels = createCodexModels({ userSettings: { codexAuth: async () => saved }, teamCredential: async () => 'sk-team', fetch });
  const got = await codexModels.list('ana');
  assert.equal(fetch.calls.length, 0);
  assert.equal(got.source, 'built-in');
  assert.match(got.note, /has expired/);
});

test('a start is checked against the list it was offered', async () => {
  const codexModels = createCodexModels({ userSettings: { codexAuth: async () => 'sk-own' }, fetch: fakeFetch([{ status: 200, body: CATALOG }]) });
  assert.equal(await codexModels.allows('ana', 'gpt-7-sol', 'ultra'), null);
  assert.equal(await codexModels.allows('ana', '', ''), null);
  assert.equal(await codexModels.allows('ana', '', 'high'), null, 'the default model takes an effort some model takes');
  assert.match(await codexModels.allows('ana', 'gpt-5.5', ''), /the model must be one of gpt-7-sol, gpt-7-nova/);
  assert.match(await codexModels.allows('ana', 'gpt-7-nova', 'ultra'), /the effort must be one of low, high for gpt-7-nova/);
});

test('a changed sign-in is read again at once', async () => {
  let own = null;
  const fetch = fakeFetch([{ status: 200, body: CATALOG }]);
  const codexModels = createCodexModels({ userSettings: { codexAuth: async () => own }, teamCredential: async () => 'sk-team', fetch });
  assert.equal((await codexModels.list('ana')).source, 'team');
  own = 'sk-own';
  assert.equal((await codexModels.list('ana')).source, 'team', 'kept until told');
  codexModels.forget('ana');
  assert.equal((await codexModels.list('ana')).source, 'own');
  assert.equal(fetch.calls.at(-1).headers.authorization, 'Bearer sk-own');
});
