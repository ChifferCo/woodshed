import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createReviewAgents } from './reviewAgents.mjs';

const jwt = (exp) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;
const FUTURE = Date.parse('2026-11-25T10:00:00Z') / 1000;
const SIGN_INS = {
  ana: JSON.stringify({ tokens: { access_token: jwt(FUTURE), account_id: 'acct-ana' } }),
  cy: 'sk-cy',
  old: JSON.stringify({ tokens: { access_token: jwt(FUTURE - 30 * 86400), account_id: 'acct-old' } }),
};

function setup({ connected = { claude: true, codex: true }, own = [] } = {}) {
  const store = { state: {}, saves: 0, save() { this.saves += 1; } };
  const now = { claude: connected.claude, codex: connected.codex };
  const userSettings = { usesOwnCodexForReviews: (login) => own.includes(login), codexAuth: async (login) => SIGN_INS[login] ?? null };
  const agents = createReviewAgents({ store, userSettings, connected: async () => ({ ...now }), now: () => Date.parse('2026-11-18T10:00:00Z') });
  return { store, agents, now };
}

test('reviews run on Claude Code alone until an admin asks for Codex too, whatever the author chose', async () => {
  const { agents } = setup({ own: ['ana'] });
  assert.deepEqual(await agents.forReview({ login: 'ana' }), { agents: ['claude'], codexLogin: null, codexVia: null, why: null });
  assert.equal((await agents.view()).agents, 'claude');
});

test('both, once set, is kept in state.json with who set it', async () => {
  const { store, agents } = setup();
  assert.equal(agents.set({ agents: 'both', by: 'joel' }), true);
  assert.deepEqual(store.state.reviewAgents, { agents: 'both', by: 'joel', at: '2026-11-18T10:00:00.000Z' });
  assert.deepEqual(await agents.view(), { agents: 'both', by: 'joel', at: '2026-11-18T10:00:00.000Z', connected: { claude: true, codex: true } });
  assert.equal(agents.set({ agents: 'both', by: 'joel' }), false, 'no change, nothing saved');
  assert.equal(store.saves, 1);
  assert.throws(() => agents.set({ agents: 'codex', by: 'joel' }), /agents must be claude or both/);
});

test('Codex runs on the author\'s own sign-in when they turned it on for reviews, through the console as it is, and on the team key otherwise', async (t) => {
  const { agents } = setup({ own: ['ana', 'cy'] });
  agents.set({ agents: 'both', by: 'joel' });
  assert.deepEqual(await agents.forReview({ login: 'ana' }), { agents: ['claude', 'codex'], codexLogin: 'ana', codexVia: 'chatgpt', codexAccount: 'acct-ana', why: null }, 'a ChatGPT login, with its account');
  assert.deepEqual(await agents.forReview({ login: 'cy' }), { agents: ['claude', 'codex'], codexLogin: 'cy', codexVia: 'key', why: null }, 'an API key');
  assert.deepEqual(await agents.forReview({ login: 'bo' }), { agents: ['claude', 'codex'], codexLogin: null, codexVia: 'key', why: null }, 'the team key');
  assert.deepEqual(await agents.forReview({ login: null }), { agents: ['claude', 'codex'], codexLogin: null, codexVia: 'key', why: null }, 'nobody\'s own');
});

test('an author whose saved ChatGPT login has expired gets the team key, or Claude Code alone, and is told why', async (t) => {
  const { agents } = setup({ own: ['old'] });
  agents.set({ agents: 'both', by: 'joel' });
  assert.deepEqual(await agents.forReview({ login: 'old' }), { agents: ['claude', 'codex'], codexLogin: null, codexVia: 'key', why: 'the author\'s saved Codex sign-in has expired' });
  const none = setup({ connected: { claude: true, codex: false }, own: ['old'] });
  none.agents.set({ agents: 'both', by: 'joel' });
  assert.match((await none.agents.forReview({ login: 'old' })).why, /expired, and the console has no OpenAI key/);
});

test('with no team OpenAI key, both can still be set: only authors with their own sign-in get Codex, and the rest say why not', async (t) => {
  const { agents } = setup({ connected: { claude: true, codex: false }, own: ['ana'] });
  assert.equal(agents.set({ agents: 'both', by: 'joel' }), true);
  assert.deepEqual(await agents.forReview({ login: 'ana' }), { agents: ['claude', 'codex'], codexLogin: 'ana', codexVia: 'chatgpt', codexAccount: 'acct-ana', why: null });
  const other = await agents.forReview({ login: 'bo' });
  assert.deepEqual(other.agents, ['claude']);
  assert.match(other.why, /no Codex sign-in of their own for reviews, and the console has no OpenAI key/);
});
