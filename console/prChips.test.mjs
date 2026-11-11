import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPrChips, describePr, prNumberOf, reduceChecks } from './prChips.mjs';

const pr = (number, fields = {}) => ({
  number, title: `PR ${number}`, state: 'OPEN', isDraft: false, reviewDecision: null,
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: fields.checks ?? [] } } } }] }, ...fields,
});

test('checks count as the shed counts them', () => {
  assert.deepEqual(reduceChecks([
    { status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'COMPLETED', conclusion: 'SKIPPED' }, { status: 'COMPLETED', conclusion: 'FAILURE' },
    { status: 'IN_PROGRESS', conclusion: null }, { state: 'PENDING' }, { state: 'ERROR' }, { status: 'COMPLETED', conclusion: 'STARTUP_FAILURE' },
  ]), { pass: 2, fail: 3, pending: 2, total: 7 });
  assert.deepEqual(reduceChecks(undefined), { pass: 0, fail: 0, pending: 0, total: 0 });
});

test('a pull request\'s state, review and checks; a settled one carries neither', () => {
  assert.deepEqual(describePr(pr(1, { reviewDecision: 'APPROVED', checks: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] })),
    { number: 1, title: 'PR 1', state: 'open', review: 'approved', checks: { pass: 1, fail: 0, pending: 0, total: 1 }, queuePosition: null });
  assert.equal(describePr(pr(2, { isDraft: true })).state, 'draft');
  assert.equal(describePr(pr(3, { reviewDecision: 'CHANGES_REQUESTED' })).review, 'changes');
  assert.deepEqual(describePr(pr(4, { state: 'MERGED', reviewDecision: 'APPROVED', checks: [{ state: 'SUCCESS' }] })),
    { number: 4, title: 'PR 4', state: 'merged', review: null, checks: null, queuePosition: null });
  assert.equal(describePr(pr(5)).checks, null, 'no checks yet');
});

test('a pull request in the merge queue is queued, with its place, until it merges', () => {
  const queued = describePr(pr(6, { reviewDecision: 'APPROVED', mergeQueueEntry: { position: 2 }, checks: [{ status: 'IN_PROGRESS' }] }));
  assert.equal(queued.state, 'queued');
  assert.equal(queued.queuePosition, 2);
  assert.equal(queued.review, 'approved', 'not settled: its checks and review still count');
  assert.equal(describePr(pr(7, { mergeQueueEntry: {} })).queuePosition, null);
  assert.equal(describePr(pr(8, { state: 'MERGED', mergeQueueEntry: { position: 1 } })).state, 'merged');
  assert.equal(describePr(pr(9, { mergeQueueEntry: null })).state, 'open');
});

test('each session\'s pull request is read in one call, again after a minute, and a settled one after 15', async () => {
  let clock = 0;
  const asked = [];
  const answers = { 10: pr(10), 11: pr(11, { state: 'MERGED' }) };
  const github = { pullStatuses: async (numbers) => { asked.push(numbers); return numbers.map((n) => answers[n]).filter(Boolean); } };
  const chips = createPrChips({ github, repo: 'o/r', now: () => clock });
  const sessions = [{ prUrl: 'https://github.com/o/r/pull/10' }, { prUrl: 'https://github.com/o/r/pull/11' }, { prUrl: 'https://github.com/o/r/pull/10' },
    { prUrl: 'https://github.com/evil/r/pull/12' }, { prUrl: null }];
  await chips.refresh(sessions);
  assert.deepEqual(asked, [[10, 11]], 'one call, each number once, another repo\'s left out');
  assert.equal(chips.view('https://github.com/o/r/pull/11').state, 'merged');
  clock += 61_000;
  await chips.refresh(sessions);
  assert.deepEqual(asked.at(-1), [10], 'the merged one waits');
  clock += 15 * 60_000;
  await chips.refresh(sessions);
  assert.deepEqual(asked.at(-1), [10, 11]);
  assert.equal(prNumberOf('https://github.com/o/r/pull/10/files', 'o/r'), null);
});

test('a number GitHub has no pull request for is asked again only as often as a settled one', async () => {
  let clock = 0;
  const asked = [];
  const github = { pullStatuses: async (numbers) => { asked.push(numbers); return numbers.filter((n) => n === 10).map((n) => pr(n)); } };
  const chips = createPrChips({ github, repo: 'o/r', now: () => clock });
  const sessions = [{ prUrl: 'https://github.com/o/r/pull/10' }, { prUrl: 'https://github.com/o/r/pull/99' }];
  await chips.refresh(sessions);
  assert.deepEqual(asked, [[10, 99]]);
  clock += 61_000;
  await chips.refresh(sessions);
  assert.deepEqual(asked.at(-1), [10], 'the missing one waits');
  clock += 15 * 60_000;
  await chips.refresh(sessions);
  assert.deepEqual(asked.at(-1), [10, 99]);
});

test('while webhooks arrive, an open pull request is read when a webhook marks it, or every fallback period', async () => {
  let clock = 0;
  const asked = [];
  const github = { pullStatuses: async (numbers) => { asked.push(numbers); return numbers.map((n) => pr(n)); } };
  const chips = createPrChips({ github, repo: 'o/r', now: () => clock, webhooksFlowing: () => true, fallbackMs: 5 * 60_000 });
  const sessions = [{ prUrl: 'https://github.com/o/r/pull/10' }, { prUrl: 'https://github.com/o/r/pull/11' }];
  await chips.refresh(sessions);
  clock += 61_000;
  await chips.refresh(sessions);
  assert.equal(asked.length, 1, 'a minute is not due while webhooks arrive');
  assert.deepEqual(chips.stale([11, 12]), [11], 'only a pull request it has read is marked');
  await chips.refresh(sessions);
  assert.deepEqual(asked.at(-1), [11]);
  await chips.refresh(sessions);
  assert.equal(asked.length, 2, 'read once for the mark');
  clock = 5 * 60_000;
  await chips.refresh(sessions);
  assert.deepEqual(asked.at(-1), [10], 'the other at the fallback period after it was read');
});

test('each project\'s chips read its own repo, and a webhook marks only that project\'s', async () => {
  const { createProjectPrChips } = await import('./prChips.mjs');
  const asked = { app: [], tools: [] };
  const client = (name) => ({
    async pullStatuses(numbers) {
      asked[name].push(numbers);
      return numbers.map((number) => ({ number, title: `${name} ${number}`, state: 'OPEN', isDraft: false }));
    },
  });
  const projects = [{ name: 'app', repo: 'acme/app', default: true }, { name: 'tools', repo: 'acme/tools', default: false }];
  const chips = createProjectPrChips({ projects, githubFor: (p) => client(p.name) });
  const sessions = [{ prUrl: 'https://github.com/acme/app/pull/7' }, { prUrl: 'https://github.com/acme/tools/pull/7' }];
  await chips.refresh(sessions);
  assert.deepEqual(asked, { app: [[7]], tools: [[7]] });
  assert.equal(chips.view('https://github.com/acme/app/pull/7').title, 'app 7');
  assert.equal(chips.view('https://github.com/acme/tools/pull/7').title, 'tools 7', 'two different #7s');
  assert.deepEqual(chips.stale([7], 'tools'), [7]);
  await chips.refresh(sessions);
  assert.deepEqual(asked, { app: [[7]], tools: [[7], [7]] }, 'only the tools #7 was due again');
  assert.deepEqual(chips.stale([7]), [7], 'no project named: the default project\'s');
});

test('one project\'s GitHub failing leaves the other projects\' chips read', async () => {
  const { createProjectPrChips } = await import('./prChips.mjs');
  const projects = [{ name: 'app', repo: 'acme/app', default: true }, { name: 'tools', repo: 'acme/tools', default: false }];
  const githubFor = (p) => ({
    async pullStatuses(numbers) {
      if (p.name === 'app') throw new Error('HTTP 502');
      return numbers.map((number) => ({ number, title: `tools ${number}`, state: 'OPEN', isDraft: false }));
    },
  });
  const chips = createProjectPrChips({ projects, githubFor });
  await chips.refresh([{ prUrl: 'https://github.com/acme/app/pull/1' }, { prUrl: 'https://github.com/acme/tools/pull/2' }]);
  assert.equal(chips.view('https://github.com/acme/app/pull/1'), null);
  assert.equal(chips.view('https://github.com/acme/tools/pull/2').title, 'tools 2');
});

test('a project added or removed while the console runs gets or loses its chips with no restart', async () => {
  const { createProjectPrChips } = await import('./prChips.mjs');
  const read = [];
  const githubFor = (p) => ({ async pullStatuses(numbers) { read.push(p.name); return numbers.map((number) => ({ number, title: `${p.name} ${number}`, state: 'OPEN', isDraft: false })); } });
  const list = [{ name: 'app', repo: 'acme/app', default: true }];
  const chips = createProjectPrChips({ projects: () => list, githubFor });
  const sessions = [{ prUrl: 'https://github.com/acme/app/pull/1' }, { prUrl: 'https://github.com/acme/api/pull/2' }];
  await chips.refresh(sessions);
  assert.equal(chips.view(sessions[1].prUrl), null, 'not a project yet');
  list.push({ name: 'api', repo: 'acme/api', default: false });
  await chips.refresh(sessions);
  assert.equal(chips.view(sessions[1].prUrl).title, 'api 2');
  assert.deepEqual(chips.stale([2], 'api'), [2]);
  list.pop();
  assert.equal(chips.view(sessions[1].prUrl), null, 'removed again');
  assert.deepEqual(chips.stale([2], 'api'), []);
});
