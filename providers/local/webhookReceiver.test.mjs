import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { createWebhookReceiver } from './webhookReceiver.mjs';

const SECRET = 'whsec-test';
const sign = (body) => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
const label = JSON.stringify({ action: 'labeled', label: { name: 'woodshed' }, issue: { number: 7, title: 'x' }, sender: { login: 'joel' }, repository: { full_name: 'o/r' } });

async function start({ values = { 'github-webhook-secret': SECRET }, dispatch } = {}) {
  const dispatched = [];
  let alive = 0;
  const receiver = createWebhookReceiver({ host: '127.0.0.1', port: 0, secrets: { read: async (n) => values[n] ?? null }, sleep: async () => {} });
  await receiver.run({
    dispatch: dispatch ?? (async (m) => { dispatched.push(m); return true; }),
    alive: () => { alive++; },
  });
  const url = `http://127.0.0.1:${receiver.address().port}`;
  return { receiver, url, dispatched, alive: () => alive };
}

function post(url, path, body, headers) {
  return fetch(`${url}${path}`, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });
}

test('a signed GitHub delivery is checked with the store\'s secret and handed to the dispatch, as the queue hands it', async (t) => {
  const r = await start();
  t.after(() => r.receiver.close());
  assert.equal(r.alive(), 1, 'listening counts as webhooks reachable');
  const res = await post(r.url, '/github', label, { 'x-github-event': 'issues', 'x-github-delivery': 'd1', 'x-hub-signature-256': sign(label) });
  assert.equal(res.status, 202);
  await r.receiver.close();
  assert.equal(r.dispatched.length, 1);
  const message = JSON.parse(r.dispatched[0].text);
  assert.deepEqual([message.source, message.type, message.number, message.label, r.dispatched[0].attempt], ['github', 'label', 7, 'woodshed', 'try 1 of 3']);
});

test('a bad signature, another path, and a delivery before the secret is set are refused, and nothing is dispatched', async (t) => {
  const r = await start();
  t.after(() => r.receiver.close());
  assert.equal((await post(r.url, '/github', label, { 'x-github-event': 'issues', 'x-hub-signature-256': 'sha256=00' })).status, 401);
  assert.equal((await post(r.url, '/other', label, {})).status, 404);
  assert.equal((await post(r.url, '/slack', '{}', {})).status, 503, 'no Slack signing secret yet');
  const unset = await start({ values: {} });
  t.after(() => unset.receiver.close());
  assert.equal((await post(unset.url, '/github', label, { 'x-github-event': 'issues', 'x-hub-signature-256': sign(label) })).status, 503);
  assert.equal(r.dispatched.length + unset.dispatched.length, 0);
});

test('a message the console fails on is tried again, up to three times, then dropped', async (t) => {
  const attempts = [];
  const r = await start({ dispatch: async (m) => { attempts.push(m.attempt); return attempts.length === 3; } });
  t.after(() => r.receiver.close());
  await post(r.url, '/github', label, { 'x-github-event': 'issues', 'x-hub-signature-256': sign(label) });
  await r.receiver.close();
  assert.deepEqual(attempts, ['try 1 of 3', 'try 2 of 3', 'try 3 of 3']);
});

test('a receiver whose port is taken logs it and does not throw, so the console still polls', async (t) => {
  const first = await start();
  t.after(() => first.receiver.close());
  const port = first.receiver.address().port;
  const second = createWebhookReceiver({ host: '127.0.0.1', port, secrets: { read: async () => SECRET } });
  await second.run({ dispatch: async () => true, alive: () => assert.fail('not listening') });
  assert.equal(second.address(), null);
});

test('a dispatch that throws is a failed try, and the queue goes on with the next message', async (t) => {
  const seen = [];
  const r = await start({ dispatch: async (m) => { seen.push(m.attempt); if (seen.length === 1) throw new Error('boom'); return true; } });
  t.after(() => r.receiver.close());
  const headers = { 'x-github-event': 'issues', 'x-hub-signature-256': sign(label) };
  await post(r.url, '/github', label, headers);
  await r.receiver.close();
  assert.deepEqual(seen, ['try 1 of 3', 'try 2 of 3']);
  // Always throwing: three tries, then dropped. An unhandled rejection on the way would fail this run.
  let tries = 0;
  const again = await start({ dispatch: async () => { tries++; throw new Error('always'); } });
  t.after(() => again.receiver.close());
  assert.equal((await post(again.url, '/github', label, headers)).status, 202);
  await again.receiver.close();
  assert.equal(tries, 3);
});
