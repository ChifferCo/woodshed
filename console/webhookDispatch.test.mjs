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

test('a GitHub message reaches the fleet naming the project of its repo, and one from a repo that is no project is dropped', async () => {
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
    handleWebhookTrigger: async (t) => { triggers.push([t.number, t.project ?? null]); return { outcome: 'routed' }; },
    handleNeedsHuman: async (b) => { needs.push([b.number, b.project ?? null]); return { outcome: 'told' }; },
    webhooksAlive() {},
  };
  const appIdentity = { available: true, login: async () => 'woodshed-app[bot]' };
  const pulls = { handle: async (b) => { prs.push([b.number, b.project ?? null]); } };
  const { dispatch } = createWebhookDispatch({ label: 'woodshed', config, fleet, pulls, appIdentity });
  const send = (message) => dispatch({ text: JSON.stringify(message) });

  assert.equal(await send({ ...label, number: 12, repo: 'Other/Repo' }), true, 'a repo that is not a project: dropped, not retried');
  assert.deepEqual([triggers, needs, prs], [[], [], []]);

  await send({ ...comment, number: 12, repo: 'acme/tools' });
  await send({ ...label, number: 14, repo: 'acme/tools' });
  await send({ source: 'github', type: 'needsHuman', number: 12, login: 'woodshed-app[bot]', repo: 'acme/tools' });
  await send({ source: 'github', type: 'pr', number: 12, numbers: [12], repo: 'acme/tools' });
  assert.deepEqual(triggers, [[12, 'tools'], [14, 'tools']], 'another project\'s: handed on naming it, so it never acts on the default repo\'s #12');
  assert.deepEqual(needs, [[12, 'tools']]);
  assert.deepEqual(prs, [[12, 'tools']]);

  await send({ ...comment, number: 9, repo: 'ACME/app' });
  await send({ ...comment, number: 10 });
  await send({ source: 'github', type: 'needsHuman', number: 11, login: 'woodshed-app[bot]', repo: 'acme/app' });
  await send({ source: 'github', type: 'pr', number: 13, numbers: [13], repo: 'acme/app' });
  assert.deepEqual(triggers.slice(2), [[9, null], [10, null]], 'the default repo\'s, in any case, and one from a Lambda that named no repo, as before');
  assert.deepEqual(needs.slice(1), [[11, null]]);
  assert.deepEqual(prs.slice(1), [[13, null]]);
});

test('messageToTrigger keeps the project of another project\'s message', () => {
  assert.equal(messageToTrigger({ ...label, project: 'tools' }, { label: 'woodshed' }).project, 'tools');
  assert.equal(messageToTrigger({ ...comment, project: 'tools' }, { label: 'woodshed' }).project, 'tools');
});
