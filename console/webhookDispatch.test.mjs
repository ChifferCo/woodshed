import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWebhookDispatch, messageToTrigger } from './webhookDispatch.mjs';

// What a whole message does, from the queue to the fleet, is in providers/aws/webhookQueue.test.mjs.
const label = { source: 'github', type: 'label', number: 7, kind: 'issue', title: 'x', label: 'woodshed', login: 'joel', receivedAt: 't', deliveryId: 'd' };
const comment = { source: 'github', type: 'comment', number: 9, login: 'joel', commentId: 55, body: '/woodshed keep going', deliveryId: 'd' };

test('messageToTrigger maps labels and /woodshed comments to the triggers the poll makes', () => {
  assert.deepEqual(messageToTrigger(label, { label: 'woodshed' }), { trigger: 'label', number: 7, title: 'x', kind: 'issue', login: 'joel', at: 't' });
  assert.deepEqual(messageToTrigger(comment, { label: 'woodshed' }), { trigger: 'comment', number: 9, login: 'joel', text: 'keep going', commentId: 55 });
});

test('messageToTrigger drops other labels, non-commands and anything malformed', () => {
  assert.equal(messageToTrigger({ ...label, label: 'bug' }, { label: 'woodshed' }), null);
  assert.equal(messageToTrigger({ ...comment, body: '/woodshedding' }, { label: 'woodshed' }), null);
  assert.equal(messageToTrigger({ ...label, number: '7' }, { label: 'woodshed' }), null);
  assert.equal(messageToTrigger({ ...label, source: 'slack' }, { label: 'woodshed' }), null);
  assert.equal(messageToTrigger(null, { label: 'woodshed' }), null);
});

test('a GitHub message reaches the fleet only when it is about the default project\'s repo', async () => {
  const config = {
    projects: [
      { name: 'app', repo: 'acme/app', default: true },
      { name: 'tools', repo: 'acme/tools', default: false },
    ],
  };
  const triggers = [];
  const needs = [];
  const prs = [];
  const fleet = {
    handleWebhookTrigger: async (t) => { triggers.push(t.number); return { outcome: 'routed' }; },
    handleNeedsHuman: async (b) => { needs.push(b.number); return { outcome: 'told' }; },
    webhooksAlive() {},
  };
  const appIdentity = { available: true, login: async () => 'woodshed-app[bot]' };
  const pulls = { handle: async (b) => { prs.push(b.number); } };
  const { dispatch } = createWebhookDispatch({ label: 'woodshed', config, fleet, pulls, appIdentity });
  const send = (message) => dispatch({ text: JSON.stringify(message) });

  assert.equal(await send({ ...comment, number: 12, repo: 'acme/tools' }), true, 'another project\'s: dropped, not retried');
  assert.equal(await send({ ...label, number: 12, repo: 'Other/Repo' }), true, 'a repo that is not a project: dropped');
  assert.equal(await send({ source: 'github', type: 'needsHuman', number: 12, login: 'woodshed-app[bot]', repo: 'acme/tools' }), true);
  assert.equal(await send({ source: 'github', type: 'pr', number: 12, numbers: [12], repo: 'acme/tools' }), true);
  assert.deepEqual([triggers, needs, prs], [[], [], []], 'nothing acted on the default repo\'s #12');

  await send({ ...comment, number: 9, repo: 'ACME/app' });
  await send({ ...comment, number: 10 });
  await send({ source: 'github', type: 'needsHuman', number: 11, login: 'woodshed-app[bot]', repo: 'acme/app' });
  await send({ source: 'github', type: 'pr', number: 13, numbers: [13], repo: 'acme/app' });
  assert.deepEqual(triggers, [9, 10], 'the default repo\'s, in any case, and one from a Lambda that named no repo');
  assert.deepEqual(needs, [11]);
  assert.deepEqual(prs, [13]);
});
