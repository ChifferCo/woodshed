import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { analyticsReport, createAnalytics, keepUsage, usageRecord } from './analytics.mjs';
import { createGitHub, recentPullRow } from './github.mjs';
import { createHandler } from './server.mjs';

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
    record({ id: 'aaaa0002', login: 'bo', branch: 'woodshed/bo-aaaa0002', private: true, title: null }),
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
  const records = [record({ id: 'aaaa0001', login: 'ana', branch: 'main-fix' })];
  const pulls = [
    pull({ number: 1, url: url(1), author: 'stranger', branch: 'main-fix', headRepo: 'stranger/r' }),
    pull({ number: 2, url: url(2), author: 'ana', branch: 'main-fix', headRepo: REPO }),
  ];
  const r = analyticsReport({ records, pulls: [{ project: 'app', repo: REPO, pulls }], days: 30, now: NOW });
  assert.deepEqual(r.pulls.recent.map((p) => [p.number, p.via, p.login]).sort(), [[1, 'other', 'stranger'], [2, 'woodshed', 'ana']]);
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
  const withCheck = node(1, { state: 'MERGED', mergedAt: ago(0.5), commits: { nodes: [{ commit: { checkSuites: { nodes: [{ checkRuns: { nodes: [{ title: 'High: touches billing' }] } }] } } }] } });
  assert.deepEqual([recentPullRow(withCheck).state, recentPullRow(withCheck).tier], ['merged', 'High']);
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
  const found = await createGitHub({ repo: REPO, run }).recentPulls({ since: '2026-10-27', check: 'Merge risk' });
  assert.deepEqual(found.pulls.map((p) => p.number), [1, 2]);
  assert.equal(found.truncated, false);
  assert.ok(calls[0].includes(`q=repo:${REPO} is:pr created:>=2026-10-27 sort:created-desc`));
  assert.ok(calls[0].includes('check=Merge risk'));
  await assert.rejects(createGitHub({ repo: REPO, run }).recentPulls({ since: 'yesterday' }), /date/);
});

test('the report reads each repo once for five minutes, and a repo GitHub did not answer is named, not a failure of the page', async () => {
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
  now += 6 * 60_000;
  await analytics.report({ days: 30 });
  assert.equal(reads, 2);
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
