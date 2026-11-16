import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { createHandler, toMessage, toSlackMessage, verifySignature, verifySlackSignature } from './index.mjs';

const SECRET = 'hook-secret';
const NOW = new Date('2026-10-22T10:00:00.000Z');

function sign(body, secret = SECRET) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function request({ event, payload, path = '/github', method = 'POST', signature, base64 = false }) {
  const body = JSON.stringify(payload);
  return {
    rawPath: path,
    requestContext: { http: { method } },
    headers: {
      'X-GitHub-Event': event,
      'X-GitHub-Delivery': 'd-1',
      ...(signature === null ? {} : { 'X-Hub-Signature-256': signature ?? sign(body) }),
    },
    body: base64 ? Buffer.from(body).toString('base64') : body,
    isBase64Encoded: base64,
  };
}

function setup() {
  const queued = [];
  const handle = createHandler({ getSecret: async () => SECRET, enqueue: async (m) => { queued.push(m); }, now: () => NOW });
  return { handle, queued };
}

const labeled = {
  action: 'labeled', label: { name: 'woodshed' }, sender: { login: 'joel' },
  issue: { number: 25769, title: 'First test' }, repository: { full_name: 'acme/app' },
};

test('verifySignature accepts GitHub\'s signature and nothing else', () => {
  const body = Buffer.from('{"a":1}');
  assert.equal(verifySignature(SECRET, body, sign(body)), true);
  assert.equal(verifySignature(SECRET, body, sign(body, 'other')), false);
  assert.equal(verifySignature(SECRET, body, sign(body).replace('sha256=', 'sha1=')), false);
  assert.equal(verifySignature(SECRET, body, undefined), false);
  assert.equal(verifySignature('', body, sign(body, '')), false);
});

test('a signed label event is queued as a small message', async () => {
  const { handle, queued } = setup();
  const res = await handle(request({ event: 'issues', payload: labeled }));
  assert.equal(res.statusCode, 202);
  assert.deepEqual(queued, [{
    source: 'github', deliveryId: 'd-1', receivedAt: NOW.toISOString(), login: 'joel', repo: 'acme/app',
    type: 'label', number: 25769, kind: 'issue', title: 'First test', label: 'woodshed',
  }]);
});

test('a bad or missing signature is refused and queues nothing', async () => {
  const { handle, queued } = setup();
  assert.equal((await handle(request({ event: 'issues', payload: labeled, signature: 'sha256=00' }))).statusCode, 401);
  assert.equal((await handle(request({ event: 'issues', payload: labeled, signature: null }))).statusCode, 401);
  assert.deepEqual(queued, []);
});

test('a base64 body from the Function URL is verified against its decoded bytes', async () => {
  const { handle, queued } = setup();
  assert.equal((await handle(request({ event: 'issues', payload: labeled, base64: true }))).statusCode, 202);
  assert.equal(queued.length, 1);
});

test('only /github takes POSTs; /slack is not built yet', async () => {
  const { handle } = setup();
  assert.equal((await handle(request({ event: 'issues', payload: labeled, path: '/slack' }))).statusCode, 404);
  assert.equal((await handle(request({ event: 'issues', payload: labeled, method: 'GET' }))).statusCode, 405);
});

test('ping answers without queueing', async () => {
  const { handle, queued } = setup();
  assert.equal((await handle(request({ event: 'ping', payload: { zen: 'hi' } }))).statusCode, 200);
  assert.deepEqual(queued, []);
});

test('events the console does not act on are acknowledged and dropped', async () => {
  const { handle, queued } = setup();
  const unlabeled = { ...labeled, action: 'unlabeled' };
  const talk = { action: 'created', issue: { number: 9 }, comment: { id: 1, body: 'just talking' }, sender: { login: 'a' } };
  const push = { ref: 'refs/heads/master' };
  for (const [event, payload] of [['issues', unlabeled], ['issue_comment', talk], ['push', push]]) {
    assert.equal((await handle(request({ event, payload }))).statusCode, 204, event);
  }
  assert.deepEqual(queued, []);
});

test('toMessage keeps /woodshed comments and PR labels', () => {
  const meta = { deliveryId: 'd', receivedAt: 't' };
  assert.deepEqual(
    toMessage('issue_comment', {
      action: 'created', sender: { login: 'b' }, issue: { number: 9 },
      comment: { id: 77, created_at: '2026-10-22T09:59:00Z', body: '/woodshed go on' },
    }, meta),
    { source: 'github', deliveryId: 'd', receivedAt: 't', login: 'b', repo: null, type: 'comment', number: 9, commentId: 77, createdAt: '2026-10-22T09:59:00Z', body: '/woodshed go on' },
  );
  assert.equal(
    toMessage('pull_request', { action: 'labeled', label: { name: 'woodshed' }, sender: { login: 'c' }, pull_request: { number: 5, title: 'PR' } }, meta).kind,
    'pr',
  );
  assert.equal(toMessage('issue_comment', { action: 'edited', issue: { number: 9 }, comment: { id: 1, body: '/woodshed x' } }, meta), null);
});

test('after the secret is rotated, a delivery signed with the new one reads the secret again and is queued', async () => {
  const queued = [];
  const reads = [];
  const getSecret = async ({ fresh = false } = {}) => {
    reads.push(fresh);
    return fresh ? 'rotated' : SECRET;
  };
  const handle = createHandler({ getSecret, enqueue: async (m) => { queued.push(m); }, now: () => NOW });
  const body = JSON.stringify(labeled);
  const res = await handle(request({ event: 'issues', payload: labeled, signature: sign(body, 'rotated') }));
  assert.equal(res.statusCode, 202);
  assert.deepEqual(reads, [false, true]);
  assert.equal(queued.length, 1);

  reads.length = 0;
  await handle(request({ event: 'issues', payload: labeled }));
  assert.deepEqual(reads, [false], 'a delivery the cached secret signs reads nothing more');
});

const SLACK_SECRET = 'slack-signing';

function slackSign(body, timestamp, secret = SLACK_SECRET) {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
}

function slackRequest({ payload, timestamp = String(NOW.getTime() / 1000), signature }) {
  const body = JSON.stringify(payload);
  return {
    rawPath: '/slack',
    requestContext: { http: { method: 'POST' } },
    headers: { 'X-Slack-Request-Timestamp': timestamp, 'X-Slack-Signature': signature ?? slackSign(body, timestamp) },
    body,
    isBase64Encoded: false,
  };
}

function slackSetup() {
  const queued = [];
  const handle = createHandler({
    getSecret: async () => SECRET, getSlackSecret: async () => SLACK_SECRET, enqueue: async (m) => { queued.push(m); }, now: () => NOW,
  });
  return { handle, queued };
}

const mention = {
  type: 'event_callback', team_id: 'T1', event_id: 'Ev1',
  event: { type: 'app_mention', user: 'U1', user_team: 'T1', channel: 'C1', ts: '1700000000.000100', text: '<@B1> how do retries work?' },
};

test('verifySlackSignature accepts Slack\'s signature within five minutes, and nothing else', () => {
  const body = Buffer.from('{"a":1}');
  const ts = String(NOW.getTime() / 1000);
  const nowMs = NOW.getTime();
  assert.equal(verifySlackSignature(SLACK_SECRET, body, { signature: slackSign(body, ts), timestamp: ts, nowMs }), true);
  assert.equal(verifySlackSignature(SLACK_SECRET, body, { signature: slackSign(body, ts, 'other'), timestamp: ts, nowMs }), false);
  const old = String(NOW.getTime() / 1000 - 301);
  assert.equal(verifySlackSignature(SLACK_SECRET, body, { signature: slackSign(body, old), timestamp: old, nowMs }), false);
  assert.equal(verifySlackSignature('', body, { signature: slackSign(body, ts, ''), timestamp: ts, nowMs }), false);
});

test('a signed mention of the bot is queued as a small message', async () => {
  const { handle, queued } = slackSetup();
  const res = await handle(slackRequest({ payload: mention }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(queued, [{
    source: 'slack', type: 'mention', eventId: 'Ev1', receivedAt: NOW.toISOString(), team: 'T1',
    channel: 'C1', user: 'U1', ts: '1700000000.000100', threadTs: null, text: '<@B1> how do retries work?',
  }]);
});

test('Slack\'s URL check gets its challenge back, once signed', async () => {
  const { handle, queued } = slackSetup();
  const res = await handle(slackRequest({ payload: { type: 'url_verification', challenge: 'abc' } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'abc');
  assert.equal(queued.length, 0);
});

test('an unsigned or stale Slack request is refused', async () => {
  const { handle, queued } = slackSetup();
  assert.equal((await handle(slackRequest({ payload: mention, signature: 'v0=nope' }))).statusCode, 401);
  assert.equal((await handle(slackRequest({ payload: mention, timestamp: String(NOW.getTime() / 1000 - 600) }))).statusCode, 401);
  assert.equal(queued.length, 0);
});

test('/slack is a 404 until the Lambda has a Slack secret', async () => {
  const { handle } = setup();
  assert.equal((await handle(slackRequest({ payload: mention }))).statusCode, 404);
});

test('toSlackMessage keeps people\'s mentions in this workspace only', () => {
  const at = { receivedAt: NOW.toISOString() };
  assert.equal(toSlackMessage({ ...mention, event: { ...mention.event, bot_id: 'B9' } }, at), null);
  assert.equal(toSlackMessage({ ...mention, event: { ...mention.event, subtype: 'message_changed' } }, at), null);
  assert.equal(toSlackMessage({ ...mention, event: { ...mention.event, user_team: 'T2' } }, at), null);
  assert.equal(toSlackMessage({ ...mention, event: { ...mention.event, type: 'message' } }, at), null);
  assert.equal(toSlackMessage({ ...mention, event: { ...mention.event, thread_ts: '1699.1' } }, at).threadTs, '1699.1');
});

test('toMessage passes on a Needs a human comment with its author, for the console to check against its App', () => {
  const meta = { deliveryId: 'd', receivedAt: '2026-11-04T17:00:00Z' };
  const comment = (login, body) => toMessage('issue_comment', {
    action: 'created', sender: { login }, issue: { number: 26686 },
    comment: { id: 77, user: { login }, body, html_url: 'https://github.com/o/r/pull/26686#issuecomment-77' },
  }, meta);
  // Any App's name: each installation names its own, so the handler cannot know which (console/appIdentity.mjs does).
  assert.deepEqual(comment('acme-woodshed[bot]', 'Needs a human: @joel the fix could not be shown here.'), {
    source: 'github', deliveryId: 'd', receivedAt: '2026-11-04T17:00:00Z', login: 'acme-woodshed[bot]', repo: null, type: 'needsHuman',
    number: 26686, commentId: 77, url: 'https://github.com/o/r/pull/26686#issuecomment-77', body: 'Needs a human: @joel the fix could not be shown here.',
  });
  assert.equal(comment('joel', 'Needs a human: please look').login, 'joel', 'a person typing the words reaches the console with their login, which turns it away');
  assert.equal(comment('acme-woodshed[bot]', 'Started a Woodshed session for @joel'), null);
});

test('toMessage turns a change to a pull request, its review or a workflow run on it into a pr message', () => {
  const meta = { deliveryId: 'g', receivedAt: 't' };
  const sender = { login: 'c' };
  assert.deepEqual(
    toMessage('pull_request', { action: 'closed', sender, pull_request: { number: 5 } }, meta),
    { source: 'github', deliveryId: 'g', receivedAt: 't', login: 'c', repo: null, type: 'pr', kind: 'pr', number: 5, numbers: [5], what: 'pull request closed' },
  );
  assert.equal(toMessage('pull_request_review', { action: 'submitted', sender, pull_request: { number: 6 } }, meta).what, 'review submitted');
  assert.equal(toMessage('pull_request', { action: 'opened', sender, pull_request: { number: 5 } }, meta).what, 'pull request opened', 'a new pull request may need the QA label');
  const run = toMessage('workflow_run', {
    action: 'completed', sender, workflow_run: { name: 'Claude Code Review', conclusion: 'success', pull_requests: [{ number: 7 }, { number: 8 }] },
  }, meta);
  assert.deepEqual([run.type, run.number, run.numbers, run.what], ['pr', 7, [7, 8], 'Claude Code Review success']);
  assert.equal(toMessage('pull_request', { action: 'labeled', label: { name: 'bug' }, sender, pull_request: { number: 5 } }, meta).type, 'label', 'a label stays a label');
});

test('toMessage drops pull request events that change nothing the console shows', () => {
  const meta = { deliveryId: 'g', receivedAt: 't' };
  assert.equal(toMessage('pull_request', { action: 'review_requested', pull_request: { number: 5 } }, meta), null);
  assert.equal(toMessage('pull_request_review', { action: 'edited', pull_request: { number: 5 } }, meta), null);
  assert.equal(toMessage('workflow_run', { action: 'in_progress', workflow_run: { pull_requests: [{ number: 5 }] } }, meta), null);
  assert.equal(toMessage('workflow_run', { action: 'completed', workflow_run: { pull_requests: [] } }, meta), null, 'a run on master has no pull request');
});
