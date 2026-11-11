// The console's copy of the webhooks Lambda's toMessage (githubEvents.mjs) must make the same message from every
// event: a caller may hand the console raw events, and a console on AWS gets the Lambda's messages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { toMessage as consoleToMessage } from './githubEvents.mjs';
import { toMessage as lambdaToMessage } from '../providers/aws/webhooks/index.mjs';

const meta = { deliveryId: 'd-1', receivedAt: '2026-11-10T10:00:00.000Z' };
const sender = { login: 'octocat' };
const repository = { full_name: 'acme/app' };
const EVENTS = [
  ['issues', { action: 'labeled', label: { name: 'woodshed' }, sender, repository, issue: { number: 1, title: 'An issue' } }],
  ['issues', { action: 'labeled', label: { name: 'woodshed' }, sender, repository, issue: { number: 2, title: 'A PR as an issue', pull_request: {} } }],
  ['pull_request', { action: 'labeled', label: { name: 'woodshed' }, sender, repository, pull_request: { number: 3, title: 'PR' } }],
  ['issues', { action: 'labeled', sender, issue: { number: 4 } }],
  ['issue_comment', { action: 'created', sender, repository, issue: { number: 5 }, comment: { id: 9, body: '/woodshed carry on', created_at: '2026-11-10T09:00:00Z' } }],
  ['issue_comment', { action: 'created', sender, repository, issue: { number: 6 }, comment: { id: 10, body: 'just a comment' } }],
  ['issue_comment', { action: 'created', sender, repository, issue: { number: 7 }, comment: { id: 11, body: `/woodshed ${'x'.repeat(9000)}` } }],
  ['issue_comment', { action: 'created', sender, repository, issue: { number: 8 }, comment: { id: 12, body: 'Needs a human: the tests', user: { login: 'woodshed-app[bot]' }, html_url: 'https://github.com/acme/app/issues/8#c12' } }],
  ['issue_comment', { action: 'edited', sender, repository, issue: { number: 9 }, comment: { id: 13, body: '/woodshed x' } }],
  ['pull_request', { action: 'closed', sender, repository, pull_request: { number: 10 } }],
  ['pull_request', { action: 'review_requested', sender, repository, pull_request: { number: 11 } }],
  ['pull_request_review', { action: 'submitted', sender, repository, pull_request: { number: 12 } }],
  ['workflow_run', { action: 'completed', sender, repository, workflow_run: { name: 'CI', conclusion: 'failure', pull_requests: [{ number: 13 }, { number: 14 }] } }],
  ['workflow_run', { action: 'completed', sender, repository, workflow_run: { pull_requests: [] } }],
  ['push', { sender, repository }],
];

test('the console and the Lambda make the same message from every event', () => {
  for (const [event, payload] of EVENTS) {
    assert.deepEqual(consoleToMessage(event, payload, meta), lambdaToMessage(event, payload, meta), `${event} ${payload.action ?? ''}`);
  }
  assert.ok(EVENTS.filter(([event, payload]) => consoleToMessage(event, payload, meta)).length >= 8, 'most of them make a message');
});

test('the console\'s copy is the Lambda\'s code, line for line', () => {
  const body = (file, from, to) => {
    const text = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    return text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)));
  };
  const from = 'export function toMessage(';
  assert.equal(body('./githubEvents.mjs', from, '\n}\n\n/** @returns'), body('../providers/aws/webhooks/index.mjs', from, '\n}\n\n/** @returns'));
  const pulls = 'function changedPulls(';
  assert.equal(body('./githubEvents.mjs', pulls, '\n}\n'), body('../providers/aws/webhooks/index.mjs', pulls, '\n}\n'));
});
