import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canWrite, checkGh, createGitHub, explainGhError, skillsFrom, commandTriggers, labelTriggers, partialGraphql, pullRow, rememberSeen,
} from './github.mjs';

// What execFile throws when there is no gh on the PATH.
function ghMissing() {
  return Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT', syscall: 'spawn gh', path: 'gh' });
}

test('a pull request row carries its branch, age, draft and checks, counted as the chips count them', () => {
  const contexts = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }, { state: 'SUCCESS' }];
  const node = { number: 26308, title: 'fix', headRefName: 'woodshed-cloud/fix', updatedAt: '2026-10-28T22:20:00Z', isDraft: false,
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: contexts } } } }] } };
  assert.deepEqual(pullRow(node, 'yours'), {
    number: 26308, title: 'fix', branch: 'woodshed-cloud/fix', why: 'yours', updatedAt: '2026-10-28T22:20:00Z', draft: false,
    checks: { pass: 2, fail: 0, pending: 1, total: 3 },
  });
  assert.equal(pullRow({ number: 1, title: 't', headRefName: 'b', isDraft: true }, 'review').checks, null, 'no checks yet');
  assert.equal(pullRow({ number: 1, title: 't', headRefName: 'b', isDraft: true }, 'review').draft, true);
});

test('a gh graphql call that failed on one missing pull request still gives the rest', () => {
  // What gh printed for one number that resolved and one that did not, as it exited 1.
  const stdout = '{"data":{"repository":{"a":{"number":26223},"b":null}},"errors":[{"type":"NOT_FOUND","path":["repository","b"]}]}';
  assert.deepEqual(partialGraphql(Object.assign(new Error('exit 1'), { stdout })).data.repository, { a: { number: 26223 }, b: null });
  assert.equal(partialGraphql(Object.assign(new Error('exit 1'), { stdout: '' })), null);
  assert.equal(partialGraphql(new Error('spawn gh ENOENT')), null);
});

test('canWrite accepts write, maintain and admin', () => {
  assert.equal(canWrite({ permission: 'write', role_name: 'write' }), true);
  assert.equal(canWrite({ permission: 'write', role_name: 'maintain' }), true);
  assert.equal(canWrite({ permission: 'admin', role_name: 'admin' }), true);
  assert.equal(canWrite({ permission: 'read', role_name: 'triage' }), false);
  assert.equal(canWrite(null), false);
});

test('labelTriggers keeps new events for our label, oldest first', () => {
  const events = [
    { id: 30, event: 'labeled', created_at: 't30', label: { name: 'woodshed' }, actor: { login: 'sid' }, issue: { number: 5, title: 'PR thing', pull_request: {} } },
    { id: 20, event: 'labeled', label: { name: 'bug' }, actor: { login: 'sid' }, issue: { number: 4, title: 'x' } },
    { id: 15, event: 'labeled', created_at: 't15', label: { name: 'woodshed' }, actor: { login: 'joel' }, issue: { number: 3, title: 'Issue thing' } },
    { id: 10, event: 'labeled', label: { name: 'woodshed' }, actor: { login: 'joel' }, issue: { number: 2, title: 'old' } },
    { id: 25, event: 'unlabeled', label: { name: 'woodshed' }, actor: { login: 'joel' }, issue: { number: 3, title: 'x' } },
  ];
  assert.deepEqual(labelTriggers(events, { label: 'woodshed', afterId: 10 }), [
    { id: 15, number: 3, title: 'Issue thing', kind: 'issue', login: 'joel', at: 't15' },
    { id: 30, number: 5, title: 'PR thing', kind: 'pr', login: 'sid', at: 't30' },
  ]);
});

test('commandTriggers reads /woodshed comments not seen and not older than the console', () => {
  const comments = [
    { id: 1, created_at: '2026-10-21T09:00:00Z', body: '/woodshed old', user: { login: 'a' }, issue_url: 'https://api.github.com/repos/o/r/issues/9' },
    { id: 2, created_at: '2026-10-21T11:00:00Z', body: '/woodshed go', user: { login: 'b' }, issue_url: 'https://api.github.com/repos/o/r/issues/9' },
    { id: 3, created_at: '2026-10-21T11:00:00Z', body: 'just talking', user: { login: 'c' }, issue_url: 'https://api.github.com/repos/o/r/issues/9' },
    { id: 4, created_at: '2026-10-21T11:00:00Z', body: '/woodshed seen', user: { login: 'd' }, issue_url: 'https://api.github.com/repos/o/r/issues/9' },
  ];
  assert.deepEqual(commandTriggers(comments, { seen: new Set([4]), notBefore: '2026-10-21T10:00:00Z' }), [
    { id: 2, number: 9, login: 'b', text: 'go' },
  ]);
});

test('rememberSeen keeps the latest 500 ids', () => {
  const seen = rememberSeen(Array.from({ length: 500 }, (_, i) => i), [500, 501]);
  assert.equal(seen.length, 500);
  assert.equal(seen[0], 2);
  assert.equal(seen.at(-1), 501);
});

test('the / list: each skill\'s front matter description, and each command as folder:name', () => {
  const blob = (text) => ({ text });
  const repository = {
    skills: { entries: [
      { name: 'implement', object: { entries: [{ name: 'SKILL.md', object: blob('---\nname: implement\ndescription: Plan first, then build.\n---\nBody') }] } },
      { name: 'folded', object: { entries: [{ name: 'SKILL.md', object: blob('---\ndescription: >\n  Two lines\n  folded.\nother: x\n---\n') }] } },
      { name: 'no-skill-file', object: { entries: [{ name: 'README.md', object: blob('x') }] } },
    ] },
    commands: { entries: [
      { name: 'team', object: { entries: [{ name: 'tidy-pr.md', object: blob('\nYou are tidying up the PR.\n') }, { name: 'push.sh', object: blob('#!/bin/sh') }] } },
    ] },
  };
  assert.deepEqual(skillsFrom(repository), [
    { name: 'folded', desc: 'Two lines folded.' },
    { name: 'implement', desc: 'Plan first, then build.' },
    { name: 'team:tidy-pr', desc: 'You are tidying up the PR.' },
  ]);
  assert.deepEqual(skillsFrom(null), []);
});

test('a console with no gh says so once at start, and one with gh says nothing', async () => {
  const warnings = [];
  const warn = (...line) => warnings.push(line);
  assert.equal(await checkGh({ run: async () => { throw ghMissing(); }, warn }), false);
  assert.deepEqual(warnings, [['console: gh not installed, GitHub calls will fail', { install: 'https://cli.github.com' }]]);
  warnings.length = 0;
  assert.equal(await checkGh({ run: async () => ({ stdout: 'gh version 2.62.0' }), warn }), true);
  assert.deepEqual(warnings, []);
});

test('a gh that is there but fails its version check is not reported as missing', async () => {
  const broken = Object.assign(new Error('Command failed: gh --version'), { code: 1 });
  await assert.rejects(checkGh({ run: async () => { throw broken; }, warn: () => assert.fail('warned') }), broken);
});

test('a GitHub call with no gh installed fails saying gh is not installed, not spawn gh ENOENT', async () => {
  const github = createGitHub({ repo: 'o/r', run: async () => { throw ghMissing(); } });
  await assert.rejects(github.canWrite('sid'), (err) => {
    assert.match(err.message, /^gh is not installed on the console/);
    assert.equal(err.code, 'ENOENT');
    return true;
  });
  await assert.rejects(github.latestEventId(), /gh is not installed/);
});

test('other gh failures pass through as they were', async () => {
  const notFound = Object.assign(new Error('Command failed'), { code: 1, stderr: 'gh: Not Found (HTTP 404)' });
  assert.equal(explainGhError(notFound), notFound);
  const github = createGitHub({ repo: 'o/r', run: async () => { throw notFound; } });
  assert.equal(await github.canWrite('sid'), false, 'a 404 still reads as not a collaborator');
});

test('a client given a getter follows the repo it names, the default branch read once for each', async () => {
  let repo = 'acme/api';
  const asked = [];
  const run = async (cmd, args) => {
    asked.push(args[1]);
    return { stdout: JSON.stringify({ default_branch: args[1] === 'repos/acme/web' ? 'trunk' : 'main' }) };
  };
  const github = createGitHub({ repo: () => repo, run });
  assert.equal(github.repo, 'acme/api');
  assert.equal(await github.defaultBranch(), 'main');
  assert.equal(await github.defaultBranch(), 'main');
  repo = 'acme/web';
  assert.equal(github.repo, 'acme/web');
  assert.equal(await github.defaultBranch(), 'trunk', 'not the first repo\'s, kept from before');
  await github.issue(7);
  assert.deepEqual(asked, ['repos/acme/api', 'repos/acme/web', 'repos/acme/web/issues/7']);
});
