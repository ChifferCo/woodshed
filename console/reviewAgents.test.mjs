import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createReviewAgents, bestChoice, opencodeReviewCredential, ownReviewCredential } from './reviewAgents.mjs';

const jwt = (exp) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;
const NOW = Date.parse('2026-11-18T10:00:00Z');
const FUTURE = NOW / 1000 + 7 * 86400;
const SIGN_INS = {
  ana: JSON.stringify({ tokens: { access_token: jwt(FUTURE), account_id: 'acct-ana' } }),
  cy: 'sk-cy',
  old: JSON.stringify({ tokens: { access_token: jwt(NOW / 1000 - 60), account_id: 'acct-old' } }),
};

/**
 * @param {{team?: {claude: boolean, codex: boolean}, claudeOwn?: string[], codexOwn?: string[], choices?: Record<string, string>}} opts
 */
// Grok Build and OpenCode sign-ins, each made up: an xAI key, a login, an expired login, and OpenCode's auth.json.
const AGENT_SIGN_INS = {
  grok: {
    gil: 'xai-made-up-key-0123456789',
    lou: JSON.stringify({ 'https://auth.x.ai::made-up': { key: 'made-up-access', refresh_token: 'made-up-refresh', expires_at: '2026-11-18T12:00:00Z' } }),
    old: JSON.stringify({ 'https://auth.x.ai::made-up': { key: 'made-up-access', refresh_token: 'made-up-refresh', expires_at: '2026-11-18T09:00:00Z' } }),
  },
  opencode: {
    gil: JSON.stringify({ openai: { type: 'api', key: 'sk-made-up-openai' }, anthropic: { type: 'api', key: 'sk-ant-made-up' } }),
    oau: JSON.stringify({ anthropic: { type: 'oauth', access: 'made-up', refresh: 'made-up', expires: 0 }, 'github-copilot': { type: 'oauth', access: 'x', refresh: 'y', expires: 0 } }),
  },
};

function setup({ team = { claude: true, codex: true }, claudeOwn = [], codexOwn = [], agentOwn = {}, choices = {}, keysFail = false, agentAuthFails = false } = {}) {
  const userSettings = {
    reviewAgents: (login) => choices[login] ?? null,
    usesOwnTokenForShared: (login) => claudeOwn.includes(login),
    usesOwnCodexForReviews: (login) => codexOwn.includes(login),
    codexAuth: async (login) => SIGN_INS[login] ?? null,
    usesOwnAgentForReviews: (login, id) => (agentOwn[id] ?? []).includes(login),
    agentAuth: async (login, id) => { if (agentAuthFails) throw new Error('Secrets Manager timed out'); return AGENT_SIGN_INS[id]?.[login] ?? null; },
  };
  const connected = async () => { if (keysFail) throw new Error('Secrets Manager timed out'); return { ...team }; };
  return createReviewAgents({ userSettings, connected, now: () => NOW });
}

test('the default is the most there is: both, else the one there is, else none', () => {
  assert.equal(bestChoice({ claude: true, codex: true }), 'both');
  assert.equal(bestChoice({ claude: true, codex: false }), 'claude');
  assert.equal(bestChoice({ claude: false, codex: true }), 'codex');
  assert.equal(bestChoice({ claude: false, codex: false }), 'none');
});

test('with no choice saved, a review runs both when the team keys can, on the team keys', async () => {
  const agents = setup();
  assert.deepEqual(await agents.forReview({ login: 'bo' }), { agents: ['claude', 'codex'], choice: null, codexLogin: null, codexVia: 'key', why: null, keysUnread: false });
});

test('each choice runs what it says: none, Claude Code, Codex or both', async () => {
  const agents = setup({ choices: { a: 'none', b: 'claude', c: 'codex', d: 'both' } });
  assert.deepEqual((await agents.forReview({ login: 'a' })).agents, []);
  assert.deepEqual((await agents.forReview({ login: 'b' })).agents, ['claude']);
  assert.deepEqual((await agents.forReview({ login: 'c' })).agents, ['codex']);
  assert.deepEqual((await agents.forReview({ login: 'd' })).agents, ['claude', 'codex']);
});

test('what is offered follows the tokens: the team keys, or the person\'s own sign-ins', async () => {
  const none = setup({ team: { claude: false, codex: false } });
  const nothing = { claude: false, codex: false, grok: false, opencode: false };
  assert.deepEqual(await none.options('bo'), { available: nothing, own: nothing, ownWhy: { grok: null, opencode: null }, best: 'none' });
  const own = setup({ team: { claude: false, codex: false }, claudeOwn: ['ana'], codexOwn: ['ana'] });
  assert.deepEqual(await own.options('ana'), { available: { ...nothing, claude: true, codex: true }, own: { ...nothing, claude: true, codex: true }, ownWhy: { grok: null, opencode: null }, best: 'both' });
  assert.equal((await own.options('bo')).best, 'none', 'someone else\'s sign-ins are not theirs');
  const claudeTeam = setup({ team: { claude: true, codex: false } });
  assert.equal((await claudeTeam.options('bo')).best, 'claude');
  const expired = setup({ team: { claude: false, codex: false }, codexOwn: ['old'] });
  assert.deepEqual((await expired.options('old')).available, { claude: false, codex: false, grok: false, opencode: false }, 'an expired login runs nothing');
});

test('with nothing to run a review on, the default is no review', async () => {
  const agents = setup({ team: { claude: false, codex: false } });
  assert.deepEqual(await agents.forReview({ login: 'bo' }), { agents: [], choice: null, codexLogin: null, codexVia: null, why: null, keysUnread: false });
});

test('a choice that cannot run now keeps what of it can, else falls back to the most there is, and says why', async () => {
  const agents = setup({ team: { claude: true, codex: false }, choices: { a: 'both', b: 'codex' } });
  const a = await agents.forReview({ login: 'a' });
  assert.deepEqual(a.agents, ['claude']);
  assert.match(a.why, /the author chose both, which this console cannot run now/);
  const b = await agents.forReview({ login: 'b' });
  assert.deepEqual(b.agents, ['claude'], 'Codex alone cannot run: the most there is');
  assert.match(b.why, /chose codex/);
});

test('Codex runs on the author\'s own sign-in when they use it for reviews, as it is, and on the team key otherwise', async () => {
  const agents = setup({ team: { claude: true, codex: true }, codexOwn: ['ana', 'cy'] });
  assert.deepEqual(await agents.forReview({ login: 'ana' }), { agents: ['claude', 'codex'], choice: null, codexLogin: 'ana', codexVia: 'chatgpt', codexAccount: 'acct-ana', why: null, keysUnread: false });
  assert.deepEqual(await agents.forReview({ login: 'cy' }), { agents: ['claude', 'codex'], choice: null, codexLogin: 'cy', codexVia: 'key', why: null, keysUnread: false });
  assert.deepEqual(await agents.forReview({ login: null }), { agents: ['claude', 'codex'], choice: null, codexLogin: null, codexVia: 'key', why: null, keysUnread: false }, 'nobody\'s own');
});

test('an author whose ChatGPT login has expired gets Codex on the team key, and is told why', async () => {
  const agents = setup({ codexOwn: ['old'] });
  const r = await agents.forReview({ login: 'old' });
  assert.deepEqual([r.agents, r.codexLogin, r.codexVia], [['claude', 'codex'], null, 'key']);
  assert.match(r.why, /expired/);
});

test('nobody\'s own choice or sign-in counts for a review with no login: the team keys decide', async () => {
  const agents = setup({ team: { claude: false, codex: true }, choices: { ana: 'none' } });
  assert.deepEqual((await agents.forReview({ login: null })).agents, ['codex']);
});

test('team keys that could not be read are said so, and are not taken for no keys', async () => {
  const unread = await setup({ keysFail: true }).forReview({ login: 'bo' });
  assert.deepEqual([unread.agents, unread.keysUnread], [[], true]);
  assert.match(unread.why, /the team keys could not be read: Secrets Manager timed out/);
  const own = await setup({ keysFail: true, claudeOwn: ['ana'] }).forReview({ login: 'ana' });
  assert.deepEqual([own.agents, own.keysUnread], [['claude'], true], 'the author\'s own sign-in still runs');
});

test('an author\'s own Codex sign-in that could not be read is said so too, and is not taken for none', async () => {
  const userSettings = {
    reviewAgents: () => null, usesOwnTokenForShared: () => false, usesOwnCodexForReviews: () => true,
    codexAuth: async () => { throw new Error('Secrets Manager timed out'); },
  };
  const agents = createReviewAgents({ userSettings, connected: async () => ({ claude: false, codex: false }), now: () => NOW });
  const r = await agents.forReview({ login: 'ana' });
  assert.deepEqual([r.agents, r.keysUnread], [[], true]);
  assert.match(r.why, /the author's Codex sign-in could not be read: Secrets Manager timed out/);
});

test('a choice is saved as a preset\'s name or the reviewers joined with +, and anything else is none at all', async () => {
  const agents = setup({ agentOwn: { grok: ['gil'], opencode: ['gil'] }, choices: { gil: 'claude+grok+opencode', bad: 'grok+grok', odd: 'claude+mystery' } });
  const r = await agents.forReview({ login: 'gil' });
  assert.deepEqual([r.agents, r.choice, r.why], [['claude', 'grok', 'opencode'], 'claude+grok+opencode', null]);
  assert.deepEqual(r.ownSignIns, { grok: { login: 'gil', via: 'key' }, opencode: { login: 'gil', provider: 'anthropic' } }, 'the credential itself is never in what the review records');
  assert.equal((await agents.forReview({ login: 'bad' })).choice, null, 'an id twice is not a choice: the default runs');
  assert.equal((await agents.forReview({ login: 'odd' })).choice, null);
});

test('Grok Build and OpenCode are never in the default: they review only when the author picks them', async () => {
  const agents = setup({ agentOwn: { grok: ['gil'], opencode: ['gil'] } });
  assert.deepEqual((await agents.forReview({ login: 'gil' })).agents, ['claude', 'codex']);
  const options = await agents.options('gil');
  assert.deepEqual([options.available.grok, options.own.opencode, options.best], [true, true, 'both']);
});

test('Grok Build reviews on the author\'s key or unexpired login, and is left out, saying why, when it cannot', async () => {
  const agents = setup({ team: { claude: true, codex: false }, agentOwn: { grok: ['gil', 'lou', 'old'] }, choices: { gil: 'claude+grok', lou: 'grok', old: 'claude+grok', off: 'claude+grok', none: 'grok' } });
  assert.deepEqual((await agents.forReview({ login: 'lou' })).ownSignIns, { grok: { login: 'lou', via: 'login' } });
  const old = await agents.forReview({ login: 'old' });
  assert.deepEqual([old.agents, old.ownSignIns], [['claude'], undefined]);
  assert.match(old.why, /the author chose claude\+grok, which this console cannot run now; Grok Build left out: the author's saved Grok Build login has expired/);
  assert.equal(old.keysUnread, false, 'an expired login is no failure to read');
  const off = await agents.forReview({ login: 'off' });
  assert.match(off.why, /Grok Build left out: the author has no Grok Build sign-in on for reviews/);
  const alone = await agents.forReview({ login: 'none' });
  assert.deepEqual(alone.agents, ['claude'], 'Grok Build alone cannot run: the most there is');
  assert.deepEqual((await agents.options('old')).ownWhy, { grok: 'the author\'s saved Grok Build login has expired', opencode: null });
});

test('a review of nobody\'s own pull request never runs Grok Build or OpenCode', async () => {
  const agents = setup({ agentOwn: { grok: ['gil'] }, choices: { gil: 'grok' } });
  const r = await agents.forReview({ login: null });
  assert.deepEqual([r.agents, r.ownSignIns], [['claude', 'codex'], undefined]);
});

test('OpenCode reviews only on an API key of a provider the proxy forwards, never a login', () => {
  assert.deepEqual(opencodeReviewCredential(AGENT_SIGN_INS.opencode.gil), { provider: 'anthropic', key: 'sk-ant-made-up' }, 'Anthropic first');
  assert.deepEqual(opencodeReviewCredential(JSON.stringify({ openai: { type: 'api', key: 'sk-made-up-openai' } })), { provider: 'openai', key: 'sk-made-up-openai' });
  assert.equal(opencodeReviewCredential(AGENT_SIGN_INS.opencode.oau), null);
  assert.equal(opencodeReviewCredential(JSON.stringify({ openrouter: { type: 'api', key: 'sk-or-made-up' } })), null, 'a provider the proxy does not know');
  assert.equal(opencodeReviewCredential(JSON.stringify({ openai: { type: 'api', key: 'has a space' } })), null, 'never a key a header cannot carry');
  assert.equal(opencodeReviewCredential('{not json'), null);
  assert.match(ownReviewCredential('opencode', AGENT_SIGN_INS.opencode.oau).why, /no API key of anthropic or openai/);
  assert.match(ownReviewCredential('grok', null).why, /no Grok Build sign-in saved/);
});

test('a review never runs on a Grok login that does not say when it expires, though a key needs no expiry', () => {
  const now = Date.parse('2026-11-18T10:00:00Z');
  const entry = (extra) => JSON.stringify({ 'https://auth.x.ai::made-up': { key: 'made-up-access', refresh_token: 'made-up-refresh', ...extra } });
  for (const extra of [{}, { expires_at: 1800000000 }, { expires_at: null }]) {
    assert.match(ownReviewCredential('grok', entry(extra), now).why, /does not say when it expires/, JSON.stringify(extra));
  }
  assert.match(ownReviewCredential('grok', entry({ expires_at: 'soon' }), now).why, /has expired/);
  assert.equal(ownReviewCredential('grok', entry({ expires_at: '2026-11-18T12:00:00Z' }), now).via, 'login');
  assert.equal(ownReviewCredential('grok', 'xai-made-up-key-0123456789', now).via, 'key');
});

test('an author\'s Grok Build or OpenCode sign-in that could not be read is said so, and is not taken for none', async () => {
  const agents = setup({ team: { claude: false, codex: false }, agentOwn: { grok: ['gil'] }, choices: { gil: 'grok' }, agentAuthFails: true });
  const r = await agents.forReview({ login: 'gil' });
  assert.deepEqual([r.agents, r.keysUnread], [[], true]);
  assert.match(r.why, /the author's Grok Build sign-in could not be read: Secrets Manager timed out/);
});
