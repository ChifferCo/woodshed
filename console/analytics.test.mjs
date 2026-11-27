import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { analyticsReport, createAnalytics, keepUsage, usageRecord } from './analytics.mjs';
import { createGitHub, recentPullRow } from './github.mjs';
import { createHandler } from './server.mjs';
import { createProjectAccess } from './projectAccess.mjs';
import { IDENTITY_HEADER, createTrustedIdentity, signIdentity } from './trustedIdentity.mjs';

const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const DAY = 86_400_000;
const ago = (days) => new Date(NOW - days * DAY).toISOString();
const REPO = 'o/r';
const url = (n) => `https://github.com/${REPO}/pull/${n}`;

const record = (fields) => ({
  id: 'aaaa0000', project: 'app', repo: REPO, kind: 'work', login: 'ana', private: false, agent: 'claude', createdAt: ago(1),
  title: 'A change', branch: null, prUrls: [], number: null, tier: null, status: 'stopped', ...fields,
});
const pull = (fields) => ({
  number: 1, url: url(1), title: 'A pull request', author: 'ana', bot: false, createdAt: ago(3), mergedAt: null, closedAt: null,
  state: 'open', additions: 10, deletions: 2, branch: 'feature', tier: null, ...fields,
});

test('a pull request a session reported, or whose branch it worked on, is through Woodshed and its person\'s, whoever GitHub says opened it', () => {
  const records = [
    record({ id: 'aaaa0001', login: 'ana', prUrls: [url(1)] }),
    record({ id: 'aaaa0002', login: 'bo', branch: 'woodshed/bo-aaaa0002', private: true, title: null, createdAt: ago(5) }),
  ];
  const pulls = [
    // A shared session's pull request opens as the App: still Ana's.
    pull({ number: 1, url: url(1), author: 'woodshed-app', bot: true, state: 'merged', mergedAt: ago(2) }),
    pull({ number: 2, url: url(2), author: 'bo', branch: 'woodshed/bo-aaaa0002', state: 'merged', mergedAt: ago(2.5) }),
    pull({ number: 3, url: url(3), author: 'cy', branch: 'cy/by-hand', state: 'merged', mergedAt: ago(1) }),
    pull({ number: 4, url: url(4), author: 'renovate', bot: true, branch: 'renovate/deps' }),
  ];
  const r = analyticsReport({ records, pulls: [{ project: 'app', repo: REPO, pulls }], days: 30, now: NOW });
  assert.deepEqual(r.pulls.recent.map((p) => [p.number, p.via, p.login]).sort(), [[1, 'woodshed', 'ana'], [2, 'woodshed', 'bo'], [3, 'other', 'cy']],
    'the bot\'s own pull request is nobody\'s work');
  assert.deepEqual([r.pulls.woodshed.opened, r.pulls.woodshed.merged, r.pulls.other.opened], [2, 2, 1]);
  assert.equal(r.pulls.mergedShare, 2 / 3);
  // Opened 3 days ago, merged after 1 and 0.5 days: the median of 24 h and 12 h.
  assert.equal(r.pulls.woodshed.medianMergeHours, 18);
  assert.equal(r.pulls.other.medianMergeHours, 48);
  const cy = r.people.find((p) => p.login === 'cy');
  assert.deepEqual([cy.sessions, cy.other.opened, cy.share], [0, 1, 0], 'someone who works without Woodshed is on the page too');
});

test('a fork\'s pull request on a branch name a session used is not that session\'s', () => {
  const records = [record({ id: 'aaaa0001', login: 'ana', branch: 'main-fix', createdAt: ago(5) })];
  const pulls = [
    pull({ number: 1, url: url(1), author: 'stranger', branch: 'main-fix', headRepo: 'stranger/r' }),
    pull({ number: 2, url: url(2), author: 'ana', branch: 'main-fix', headRepo: REPO }),
  ];
  const r = analyticsReport({ records, pulls: [{ project: 'app', repo: REPO, pulls }], days: 30, now: NOW });
  assert.deepEqual(r.pulls.recent.map((p) => [p.number, p.via, p.login]).sort(), [[1, 'other', 'stranger'], [2, 'woodshed', 'ana']]);
});

test('a session that ended on main, or a pull request older than the session, is not matched by the branch\'s name', () => {
  const records = [
    record({ id: 'aaaa0001', login: 'ana', branch: 'main', createdAt: ago(5) }),
    record({ id: 'aaaa0002', login: 'bo', branch: 'patch-1', createdAt: ago(2) }),
  ];
  const pulls = [
    pull({ number: 1, url: url(1), author: 'cy', branch: 'main', headRepo: REPO, createdAt: ago(1) }),
    pull({ number: 2, url: url(2), author: 'dee', branch: 'patch-1', headRepo: REPO, createdAt: ago(4) }),
    pull({ number: 3, url: url(3), author: 'bo', branch: 'patch-1', headRepo: REPO, createdAt: ago(1) }),
  ];
  const r = analyticsReport({ records, pulls: [{ project: 'app', repo: REPO, pulls }], days: 30, now: NOW });
  assert.deepEqual(r.pulls.recent.map((p) => [p.number, p.via, p.login]).sort(), [[1, 'other', 'cy'], [2, 'other', 'dee'], [3, 'woodshed', 'bo']]);
});

test('two sessions on one branch: a pull request is the newest one\'s that had started when it was opened', () => {
  const records = [
    record({ id: 'aaaa0001', login: 'ana', branch: 'woodshed/feature', createdAt: ago(6) }),
    record({ id: 'aaaa0002', login: 'bo', branch: 'woodshed/feature', createdAt: ago(2) }),
  ];
  const pulls = [
    pull({ number: 1, url: url(1), author: 'x', branch: 'woodshed/feature', headRepo: REPO, createdAt: ago(4) }),
    pull({ number: 2, url: url(2), author: 'x', branch: 'woodshed/feature', headRepo: REPO, createdAt: ago(1) }),
  ];
  const r = analyticsReport({ records, pulls: [{ project: 'app', repo: REPO, pulls }], days: 30, now: NOW });
  assert.deepEqual(r.pulls.recent.map((p) => [p.number, p.via, p.login]).sort(), [[1, 'woodshed', 'ana'], [2, 'woodshed', 'bo']]);
});

test('a tainted session is counted, but its branch, pull requests and title are not kept', () => {
  const r = usageRecord({ id: 'dddd0001', createdAt: ago(1), owner: 'ana', taintedAt: ago(1), branch: 'woodshed/x', prUrl: url(3), title: 'x', kind: 'task' }, { name: 'app', repo: REPO });
  assert.deepEqual([r.login, r.branch, r.prUrls, r.title], ['ana', null, [], null]);
  const old = { usageKept: [] };
  keepUsage(old, [record({ id: 'eeee0001', createdAt: ago(200) })], NOW);
  assert.deepEqual(old.usageKept, [], 'a record already past 180 days is not kept');
});

test('merge risk is the check\'s tier, else the newest review session\'s on that pull request', () => {
  const records = [
    record({ id: 'aaaa0001', prUrls: [url(1), url(2)] }),
    record({ id: 'aaaa0002', kind: 'review', number: 2, tier: 'Low', createdAt: ago(3) }),
    record({ id: 'aaaa0003', kind: 'review', number: 2, tier: 'High', createdAt: ago(2) }),
  ];
  const pulls = [pull({ number: 1, url: url(1), tier: 'Medium' }), pull({ number: 2, url: url(2) }), pull({ number: 3, url: url(3), author: 'cy' })];
  const r = analyticsReport({ records, pulls: [{ project: 'app', repo: REPO, pulls }], days: 30, now: NOW });
  assert.deepEqual(Object.fromEntries(r.pulls.recent.map((p) => [p.number, p.tier])), { 1: 'Medium', 2: 'High', 3: null });
  assert.deepEqual(r.pulls.woodshed.tiers, { Low: 0, Medium: 1, High: 1 });
  assert.equal(r.sessions.review, 2, 'reviews are counted apart from work sessions');
  assert.equal(r.sessions.work, 1);
});

test('only what started in the window counts; members who started nothing are listed; a private session\'s title is never given', () => {
  const records = [
    record({ id: 'aaaa0001', login: 'ana', createdAt: ago(2), private: true, title: 'Secret plans', agent: 'codex' }),
    record({ id: 'aaaa0002', login: 'ana', createdAt: ago(40) }),
    record({ id: 'aaaa0003', login: 'bo', createdAt: ago(1), title: 'Shared work' }),
  ];
  const r = analyticsReport({ records, pulls: [], members: ['ana', 'bo', 'dee'], days: 30, now: NOW });
  assert.equal(r.sessions.work, 2);
  assert.deepEqual([r.sessions.private, r.sessions.shared], [1, 1]);
  assert.deepEqual(r.sessions.agents, { codex: 1, claude: 1 });
  assert.deepEqual([r.sessions.people, r.sessions.activeMembers, r.sessions.members], [2, 2, 3]);
  assert.deepEqual(r.people.map((p) => [p.login, p.sessions]), [['ana', 1], ['bo', 1], ['dee', 0]]);
  assert.deepEqual(r.sessions.recent.map((s) => s.title), ['Shared work', null]);
  assert.equal(r.trend.length, 4, 'about a week each for 30 days');
  assert.equal(r.trend.reduce((sum, b) => sum + b.sessions, 0), 2);
  assert.equal(analyticsReport({ records, pulls: [], days: 7, now: NOW }).trend.length, 7, 'a day each for a week');
});

test('a session off the list is kept with no prompt, and a private one with no title; old ones are dropped', () => {
  const state = { usageKept: [record({ id: 'old00000', createdAt: ago(200) })] };
  const shared = { id: 'bbbb0001', createdAt: ago(1), startedBy: 'ana', title: 'Shared', prompt: 'do the thing', kind: 'issue', branch: 'woodshed/1-bbbb0001', prUrl: url(5) };
  const mine = { id: 'bbbb0002', createdAt: ago(1), owner: 'bo', title: 'Private', prompt: 'secret', kind: 'task', options: { agent: 'codex' } };
  keepUsage(state, [usageRecord(shared, { name: 'app', repo: REPO }), usageRecord(mine, { name: 'app', repo: REPO })], NOW);
  keepUsage(state, [usageRecord(shared, { name: 'app', repo: REPO })], NOW);
  assert.deepEqual(state.usageKept.map((r) => [r.id, r.login, r.title, r.private, r.agent, r.project]), [
    ['bbbb0001', 'ana', 'Shared', false, 'claude', 'app'], ['bbbb0002', 'bo', null, true, 'codex', 'app'],
  ]);
  assert.ok(!JSON.stringify(state.usageKept).includes('secret') && !JSON.stringify(state.usageKept).includes('do the thing'));
  assert.deepEqual(state.usageKept[0].prUrls, [url(5)]);
});

test('GitHub\'s search: a row\'s state and its tier from the check\'s title, and every page read up to the last', async () => {
  const node = (n, fields = {}) => ({
    number: n, url: url(n), title: 'T', createdAt: ago(1), mergedAt: null, closedAt: null, state: 'OPEN', isDraft: false, additions: 3, deletions: 1,
    headRefName: 'b', author: { login: 'ana', __typename: 'User' }, ...fields,
  });
  const merged = node(1, { state: 'MERGED', mergedAt: ago(0.5), labels: { nodes: [{ name: 'merge risk: high' }] } });
  assert.deepEqual([recentPullRow(merged).state, recentPullRow(merged).tier], ['merged', 'High']);
  assert.equal(recentPullRow(node(2, { isDraft: true })).state, 'draft');
  assert.equal(recentPullRow(node(4, { labels: { nodes: [{ name: 'bug' }, { name: 'merge risk: medium' }] } })).tier, 'Medium', 'the review\'s label, with no check');
  assert.equal(recentPullRow(node(3, { author: { login: 'dependabot', __typename: 'Bot' } })).bot, true);

  const calls = [];
  const run = async (cmd, args) => {
    calls.push(args);
    const after = args.find((a) => a.startsWith('after='));
    const page = after ? [node(2)] : [node(1)];
    return { stdout: JSON.stringify({ data: { search: { issueCount: 2, pageInfo: { hasNextPage: !after, endCursor: 'c1' }, nodes: page } } }) };
  };
  const found = await createGitHub({ repo: REPO, run }).recentPulls({ since: '2026-10-27' });
  assert.deepEqual(found.pulls.map((p) => p.number), [1, 2]);
  assert.equal(found.truncated, false);
  assert.ok(calls[0].includes(`q=repo:${REPO} is:pr created:>=2026-10-27 sort:created-desc`));
  assert.ok(!calls[0].some((a) => /checkSuites|check=/.test(a)), 'no check suites in the search: GitHub answered 502 for them');

  const checkCalls = [];
  const checkRun = async (cmd, args) => {
    checkCalls.push(args);
    const numbers = [...args.find((a) => a.startsWith('query=')).matchAll(/pullRequest\(number: (\d+)\)/g)].map((m) => Number(m[1]));
    const repository = Object.fromEntries(numbers.map((n) => [`pr${n}`, { number: n, commits: { nodes: [{ commit: { checkSuites: { nodes: [{ checkRuns: { nodes: n % 2 ? [{ title: 'Medium: x' }] : [] } }] } } }] } }]));
    return { stdout: JSON.stringify({ data: { repository } }) };
  };
  const tiers = await createGitHub({ repo: REPO, run: checkRun }).checkTiers(Array.from({ length: 30 }, (_, i) => i + 1), 'Merge risk');
  assert.equal(checkCalls.length, 2, '25 to a call');
  assert.ok(checkCalls[0].includes('check=Merge risk'));
  assert.equal(tiers.size, 15);
  assert.equal(tiers.get(1), 'Medium');
  await assert.rejects(createGitHub({ repo: REPO, run }).recentPulls({ since: 'yesterday' }), /date/);
});

test('a pull request with no label is tiered by the merge risk check, asked apart, and a failed ask keeps the labels', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const config = { projects: [{ name: 'app', repo: REPO, default: true }] };
  let failChecks = false;
  const asked = [];
  const gh = {
    recentPulls: async () => ({ pulls: [pull({ number: 1, url: url(1), tier: 'Low' }), pull({ number: 2, url: url(2) }), pull({ number: 3, url: url(3) })], total: 3, truncated: false }),
    checkTiers: async (numbers, check) => { asked.push([numbers, check]); if (failChecks) throw new Error('gh: HTTP 502'); return new Map([[2, 'High']]); },
  };
  const make = () => createAnalytics({ config, sessions: () => [], state: () => ({}), githubFor: () => gh, gatesOf: async () => ({ mergeRisk: { check: 'Merge risk' } }), now: () => NOW });
  const r = await make().report({ days: 30 });
  assert.deepEqual(asked, [[[2, 3], 'Merge risk']], 'only those with no label');
  assert.deepEqual(Object.fromEntries(r.pulls.recent.map((p) => [p.number, p.tier])), { 1: 'Low', 2: 'High', 3: null });
  failChecks = true;
  const kept = await make().report({ days: 30 });
  assert.deepEqual([kept.failed, Object.fromEntries(kept.pulls.recent.map((p) => [p.number, p.tier]))], [[], { 1: 'Low', 2: null, 3: null }]);
  const noCheck = createAnalytics({ config, sessions: () => [], state: () => ({}), githubFor: () => gh, now: () => NOW });
  asked.length = 0;
  await noCheck.report({ days: 30 });
  assert.deepEqual(asked, [], 'a project file with no merge risk check asks nothing more');
});

test('both reads name the viewer\'s repo, though the default repo changes between them', async () => {
  let defaultRepo = 'o/old';
  const calls = [];
  // The default project's client: with no repo named, it reads whichever repo is the default now.
  const gh = {
    async recentPulls({ since, repo = defaultRepo }) { calls.push(['search', repo]); return { pulls: [pull({ number: 7, url: `https://github.com/${repo}/pull/7` })], total: 1, truncated: false }; },
    async checkTiers(numbers, check, { repo = defaultRepo } = {}) { calls.push(['checks', repo]); return new Map(repo === 'o/new' ? [[7, 'High']] : []); },
  };
  const config = { projects: [{ name: 'app', repo: 'o/old', default: true }] };
  // An admin makes another repo the default while the report waits on the project file.
  const gatesOf = async () => { defaultRepo = 'o/new'; return { mergeRisk: { check: 'Merge risk' } }; };
  const r = await createAnalytics({ config, sessions: () => [], state: () => ({}), githubFor: () => gh, gatesOf, now: () => NOW }).report({ days: 30 });
  assert.deepEqual(calls, [['search', 'o/old'], ['checks', 'o/old']]);
  assert.equal(r.pulls.recent[0].tier, null, 'no tier of the other repo\'s #7');

  // And the client itself: a named repo wins over its default.
  const args = [];
  const run = async (cmd, a) => { args.push(a.join(' ')); return { stdout: JSON.stringify({ data: { search: { issueCount: 0, pageInfo: { hasNextPage: false }, nodes: [] }, repository: {} } }) }; };
  const client = createGitHub({ repo: () => 'o/new', run });
  await client.recentPulls({ since: '2026-10-27', repo: 'o/old' });
  await client.checkTiers([1], 'Merge risk', { repo: 'o/old' });
  assert.ok(args[0].includes('q=repo:o/old ') && args[1].includes('owner=o') && args[1].includes('name=old'));
  await assert.rejects(client.recentPulls({ since: '2026-10-27', repo: 'o/x is:issue' }), /owner\/name/);
});

test('a merge risk batch GitHub fails is left out, and the other batches\' tiers stay', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let call = 0;
  const run = async (cmd, a) => {
    call++;
    if (call === 1) throw Object.assign(new Error('gh: HTTP 502'), { stderr: 'gh: HTTP 502' });
    const numbers = [...a.find((x) => x.startsWith('query=')).matchAll(/pullRequest\(number: (\d+)\)/g)].map((m) => Number(m[1]));
    const repository = Object.fromEntries(numbers.map((n) => [`pr${n}`, { number: n, commits: { nodes: [{ commit: { checkSuites: { nodes: [{ checkRuns: { nodes: [{ title: 'Low: x' }] } }] } } }] } }]));
    return { stdout: JSON.stringify({ data: { repository } }) };
  };
  const tiers = await createGitHub({ repo: REPO, run }).checkTiers(Array.from({ length: 30 }, (_, i) => i + 1), 'Merge risk');
  assert.equal(tiers.size, 5, 'the second batch of 5');
  const allFail = async () => { throw new Error('gh: HTTP 502'); };
  await assert.rejects(createGitHub({ repo: REPO, run: allFail }).checkTiers([1, 2], 'Merge risk'), /502/, 'every batch failing is a failure');
});

test('the report reads each repo once for an hour, and a repo GitHub did not answer is named, not a failure of the page', async () => {
  let reads = 0;
  let now = NOW;
  const ok = { recentPulls: async () => { reads++; return { pulls: [pull({ number: 9, url: url(9), createdAt: ago(1) })], total: 1, truncated: false }; } };
  const down = { recentPulls: async () => { throw new Error('HTTP 502'); } };
  const config = { projects: [{ name: 'app', repo: REPO, default: true }, { name: 'web', repo: 'o/web' }] };
  const analytics = createAnalytics({
    config, sessions: () => [{ id: 'cccc0001', createdAt: ago(1), owner: 'ana', title: 'x', kind: 'task' }], state: () => ({ usageKept: [] }),
    githubFor: (p) => (p.name === 'app' ? ok : down), now: () => now,
  });
  const first = await analytics.report({ days: 30 });
  assert.deepEqual(first.failed, [{ project: 'web', repo: 'o/web' }]);
  assert.equal(first.pulls.other.opened, 1);
  assert.equal(first.sessions.work, 1);
  assert.equal(first.sessions.recent[0].project, 'app', 'a session on the default project names it');
  await analytics.report({ days: 30 });
  assert.equal(reads, 1);
  // A viewer who can open only the other repo gets nothing of this one: its pull requests, sessions or links.
  const theirs = await analytics.report({ days: 30, repos: ['o/web'] });
  assert.deepEqual([theirs.projects, theirs.pulls.other.opened, theirs.sessions.work], [['web'], 0, 0]);
  assert.equal(reads, 1, 'and its repo is not even read');
  now += 30 * 60_000;
  await analytics.report({ days: 30 });
  assert.equal(reads, 1, 'still the same read half an hour on');
  now += 31 * 60_000;
  await analytics.report({ days: 30 });
  assert.equal(reads, 2, 'a view past an hour starts a new read');
});

const cachedAnalytics = (gh, clock) => createAnalytics({
  config: { projects: [{ name: 'app', repo: REPO, default: true }] }, sessions: () => [], state: () => ({ usageKept: [] }), githubFor: () => gh, now: () => clock.now,
});
const nextTick = () => new Promise((r) => setImmediate(r));

test('every window shares one read per repo', async () => {
  const clock = { now: NOW };
  let reads = 0;
  const analytics = cachedAnalytics({ recentPulls: async () => { reads++; return { pulls: [pull({ number: 9, url: url(9), createdAt: ago(1) })], total: 1, truncated: false }; } }, clock);
  for (const days of [7, 30, 90]) await analytics.report({ days });
  assert.equal(reads, 1, 'the three windows are one search');
});

test('the saved read is shown at once however old, with when it is as of, and a refresh runs in the background', async () => {
  const clock = { now: NOW };
  let number = 9;
  let release = null;
  const gh = { recentPulls: async () => {
    if (release) await new Promise((r) => { release = r; });
    return { pulls: [pull({ number, url: url(number), createdAt: ago(1) })], total: 1, truncated: false };
  } };
  const analytics = cachedAnalytics(gh, clock);
  const first = await analytics.report({ days: 7 });
  assert.equal(first.asOf, new Date(NOW).toISOString());
  assert.equal(first.refreshing, false);
  clock.now += 3 * 24 * 60 * 60_000;
  number = 10;
  release = () => {};
  const old = await analytics.report({ days: 90 });
  assert.equal(old.pulls.recent[0].number, 9, 'the three-day-old read, not waited for');
  assert.equal(old.asOf, new Date(NOW).toISOString(), 'and it says when it is from');
  assert.equal(old.refreshing, true);
  assert.equal((await analytics.report({ days: 90 })).refreshing, true, 'one refresh at a time');
  release();
  await nextTick();
  await nextTick();
  const fresh = await analytics.report({ days: 90 });
  assert.equal(fresh.pulls.recent[0].number, 10);
  assert.equal(fresh.asOf, new Date(clock.now).toISOString());
  assert.equal(fresh.refreshing, false);
});

test('the Refresh button reads again now, once, and only the repos the person may open', async () => {
  const clock = { now: NOW };
  let reads = 0;
  let release = null;
  const gh = { recentPulls: async () => { reads++; if (release) await new Promise((r) => { release = r; }); return { pulls: [], total: 0, truncated: false }; } };
  const analytics = cachedAnalytics(gh, clock);
  await analytics.report({ days: 7 });
  clock.now += 5 * 60_000;
  assert.equal(analytics.refresh({ repos: ['o/other'] }), 0, 'not a repo they cannot open');
  release = () => {};
  assert.equal(analytics.refresh({ repos: [REPO] }), 1);
  assert.equal(analytics.refresh({ repos: [REPO] }), 0, 'not while one runs');
  assert.equal((await analytics.report({ days: 7 })).refreshing, true);
  release();
  await nextTick();
  await nextTick();
  assert.equal(reads, 2);
  const after = await analytics.report({ days: 7 });
  assert.deepEqual([after.refreshing, after.asOf], [false, new Date(clock.now).toISOString()]);
});

test('a failed refresh keeps the old read, says so, and is not tried on its own again for a minute; the first read still fails the page', async () => {
  const clock = { now: NOW };
  let reads = 0;
  let fail = false;
  const gh = { recentPulls: async () => { reads++; if (fail) throw new Error('HTTP 502'); return { pulls: [pull({ number: 9, url: url(9), createdAt: ago(1) })], total: 1, truncated: false }; } };
  const analytics = cachedAnalytics(gh, clock);
  fail = true;
  assert.equal((await analytics.report({ days: 7 })).failed.length, 1, 'with no read the page names the repo');
  const failedReads = reads;
  assert.equal((await analytics.report({ days: 7 })).failed.length, 1);
  assert.equal(reads, failedReads, 'a first read that failed is not repeated within the minute');
  fail = false;
  analytics.refresh({ repos: [REPO] });
  assert.equal(reads, failedReads + 1, 'but the button reads it at once');
  assert.equal((await analytics.report({ days: 7 })).failed.length, 0, 'and the page waits for that read, not the old failure');
  clock.now += 61_000;
  fail = false;
  await analytics.report({ days: 7 });
  clock.now += 2 * 60 * 60_000;
  fail = true;
  await analytics.report({ days: 7 });
  await nextTick();
  await nextTick();
  const before = reads;
  const kept = await analytics.report({ days: 30 });
  assert.equal(kept.pulls.recent[0].number, 9);
  assert.deepEqual([kept.failed, kept.refreshFailed], [[], true]);
  assert.equal(reads, before, 'paced for a minute');
  clock.now += 61_000;
  await analytics.report({ days: 30 });
  assert.equal(reads, before + 1);
});

test('a capped read flags only the windows it does not reach back past', async () => {
  const clock = { now: NOW };
  const analytics = cachedAnalytics({ recentPulls: async () => ({ pulls: [pull({ number: 9, url: url(9), createdAt: ago(14) })], total: 900, truncated: true }) }, clock);
  assert.equal((await analytics.report({ days: 7 })).truncated, false);
  assert.equal((await analytics.report({ days: 30 })).truncated, true);
});

test('/api/analytics is an admin\'s, and answers the window asked for with each person\'s name', async (t) => {
  const { createMembers } = await import('./members.mjs');
  const store = { state: { members: {
    mia: { addedBy: null, addedAt: '2026-10-01T00:00:00.000Z', how: 'first to sign in', admin: true },
    sam: { addedBy: 'mia', addedAt: '2026-10-01T00:00:00.000Z', how: 'invited' },
  } }, save() {} };
  const members = createMembers({ store });
  const config = { host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], repo: REPO, label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const loginOf = (cookie) => /woodshed_session=(\w+)/.exec(String(cookie))?.[1] ?? null;
  const auth = { enabled: () => true, available: () => true, sessionFor: async (c) => (members.isMember(loginOf(c)) ? { login: loginOf(c) } : null), visitorFor: async () => null };
  const asked = [];
  const analytics = { report: async ({ days, repos }) => { asked.push([days, repos]); return analyticsReport({ records: [record({ login: 'sam' })], pulls: [], days, now: Date.now() }); } };
  const projectAccess = { startable: async (login) => (login === 'mia' ? [{ name: 'app', repo: REPO }] : []) };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth, members, analytics, projectAccess, people: { names: (logins) => Object.fromEntries([...logins].map((l) => [l, l.toUpperCase()])) } });
  const server = http.createServer((req, res) => { handle(req, res); });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => server.close());
  const get = (path, login) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers: { cookie: `woodshed_session=${login}` } });
  assert.equal((await get('/api/analytics', 'sam')).status, 403, 'a member who is not an admin reads nothing');
  const res = await get('/api/analytics?days=90', 'mia');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual([body.days, body.windows, body.names.sam], [90, [7, 30, 90], 'SAM']);
  await get('/api/analytics?days=12345', 'mia');
  assert.deepEqual(asked, [[90, [REPO]], [30, [REPO]]], 'a window not offered is 30 days, and only the repos the viewer may open');
  assert.equal((await get('/analytics', 'sam')).status, 200, 'the page itself loads, and its call says no');
});

test('behind a hosting proxy an owner sees only the repos GitHub says they write to, the default one included', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const SECRET = 'the-hosts-identity-secret-0123456789abcdef';
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
    projects: [{ name: 'app', repo: 'o/app', default: true }, { name: 'secret', repo: 'o/secret' }, { name: 'down', repo: 'o/down' }],
  };
  // ana writes to o/app only; GitHub fails for o/down; nobody's write to o/secret.
  const writes = { 'o/app': ['ana-owner', 'bo-owner'], 'o/secret': ['bo-owner'] };
  const asked = [];
  const githubFor = (project) => ({
    async canWrite(login) {
      asked.push(`${login} ${project.repo}`);
      if (project.repo === 'o/down') throw new Error('HTTP 502');
      return (writes[project.repo] ?? []).includes(login);
    },
    async recentPulls() { return { pulls: [pull({ number: 1, url: `https://github.com/${project.repo}/pull/1`, author: 'cy', title: `in ${project.repo}` })], total: 1, truncated: false }; },
  });
  const sessions = config.projects.map((p, i) => ({ id: `ffff000${i}`, project: p.name, repo: p.repo, createdAt: new Date(Date.now() - DAY).toISOString(), startedBy: 'cy', title: `on ${p.repo}`, kind: 'issue', prUrl: `https://github.com/${p.repo}/pull/1` }));
  const analytics = createAnalytics({ config, sessions: () => sessions, state: () => ({}), githubFor });
  // The real check, hosted as installation.mjs makes it: nobody signs in with GitHub here.
  const projectAccess = createProjectAccess({ config, githubFor, signIn: () => false, hosted: () => true });
  const handle = createHandler({ config, fleet: { sessions: () => sessions, find: () => null }, trusted: createTrustedIdentity({ secret: SECRET }), analytics, projectAccess });
  const server = http.createServer((req, res) => { handle(req, res); });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => server.close());
  const as = async (login) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/analytics`, {
      headers: { [IDENTITY_HEADER]: signIdentity({ secret: SECRET, login, role: 'owner', exp: Date.now() + 60_000 }) },
    });
    return { status: res.status, body: await res.json() };
  };
  const ana = await as('ana-owner');
  assert.equal(ana.status, 200);
  assert.deepEqual(ana.body.projects, ['app']);
  const anaText = JSON.stringify(ana.body);
  assert.ok(!anaText.includes('o/secret') && !anaText.includes('o/down'), 'nothing of a repo they cannot write to, or one GitHub did not answer for');
  assert.deepEqual([ana.body.pulls.woodshed.opened, ana.body.sessions.work], [1, 1]);
  const bo = await as('bo-owner');
  assert.deepEqual(bo.body.projects, ['app', 'secret'], 'someone who writes to both sees both');
  assert.ok(asked.includes('ana-owner o/app'), 'the default repo is asked too: no sign-in proved it');
  const nobody = await as('dee-owner');
  assert.deepEqual([nobody.body.projects, nobody.body.sessions.work, nobody.body.pulls.recent.length], [[], 0, 0]);
});

test('with GitHub sign-in, an admin who loses write access to the default repo stops seeing it within a minute, on the same cookie', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { createMembers } = await import('./members.mjs');
  const store = { state: { members: { mia: { addedBy: null, addedAt: '2026-10-01T00:00:00.000Z', how: 'first to sign in', admin: true } } }, save() {} };
  const members = createMembers({ store });
  const config = {
    host: '127.0.0.1', publicUrl: 'https://console.example', extraHosts: [], label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 },
    projects: [{ name: 'app', repo: 'o/app', default: true }, { name: 'web', repo: 'o/web' }],
  };
  // The cookie stays good throughout: sign-in's own recheck is hourly.
  const auth = { enabled: () => true, available: () => true, sessionFor: async () => ({ login: 'mia' }), visitorFor: async () => null };
  const writes = new Set(['o/app', 'o/web']);
  let clock = NOW;
  const githubFor = (project) => ({
    async canWrite() { return writes.has(project.repo); },
    async recentPulls() { return { pulls: [pull({ number: 1, url: `https://github.com/${project.repo}/pull/1`, author: 'cy' })], total: 1, truncated: false }; },
  });
  const analytics = createAnalytics({ config, sessions: () => [], state: () => ({}), githubFor, now: () => clock });
  const projectAccess = createProjectAccess({ config, githubFor, signIn: () => true, now: () => clock });
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth, members, analytics, projectAccess });
  const server = http.createServer((req, res) => { handle(req, res); });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => server.close());
  const projects = async () => (await (await fetch(`http://127.0.0.1:${server.address().port}/api/analytics`, { headers: { cookie: 'woodshed_session=mia' } })).json()).projects;
  assert.deepEqual(await projects(), ['app', 'web']);
  writes.delete('o/app');
  clock += 61_000;
  const after = await projects();
  assert.deepEqual(after, ['web'], 'the default repo is asked too, not taken as proved by the sign-in');
});

test('a pull request carries who reviewed it: people, and the models (Woodshed reviews first, else review bots)', () => {
  const records = [
    record({ id: 'bbbb0001', kind: 'review', repo: REPO, number: 1, tier: 'Low', reviewAgents: ['claude', 'codex'], createdAt: ago(2) }),
  ];
  const pulls = [{ project: 'app', repo: REPO, pulls: [
    pull({ number: 1, url: url(1), humanReviewers: ['bo'], botReviewers: ['claude'] }),
    pull({ number: 2, url: url(2), humanReviewers: [], botReviewers: ['copilot', 'claude'] }),
  ] }];
  const { pulls: { recent } } = analyticsReport({ records, pulls, days: 30, now: NOW });
  const one = recent.find((p) => p.number === 1);
  const two = recent.find((p) => p.number === 2);
  assert.deepEqual(one.humanReviewers, ['bo']);
  assert.deepEqual(one.models.sort(), ['claude', 'codex']);
  assert.deepEqual(two.humanReviewers, []);
  assert.deepEqual(two.models, ['copilot', 'claude']);
  assert.equal(one.repo, REPO);
});

test('the lists are not cut at 500', () => {
  const many = Array.from({ length: 600 }, (_, i) => pull({ number: i + 1, url: url(i + 1), createdAt: ago(1) }));
  const records = Array.from({ length: 600 }, (_, i) => record({ id: `cccc${String(i).padStart(4, '0')}` }));
  const r = analyticsReport({ records, pulls: [{ project: 'app', repo: REPO, pulls: many }], days: 30, now: NOW });
  assert.equal(r.pulls.recent.length, 600);
  assert.equal(r.sessions.recent.length, 600);
});

test('recentPullRow reads human and bot reviewers, not the author, pending or dismissed ones', () => {
  const row = recentPullRow({ number: 1, url: url(1), author: { login: 'ana', __typename: 'User' }, reviews: { nodes: [
    { state: 'APPROVED', author: { login: 'bo', __typename: 'User' } }, { state: 'COMMENTED', author: { login: 'ana', __typename: 'User' } },
    { state: 'COMMENTED', author: { login: 'claude[bot]', __typename: 'Bot' } }, { state: 'DISMISSED', author: { login: 'cy', __typename: 'User' } },
    { state: 'PENDING', author: { login: 'di', __typename: 'User' } },
  ] } });
  assert.deepEqual(row.humanReviewers, ['bo']);
  assert.deepEqual(row.botReviewers, ['claude']);
});

test('GitHub\'s search stops at 1,000 results, so a window with more is read in date ranges and every pull request comes', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const day = (i) => new Date(Date.parse(`${today}T12:00:00Z`) - (i % 30) * DAY).toISOString();
  const all = Array.from({ length: 1200 }, (_, i) => ({
    number: i + 1, url: url(i + 1), title: 'T', createdAt: day(i), mergedAt: null, closedAt: null, state: 'OPEN', isDraft: false, additions: 1, deletions: 0,
    headRefName: 'b', author: { login: 'ana', __typename: 'User' },
  }));
  const queries = [];
  const run = async (cmd, args) => {
    const q = args.find((a) => a.startsWith('q=')).slice(2);
    queries.push(q);
    const created = /created:(\S+)/.exec(q)[1];
    const [from, to] = created.startsWith('>=') ? [created.slice(2), '9999-12-31'] : created.split('..');
    const hits = all.filter((n) => n.createdAt.slice(0, 10) >= from && n.createdAt.slice(0, 10) <= to).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const start = Number(args.find((a) => a.startsWith('after='))?.slice(6) ?? 0);
    // GitHub answers the first 1,000 only, 100 a page.
    const page = hits.slice(0, 1000).slice(start, start + 100);
    const more = start + 100 < Math.min(1000, hits.length);
    return { stdout: JSON.stringify({ data: { search: { issueCount: hits.length, pageInfo: { hasNextPage: more, endCursor: String(start + 100) }, nodes: page } } }) };
  };
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - 40 * DAY).toISOString().slice(0, 10);
  const found = await createGitHub({ repo: REPO, run }).recentPulls({ since });
  assert.equal(found.pulls.length, 1200);
  assert.equal(new Set(found.pulls.map((p) => p.number)).size, 1200, 'none twice');
  assert.equal(found.truncated, false);
  assert.ok(queries.some((q) => /created:\d{4}-\d\d-\d\d\.\.\d{4}-\d\d-\d\d/.test(q)), 'cut into date ranges');
});

test('a pull request with more reviews than were read is not said to have had no human review', () => {
  const row = recentPullRow({ number: 1, url: url(1), author: { login: 'ana', __typename: 'User' }, reviews: { totalCount: 150, nodes: [{ state: 'COMMENTED', author: { login: 'claude[bot]', __typename: 'Bot' } }] } });
  assert.equal(row.reviewsPartial, true);
  const { pulls: { recent } } = analyticsReport({ records: [], pulls: [{ project: 'app', repo: REPO, pulls: [pull({ ...row, createdAt: ago(1) })] }], days: 30, now: NOW });
  assert.equal(recent[0].humanUnknown, true);
});

test('the daily chart has one bucket for each local date and counts each series by the date it was opened, across a daylight-saving change', async () => {
  const { dayCounts } = (await import('./public/analyticsDays.js')).default;
  const was = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    // 00:30 on Oct 31, 2026, local: the clocks go back on Nov 1.
    const since = new Date(2026, 9, 31, 0, 30).toISOString();
    const until = new Date(2026, 10, 3, 12, 0).toISOString();
    const at = (m, d, h) => new Date(2026, m, d, h).toISOString();
    const items = [
      { at: at(9, 31, 9), k: 'a' }, { at: at(10, 1, 0), k: 'a' }, { at: at(10, 1, 23), k: 'b' }, { at: at(10, 1, 12), k: 'b' }, { at: at(10, 3, 8), k: 'a' }, { at: at(8, 1, 8), k: 'a' },
    ];
    const buckets = dayCounts(items, (i) => i.at, (i) => i.k, since, until);
    assert.deepEqual(buckets.map((b) => [new Date(b.start).getDate(), b.a, b.b]), [[31, 1, 0], [1, 1, 2], [2, 0, 0], [3, 1, 0]]);
    assert.equal(new Set(buckets.map((b) => b.key)).size, buckets.length, 'no date twice');
    assert.equal(buckets.reduce((t, b) => t + b.a + b.b, 0), 5, 'the one before the window is not counted');
  } finally {
    if (was === undefined) delete process.env.TZ; else process.env.TZ = was;
  }
});

test('a review that has not reported adds no models', () => {
  const records = [record({ id: 'dddd0001', kind: 'review', repo: REPO, number: 1, reviewAgents: ['claude', 'codex'], reviewDone: false, createdAt: ago(2) })];
  const { pulls: { recent } } = analyticsReport({ records, pulls: [{ project: 'app', repo: REPO, pulls: [pull({ number: 1, url: url(1), botReviewers: [] })] }], days: 30, now: NOW });
  assert.deepEqual(recent[0].models, []);
});

test('a review\'s models are the agents its report named, not those scheduled', () => {
  const s = { id: 'eeee0001', repo: REPO, kind: 'review', createdAt: ago(1), review: { agents: ['claude', 'codex'], reportedAgents: ['claude'], reported: true }, number: 1, status: 'stopped' };
  assert.deepEqual(usageRecord(s).reviewAgents, ['claude']);
  assert.deepEqual(usageRecord({ ...s, review: { agents: ['claude', 'codex'], reported: true } }).reviewAgents, ['claude', 'codex']);
});

test('a review that reported no verdict is not done, one with a verdict or from before verdicts were kept is', () => {
  const s = { id: 'ffff0001', repo: REPO, kind: 'review', createdAt: ago(1), review: { agents: ['claude'], reported: true, conclusion: null }, number: 1, status: 'stopped' };
  assert.equal(usageRecord(s).reviewDone, false);
  assert.equal(usageRecord({ ...s, review: { ...s.review, conclusion: 'APPROVE' } }).reviewDone, true);
  assert.equal(usageRecord({ ...s, review: { agents: ['claude'], reported: true } }).reviewDone, true);
});

test('a Woodshed session\'s person who reviewed their own App-opened pull request is not a human reviewer', () => {
  const records = [record({ id: 'abab0001', login: 'ana', prUrls: [url(1)] })];
  const pulls = [{ project: 'app', repo: REPO, pulls: [pull({ number: 1, url: url(1), author: 'woodshed-app', humanReviewers: ['ana', 'bo'] })] }];
  const { pulls: { recent } } = analyticsReport({ records, pulls, days: 30, now: NOW });
  assert.deepEqual(recent[0].humanReviewers, ['bo']);
});
