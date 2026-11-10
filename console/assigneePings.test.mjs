import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAssigneePings } from './assigneePings.mjs';

function setup({ links = { 'ana-dev': 'U01ANA00001' }, fail = false } = {}) {
  const sent = [];
  const slack = { async dm(msg) { if (fail) throw new Error('slack: rate limited'); sent.push(msg); return true; } };
  const slackPeople = { slackUserFor: (login) => links[login] ?? null };
  return { sent, pings: createAssigneePings({ slack, slackPeople, publicUrl: 'https://console.test' }) };
}

const shared = { id: 'aaaa1111', title: 'Fix <duplicate> runs', owner: null, assignee: 'ana-dev' };

test('the assignee hears that their session needs them, by a direct message with its link', async () => {
  const { sent, pings } = setup();
  assert.equal(await pings.needsYou(shared), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].user, 'U01ANA00001');
  assert.match(sent[0].markdown, /^“Fix ‹duplicate› runs” needs you/, 'angle brackets cannot make a Slack link or mention, and no entity shows');
  assert.match(sent[0].markdown, /https:\/\/console\.test\/s\/aaaa1111$/);
});

test('a pull request that gave up says why, with the PR and the session', async () => {
  const { sent, pings } = setup();
  await pings.gaveUp(shared, { number: 7, url: 'https://github.com/o/r/pull/7', review: 'CHANGES_REQUESTED',
    suites: [{ name: 'e2e suite', outcome: 'failed' }, { name: 'smoke tests', outcome: 'green' }] });
  assert.match(sent[0].markdown, /#7 was not approved with green checks in time/);
  assert.match(sent[0].markdown, /Review: CHANGES_REQUESTED\. E2e suite: failed\. Smoke tests: green\./);
  assert.match(sent[0].markdown, /https:\/\/github\.com\/o\/r\/pull\/7 · https:\/\/console\.test\/s\/aaaa1111$/);
});

test('nobody is messaged without an assignee with a Slack link, or for a private session', async () => {
  const { sent, pings } = setup();
  assert.equal(await pings.needsYou({ ...shared, assignee: null }), false, 'unassigned');
  assert.equal(await pings.needsYou({ ...shared, assignee: 'mrivera' }), false, 'no Slack link: skipped, not sent to the channel');
  assert.equal(await pings.needsYou({ ...shared, owner: 'ana-dev' }), false, 'a private session has no assignee to tell');
  assert.deepEqual(sent, []);
});

test('a title with Markdown in it stays plain text in quotes', async () => {
  const { sent, pings } = setup();
  await pings.needsYou({ ...shared, title: 'Fix *bold* and _under_ in env' });
  assert.match(sent[0].markdown, /^“Fix \*bold\* and _under_ in env” needs you/);
});

test('a console with no Slack client skips, and says so rather than blaming the link', async () => {
  const pings = createAssigneePings({ slack: null, slackPeople: { slackUserFor: () => 'U01ANA00001' }, publicUrl: 'https://console.test' });
  assert.equal(await pings.needsYou(shared), false);
});

test('a message Slack refuses changes nothing else', async () => {
  const { pings } = setup({ fail: true });
  assert.equal(await pings.needsYou(shared), false);
});

test('a ready pull request is no direct message: its brief and the mention are in the channel\'s thread', () => {
  const { pings } = setup();
  assert.equal(pings.prReady, undefined);
});

test('the assignee to mention in the thread follows the same rules as a message', () => {
  const { pings } = setup();
  assert.equal(pings.mentionFor(shared), 'U01ANA00001');
  assert.equal(pings.mentionFor({ ...shared, assignee: null }), null);
  assert.equal(pings.mentionFor({ ...shared, assignee: 'mrivera' }), null);
  assert.equal(pings.mentionFor({ ...shared, owner: 'ana-dev' }), null);
});

test('a Needs a human comment from the session reaches its assignee, with the comment and the session', async () => {
  const { sent, pings } = setup();
  assert.equal(await pings.needsHuman(shared, { number: 26686, url: 'https://github.com/o/r/pull/26686#issuecomment-9' }), true);
  assert.equal(sent[0].user, 'U01ANA00001');
  assert.match(sent[0].markdown, /^“Fix ‹duplicate› runs” needs a person: it left a “Needs a human” comment on #26686\./);
  assert.match(sent[0].markdown, /issuecomment-9 · https:\/\/console\.test\/s\/aaaa1111$/);
  assert.equal(await pings.needsHuman({ ...shared, owner: 'ana-dev' }, { number: 1, url: null }), false, 'not for a private session');
});
