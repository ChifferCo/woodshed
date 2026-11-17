import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPullWebhooks } from './pullWebhooks.mjs';
import { createWebhookDispatch } from './webhookDispatch.mjs';
import { createWebhookSwitch } from './webhookSwitch.mjs';

const memoryStore = () => ({ state: {}, saves: 0, save() { this.saves += 1; } });
const label = { source: 'github', type: 'label', number: 7, kind: 'issue', title: 'x', label: 'woodshed', login: 'joel', deliveryId: 'd' };
const mention = { source: 'slack', type: 'mention', eventId: 'E1', channel: 'C1', text: 'hi' };

test('each switch is kept in state.json, says who turned it, and refuses anything but a source and true or false', () => {
  const store = memoryStore();
  let forgot = 0;
  const sw = createWebhookSwitch({ store, onOff: (source) => { if (source === 'github') forgot += 1; }, now: () => Date.parse('2026-11-17T10:00:00Z') });
  assert.equal(sw.off('github'), false);
  assert.equal(sw.set({ source: 'github', off: true, by: 'joel' }), true);
  assert.equal(sw.set({ source: 'github', off: true, by: 'joel' }), false, 'turning it off twice changes nothing');
  assert.deepEqual(store.state.webhooks, { github: { off: true, by: 'joel', at: '2026-11-17T10:00:00.000Z' } });
  assert.equal(sw.off('slack'), false, 'one source\'s switch leaves the other on');
  assert.equal(store.saves, 1);
  assert.equal(forgot, 1, 'turning it off forgets that pull request webhooks flowed');
  assert.equal(createWebhookSwitch({ store }).off('github'), true, 'a restarted console reads it back');
  assert.throws(() => sw.set({ source: 'github', off: 'yes', by: 'joel' }), /true or false/);
  assert.throws(() => sw.set({ source: 'jira', off: true, by: 'joel' }), /github or slack/);
  sw.set({ source: 'slack', off: true, by: 'ana' });
  sw.set({ source: 'github', off: false, by: 'ana' });
  assert.equal(forgot, 1);
  assert.equal(sw.view().github.off, false);
  assert.equal(sw.view().slack.by, 'ana');
});

test('GitHub\'s off, its messages are dropped and the fleet hears no webhooks; Slack mentions still come through', async () => {
  const store = memoryStore();
  const sw = createWebhookSwitch({ store });
  const triggers = [];
  const mentions = [];
  let alive = 0;
  const fleet = { async handleWebhookTrigger(t) { triggers.push(t.number); return { outcome: 'started', sessionId: 's1' }; }, webhooksAlive() { alive += 1; } };
  const asks = { async handleMention(b) { mentions.push(b.eventId); return { outcome: 'started' }; } };
  const recorded = [];
  const dispatch = createWebhookDispatch({ label: 'woodshed', fleet, asks, events: { record: (b, r) => recorded.push(r.outcome) }, webhookSwitch: sw });

  assert.equal(await dispatch.dispatch({ text: JSON.stringify(label) }), true);
  dispatch.alive();
  assert.deepEqual(triggers, [7]);
  assert.equal(alive, 1);

  sw.set({ source: 'github', off: true, by: 'joel' });
  assert.equal(await dispatch.dispatch({ text: JSON.stringify({ ...label, number: 8 }) }), true, 'the source forgets it');
  assert.equal(await dispatch.dispatch({ text: JSON.stringify({ source: 'github', type: 'pr', number: 9, what: 'pull request edited' }) }), true);
  dispatch.alive();
  assert.deepEqual(triggers, [7], 'nothing reached the fleet');
  assert.equal(alive, 1, 'so its poll goes back to full speed');
  assert.equal(sw.view().github.dropped, 2);
  assert.equal(await dispatch.dispatch({ text: JSON.stringify(mention) }), true);
  assert.deepEqual(mentions, ['E1']);
  assert.deepEqual(recorded, ['started', 'started']);

  sw.set({ source: 'github', off: false, by: 'joel' });
  await dispatch.dispatch({ text: JSON.stringify({ ...label, number: 10 }) });
  assert.deepEqual(triggers, [7, 10]);
  assert.equal(sw.view().github.dropped, 0);
});

test('Slack\'s off, mentions are dropped and logged as ignored; GitHub\'s still come through', async () => {
  const sw = createWebhookSwitch({ store: memoryStore() });
  const triggers = [];
  const mentions = [];
  let alive = 0;
  const fleet = { async handleWebhookTrigger(t) { triggers.push(t.number); return { outcome: 'started', sessionId: 's1' }; }, webhooksAlive() { alive += 1; } };
  const asks = { async handleMention(b) { mentions.push(b.eventId); return { outcome: 'started' }; } };
  const recorded = [];
  const dispatch = createWebhookDispatch({ label: 'woodshed', fleet, asks, events: { record: (b, r) => recorded.push(r) }, webhookSwitch: sw });
  sw.set({ source: 'slack', off: true, by: 'joel' });
  assert.equal(await dispatch.dispatch({ text: JSON.stringify(mention) }), true);
  assert.deepEqual(mentions, []);
  assert.deepEqual(recorded, [{ outcome: 'ignored', reason: 'Slack questions are switched off on Console settings' }]);
  assert.equal(sw.view().slack.dropped, 1);
  await dispatch.dispatch({ text: JSON.stringify(label) });
  dispatch.alive();
  assert.deepEqual(triggers, [7]);
  assert.equal(alive, 1);
  sw.set({ source: 'slack', off: false, by: 'joel' });
  await dispatch.dispatch({ text: JSON.stringify(mention) });
  assert.deepEqual(mentions, ['E1']);
});

test('forget puts the pull request readers back on their full speed at once', () => {
  const pulls = createPullWebhooks({ now: () => 1_000_000 });
  pulls.handle({ number: 1 });
  assert.equal(pulls.flowing(), true);
  pulls.forget();
  assert.equal(pulls.flowing(), false);
});

test('GitHub\'s off, what only a webhook starts is named in the log once per kind, and never reaches the fleet', async () => {
  const sw = createWebhookSwitch({ store: memoryStore() });
  const reached = [];
  const fleet = {
    async handleNeedsHuman() { reached.push('needsHuman'); return { outcome: 'sent' }; },
    async handleQaLabel() { reached.push('qa'); return { outcome: 'started' }; },
    async qaAfterReview() { reached.push('qaAfterReview'); },
    webhooksAlive() {},
  };
  const appIdentity = { available: true, login: async () => 'woodshed[bot]' };
  const dispatch = createWebhookDispatch({ label: 'woodshed', fleet, appIdentity, webhookSwitch: sw });
  const warned = [];
  const warn = console.warn;
  console.warn = (msg, fields) => warned.push([msg, fields?.kind]);
  try {
    sw.set({ source: 'github', off: true, by: 'joel' });
    await dispatch.dispatch({ text: JSON.stringify({ source: 'github', type: 'needsHuman', number: 3, login: 'woodshed[bot]' }) });
    await dispatch.dispatch({ text: JSON.stringify({ source: 'github', type: 'needsHuman', number: 4, login: 'woodshed[bot]' }) });
    await dispatch.dispatch({ text: JSON.stringify({ ...label, kind: 'pr', label: 'qa' }) });
    await dispatch.dispatch({ text: JSON.stringify({ source: 'github', type: 'pr', number: 5, what: 'review submitted' }) });
    await dispatch.dispatch({ text: JSON.stringify(label) });
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(reached, []);
  assert.deepEqual(warned.map(([, kind]) => kind), ['Needs a human', 'QA label', 'QA and review steps'], 'each kind once; the poll finds the label');
  assert.ok(warned.every(([msg]) => msg === 'webhooks: off, dropped a delivery the poll does not cover'));
  assert.equal(sw.view().github.dropped, 5);
});
