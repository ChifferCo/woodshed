import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createReviewAgents, bestChoice } from './reviewAgents.mjs';

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
function setup({ team = { claude: true, codex: true }, claudeOwn = [], codexOwn = [], choices = {} } = {}) {
  const userSettings = {
    reviewAgents: (login) => choices[login] ?? null,
    usesOwnTokenForShared: (login) => claudeOwn.includes(login),
    usesOwnCodexForReviews: (login) => codexOwn.includes(login),
    codexAuth: async (login) => SIGN_INS[login] ?? null,
  };
  return createReviewAgents({ userSettings, connected: async () => ({ ...team }), now: () => NOW });
}

test('the default is the most there is: both, else the one there is, else none', () => {
  assert.equal(bestChoice({ claude: true, codex: true }), 'both');
  assert.equal(bestChoice({ claude: true, codex: false }), 'claude');
  assert.equal(bestChoice({ claude: false, codex: true }), 'codex');
  assert.equal(bestChoice({ claude: false, codex: false }), 'none');
});

test('with no choice saved, a review runs both when the team keys can, on the team keys', async () => {
  const agents = setup();
  assert.deepEqual(await agents.forReview({ login: 'bo' }), { agents: ['claude', 'codex'], choice: null, codexLogin: null, codexVia: 'key', why: null });
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
  assert.deepEqual(await none.options('bo'), { available: { claude: false, codex: false }, own: { claude: false, codex: false }, best: 'none' });
  const own = setup({ team: { claude: false, codex: false }, claudeOwn: ['ana'], codexOwn: ['ana'] });
  assert.deepEqual(await own.options('ana'), { available: { claude: true, codex: true }, own: { claude: true, codex: true }, best: 'both' });
  assert.equal((await own.options('bo')).best, 'none', 'someone else\'s sign-ins are not theirs');
  const claudeTeam = setup({ team: { claude: true, codex: false } });
  assert.equal((await claudeTeam.options('bo')).best, 'claude');
  const expired = setup({ team: { claude: false, codex: false }, codexOwn: ['old'] });
  assert.deepEqual((await expired.options('old')).available, { claude: false, codex: false }, 'an expired login runs nothing');
});

test('with nothing to run a review on, the default is no review', async () => {
  const agents = setup({ team: { claude: false, codex: false } });
  assert.deepEqual(await agents.forReview({ login: 'bo' }), { agents: [], choice: null, codexLogin: null, codexVia: null, why: null });
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
  assert.deepEqual(await agents.forReview({ login: 'ana' }), { agents: ['claude', 'codex'], choice: null, codexLogin: 'ana', codexVia: 'chatgpt', codexAccount: 'acct-ana', why: null });
  assert.deepEqual(await agents.forReview({ login: 'cy' }), { agents: ['claude', 'codex'], choice: null, codexLogin: 'cy', codexVia: 'key', why: null });
  assert.deepEqual(await agents.forReview({ login: null }), { agents: ['claude', 'codex'], choice: null, codexLogin: null, codexVia: 'key', why: null }, 'nobody\'s own');
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
