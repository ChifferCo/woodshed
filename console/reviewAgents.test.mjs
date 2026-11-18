import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createReviewAgents } from './reviewAgents.mjs';

function setup(connected = { claude: true, codex: true }) {
  const store = { state: {}, saves: 0, save() { this.saves += 1; } };
  const now = { claude: connected.claude, codex: connected.codex };
  const agents = createReviewAgents({ store, connected: async () => ({ ...now }), now: () => Date.parse('2026-11-18T10:00:00Z') });
  return { store, agents, now };
}

test('reviews run on Claude Code alone until an admin asks for Codex too', async () => {
  const { agents } = setup();
  assert.deepEqual(await agents.forReview(), { agents: ['claude'], why: null });
  assert.equal((await agents.view()).agents, 'claude');
});

test('both, once set, is kept in state.json with who set it, and each review runs both', async () => {
  const { store, agents } = setup();
  assert.equal(await agents.set({ agents: 'both', by: 'joel' }), true);
  assert.deepEqual(store.state.reviewAgents, { agents: 'both', by: 'joel', at: '2026-11-18T10:00:00.000Z' });
  assert.equal(store.saves, 1);
  assert.deepEqual(await agents.forReview(), { agents: ['claude', 'codex'], why: null });
  assert.deepEqual(await agents.view(), { agents: 'both', by: 'joel', at: '2026-11-18T10:00:00.000Z', connected: { claude: true, codex: true } });
  assert.equal(await agents.set({ agents: 'both', by: 'joel' }), false, 'no change, nothing saved');
  assert.equal(store.saves, 1);
});

test('both is refused unless Claude and Codex are both connected, saying which key is missing', async () => {
  const { store, agents } = setup({ claude: true, codex: false });
  await assert.rejects(agents.set({ agents: 'both', by: 'joel' }), (err) => err.shown && err.status === 409 && /set openai-api-key/.test(err.message) && !/anthropic/.test(err.message));
  assert.equal(store.state.reviewAgents, undefined);
  const neither = setup({ claude: false, codex: false });
  await assert.rejects(neither.agents.set({ agents: 'both', by: 'joel' }), /set anthropic-api-key and set openai-api-key/);
  await assert.rejects(agents.set({ agents: 'codex', by: 'joel' }), /agents must be claude or both/);
});

test('a review started after the OpenAI key went runs on Claude Code alone, and says why', async () => {
  const { agents, now } = setup();
  await agents.set({ agents: 'both', by: 'joel' });
  now.codex = false;
  assert.deepEqual(await agents.forReview(), { agents: ['claude'], why: 'the console has no OpenAI key' });
  assert.equal(await agents.set({ agents: 'claude', by: 'joel' }), true, 'turning it off never needs the keys');
});
