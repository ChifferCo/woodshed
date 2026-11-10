import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPullWebhooks, FLOWING_MS } from './pullWebhooks.mjs';

test('a pull request change marks it due in each reader, and says which read it', () => {
  const pulls = createPullWebhooks({ now: () => 0 });
  const seen = [];
  pulls.watch({ name: 'chip', stale: (numbers) => { seen.push(['chip', numbers]); return numbers.filter((n) => n === 7); } });
  pulls.watch({ name: 'Slack post', stale: (numbers) => { seen.push(['slack', numbers]); return []; } });
  assert.deepEqual(pulls.handle({ type: 'pr', number: 7, numbers: [7, 8], what: 'review submitted' }), { outcome: 'refreshed', reason: 'chip' });
  assert.deepEqual(seen, [['chip', [7, 8]], ['slack', [7, 8]]]);
});

test('a change to a pull request no reader has is left out of the events log', () => {
  const pulls = createPullWebhooks({ now: () => 0 });
  pulls.watch({ name: 'chip', stale: () => [] });
  assert.deepEqual(pulls.handle({ type: 'pr', number: 5, numbers: [5] }), { unrecorded: true });
});

test('webhooks are flowing for half an hour after any pull request change, tracked or not', () => {
  let clock = 0;
  const pulls = createPullWebhooks({ now: () => clock });
  assert.equal(pulls.flowing(), false, 'none yet: the polls run at full speed');
  pulls.handle({ type: 'pr', number: 5, numbers: [5] });
  assert.equal(pulls.flowing(), true);
  clock += FLOWING_MS - 1;
  assert.equal(pulls.flowing(), true);
  clock += 1;
  assert.equal(pulls.flowing(), false, 'a quiet half hour: back to full speed');
});
