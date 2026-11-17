import { test } from 'node:test';
import assert from 'node:assert/strict';

import { claimEvent, claimOwner } from './claim.mjs';

const eyes = (login, at, id, type = 'Bot') => ({ id, content: 'eyes', created_at: at, user: { login, type } });

test('the earliest 👀 from a bot owns the work, and a person\'s 👀 never does', () => {
  assert.equal(claimOwner([eyes('b[bot]', '2026-11-16T10:00:02Z', 2), eyes('a[bot]', '2026-11-16T10:00:01Z', 1)]), 'a[bot]');
  assert.equal(claimOwner([eyes('ada', '2026-11-16T10:00:00Z', 1, 'User'), eyes('b[bot]', '2026-11-16T10:00:05Z', 2)]), 'b[bot]');
  assert.equal(claimOwner([eyes('b[bot]', '2026-11-16T10:00:00Z', 9), eyes('a[bot]', '2026-11-16T10:00:00Z', 3)]), 'a[bot]', 'the same second: the lower id');
  assert.equal(claimOwner([]), null);
});

function fakeGh(existing = []) {
  const reactions = [...existing];
  const reacted = [];
  return {
    reacted,
    gh: {
      async issueReactions() { return reactions; },
      async reactToIssue(number) { reacted.push(number); reactions.push(eyes('me[bot]', '2026-11-16T10:00:09Z', 99)); },
    },
  };
}

test('a console with no 👀 yet reacts, waits for the others, and owns it when its 👀 is the earliest', async () => {
  const { gh, reacted } = fakeGh();
  const waited = [];
  const result = await claimEvent({ gh, number: 7, login: 'me[bot]', waitMs: 5000, wait: async (ms) => { waited.push(ms); } });
  assert.deepEqual([result.claimed, reacted, waited], [true, [7], [5000]]);
});

test('another console\'s earlier 👀 keeps the work there, on this event and every later one, without reacting or waiting', async () => {
  const { gh, reacted } = fakeGh([eyes('other[bot]', '2026-11-16T09:00:00Z', 1)]);
  const result = await claimEvent({ gh, number: 7, login: 'me[bot]', waitMs: 5000, wait: async () => assert.fail('no wait') });
  assert.deepEqual([result.claimed, result.owner, reacted], [false, 'other[bot]', []]);
});

test('a pull request this console\'s App opened is its own without a race, and a console without an App login goes ahead', async () => {
  const { gh } = fakeGh([eyes('other[bot]', '2026-11-16T09:00:00Z', 1)]);
  assert.equal((await claimEvent({ gh, number: 7, login: 'me[bot]', authoredByUs: true, waitMs: 0, wait: async () => {} })).claimed, true);
  assert.equal((await claimEvent({ gh, number: 7, login: null, waitMs: 0, wait: async () => {} })).claimed, true);
});
