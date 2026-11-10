import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWebhookDispatch } from '../../console/webhookDispatch.mjs';
import { createWebhookEvents } from '../../console/webhookEvents.mjs';
import { createWebhookQueue } from './webhookQueue.mjs';

function eventsLog(opts = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-events-')), 'webhookEvents.jsonl');
  return createWebhookEvents({ file, ...opts });
}

const URL = 'https://sqs.us-east-1.amazonaws.com/1/woodshed-cloud-webhooks';
// The queue over a fake AWS CLI, handing what it receives to the console's real dispatch.
function createWebhookConsumer({ queue, aws, ...dispatchOpts }) {
  const handler = createWebhookDispatch(dispatchOpts);
  const sqs = createWebhookQueue({ queue, aws });
  return { receiveOnce: (url) => sqs.receiveOnce(url, handler) };
}

const label = { source: 'github', type: 'label', number: 7, kind: 'issue', title: 'x', label: 'woodshed', login: 'joel', receivedAt: 't', deliveryId: 'd' };
const comment = { source: 'github', type: 'comment', number: 9, login: 'joel', commentId: 55, body: '/woodshed keep going', deliveryId: 'd' };

function setup(messages, { handleFails = false } = {}) {
  const calls = { aws: [], handled: [], alive: 0 };
  const fleet = {
    async handleWebhookTrigger(t) {
      calls.handled.push(t);
      if (handleFails) throw new Error('gh api failed: HTTP 502');
    },
    webhooksAlive() { calls.alive++; },
  };
  async function aws(args) {
    calls.aws.push(args.slice(0, 2).join(' '));
    if (args[1] === 'receive-message') return { Messages: messages };
    return null;
  }
  return { consumer: createWebhookConsumer({ queue: URL, label: 'woodshed', fleet, aws }), calls };
}

const sqsMessage = (body, id = 'm1') => ({ MessageId: id, ReceiptHandle: `r-${id}`, Body: typeof body === 'string' ? body : JSON.stringify(body) });

test('a handled message is deleted', async () => {
  const { consumer, calls } = setup([sqsMessage(label)]);
  assert.equal(await consumer.receiveOnce(URL), 1);
  assert.equal(calls.handled.length, 1);
  assert.equal(calls.alive, 1);
  assert.deepEqual(calls.aws, ['sqs receive-message', 'sqs delete-message']);
});

test('unreadable and irrelevant messages are deleted without reaching the fleet', async () => {
  const { consumer, calls } = setup([sqsMessage('not json', 'a'), sqsMessage({ ...label, label: 'bug' }, 'b')]);
  await consumer.receiveOnce(URL);
  assert.equal(calls.handled.length, 0);
  assert.deepEqual(calls.aws, ['sqs receive-message', 'sqs delete-message', 'sqs delete-message']);
});

test('a message the fleet fails on stays on the queue for a retry', async () => {
  const { consumer, calls } = setup([sqsMessage(comment)], { handleFails: true });
  await consumer.receiveOnce(URL);
  assert.equal(calls.handled.length, 1);
  assert.deepEqual(calls.aws, ['sqs receive-message']);
});

test('each message for the console lands in the events log with what came of it, newest first; others are left out', async () => {
  const events = eventsLog({ now: () => Date.parse('2026-10-22T10:00:00Z') });
  const fleet = {
    async handleWebhookTrigger(t) {
      if (t.number === 9) throw new Error('gh api failed: HTTP 502');
      return { outcome: 'started', sessionId: '0a1b2c3d' };
    },
    webhooksAlive() {},
  };
  const messages = [sqsMessage(label, 'a'), sqsMessage({ ...label, label: 'bug' }, 'b'), sqsMessage('not json', 'c'),
    { ...sqsMessage(comment, 'd'), Attributes: { ApproximateReceiveCount: '2' } }];
  const aws = async (args) => (args[1] === 'receive-message' ? { Messages: messages } : null);
  await createWebhookConsumer({ queue: URL, label: 'woodshed', fleet, events, aws }).receiveOnce(URL);

  assert.deepEqual(events.list().map((e) => [e.number, e.outcome, e.sessionId, e.reason]), [
    [9, 'failed', null, 'gh api failed: HTTP 502 (try 2 of 3)'],
    [null, 'failed', null, 'the message was not JSON'],
    [7, 'started', '0a1b2c3d', null],
  ]);
  assert.equal(events.list()[0].detail, '/woodshed keep going');
});

test('a Slack mention goes to asks, is recorded, and deleted; without asks it is dropped', async () => {
  const mention = { source: 'slack', type: 'mention', eventId: 'Ev1', channel: 'C1', user: 'U1', ts: '1.1', text: '<@B1> why?', receivedAt: 't' };
  const handled = [];
  const asks = { async handleMention(m) { handled.push(m.eventId); return { outcome: 'started', sessionId: 'abcd1234' }; } };
  const calls = { aws: [] };
  async function aws(args) {
    calls.aws.push(args[1]);
    return args[1] === 'receive-message' ? { Messages: [{ Body: JSON.stringify(mention), ReceiptHandle: 'r' }] } : null;
  }
  const events = eventsLog();
  const fleet = { async handleWebhookTrigger() { throw new Error('not for the fleet'); }, webhooksAlive() {} };
  await createWebhookConsumer({ queue: URL, label: 'woodshed', fleet, asks, events, aws }).receiveOnce(URL);
  assert.deepEqual(handled, ['Ev1']);
  assert.deepEqual(calls.aws, ['receive-message', 'delete-message']);
  const [entry] = events.list();
  assert.equal(entry.type, 'mention');
  assert.equal(entry.login, 'slack:U1');
  assert.equal(entry.detail, 'why?');
  assert.equal(entry.outcome, 'started');

  calls.aws.length = 0;
  await createWebhookConsumer({ queue: URL, label: 'woodshed', fleet, events, aws }).receiveOnce(URL);
  assert.deepEqual(calls.aws, ['receive-message', 'delete-message']);
  assert.equal(events.list()[0].outcome, 'ignored');
  assert.equal(events.list()[0].reason, 'Slack questions are off on this console');

  const before = events.list().length;
  const reaction = { ...mention, type: 'reaction', eventId: 'Ev2' };
  const withReaction = async (args) => (args[1] === 'receive-message' ? { Messages: [{ Body: JSON.stringify(reaction), ReceiptHandle: 'r' }] } : null);
  await createWebhookConsumer({ queue: URL, label: 'woodshed', fleet, asks, events, aws: withReaction }).receiveOnce(URL);
  assert.equal(events.list().length, before, 'a Slack event that is not a mention is not kept');
});

// An App named as an installation would name its own: nothing may assume one installation's.
const APP = { available: true, login: async () => 'acme-woodshed[bot]' };

test('a session\'s Needs a human comment goes to the fleet, is recorded, and deleted', async () => {
  const needsHuman = {
    source: 'github', type: 'needsHuman', login: 'acme-woodshed[bot]', number: 26686, commentId: 5, url: 'u',
    body: 'Needs a human: @joel the fix could not be shown here.', receivedAt: 't',
  };
  const handled = [];
  const fleet = {
    async handleWebhookTrigger() { throw new Error('not a trigger'); },
    async handleNeedsHuman(m) { handled.push(m.commentId); return { outcome: 'sent', sessionId: 'abcd1234' }; },
    webhooksAlive() {},
  };
  const calls = [];
  async function aws(args) {
    calls.push(args[1]);
    return args[1] === 'receive-message' ? { Messages: [{ Body: JSON.stringify(needsHuman), ReceiptHandle: 'r' }] } : null;
  }
  const events = eventsLog();
  await createWebhookConsumer({ queue: URL, label: 'woodshed', fleet, events, aws, appIdentity: APP }).receiveOnce(URL);
  assert.deepEqual(handled, [5]);
  assert.deepEqual(calls, ['receive-message', 'delete-message']);
  assert.deepEqual(events.list().map((e) => [e.number, e.outcome, e.detail]), [[26686, 'sent', 'Needs a human: @joel the fix could not be shown here.']]);
});

test('a pull request change goes to pulls; one no reader has is deleted without a line in the events log', async () => {
  const change = (number) => ({ source: 'github', type: 'pr', kind: 'pr', number, numbers: [number], what: 'review submitted', login: 'joel', receivedAt: 't', deliveryId: `d${number}` });
  const calls = [];
  const aws = async (args) => {
    calls.push(args[1]);
    return args[1] === 'receive-message' ? { Messages: [sqsMessage(change(7), 'a'), sqsMessage(change(8), 'b')] } : null;
  };
  const pulls = { handle: (m) => (m.number === 7 ? { outcome: 'refreshed', reason: 'chip' } : { unrecorded: true }) };
  const events = eventsLog();
  const fleet = { async handleWebhookTrigger() { throw new Error('not a trigger'); }, webhooksAlive() {} };
  await createWebhookConsumer({ queue: URL, label: 'woodshed', fleet, pulls, events, aws }).receiveOnce(URL);
  assert.deepEqual(calls, ['receive-message', 'delete-message', 'delete-message']);
  assert.deepEqual(events.list().map((e) => [e.number, e.kind, e.outcome, e.detail, e.reason]), [[7, 'pr', 'refreshed', 'review submitted', 'chip']]);
});

test('a Needs a human comment is turned away unless the console\'s own App wrote it, and kept for a retry when the App cannot be read', async () => {
  const handled = [];
  const fleet = {
    async handleWebhookTrigger() { throw new Error('not a trigger'); },
    async handleNeedsHuman(m) { handled.push(m.commentId); return { outcome: 'sent' }; },
    webhooksAlive() {},
  };
  const comment = (login, commentId) => ({ source: 'github', type: 'needsHuman', login, number: 7, commentId, url: 'u', body: 'Needs a human: x', receivedAt: 't' });
  async function run(message, appIdentity) {
    const calls = [];
    const aws = async (args) => {
      calls.push(args[1]);
      return args[1] === 'receive-message' ? { Messages: [{ Body: JSON.stringify(message), ReceiptHandle: 'r' }] } : null;
    };
    const events = eventsLog();
    await createWebhookConsumer({ queue: URL, label: 'woodshed', fleet, events, aws, appIdentity }).receiveOnce(URL);
    return { calls, events: events.list() };
  }

  const person = await run(comment('joel', 1), APP);
  assert.deepEqual([person.calls, person.events], [['receive-message', 'delete-message'], []], 'a person typing the words: deleted, not logged');
  const oldName = await run(comment('woodshed-cloud[bot]', 2), APP);
  assert.deepEqual(oldName.calls, ['receive-message', 'delete-message'], 'another App\'s login is not this console\'s');
  const noApp = await run(comment('acme-woodshed[bot]', 3), { available: false, login: async () => null });
  assert.deepEqual(noApp.calls, ['receive-message', 'delete-message'], 'a console with no App has no session that could have written it');
  const unread = await run(comment('acme-woodshed[bot]', 4), { available: true, login: async () => null });
  assert.deepEqual(unread.calls, ['receive-message'], 'GitHub not answering: left on the queue for a retry');
  assert.deepEqual(handled, []);
});
