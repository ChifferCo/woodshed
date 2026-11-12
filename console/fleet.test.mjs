import { test } from 'node:test';
import assert from 'node:assert/strict';

import { commentConsoleUrl, createFleet, failedComment, failureReason, refusalComment, resumeComment, SETUP_APP_PROMPT, startComment } from './fleet.mjs';

const APPROVAL_GRACE_MS = 5 * 60_000;
const HOUR = 3_600_000;
const PULL_GATES = {
  review: { author: 'review-bot[bot]', heading: '## Code review', workflow: '.github/workflows/review.yml', rerun: '[review]', commentAuthor: 'review-bot[bot]' },
  suites: [{ name: 'e2e suite', workflow: '.github/workflows/e2e.yml', jobs: 'e2e run', rerun: '[e2e]' }],
  qa: null,
  mergeRisk: null,
};
const approvedReview = () => [{ user: { login: 'review-bot[bot]' }, state: 'APPROVED', body: '## Code review' }];
const e2eRuns = (conclusion = () => 'success') => [1, 2, 3, 4].map((n) => ({ name: `e2e run (${n}/4)`, status: 'completed', conclusion: conclusion(n), html_url: `u${n}` }));

function setup({ userSettings = null, maxRunning = 5, maxPrivatePerPerson = 10, writers = ['joel'], issues = {}, ghToken = 'gh-token', databases = null, slack = null, homes = null, retention, people = null, autoName = null, attachments = null, assignables = [], githubSessions = null, memberList = null, pings = null, databasesRefusal = async () => null, projects = null, githubFor = null, consoleLinks = undefined, appDomain = '', gates = PULL_GATES } = {}) {
  let clock = Date.parse('2026-10-21T10:00:00.000Z');
  const calls = { started: [], stopped: [], statusd: [], comments: [], checks: [], reactions: [], unlabeled: [], found: [], assignees: [], statusMoves: [], taskStates: [], taskState: [] };
  const alive = new Set();
  // When ECS began pulling each task's image, by ref.
  const pulls = {};
  const statuses = {};
  // A promise start waits on before it answers, as run-task and the wait for an address do.
  const fail = { send: false, start: false, startWaits: null, find: false, findWaits: null, taskStates: false };
  const launcher = {
    kind: 'fake',
    refFor(id) { return `c-${id}`; },
    async start(id, env) {
      calls.started.push({ id, env });
      if (fail.start) throw new Error(typeof fail.start === 'string' ? fail.start : 'aws ecs run-task failed: AccessDeniedException');
      alive.add(`c-${id}`);
      if (fail.startWaits) await fail.startWaits;
      return { ref: `c-${id}`, host: '127.0.0.1', termPort: 1, statusPort: 2 };
    },
    async find(id) {
      calls.found.push(id);
      if (fail.find) throw new Error(fail.find);
      // Read before the wait, as list-tasks answers before the describe that follows it.
      const running = alive.has(`c-${id}`);
      if (fail.findWaits) await fail.findWaits;
      return running ? { ref: `c-${id}`, host: '127.0.0.1', termPort: 1, statusPort: 2 } : null;
    },
    async isAlive(ref) { return alive.has(ref); },
    async taskState(ref) {
      calls.taskState.push(ref);
      return { alive: alive.has(ref), pullStartedAt: pulls[ref] ?? null };
    },
    async taskStates(refs) {
      calls.taskStates.push(refs);
      if (fail.taskStates) throw new Error('aws ecs describe-tasks failed: ThrottlingException: Rate exceeded');
      return new Map(refs.map((ref) => [ref, { alive: alive.has(ref), pullStartedAt: pulls[ref] ?? null }]));
    },
    async logTail() { return fail.logTail ?? '[woodshed 10:00:00] ERROR: PGHOST is not set'; },
    async stop(ref) { calls.stopped.push(ref); alive.delete(ref); },
  };
  const github = {
    events: [],
    comments: [],
    async latestEventId() { return 100; },
    pageSize: 100,
    async issueEventsSince() { return { events: this.events, complete: true }; },
    async commentsSince() { return this.comments; },
    async canWrite(login) { return writers.includes(login); },
    async issue(number) { return issues[number] ?? { title: `Issue ${number}` }; },
    async pull() { return { head: { ref: 'joel/pr-branch' } }; },
    async comment(number, body) { calls.comments.push({ number, body }); return 9000 + calls.comments.length; },
    async issueComments() { return []; },
    async workflowRun() { return { path: '.github/workflows/review.yml', head_sha: 'abc' }; },
    async updateComment(id, body) { calls.comments.push({ id, body }); return id; },
    async createCheckRun(check) { calls.checks.push(check); return 'https://github.com/o/r/runs/1'; },
    async removeLabel(number, label) { calls.unlabeled.push({ number, label }); return true; },
    async reactToIssue(number) { calls.reactions.push({ issue: number }); },
    async reactToComment(id) { calls.reactions.push({ comment: id }); },
    projectItems: {},
    async issueProjectItems(number) { return this.projectItems[number] ?? []; },
    async setProjectStatus(move) { calls.statusMoves.push(move); },
    async addAssignees(number, logins) { calls.assignees.push({ number, add: logins }); },
    async removeAssignees(number, logins) { calls.assignees.push({ number, remove: logins }); },
  };
  async function statusd(session, method, path, opts) {
    calls.statusd.push({ id: session.id, method, path, body: opts?.body });
    if (path === '/status') {
      if (!statuses[session.id]) throw new Error('connection refused');
      return statuses[session.id];
    }
    return { ok: true, committed: false, head: 'abc' };
  }
  const store = { state: { sessions: [], github: null }, save() {} };
  const config = {
    repo: 'o/r', label: 'woodshed', publicUrl: 'https://console.test', maxRunning,
    limits: { idleMs: 2 * HOUR, lifetimeMs: 8 * HOUR, startTimeoutMs: 15 * 60_000 },
    sessionEnv: { PGHOST: 'db' }, ghToken, pollMs: 30_000, fallbackPollMs: 300_000, retention, maxPrivatePerPerson,
    ...(projects ? { projects } : {}),
    ...(appDomain ? { appDomain } : {}),
  };
  const fleet = createFleet({
    config, store, launcher, github, databases, slack, homes, userSettings, people, autoName, attachments, now: () => clock,
    pings, pullRequests: async () => gates, databasesRefusal, githubFor, ...(consoleLinks ? { consoleLinks } : {}),
    // Every writer has sessions from GitHub unless a test names who does.
    members: {
      isAssignable: (login) => assignables.some((e) => e.toLowerCase() === String(login).toLowerCase()),
      assignables: () => [...assignables],
      hasGithubSessions: (login) => (githubSessions ?? writers).some((e) => e.toLowerCase() === String(login).toLowerCase()),
      isMember: (login) => (memberList ?? writers).some((e) => e.toLowerCase() === String(login).toLowerCase()),
    },
    statusd: (session, method, path, opts) => {
      if (path === '/send' && fail.send) return Promise.reject(new Error('statusd /send timed out'));
      return statusd(session, method, path, opts);
    },
  });
  return { fleet, calls, github, alive, pulls, statuses, store, fail, advance: (ms) => { clock += ms; } };
}

// The project file needs an engine the installation does not host (databaseGate.mjs): nothing starts that would get
// databases, and the reason reaches whoever asked.
test('a project whose databases are not hosted starts no session: a label is told why on its issue, and the API refuses', async () => {
  const why = 'the project file\'s databases need mongo, which this installation does not host (it hosts postgres)';
  const { fleet, calls } = setup({ databasesRefusal: async () => why });
  const outcome = await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'Add GTM', kind: 'issue' });
  assert.deepEqual(outcome, { outcome: 'ignored', reason: why });
  assert.deepEqual(calls.comments.map((c) => c.body), [`Woodshed cannot start a session here: ${why}.`]);
  assert.equal(fleet.sessions().length, 0);
  await assert.rejects(fleet.startPrivate({ owner: 'joel', prompt: 'Fix it' }), { shown: true, message: `Not started: ${why}` });
  assert.equal(calls.started.length, 0);
});

test('a label from a writer starts a session and announces it on the issue', async () => {
  const { fleet, calls } = setup();
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'Add GTM', kind: 'issue' });

  const [session] = fleet.sessions();
  assert.equal(session.status, 'starting');
  assert.equal(session.branch, `woodshed/42-${session.id}`);
  assert.deepEqual([session.project, session.repo], ['r', 'o/r'], 'on the default project, named after the repo');
  assert.deepEqual(calls.reactions, [{ issue: 42 }]);
  assert.equal(calls.comments.length, 1);
  assert.match(calls.comments[0].body, new RegExp(`https://console.test/s/${session.id}`));
  assert.doesNotMatch(calls.comments[0].body, /@claude/);

  const { env } = calls.started[0];
  assert.equal(env.ISSUE, '42');
  assert.equal(env.BRANCH, session.branch);
  assert.equal(env.GH_TOKEN, 'gh-token');
  assert.equal(env.SESSION_TOKEN, session.token);
  assert.equal(env.STARTED_BY, 'joel');
  assert.equal(env.SESSION_URL, `https://console.test/s/${session.id}`);
  assert.equal(env.PGHOST, 'db');
});

test('a session is told the domain its app answers under, and nothing when session apps are off', async () => {
  const { fleet, calls } = setup({ appDomain: 'apps.console.test' });
  await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it' });
  assert.equal(calls.started[0].env.SESSION_APP_DOMAIN, 'apps.console.test');
  const off = setup();
  await off.fleet.startPrivate({ owner: 'joel', prompt: 'Fix it' });
  assert.equal(off.calls.started[0].env.SESSION_APP_DOMAIN, undefined);
});

test('with a GitHub App, a session is given no GitHub token to keep', async () => {
  const { fleet, calls } = setup({ ghToken: null });
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'Add GTM', kind: 'issue' });
  assert.equal('GH_TOKEN' in calls.started[0].env, false);
});

test('a trigger from someone without write access does nothing', async () => {
  const { fleet, calls } = setup();
  await fleet.handleTrigger({ number: 42, login: 'outsider', trigger: 'label', title: 'x', kind: 'issue' });
  assert.equal(fleet.sessions().length, 0);
  assert.equal(calls.comments.length, 0);
});

test('a trigger from a handle that another GitHub account now holds does nothing', async () => {
  const checked = [];
  const people = { async check(login) { checked.push(login); return false; } };
  const { fleet, calls } = setup({ people });
  const outcome = await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  assert.deepEqual(outcome, { outcome: 'ignored', reason: 'the GitHub name was another account\'s when last used here' });
  assert.deepEqual(checked, ['joel']);
  assert.equal(fleet.sessions().length, 0);
  assert.deepEqual([calls.comments.length, calls.reactions.length], [0, 0]);
});

test('a PR label starts nothing, and a /woodshed comment on the PR checks out its head', async () => {
  const { fleet, calls } = setup({ issues: { 50: { title: 'Some PR', pull_request: {} } } });
  const labelled = await fleet.handleTrigger({ number: 50, login: 'joel', trigger: 'label', title: 'Some PR', kind: 'pr' });
  assert.equal(labelled.outcome, 'ignored');
  assert.deepEqual([fleet.sessions().length, calls.started.length, calls.comments.length], [0, 0, 0]);

  await fleet.handleTrigger({ number: 50, login: 'joel', trigger: 'comment', text: 'fix the review', commentId: 7 });
  assert.equal(fleet.sessions()[0].branch, 'joel/pr-branch');
  assert.equal(calls.started[0].env.PR, '50');
  assert.equal(calls.started[0].env.BRANCH, undefined);
});

test('a writer without sessions from GitHub starts nothing: the label comes off and the issue says why', async () => {
  const { fleet, calls, store } = setup({ writers: ['joel', 'sam', 'outsider'], githubSessions: ['joel'], memberList: ['joel', 'sam'], issues: { 50: { title: 'Some PR', pull_request: {} } } });
  store.state.github = { seenComments: [] };
  const labelled = await fleet.handleTrigger({ number: 42, login: 'sam', trigger: 'label', title: 'Add GTM', kind: 'issue' });
  assert.deepEqual(labelled, { outcome: 'ignored', reason: '@sam has no sessions from GitHub' });
  assert.deepEqual([fleet.sessions().length, calls.started.length, calls.reactions.length], [0, 0, 0]);
  assert.deepEqual(calls.unlabeled, [{ number: 42, label: 'woodshed' }]);
  assert.equal(calls.comments.length, 1);
  assert.match(calls.comments[0].body, /@sam can't start Woodshed sessions from GitHub yet, so nothing started and the `woodshed` label was taken off/);
  assert.match(calls.comments[0].body, /https:\/\/console\.test\/people/);
  assert.deepEqual(store.state.github.seenComments, [calls.comments[0].id ?? 9001], 'its own reply is never read back as a command');

  const commented = await fleet.handleTrigger({ number: 42, login: 'sam', trigger: 'comment', text: 'do it', commentId: 7 });
  assert.equal(commented.outcome, 'ignored');
  assert.equal(calls.unlabeled.length, 1, 'a comment has no label to take off');
  assert.doesNotMatch(calls.comments[1].body, /label/);

  const onPr = await fleet.handleTrigger({ number: 50, login: 'sam', trigger: 'label', title: 'Some PR', kind: 'pr' });
  assert.equal(onPr.outcome, 'ignored');
  assert.equal(calls.comments.length, 2, 'what is ignored for everyone gets no reply');

  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'Add GTM', kind: 'issue' });
  assert.equal(fleet.sessions().length, 1, 'someone with it starts the session as usual');

  await fleet.handleTrigger({ number: 43, login: 'outsider', trigger: 'label', title: 'Other', kind: 'issue' });
  const told = calls.comments.at(-1).body;
  assert.match(told, /Ask an admin to add you to the console \(https:\/\/console\.test\)/, 'a writer not on People is told to be added first');
  assert.doesNotMatch(told, /\/people/);
});

test('sessions past the cap queue, and a stop starts the next one', async () => {
  const { fleet, calls } = setup({ maxRunning: 1 });
  await fleet.handleTrigger({ number: 1, login: 'joel', trigger: 'label', title: 'one', kind: 'issue' });
  await fleet.handleTrigger({ number: 2, login: 'joel', trigger: 'label', title: 'two', kind: 'issue' });
  const [first, second] = fleet.sessions();
  assert.equal(second.status, 'queued');
  assert.match(calls.comments[1].body, /^Queued a session on Woodshed for @joel/);

  await fleet.stop(first, 'stopped from the console');
  assert.equal(first.status, 'stopped');
  assert.equal(second.status, 'starting');
  assert.ok(calls.statusd.some((c) => c.id === first.id && c.path === '/checkpoint'));
  assert.deepEqual(calls.stopped, [`c-${first.id}`]);
});

test('a stop from the console records who stopped it, an idle pause no one, and a resume clears it', async () => {
  const { fleet, statuses } = setup();
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = fleet.sessions();
  statuses[session.id] = { state: 'working' };
  await fleet.tick();
  await fleet.stop(session, 'stopped from the console', { by: 'joel' });
  assert.deepEqual([session.status, session.stoppedBy], ['stopped', 'joel']);
  await fleet.resumeShared(session, { by: 'joel', why: 'console' });
  assert.equal(session.stoppedBy, null);
  await fleet.tick();
  await fleet.stop(session, 'idle for 1 h');
  assert.deepEqual([session.status, session.stoppedBy], ['stopped', null]);
});

test('a comment on a running session is typed into it', async () => {
  const { fleet, calls, statuses } = setup();
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = fleet.sessions();
  statuses[session.id] = { state: 'needs-you', branch: session.branch, head: 'abc' };
  await fleet.tick();
  assert.equal(session.status, 'running');

  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'comment', text: 'option 1', commentId: 77 });
  assert.deepEqual(calls.statusd.filter((c) => c.path === '/send').map((c) => c.body), [{ text: 'option 1' }]);
  assert.deepEqual(calls.reactions.at(-1), { comment: 77 });
});

test('a message for a starting session is held until claude is open', async () => {
  const { fleet, calls, statuses } = setup();
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = fleet.sessions();
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'comment', text: 'also add tests', commentId: 78 });
  assert.equal(session.pendingMessages.length, 1);
  assert.equal(calls.statusd.filter((c) => c.path === '/send').length, 0);

  // Running, but claude is still opening: its pane holds a shell, which would run the text.
  statuses[session.id] = { state: 'starting' };
  await fleet.tick();
  assert.equal(calls.statusd.filter((c) => c.path === '/send').length, 0);

  statuses[session.id] = { state: 'working' };
  await fleet.tick();
  assert.deepEqual(calls.statusd.filter((c) => c.path === '/send').map((c) => c.body), [{ text: 'also add tests' }]);
  assert.equal(session.pendingMessages.length, 0);
});

test('a comment on a stopped issue resumes its session; once it is cleaned up, a new one starts on its branch', async () => {
  const { fleet, calls, statuses } = setup();
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [first] = fleet.sessions();
  statuses[first.id] = { state: 'done', claudeSession: '0b6e9c7a-1d2f-4e5a-9b8c-7d6e5f4a3b2c' };
  await fleet.tick();
  const oldToken = first.token;
  await fleet.stop(first, 'test');
  assert.equal(first.kept, true);

  const resumed = await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'comment', text: 'pick it up again', commentId: 80 });
  assert.deepEqual(resumed, { outcome: 'resumed', sessionId: first.id });
  assert.equal(fleet.sessions().length, 1, 'the same session runs again');
  assert.equal(first.status, 'starting');
  assert.notEqual(first.token, oldToken, 'with new tokens');
  assert.equal(calls.started[1].env.RESUME_SESSION, '0b6e9c7a-1d2f-4e5a-9b8c-7d6e5f4a3b2c');
  assert.equal(calls.started[1].env.BRANCH, first.branch);
  assert.deepEqual(first.pendingMessages, ['pick it up again'], 'the comment is typed in once claude is open');
  assert.match(calls.comments.at(-1).body, /^Resumed the Woodshed session on `woodshed\/42-/);

  await fleet.stop(first, 'test');
  await fleet.deleteShared(first, 'joel');
  assert.deepEqual([first.kept, Boolean(first.cleanedAt)], [false, true]);
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'comment', text: 'and again', commentId: 81 });
  const second = fleet.sessions()[1];
  assert.equal(second.branch, first.branch);
  assert.equal(calls.started.at(-1).env.PROMPT, 'and again');
  assert.equal(calls.started.at(-1).env.RESUME_SESSION, undefined);
});

test('a comment on the pull request a shared session opened goes to that session', async () => {
  const { fleet, calls, statuses } = setup();
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = fleet.sessions();
  statuses[session.id] = { state: 'done', prUrl: 'https://github.com/o/r/pull/77' };
  await fleet.tick();
  const sent = await fleet.handleTrigger({ number: 77, login: 'joel', trigger: 'comment', text: 'rename it', commentId: 90 });
  assert.deepEqual(sent, { outcome: 'sent', sessionId: session.id });
  await fleet.stop(session, 'test');
  const resumed = await fleet.handleTrigger({ number: 77, login: 'joel', trigger: 'comment', text: 'one more thing', commentId: 91 });
  assert.deepEqual(resumed, { outcome: 'resumed', sessionId: session.id });
  assert.equal(fleet.sessions().length, 1);
  assert.equal(calls.started.length, 2);
});

test('a container that dies while starting fails with its last log line', async () => {
  const { fleet, alive } = setup();
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = fleet.sessions();
  alive.clear();
  await fleet.tick();
  assert.equal(session.status, 'failed');
  assert.equal(session.error, 'PGHOST is not set');
});

test('a failed start shows the entrypoint\'s ERROR, not ECS\'s stop reason after it', async () => {
  const { fleet, alive, fail } = setup();
  fail.logTail = [
    '[woodshed 17:23:08] Cloning the project\'s repo (repo: o/r)',
    '[woodshed 17:23:10] ERROR: .woodshed/project.yaml: pullRequests.qa is missing author',
    'Essential container in task exited: exit code 1',
  ].join('\n');
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = fleet.sessions();
  alive.clear();
  await fleet.tick();
  assert.equal(session.status, 'failed');
  assert.equal(session.error, '.woodshed/project.yaml: pullRequests.qa is missing author');
});

test('failureReason falls back to the last line, ECS\'s reason for a task that never logged', () => {
  assert.equal(failureReason('CannotPullContainerError: image not found'), 'CannotPullContainerError: image not found');
  assert.equal(failureReason('[woodshed 10:00:00] Cloning\nEssential container in task exited: exit code 137'), 'Essential container in task exited: exit code 137');
  assert.equal(failureReason('[woodshed 1] ERROR: first\n[woodshed 2] ERROR: second\nstop'), 'second');
  assert.equal(failureReason(''), null);
});

test('a start that fails at once is announced as failed, never as started', async () => {
  const { fleet, calls, fail } = setup();
  fail.start = true;
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = fleet.sessions();
  assert.equal(session.status, 'failed');
  assert.equal(calls.comments.length, 1);
  assert.match(calls.comments[0].body, /^The Woodshed session for @joel failed to start/);
  assert.doesNotMatch(calls.comments[0].body, /AccessDenied/, 'the error stays in the console');
});

test('a queued session whose later launch fails gets a follow-up', async () => {
  const { fleet, calls, fail } = setup({ maxRunning: 1 });
  await fleet.handleTrigger({ number: 1, login: 'joel', trigger: 'label', title: 'one', kind: 'issue' });
  await fleet.handleTrigger({ number: 2, login: 'joel', trigger: 'label', title: 'two', kind: 'issue' });
  const [first, second] = fleet.sessions();
  fail.start = true;
  await fleet.stop(first, 'stopped from the console');
  assert.equal(second.status, 'failed');
  const toSecond = calls.comments.filter((c) => c.number === 2);
  assert.equal(toSecond.length, 2);
  assert.match(toSecond[0].body, /^Queued/);
  assert.match(toSecond[1].body, /failed to start/);
});

test('a session that dies while starting, after its start comment, gets a follow-up', async () => {
  const { fleet, calls, alive } = setup();
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  alive.clear();
  await fleet.tick();
  assert.equal(calls.comments.length, 2);
  assert.match(calls.comments[0].body, /^Started a session on Woodshed/);
  assert.match(calls.comments[1].body, /failed to start/);
  assert.doesNotMatch(calls.comments[1].body, /PGHOST/, 'the log line stays in the console');
});

test('an idle session is checkpointed and stopped', async () => {
  const { fleet, calls, statuses, advance } = setup();
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = fleet.sessions();
  statuses[session.id] = { state: 'done' };
  await fleet.tick();
  advance(2 * HOUR + 60_000);
  await fleet.tick();
  assert.equal(session.status, 'stopped');
  assert.equal(session.stopReason, 'idle for 2 h');
  assert.ok(calls.statusd.some((c) => c.path === '/checkpoint'));
});

test('the first poll only records where GitHub is, so history is never replayed', async () => {
  const { fleet, github, store } = setup();
  github.events = [{ id: 99, event: 'labeled', label: { name: 'woodshed' }, actor: { login: 'joel' }, issue: { number: 1, title: 'old' } }];
  await fleet.pollGitHub();
  assert.equal(fleet.sessions().length, 0);
  assert.equal(store.state.github.lastEventId, 100);

  github.events = [{ id: 101, event: 'labeled', label: { name: 'woodshed' }, actor: { login: 'joel' }, issue: { number: 1, title: 'new' } }, ...github.events];
  await fleet.pollGitHub();
  await fleet.pollGitHub();
  assert.equal(fleet.sessions().length, 1);
});

const LABELED_AT = '2026-10-21T10:00:00Z';

test('a label a webhook started is skipped by the poll, even after its session stopped', async () => {
  const { fleet, github } = setup();
  await fleet.pollGitHub();
  await fleet.handleWebhookTrigger({ number: 7, login: 'joel', trigger: 'label', title: 'x', kind: 'issue', at: '2026-10-21T10:00:03Z' });
  assert.equal(fleet.sessions().length, 1);
  fleet.sessions()[0].status = 'stopped';

  github.events = [{ id: 101, event: 'labeled', created_at: LABELED_AT, label: { name: 'woodshed' }, actor: { login: 'joel' }, issue: { number: 7, title: 'x' } }];
  await fleet.pollGitHub();
  assert.equal(fleet.sessions().length, 1);
});

test('a label the poll started is skipped by a late webhook', async () => {
  const { fleet, github } = setup();
  await fleet.pollGitHub();
  github.events = [{ id: 101, event: 'labeled', created_at: LABELED_AT, label: { name: 'woodshed' }, actor: { login: 'joel' }, issue: { number: 7, title: 'x' } }];
  await fleet.pollGitHub();
  fleet.sessions()[0].status = 'stopped';
  await fleet.handleWebhookTrigger({ number: 7, login: 'joel', trigger: 'label', title: 'x', kind: 'issue', at: '2026-10-21T10:00:20Z' });
  assert.equal(fleet.sessions().length, 1);
});

test('the same label added again later starts a new session', async () => {
  const { fleet } = setup();
  await fleet.handleWebhookTrigger({ number: 7, login: 'joel', trigger: 'label', title: 'x', kind: 'issue', at: LABELED_AT });
  fleet.sessions()[0].status = 'stopped';
  await fleet.handleWebhookTrigger({ number: 7, login: 'joel', trigger: 'label', title: 'x', kind: 'issue', at: '2026-10-21T11:00:00Z' });
  assert.equal(fleet.sessions().length, 2);
});

test('a comment a webhook handled is never handled again by the poll', async () => {
  const { fleet, github, advance } = setup();
  await fleet.pollGitHub();
  advance(1000);
  await fleet.handleWebhookTrigger({ number: 9, login: 'joel', trigger: 'comment', text: 'go', commentId: 55 });
  assert.equal(fleet.sessions().length, 1);
  fleet.sessions()[0].status = 'stopped';

  github.comments = [{ id: 55, created_at: '2026-10-21T10:00:01Z', updated_at: '2026-10-21T10:00:01Z', body: '/woodshed go', user: { login: 'joel' }, issue_url: 'https://api.github.com/repos/o/r/issues/9' }];
  await fleet.pollGitHub();
  await fleet.handleWebhookTrigger({ number: 9, login: 'joel', trigger: 'comment', text: 'go', commentId: 55 });
  assert.equal(fleet.sessions().length, 1);
});

test('a webhook trigger that fails before a session starts is handled again on the retry', async () => {
  const { fleet, github } = setup();
  await fleet.pollGitHub();
  const canWrite = github.canWrite;
  github.canWrite = async () => { throw new Error('GitHub 502'); };
  const label = { number: 7, login: 'joel', trigger: 'label', title: 'x', kind: 'issue', at: LABELED_AT };
  const comment = { number: 9, login: 'joel', trigger: 'comment', text: 'go', commentId: 55 };
  await assert.rejects(fleet.handleWebhookTrigger(label), /GitHub 502/);
  await assert.rejects(fleet.handleWebhookTrigger(comment), /GitHub 502/);
  assert.equal(fleet.sessions().length, 0);

  github.canWrite = canWrite;
  await fleet.handleWebhookTrigger(label);
  await fleet.handleWebhookTrigger(comment);
  assert.deepEqual(fleet.sessions().map((s) => s.number), [7, 9]);
});

test('while webhooks arrive the poll runs only every fallbackPollMs', async () => {
  const { fleet, github, advance } = setup();
  let polls = 0;
  const read = github.issueEventsSince.bind(github);
  github.issueEventsSince = (...args) => { polls++; return read(...args); };
  await fleet.pollGitHub();

  fleet.webhooksAlive();
  await fleet.pollGitHub();
  assert.equal(polls, 1);
  advance(30_000);
  fleet.webhooksAlive();
  await fleet.pollGitHub();
  assert.equal(polls, 1);
  advance(300_000);
  fleet.webhooksAlive();
  await fleet.pollGitHub();
  assert.equal(polls, 2);

  // The queue goes quiet: the poll is back to every call.
  advance(61_000);
  await fleet.pollGitHub();
  assert.equal(polls, 3);
});

test('a queued session listed by two callers at once is launched once', async () => {
  const { fleet, calls, store } = setup({ maxRunning: 2 });
  store.state.sessions.push({
    id: 'q1q1q1q1', repo: 'o/r', kind: 'issue', number: 3, title: 'q', startedBy: 'joel', status: 'queued',
    createdAt: '2026-10-21T09:00:00.000Z', pendingMessages: [], token: 't', terminalToken: 'tt',
  });
  await Promise.all([fleet.tick(), fleet.handleTrigger({ number: 4, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' })]);
  assert.equal(calls.started.filter((c) => c.id === 'q1q1q1q1').length, 1);
  assert.equal(calls.started.length, 2);
});

test('a stop interrupted by a restart is finished by the next tick', async () => {
  const { fleet, calls, store } = setup();
  store.state.sessions.push({
    id: 's1s1s1s1', repo: 'o/r', kind: 'issue', number: 3, title: 's', startedBy: 'joel', status: 'stopping', ref: 'c-s1s1s1s1',
    createdAt: '2026-10-21T09:00:00.000Z', pendingMessages: [], endpoint: { host: 'h' },
  });
  await fleet.tick();
  assert.equal(store.state.sessions[0].status, 'stopped');
  assert.deepEqual(calls.stopped, ['c-s1s1s1s1']);
});

test('a start a restart lost track of is found by its session id and comes up, not left to time out', async () => {
  const { fleet, alive, statuses, store, calls } = setup();
  store.state.sessions.push({
    id: 'l1l1l1l1', repo: 'o/r', kind: 'task', number: null, title: 'l', startedBy: 'joel', owner: 'joel', status: 'starting',
    ref: null, endpoint: null, startedAt: '2026-10-21T09:59:00.000Z', createdAt: '2026-10-21T09:59:00.000Z',
    startSteps: { claude: '2026-10-21T09:59:40.000Z' }, pendingMessages: [], token: 't', terminalToken: 'tt',
  });
  const [session] = store.state.sessions;

  // No task yet: it stays starting, and the next tick looks again.
  await fleet.tick();
  assert.equal(session.status, 'starting');
  assert.equal(session.ref, null);

  alive.add('c-l1l1l1l1');
  statuses.l1l1l1l1 = { state: 'working' };
  await fleet.tick();
  assert.equal(session.ref, 'c-l1l1l1l1');
  assert.equal(session.endpoint.statusPort, 2);
  assert.equal(session.status, 'running');
  assert.ok(session.startSteps.machine && session.startSteps.claude, 'the steps it had reported are kept');
  assert.deepEqual(calls.found, ['l1l1l1l1', 'l1l1l1l1']);
});

test('a lost start stopped while the console looks for its task is left stopped', async () => {
  const { fleet, alive, store, fail } = setup();
  store.state.sessions.push({
    id: 'l2l2l2l2', repo: 'o/r', kind: 'task', number: null, title: 'l', startedBy: 'joel', owner: 'joel', status: 'starting',
    ref: null, endpoint: null, startedAt: '2026-10-21T09:59:00.000Z', createdAt: '2026-10-21T09:59:00.000Z',
    pendingMessages: [], token: 't', terminalToken: 'tt',
  });
  const [session] = store.state.sessions;
  alive.add('c-l2l2l2l2');
  let answer;
  fail.findWaits = new Promise((resolve) => { answer = resolve; });
  const ticking = fleet.tick();
  await new Promise((resolve) => setImmediate(resolve));
  // The stop lands between the console asking for the task and the answer.
  await fleet.stop(session, 'stopped from the console', { by: 'joel' });
  answer();
  await ticking;
  assert.equal(session.ref, null);
  assert.equal(session.status, 'stopped');
});

test('a lost start whose lookup keeps failing still times out', async () => {
  const { fleet, store, fail, advance } = setup();
  store.state.sessions.push({
    id: 'l3l3l3l3', repo: 'o/r', kind: 'task', number: null, title: 'l', startedBy: 'joel', owner: 'joel', status: 'starting',
    ref: null, endpoint: null, startedAt: '2026-10-21T10:00:00.000Z', createdAt: '2026-10-21T10:00:00.000Z',
    pendingMessages: [], token: 't', terminalToken: 'tt',
  });
  const [session] = store.state.sessions;
  fail.find = 'aws ecs list-tasks failed: ThrottlingException';
  advance(16 * 60_000);
  await fleet.tick();
  assert.equal(session.status, 'stopped');
  assert.equal(session.stopReason, 'did not start in time');
});

test('a session this console is still launching is not looked for: its own start records the task', async () => {
  const { fleet, fail, calls } = setup();
  let finish;
  fail.startWaits = new Promise((resolve) => { finish = resolve; });
  const starting = fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  await new Promise((resolve) => setImmediate(resolve));
  const [session] = fleet.sessions();
  assert.equal(session.status, 'starting');
  await fleet.tick();
  assert.deepEqual(calls.found, []);
  finish();
  await starting;
  assert.equal(session.ref, `c-${session.id}`);
});

test('a message whose send fails is held, not lost, and goes out on a later tick', async () => {
  const { fleet, calls, statuses, fail } = setup();
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = fleet.sessions();
  statuses[session.id] = { state: 'done' };
  await fleet.tick();
  fail.send = true;
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'comment', text: 'keep me', commentId: 90 });
  assert.deepEqual(session.pendingMessages, ['keep me']);
  await fleet.tick();
  assert.deepEqual(session.pendingMessages, ['keep me']);
  fail.send = false;
  await fleet.tick();
  assert.deepEqual(session.pendingMessages, []);
  assert.ok(calls.statusd.some((c) => c.path === '/send' && c.body.text === 'keep me'));
});

test('sessions get separate statusd and terminal tokens', async () => {
  const { fleet, calls } = setup();
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const { env } = calls.started[0];
  assert.ok(env.TERMINAL_TOKEN);
  assert.notEqual(env.TERMINAL_TOKEN, env.SESSION_TOKEN);
});

test('startComment never mentions @claude', () => {
  const body = startComment({ session: { id: 'abcd1234', status: 'starting', startedBy: 'joel', branch: 'woodshed/1-abcd1234' }, publicUrl: 'https://x', maxRunning: 5 });
  assert.doesNotMatch(body, /@claude/i);
});

test('startComment gives the session app\'s address when apps are on, and none otherwise', () => {
  const session = { id: 'abcd1234', status: 'starting', startedBy: 'joel', branch: 'woodshed/1-abcd1234' };
  assert.match(startComment({ session, publicUrl: 'https://x', maxRunning: 5, appDomain: 'woodshed.example' }), /^Its app, once started from that page: https:\/\/abcd1234\.woodshed\.example\/$/m);
  assert.doesNotMatch(startComment({ session, publicUrl: 'https://x', maxRunning: 5 }), /Its app/);
});

test('Stop app asks the session\'s statusd and takes the app\'s state from its answer', async () => {
  const { fleet, calls, statuses } = setup();
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = fleet.sessions();
  await assert.rejects(fleet.stopApp(session), (err) => err.notRunning === true, 'a session still starting has no app');

  statuses[session.id] = { state: 'done', app: 'running', appServers: { frontend: true, backend: true } };
  await fleet.tick();
  assert.deepEqual([session.status, session.app, session.appServers], ['running', 'running', { frontend: true, backend: true, frontendPort: null, backendPort: null }]);
  await fleet.stopApp(session);
  assert.ok(calls.statusd.some((c) => c.method === 'POST' && c.path === '/app/stop'));
  assert.equal(session.app, 'stopping', 'statusd answered without a state, as the fake does, so the console assumes one');
});

test('Start app names one of several apps to statusd, and none for one app or an image from before several', async () => {
  const { fleet, calls, statuses } = setup();
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = fleet.sessions();
  statuses[session.id] = { state: 'done', app: 'stopped' };
  await fleet.tick();
  await assert.rejects(fleet.startApp(session, { app: 'admin' }), (err) => err.refused && /starts its one app only/.test(err.message),
    'a statusd that listed no apps runs its one');
  await fleet.startApp(session);
  assert.deepEqual(calls.statusd.filter((c) => c.path === '/app/start').map((c) => c.body), [undefined], 'no body: the default, for any image');

  statuses[session.id] = { state: 'done', app: 'running', appName: 'web', apps: [{ name: 'web', label: 'Web' }, { name: 'admin', label: 'Admin' }] };
  await fleet.tick();
  assert.deepEqual([session.appName, session.apps.map((a) => a.name)], ['web', ['web', 'admin']]);
  await assert.rejects(fleet.startApp(session, { app: 'mobile' }), (err) => err.refused && /no app named mobile/.test(err.message));
  await fleet.startApp(session, { app: 'admin' });
  assert.deepEqual(calls.statusd.filter((c) => c.path === '/app/start').map((c) => c.body), [undefined, { app: 'admin' }]);
  assert.equal(session.appName, 'admin', 'the pick shows before the next status check');
});

test('Set up app types the setup request into claude, only for a running session whose project has no app', async () => {
  const { fleet, calls, statuses } = setup();
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = fleet.sessions();
  await assert.rejects(fleet.setupApp(session), (err) => err.notRunning === true);

  statuses[session.id] = { state: 'idle', app: 'stopped' };
  await fleet.tick();
  await assert.rejects(fleet.setupApp(session), (err) => err.refused === true, 'a project with an app is started, not set up');

  statuses[session.id] = { state: 'idle', app: 'none' };
  await fleet.tick();
  assert.equal(session.app, 'none', 'the console keeps statusd\'s none');
  const { sent } = await fleet.setupApp(session);
  assert.equal(sent, 'sent');
  assert.deepEqual(calls.statusd.filter((c) => c.path === '/send').map((c) => c.body), [{ text: SETUP_APP_PROMPT }]);
  assert.match(SETUP_APP_PROMPT, /\.woodshed\/project\.yaml/);
  assert.doesNotMatch(SETUP_APP_PROMPT, /\n/, 'typed as one message');
  for (const field of ['start', 'stop', 'frontendPort', 'backendPort', 'logs', 'howToProve']) assert.match(SETUP_APP_PROMPT, new RegExp(`\`${field}\``), `names ${field}, which the project file's app reads`);
});

test('a starting session records each start step once, and opens on the quick check without an aws call', async () => {
  const { fleet, calls, statuses, alive, advance } = setup();
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = fleet.sessions();
  assert.equal(session.status, 'starting');
  assert.equal(session.startSteps.machine, '2026-10-21T10:00:00.000Z', 'the console\'s own step, once the task has an address');

  advance(9_000);
  fleet.startStep(session, 'container');
  advance(4_000);
  fleet.startStep(session, 'branch');
  fleet.startStep(session, 'container');
  assert.deepEqual(Object.keys(session.startSteps), ['machine', 'container', 'branch']);
  assert.equal(session.startSteps.container, '2026-10-21T10:00:09.000Z', 'a step reported twice keeps its first time');

  await fleet.checkStarting();
  assert.equal(session.status, 'starting', 'statusd not up yet');
  statuses[session.id] = { state: 'working' };
  alive.clear();
  await fleet.checkStarting();
  assert.equal(session.status, 'running', 'the quick check reads statusd alone, never whether the task is alive');
  assert.equal(calls.statusd.filter((c) => c.path === '/status').length, 2);

  fleet.startStep(session, 'claude');
  assert.equal(session.startSteps.claude, undefined, 'a running session\'s start is over');
});

test('the wait for AWS ends when ECS began the pull, as the tick reads it, even after the container reported', async () => {
  const { fleet, pulls, advance } = setup();
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = fleet.sessions();
  await fleet.tick();
  assert.equal(session.startSteps.pullStarted, undefined, 'no pull yet');

  advance(80_000);
  fleet.startStep(session, 'container');
  pulls[session.ref] = '2026-10-21T10:01:12.000Z';
  await fleet.tick();
  assert.equal(session.startSteps.pullStarted, '2026-10-21T10:01:12.000Z', 'ECS\'s own time, not when the tick read it');
  pulls[session.ref] = '2026-10-21T10:01:30.000Z';
  await fleet.tick();
  assert.equal(session.startSteps.pullStarted, '2026-10-21T10:01:12.000Z', 'kept once');
});

test('a tick reads every session\'s task in one call, and each alone when that call fails', async () => {
  const { fleet, calls, alive, fail } = setup();
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  await fleet.handleTrigger({ number: 43, login: 'joel', trigger: 'label', title: 'y', kind: 'issue' });
  const [a, b] = fleet.sessions();
  calls.taskStates.length = 0;
  calls.taskState.length = 0;
  await fleet.tick();
  assert.deepEqual(calls.taskStates, [[a.ref, b.ref]]);
  assert.deepEqual(calls.taskState, [], 'none read alone');

  fail.taskStates = true;
  alive.delete(b.ref);
  await fleet.tick();
  assert.deepEqual(calls.taskState, [a.ref, b.ref]);
  assert.notEqual(a.status, b.status, 'the gone task is still noticed');
});

test('a tick still runs while the quick check waits on a slow statusd, and a held message goes in once', async () => {
  const { fleet, calls, statuses } = setup();
  await fleet.handleTrigger({ number: 41, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [running] = fleet.sessions();
  statuses[running.id] = { state: 'working' };
  await fleet.tick();
  assert.equal(running.status, 'running');

  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'y', kind: 'issue' });
  const starting = fleet.sessions().find((s) => s.number === 42);
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'comment', text: 'also add tests', commentId: 78 });
  let answer;
  statuses[starting.id] = new Promise((resolve) => { answer = resolve; });
  const checking = fleet.checkStarting();

  const reads = (id) => calls.statusd.filter((c) => c.path === '/status' && c.id === id).length;
  const runningReads = reads(running.id);
  await fleet.tick();
  assert.equal(reads(running.id), runningReads + 1, 'the tick was not skipped');
  assert.equal(reads(starting.id), 1, 'the tick left the session the quick check is reading');

  answer({ state: 'working' });
  await checking;
  await fleet.tick();
  assert.equal(starting.status, 'running');
  assert.deepEqual(calls.statusd.filter((c) => c.path === '/send' && c.id === starting.id).map((c) => c.body), [{ text: 'also add tests' }]);
});

test('New session on My Woodshed starts a private session, posts nothing, and tells the container whose it is', async () => {
  const { fleet, calls } = setup({ issues: { 77: { title: 'A PR', pull_request: {} } } });
  const session = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix the currency\nrounding too', model: 'opus', permissionMode: 'plan' });
  assert.equal(session.owner, 'joel');
  assert.equal(session.kind, 'task');
  assert.equal(session.number, null);
  assert.equal(session.title, 'Fix the currency');
  assert.equal(session.branch, `woodshed/joel-${session.id}`);
  assert.deepEqual(calls.comments, [], 'nothing on GitHub');
  assert.deepEqual(calls.reactions, []);
  const { env } = calls.started[0];
  assert.equal(env.SESSION_KIND, 'private');
  assert.equal(env.MODEL, 'opus');
  assert.equal(env.PERMISSION_MODE, 'plan');
  assert.equal(env.EFFORT, undefined, 'claude\'s own effort when none is picked');
  assert.equal(env.ISSUE, undefined);
  assert.equal(env.BRANCH, session.branch);

  const onPr = await fleet.startPrivate({ owner: 'joel', prompt: 'Review it', workOn: '#77', name: 'Review 77' });
  assert.deepEqual([onPr.kind, onPr.number, onPr.branch, onPr.title], ['pr', 77, 'joel/pr-branch', 'Review 77']);
  assert.equal(calls.started[1].env.PR, '77');
  const onIssue = await fleet.startPrivate({ owner: 'joel', prompt: 'Do it', workOn: '12' });
  assert.deepEqual([onIssue.kind, onIssue.title, onIssue.branch], ['issue', 'Issue 12', `woodshed/12-${onIssue.id}`]);

  await fleet.startPrivate({ owner: 'joel', prompt: 'a fourth' });
  assert.equal(calls.started.length, 4, 'up to the per-person setting, whatever the shared slots');
  const mia = await fleet.startPrivate({ owner: 'mia', prompt: 'mine', workOn: 'mia/branch' });
  assert.equal(mia.branch, 'mia/branch');
  await assert.rejects(fleet.startPrivate({ owner: 'mia', prompt: 'x', workOn: 'PR #12' }), /is an issue, not a pull request/);
  await assert.rejects(fleet.startPrivate({ owner: 'mia', prompt: '  ' }), /say what Claude should do/);
  const reviewOnly = await fleet.startPrivate({ owner: 'mia', prompt: '', workOn: '#77' });
  assert.equal(reviewOnly.kind, 'pr', 'a pull request with no prompt starts a session to review it');
  await assert.rejects(fleet.startPrivate({ owner: 'mia', prompt: '', workOn: '12' }), /say what Claude should do/);
  await assert.rejects(fleet.startPrivate({ owner: 'mia', prompt: '  ', agent: 'codex' }), /say what Codex should do/);
  const onBranch = await fleet.startPrivate({ owner: 'mia', prompt: '', workOn: 'mia/branch' });
  assert.equal(onBranch.title, 'Review mia/branch', 'a branch with no prompt is named for the branch');
  assert.equal(reviewOnly.prompt, '', 'claude is given nothing to do');
  assert.equal(reviewOnly.reviewOnly, true);
  const launchOf = (session) => calls.started.find((c) => c.env.SESSION_ID === session.id);
  assert.equal(launchOf(reviewOnly).env.REVIEW_ONLY, '1', 'the container is told to start claude empty and the review itself');
  assert.equal(launchOf(reviewOnly).env.PROMPT, undefined);
  assert.equal(onBranch.reviewOnly, true);
  assert.equal(launchOf(onIssue).env.REVIEW_ONLY, undefined, 'a session with a prompt is not a review-only one');
});

test('files attached to New session are claimed before it starts, told to the container, and go with Remove', async () => {
  const claimed = [];
  const dropped = [];
  const attachments = {
    claim: async ({ login, ids, sessionId }) => { claimed.push({ login, ids, sessionId }); return ids.length; },
    drop: async (id) => { dropped.push(id); },
  };
  const { fleet, calls } = setup({ attachments });
  const session = await fleet.startPrivate({ owner: 'joel', prompt: 'Look at these', attachmentIds: ['a1', 'b2'] });
  assert.deepEqual(claimed, [{ login: 'joel', ids: ['a1', 'b2'], sessionId: session.id }]);
  assert.equal(calls.started[0].env.ATTACHMENTS, '2');
  const plain = await fleet.startPrivate({ owner: 'joel', prompt: 'No files' });
  assert.equal(calls.started[1].env.ATTACHMENTS, undefined);
  await fleet.stop(plain, 'test');
  await fleet.removePrivateSession({ owner: 'joel', id: plain.id });
  assert.deepEqual(dropped, [plain.id]);
});

test('a rename is trimmed and kept, and an empty one refused', async () => {
  const { fleet } = setup();
  const session = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it' });
  fleet.rename(session, '  Billing   rounding ');
  assert.equal(fleet.find(session.id).title, 'Billing rounding');
  assert.throws(() => fleet.rename(session, '   '), /cannot be empty/);
});

test('a private session with no name starts on its prompt\'s first line, and takes the auto-namer\'s name when it comes', async () => {
  const named = [];
  const answers = {};
  const autoName = (prompt) => { named.push(prompt); return new Promise((resolve) => { answers[prompt] = resolve; }); };
  const { fleet } = setup({ autoName });
  const fix = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix the currency\nrounding too' });
  assert.equal(fix.title, 'Fix the currency', 'the session does not wait for the name');
  answers['Fix the currency\nrounding too']('Billing rounding');
  await new Promise(setImmediate);
  assert.equal(fleet.find(fix.id).title, 'Billing rounding');

  const look = await fleet.startPrivate({ owner: 'joel', prompt: 'Look at it' });
  answers['Look at it']('');
  await new Promise(setImmediate);
  assert.equal(fleet.find(look.id).title, 'Look at it', 'no name keeps the first line');

  const renamed = await fleet.startPrivate({ owner: 'joel', prompt: 'Tidy up' });
  fleet.rename(renamed, 'My own name');
  answers['Tidy up']('Haiku name');
  await new Promise(setImmediate);
  assert.equal(fleet.find(renamed.id).title, 'My own name', 'a rename on the rail before the answer is kept');

  assert.equal((await fleet.startPrivate({ owner: 'joel', prompt: 'Fix x', name: 'Mine' })).title, 'Mine');
  assert.deepEqual(named, ['Fix the currency\nrounding too', 'Look at it', 'Tidy up'], 'a name given is not asked for');
});

test('a /woodshed comment on an issue with a private session starts its own shared one', async () => {
  const { fleet } = setup();
  const mine = await fleet.startPrivate({ owner: 'joel', prompt: 'quietly', workOn: '#42' });
  const result = await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'comment', text: 'go', commentId: 5 });
  assert.equal(result.outcome, 'started');
  const shared = fleet.find(result.sessionId);
  assert.equal(shared.owner, null);
  assert.notEqual(shared.branch, mine.branch, 'nor does it resume the private session\'s branch');
});

test('Remove My Woodshed stops the owner\'s private sessions, then takes them all off the list, and no one else\'s', async () => {
  const { fleet, calls, statuses, store } = setup();
  const running = await fleet.startPrivate({ owner: 'joel', prompt: 'one' });
  statuses[running.id] = { state: 'working' };
  await fleet.tick();
  const ended = await fleet.startPrivate({ owner: 'joel', prompt: 'two' });
  await fleet.stop(ended, 'stopped from the console');
  const mia = await fleet.startPrivate({ owner: 'mia', prompt: 'hers' });
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'Shared', kind: 'issue' });
  const checkpoints = () => calls.statusd.filter((c) => c.path === '/checkpoint').map((c) => c.id);

  // A stop the last run of the console began and never finished.
  const halfStopped = await fleet.startPrivate({ owner: 'joel', prompt: 'three' });
  Object.assign(halfStopped, { status: 'stopping', ref: `c-${halfStopped.id}` });

  assert.deepEqual(await fleet.removePrivate('joel'), { stopped: 2, removed: 3 });
  assert.ok(checkpoints().includes(running.id), 'its work was pushed first');
  assert.ok(calls.stopped.includes(`c-${halfStopped.id}`), 'an interrupted stop is finished, so its task does not run on');
  assert.deepEqual(store.state.sessions.map((s) => s.owner ?? 'shared').sort(), ['mia', 'shared']);
  assert.equal(fleet.find(mia.id).status, 'starting', 'a teammate\'s session is untouched');
});

test('Resume starts a private session whose start failed again, with the conversation it had before', async () => {
  const { fleet, calls, statuses, alive } = setup();
  const first = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it', workOn: 'joel/fix' });
  statuses[first.id] = { state: 'working', claudeSession: '0b6e9c7a-1d2f-4e5a-9b8c-7d6e5f4a3b2c', branch: 'joel/fix' };
  await fleet.tick();
  await fleet.stop(first, 'stopped from the console', { by: 'joel' });
  await fleet.resumePrivate({ owner: 'joel', id: first.id });
  delete statuses[first.id];
  alive.clear();
  await fleet.tick();
  assert.equal(first.status, 'failed');
  await fleet.resumePrivate({ owner: 'joel', id: first.id });
  assert.equal(first.status, 'starting');
  assert.equal(first.error, null);
  assert.equal(first.resumeClaude, '0b6e9c7a-1d2f-4e5a-9b8c-7d6e5f4a3b2c');
  assert.equal(calls.started.length, 3);
});

test('Resume starts a stopped private session again on its branch, reopening claude\'s conversation, for its owner only', async () => {
  const { fleet, calls, statuses } = setup();
  const first = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it', model: 'opus', workOn: 'joel/fix' });
  statuses[first.id] = { state: 'working', claudeSession: '0b6e9c7a-1d2f-4e5a-9b8c-7d6e5f4a3b2c', branch: 'joel/fix' };
  await fleet.tick();
  assert.equal(first.claudeSession, '0b6e9c7a-1d2f-4e5a-9b8c-7d6e5f4a3b2c');
  await assert.rejects(fleet.resumePrivate({ owner: 'joel', id: first.id }), /still running/);
  await fleet.stop(first, 'stopped from the console', { by: 'joel' });
  assert.equal(first.stoppedBy, 'joel');

  await assert.rejects(fleet.resumePrivate({ owner: 'mia', id: first.id }), /no session you can open/);
  const sessionsBefore = fleet.sessions().length;
  const again = await fleet.resumePrivate({ owner: 'joel', id: first.id });
  assert.equal(again, first, 'the same session, with its page and id');
  assert.equal(fleet.sessions().length, sessionsBefore, 'no second record');
  assert.equal(again.status, 'starting');
  assert.equal(again.stoppedBy, null, 'the last run\'s Stop is not carried into this one');
  assert.deepEqual([again.branch, again.options.model, again.owner, again.prompt], ['joel/fix', 'opus', 'joel', 'Fix it'],
    'the prompt goes along, for when the conversation is not in the home');
  assert.equal(calls.started.at(-1).env.RESUME_SESSION, '0b6e9c7a-1d2f-4e5a-9b8c-7d6e5f4a3b2c');

  const never = await fleet.startPrivate({ owner: 'joel', prompt: 'Never got going' });
  await fleet.stop(never, 'stopped from the console');
  const fresh = await fleet.resumePrivate({ owner: 'joel', id: never.id });
  assert.equal(fresh.prompt, 'Never got going');
  assert.equal(calls.started.at(-1).env.RESUME_SESSION, undefined);
});

test('New session in the background answers while the container is still coming up, and logs a launch that breaks', async () => {
  const { fleet, calls, fail, store } = setup();
  let finish;
  fail.startWaits = new Promise((resolve) => { finish = resolve; });
  const session = await fleet.startPrivate({ owner: 'joel', prompt: 'Go', background: true });
  assert.equal(session.status, 'starting', 'the page already has the starting screen to show');
  assert.equal(calls.started.length, 1, 'the launch began');
  assert.equal(session.ref, null, 'and has no address yet');
  finish();
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(session.ref, `c-${session.id}`);

  const errors = [];
  const original = console.error;
  console.error = (...args) => { errors.push(args); };
  try {
    const realSave = store.save;
    let saves = 0;
    store.save = () => { if (++saves > 1) throw new Error('disk full'); realSave(); };
    const broken = await fleet.startPrivate({ owner: 'joel', prompt: 'Break it', background: true });
    assert.equal(broken.owner, 'joel', 'the caller still gets the session');
    await new Promise((resolve) => { setImmediate(resolve); });
  } finally {
    console.error = original;
  }
  assert.deepEqual(errors.map((e) => [e[0], e[1].message]), [['fleet: background start failed', 'disk full']]);
});

test('Resume in the background answers before the container has an address', async () => {
  const { fleet, fail } = setup();
  const first = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it' });
  await fleet.stop(first, 'stopped from the console');
  let finish;
  fail.startWaits = new Promise((resolve) => { finish = resolve; });
  const again = await fleet.resumePrivate({ owner: 'joel', id: first.id, background: true });
  assert.equal(again.status, 'starting');
  assert.equal(again.ref, null);
  finish();
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(again.ref, `c-${first.id}`);
});

test('Remove takes a private session, running or stopped, off the list with the Claude home it kept, and only its owner\'s', async () => {
  const removedHomes = [];
  const { fleet } = setup({ homes: { async remove(name) { removedHomes.push(name); } } });
  const mine = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it' });
  await assert.rejects(fleet.removePrivateSession({ owner: 'mia', id: mine.id }), /no session you can open/);
  await fleet.removePrivateSession({ owner: 'joel', id: mine.id });
  assert.equal(fleet.find(mine.id), null);
  assert.deepEqual(removedHomes, [`joel/sessions/${mine.id}`]);

});

test('a Resume that lands while Remove deletes the home finds no session, so nothing runs off the list', async () => {
  let resumed = null;
  const homes = { async remove() { resumed = await ctx.fleet.resumePrivate({ owner: 'joel', id: session.id }).catch((err) => err); } };
  const ctx = setup({ homes });
  const session = await ctx.fleet.startPrivate({ owner: 'joel', prompt: 'Race it' });
  await ctx.fleet.stop(session, 'stopped from the console');
  await ctx.fleet.removePrivateSession({ owner: 'joel', id: session.id });
  assert.match(String(resumed?.message), /no session you can open/);
  assert.equal(ctx.fleet.sessions().length, 0);
});

test('a shared session\'s databases are copied as it starts, and swept once it has ended; a private session\'s are its owner\'s', async () => {
  const done = [];
  const databases = {
    available: true, failCopy: false,
    async createForSession(id) {
      done.push(`copy ${id}`);
      if (this.failCopy) throw new Error('run-task failed: AccessDeniedException');
    },
    async sweep(active) { done.push(`sweep ${[...active].sort().join(',')}`); },
  };
  const { fleet, calls, alive } = setup({ databases });
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [shared] = fleet.sessions();
  assert.deepEqual(done, [`copy ${shared.id}`]);
  assert.equal(calls.started.length, 1, 'then the container');
  assert.equal(calls.started[0].env.PGPASSWORD, undefined, 'no database in its environment: it asks the session API');

  const mine = await fleet.startPrivate({ owner: 'joel', prompt: 'mine' });
  assert.deepEqual(done, [`copy ${shared.id}`], 'a private session uses its owner\'s');

  await fleet.tick();
  assert.equal(done.at(-1), `sweep ${[shared.id, mine.id].sort().join(',')}`);
  alive.delete(`c-${shared.id}`);
  await fleet.tick();
  assert.equal(shared.status, 'failed', 'its container died before statusd answered');
  await fleet.tick();
  assert.equal(done.at(-1), `sweep ${mine.id}`, 'an ended session is left out, so its databases go');

  databases.failCopy = true;
  await fleet.handleTrigger({ number: 43, login: 'joel', trigger: 'label', title: 'y', kind: 'issue' });
  const failed = fleet.sessions().find((s) => s.number === 43);
  assert.equal(failed.status, 'failed', 'a copy that cannot start fails the session');
  assert.equal(calls.started.length, 2, 'and no container is started for it');
});

async function sessionWithPull({ createdAt }) {
  const slack = { available: true, posts: [], async postPr(pr) { this.posts.push(pr); return true; } };
  const ctx = setup({ slack });
  await ctx.fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'Add GTM', kind: 'issue' });
  const [session] = ctx.fleet.sessions();
  ctx.github.pull = async (number) => ({ number, title: 'Add GTM to the agent', created_at: createdAt, state: 'open', head: { sha: 'abc' } });
  ctx.statuses[session.id] = { state: 'working' };
  await ctx.fleet.tick();
  return { ...ctx, slack, session };
}

test('a pull request a session opens waits for its review and suite, not posted yet', async () => {
  const { fleet, slack, statuses, session, store } = await sessionWithPull({ createdAt: '2026-10-21T10:05:00Z' });
  statuses[session.id] = { state: 'working', prUrl: 'https://github.com/o/r/pull/7' };
  await fleet.tick();
  assert.deepEqual(store.state.slackPending.map((p) => [p.number, p.sessionId]), [[7, session.id]]);
  assert.equal(fleet.sessions()[0].announcedPrUrl, 'https://github.com/o/r/pull/7');
  assert.deepEqual(slack.posts, []);
});

test('a pull request older than the session, from a resumed branch or a PR\'s own session, never waits', async () => {
  const { fleet, statuses, session, store } = await sessionWithPull({ createdAt: '2026-10-20T09:00:00Z' });
  statuses[session.id] = { state: 'working', prUrl: 'https://github.com/o/r/pull/7' };
  await fleet.tick();
  assert.deepEqual(store.state.slackPending ?? [], []);
  assert.equal(fleet.sessions()[0].announcedPrUrl, 'https://github.com/o/r/pull/7');
});

test('a pull request GitHub could not be read for is tried again on the next tick', async () => {
  const { fleet, github, statuses, session, store } = await sessionWithPull({ createdAt: '2026-10-21T10:05:00Z' });
  const pull = github.pull;
  github.pull = async () => { throw new Error('HTTP 502'); };
  statuses[session.id] = { state: 'working', prUrl: 'https://github.com/o/r/pull/7' };
  await fleet.tick();
  assert.equal(fleet.sessions()[0].announcedPrUrl, undefined);
  github.pull = pull;
  await fleet.tick();
  assert.equal(store.state.slackPending.length, 1);
});

test('a session that opens a new pull request after the first one has the new one tracked too', async () => {
  const { fleet, statuses, session, store } = await sessionWithPull({ createdAt: '2026-10-21T10:05:00Z' });
  statuses[session.id] = { state: 'working', prUrl: 'https://github.com/o/r/pull/7' };
  await fleet.tick();
  await fleet.tick();
  assert.deepEqual(store.state.slackPending.map((p) => p.number), [7], 'the same URL is tracked once');
  statuses[session.id] = { state: 'working', prUrl: 'https://github.com/o/r/pull/9' };
  await fleet.tick();
  assert.deepEqual(store.state.slackPending.map((p) => p.number), [7, 9]);
  assert.equal(fleet.sessions()[0].announcedPrUrl, 'https://github.com/o/r/pull/9');
});

test('a reported URL with anything after the number is never tracked', async () => {
  const { fleet, statuses, session, store } = await sessionWithPull({ createdAt: '2026-10-21T10:05:00Z' });
  statuses[session.id] = { state: 'working', prUrl: 'https://github.com/o/r/pull/7> <!channel' };
  await fleet.tick();
  assert.deepEqual(store.state.slackPending ?? [], []);
});

test('posting one pull request does not stop a session whose other pull request is still waiting', async () => {
  const { fleet, github, slack, statuses, session, advance } = await sessionWithPull({ createdAt: '2026-10-21T10:05:00Z' });
  const pull = github.pull;
  github.pull = async (number) => ({ ...(await pull(number)), html_url: `https://github.com/o/r/pull/${number}` });
  const approved = new Set();
  github.reviews = async (number) => (approved.has(number) ? approvedReview() : []);
  github.checkRuns = async () => e2eRuns();
  statuses[session.id] = { state: 'working', prUrl: 'https://github.com/o/r/pull/7' };
  await fleet.tick();
  statuses[session.id] = { state: 'working', prUrl: 'https://github.com/o/r/pull/9' };
  await fleet.tick();
  assert.deepEqual([...fleet.slackWaiting()], [session.id]);
  approved.add(7);
  advance(60_000);
  await fleet.tick();
  assert.deepEqual(slack.posts, [], 'held for the session to read the notes');
  advance(APPROVAL_GRACE_MS);
  await fleet.tick();
  assert.deepEqual(slack.posts.map((p) => p.url), ['https://github.com/o/r/pull/7']);
  assert.equal(session.status, 'running', 'pull request 9 is still waiting');
  approved.add(9);
  advance(60_000);
  await fleet.tick();
  advance(APPROVAL_GRACE_MS);
  await fleet.tick();
  assert.equal(slack.posts.length, 2);
  assert.deepEqual([session.status, session.stopReason], ['stopped', 'posted to Slack']);
});

test('a pull request that closes after another was posted does not stop the session', async () => {
  const { fleet, github, slack, statuses, session, advance } = await sessionWithPull({ createdAt: '2026-10-21T10:05:00Z' });
  const state = new Map([[7, 'open'], [9, 'open']]);
  const pull = github.pull;
  github.pull = async (number) => ({ ...(await pull(number)), state: state.get(number), html_url: `https://github.com/o/r/pull/${number}` });
  github.reviews = async (number) => (number === 7 ? approvedReview() : []);
  github.checkRuns = async () => e2eRuns();
  statuses[session.id] = { state: 'working', prUrl: 'https://github.com/o/r/pull/9' };
  await fleet.tick();
  statuses[session.id] = { state: 'working', prUrl: 'https://github.com/o/r/pull/7' };
  await fleet.tick();
  advance(60_000);
  await fleet.tick();
  advance(APPROVAL_GRACE_MS);
  await fleet.tick();
  assert.equal(slack.posts.length, 1, 'pull request 7 was posted');
  state.set(9, 'closed');
  advance(60_000);
  await fleet.tick();
  assert.deepEqual([...fleet.slackWaiting()], []);
  assert.equal(session.status, 'running', 'its next pull request may not be reported yet');
});

test('the assignee is tagged in the thread of the ready pull request\'s post, and gets no direct message', async () => {
  const dms = [];
  const pings = {
    needsYou: async (s) => { dms.push({ id: s.id, why: 'needs you' }); return true; },
    gaveUp: async (s) => { dms.push({ id: s.id, why: 'gave up' }); return true; },
    mentionFor: (s) => (s.assignee === 'joel' ? 'U0JOEL0001' : null),
  };
  const slack = { available: true, posts: [], async postPr(pr) { this.posts.push(pr); return true; } };
  const { fleet, github, statuses, store, advance } = setup({ slack, pings, assignables: ['joel'] });
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'Add GTM', kind: 'issue' });
  const [session] = store.state.sessions;
  github.pull = async (number) => ({ number, title: 'Add GTM', created_at: '2026-10-21T10:05:00Z', state: 'open', head: { sha: 'abc' }, html_url: `https://github.com/o/r/pull/${number}` });
  github.reviews = async () => approvedReview();
  github.checkRuns = async () => e2eRuns();
  statuses[session.id] = { state: 'done', prUrl: 'https://github.com/o/r/pull/7' };
  await fleet.tick();
  advance(APPROVAL_GRACE_MS);
  await fleet.tick();
  assert.equal(slack.posts.length, 1);
  assert.deepEqual(dms, [], 'the thread is enough: a direct message is kept for a decision the session is waiting on');
  assert.equal(slack.posts[0].mention, 'U0JOEL0001', 'the assignee is tagged in the thread');
});

test('a My Woodshed session\'s pull request is never tracked for Slack', async () => {
  const { fleet, statuses, session, store } = await sessionWithPull({ createdAt: '2026-10-21T10:05:00Z' });
  session.owner = 'joel';
  statuses[session.id] = { state: 'working', prUrl: 'https://github.com/o/r/pull/7' };
  await fleet.tick();
  assert.deepEqual(store.state.slackPending ?? [], []);
});

test('a stopped shared session is kept; posting its pull request to Slack stops it and it is finished', async () => {
  const { fleet, github, slack, statuses, session, store, advance } = await sessionWithPull({ createdAt: '2026-10-21T10:05:00Z' });
  github.reviews = async () => approvedReview();
  github.checkRuns = async () => e2eRuns();
  statuses[session.id] = { state: 'done', prUrl: 'https://github.com/o/r/pull/7' };
  await fleet.tick();
  assert.equal(slack.posts.length, 0, 'held on the tick it was tracked');
  advance(APPROVAL_GRACE_MS);
  await fleet.tick();
  assert.deepEqual([...fleet.slackWaiting()], []);
  assert.equal(slack.posts.length, 1);
  assert.deepEqual([session.status, session.stopReason, session.kept], ['stopped', 'posted to Slack', true]);
  assert.ok(session.slackPostedAt);
  advance(60_000);
  await fleet.tick();
  assert.deepEqual(store.state.slackPending, []);
});

test('review feedback is typed into a running session, and resumes a stopped one', async () => {
  const { fleet, github, statuses, session, calls, advance } = await sessionWithPull({ createdAt: '2026-10-21T10:05:00Z' });
  github.reviews = async () => [{
    id: 1, user: { login: 'review-bot[bot]' }, state: 'CHANGES_REQUESTED', body: '## Code review', commit_id: 'abc', html_url: 'https://github.com/o/r/pull/7#r1',
  }];
  github.checkRuns = async () => [];
  github.pullFiles = async () => ['web/app/page.tsx'];
  statuses[session.id] = { state: 'done', prUrl: 'https://github.com/o/r/pull/7' };
  await fleet.tick();
  const sent = calls.statusd.filter((c) => c.path === '/send');
  assert.equal(sent.length, 1);
  assert.match(sent[0].body.text, /asks for changes/);

  await fleet.stop(session, 'idle for 1 h');
  github.checkRuns = async () => e2eRuns((n) => (n === 2 ? 'failure' : 'success'));
  advance(60_000);
  await fleet.tick();
  assert.equal(session.status, 'starting', 'resumed by the failed suite');
  assert.equal(session.resumedBy, 'woodshed');
  assert.match(session.pendingMessages.at(-1), /e2e run \(2\/4\) u2/);
  assert.equal(fleet.sessions().length, 1);
});

test('a kept session goes 3 days after its pull request closes, or 7 days after it stopped with none', async () => {
  const done = [];
  const databases = { available: true, async createForSession(id) { done.push(`copy ${id}`); }, async sweep(keep) { done.push(`sweep ${[...keep].sort().join(',')}`); } };
  const removedHomes = [];
  const ctx = setup({ databases, homes: { async remove(name) { removedHomes.push(name); } } });
  const fleet = ctx.fleet;
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  await fleet.handleTrigger({ number: 43, login: 'joel', trigger: 'label', title: 'y', kind: 'issue' });
  const [withPr, without] = fleet.sessions();
  ctx.statuses[withPr.id] = { state: 'done', prUrl: 'https://github.com/o/r/pull/7' };
  ctx.statuses[without.id] = { state: 'done' };
  await fleet.tick();
  await fleet.stop(withPr, 'test');
  await fleet.stop(without, 'test');
  await fleet.tick();
  assert.equal(done.at(-1), `sweep ${[withPr.id, without.id].sort().join(',')}`, 'both keep their databases');
  assert.equal(without.deletesAt, '2026-10-28T10:00:00.000Z');

  ctx.github.pull = async () => ({ state: 'closed', merged_at: '2026-10-21T11:00:00Z', closed_at: '2026-10-21T11:00:00Z', head: { ref: 'b' } });
  ctx.advance(15 * 60_000);
  await fleet.tick();
  assert.deepEqual([withPr.prMerged, withPr.deletesAt], [true, '2026-10-24T11:00:00.000Z']);

  ctx.advance(3 * 24 * HOUR + HOUR);
  await fleet.tick();
  assert.deepEqual([withPr.kept, Boolean(withPr.cleanedAt)], [false, true]);
  assert.equal(done.at(-1), `sweep ${without.id}`, 'its databases go');
  assert.equal(without.kept, true);
  ctx.advance(4 * 24 * HOUR);
  await fleet.tick();
  assert.equal(without.kept, false);
  assert.equal(done.at(-1), 'sweep ');
  assert.deepEqual(removedHomes, [`_sessions/${withPr.id}`, `_sessions/${without.id}`], 'each one\'s Claude home goes with it');
});

test('a kept session whose pull request stays open goes after the open-PR days, counted again from its last stop', async () => {
  const done = [];
  const databases = { available: true, async createForSession() {}, async sweep(keep) { done.push([...keep].sort().join(',')); } };
  const retention = { afterCloseMs: 3 * 24 * HOUR, withoutPrMs: 7 * 24 * HOUR, openPrMs: 2 * 24 * HOUR, slackGiveUpMs: 7 * 24 * HOUR };
  const ctx = setup({ databases, retention });
  await ctx.fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = ctx.fleet.sessions();
  ctx.github.pull = async () => ({ state: 'open', head: { ref: 'b' } });
  ctx.statuses[session.id] = { state: 'done', prUrl: 'https://github.com/o/r/pull/7' };
  await ctx.fleet.tick();
  await ctx.fleet.stop(session, 'test');
  await ctx.fleet.tick();
  assert.equal(session.deletesAt, '2026-10-23T10:00:00.000Z', 'two days, the open-PR number, from the stop');
  ctx.advance(24 * HOUR);
  await ctx.fleet.resumeShared(session, { by: 'joel', why: 'console' });
  await ctx.fleet.tick();
  await ctx.fleet.stop(session, 'test');
  await ctx.fleet.tick();
  assert.equal(session.deletesAt, '2026-10-24T10:00:00.000Z', 'a resume starts the count again');
  retention.openPrMs = 24 * HOUR;
  await ctx.fleet.tick();
  assert.equal(session.deletesAt, '2026-10-23T10:00:00.000Z', 'a changed setting applies to sessions already kept');
  ctx.advance(24 * HOUR + 60_000);
  await ctx.fleet.tick();
  assert.equal(session.kept, false);
});

test('a deleted shared session leaves the list after the setting\'s days, counted from its delete', async () => {
  const retention = { afterCloseMs: 3 * 24 * HOUR, withoutPrMs: 7 * 24 * HOUR, openPrMs: 14 * 24 * HOUR, slackGiveUpMs: 7 * 24 * HOUR, removeAfterDeleteMs: 2 * 24 * HOUR };
  const ctx = setup({ retention });
  await ctx.fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  await ctx.fleet.handleTrigger({ number: 43, login: 'joel', trigger: 'label', title: 'y', kind: 'issue' });
  const [deleted, kept] = ctx.fleet.sessions();
  ctx.statuses[deleted.id] = { state: 'done' };
  ctx.statuses[kept.id] = { state: 'done' };
  await ctx.fleet.tick();
  await ctx.fleet.stop(kept, 'test');
  ctx.advance(24 * HOUR);
  await ctx.fleet.deleteShared(deleted, 'joel');
  ctx.advance(2 * 24 * HOUR - 60_000);
  await ctx.fleet.tick();
  assert.ok(ctx.fleet.sessions().includes(deleted), 'still listed, as Deleted, before its days are up');
  ctx.advance(2 * 60_000);
  await ctx.fleet.tick();
  assert.deepEqual(ctx.fleet.sessions().map((s) => s.id), [kept.id], 'the deleted one goes; a kept one stays');
});

test('Remove takes a deleted shared session off the list, and refuses one that still keeps its data', async () => {
  const ctx = setup();
  await ctx.fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = ctx.fleet.sessions();
  ctx.statuses[session.id] = { state: 'done' };
  await ctx.fleet.tick();
  assert.throws(() => ctx.fleet.removeShared(session, 'joel'), /delete it first/, 'a running one');
  await ctx.fleet.stop(session, 'test');
  assert.throws(() => ctx.fleet.removeShared(session, 'joel'), /delete it first/, 'a kept one');
  const mine = await ctx.fleet.startPrivate({ owner: 'joel', prompt: 'mine' });
  assert.throws(() => ctx.fleet.removeShared(mine, 'joel'), /removed from My Woodshed/);
  await ctx.fleet.deleteShared(session, 'joel');
  ctx.fleet.removeShared(session, 'joel');
  assert.deepEqual(ctx.fleet.sessions().map((s) => s.id), [mine.id]);
});

test('a deleted session whose Claude home is still being deleted stays listed until it goes', async () => {
  let failing = true;
  const homes = { async remove() { if (failing) throw new Error('aws s3api delete-object failed: SlowDown'); } };
  const retention = { afterCloseMs: 3 * 24 * HOUR, withoutPrMs: 7 * 24 * HOUR, openPrMs: 14 * 24 * HOUR, slackGiveUpMs: 7 * 24 * HOUR, removeAfterDeleteMs: 0 };
  const ctx = setup({ homes, retention });
  await ctx.fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = ctx.fleet.sessions();
  ctx.statuses[session.id] = { state: 'done' };
  await ctx.fleet.tick();
  await ctx.fleet.stop(session, 'test');
  await ctx.fleet.deleteShared(session, 'joel');
  assert.throws(() => ctx.fleet.removeShared(session, 'joel'), /still being deleted/);
  await ctx.fleet.tick();
  assert.ok(ctx.fleet.sessions().includes(session), 'kept on the list, so its home delete is tried again');
  failing = false;
  ctx.advance(10 * 60_000 + 1);
  await ctx.fleet.tick();
  assert.deepEqual(ctx.fleet.sessions(), []);
});

test('a Claude home whose delete fails is tried again ten minutes later, until it goes', async () => {
  let failing = true;
  const removed = [];
  const homes = { async remove(name) { if (failing) throw new Error('aws s3api delete-object failed: SlowDown'); removed.push(name); } };
  const ctx = setup({ homes });
  await ctx.fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = ctx.fleet.sessions();
  ctx.statuses[session.id] = { state: 'done' };
  await ctx.fleet.tick();
  await ctx.fleet.stop(session, 'test');
  await ctx.fleet.deleteShared(session, 'joel');
  assert.equal(session.homeDeletePending, true);
  failing = false;
  await ctx.fleet.tick();
  assert.deepEqual(removed, [], 'not again on the next tick');
  ctx.advance(10 * 60_000);
  await ctx.fleet.tick();
  assert.deepEqual(removed, [`_sessions/${session.id}`]);
  assert.equal(session.homeDeletePending, false);
});

test('the shared slots leave My Woodshed out: a private session starts at once, and takes no shared slot', async () => {
  const ctx = setup({ maxRunning: 1 });
  await ctx.fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const mine = await ctx.fleet.startPrivate({ owner: 'joel', prompt: 'mine' });
  assert.equal(mine.status, 'starting', 'not queued behind the full shared slot');
  await ctx.fleet.handleTrigger({ number: 43, login: 'joel', trigger: 'label', title: 'y', kind: 'issue' });
  const [first, , second] = ctx.fleet.sessions();
  assert.deepEqual([first.status, second.status], ['starting', 'queued']);
});

test('a start AWS has no room for waits in the queue, says why, and is tried again a minute later', async () => {
  const ctx = setup();
  ctx.fail.start = 'aws ecs run-task failed: You\'ve reached the limit on the number of vCPUs you can run concurrently';
  await ctx.fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = ctx.fleet.sessions();
  assert.equal(session.status, 'queued', 'not failed: a label would otherwise have to be added again');
  assert.match(session.error, /^AWS has no room for another session: the account's Fargate vCPU quota/);
  assert.match(session.error, /limit on the number of vCPUs/);

  ctx.fail.start = false;
  ctx.advance(30_000);
  await ctx.fleet.tick();
  assert.equal(session.status, 'queued', 'not tried again on every tick');
  ctx.advance(31_000);
  await ctx.fleet.tick();
  assert.equal(session.status, 'starting');
  assert.equal(session.retryAt, null);
});

test('a session waiting to be tried again holds no slot from the sessions behind it', async () => {
  const ctx = setup();
  ctx.fail.start = 'aws ecs run-task failed: RESOURCE:CPU';
  await ctx.fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  ctx.fail.start = false;
  await ctx.fleet.handleTrigger({ number: 43, login: 'joel', trigger: 'label', title: 'y', kind: 'issue' });
  const [waiting, next] = ctx.fleet.sessions();
  assert.deepEqual([waiting.status, next.status], ['queued', 'starting']);
});

test('a session stuck stopping is stopped from the settings page, keeping what it has', async () => {
  const ctx = setup();
  await ctx.fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = ctx.fleet.sessions();
  ctx.statuses[session.id] = { state: 'working' };
  await ctx.fleet.tick();
  await assert.rejects(ctx.fleet.forceStop(session, 'joel'), /only a session stuck starting or stopping/);
  Object.assign(session, { status: 'stopping', stoppingAt: '2026-10-21T09:00:00.000Z', stopReason: 'idle for 1 h' });
  await ctx.fleet.forceStop(session, 'joel');
  assert.deepEqual([session.status, session.kept, session.stopReason], ['stopped', true, 'idle for 1 h']);
  assert.deepEqual(ctx.calls.stopped.at(-1), `c-${session.id}`);
});

test('Delete now on a queued shared session takes it out of the line without an error', async () => {
  const { fleet } = setup({ maxRunning: 1 });
  await fleet.handleTrigger({ number: 1, login: 'joel', trigger: 'label', title: 'one', kind: 'issue' });
  await fleet.handleTrigger({ number: 2, login: 'joel', trigger: 'label', title: 'two', kind: 'issue' });
  const [, waiting] = fleet.sessions();
  assert.equal(waiting.status, 'queued');
  await fleet.deleteShared(waiting, 'joel');
  assert.equal(waiting.status, 'stopped');
});

test('Resume and Delete now refuse what they cannot do', async () => {
  const { fleet } = setup();
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = fleet.sessions();
  await assert.rejects(fleet.resumeShared(session, { by: 'joel', why: 'console' }), /still running/);
  const mine = await fleet.startPrivate({ owner: 'joel', prompt: 'mine' });
  await fleet.stop(mine, 'test');
  assert.equal(mine.kept, undefined, 'a private session keeps nothing of its own');
  await assert.rejects(fleet.resumeShared(mine, { by: 'joel', why: 'console' }), /resumed from My Woodshed/);
  await fleet.deleteShared(session, 'joel');
  assert.equal(session.status, 'stopped', 'a running session is stopped, then deleted');
  await assert.rejects(fleet.deleteShared(session, 'joel'), /already deleted/);
  await assert.rejects(fleet.resumeShared(session, { by: 'joel', why: 'console' }), /deleted: comment \/woodshed on #42/);
});

test('a person may have as many My Woodshed sessions as the setting says, and they take no shared slot', async () => {
  const { fleet } = setup({ maxRunning: 1, maxPrivatePerPerson: 2 });
  await fleet.startPrivate({ owner: 'joel', prompt: 'one' });
  await fleet.startPrivate({ owner: 'joel', prompt: 'two' });
  const third = await fleet.startPrivate({ owner: 'joel', prompt: 'three' });
  const fourth = await fleet.startPrivate({ owner: 'joel', prompt: 'four' });
  assert.equal(third.status, 'queued', 'at the limit a session waits in line instead of being refused');
  assert.equal(fourth.status, 'queued');
  const hers = await fleet.startPrivate({ owner: 'mia', prompt: 'hers' });
  assert.equal(hers.status, 'starting', 'each person has a line of their own');
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  assert.equal(fleet.sessions().find((s) => s.number === 42).status, 'starting', 'the one shared slot is still free');
  const first = fleet.sessions().find((s) => s.prompt === 'one');
  await fleet.stop(first, 'test');
  assert.equal(third.status, 'starting', 'the oldest in line starts once one of his tasks has stopped');
  assert.equal(fourth.status, 'queued');
  await fleet.stop(fourth, 'test');
  assert.equal(fourth.status, 'stopped', 'taken out of the line, it never had a task');
  const resumed = await fleet.resumePrivate({ owner: 'joel', id: fourth.id });
  assert.equal(resumed.status, 'queued', 'Resume puts it back in line while he is still at the limit');
});

// The console makes shared sessions' databases, which is how the entrypoint asks for the token.
const madeDatabases = () => ({ available: true, async createForSession() {}, async sweep() {} });

function ownTokens({ on = ['joel'], tokens = { joel: 'sk-ant-oat01-joel' }, unreadable = [] } = {}) {
  return {
    usesOwnTokenForShared: (login) => on.includes(login),
    async claudeToken(login) {
      if (unreadable.includes(login)) throw new Error('AccessDeniedException');
      return tokens[login] ?? null;
    },
  };
}

test('a shared session runs on its starter\'s plan when their switch is on and a token is saved, and says so on the issue', async () => {
  const ctx = setup({ userSettings: ownTokens(), databases: madeDatabases() });
  await ctx.fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = ctx.fleet.sessions();
  assert.equal(session.plan, 'joel');
  assert.equal(JSON.stringify(ctx.store.state).includes('sk-ant'), false, 'the token itself is never kept');
  assert.equal(JSON.stringify(ctx.calls.started[0].env).includes('sk-ant'), false, 'nor in the task\'s environment');
  assert.match(ctx.calls.comments[0].body, /on @joel's own Claude plan\.$/m);
});

test('the switch off, no token or one that cannot be read: the team key', async () => {
  for (const userSettings of [ownTokens({ on: [] }), ownTokens({ tokens: {} }), ownTokens({ unreadable: ['joel'] }), null]) {
    const ctx = setup({ userSettings, databases: madeDatabases() });
    await ctx.fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
    const [session] = ctx.fleet.sessions();
    assert.equal(session.plan, null);
    assert.doesNotMatch(ctx.calls.comments[0].body, /Claude plan/);
  }
});

test('a resume by someone else runs on the starter\'s plan, decided again at that launch', async () => {
  const userSettings = ownTokens({ on: ['joel'] });
  const ctx = setup({ userSettings, databases: madeDatabases() });
  await ctx.fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = ctx.fleet.sessions();
  ctx.statuses[session.id] = { state: 'working' };
  await ctx.fleet.tick();
  await ctx.fleet.stop(session, 'stopped from the console');
  await ctx.fleet.resumeShared(session, { text: 'carry on', by: 'mia', why: 'comment' });
  assert.equal(session.plan, 'joel');
  await ctx.fleet.stop(session, 'stopped from the console');
  userSettings.usesOwnTokenForShared = () => false;
  await ctx.fleet.resumeShared(session, { by: 'joel', why: 'console' });
  assert.equal(session.plan, null, 'switched off since: the team key from this launch');
});

test('a session started from the console\'s API never runs on a personal plan, whoever it names', async () => {
  const ctx = setup({ userSettings: ownTokens({ on: ['joel'] }), databases: madeDatabases() });
  const session = await ctx.fleet.startManual({ number: 42, startedBy: 'joel' });
  assert.equal(session.plan, null, 'GitHub did not vouch for this starter');
});

test('a console that makes no shared databases runs every shared session on the team key, switch or not', async () => {
  const ctx = setup({ userSettings: ownTokens() });
  await ctx.fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  assert.equal(ctx.fleet.sessions()[0].plan, null, 'its entrypoint never asks the session API, so the token would never arrive');
  assert.doesNotMatch(ctx.calls.comments[0].body, /Claude plan/);
});

test('a My Woodshed session is untouched: it runs on its owner\'s token as before, and has no plan', async () => {
  const ctx = setup({ userSettings: ownTokens() });
  const mine = await ctx.fleet.startPrivate({ owner: 'joel', prompt: 'mine' });
  assert.equal(mine.plan, undefined);
});

test('someone who can be assigned and tags a ticket has the session; someone else leaves it unassigned', async () => {
  const { fleet, store } = setup({ writers: ['joel', 'priya'], assignables: ['joel'] });
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  await fleet.handleTrigger({ number: 43, login: 'priya', trigger: 'comment', text: 'look', commentId: 5, title: 'y', kind: 'issue' });
  const [mine, hers] = store.state.sessions;
  assert.deepEqual([mine.assignee, mine.assignedBy, mine.assignedHow], ['joel', 'joel', 'label']);
  assert.equal(hers.assignee ?? null, null, 'a starter who cannot be assigned is not assigned');
});

test('a later comment does not move an assigned session, but someone who can be assigned takes an unassigned one', async () => {
  const { fleet, store } = setup({ writers: ['joel', 'ana', 'priya'], assignables: ['joel', 'ana'] });
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  await fleet.handleTrigger({ number: 42, login: 'ana', trigger: 'comment', text: 'also this', commentId: 6 });
  assert.equal(store.state.sessions[0].assignee, 'joel', 'someone else commenting leaves it with joel');
  await fleet.handleTrigger({ number: 43, login: 'priya', trigger: 'label', title: 'z', kind: 'issue' });
  assert.equal(store.state.sessions[1].assignee ?? null, null);
  await fleet.handleTrigger({ number: 43, login: 'ana', trigger: 'comment', text: 'on it', commentId: 7 });
  assert.deepEqual([store.state.sessions[1].assignee, store.state.sessions[1].assignedHow], ['ana', 'comment']);
});

test('assign: someone who can be assigned takes, hands over and unassigns; nobody else can, and not to someone who cannot', async () => {
  const { fleet, store } = setup({ writers: ['joel', 'ana', 'priya'], assignables: ['joel', 'ana'] });
  await fleet.handleTrigger({ number: 43, login: 'priya', trigger: 'label', title: 'z', kind: 'issue' });
  const id = store.state.sessions[0].id;
  assert.throws(() => fleet.assign({ id, by: 'priya', to: 'priya' }), /only someone who can be assigned/);
  assert.throws(() => fleet.assign({ id, by: 'joel', to: 'priya' }), /cannot be assigned/);
  assert.equal(fleet.assign({ id, by: 'joel', to: 'joel' }).assignedHow, 'take it');
  assert.equal(fleet.assign({ id, by: 'joel', to: 'ANA' }).assignee, 'ana', 'handles match whatever their case');
  assert.equal(store.state.sessions[0].assignedHow, 'hand over');
  const freed = fleet.assign({ id, by: 'joel', to: null });
  assert.deepEqual([freed.assignee, freed.assignedHow, freed.assignedBy], [null, 'unassign', 'joel']);
  assert.throws(() => fleet.assign({ id: 'nosuchid', by: 'joel', to: 'joel' }), /no shared session/);
});

test('a private session and a question from Slack cannot be assigned', async () => {
  const { fleet, store } = setup({ assignables: ['joel'] });
  store.state.sessions.push({ id: 'aaaa1111', owner: 'joel', kind: 'task' }, { id: 'bbbb2222', owner: null, kind: 'ask' });
  assert.throws(() => fleet.assign({ id: 'aaaa1111', by: 'joel', to: 'joel' }), /no shared session/);
  assert.throws(() => fleet.assign({ id: 'bbbb2222', by: 'joel', to: 'joel' }), /nobody to assign/);
});

test('assigning is case-blind, the members list spells the assignee, and sessions go back when someone can no longer be assigned', async () => {
  const { fleet, store } = setup({ writers: ['Octocat', 'ana'], assignables: ['octocat', 'ana'] });
  await fleet.handleTrigger({ number: 42, login: 'Octocat', trigger: 'label', title: 'x', kind: 'issue' });
  const session = store.state.sessions[0];
  assert.equal(session.assignee, 'octocat', 'GitHub spelled it Octocat; the list spells it octocat');
  assert.equal(fleet.assign({ id: session.id, by: 'Octocat', to: 'octocat' }).assignedHow, 'label', 'assigning it to its own assignee changes nothing');
  fleet.assign({ id: session.id, by: 'ana', to: 'ana' });
  assert.equal(fleet.releaseAssignments({ login: 'ANA', by: 'octocat' }), 1);
  assert.deepEqual([session.assignee, session.assignedHow, session.assignedBy], [null, 'unassign', 'octocat']);
  assert.equal(fleet.releaseAssignments({ login: 'ana', by: 'octocat' }), 0, 'nothing left to release');
});

// The issue's assignee follows the session's in the background; the fakes answer at once, so one turn settles it.
const settle = () => new Promise((resolve) => setImmediate(resolve));
const ACME_CARD = {
  id: 'item1', status: { name: 'Priority' },
  project: { id: 'proj1', title: 'Acme', field: { id: 'status1', options: [{ id: 'o1', name: 'Priority' }, { id: 'o2', name: 'In progress' }] } },
};

test('a session started on an issue moves its card to In progress and puts its assignee on the issue', async () => {
  const { fleet, github, calls } = setup({ writers: ['joel', 'priya'], assignables: ['joel'] });
  github.projectItems = { 42: [ACME_CARD], 43: [ACME_CARD] };
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  await fleet.handleTrigger({ number: 43, login: 'priya', trigger: 'label', title: 'y', kind: 'issue' });
  assert.deepEqual(calls.statusMoves.map((m) => [m.itemId, m.optionId]), [['item1', 'o2'], ['item1', 'o2']], 'both issues move, whoever started them');
  assert.deepEqual(calls.assignees, [{ number: 42, add: ['joel'] }], 'only the assignee is put on an issue');
});

test('a pull request\'s session leaves project cards and assignees alone', async () => {
  const { fleet, calls } = setup({ assignables: ['joel'] });
  await fleet.handleTrigger({ number: 7, login: 'joel', trigger: 'comment', text: 'fix it', commentId: 3, title: 'pr', kind: 'pr' });
  assert.deepEqual([calls.statusMoves, calls.assignees], [[], []]);
});

test('take it, hand over and unassign follow onto the issue; someone GitHub had already stays', async () => {
  const { fleet, store, calls, github } = setup({ writers: ['joel', 'ana', 'priya'], assignables: ['joel', 'ana'] });
  await fleet.handleTrigger({ number: 43, login: 'priya', trigger: 'label', title: 'z', kind: 'issue' });
  const session = store.state.sessions[0];
  fleet.assign({ id: session.id, by: 'joel', to: 'joel' });
  await settle();
  fleet.assign({ id: session.id, by: 'joel', to: 'ana' });
  await settle();
  fleet.assign({ id: session.id, by: 'ana', to: null });
  await settle();
  assert.deepEqual(calls.assignees, [
    { number: 43, add: ['joel'] }, { number: 43, remove: ['joel'] }, { number: 43, add: ['ana'] }, { number: 43, remove: ['ana'] },
  ]);
  calls.assignees.length = 0;
  github.issue = async () => ({ title: 'z', assignees: [{ login: 'Joel' }] });
  fleet.assign({ id: session.id, by: 'joel', to: 'joel' });
  await settle();
  fleet.assign({ id: session.id, by: 'joel', to: null });
  await settle();
  assert.deepEqual(calls.assignees, [], 'joel was on the issue already, so unassigning in the console leaves him there');
});

test('a GitHub refusal to assign is logged and the session keeps its assignee', async () => {
  const { fleet, store, github } = setup({ writers: ['priya'], assignables: ['joel'] });
  github.addAssignees = async () => { throw new Error('HTTP 403: Resource not accessible by integration'); };
  github.issueProjectItems = async () => { throw new Error('HTTP 403: Resource not accessible by integration'); };
  await fleet.handleTrigger({ number: 43, login: 'priya', trigger: 'label', title: 'z', kind: 'issue' });
  const session = store.state.sessions[0];
  assert.equal(session.status, 'starting', 'the start goes on without the project board');
  fleet.assign({ id: session.id, by: 'joel', to: 'joel' });
  await settle();
  assert.deepEqual([session.assignee, session.githubAssignee ?? null], ['joel', null]);
});

test('a resume keeps who has the session: an assigned one stays with them, an unassigned one stays unassigned', async () => {
  const { fleet, statuses, store } = setup({ writers: ['joel', 'ana', 'priya'], assignables: ['joel', 'ana'] });
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  await fleet.handleTrigger({ number: 43, login: 'priya', trigger: 'label', title: 'y', kind: 'issue' });
  for (const s of store.state.sessions) {
    statuses[s.id] = { state: 'done', claudeSession: '0b6e9c7a-1d2f-4e5a-9b8c-7d6e5f4a3b2c' };
  }
  await fleet.tick();
  const [assigned, unassigned] = store.state.sessions;
  await fleet.stop(assigned, 'test');
  await fleet.stop(unassigned, 'test');
  assert.deepEqual(await fleet.handleTrigger({ number: 42, login: 'ana', trigger: 'comment', text: 'carry on', commentId: 90 }), { outcome: 'resumed', sessionId: assigned.id });
  assert.deepEqual(await fleet.handleTrigger({ number: 43, login: 'ana', trigger: 'comment', text: 'carry on', commentId: 91 }), { outcome: 'resumed', sessionId: unassigned.id });
  assert.equal(assigned.assignee, 'joel', 'someone else resuming does not take it');
  assert.equal(unassigned.assignee ?? null, null, 'resuming does not take an unassigned session either');
});

test('an assigned session that starts to ask is told about once, each time it starts asking', async () => {
  const told = [];
  const pings = { needsYou: async (s) => { told.push(s.id); return true; }, gaveUp: async () => true };
  const { fleet, statuses, store } = setup({ assignables: ['joel'], pings });
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = store.state.sessions;
  statuses[session.id] = { state: 'working' };
  await fleet.tick();
  assert.deepEqual(told, [], 'working is nobody\'s business');
  statuses[session.id] = { state: 'needs-you' };
  await fleet.tick();
  await fleet.tick();
  assert.deepEqual(told, [session.id], 'still asking on the next read is not a second message');
  statuses[session.id] = { state: 'working' };
  await fleet.tick();
  statuses[session.id] = { state: 'needs-you' };
  await fleet.tick();
  assert.deepEqual(told, [session.id, session.id], 'a new question is');
});

test('a session\'s Needs a human comment messages its assignee once, and the console\'s own gave-up comment does not', async () => {
  const told = [];
  const pings = { needsYou: async () => true, gaveUp: async () => true, needsHuman: async (s, c) => { told.push({ id: s.id, ...c }); return true; } };
  const { fleet, store, github } = setup({ assignables: ['joel'], pings });
  github.pullComments = async () => [];
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'Add GTM', kind: 'issue' });
  const [session] = store.state.sessions;
  store.state.github ??= { seenComments: [] };
  store.state.github.seenComments ??= [];

  const url = 'https://github.com/o/r/issues/42#issuecomment-501';
  const result = await fleet.handleNeedsHuman({ number: 42, commentId: 501, url, body: 'Needs a human: @joel the fix could not be shown here.' });
  assert.deepEqual(result, { outcome: 'sent', sessionId: session.id });
  assert.deepEqual(told, [{ id: session.id, number: 42, url }]);
  assert.equal((await fleet.handleNeedsHuman({ number: 42, commentId: 501, url, body: 'Needs a human: x' })).outcome, 'duplicate');

  const own = await fleet.handleNeedsHuman({
    number: 42, commentId: 502, url, body: 'Needs a human: @joel this pull request did not pass its review and checks in time, so…',
  });
  assert.equal(own.outcome, 'ignored');
  assert.equal((await fleet.handleNeedsHuman({ number: 999, commentId: 503, url, body: 'Needs a human: x' })).outcome, 'ignored', 'no session on it');
  assert.equal(told.length, 1);
});

test('a webhook about a kept session\'s pull request has it read at the next tick, not 15 minutes later', async () => {
  const ctx = setup();
  await ctx.fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = ctx.fleet.sessions();
  let reads = 0;
  let state = 'open';
  ctx.github.pull = async () => { reads++; return { state, closed_at: '2026-10-21T10:05:00Z', merged_at: '2026-10-21T10:05:00Z', head: { ref: 'b' } }; };
  ctx.statuses[session.id] = { state: 'done', prUrl: 'https://github.com/o/r/pull/7' };
  await ctx.fleet.tick();
  await ctx.fleet.stop(session, 'test');
  await ctx.fleet.tick();
  const afterStop = reads;
  state = 'closed';
  await ctx.fleet.tick();
  assert.equal(reads, afterStop, 'not read again within 15 minutes on its own');
  assert.deepEqual(ctx.fleet.pullsChanged([7, 8]), [7]);
  await ctx.fleet.tick();
  assert.equal(session.prMerged, true);
  assert.equal(session.prClosedAt, '2026-10-21T10:05:00.000Z');
  assert.deepEqual(ctx.fleet.pullsChanged([7]), [], 'a closed one is not read again');
});

test('a private session pauses on its owner\'s own idle hours, and a shared one keeps the console\'s', async () => {
  const userSettings = { ...ownTokens(), limitsFor: (login) => (login === 'joel' ? { idleMs: 30 * 60_000 } : {}) };
  const { fleet, statuses, advance } = setup({ userSettings });
  const mine = await fleet.startPrivate({ owner: 'joel', prompt: 'mine' });
  const hers = await fleet.startPrivate({ owner: 'mia', prompt: 'hers' });
  statuses[mine.id] = { state: 'done' };
  statuses[hers.id] = { state: 'done' };
  await fleet.tick();
  advance(40 * 60_000);
  await fleet.tick();
  assert.equal(mine.status, 'stopped');
  assert.equal(mine.stopReason, 'idle for 30 min');
  assert.equal(hers.status, 'running', 'no override: the console\'s 2 hours');
});

test('a private session on another project records it, clones its repo, and reads Work on from that repo', async () => {
  const projects = [{ name: 'r', repo: 'o/r', default: true }, { name: 'tools', repo: 'o/tools', default: false }];
  const asked = [];
  const tools = {
    async defaultBranch() { return 'main'; },
    async issue(number) { asked.push(number); return { title: `Tools ${number}`, pull_request: {} }; },
    async pull() { return { head: { ref: 'tools/branch' } }; },
  };
  const { fleet, calls } = setup({ projects, githubFor: (project) => (project.name === 'tools' ? tools : null) });
  const onTools = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it', workOn: '#5', project: projects[1] });
  assert.deepEqual([onTools.project, onTools.repo, onTools.kind, onTools.branch, onTools.title], ['tools', 'o/tools', 'pr', 'tools/branch', 'Tools 5']);
  assert.deepEqual(asked, [5], 'the PR is looked up in the project\'s repo');
  assert.equal(calls.started[0].env.PROJECT_REPO, 'o/tools');
  const onDefault = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it' });
  assert.deepEqual([onDefault.project, onDefault.repo], ['r', 'o/r']);
  assert.equal(calls.started[1].env.PROJECT_REPO, undefined, 'the image\'s own repo: nothing to clone');
});

// Another project's issues and pull requests are its repo's: its #12 is not the default project's #12.
function twoProjects({ toolWriters = ['joel'], links = { r: true, tools: false }, ...options } = {}) {
  const projects = [{ name: 'r', repo: 'o/r', default: true }, { name: 'tools', repo: 'o/tools', default: false }];
  const toolCalls = { comments: [], reactions: [], canWrite: [], issues: [], pulls: [] };
  const tools = {
    async canWrite(login) { toolCalls.canWrite.push(login); return toolWriters.includes(login); },
    async issue(number) { toolCalls.issues.push(number); return { title: `Tools ${number}` }; },
    async pull(number) { toolCalls.pulls.push(number); return { head: { ref: 'tools/pr' }, state: 'open' }; },
    async comment(number, body) { toolCalls.comments.push({ number, body }); return 7000 + toolCalls.comments.length; },
    async reactToIssue(number) { toolCalls.reactions.push({ issue: number }); },
    async reactToComment(id) { toolCalls.reactions.push({ comment: id }); },
    async removeLabel() { return true; },
    async issueProjectItems() { return []; },
  };
  const ctx = setup({ ...options, projects, githubFor: (project) => (project.name === 'tools' ? tools : null), consoleLinks: async (name) => links[name] });
  return { ...ctx, projects, tools, toolCalls };
}

test('a label or /woodshed comment on another project\'s issue starts a session on that project, on its repo', async () => {
  const { fleet, calls, toolCalls } = twoProjects();
  const started = await fleet.handleTrigger({ number: 12, login: 'joel', trigger: 'label', title: '', kind: 'issue', project: 'tools' });
  assert.equal(started.outcome, 'started');
  const session = fleet.find(started.sessionId);
  assert.deepEqual([session.project, session.repo, session.number, session.title], ['tools', 'o/tools', 12, 'Tools 12']);
  assert.equal(calls.started[0].env.PROJECT_REPO, 'o/tools', 'the session clones the project\'s repo');
  assert.deepEqual(toolCalls.canWrite, ['joel'], 'write access is checked on the project\'s repo');
  assert.deepEqual(toolCalls.issues, [12]);
  assert.deepEqual(toolCalls.reactions, [{ issue: 12 }]);
  assert.equal(toolCalls.comments.length, 1, 'the start comment goes on the project\'s issue');
  assert.deepEqual([calls.comments, calls.reactions], [[], []], 'nothing on the default repo\'s #12');
});

test('another project\'s #12 and the default project\'s #12 are different issues', async () => {
  const { fleet, calls, toolCalls } = twoProjects();
  const onDefault = await fleet.handleTrigger({ number: 12, login: 'joel', trigger: 'label', title: 'Default 12', kind: 'issue' });
  const onTools = await fleet.handleTrigger({ number: 12, login: 'joel', trigger: 'label', title: 'Tools 12', kind: 'issue', project: 'tools' });
  assert.equal(onTools.outcome, 'started', 'a session on the default #12 does not stop one on the project\'s #12');
  assert.notEqual(onTools.sessionId, onDefault.sessionId);
  // A comment on the project's #12 goes to its session, not the default project's.
  const sent = await fleet.handleTrigger({ number: 12, login: 'joel', trigger: 'comment', text: 'and this', commentId: 501, project: 'tools' });
  assert.deepEqual([sent.outcome, sent.sessionId], ['sent', onTools.sessionId]);
  assert.deepEqual(toolCalls.reactions.at(-1), { comment: 501 });
  assert.equal(calls.reactions.filter((r) => r.comment === 501).length, 0);
});

test('a project the console no longer has, or a writer of the default repo only, starts nothing on another project', async () => {
  const { fleet, calls, toolCalls } = twoProjects({ toolWriters: [] });
  const gone = await fleet.handleTrigger({ number: 3, login: 'joel', trigger: 'label', title: '', kind: 'issue', project: 'gone' });
  assert.equal(gone.outcome, 'ignored');
  const notWriter = await fleet.handleTrigger({ number: 3, login: 'joel', trigger: 'label', title: '', kind: 'issue', project: 'tools' });
  assert.deepEqual(notWriter, { outcome: 'ignored', reason: 'no write access to the repo' });
  assert.deepEqual([calls.started, toolCalls.comments], [[], []]);
});

test('a webhook label is claimed per project, so the same number on two repos is two labels', async () => {
  const { fleet } = twoProjects();
  const at = '2026-10-21T10:00:00.000Z';
  const first = await fleet.handleWebhookTrigger({ number: 8, login: 'joel', trigger: 'label', title: 'x', kind: 'issue', at });
  const other = await fleet.handleWebhookTrigger({ number: 8, login: 'joel', trigger: 'label', title: 'y', kind: 'issue', at, project: 'tools' });
  const again = await fleet.handleWebhookTrigger({ number: 8, login: 'joel', trigger: 'label', title: 'y', kind: 'issue', at, project: 'tools' });
  assert.deepEqual([first.outcome, other.outcome, again.outcome], ['started', 'started', 'duplicate']);
});

// The tools repo's own issue events and comments, on its own client, as GitHub answers them.
function pollableTools(tools) {
  return Object.assign(tools, {
    events: [], comments: [], polled: 0, pageSize: 100,
    async latestEventId() { return 500; },
    async issueEventsSince() { this.polled++; return { events: this.events, complete: true }; },
    async commentsSince() { return this.comments; },
  });
}

const toolsLabel = (id, number) => ({ id, event: 'labeled', created_at: LABELED_AT, label: { name: 'woodshed' }, actor: { login: 'joel' }, issue: { number, title: `t${number}` } });
const toolsComment = (id, number, body) => ({ id, created_at: '2026-10-21T10:00:05Z', updated_at: '2026-10-21T10:00:05Z', body, user: { login: 'joel' }, issue_url: `https://api.github.com/repos/o/tools/issues/${number}` });

test('with webhooks not arriving, the poll starts sessions from another project\'s labels and comments, on its repo', async () => {
  const { fleet, github, store, tools, toolCalls, calls } = twoProjects();
  pollableTools(tools);
  tools.events = [toolsLabel(499, 3)];
  await fleet.pollGitHub();
  assert.equal(store.state.githubProjects.tools.lastEventId, 500, 'the first poll only records where the tools repo is');
  assert.equal(store.state.githubProjects.tools.repo, 'o/tools');
  assert.equal(fleet.sessions().length, 0);

  tools.events = [toolsLabel(501, 12), toolsLabel(499, 3)];
  tools.comments = [toolsComment(77, 15, '/woodshed fix the build')];
  // The default repo has its own #12, untouched.
  github.events = [];
  await fleet.pollGitHub();
  const sessions = fleet.sessions();
  assert.deepEqual(sessions.map((s) => [s.project, s.repo, s.number, s.trigger]), [['tools', 'o/tools', 12, 'label'], ['tools', 'o/tools', 15, 'comment']]);
  assert.equal(sessions[1].prompt, 'fix the build');
  assert.deepEqual(toolCalls.reactions, [{ issue: 12 }, { comment: 77 }], 'the 👀 goes on the tools repo');
  assert.deepEqual([calls.comments, calls.reactions], [[], []], 'nothing on the default repo');
  assert.equal(store.state.githubProjects.tools.lastEventId, 501);

  // A webhook arriving late for the same label or comment is a duplicate, and the next poll starts nothing again.
  const late = await fleet.handleWebhookTrigger({ number: 12, login: 'joel', trigger: 'label', title: 't12', kind: 'issue', at: '2026-10-21T10:00:20Z', project: 'tools' });
  const lateComment = await fleet.handleWebhookTrigger({ number: 15, login: 'joel', trigger: 'comment', text: 'fix the build', commentId: 77, project: 'tools' });
  assert.deepEqual([late.outcome, lateComment.outcome], ['duplicate', 'duplicate']);
  await fleet.pollGitHub();
  assert.equal(fleet.sessions().length, 2);
});

test('one project\'s poll failing leaves the others polled, and a removed project\'s cursors go', async () => {
  const { fleet, github, store, tools, projects } = twoProjects();
  pollableTools(tools);
  await fleet.pollGitHub();
  await fleet.pollGitHub();
  assert.equal(tools.polled, 1);

  tools.issueEventsSince = async () => { throw new Error('gh: HTTP 502'); };
  github.events = [{ id: 101, event: 'labeled', created_at: LABELED_AT, label: { name: 'woodshed' }, actor: { login: 'joel' }, issue: { number: 4, title: 'x' } }];
  const warned = [];
  const warn = console.warn;
  console.warn = (line, fields) => warned.push([line, fields]);
  try {
    await fleet.pollGitHub();
    await fleet.pollGitHub();
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(fleet.sessions().map((s) => [s.project, s.number]), [['r', 4]], 'the default repo is still polled');
  assert.deepEqual(warned, [['fleet: a project\'s github poll failed', { project: 'tools', message: 'gh: HTTP 502' }]], 'said once while it keeps failing');

  // The default project failing is still the poll's own error, after the others were polled.
  github.issueEventsSince = async () => { throw new Error('gh: HTTP 401'); };
  pollableTools(tools);
  tools.polled = 0;
  await assert.rejects(fleet.pollGitHub(), /HTTP 401/);
  assert.equal(tools.polled, 1);

  projects.pop();
  await fleet.pollGitHub().catch(() => {});
  assert.deepEqual(store.state.githubProjects, {});
});

test('a Needs a human comment and a pull request change reach the session on that project\'s repo alone', async () => {
  const { fleet, store, toolCalls } = twoProjects();
  const onDefault = fleet.find((await fleet.handleTrigger({ number: 12, login: 'joel', trigger: 'label', title: 'd', kind: 'issue' })).sessionId);
  const onTools = fleet.find((await fleet.handleTrigger({ number: 12, login: 'joel', trigger: 'label', title: 't', kind: 'issue', project: 'tools' })).sessionId);
  const needsDefault = await fleet.handleNeedsHuman({ number: 12, commentId: 801 });
  const needsTools = await fleet.handleNeedsHuman({ number: 12, commentId: 802, project: 'tools' });
  assert.equal(needsDefault.sessionId, onDefault.id);
  assert.equal(needsTools.sessionId, onTools.id);
  const needsGone = await fleet.handleNeedsHuman({ number: 12, commentId: 803, project: 'gone' });
  assert.equal(needsGone.sessionId, undefined);
  // A kept session's pull request is read again for its retention when its own repo's webhook says it changed.
  for (const [s, url] of [[onDefault, 'https://github.com/o/r/pull/40'], [onTools, 'https://github.com/o/tools/pull/40']]) Object.assign(s, { prUrl: url, kept: true, status: 'stopped', stoppedAt: '2026-10-21T09:30:00.000Z' });
  store.save();
  await fleet.tick();
  assert.deepEqual(toolCalls.pulls, [40], 'the kept tools session\'s pull request is read on its own repo');
  assert.deepEqual(fleet.pullsChanged([40], 'tools'), [40]);
  assert.deepEqual(fleet.pullsChanged([40], 'gone'), [], 'a project the console does not have marks nothing');
});

test('the console\'s comments link to it on the default project\'s repo, word for word as before, and nowhere else', () => {
  const session = { id: 'abcd1234', status: 'starting', startedBy: 'joel', resumedBy: 'joel', branch: 'woodshed/1-abcd1234' };
  assert.equal(startComment({ session, publicUrl: 'https://console.test', maxRunning: 5, appDomain: 'apps.test' }), [
    'Started a session on Woodshed for @joel on `woodshed/1-abcd1234`.',
    '',
    'Watch it and type into it: https://console.test/s/abcd1234',
    'Its app, once started from that page: https://abcd1234.apps.test/',
    '',
    'Comment `/woodshed <message>` here to send it a message.',
  ].join('\n'));
  assert.equal(resumeComment({ session, publicUrl: 'https://console.test' }),
    'Resumed the Woodshed session on `woodshed/1-abcd1234` for @joel, with its conversation.\n\nWatch it and type into it: https://console.test/s/abcd1234');
  assert.match(failedComment({ session, publicUrl: 'https://console.test' }), /The console shows why: https:\/\/console\.test\/s\/abcd1234\n/);
  assert.match(refusalComment({ login: 'sam', label: 'woodshed', unlabeled: false, member: true, publicUrl: 'https://console.test' }), /People page: https:\/\/console\.test\/people$/);
  assert.match(refusalComment({ login: 'sam', label: 'woodshed', unlabeled: false, member: false, publicUrl: 'https://console.test' }), /add you to the console \(https:\/\/console\.test\)/);

  const without = [
    startComment({ session, publicUrl: null, maxRunning: 5, appDomain: 'apps.test' }),
    startComment({ session: { ...session, status: 'queued' }, publicUrl: null, maxRunning: 5 }),
    resumeComment({ session, publicUrl: null }),
    failedComment({ session, publicUrl: null }),
    startComment({ session: { ...session, status: 'failed' }, publicUrl: null, maxRunning: 5 }),
    refusalComment({ login: 'sam', label: 'woodshed', unlabeled: true, member: true, publicUrl: null }),
    refusalComment({ login: 'sam', label: 'woodshed', unlabeled: false, member: false, publicUrl: null }),
  ];
  for (const body of without) {
    assert.doesNotMatch(body, /https?:|console\.test|apps\.test/, body);
    assert.match(body, /Woodshed|console/, 'the comment still says where the session is');
  }
});

test('the console\'s address in a comment follows the repo\'s project file, not whether the project is the default', async () => {
  // Another project whose file says nothing keeps the links.
  const open = twoProjects({ links: { r: true, tools: true } });
  await open.fleet.handleTrigger({ number: 12, login: 'joel', trigger: 'label', title: '', kind: 'issue', project: 'tools' });
  assert.match(open.toolCalls.comments.at(-1).body, /https:\/\/console\.test\/s\//);
  // The default project's file can say no too.
  const closed = twoProjects({ links: { r: false, tools: true } });
  await closed.fleet.handleTrigger({ number: 3, login: 'joel', trigger: 'label', title: 'Default 3', kind: 'issue' });
  assert.doesNotMatch(closed.calls.comments.at(-1).body, /console\.test|https?:/);
  // A file that could not be read: the default project keeps its links, another project's are left out.
  const unread = twoProjects({ links: { r: null, tools: null } });
  await unread.fleet.handleTrigger({ number: 3, login: 'joel', trigger: 'label', title: 'Default 3', kind: 'issue' });
  await unread.fleet.handleTrigger({ number: 12, login: 'joel', trigger: 'label', title: '', kind: 'issue', project: 'tools' });
  assert.match(unread.calls.comments.at(-1).body, /https:\/\/console\.test\/s\//);
  assert.doesNotMatch(unread.toolCalls.comments.at(-1).body, /console\.test|https?:/);
});

test('commentConsoleUrl reads consoleLinks, and an unread file keeps only the default project\'s address', () => {
  const publicUrl = 'https://console.test';
  assert.equal(commentConsoleUrl({ publicUrl, project: { default: false }, consoleLinks: true }), publicUrl);
  assert.equal(commentConsoleUrl({ publicUrl, project: { default: true }, consoleLinks: false }), null);
  assert.equal(commentConsoleUrl({ publicUrl, project: { default: true }, consoleLinks: null }), publicUrl);
  assert.equal(commentConsoleUrl({ publicUrl, project: { default: false }, consoleLinks: null }), null);
});

test('a resume and a failure on a repo whose project file says consoleLinks: false name no console address there', async () => {
  const { fleet, calls, toolCalls, statuses, alive } = twoProjects();
  const started = await fleet.handleTrigger({ number: 12, login: 'joel', trigger: 'label', title: '', kind: 'issue', project: 'tools' });
  const session = fleet.find(started.sessionId);
  statuses[session.id] = { state: 'done', claudeSession: '0b6e9c7a-1d2f-4e5a-9b8c-7d6e5f4a3b2c' };
  await fleet.tick();
  await fleet.stop(session, 'test');
  const resumed = await fleet.handleTrigger({ number: 12, login: 'joel', trigger: 'comment', text: 'pick it up again', commentId: 80, project: 'tools' });
  assert.deepEqual(resumed, { outcome: 'resumed', sessionId: session.id });
  assert.match(toolCalls.comments.at(-1).body, /^Resumed the Woodshed session/);
  alive.clear();
  await fleet.tick();
  assert.match(toolCalls.comments.at(-1).body, /failed to start/, 'the failure is announced on the project\'s issue');
  assert.equal(toolCalls.comments.length, 3, 'start, resume and failure, all on the project\'s issue');
  for (const { body } of toolCalls.comments) assert.doesNotMatch(body, /console\.test|https?:/, body);
  assert.deepEqual(calls.comments, [], 'nothing on the default repo');

  // The default project's resume and failure still link to the session.
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const onDefault = fleet.sessions().find((s) => s.number === 42);
  alive.clear();
  await fleet.tick();
  assert.equal(onDefault.status, 'failed');
  assert.match(calls.comments.at(-1).body, /failed to start[\s\S]*https:\/\/console\.test\/s\//);
});

test('a start and a refusal on a repo whose project file says consoleLinks: false name no console address there', async () => {
  const { fleet, calls, toolCalls } = twoProjects({ toolWriters: ['joel', 'sam'], githubSessions: ['joel'], writers: ['joel', 'sam'] });
  const started = await fleet.handleTrigger({ number: 12, login: 'joel', trigger: 'label', title: '', kind: 'issue', project: 'tools' });
  assert.equal(started.outcome, 'started');
  await fleet.handleTrigger({ number: 3, login: 'joel', trigger: 'label', title: 'Default 3', kind: 'issue' });
  assert.match(calls.comments.at(-1).body, /https:\/\/console\.test\/s\//, 'the default project\'s issue still links to the session');
  const sam = await fleet.handleTrigger({ number: 13, login: 'sam', trigger: 'label', title: '', kind: 'issue', project: 'tools' });
  assert.equal(sam.outcome, 'ignored', 'no sessions from GitHub for sam');
  assert.equal(toolCalls.comments.length, 2, 'a start comment and a refusal on the project\'s issues');
  for (const { body } of toolCalls.comments) assert.doesNotMatch(body, /console\.test|https?:/, body);
});

test('a posted pull request keeps the channel it went to on its session, after the project\'s channel changes', async () => {
  const { createSlack } = await import('./slack.mjs');
  const settings = { state: { settings: { slackChannel: 'C0CONSOLE01' } }, save() {} };
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    return { status: 200, async json() { return { ok: true, ts: body.thread_ts ?? '1730000000.000100' }; } };
  };
  const slack = createSlack({ store: settings, secrets: { async read() { return 'xoxb-1'; } }, fetchImpl });
  slack.setProjectChannel({ project: 'r', channel: 'C0ACMEPRS1', by: 'mia-dev' });
  const { fleet, github, statuses, store, advance } = setup({ slack });
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'Add GTM', kind: 'issue' });
  const [session] = store.state.sessions;
  github.pull = async (number) => ({ number, title: 'Add GTM', created_at: '2026-10-21T10:05:00Z', state: 'open', head: { sha: 'abc' }, html_url: `https://github.com/o/r/pull/${number}` });
  github.reviews = async () => approvedReview();
  github.checkRuns = async () => e2eRuns();
  statuses[session.id] = { state: 'done', prUrl: 'https://github.com/o/r/pull/7' };
  await fleet.tick();
  advance(APPROVAL_GRACE_MS);
  await fleet.tick();
  assert.deepEqual(session.slackPost, { channel: 'C0ACMEPRS1', ts: '1730000000.000100' }, 'the default project\'s own channel, by its name');
  slack.setProjectChannel({ project: 'r', channel: 'C0OTHER001', by: 'mia-dev' });
  await fleet.tick();
  assert.deepEqual(session.slackPost, { channel: 'C0ACMEPRS1', ts: '1730000000.000100' }, 'the post stays where it was made');
});

test('with no console channel, a pull request on a project without its own is not tracked until a channel is set', async () => {
  const { createSlack } = await import('./slack.mjs');
  const settings = { state: { settings: { slackChannel: '' } }, save() {} };
  const slack = createSlack({ store: settings, secrets: { async read() { return 'xoxb-1'; } }, fetchImpl: async () => ({ status: 200, async json() { return { ok: true }; } }) });
  slack.setProjectChannel({ project: 'tools', channel: 'C0TOOLS001', by: 'mia-dev' });
  const { fleet, github, statuses, store } = setup({ slack });
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'Add GTM', kind: 'issue' });
  const [session] = store.state.sessions;
  github.pull = async (number) => ({ number, title: 'Add GTM', created_at: '2026-10-21T10:05:00Z', state: 'open', head: { sha: 'abc' } });
  statuses[session.id] = { state: 'working', prUrl: 'https://github.com/o/r/pull/7' };
  await fleet.tick();
  assert.deepEqual(store.state.slackPending ?? [], [], 'its project has nowhere to post');
  assert.equal(session.announcedPrUrl, undefined, 'and it is looked at again');
  slack.setChannel({ channel: 'C0CONSOLE01', by: 'mia-dev' });
  await fleet.tick();
  assert.deepEqual(store.state.slackPending.map((p) => p.number), [7]);
});

const QA_GATES = { ...PULL_GATES, qa: { check: 'QA', label: 'qa', heading: '## QA', author: 'console[bot]', runner: 'woodshed' } };
const QA_PULL = { state: 'open', title: 'Add GTM', head: { ref: 'joel/gtm', sha: 'a'.repeat(40) }, base: { ref: 'main' }, labels: [{ name: 'qa' }] };
const reviewOn = (sha, state = 'APPROVED') => [{ user: { login: 'review-bot[bot]' }, state, body: '## Code review', commit_id: sha }];
const QA_VERDICT = { conclusion: 'success', title: 'Pass: 2 test cases passed', status: '✅ **Pass**: all 2 test cases passed', total: 2 };

function qaSetup(options = {}) {
  const t = setup({ gates: QA_GATES, ...options });
  t.github.pull = async () => QA_PULL;
  t.github.reviews = async () => reviewOn(QA_PULL.head.sha);
  t.github.labeledBy = async () => 'joel';
  return t;
}

test('a QA label before the review approves the head posts a waiting check and starts nothing', async () => {
  const { fleet, calls, github } = qaSetup();
  github.reviews = async () => reviewOn('b'.repeat(40));
  assert.deepEqual(await fleet.handleQaLabel({ number: 7, label: 'qa', login: 'joel' }), { outcome: 'waiting', reason: 'the review has not approved the latest commit' });
  assert.equal(fleet.sessions().length, 0);
  assert.deepEqual([calls.checks[0].sha, calls.checks[0].conclusion], ['a'.repeat(40), 'neutral']);
  assert.match(calls.checks[0].title, /^Waiting\b/, 'the brief reads a Waiting check as no result');
});

test('the review approving a labelled pull request starts QA as whoever added the label, once for each commit', async () => {
  const { fleet, github } = qaSetup();
  github.labeledBy = async () => 'joel';
  const first = await fleet.qaAfterReview({ number: 7 });
  assert.equal(first.outcome, 'started');
  const [session] = fleet.sessions();
  assert.deepEqual([session.startedBy, session.qa.sha], ['joel', 'a'.repeat(40)]);
  session.status = 'stopped';
  assert.deepEqual(await fleet.qaAfterReview({ number: 7 }), { unrecorded: true }, 'already tested at this commit');
  assert.equal(fleet.sessions().length, 1);
});

test('a commit the review approved while QA ran on an older one is tested once that run finishes', async () => {
  const { fleet, github } = qaSetup();
  await fleet.handleQaLabel({ number: 7, label: 'qa', login: 'joel' });
  const newer = { ...QA_PULL, head: { ...QA_PULL.head, sha: 'c'.repeat(40) } };
  github.pull = async () => newer;
  github.reviews = async () => reviewOn(newer.head.sha);
  assert.equal((await fleet.qaAfterReview({ number: 7 })).reason, 'QA is already running on it');
  await fleet.qaFinished(fleet.sessions()[0], { verdict: QA_VERDICT, report: '## TC-1: a ✅', sha: 'a'.repeat(40), costUsd: 1 });
  await settle();
  const later = fleet.sessions()[1];
  assert.deepEqual([later?.qa.sha, later?.startedBy], ['c'.repeat(40), 'joel']);
});

test('a review starts no QA without the label, without approval, or for a project with no review gate', async () => {
  const unlabelled = qaSetup();
  unlabelled.github.pull = async () => ({ ...QA_PULL, labels: [] });
  assert.deepEqual(await unlabelled.fleet.qaAfterReview({ number: 7 }), { unrecorded: true });
  const changes = qaSetup();
  changes.github.reviews = async () => reviewOn(QA_PULL.head.sha, 'CHANGES_REQUESTED');
  assert.deepEqual(await changes.fleet.qaAfterReview({ number: 7 }), { unrecorded: true });
  assert.deepEqual([changes.fleet.sessions().length, changes.calls.checks.length], [0, 0], 'no session, and no second Waiting check');
  const noReview = qaSetup({ gates: { ...QA_GATES, review: null } });
  assert.deepEqual(await noReview.fleet.qaAfterReview({ number: 7 }), { unrecorded: true });
  assert.equal((await noReview.fleet.handleQaLabel({ number: 7, label: 'qa', login: 'joel' })).outcome, 'started', 'with no review, the label starts QA');
});

test('the QA label on a pull request starts a QA session on its branch, read only, and says so in the QA comment', async () => {
  const { fleet, calls } = qaSetup();
  const outcome = await fleet.handleQaLabel({ number: 7, label: 'qa', login: 'joel' });

  const [session] = fleet.sessions();
  assert.deepEqual(outcome, { outcome: 'started', sessionId: session.id });
  assert.deepEqual([session.kind, session.branch, session.trigger], ['pr', 'joel/gtm', 'qa']);
  const { env } = calls.started[0];
  assert.deepEqual([env.SESSION_MODE, env.PR, env.QA_BASE, env.GH_TOKEN], ['qa', '7', 'main', undefined]);
  assert.equal(calls.comments.length, 1);
  assert.match(calls.comments[0].body, /^## QA\n\n⏳ \*\*Running\*\*/);
  assert.match(calls.comments[0].body, new RegExp(`https://console.test/s/${session.id}`));
  assert.equal(session.qa.commentId, 9001);
});

test('a QA label is dropped unless the project runs QA here, and starts nothing while QA already runs', async () => {
  const inActions = qaSetup({ gates: { ...QA_GATES, qa: { ...QA_GATES.qa, runner: 'actions' } } });
  assert.deepEqual(await inActions.fleet.handleQaLabel({ number: 7, label: 'qa', login: 'joel' }), { unrecorded: true });
  const { fleet } = qaSetup();
  assert.deepEqual(await fleet.handleQaLabel({ number: 7, label: 'bug', login: 'joel' }), { unrecorded: true });
  assert.equal((await fleet.handleQaLabel({ number: 7, label: 'qa', login: 'stranger' })).reason, 'no write access to the repo');
  await fleet.handleQaLabel({ number: 7, label: 'qa', login: 'joel' });
  assert.deepEqual(await fleet.handleQaLabel({ number: 7, label: 'qa', login: 'joel' }), { outcome: 'ignored', reason: 'QA is already running on it' });
  assert.equal(fleet.sessions().length, 1);
});

test('a QA check GitHub refuses still leaves the report in the comment and stops the session', async () => {
  const { fleet, calls, github } = qaSetup();
  github.createCheckRun = async () => { throw new Error('HTTP 403: Resource not accessible by integration'); };
  await fleet.handleQaLabel({ number: 7, label: 'qa', login: 'joel' });
  const [session] = fleet.sessions();
  await fleet.qaFinished(session, { verdict: QA_VERDICT, report: '## TC-1: a ✅', sha: 'a'.repeat(40), costUsd: 1 });
  await settle();
  assert.match(calls.comments.at(-1).body, /✅ \*\*Pass\*\*/);
  assert.equal(session.status, 'stopped');
});

test('a QA report naming another commit posts no check, though its comment is still written', async () => {
  const { fleet, calls } = qaSetup();
  await fleet.handleQaLabel({ number: 7, label: 'qa', login: 'joel' });
  const [session] = fleet.sessions();
  await fleet.qaFinished(session, { verdict: QA_VERDICT, report: '## TC-1: a ✅', sha: 'b'.repeat(40), costUsd: 1 });
  await settle();
  assert.equal(calls.checks.length, 0, 'the pull request\'s code could name another pull request\'s head');
  assert.match(calls.comments.at(-1).body, /✅ \*\*Pass\*\*/);
});

test('a QA report on a commit pushed since the session started is checked on it', async () => {
  const { fleet, calls, github } = qaSetup();
  await fleet.handleQaLabel({ number: 7, label: 'qa', login: 'joel' });
  github.pull = async () => ({ ...QA_PULL, head: { ...QA_PULL.head, sha: 'c'.repeat(40) } });
  await fleet.qaFinished(fleet.sessions()[0], { verdict: QA_VERDICT, report: '## TC-1: a ✅', sha: 'c'.repeat(40), costUsd: 1 });
  await settle();
  assert.equal(calls.checks[0].sha, 'c'.repeat(40));
});

test('a QA session is not where a /woodshed comment on its pull request goes', async () => {
  const { fleet } = qaSetup();
  await fleet.handleQaLabel({ number: 7, label: 'qa', login: 'joel' });
  await fleet.handleTrigger({ number: 7, login: 'joel', trigger: 'comment', text: 'fix the test', commentId: 55 });
  assert.equal(fleet.sessions().length, 2, 'a coding session of its own');
  assert.equal(fleet.sessions().filter((s) => s.qa).length, 1);
});

test('a QA report is written over the running comment, the session stops and is not kept, and the next run reuses the comment', async () => {
  const { fleet, calls, statuses } = qaSetup();
  await fleet.handleQaLabel({ number: 7, label: 'qa', login: 'joel' });
  const [session] = fleet.sessions();
  statuses[session.id] = { state: 'working' };
  await fleet.tick();

  await fleet.qaFinished(session, { verdict: QA_VERDICT, report: '## TC-1: a ✅\n## TC-2: b ✅', sha: 'a'.repeat(40), costUsd: 1.5 });
  await settle();
  const written = calls.comments.at(-1);
  assert.equal(written.id, 9001, 'the comment the start posted');
  assert.match(written.body, /^## QA\n\n✅ \*\*Pass\*\*: all 2 test cases passed\n\n## TC-1: a ✅/);
  assert.equal(session.status, 'stopped');
  assert.match(session.stopReason, /^QA finished: Pass/);
  assert.equal(session.kept, undefined, 'its databases go: a QA run is never resumed');
  assert.deepEqual([session.qa.conclusion, session.qa.costUsd], ['success', 1.5]);
  const [check] = calls.checks;
  assert.deepEqual([check.sha, check.name, check.conclusion, check.title, check.externalId], ['a'.repeat(40), 'QA', 'success', 'Pass: 2 test cases passed', session.id]);
  assert.match(check.summary, /^✅ \*\*Pass\*\*: all 2 test cases passed\n\n## TC-1: a ✅/, 'the report rides in the check, which no session can write');

  await fleet.handleQaLabel({ number: 7, label: 'qa', login: 'joel' });
  assert.equal(fleet.sessions()[1].qa.commentId, 9001);
  assert.equal(calls.comments.at(-1).id, 9001, 'the second run updates the same comment');
});

test('a console with no repo yet starts nothing, and says an admin adds one on Console settings', async () => {
  const { fleet, calls } = setup();
  // As loadConfig leaves it with neither WOODSHED_REPO nor WOODSHED_PROJECTS, and no repo added yet.
  const none = { name: 'default', repo: '', default: true };
  const said = { shown: true, message: 'Not started: the console has no repo yet. An admin adds one on the Console settings page, under Repos.' };
  await assert.rejects(fleet.startPrivate({ owner: 'joel', prompt: 'Fix it', project: none }), said);
  await assert.rejects(fleet.createSession({ kind: 'ask', title: 'Why?', startedBy: 'joel', trigger: 'slack', project: none }), said);
  assert.equal(calls.started.length, 0);
  assert.equal(fleet.sessions().length, 0);
});

test('when the default repo is removed, the next default starts its poll from now, not from the old repo\'s last event', async () => {
  const { fleet, github, store, projects } = twoProjects();
  await fleet.pollGitHub();
  assert.equal(store.state.github.repo, 'o/r', 'the default\'s cursors name their repo');
  // The first repo added is removed on a console that started with none: the next one is the default, and the
  // console's own client follows it (installation.mjs), so its events come from that client from here on.
  projects.splice(0, 2, { name: 'tools', repo: 'o/tools', default: true });
  github.latestEventId = async () => 500;
  github.events = [toolsLabel(499, 3)];
  await fleet.pollGitHub();
  assert.deepEqual([store.state.github.repo, store.state.github.lastEventId], ['o/tools', 500], 'started again from where the new repo is');
  await fleet.pollGitHub();
  assert.equal(fleet.sessions().length, 0, 'the new default\'s older label is not handled again');
});

test('the default\'s cursors from before they named a repo are kept, as the environment\'s repo\'s', async () => {
  const { fleet, github, store } = setup();
  store.state.github = { lastEventId: 100, commentsSince: '2026-10-21T09:00:00.000Z', notBefore: '2026-10-21T09:00:00.000Z', seenComments: [7] };
  github.events = [{ id: 101, event: 'labeled', created_at: LABELED_AT, label: { name: 'woodshed' }, actor: { login: 'joel' }, issue: { number: 4, title: 'x' } }];
  await fleet.pollGitHub();
  assert.equal(fleet.sessions().length, 1, 'polled from the kept cursor, not started again');
  assert.ok(store.state.github.seenComments.includes(7), 'the comments seen before are still seen');
});
