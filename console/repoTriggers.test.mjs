import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRepoTriggers, labelProblem, sameLabel } from './repoTriggers.mjs';
import { createWebhookDispatch, messageToTrigger, pollMisses } from './webhookDispatch.mjs';
import { createWebhookSwitch } from './webhookSwitch.mjs';

const memoryStore = () => ({ state: {}, saves: 0, save() { this.saves += 1; } });

test('a repo never set has the console\'s label with both switches on', () => {
  const triggers = createRepoTriggers({ store: memoryStore(), config: { label: 'woodshed' } });
  assert.deepEqual(triggers.of('app'), { label: 'woodshed', labels: true, comments: true, labelSet: false });
  assert.deepEqual(triggers.of(null), { label: 'woodshed', labels: true, comments: true, labelSet: false });
});

test('each repo keeps its own label and switches in state.json, logged with who changed them', async () => {
  const store = memoryStore();
  const triggers = createRepoTriggers({ store, config: { label: 'woodshed' } });
  const logged = [];
  const log = console.log;
  console.log = (msg, fields) => logged.push([msg, fields]);
  try {
    assert.equal(await triggers.set({ project: 'app', label: 'agent', comments: false, by: 'mia' }), 2);
    assert.equal(await triggers.set({ project: 'app', label: 'agent', by: 'mia' }), 0, 'the same value changes nothing');
  } finally {
    console.log = log;
  }
  assert.deepEqual(store.state.repoTriggers, { app: { label: 'agent', commentsOff: true } });
  assert.deepEqual(triggers.of('app'), { label: 'agent', labels: true, comments: false, labelSet: true });
  assert.deepEqual(triggers.of('tools').label, 'woodshed', 'another repo is untouched');
  assert.deepEqual(logged, [
    ['repoTriggers: changed', { project: 'app', key: 'label', from: 'woodshed', to: 'agent', by: 'mia' }],
    ['repoTriggers: changed', { project: 'app', key: 'comments', from: true, to: false, by: 'mia' }],
  ]);
  await triggers.set({ project: 'app', label: 'woodshed', comments: true, by: 'mia' });
  assert.equal(store.state.repoTriggers.app, undefined, 'back to the console\'s label and on: nothing kept, so WOODSHED_LABEL still applies');
  await triggers.set({ project: 'app', labels: false, by: 'mia' });
  triggers.forget('app');
  assert.equal(triggers.of('app').labels, true, 'a removed repo added again starts on');
});

test('a label GitHub would not take, the repo\'s QA label, or a switch that is not true or false is refused', async () => {
  const triggers = createRepoTriggers({ store: memoryStore(), config: { label: 'woodshed' }, qaLabelOf: async () => 'QA' });
  await assert.rejects(triggers.set({ project: 'app', label: 'qa', by: 'mia' }), /is this repo's QA label/);
  await assert.rejects(triggers.set({ project: 'app', label: 'a,b', by: 'mia' }), /comma/);
  await assert.rejects(triggers.set({ project: 'app', label: ' agent', by: 'mia' }), /space/);
  await assert.rejects(triggers.set({ project: 'app', label: 'x'.repeat(51), by: 'mia' }), /at most 50/);
  await assert.rejects(triggers.set({ project: 'app', labels: 'no', by: 'mia' }), /true or false/);
  const unreadable = createRepoTriggers({ store: memoryStore(), config: { label: 'woodshed' }, qaLabelOf: async () => { throw new Error('no file'); } });
  assert.equal(await unreadable.set({ project: 'app', label: 'agent', by: 'mia' }), 1, 'a project file that cannot be read does not block the change');
  assert.equal(labelProblem('merge risk: low'), null);
  assert.ok(sameLabel('Agent', 'agent'));
});

test('a webhook label is matched against its repo\'s own label, and its QA label still goes to QA', async () => {
  const config = { projects: [{ name: 'app', repo: 'o/app', default: true }, { name: 'tools', repo: 'o/tools' }] };
  const triggers = createRepoTriggers({ store: memoryStore(), config: { label: 'woodshed' } });
  await triggers.set({ project: 'tools', label: 'agent', by: 'mia' });
  const handled = [];
  const qa = [];
  const fleet = {
    async handleWebhookTrigger(t) { handled.push([t.project ?? 'app', t.number]); return { outcome: 'started' }; },
    async handleQaLabel(t) { qa.push([t.project ?? 'app', t.label]); return { unrecorded: true }; },
    webhooksAlive() {},
  };
  const dispatch = createWebhookDispatch({ label: 'woodshed', labelOf: (name) => triggers.of(name ?? 'app').label, config, fleet });
  const label = (repo, name, number, kind = 'issue') => ({ text: JSON.stringify({ source: 'github', type: 'label', repo, number, kind, title: '', label: name, login: 'joel' }) });
  await dispatch.dispatch(label('o/tools', 'Agent', 1));
  await dispatch.dispatch(label('o/tools', 'woodshed', 2));
  await dispatch.dispatch(label('o/app', 'woodshed', 3));
  await dispatch.dispatch(label('o/tools', 'woodshed', 4, 'pr'));
  assert.deepEqual(handled, [['tools', 1], ['app', 3]], 'woodshed on tools is no longer its label');
  assert.deepEqual(qa, [['tools', 'woodshed']], 'another label on a pull request is the fleet\'s to check for QA');
  assert.equal(messageToTrigger({ source: 'github', type: 'label', number: 1, kind: 'issue', label: 'AGENT', login: 'j' }, { label: 'agent' }).trigger, 'label');
});

test('with GitHub\'s webhooks off, a repo\'s own label is not logged as one the poll misses', async () => {
  const config = { projects: [{ name: 'app', repo: 'o/app', default: true }, { name: 'tools', repo: 'o/tools' }] };
  const triggers = createRepoTriggers({ store: memoryStore(), config: { label: 'woodshed' } });
  await triggers.set({ project: 'tools', label: 'agent', by: 'mia' });
  const sw = createWebhookSwitch({ store: memoryStore() });
  sw.set({ source: 'github', off: true, by: 'mia' });
  const missed = [];
  const dropped = sw.dropped;
  sw.dropped = (source, kind) => { missed.push(kind); dropped(source, kind); };
  const dispatch = createWebhookDispatch({ label: 'woodshed', labelOf: (name) => triggers.of(name ?? 'app').label, config, fleet: { webhooksAlive() {} }, webhookSwitch: sw });
  const warn = console.warn;
  console.warn = () => {};
  try {
    await dispatch.dispatch({ text: JSON.stringify({ source: 'github', type: 'label', repo: 'o/tools', number: 1, kind: 'pr', label: 'agent', login: 'j' }) });
    await dispatch.dispatch({ text: JSON.stringify({ source: 'github', type: 'label', repo: 'o/tools', number: 2, kind: 'pr', label: 'qa', login: 'j' }) });
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(missed, [null, 'QA label']);
  assert.equal(pollMisses({ type: 'label', kind: 'pr', label: 'Agent' }, 'agent'), null);
});
