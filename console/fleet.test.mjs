import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sharedHomeName } from './homes.mjs';
import { withDefaultReview } from './defaultReview.mjs';

import { sessionForStartToken, startTokenHash } from './sessionStarts.mjs';
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

function setup({ userSettings = null, maxRunning = 5, maxPrivatePerPerson = 10, writers = ['joel'], issues = {}, ghToken = 'gh-token', databases = null, slack = null, homes = null, retention, people = null, autoName = null, attachments = null, assignables = [], githubSessions = null, memberList = null, pings = null, projectBlocker = async () => null, projects = null, githubFor = null, consoleLinks = undefined, appDomain = '', gates = PULL_GATES, ownApp = () => null, reviewerApp = null, repoTriggers = null, runsOnName = null, qaRecordings = null, reviewAgents = null, reviewGates = undefined, startableRepos = null } = {}) {
  let clock = Date.parse('2026-10-21T10:00:00.000Z');
  const calls = { started: [], stopped: [], statusd: [], comments: [], checks: [], reviews: [], reactions: [], unlabeled: [], found: [], assignees: [], statusMoves: [], taskStates: [], taskState: [], labeled: [], labelsMade: [], resolvedThreads: [] };
  const alive = new Set();
  // When ECS began pulling each task's image, by ref.
  const pulls = {};
  const statuses = {};
  // What statusd answers on another route, by path, when a test gives one.
  const answers = {};
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
    async createReview(number, review) { calls.reviews.push({ number, ...review }); return 1; },
    async commitMessage() { return 'feat: do the thing [woodshed-review]'; },
    async removeLabel(number, label) { calls.unlabeled.push({ number, label }); return true; },
    async addLabel(number, label) { calls.labeled.push({ number, label }); },
    async ensureLabel(label) { calls.labelsMade.push(label); return true; },
    threads: [],
    async reviewThreads() { return this.threads; },
    async resolveThread(id) { calls.resolvedThreads.push(id); return true; },
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
      // Today's statusd: the guarded send, and typing only into a running agent when asked. A test of an older one
      // says safeSend or agentOnlySend false. A test may hold the answer back (a promise): it is awaited first.
      return Promise.resolve(statuses[session.id]).then((status) => ({ safeSend: true, agentOnlySend: true, ...status }));
    }
    if (answers[path]) return answers[path];
    return { ok: true, committed: false, head: 'abc' };
  }
  const store = { state: { sessions: [], github: null }, save() {} };
  const config = {
    repo: 'o/r', label: 'woodshed', publicUrl: 'https://console.test', maxRunning,
    limits: { idleMs: 2 * HOUR, lifetimeMs: 8 * HOUR, startTimeoutMs: 15 * 60_000 },
    sessionEnv: { PGHOST: 'db' }, ghToken, pollMs: 30_000, fallbackPollMs: 300_000, retention, maxPrivatePerPerson,
    ...(projects ? { projects } : {}),
    ...(appDomain ? { appDomain } : {}),
    ...(runsOnName ? { runsOnName } : {}),
  };
  const fleet = createFleet({
    config, store, launcher, github, databases, slack, homes, userSettings, people, autoName, attachments, qaRecordings, now: () => clock, startableRepos,
    pings, pullRequests: async () => gates, ...(reviewGates !== undefined ? { reviewGates: typeof reviewGates === 'function' ? reviewGates : async () => reviewGates } : {}), projectBlocker, githubFor, ownApp, reviewerApp, repoTriggers, reviewAgents, ...(consoleLinks ? { consoleLinks } : {}),
    // Every writer has sessions from GitHub unless a test names who does.
    members: {
      isAssignable: (login) => assignables.some((e) => e.toLowerCase() === String(login).toLowerCase()),
      assignables: () => [...assignables],
      hasGithubSessions: (login) => (githubSessions ?? writers).some((e) => e.toLowerCase() === String(login).toLowerCase()),
      isMember: (login) => (memberList ?? writers).some((e) => e.toLowerCase() === String(login).toLowerCase()),
    },
    statusd: (session, method, path, opts) => {
      if (path === '/send' && fail.send) return Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
      if (path === '/send' && fail.sendTyped) return Promise.reject(Object.assign(new Error('statusd /send answered 409'), { status: 409, body: { why: 'prompt-open', typed: true } }));
      // A test's own answer for one send: an error to refuse it with, or a promise to wait on before it goes.
      if (path === '/send' && fail.sendFor) {
        fail.lastSendOpts = opts;
        const answer = fail.sendFor(opts?.body?.text);
        if (answer instanceof Error) return Promise.reject(answer);
        if (answer) return answer.then(() => statusd(session, method, path, opts));
      }
      if (path === '/send' && fail.sendBusy) {
        calls.statusd.push({ path, body: opts?.body, refused: 'busy' });
        return Promise.reject(Object.assign(new Error('statusd /send answered 409'), { status: 409, body: { why: 'working', busy: true } }));
      }
      return statusd(session, method, path, opts);
    },
  });
  return { fleet, calls, github, alive, pulls, statuses, answers, store, fail, launcher, advance: (ms) => { clock += ms; } };
}

// A project that is not ready (databaseGate.mjs) starts no session that would get databases, and the reason, with its
// first fix, reaches whoever asked. Another project still starts.
const MONGO_BLOCKER = {
  project: 'example-repo', repo: 'example-org/example-repo',
  reason: 'example-org/example-repo\'s project file asks for a Mongo database, and this console only runs Postgres.',
  fix: [{ text: 'Add "mongo" to databases in the installation\'s terraform.tfvars, then run terraform plan and terraform apply.' }, { text: 'Or take the Mongo database out.' }],
};
const MONGO_WHY = `${MONGO_BLOCKER.reason} ${MONGO_BLOCKER.fix[0].text}`;

test('a project that is not ready starts no session: a label is told why on its issue, and the API refuses', async () => {
  const asked = [];
  const { fleet, calls } = setup({ projectBlocker: async (project) => { asked.push(project.name); return MONGO_BLOCKER; } });
  const outcome = await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'Add GTM', kind: 'issue' });
  assert.deepEqual(outcome, { outcome: 'ignored', reason: MONGO_WHY });
  assert.deepEqual(calls.comments.map((c) => c.body), [`Woodshed cannot start a session here: ${MONGO_WHY}`]);
  assert.equal(fleet.sessions().length, 0);
  await assert.rejects(fleet.startPrivate({ owner: 'joel', prompt: 'Fix it' }), { shown: true, message: `Not started: ${MONGO_WHY}` });
  assert.equal(calls.started.length, 0);
  assert.equal(asked.length, 2, 'each start checks its project');
});

test('a blocked project holds back only its own sessions: another project starts', async () => {
  const projects = [
    { name: 'example-repo', repo: 'example-org/example-repo', default: true },
    { name: 'web', repo: 'example-org/web', default: false },
  ];
  const { fleet, calls } = setup({ projects, projectBlocker: async (project) => (project.name === 'example-repo' ? MONGO_BLOCKER : null) });
  await assert.rejects(fleet.startPrivate({ owner: 'joel', prompt: 'Fix it' }), { shown: true, message: `Not started: ${MONGO_WHY}` });
  const session = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it', project: projects[1] });
  assert.equal(session.project, 'web');
  assert.equal(calls.started.length, 1);
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

test('a private session names its agent to the container, and a resume of one but claude starts its prompt again', async () => {
  const { fleet, calls } = setup();
  const grok = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it', agent: 'grok', model: 'grok-build', effort: 'high', permissionMode: 'acceptEdits' });
  assert.deepEqual([calls.started[0].env.AGENT, calls.started[0].env.MODEL, calls.started[0].env.EFFORT], ['grok', 'grok-build', 'high']);
  await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it', agent: 'opencode', model: 'anthropic/claude-sonnet-4-5' });
  assert.equal(calls.started[1].env.AGENT, 'opencode');
  await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it' });
  assert.equal(calls.started[2].env.AGENT, undefined, 'claude is the image\'s default');
  await assert.rejects(fleet.startPrivate({ owner: 'joel', prompt: '', agent: 'grok' }), /say what Grok Build should do/);
  await assert.rejects(fleet.startPrivate({ owner: 'joel', prompt: 'x', agent: 'opencode', model: 'no-provider' }), /not a name OpenCode takes/);
  grok.claudeSession = '0b6e9c7a-1d2f-4e5a-9b8c-7d6e5f4a3b2c';
  await fleet.stopSession?.(grok.id).catch(() => {});
  grok.status = 'stopped';
  await fleet.resumePrivate({ owner: 'joel', id: grok.id });
  assert.equal(grok.resumeClaude, null, 'only claude reopens a conversation');
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

test('stopping a session that paused by itself moves it to Stopped, and only once', async () => {
  const { fleet, calls, statuses } = setup();
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = fleet.sessions();
  statuses[session.id] = { state: 'working' };
  await fleet.tick();
  await fleet.stop(session, 'idle for 1 h');
  const removed = calls.stopped.length;
  await fleet.stop(session, 'idle for 1 h');
  assert.equal(session.stoppedBy, null, 'a stop with no person leaves it waiting');
  await fleet.stop(session, 'stopped from the console', { by: 'joel' });
  assert.deepEqual([session.status, session.stoppedBy, session.stopReason], ['stopped', 'joel', 'idle for 1 h']);
  await fleet.stop(session, 'stopped from the console', { by: 'ana' });
  assert.equal(session.stoppedBy, 'joel');
  assert.equal(calls.stopped.length, removed, 'nothing is stopped again');
  await fleet.resumeShared(session, { by: 'joel', why: 'console' });
  assert.equal(session.stoppedBy, null);
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

test('a pull request on another repo is kept only for a private session, on a project its owner may start on', async () => {
  const projects = [
    { name: 'r', repo: 'o/r', default: true },
    { name: 'cloud', repo: 'o/cloud', default: false },
    { name: 'secret', repo: 'o/secret', default: false },
  ];
  const asked = [];
  const { fleet, statuses, advance } = setup({ projects, startableRepos: async (login) => { asked.push(login); return ['o/r', 'o/cloud']; } });
  const own = 'https://github.com/o/r/pull/7';
  const cloud = 'https://github.com/o/cloud/pull/151';
  const secret = 'https://github.com/o/secret/pull/1';
  const mine = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it' });
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const shared = fleet.sessions().find((s) => !s.owner);
  statuses[mine.id] = { state: 'done', prUrl: own, prUrls: [own, cloud, secret] };
  statuses[shared.id] = { state: 'done', prUrl: own, prUrls: [own, cloud] };
  await fleet.tick();
  assert.deepEqual(fleet.sessions().find((s) => s.id === mine.id).prUrls, [own, cloud], 'a project the owner may not start on is dropped');
  assert.deepEqual(fleet.sessions().find((s) => s.id === shared.id).prUrls, [own], 'a shared session keeps its own repo\'s alone');
  assert.deepEqual(asked, ['joel'], 'asked for the private session alone');
  statuses[mine.id] = { state: 'done', prUrl: own, prUrls: [own] };
  await fleet.tick();
  assert.equal(asked.length, 1, 'not asked when the status names no other repo');
  statuses[mine.id] = { state: 'done', prUrl: own, prUrls: [own, cloud] };
  await fleet.tick();
  assert.equal(asked.length, 1, 'kept a minute');
  advance(61_000);
  await fleet.tick();
  assert.equal(asked.length, 2, 'asked again after it');
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

test('Extend puts an idle pause off by an hour, and a session\'s own limits replace the console\'s', async () => {
  const { fleet, statuses, advance } = setup();
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  await fleet.handleTrigger({ number: 43, login: 'joel', trigger: 'label', title: 'y', kind: 'issue' });
  const [first, second] = fleet.sessions();
  statuses[first.id] = { state: 'done' };
  statuses[second.id] = { state: 'done' };
  await fleet.tick();
  const pause = Date.parse(fleet.pauseOf(first).at);
  advance(2 * HOUR - 20 * 60_000);
  assert.throws(() => fleet.extend(first, 'joel'), (err) => err.forbidden && /nobody has this session: take it/.test(err.message), 'an unassigned one is taken first');
  first.assignee = 'joel';
  second.assignee = 'Joel';
  assert.throws(() => fleet.extend(first, 'joel'), /last 15 min before it pauses/, 'not before its last 15 minutes');
  advance(10 * 60_000);
  fleet.extend(first, 'joel');
  assert.equal(Date.parse(fleet.pauseOf(first).at), pause + HOUR);
  assert.throws(() => fleet.extend(first, 'joel'), /last 15 min/, 'pressed again at once, it is an hour off');
  advance(60 * 60_000);
  fleet.extend(first, 'joel');
  assert.equal(Date.parse(fleet.pauseOf(first).at), pause + 2 * HOUR, 'in its last 15 minutes again, another hour');
  for (const call of [() => fleet.extend(first, 'mia'), () => fleet.setLimits(second, { idleHours: 6 }, 'mia')]) {
    assert.throws(call, (err) => err.forbidden && /only joel, who has this session/i.test(err.message), 'someone else on a shared session');
  }
  fleet.setLimits(second, { idleHours: 6, lifetimeHours: null }, 'joel');
  assert.deepEqual(second.limits, { idleHours: 6 });
  assert.throws(() => fleet.setLimits(second, { idleHours: 30 }, 'joel'), /0.25 to 24/);
  advance(10 * 60_000);
  await fleet.tick();
  assert.deepEqual([first.status, second.status], ['running', 'running']);
  advance(2 * HOUR);
  await fleet.tick();
  assert.deepEqual([first.status, first.stopReason, second.status], ['stopped', 'idle for 4 h', 'running']);
  fleet.setLimits(second, {}, 'joel');
  assert.equal(second.limits, null, 'empty goes back to the console\'s');
  await fleet.tick();
  assert.equal(second.status, 'stopped');
  assert.throws(() => fleet.extend(second, 'joel'), /only a running session/);
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

test('a send whose connection drops after it reached statusd is unknown and never sent again; one never connected is held', async () => {
  const { fleet, calls, statuses, fail } = setup();
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = fleet.sessions();
  statuses[session.id] = { state: 'done', branch: session.branch, head: 'abc' };
  await fleet.tick();
  const sends = () => calls.statusd.filter((c) => c.path === '/send').length;
  fail.sendFor = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  assert.equal(await fleet.send(session, 'reset', { id: 'page-id-0010' }), 'unknown');
  assert.deepEqual(session.pendingMessages, [], 'not held to type again');
  fail.sendFor = () => new SyntaxError('Unexpected end of JSON input');
  assert.equal(await fleet.send(session, 'cut off'), 'unknown', 'a reply cut off after statusd took it');
  fail.sendFor = () => Object.assign(new Error('statusd /send answered 409'), { status: 409, body: null });
  assert.equal(await fleet.send(session, 'cut 409'), 'unknown', 'a refusal whose body was lost may have said typed');
  fail.sendFor = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  assert.equal(await fleet.send(session, 'refused'), 'queued', 'never reached statusd: held to try again');
  fail.sendFor = null;
  const before = sends();
  await fleet.tick();
  assert.deepEqual(calls.statusd.filter((c) => c.path === '/send').slice(before).map((c) => c.body.text), ['refused']);
});

test('a Chat message held across a resume onto a statusd that types blind is dropped and the page told; the console\'s own goes', async () => {
  const { fleet, calls, statuses, fail } = setup();
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = fleet.sessions();
  statuses[session.id] = { state: 'working', branch: session.branch, head: 'abc' };
  await fleet.tick();
  fail.sendBusy = true;
  assert.equal(await fleet.send(session, 'from chat', { id: 'page-id-0011' }), 'queued');
  assert.equal(await fleet.send(session, 'review feedback'), 'queued');
  fail.sendBusy = false;
  const typed = () => calls.statusd.filter((c) => c.path === '/send' && !c.refused);
  assert.deepEqual(typed(), []);
  statuses[session.id] = { state: 'done', branch: session.branch, head: 'abc', safeSend: false };
  await fleet.tick();
  assert.deepEqual(typed().map((c) => c.body.text), ['review feedback']);
  assert.deepEqual(session.pendingMessages, []);
  assert.deepEqual(session.refusedIds, ['page-id-0011']);
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

test('Start and Stop app say whether statusd took them, for the command line', async () => {
  const { fleet, statuses, answers } = setup();
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = fleet.sessions();
  statuses[session.id] = { state: 'done', app: 'running' };
  await fleet.tick();
  answers['/app/start'] = { started: false, app: 'stopping' };
  const skipped = {};
  await fleet.startApp(session, { said: skipped });
  assert.deepEqual(skipped, { started: false }, 'a start while the stop script runs');
  answers['/app/stop'] = { stopping: false, app: 'running' };
  const noStop = {};
  await fleet.stopApp(session, { said: noStop });
  assert.deepEqual([noStop, session.app], [{ stopping: false }, 'running'], 'no stop command');
  delete answers['/app/stop'];
  const older = {};
  await fleet.stopApp(session, { said: older });
  assert.deepEqual(older, {}, 'a statusd that does not say leaves it unsaid');
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

test('a start whose agent opened but whose launcher never answered is logged once, 30 s on, as not reached', async () => {
  const { fleet, fail, advance } = setup();
  let finish;
  fail.startWaits = new Promise((resolve) => { finish = resolve; });
  const starting = fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  await new Promise((resolve) => setImmediate(resolve));
  const [session] = fleet.sessions();
  const warned = [];
  const warn = console.warn;
  console.warn = (line, fields) => warned.push([line, fields]);
  try {
    advance(15_000);
    fleet.startStep(session, 'claude');
    advance(29_000);
    await fleet.checkStarting();
    assert.deepEqual(warned, [], 'not yet: reaching it takes a second or two');
    advance(1_000);
    await fleet.checkStarting();
    await fleet.checkStarting();
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(warned, [['fleet: the agent is open but the console has not reached the session', {
    id: session.id, seconds: 30, address: false, launching: true, message: null,
  }]], 'once for the start, saying the launcher has not answered');
  finish();
  await starting;
});

test('a start whose statusd does not answer after its agent opened is logged once, with the read\'s error', async () => {
  const { fleet, advance, statuses } = setup();
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = fleet.sessions();
  fleet.startStep(session, 'claude');
  const warned = [];
  const warn = console.warn;
  console.warn = (line, fields) => warned.push([line, fields]);
  try {
    advance(45_000);
    await fleet.checkStarting();
    await fleet.tick();
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(warned, [['fleet: the agent is open but the console has not reached the session', {
    id: session.id, seconds: 45, address: true, launching: false, message: 'connection refused',
  }]]);
  statuses[session.id] = { state: 'working' };
  await fleet.checkStarting();
  assert.equal(session.status, 'running');
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
  const { fleet, calls, github } = setup({ issues: { 77: { title: 'A PR', pull_request: {} }, 78: { title: 'Closed', pull_request: {} } } });
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
  // A merged or closed pull request is refused before a machine is asked for, naming the repo it was looked up on.
  github.pull = async (number) => ({ head: { ref: 'gone/branch' }, state: 'closed', merged_at: number === 77 ? '2026-11-11T12:08:23Z' : null });
  await assert.rejects(fleet.startPrivate({ owner: 'mia', prompt: 'x', workOn: 'PR #77' }), /#77 on [^ ]+ was merged: start on an open pull request/);
  await assert.rejects(fleet.startPrivate({ owner: 'mia', prompt: 'x', workOn: 'PR #78' }), /#78 on [^ ]+ was closed/);
  github.pull = async () => ({ head: { ref: 'joel/pr-branch' } });
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
  assert.ok(fleet.find(fix.id).namedAt, 'the page is told the naming is over, for its rename offer');

  const look = await fleet.startPrivate({ owner: 'joel', prompt: 'Look at it' });
  answers['Look at it']('');
  await new Promise(setImmediate);
  assert.equal(fleet.find(look.id).title, 'Look at it', 'no name keeps the first line');
  assert.ok(fleet.find(look.id).namedAt, 'the rename is offered on the first line too');

  const renamed = await fleet.startPrivate({ owner: 'joel', prompt: 'Tidy up' });
  fleet.rename(renamed, 'My own name');
  answers['Tidy up']('Haiku name');
  await new Promise(setImmediate);
  assert.equal(fleet.find(renamed.id).title, 'My own name', 'a rename on the rail before the answer is kept');
  assert.equal(fleet.find(renamed.id).namedAt, undefined, 'and no rename is offered after one');

  const failed = await fleet.startPrivate({ owner: 'joel', prompt: 'Break it' });
  answers['Break it'](Promise.reject(new Error('Anthropic not reached')));
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.equal(fleet.find(failed.id).title, 'Break it');
  assert.ok(fleet.find(failed.id).namedAt, 'a failed naming offers the rename too');

  assert.equal((await fleet.startPrivate({ owner: 'joel', prompt: 'Fix x', name: 'Mine' })).title, 'Mine');
  assert.deepEqual(named, ['Fix the currency\nrounding too', 'Look at it', 'Tidy up', 'Break it'], 'a name given is not asked for');
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

test('a session started or resumed for a parent in its person\'s Herdr is told to wait for its terminal, that run alone', async () => {
  const { fleet, calls, statuses } = setup();
  const envOf = (session) => calls.started.filter((c) => c.env.SESSION_ID === session.id).at(-1).env;
  const child = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it', herdrParent: true });
  assert.equal(envOf(child).WOODSHED_HERDR_PARENT, '1', 'the entrypoint leaves the agent\'s terminal to the person\'s Herdr');
  const plain = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it' });
  assert.equal(envOf(plain).WOODSHED_HERDR_PARENT, undefined);
  const shared = await fleet.createSession({ kind: 'task', number: null, title: 's', startedBy: 'joel', trigger: 'console', prompt: 'p', herdrParent: true });
  assert.equal(envOf(shared).WOODSHED_HERDR_PARENT, undefined, 'a shared session never waits on someone\'s laptop');

  statuses[child.id] = { state: 'working' };
  await fleet.tick();
  await fleet.stop(child, 'stopped from the console', { by: 'joel' });
  await fleet.resumePrivate({ owner: 'joel', id: child.id });
  assert.equal(envOf(child).WOODSHED_HERDR_PARENT, undefined, 'Resume on the page makes its own terminal, as any session');
  statuses[child.id] = { state: 'working' };
  await fleet.tick();
  await fleet.stop(child, 'stopped from the console', { by: 'joel' });
  await fleet.resumePrivate({ owner: 'joel', id: child.id, herdrParent: true });
  assert.equal(envOf(child).WOODSHED_HERDR_PARENT, '1', 'woodshed session herdr --parent resumes it waiting');
});

test('each run of a person\'s own session gets a start token, kept only as its hash, and none once it stops', async () => {
  const { fleet, calls, statuses, store } = setup();
  const envOf = (session) => calls.started.filter((c) => c.env.SESSION_ID === session.id).at(-1).env;
  const mine = await fleet.startPrivate({ owner: 'joel', prompt: 'Plan the billing page' });
  const token = envOf(mine).WOODSHED_START_TOKEN;
  assert.match(token, /^wst_[0-9a-f]{64}$/);
  assert.equal(mine.startTokenHash, startTokenHash(token));
  assert.ok(!JSON.stringify(store.state).includes(token), 'the console keeps the hash, never the token');
  assert.equal(sessionForStartToken(token, fleet.sessions())?.id, mine.id);

  const shared = await fleet.createSession({ kind: 'task', number: null, title: 's', startedBy: 'joel', trigger: 'console', prompt: 'p' });
  assert.equal(envOf(shared).WOODSHED_START_TOKEN, undefined, 'a shared session has no one person to start sessions as');

  const child = await fleet.startPrivate({ owner: 'joel', prompt: 'Add CSV export', startedFrom: mine.id });
  assert.equal(child.startedFrom, mine.id);
  assert.equal(child.startedApart, undefined, 'a piece of the starting session\'s work');
  const apart = await fleet.startPrivate({ owner: 'joel', prompt: 'Audit refunds', startedFrom: mine.id, startedApart: true });
  assert.deepEqual([apart.startedFrom, apart.startedApart], [mine.id, true], 'work of its own, still saying where it came from');
  const ofTeam = await fleet.createSession({ kind: 'task', number: null, title: 't', startedBy: 'joel', trigger: 'label', startedFrom: mine.id, startedApart: true });
  assert.deepEqual([ofTeam.startedFrom, ofTeam.startedApart], [undefined, undefined], 'only a person\'s own session says where it came from');

  statuses[mine.id] = { state: 'working' };
  await fleet.tick();
  await fleet.stop(mine, 'stopped from the console', { by: 'joel' });
  assert.equal(mine.startTokenHash, null, 'a stopped session starts nothing more');
  assert.equal(sessionForStartToken(token, fleet.sessions()), null);
  assert.equal(fleet.find(child.id).status, 'starting', 'stopping it does nothing to the session it started');

  await fleet.resumePrivate({ owner: 'joel', id: mine.id });
  const again = envOf(mine).WOODSHED_START_TOKEN;
  assert.ok(again && again !== token, 'a resume is a new run, with a token of its own');
  assert.equal(sessionForStartToken(token, fleet.sessions()), null, 'the last run\'s token still does nothing');
  assert.equal(sessionForStartToken(again, fleet.sessions())?.id, mine.id);

  // Once it has seen production data it starts nothing, whatever token it holds.
  mine.taintedAt = new Date().toISOString();
  assert.equal(sessionForStartToken(again, fleet.sessions()), null);
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

  // The agents its owner started beside its own in the last run, and what they were allowed, are not this run's.
  await fleet.stop(fresh, 'stopped from the console');
  fleet.allowAgent(fresh, 'codex');
  fresh.agents = [{ id: 'agent-2', agent: 'codex' }];
  await fleet.resumePrivate({ owner: 'joel', id: fresh.id });
  assert.equal(fresh.extraAgents, null);
  assert.equal(fresh.agents, null);
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

async function sessionWithPull({ createdAt, ...options }) {
  const slack = { available: true, posts: [], async postPr(pr) { this.posts.push(pr); return true; } };
  const ctx = setup({ slack, ...options });
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

test('a My Woodshed session\'s pull request is watched until it passes, and never posted to Slack', async () => {
  const { fleet, github, slack, statuses, session, store, calls, advance } = await sessionWithPull({ createdAt: '2026-10-20T09:00:00Z' });
  session.owner = 'joel';
  github.pull = async (number) => ({ number, title: 'Add GTM', created_at: '2026-10-20T09:00:00Z', state: 'open', head: { sha: 'abc' }, user: { login: 'Joel' } });
  github.reviews = async () => [{
    id: 1, user: { login: 'review-bot[bot]' }, state: 'CHANGES_REQUESTED', body: '## Code review', commit_id: 'abc', html_url: 'https://github.com/o/r/pull/7#r1',
  }];
  github.checkRuns = async () => e2eRuns();
  statuses[session.id] = { state: 'done', prUrl: 'https://github.com/o/r/pull/7' };
  await fleet.tick();
  assert.deepEqual(store.state.slackPending.map((p) => [p.number, p.watch]), [[7, true]], 'watched, though older than the session: its owner opened it');
  assert.deepEqual([...fleet.slackWaiting()], [], 'not waiting for Slack');
  const sent = () => calls.statusd.filter((c) => c.path === '/send').map((c) => c.body.text);
  assert.equal(sent().length, 1);
  assert.match(sent()[0], /asks for changes/);

  github.pull = async (number) => ({ number, title: 'Add GTM', created_at: '2026-10-20T09:00:00Z', state: 'open', head: { sha: 'def' } });
  github.reviews = async () => approvedReview();
  github.checkRuns = async () => e2eRuns();
  advance(60_000);
  await fleet.tick();
  assert.match(sent()[1], /^PR #7 at def passed its review and suites: the review verdict is APPROVE/);
  advance(60_000);
  await fleet.tick();
  assert.equal(sent().length, 2, 'the pass is told once for its commit');
  assert.deepEqual(slack.posts, []);
  assert.equal(session.status, 'running', 'a pass does not stop it');
  assert.equal(store.state.slackPending.length, 1, 'still watched, for a fix pushed after the approval');

  await fleet.stop(session, 'idle for 1 h');
  advance(60_000);
  await fleet.tick();
  assert.deepEqual(store.state.slackPending, [], 'its session ended');
  assert.equal(session.status, 'stopped', 'never resumed by the console');
});

for (const [what, fields, author] of [
  ['a review-only session, which only reads it', { reviewOnly: true }, 'joel'],
  ['a teammate\'s pull request older than the session', {}, 'ana-dev'],
]) {
  test(`a My Woodshed session is never told to fix ${what}`, async () => {
    const { fleet, github, statuses, session, store, calls } = await sessionWithPull({ createdAt: '2026-10-20T09:00:00Z' });
    Object.assign(session, { owner: 'joel', ...fields });
    github.pull = async (number) => ({ number, created_at: '2026-10-20T09:00:00Z', state: 'open', head: { sha: 'abc' }, user: { login: author } });
    github.reviews = async () => [{ id: 1, user: { login: 'review-bot[bot]' }, state: 'CHANGES_REQUESTED', body: '## Code review', commit_id: 'abc', html_url: 'u' }];
    github.checkRuns = async () => e2eRuns();
    statuses[session.id] = { state: 'done', prUrl: 'https://github.com/o/r/pull/7' };
    await fleet.tick();
    await fleet.tick();
    assert.deepEqual(store.state.slackPending ?? [], []);
    assert.deepEqual(calls.statusd.filter((c) => c.path === '/send'), []);
  });
}

test('a My Woodshed session\'s pull request is watched on a console with no Slack, and again once resumed', async () => {
  const { fleet, github, statuses, calls, store, advance, launcher } = setup();
  const session = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it' });
  github.pull = async (number) => ({ number, created_at: '2026-10-21T10:05:00Z', state: 'open', head: { sha: 'abc' }, user: { login: 'joel' } });
  github.reviews = async () => [];
  github.checkRuns = async () => e2eRuns((n) => (n === 2 ? 'failure' : 'success'));
  statuses[session.id] = { state: 'done', prUrl: 'https://github.com/o/r/pull/9' };
  await fleet.tick();
  await fleet.tick();
  const sent = () => calls.statusd.filter((c) => c.path === '/send' && c.id === session.id);
  assert.equal(sent().length, 1);
  assert.match(sent()[0].body.text, /e2e suite failed on PR #9/);

  // A stop in flight (its checkpoint and task stop take a while) while the pull request is read.
  let release;
  const { stop } = launcher;
  launcher.stop = (ref) => new Promise((resolve) => { release = () => resolve(stop.call(launcher, ref)); });
  const stopping = fleet.stop(session, 'idle for 1 h');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.status, 'stopping');
  github.checkRuns = async () => e2eRuns((n) => (n === 4 ? 'failure' : 'success'));
  advance(60_000);
  await fleet.tick();
  assert.deepEqual([store.state.slackPending, session.pendingMessages], [[], []], 'a stopping session hears nothing, and nothing is held for a Resume');
  release();
  await stopping;
  await fleet.resumePrivate({ owner: 'joel', id: session.id });
  github.checkRuns = async () => e2eRuns((n) => (n === 3 ? 'failure' : 'success'));
  await fleet.tick();
  await fleet.tick();
  assert.deepEqual(store.state.slackPending.map((p) => [p.number, p.sessionId]), [[9, session.id]], 'watched again once resumed');
  assert.match(sent().at(-1).body.text, /e2e run \(3\/4\)/);
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

test('a start waiting for room shows the steps its launcher reports, saved only when they change, and drops them when it starts', async () => {
  const ctx = setup();
  const saves = [];
  ctx.store.save = () => saves.push(1);
  let answer = { steps: [
    { label: 'Creating a machine', state: 'done', at: '2026-10-21T09:59:00.000Z' },
    { label: 'Installing  Docker', state: 'current', note: ' layer 3\nof 7 ', at: '2026-10-21T09:59:40Z' },
    { label: 'Starting the databases', state: 'pending' },
    { label: 'Not a state the page knows', state: 'skipped' },
    { label: '', state: 'pending' },
  ] };
  ctx.fail.start = 'Capacity is unavailable: the machine is being set up';
  const asked = [];
  ctx.launcher.progress = async (id) => { asked.push(id); return answer; };
  await ctx.fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = ctx.fleet.sessions();
  assert.equal(session.status, 'queued');
  assert.deepEqual(asked, [session.id], 'read as soon as the start goes back in the queue');
  assert.deepEqual(session.waitProgress.steps, [
    { label: 'Creating a machine', state: 'done', note: null, at: '2026-10-21T09:59:00.000Z' },
    { label: 'Installing Docker', state: 'current', note: 'layer 3 of 7', at: '2026-10-21T09:59:40.000Z' },
    { label: 'Starting the databases', state: 'pending', note: null, at: null },
  ]);

  const saved = saves.length;
  await ctx.fleet.checkWaiting();
  assert.equal(saves.length, saved, 'the same steps are not saved again');
  answer = { steps: [{ label: 'Creating a machine', state: 'failed', note: 'out of capacity' }] };
  await ctx.fleet.checkWaiting();
  assert.deepEqual(session.waitProgress.steps.map((s) => s.state), ['failed']);
  ctx.launcher.progress = async () => { throw new Error('database unreachable'); };
  await ctx.fleet.checkWaiting();
  assert.deepEqual(session.waitProgress.steps.map((s) => s.state), ['failed'], 'a read that fails keeps the last steps');

  ctx.launcher.progress = async () => answer;
  ctx.fail.start = false;
  ctx.advance(61_000);
  await ctx.fleet.tick();
  assert.equal(session.status, 'starting');
  assert.equal(session.waitProgress, null, 'a session that starts has its start checklist instead');
  answer = { steps: [{ label: 'Creating a machine', state: 'done' }] };
  await ctx.fleet.checkWaiting();
  assert.equal(session.waitProgress, null, 'only a session waiting for room is asked');
});

test('a launcher whose progress never answers holds up neither the queue nor the next read', async () => {
  const ctx = setup();
  ctx.fail.start = 'Capacity is unavailable: the machine is being set up';
  let reads = 0;
  ctx.launcher.progress = () => { reads += 1; return new Promise(() => {}); };
  await ctx.fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  ctx.fail.start = false;
  await ctx.fleet.handleTrigger({ number: 43, login: 'joel', trigger: 'label', title: 'y', kind: 'issue' });
  const [waiting, next] = ctx.fleet.sessions();
  assert.deepEqual([waiting.status, next.status], ['queued', 'starting'], 'the start behind it went on');
  assert.equal(reads, 1);
});

test('a launcher with no progress leaves a waiting start as it was', async () => {
  const ctx = setup();
  ctx.fail.start = 'aws ecs run-task failed: RESOURCE:CPU';
  await ctx.fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  await ctx.fleet.checkWaiting();
  const [session] = ctx.fleet.sessions();
  assert.equal(session.status, 'queued');
  assert.equal(session.waitProgress, null);
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

test('a console that makes no shared databases still runs a session from GitHub on its starter\'s plan', async () => {
  // A hosted pool's console has no db-admin, and a project with no Postgres or Mongo gets none: the entrypoint asks
  // /settings for the plan alone, so neither may send it to a team key the console may not have.
  for (const databases of [undefined, { available: false, async createForSession() { throw new Error('none made'); }, async sweep() {} }]) {
    const ctx = setup({ userSettings: ownTokens(), databases });
    await ctx.fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
    const [session] = ctx.fleet.sessions();
    assert.equal(session.plan, 'joel');
    assert.equal(session.status, 'starting', 'no databases asked for');
    assert.match(ctx.calls.comments[0].body, /on @joel's own Claude plan\.$/m);
  }
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

test('a review or QA run the console started on a pull request cannot be assigned: it runs by itself and ends', async () => {
  const { fleet, store } = setup({ assignables: ['joel'] });
  store.state.sessions.push(
    { id: 'cccc3333', owner: null, kind: 'pr', number: 7, trigger: 'review', review: { sha: 'a' } },
    { id: 'dddd4444', owner: null, kind: 'pr', number: 7, trigger: 'qa', qa: { sha: 'a' } },
  );
  assert.throws(() => fleet.assign({ id: 'cccc3333', by: 'joel', to: 'joel' }), /a review or QA run has nobody to assign/);
  assert.throws(() => fleet.assign({ id: 'dddd4444', by: 'joel', to: 'joel' }), /a review or QA run has nobody to assign/);
  assert.equal(store.state.sessions[0].assignee, undefined);
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

test('a Needs a human comment on a pull request goes to the session working on it, not a review session started after it', async () => {
  const told = [];
  const pings = { needsYou: async () => true, gaveUp: async () => true, needsHuman: async (s) => { told.push(s.id); return true; } };
  const { fleet, store } = setup({ assignables: ['joel'], pings });
  store.state.sessions.push(
    { id: 'wwwwwwww', repo: 'o/r', kind: 'issue', number: 3, title: 'w', startedBy: 'joel', assignee: 'joel', status: 'running', prUrl: 'https://github.com/o/r/pull/7', createdAt: '2026-10-21T09:00:00.000Z', pendingMessages: [] },
    { id: 'rrrrrrrr', repo: 'o/r', kind: 'pr', number: 7, title: 'Review: w', startedBy: 'joel', trigger: 'review', status: 'running', createdAt: '2026-10-21T09:30:00.000Z', pendingMessages: [], review: { sha: 'a' } },
  );
  store.state.github ??= { seenComments: [] };
  store.state.github.seenComments ??= [];
  const result = await fleet.handleNeedsHuman({ number: 7, commentId: 601, url: 'https://github.com/o/r/pull/7#issuecomment-601', body: 'Needs a human: x' });
  assert.deepEqual(result, { outcome: 'sent', sessionId: 'wwwwwwww' });
  assert.deepEqual(told, ['wwwwwwww']);
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

test('a session on the default repo an admin added to a console that started with none clones it, since no image holds it', async () => {
  // As liveConfig marks the first repo added when the environment names none.
  const projects = [{ name: 'api', repo: 'acme/api', default: true, clonedAtStart: true }, { name: 'web', repo: 'acme/web', default: false }];
  const { fleet, calls } = setup({ projects });
  await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it' });
  await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it', project: projects[1] });
  assert.deepEqual(calls.started.map((s) => s.env.PROJECT_REPO), ['acme/api', 'acme/web']);
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

const AUTO_GATES = { ...QA_GATES, qa: { ...QA_GATES.qa, autoLabel: true } };
const APP = { slug: 'woodshed-console', login: 'woodshed-console[bot]' };

test('with qa.autoLabel, a new pull request gets the QA label once, and not a draft, a fork or one already labelled', async () => {
  const t = qaSetup({ gates: AUTO_GATES });
  const added = [];
  t.github.addLabel = async (number, label) => { added.push([number, label]); };
  t.github.pull = async () => ({ ...QA_PULL, labels: [], user: { login: 'joel' } });
  assert.equal((await t.fleet.qaAutoLabel({ number: 7 })).outcome, 'labelled');
  for (const pull of [{ ...QA_PULL }, { ...QA_PULL, labels: [], draft: true }, { ...QA_PULL, labels: [], head: { ...QA_PULL.head, repo: { full_name: 'someone/fork' } } }]) {
    t.github.pull = async () => pull;
    assert.deepEqual(await t.fleet.qaAutoLabel({ number: 7 }), { unrecorded: true });
  }
  assert.deepEqual(added, [[7, 'qa']]);
  const off = qaSetup();
  off.github.addLabel = async () => { throw new Error('no label without autoLabel'); };
  assert.deepEqual(await off.fleet.qaAutoLabel({ number: 7 }), { unrecorded: true });
});

test('a QA label the console added waits for the approval, then runs as the author', async () => {
  const t = qaSetup({ gates: AUTO_GATES, ownApp: () => APP });
  const pull = { ...QA_PULL, user: { login: 'joel' } };
  t.github.pull = async () => pull;
  t.github.reviews = async () => reviewOn('b'.repeat(40));
  assert.equal((await t.fleet.handleQaLabel({ number: 7, label: 'qa', login: APP.login })).outcome, 'waiting', 'only after the review approves');
  t.github.reviews = async () => reviewOn(pull.head.sha);
  t.github.labeledBy = async () => APP.login;
  assert.equal((await t.fleet.qaAfterReview({ number: 7 })).outcome, 'started');
  const [session] = t.fleet.sessions();
  assert.deepEqual([session.startedBy, session.qa.teamKey], ['joel', undefined]);
});

test('a console-added QA label runs on the team key for an author who fails the identity checks, and never for a fork', async () => {
  const reused = qaSetup({ gates: AUTO_GATES, ownApp: () => APP, people: { check: async () => false }, userSettings: ownTokens(), databases: madeDatabases() });
  reused.github.pull = async () => ({ ...QA_PULL, user: { login: 'joel' } });
  assert.equal((await reused.fleet.handleQaLabel({ number: 7, label: 'qa', login: APP.login })).outcome, 'started');
  assert.deepEqual([reused.fleet.sessions()[0].qa.teamKey, reused.fleet.sessions()[0].plan], [true, null], 'never the old person\'s plan');
  const off = qaSetup({ ownApp: () => APP });
  off.github.pull = async () => ({ ...QA_PULL, user: { login: 'joel' } });
  assert.equal((await off.fleet.handleQaLabel({ number: 7, label: 'qa', login: APP.login })).reason, 'no write access to the repo', 'without autoLabel, the App\'s label is refused as before');
  const fork = qaSetup({ gates: AUTO_GATES, ownApp: () => APP });
  fork.github.pull = async () => ({ ...QA_PULL, user: { login: 'joel' }, head: { ...QA_PULL.head, repo: { full_name: 'someone/fork' } } });
  assert.equal((await fork.fleet.handleQaLabel({ number: 7, label: 'qa', login: APP.login })).reason, 'the pull request is from a fork');
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
  assert.match(calls.comments[0].body, /^## QA\n\n\*\*Running\*\*/);
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

test('a QA session\'s videos and still are kept by the console, and its comment shows the still linked to them', async () => {
  const saved = [];
  const qaRecordings = {
    async saveVideo(id, n, video) { saved.push(['video', id, n, video]); return { key: `${id}/video-${n}.webm` }; },
    async savePoster(id, png) { saved.push(['poster', id, png]); return { path: `/qa-poster/${id}/${'e'.repeat(32)}.png` }; },
  };
  const { fleet, calls } = qaSetup({ qaRecordings });
  await fleet.handleQaLabel({ number: 7, label: 'qa', login: 'joel' });
  const [session] = fleet.sessions();
  const video = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
  assert.deepEqual(await fleet.qaVideo(session, video), { n: 1 });
  assert.deepEqual(await fleet.qaVideo(session, video), { n: 2 });
  await fleet.qaPoster(session, Buffer.from('png'));
  assert.deepEqual(saved.map((s) => s.slice(0, 3)), [['video', session.id, 1], ['video', session.id, 2], ['poster', session.id, Buffer.from('png')]]);
  assert.ok(saved[0][3].equals(video));

  await fleet.qaFinished(session, { verdict: QA_VERDICT, report: '## TC-1: a ✅', sha: 'a'.repeat(40), costUsd: 1 });
  await settle();
  const body = calls.comments.at(-1).body;
  const base = `https://console.test/qa/${session.id}/video`;
  assert.ok(body.includes(`[![The QA run's recording](https://console.test/qa-poster/${session.id}/${'e'.repeat(32)}.png)](${base}/1)`), body);
  assert.ok(body.includes(`[page 1](${base}/1)`) && body.includes(`[page 2](${base}/2)`));
  assert.doesNotMatch(body, /github\.com\/.*\.webm|refs\/woodshed-qa/, 'nothing in the repo');
  assert.equal(session.qa.videos.length, 2, 'kept past the report');
});

test('a console that keeps no QA recordings refuses a video, and the comment has no recording line', async () => {
  const { fleet, calls } = qaSetup();
  await fleet.handleQaLabel({ number: 7, label: 'qa', login: 'joel' });
  const [session] = fleet.sessions();
  await assert.rejects(fleet.qaVideo(session, Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1])), /keeps no QA recordings/);
  await fleet.qaFinished(session, { verdict: QA_VERDICT, report: '## TC-1: a ✅', sha: 'a'.repeat(40), costUsd: 1 });
  await settle();
  assert.doesNotMatch(calls.comments.at(-1).body, /Recording/);
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

const REVIEW_GATES = {
  ...PULL_GATES,
  review: { ...PULL_GATES.review, rerun: '[woodshed-review]', runner: 'woodshed' },
  mergeRisk: { check: 'Merge risk' },
};
const REVIEW_PULL = { state: 'open', draft: false, title: 'Add GTM', user: { login: 'joel' }, head: { ref: 'joel/gtm', sha: 'a'.repeat(40) }, base: { ref: 'main' } };
const REVIEW_RESULT = {
  conclusion: 'APPROVE', summary: 'Looks good.', comment: '> [!TIP]\n> **Merge risk: Low**',
  mergeRisk: { tier: 'Low', reason: 'Only a docs page.', summary: 'LOW\nOnly a docs page.' }, sha: 'a'.repeat(40), costUsd: 0.4,
};
function reviewSetup(options = {}) {
  const t = setup({ gates: REVIEW_GATES, ...options });
  t.github.pull = async () => REVIEW_PULL;
  return t;
}

test('a repo whose project file names no review is reviewed in a session on [woodshed-review], by default', async () => {
  const { fleet } = reviewSetup({ gates: null, reviewGates: withDefaultReview(null) });
  const started = await fleet.reviewOnTag({ number: 7 });
  assert.equal(started.outcome, 'started');
  const [session] = fleet.sessions();
  assert.deepEqual([session.trigger, session.review.heading, session.review.check], ['review', '## Woodshed review', null]);
});

test('a review asked for by hand on a repo whose project file names no review runs by the default', async () => {
  const { fleet, github } = reviewSetup({ gates: null });
  github.pull = async () => ({ ...REVIEW_PULL, user: { login: 'joel' } });
  const project = { name: 'r', repo: 'o/r', default: true };
  const started = await fleet.reviewOnDemand({ project, number: 7, login: 'joel' });
  assert.equal(started.outcome, 'started', JSON.stringify(started));
  assert.equal(fleet.sessions()[0].review.heading, '## Woodshed review');
});

test('the default review holds back no Slack post: a repo whose file names no review posts once out of draft and green, as before', async () => {
  const { fleet, github, slack, statuses, session } = await sessionWithPull({ createdAt: '2026-10-21T10:05:00Z', gates: null, reviewGates: withDefaultReview(null) });
  const pull = github.pull;
  github.pull = async (number) => ({ ...(await pull(number)), draft: false, html_url: `https://github.com/o/r/pull/${number}` });
  github.reviews = async () => [];
  github.checkRuns = async () => [{ name: 'test', status: 'completed', conclusion: 'success', html_url: 'u' }];
  statuses[session.id] = { state: 'working', prUrl: 'https://github.com/o/r/pull/7' };
  await fleet.tick();
  await fleet.tick();
  assert.deepEqual(slack.posts.map((p) => p.url), ['https://github.com/o/r/pull/7'], 'no approval waited for');
});

test('a coding session is told the review\'s tag, which its checkout\'s project file may not name; a review, QA or every-commit review is not', async () => {
  const tagged = setup({ gates: null, reviewGates: withDefaultReview(null) });
  await tagged.fleet.createSession({ kind: 'issue', number: 7, title: 'i', startedBy: 'joel', trigger: 'label', prompt: 'p' });
  assert.equal(tagged.calls.started.at(-1).env.WOODSHED_REVIEW_TAG, '[woodshed-review]');
  await tagged.fleet.createSession({ kind: 'pr', number: 10, title: 'Review', startedBy: 'joel', trigger: 'review', branch: 'a/d', review: { base: 'main', sha: 'b'.repeat(40), heading: '## R', author: null, check: null, commentId: null, agents: ['claude'] } });
  assert.equal(tagged.calls.started.at(-1).env.WOODSHED_REVIEW_TAG, undefined, 'the review session itself pushes nothing');
  const warned = [];
  const realWarn = console.warn;
  console.warn = (...args) => warned.push(args[0]);
  try {
    const unread = setup({ gates: null, reviewGates: async () => { throw new Error('the project file could not be read: HTTP 502'); } });
    await unread.fleet.createSession({ kind: 'issue', number: 7, title: 'i', startedBy: 'joel', trigger: 'label', prompt: 'p' });
    assert.equal(unread.calls.started.length, 1, 'the session starts all the same');
    assert.equal(unread.calls.started[0].env.WOODSHED_REVIEW_TAG, undefined);
    assert.ok(warned.includes('fleet: review tag not read, the session starts with none'));
  } finally {
    console.warn = realWarn;
  }
  const everyCommit = setup({ gates: { review: { runner: 'woodshed', heading: '## R', rerun: null }, suites: [], qa: null, mergeRisk: null } });
  await everyCommit.fleet.createSession({ kind: 'issue', number: 7, title: 'i', startedBy: 'joel', trigger: 'label', prompt: 'p' });
  assert.equal(everyCommit.calls.started.at(-1).env.WOODSHED_REVIEW_TAG, undefined);
});

test('the review tag on the head starts a review session, once for the commit, only when the runner is woodshed', async () => {
  const { fleet } = reviewSetup();
  const started = await fleet.reviewOnTag({ number: 7 });
  assert.equal(started.outcome, 'started');
  const [session] = fleet.sessions();
  assert.deepEqual([session.trigger, session.review.sha, session.review.base, session.review.check], ['review', 'a'.repeat(40), 'main', 'Merge risk']);
  assert.deepEqual(await fleet.reviewOnTag({ number: 7 }), { unrecorded: true }, 'already reviewing this commit');

  const actions = setup({ gates: { ...REVIEW_GATES, review: { ...REVIEW_GATES.review, runner: 'actions' } } });
  actions.github.pull = async () => REVIEW_PULL;
  assert.deepEqual(await actions.fleet.reviewOnTag({ number: 7 }), { unrecorded: true }, 'the actions runner stays in CI');
});

test('a review its author asks for starts on the head now, tag or not, and only on their own open pull request', async () => {
  const project = { name: 'r', repo: 'o/r', default: true };
  const { fleet, github } = reviewSetup();
  github.commitMessage = async () => 'No tag here';
  const started = await fleet.reviewOnDemand({ project, number: 7, login: 'joel' });
  assert.equal(started.outcome, 'started');
  const [session] = fleet.sessions();
  assert.deepEqual([session.id, session.trigger, session.review.sha], [started.sessionId, 'review', 'a'.repeat(40)]);
  assert.deepEqual(await fleet.reviewOnDemand({ project, number: 7, login: 'joel' }), { outcome: 'running', sessionId: session.id }, 'its head is being reviewed');
  assert.equal(fleet.sessions().length, 1);

  const someoneElse = await fleet.reviewOnDemand({ project, number: 7, login: 'mia' });
  assert.deepEqual([someoneElse.outcome, someoneElse.status], ['refused', 403]);
  assert.match(someoneElse.reason, /not your pull request/);

  const draft = reviewSetup();
  draft.github.pull = async () => ({ ...REVIEW_PULL, draft: true });
  assert.deepEqual(await draft.fleet.reviewOnDemand({ project, number: 7, login: 'joel' }), { outcome: 'refused', status: 409, reason: '#7 is a draft: mark it ready for review first' });

  const missing = reviewSetup();
  missing.github.pull = async () => { throw new Error('gh: Not Found (HTTP 404)'); };
  assert.equal((await missing.fleet.reviewOnDemand({ project, number: 7, login: 'joel' })).status, 404);

  const actions = setup({ gates: { ...REVIEW_GATES, review: { ...REVIEW_GATES.review, runner: 'actions' } } });
  actions.github.pull = async () => REVIEW_PULL;
  const off = await actions.fleet.reviewOnDemand({ project, number: 7, login: 'joel' });
  assert.deepEqual([off.outcome, off.status], ['refused', 409]);
  assert.equal(off.reason, 'o/r\'s project file runs its review in GitHub Actions, not in this console: its pullRequests.review chooses that runner');

  const elsewhere = setup({ gates: { ...REVIEW_GATES, runsOn: 'other-console[bot]' }, ownApp: () => ({ login: 'woodshed-cloud[bot]' }) });
  elsewhere.github.pull = async () => REVIEW_PULL;
  const ran = await elsewhere.fleet.reviewOnDemand({ project, number: 7, login: 'joel' });
  assert.deepEqual([ran.status, ran.reason], [409, 'o/r\'s pullRequests.runsOn names another console (other-console[bot]), which runs its reviews']);
  assert.equal(elsewhere.fleet.sessions().length, 0);
  assert.equal(actions.fleet.sessions().length, 0);

  const none = reviewSetup({ reviewAgents: { forReview: async () => ({ agents: [], choice: 'none', why: null }) } });
  const chose = await none.fleet.reviewOnDemand({ project, number: 7, login: 'joel' });
  assert.deepEqual(chose, { outcome: 'refused', status: 409, reason: 'the author chose no code review' });
});

test('a review asked for again after one stopped with no verdict starts anew, and two asks at once start one', async () => {
  const project = { name: 'r', repo: 'o/r', default: true };
  const { fleet } = reviewSetup();
  const first = await fleet.reviewOnDemand({ project, number: 7, login: 'joel' });
  const [session] = fleet.sessions();
  Object.assign(session, { status: 'failed' });
  const again = await fleet.reviewOnDemand({ project, number: 7, login: 'joel' });
  assert.equal(again.outcome, 'started', 'a failed review gave no verdict, so it may be asked again');
  assert.notEqual(again.sessionId, first.sessionId);
  const second = fleet.sessions().find((s) => s.id === again.sessionId);
  Object.assign(second, { status: 'stopped', review: { ...second.review, conclusion: 'APPROVE' } });
  assert.deepEqual(await fleet.reviewOnDemand({ project, number: 7, login: 'joel' }), { outcome: 'reviewed', sessionId: second.id });

  const both = reviewSetup();
  const [a, b] = await Promise.all([1, 2].map(() => both.fleet.reviewOnDemand({ project, number: 7, login: 'joel' })));
  assert.equal(both.fleet.sessions().length, 1);
  assert.deepEqual([a.outcome, b.outcome, b.status], ['started', 'refused', 409]);
  assert.match(b.reason, /being started already/);
  const tagged = reviewSetup();
  tagged.github.commitMessage = async () => 'Fix it [woodshed-review]';
  await Promise.all([tagged.fleet.reviewOnDemand({ project, number: 7, login: 'joel' }), tagged.fleet.reviewOnTag({ number: 7 })]);
  assert.equal(tagged.fleet.sessions().length, 1, 'a tagged commit and an ask at once start one review');

  // An ask that starts nothing (not the author's) does not drop a tagged commit's review that lands meanwhile.
  const outsider = reviewSetup();
  outsider.github.commitMessage = async () => 'Fix it [woodshed-review]';
  const [refused, tagStart] = await Promise.all([outsider.fleet.reviewOnDemand({ project, number: 7, login: 'mia' }), outsider.fleet.reviewOnTag({ number: 7 })]);
  assert.deepEqual([refused.status, tagStart.outcome], [403, 'started']);

  // A verdict GitHub did not take is no review of that head: asking again starts one.
  const unposted = reviewSetup();
  const firstAsk = await unposted.fleet.reviewOnDemand({ project, number: 7, login: 'joel' });
  const s1 = unposted.fleet.sessions().find((x) => x.id === firstAsk.sessionId);
  Object.assign(s1, { status: 'stopped', review: { ...s1.review, conclusion: 'APPROVE', posted: false } });
  assert.equal((await unposted.fleet.reviewOnDemand({ project, number: 7, login: 'joel' })).outcome, 'started');
});

test('a review runs whom its author chose, and says so on the pull request', async () => {
  const both = { forReview: async () => ({ agents: ['claude', 'codex'], why: null }) };
  const { fleet, calls } = reviewSetup({ reviewAgents: both });
  await fleet.reviewOnTag({ number: 7 });
  const [session] = fleet.sessions();
  assert.deepEqual(session.review.agents, ['claude', 'codex']);
  await fleet.tick();
  assert.equal(calls.started[0].env.REVIEW_AGENTS, 'claude codex');
  assert.match(calls.comments[0].body, /Reviewing\*\* with Claude Code and Codex/);
  assert.equal(calls.started[0].env.REVIEW_CODEX_AUTH, 'key', 'the team key, through the console');
  assert.equal(calls.started[0].env.REVIEW_CODEX_ACCOUNT, undefined);

  const own = reviewSetup({ reviewAgents: { forReview: async ({ login }) => ({ agents: ['claude', 'codex'], codexLogin: login, codexVia: 'chatgpt', codexAccount: 'acct-joel', why: null }) } });
  await own.fleet.reviewOnTag({ number: 7 });
  await own.fleet.tick();
  const ownEnv = own.calls.started[0].env;
  assert.equal(ownEnv.REVIEW_CODEX_AUTH, 'chatgpt');
  assert.equal(ownEnv.REVIEW_CODEX_ACCOUNT, 'acct-joel', 'the account, an id the stand-in login names');
  assert.ok(!Object.keys(ownEnv).some((k) => /CODEX_AUTH_JSON|OPENAI_API_KEY/.test(k)), 'no sign-in in the session');

  const alone = reviewSetup({ reviewAgents: { forReview: async () => ({ agents: ['claude'], why: 'the console has no OpenAI key' }) } });
  await alone.fleet.reviewOnTag({ number: 7 });
  await alone.fleet.tick();
  assert.deepEqual(alone.fleet.sessions()[0].review.agents, ['claude']);
  assert.equal(alone.calls.started[0].env.REVIEW_AGENTS, 'claude');
  assert.doesNotMatch(alone.calls.comments[0].body, /Codex/);

  const codex = reviewSetup({ reviewAgents: { forReview: async () => ({ agents: ['codex'], choice: 'codex', codexVia: 'key', why: null }) } });
  await codex.fleet.reviewOnTag({ number: 7 });
  await codex.fleet.tick();
  assert.equal(codex.calls.started[0].env.REVIEW_AGENTS, 'codex');
  assert.equal(codex.calls.started[0].env.REVIEW_CODEX_AUTH, 'key');
  assert.match(codex.calls.comments[0].body, /Reviewing\*\* with Codex in/);
});

test('a review on its author\'s Grok Build and OpenCode sign-ins records whose they are, and the session gets none of them', async (t) => {
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')));
  const ownSignIns = { grok: { login: 'joel', via: 'login' }, opencode: { login: 'joel', provider: 'openai' } };
  const { fleet, calls } = reviewSetup({ reviewAgents: { forReview: async () => ({ agents: ['claude', 'grok', 'opencode'], choice: 'claude+grok+opencode', ownSignIns, why: null }) } });
  await fleet.reviewOnTag({ number: 7 });
  const [session] = fleet.sessions();
  assert.deepEqual(session.review.ownSignIns, ownSignIns);
  await fleet.tick();
  const env = calls.started[0].env;
  assert.equal(env.REVIEW_AGENTS, 'claude grok opencode');
  assert.equal(env.REVIEW_OPENCODE_PROVIDER, 'openai', 'which provider its config points at the console');
  assert.equal(env.REVIEW_CODEX_AUTH, undefined);
  assert.ok(!Object.keys(env).some((k) => /XAI_API_KEY|AGENT_AUTH|GROK|OPENAI_API_KEY|ANTHROPIC_API_KEY/.test(k)), 'no sign-in in the session');
  assert.match(calls.comments[0].body, /Reviewing\*\* with Claude Code, Grok Build and OpenCode in/);
  assert.ok(lines.some((l) => l.includes('fleet: review session started') && l.includes('"grok":"own login"') && l.includes('"opencode":"own openai key"')));
});

test('team keys that could not be read start no review and skip nothing: QA and the Slack post keep waiting', async () => {
  const unread = { forReview: async () => ({ agents: [], choice: null, why: 'the team keys could not be read: timed out', keysUnread: true }) };
  const gates = { ...QA_GATES, review: { ...PULL_GATES.review, rerun: '[woodshed-review]', runner: 'woodshed' } };
  const { fleet, github, store } = setup({ gates, reviewAgents: unread });
  github.pull = async () => ({ ...REVIEW_PULL, labels: [{ name: 'qa' }] });
  github.reviews = async () => [];
  github.labeledBy = async () => 'joel';
  assert.deepEqual(await fleet.reviewOnTag({ number: 7 }), { outcome: 'ignored', reason: 'the team keys could not be read, so whom to review with is not known' });
  assert.equal(fleet.sessions().length, 0);
  assert.equal(store.state.reviewSkips, undefined, 'no skip recorded');
  assert.equal((await fleet.handleQaLabel({ number: 7, label: 'qa', login: 'joel' })).outcome, 'waiting', 'QA still waits for a review');
});

test('an author who chose no code review gets none, and QA and the Slack post go on without waiting for one', async () => {
  const none = { forReview: async () => ({ agents: [], choice: 'none', why: null }) };
  const gates = { ...QA_GATES, review: { ...PULL_GATES.review, rerun: '[woodshed-review]', runner: 'woodshed' } };
  const { fleet, calls, github, store } = setup({ gates, reviewAgents: none });
  github.pull = async () => ({ ...REVIEW_PULL, labels: [{ name: 'qa' }] });
  github.reviews = async () => [];
  github.labeledBy = async () => 'joel';
  assert.deepEqual(await fleet.reviewOnTag({ number: 7 }), { outcome: 'ignored', reason: 'the author chose no code review' });
  assert.equal(fleet.sessions().length, 0, 'no review session');
  assert.equal(calls.comments.length, 0, 'nothing posted on the pull request');
  assert.equal(Object.values(store.state.reviewSkips)[0].why, 'the author chose no review');
  const qa = await fleet.handleQaLabel({ number: 7, label: 'qa', login: 'joel' });
  assert.equal(qa.outcome, 'started', 'QA does not wait for a review that will not come');

  const later = { forReview: async () => ({ agents: ['claude'], choice: 'claude', why: null }) };
  const again = setup({ gates, reviewAgents: later });
  again.store.state.reviewSkips = { ...store.state.reviewSkips };
  again.github.pull = async () => REVIEW_PULL;
  await again.fleet.reviewOnTag({ number: 7 });
  assert.deepEqual(again.store.state.reviewSkips, {}, 'a review that runs again clears the skip');
});

test('a review runs Codex on its author\'s own sign-in only when they pass the checks their Claude plan needs', async () => {
  const asked = [];
  const reviewAgents = { forReview: async ({ login }) => { asked.push(login); return { agents: ['claude', 'codex'], codexLogin: login, why: null }; } };
  const { fleet } = reviewSetup({ reviewAgents });
  await fleet.reviewOnTag({ number: 7 });
  assert.equal(fleet.sessions()[0].review.codexLogin, 'joel');

  const outsider = reviewSetup({ reviewAgents, githubSessions: [] });
  await outsider.fleet.reviewOnTag({ number: 7 });
  assert.deepEqual(asked, ['joel', null], 'someone without sessions from GitHub: nobody\'s own sign-in');
  assert.equal(outsider.fleet.sessions()[0].review.codexLogin, undefined);
});

test('a head without the review tag starts nothing', async () => {
  const { fleet, github } = reviewSetup();
  github.commitMessage = async () => 'feat: no tag here';
  assert.deepEqual(await fleet.reviewOnTag({ number: 7 }), { unrecorded: true });
  assert.equal(fleet.sessions().length, 0);
});

// #333 and #334: the review approved the head, then the session merged main in with git's own message, which carries
// no tag, and the repo dismissed the stale approval. The pull request sat with no approval and no review coming.
test('a push that dismissed the review\'s approval is reviewed again, tag or not', async () => {
  const approved = 'a'.repeat(40);
  const merged = 'b'.repeat(40);
  const untagged = (state) => {
    const t = reviewSetup();
    let head = approved;
    t.github.pull = async () => ({ ...REVIEW_PULL, head: { ...REVIEW_PULL.head, sha: head } });
    t.github.reviews = async () => [{ id: 1, user: { login: 'woodshed-reviewer[bot]' }, state, commit_id: approved, body: '## Woodshed review — APPROVE' }];
    return { ...t, push: (message) => { head = merged; t.github.commitMessage = async () => message; } };
  };

  const dismissed = untagged('DISMISSED');
  await dismissed.fleet.reviewOnTag({ number: 7 });
  await dismissed.fleet.reviewFinished(dismissed.fleet.sessions()[0], REVIEW_RESULT);
  dismissed.push("Merge remote-tracking branch 'origin/main' into woodshed/joel-1234abcd");
  const again = await dismissed.fleet.reviewOnTag({ number: 7 });
  assert.equal(again.outcome, 'started', JSON.stringify(again));
  assert.equal(dismissed.fleet.sessions()[1].review.sha, merged);
  assert.deepEqual(await dismissed.fleet.reviewOnTag({ number: 7 }), { unrecorded: true }, 'once for the commit');

  const kept = untagged('APPROVED');
  await kept.fleet.reviewOnTag({ number: 7 });
  await kept.fleet.reviewFinished(kept.fleet.sessions()[0], REVIEW_RESULT);
  kept.push("Merge branch 'main' into joel/gtm");
  assert.deepEqual(await kept.fleet.reviewOnTag({ number: 7 }), { unrecorded: true }, 'a repo that keeps stale approvals still has one');

  const changes = untagged('DISMISSED');
  await changes.fleet.reviewOnTag({ number: 7 });
  await changes.fleet.reviewFinished(changes.fleet.sessions()[0], { ...REVIEW_RESULT, conclusion: 'REQUEST_CHANGES' });
  changes.push('fix: half of it');
  assert.deepEqual(await changes.fleet.reviewOnTag({ number: 7 }), { unrecorded: true }, 'a fix after changes were asked for waits for the tag, as before');
});

test('reviewFinished submits the formal review and the Merge risk check as the console App, then stops', async () => {
  const { fleet, calls } = reviewSetup();
  await fleet.reviewOnTag({ number: 7 });
  const [session] = fleet.sessions();
  await fleet.reviewFinished(session, REVIEW_RESULT);
  assert.equal(calls.reviews.length, 1);
  assert.deepEqual([calls.reviews[0].number, calls.reviews[0].event, calls.reviews[0].sha], [7, 'APPROVE', 'a'.repeat(40)]);
  assert.ok(calls.reviews[0].body.startsWith(`${REVIEW_GATES.review.heading} — APPROVE`), 'starts with the heading the gate looks for');
  const risk = calls.checks.find((c) => c.name === 'Merge risk');
  assert.deepEqual([risk.conclusion, risk.title], ['neutral', 'Low: Only a docs page.']);
  assert.equal(fleet.sessions()[0].review.conclusion, 'APPROVE');
});

test('a finished review session ends: it is not kept, so it never shows Resume and a /woodshed comment does not resume it', async () => {
  const { fleet, statuses } = reviewSetup();
  await fleet.reviewOnTag({ number: 7 });
  const [session] = fleet.sessions();
  statuses[session.id] = { state: 'working' };
  await fleet.tick();
  assert.equal(session.status, 'running');

  await fleet.reviewFinished(session, REVIEW_RESULT);
  await settle();
  assert.equal(session.status, 'stopped');
  assert.match(session.stopReason, /^Review finished: APPROVE/);
  assert.equal(session.kept, undefined, 'a review is never resumed: the next commit gets a review of its own');
});

test('a finished review or QA run deletes the conversation it saved at its stop, which nothing would resume', async () => {
  const removed = [];
  const homes = { async remove(name) { removed.push(name); } };
  const review = reviewSetup({ homes });
  await review.fleet.reviewOnTag({ number: 7 });
  const [reviewed] = review.fleet.sessions();
  review.statuses[reviewed.id] = { state: 'working' };
  await review.fleet.tick();
  await review.fleet.reviewFinished(reviewed, REVIEW_RESULT);
  await settle();
  await review.fleet.tick();
  assert.deepEqual(removed, [sharedHomeName(reviewed.id)], 'the review\'s saved conversation');
  assert.equal(reviewed.homeDeletePending, false);

  const qa = qaSetup({ homes });
  await qa.fleet.handleQaLabel({ number: 7, label: 'qa', login: 'joel' });
  const [tested] = qa.fleet.sessions();
  qa.statuses[tested.id] = { state: 'working' };
  await qa.fleet.tick();
  await qa.fleet.qaFinished(tested, { verdict: QA_VERDICT, report: '## TC-1: a ✅', sha: 'a'.repeat(40), costUsd: 1 });
  await settle();
  await qa.fleet.tick();
  assert.deepEqual(removed.slice(1), [sharedHomeName(tested.id)], 'the QA run\'s saved conversation');
});

test('a QA run that stopped before its conversation was deleted at its stop has it deleted on the next tick, once', async () => {
  const removed = [];
  const { fleet, store } = setup({ homes: { async remove(name) { removed.push(name); } } });
  const old = (id, extra) => ({
    id, repo: 'o/r', kind: 'pr', number: 7, title: 'QA: x', startedBy: 'joel', trigger: 'qa', status: 'stopped',
    createdAt: '2026-10-21T09:00:00.000Z', stoppedAt: '2026-10-21T10:00:00.000Z', pendingMessages: [], qa: { sha: 'a' }, ...extra,
  });
  store.state.sessions.push(old('0a0a0a0a', {}), old('0c0c0c0c', { qa: undefined }), old('0b0b0b0b', { trigger: 'label', qa: undefined, kept: false, cleanedAt: '2026-10-22T10:00:00.000Z', homeDeletePending: false }));
  await fleet.tick();
  assert.deepEqual(removed, [sharedHomeName('0a0a0a0a'), sharedHomeName('0c0c0c0c')], 'each QA run\'s, by its trigger too, never a session already cleaned up');
  await fleet.tick();
  assert.equal(removed.length, 2, 'deleted once');
});

test('an ended review stays on the list while its approval is held for QA, then as long as a kept one did, so its commit is not reviewed again', async () => {
  const retention = { afterCloseMs: 3 * 24 * HOUR, withoutPrMs: 7 * 24 * HOUR, openPrMs: 14 * 24 * HOUR, slackGiveUpMs: 7 * 24 * HOUR, removeAfterDeleteMs: 0 };
  const { fleet, store, advance } = reviewSetup({ retention });
  const held = { sha: 'a'.repeat(40), summary: 's', inlineComments: [], resolved: [] };
  store.state.sessions.push({
    id: 'e0e0e0e0', repo: 'o/r', kind: 'pr', number: 7, title: 'Review: x', startedBy: 'joel', trigger: 'review', status: 'stopped',
    createdAt: '2026-10-21T09:00:00.000Z', stoppedAt: '2026-10-21T09:00:00.000Z', pendingMessages: [],
    homeDeletePending: false, review: { sha: 'a'.repeat(40), base: 'main', conclusion: 'APPROVE', reported: true, held },
  });
  await fleet.tick();
  assert.equal(fleet.sessions().length, 1, 'its held approval waits for QA on the record, even with Take off the list at 0');

  store.state.sessions[0].review.held = null;
  await fleet.tick();
  assert.equal(fleet.sessions().length, 1, 'released, it stays as long as a kept review stayed');
  assert.deepEqual(await fleet.reviewOnTag({ number: 7 }), { unrecorded: true }, 'so a pull request event does not review the commit again');

  advance(7 * 24 * HOUR);
  await fleet.tick();
  assert.equal(fleet.sessions().length, 0, 'then it goes');
});

test('an ended QA run with recordings stays on the list as long as they are kept, since they are watched as its session', async () => {
  const retention = { afterCloseMs: 3 * 24 * HOUR, withoutPrMs: 7 * 24 * HOUR, openPrMs: 14 * 24 * HOUR, slackGiveUpMs: 7 * 24 * HOUR, removeAfterDeleteMs: 2 * 24 * HOUR };
  const { fleet, store, advance } = qaSetup({ retention });
  const run = (id, qa) => ({
    id, repo: 'o/r', kind: 'pr', number: 7, title: 'QA: x', startedBy: 'joel', trigger: 'qa', status: 'stopped',
    createdAt: '2026-10-21T09:00:00.000Z', stoppedAt: '2026-10-21T09:00:00.000Z', cleanedAt: '2026-10-21T09:00:00.000Z',
    pendingMessages: [], homeDeletePending: false, qa: { base: 'main', sha: 'a'.repeat(40), conclusion: 'success', ...qa },
  });
  store.state.sessions.push(run('a1a1a1a1', { videos: [{ n: 1, bytes: 10 }] }), run('b2b2b2b2', {}));
  advance(3 * 24 * HOUR);
  await fleet.tick();
  assert.deepEqual(fleet.sessions().map((s) => s.id), ['a1a1a1a1'], 'one with no recording goes when the setting says');
  advance(10 * 24 * HOUR);
  await fleet.tick();
  assert.equal(fleet.sessions().length, 1, 'thirteen days on, its recording still plays');
  advance(2 * 24 * HOUR);
  await fleet.tick();
  assert.equal(fleet.sessions().length, 0, 'then it goes with them');
});

test('with a reviewer App, the verdict is submitted as it and not as the console App, which may be the author', async () => {
  const submitted = [];
  const reviewerApp = { configured: () => true, async submitReview(args) { submitted.push(args); return 1; } };
  const { fleet, calls } = reviewSetup({ reviewerApp });
  await fleet.reviewOnTag({ number: 7 });
  await fleet.reviewFinished(fleet.sessions()[0], REVIEW_RESULT);
  assert.equal(calls.reviews.length, 0, 'not as the console App');
  assert.deepEqual(submitted.map((s) => [s.repo, s.number, s.event, s.sha]), [['o/r', 7, 'APPROVE', 'a'.repeat(40)]]);
  assert.ok(calls.checks.some((c) => c.name === 'Merge risk'), 'the Merge risk check is still the console App\'s');
});

test('the inline comments go on the diff\'s lines with the verdict, and into its body when GitHub refuses a line', async () => {
  const comments = [{ path: 'console/a.mjs', line: 12, body: 'Throws on an empty list.' }];
  const { fleet, calls } = reviewSetup();
  await fleet.reviewOnTag({ number: 7 });
  await fleet.reviewFinished(fleet.sessions()[0], { ...REVIEW_RESULT, inlineComments: comments });
  assert.deepEqual(calls.reviews[0].comments, comments);

  const refused = reviewSetup();
  refused.github.createReview = async (number, review) => {
    if (review.comments.length) throw new Error('HTTP 422: Line could not be resolved');
    refused.calls.reviews.push({ number, ...review });
    return 2;
  };
  await refused.fleet.reviewOnTag({ number: 7 });
  await refused.fleet.reviewFinished(refused.fleet.sessions()[0], { ...REVIEW_RESULT, inlineComments: comments });
  assert.equal(refused.calls.reviews.length, 1, 'the verdict still went in');
  assert.match(refused.calls.reviews[0].body, /`console\/a\.mjs:12`: Throws on an empty list\./);
});

test('the merge risk is a label too, the other tiers taken off', async () => {
  const { fleet, calls } = reviewSetup();
  await fleet.reviewOnTag({ number: 7 });
  await fleet.reviewFinished(fleet.sessions()[0], { ...REVIEW_RESULT, mergeRisk: { tier: 'High', reason: 'Touches sign-in.', summary: 'HIGH' } });
  assert.deepEqual(calls.labelsMade, [{ name: 'merge risk: high', color: 'd93f0b', description: 'Set by the AI review' }]);
  assert.deepEqual(calls.labeled, [{ number: 7, label: 'merge risk: high' }]);
  assert.deepEqual(calls.unlabeled.map((u) => u.label).sort(), ['merge risk: low', 'merge risk: medium']);
});

test('after an APPROVE the review\'s own outdated threads and those it found fixed are resolved, and no one else\'s', async () => {
  const gates = { ...REVIEW_GATES, review: { ...REVIEW_GATES.review, author: 'woodshed-reviewer[bot]' } };
  const { fleet, calls, github } = reviewSetup({ gates });
  github.threads = [
    { id: 'T1', isResolved: false, isOutdated: true, commentId: 1, author: 'woodshed-reviewer' },
    { id: 'T2', isResolved: false, isOutdated: false, commentId: 2, author: 'woodshed-reviewer' },
    { id: 'T3', isResolved: false, isOutdated: false, commentId: 3, author: 'woodshed-reviewer' },
    { id: 'T4', isResolved: false, isOutdated: true, commentId: 4, author: 'joel' },
    { id: 'T5', isResolved: true, isOutdated: true, commentId: 5, author: 'woodshed-reviewer' },
  ];
  await fleet.reviewOnTag({ number: 7 });
  assert.equal(fleet.sessions()[0].review.author, 'woodshed-reviewer[bot]', 'the session knows whose comments are its own');
  await fleet.reviewFinished(fleet.sessions()[0], { ...REVIEW_RESULT, resolved: [2, 4] });
  assert.deepEqual(calls.resolvedThreads, ['T1', 'T2']);

  const changes = reviewSetup({ gates });
  changes.github.threads = github.threads;
  await changes.fleet.reviewOnTag({ number: 7 });
  await changes.fleet.reviewFinished(changes.fleet.sessions()[0], { ...REVIEW_RESULT, conclusion: 'REQUEST_CHANGES', resolved: [2] });
  assert.deepEqual(changes.calls.resolvedThreads, [], 'only after an approval');
});

test('reviewFinished does not submit for a commit that is no longer the head', async () => {
  const { fleet, calls, github } = reviewSetup();
  await fleet.reviewOnTag({ number: 7 });
  const [session] = fleet.sessions();
  github.pull = async () => ({ ...REVIEW_PULL, head: { ...REVIEW_PULL.head, sha: 'c'.repeat(40) } });
  await fleet.reviewFinished(session, REVIEW_RESULT);
  assert.deepEqual([calls.reviews, calls.checks.filter((c) => c.name === 'Merge risk')], [[], []]);
});

test('a review that wrote no verdict submits nothing and stops the session', async () => {
  const { fleet, calls } = reviewSetup();
  await fleet.reviewOnTag({ number: 7 });
  const [session] = fleet.sessions();
  await fleet.reviewFinished(session, { conclusion: null, sha: 'a'.repeat(40), costUsd: null });
  assert.deepEqual([calls.reviews, calls.checks.filter((c) => c.name === 'Merge risk')], [[], []]);
  assert.deepEqual([session.review.reported, session.review.conclusion], [true, null]);
});

test('a review session is not started for a pull request from a fork', async () => {
  const { fleet, github } = reviewSetup();
  github.pull = async () => ({ ...REVIEW_PULL, head: { ...REVIEW_PULL.head, repo: { full_name: 'someone/fork' } } });
  assert.equal((await fleet.reviewOnTag({ number: 7 })).reason, 'the pull request is from a fork');
  assert.equal(fleet.sessions().length, 0);
});

test('a review session runs for a same-repo pull request opened by the App', async () => {
  const { fleet, github } = reviewSetup();
  github.pull = async () => ({ ...REVIEW_PULL, user: { login: 'woodshed-console[bot]' }, head: { ...REVIEW_PULL.head, repo: { full_name: 'o/r' } } });
  assert.equal((await fleet.reviewOnTag({ number: 7 })).outcome, 'started');
});

test('a review on a human author with a reused handle still runs, on the team key, so it never spends the wrong plan', async () => {
  const t = setup({ gates: REVIEW_GATES, people: { check: async () => false } });
  t.github.pull = async () => REVIEW_PULL;
  assert.equal((await t.fleet.reviewOnTag({ number: 7 })).outcome, 'started');
  assert.equal(t.fleet.sessions()[0].review.teamKey, true);
});

test('a review runs on its author\'s plan, unless it failed the identity checks', async () => {
  const onPlan = setup({ gates: REVIEW_GATES, userSettings: ownTokens(), databases: madeDatabases() });
  onPlan.github.pull = async () => REVIEW_PULL;
  await onPlan.fleet.reviewOnTag({ number: 7 });
  assert.equal(onPlan.fleet.sessions()[0].plan, 'joel');
  const reused = setup({ gates: REVIEW_GATES, userSettings: ownTokens(), databases: madeDatabases(), people: { check: async () => false } });
  reused.github.pull = async () => REVIEW_PULL;
  await reused.fleet.reviewOnTag({ number: 7 });
  assert.equal(reused.fleet.sessions()[0].plan, null, 'the team key, never the old person\'s plan');
});

test('a review on an author without Sessions from GitHub still runs, on the team key', async () => {
  const t = setup({ gates: REVIEW_GATES, githubSessions: [] });
  t.github.pull = async () => REVIEW_PULL;
  assert.equal((await t.fleet.reviewOnTag({ number: 7 })).outcome, 'started');
  assert.equal(t.fleet.sessions()[0].review.teamKey, true);
});

const HELD_GATES = { ...REVIEW_GATES, qa: QA_GATES.qa };
const HELD_PULL = { ...REVIEW_PULL, labels: [{ name: 'qa' }] };
function heldSetup(options = {}) {
  const t = setup({ gates: HELD_GATES, ...options });
  t.github.pull = async () => HELD_PULL;
  t.github.reviews = async () => [];
  t.github.labeledBy = async () => 'joel';
  return t;
}
async function approveThenQa(t, verdict) {
  await t.fleet.reviewOnTag({ number: 7 });
  await t.fleet.reviewFinished(t.fleet.sessions()[0], REVIEW_RESULT);
  const qa = t.fleet.sessions().find((s) => s.trigger === 'qa');
  if (qa && verdict) await t.fleet.qaFinished(qa, { verdict, report: '## TC-1: a ✅', sha: 'a'.repeat(40), costUsd: 1 });
  return qa;
}

test('a review\'s APPROVE waits for QA when the pull request carries the QA label, which starts on it at once', async () => {
  const t = heldSetup();
  const qa = await approveThenQa(t, null);
  assert.deepEqual(t.calls.reviews, [], 'not approved on GitHub yet');
  assert.ok(t.calls.checks.some((c) => c.name === 'Merge risk'), 'the merge risk still goes out');
  assert.equal(qa?.qa.sha, 'a'.repeat(40), 'QA started from the held approval, with no review webhook');
  await t.fleet.qaFinished(qa, { verdict: QA_VERDICT, report: '## TC-1: a ✅', sha: 'a'.repeat(40), costUsd: 1 });
  assert.deepEqual(t.calls.reviews.map((r) => [r.event, r.sha]), [['APPROVE', 'a'.repeat(40)]]);
  assert.match(t.calls.reviews[0].body, /^## Code review — APPROVE\n\nLooks good\.\n\nQA: Pass: 2 test cases passed\.$/);
  assert.equal(t.fleet.sessions()[0].review.held, null, 'released once');
});

test('a held approval keeps its reviewers in the heading when QA releases it', async () => {
  const review = { ...HELD_GATES.review, heading: '## Claude review' };
  const t = heldSetup({
    gates: { ...HELD_GATES, review },
    reviewAgents: { forReview: async () => ({ agents: ['claude', 'codex'] }) },
  });
  await t.fleet.reviewOnTag({ number: 7 });
  await t.fleet.reviewFinished(t.fleet.sessions()[0], { ...REVIEW_RESULT, agents: ['claude', 'codex'] });
  assert.deepEqual(t.calls.reviews, []);
  const qa = t.fleet.sessions().find((s) => s.trigger === 'qa');
  await t.fleet.qaFinished(qa, { verdict: QA_VERDICT, report: '## TC-1: a ✅', sha: 'a'.repeat(40), costUsd: 1 });
  assert.match(t.calls.reviews[0].body, /^## Claude Code and Codex review — APPROVE\n/);
});

test('QA that fails turns the held approval into REQUEST_CHANGES; QA with nothing to test still approves', async () => {
  const failed = heldSetup();
  await approveThenQa(failed, { conclusion: 'failure', title: 'Fail: 1 of 2 test cases failed', status: '❌', total: 2 });
  assert.equal(failed.calls.reviews[0].event, 'REQUEST_CHANGES');
  assert.match(failed.calls.reviews[0].body, /but QA failed \(Fail: 1 of 2 test cases failed\): see the QA comment\./);
  const skipped = heldSetup();
  await approveThenQa(skipped, { conclusion: 'neutral', title: 'Not covered: nothing to test', status: '⏭️', total: 0 });
  assert.deepEqual(skipped.calls.reviews.map((r) => r.event), ['APPROVE']);
  assert.match(skipped.calls.reviews[0].body, /QA: Not covered: nothing to test\.$/);
});

test('without the QA label the approval goes out at once, and a held one is dropped when the head moved during QA', async () => {
  const unlabeled = heldSetup();
  unlabeled.github.pull = async () => ({ ...HELD_PULL, labels: [] });
  await approveThenQa(unlabeled, null);
  assert.deepEqual(unlabeled.calls.reviews.map((r) => r.event), ['APPROVE']);
  const moved = heldSetup();
  const qa = await approveThenQa(moved, null);
  moved.github.pull = async () => ({ ...HELD_PULL, head: { ...HELD_PULL.head, sha: 'c'.repeat(40) } });
  await moved.fleet.qaFinished(qa, { verdict: QA_VERDICT, report: '## TC-1: a ✅', sha: 'a'.repeat(40), costUsd: 1 });
  assert.deepEqual(moved.calls.reviews, [], 'the new commit gets its own review');
});

test('a held approval goes out at once, saying why, when QA cannot start on it', async () => {
  const t = heldSetup();
  t.github.canWrite = async () => false;
  await approveThenQa(t, null);
  assert.equal(t.fleet.sessions().filter((s) => s.trigger === 'qa').length, 0, 'the labeler has no write access');
  assert.deepEqual(t.calls.reviews.map((r) => r.event), ['APPROVE']);
  assert.match(t.calls.reviews[0].body, /QA did not start: no write access to the repo\.$/);
  assert.equal(t.fleet.sessions()[0].review.held, null);
});

test('a QA report for a commit other than the one the session started on releases nothing', async () => {
  const t = heldSetup();
  const qa = await approveThenQa(t, null);
  await t.fleet.qaFinished(qa, { verdict: QA_VERDICT, report: '## TC-1: a ✅', sha: 'a'.repeat(40), costUsd: 1 });
  assert.equal(t.calls.reviews.length, 1);
  const other = heldSetup();
  const started = await approveThenQa(other, null);
  other.github.pull = async () => ({ ...HELD_PULL, head: { ...HELD_PULL.head, sha: 'd'.repeat(40) } });
  await other.fleet.qaFinished(started, { verdict: QA_VERDICT, report: '## TC-1: a ✅', sha: 'd'.repeat(40), costUsd: 1 });
  assert.deepEqual(other.calls.reviews, [], 'the report named the new head, not the commit it tested');
});

test('a QA run that stops without its report releases the held approval on the next tick, once, saying it did not finish', async () => {
  const t = heldSetup();
  const qa = await approveThenQa(t, null);
  t.statuses[qa.id] = { state: 'working' };
  await t.fleet.tick();
  assert.equal(qa.status, 'running');
  await t.fleet.stop(qa, 'idle for 2 h');
  await t.fleet.tick();
  assert.deepEqual(t.calls.reviews.map((r) => [r.event, r.sha]), [['APPROVE', 'a'.repeat(40)]], 'the approval goes out');
  assert.match(t.calls.reviews[0].body, /QA did not finish: idle for 2 h\.$/);
  assert.equal(t.fleet.sessions()[0].review.held, null);
  await t.fleet.tick();
  assert.equal(t.calls.reviews.length, 1, 'once');
});

test('a QA run that never started releases the held approval too, and one that reported releases nothing more', async () => {
  const failed = heldSetup();
  failed.launcher.start = async () => { throw new Error('CannotPullContainerError: no image'); };
  const qa = await approveThenQa(failed, null);
  await failed.fleet.tick();
  assert.equal(qa.status, 'failed');
  await failed.fleet.tick();
  assert.deepEqual(failed.calls.reviews.map((r) => r.event), ['APPROVE']);
  assert.match(failed.calls.reviews[0].body, /QA did not finish: /);

  const reported = heldSetup();
  const ran = await approveThenQa(reported, QA_VERDICT);
  await settle();
  await reported.fleet.tick();
  assert.equal(ran.status, 'stopped');
  assert.equal(reported.calls.reviews.length, 1, 'released by the report alone');
});

test('a QA run that stops without its report leaves the approval held while another QA run tests the same commit', async () => {
  const t = heldSetup();
  const qa = await approveThenQa(t, null);
  const second = await t.fleet.createSession({ kind: 'pr', number: 7, title: 'QA: again', startedBy: 'joel', trigger: 'qa', branch: 'b', qa: { ...qa.qa, commentId: null } });
  t.statuses[qa.id] = { state: 'working' };
  await t.fleet.tick();
  await t.fleet.stop(qa, 'stopped by the console');
  await t.fleet.tick();
  assert.ok(['queued', 'starting', 'running'].includes(second.status));
  assert.deepEqual(t.calls.reviews, [], 'the other run will report on it');
  assert.ok(t.fleet.sessions()[0].review.held);
  t.statuses[second.id] = { state: 'working' };
  await t.fleet.tick();
  await t.fleet.stop(second, 'idle for 2 h');
  await t.fleet.tick();
  assert.deepEqual(t.calls.reviews.map((r) => r.event), ['APPROVE'], 'released once neither will report');
});

test('a commit approved while a QA run held QA gets its own run when that run stops without a report', async () => {
  const t = heldSetup();
  const qa = await approveThenQa(t, null);
  t.statuses[qa.id] = { state: 'working' };
  await t.fleet.tick();
  const newer = { ...HELD_PULL, head: { ...HELD_PULL.head, sha: 'b'.repeat(40) } };
  t.github.pull = async () => newer;
  await t.fleet.reviewOnTag({ number: 7 });
  const second = t.fleet.sessions().filter((s) => s.trigger === 'review').at(-1);
  await t.fleet.reviewFinished(second, { ...REVIEW_RESULT, sha: 'b'.repeat(40) });
  assert.equal(t.fleet.sessions().filter((s) => s.trigger === 'qa').length, 1, 'QA is already running on the older commit');
  await t.fleet.stop(qa, 'idle for 2 h');
  await t.fleet.tick();
  const runs = t.fleet.sessions().filter((s) => s.trigger === 'qa');
  assert.deepEqual(runs.map((s) => s.qa.sha), ['a'.repeat(40), 'b'.repeat(40)], 'the newer commit is tested now');
});

// Each repo's own label and switches (repoTriggers.mjs), set on its settings page.
test('the poll starts sessions from each repo\'s own label, and skips a label or comment its repo turns off', async () => {
  const { createRepoTriggers } = await import('./repoTriggers.mjs');
  const repoTriggers = createRepoTriggers({ store: { state: {}, save() {} }, config: { label: 'woodshed' } });
  await repoTriggers.set({ project: 'tools', label: 'Agent', by: 'mia' });
  await repoTriggers.set({ project: 'r', comments: false, by: 'mia' });
  const { fleet, github, tools, toolCalls, calls } = twoProjects({ repoTriggers });
  pollableTools(tools);
  await fleet.pollGitHub();

  tools.events = [{ ...toolsLabel(502, 13), label: { name: 'agent' } }, toolsLabel(501, 12)];
  github.events = [{ id: 101, event: 'labeled', created_at: LABELED_AT, label: { name: 'woodshed' }, actor: { login: 'joel' }, issue: { number: 4, title: 'x' } }];
  github.comments = [{ id: 88, created_at: '2026-10-21T10:00:05Z', updated_at: '2026-10-21T10:00:05Z', body: '/woodshed go', user: { login: 'joel' }, issue_url: 'https://api.github.com/repos/o/r/issues/5' }];
  await fleet.pollGitHub();
  assert.deepEqual(fleet.sessions().map((s) => [s.project, s.number]), [['r', 4], ['tools', 13]],
    'tools starts from its own label, whatever its case, not from woodshed; the default repo\'s comment is off');
  assert.ok(!calls.comments.some((c) => c.number === 5), 'nothing is posted on an issue whose comment was turned off');
  assert.equal(toolCalls.comments.length, 1);

  await repoTriggers.set({ project: 'r', labels: false, by: 'mia' });
  github.events = [{ id: 102, event: 'labeled', created_at: LABELED_AT, label: { name: 'woodshed' }, actor: { login: 'joel' }, issue: { number: 6, title: 'y' } }];
  github.comments = [];
  await fleet.pollGitHub();
  assert.equal(fleet.sessions().length, 2, 'the default repo\'s label is off now');
});

test('a webhook trigger on a repo that turns it off is ignored with the reason, and claims nothing', async () => {
  const { createRepoTriggers } = await import('./repoTriggers.mjs');
  const repoTriggers = createRepoTriggers({ store: { state: {}, save() {} }, config: { label: 'woodshed' } });
  await repoTriggers.set({ project: 'tools', labels: false, comments: false, by: 'mia' });
  const { fleet, toolCalls } = twoProjects({ repoTriggers });
  const label = await fleet.handleWebhookTrigger({ number: 9, login: 'joel', trigger: 'label', title: 'x', kind: 'issue', at: LABELED_AT, project: 'tools' });
  const comment = await fleet.handleWebhookTrigger({ number: 9, login: 'joel', trigger: 'comment', text: 'go', commentId: 66, project: 'tools' });
  assert.deepEqual(label, { outcome: 'ignored', reason: 'o/tools\'s settings turn its label off' });
  assert.deepEqual(comment, { outcome: 'ignored', reason: 'o/tools\'s settings turn /woodshed comments off' });
  assert.deepEqual(toolCalls.comments, []);
  await repoTriggers.set({ project: 'tools', labels: true, by: 'mia' });
  const after = await fleet.handleWebhookTrigger({ number: 9, login: 'joel', trigger: 'label', title: 'x', kind: 'issue', at: LABELED_AT, project: 'tools' });
  assert.equal(after.outcome, 'started', 'the ignored label claimed nothing');
});

test('the refusal and failure comments name the repo\'s own label', async () => {
  const { createRepoTriggers } = await import('./repoTriggers.mjs');
  const repoTriggers = createRepoTriggers({ store: { state: {}, save() {} }, config: { label: 'woodshed' } });
  await repoTriggers.set({ project: 'r', label: 'agent', by: 'mia' });
  const { fleet, calls } = setup({ repoTriggers, writers: ['joel', 'sam'], githubSessions: ['joel'], projects: [{ name: 'r', repo: 'o/r', default: true }] });
  await fleet.handleTrigger({ number: 3, login: 'sam', trigger: 'label', title: 'x', kind: 'issue' });
  assert.deepEqual(calls.unlabeled, [{ number: 3, label: 'agent' }]);
  assert.match(calls.comments[0].body, /the `agent` label was taken off/);
  assert.match(failedComment({ session: { startedBy: 'joel', id: 'aaaa1111' }, publicUrl: null, label: 'agent' }), /Add the `agent` label again/);
});

test('pullRequests.runsOn keeps label sessions, reviews and QA on the console it names, and a session by hand anywhere', async () => {
  const elsewhere = { ...REVIEW_GATES, runsOn: 'woodshed-internal[bot]' };
  const label = setup({ gates: elsewhere, ownApp: () => ({ login: 'acme-woodshed[bot]' }) });
  assert.equal((await label.fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'Add GTM', kind: 'issue' })).outcome, 'ignored');
  assert.deepEqual([label.calls.started.length, label.calls.comments.length], [0, 0]);
  const review = reviewSetup({ gates: elsewhere, ownApp: () => ({ login: 'acme-woodshed[bot]' }) });
  assert.equal((await review.fleet.reviewOnTag({ number: 7 })).outcome, 'ignored');
  const here = reviewSetup({ gates: { ...REVIEW_GATES, runsOn: 'acme-woodshed[bot]' }, ownApp: () => ({ login: 'acme-woodshed[bot]' }) });
  assert.equal((await here.fleet.reviewOnTag({ number: 7 })).outcome, 'started');
  assert.ok(await label.fleet.startManual({ number: 43, startedBy: 'joel' }), 'by hand, on any console');
});

test('pullRequests.runsOn names one of the consoles that act as one App, by the name each is given', async () => {
  const cloud = () => ({ login: 'acme-woodshed[bot]' });
  const gates = { ...REVIEW_GATES, runsOn: 'acme-woodshed[bot]/beta' };
  const named = reviewSetup({ gates, ownApp: cloud, runsOnName: 'beta' });
  assert.equal((await named.fleet.reviewOnTag({ number: 7 })).outcome, 'started');
  const other = reviewSetup({ gates, ownApp: cloud, runsOnName: 'acme' });
  assert.equal((await other.fleet.reviewOnTag({ number: 7 })).outcome, 'ignored', 'another org of the same App');
  const label = setup({ gates, ownApp: cloud, runsOnName: 'acme' });
  assert.equal((await label.fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'Add GTM', kind: 'issue' })).outcome, 'ignored');
  assert.equal(label.calls.started.length, 0);
  const unnamed = reviewSetup({ gates, ownApp: cloud });
  assert.equal((await unnamed.fleet.reviewOnTag({ number: 7 })).outcome, 'ignored', 'a console with no name is not the one named');
  const any = reviewSetup({ gates: { ...REVIEW_GATES, runsOn: 'acme-woodshed[bot]' }, ownApp: cloud, runsOnName: 'acme' });
  assert.equal((await any.fleet.reviewOnTag({ number: 7 })).outcome, 'started', 'the App alone still matches each of its consoles');
});

test('pullRequests.runsOn keeps the QA label to the console it names, so its own label starts its QA', async () => {
  const gates = { ...REVIEW_GATES, qa: { ...REVIEW_GATES.qa ?? {}, check: 'QA', label: 'woodshed-qa', heading: '## QA', runner: 'woodshed', autoLabel: true } };
  const elsewhere = reviewSetup({ gates: { ...gates, runsOn: 'acme-woodshed[bot]' }, ownApp: () => ({ login: 'woodshed-internal[bot]' }) });
  elsewhere.github.pull = async () => ({ ...REVIEW_PULL, labels: [] });
  await elsewhere.fleet.qaAutoLabel({ number: 7 });
  assert.deepEqual(elsewhere.calls.labeled, []);
  const here = reviewSetup({ gates: { ...gates, runsOn: 'acme-woodshed[bot]' }, ownApp: () => ({ login: 'acme-woodshed[bot]' }) });
  here.github.pull = async () => ({ ...REVIEW_PULL, labels: [] });
  await here.fleet.qaAutoLabel({ number: 7 });
  assert.deepEqual(here.calls.labeled, [{ number: 7, label: 'woodshed-qa' }]);
});

test('a pull request the console\'s own session opened is reviewed as the person who started that session', async () => {
  const app = { login: 'woodshed[bot]' };
  const t = reviewSetup({ ownApp: () => app });
  t.github.pull = async () => ({ ...REVIEW_PULL, user: { login: app.login } });
  t.store.state.sessions.push({
    id: 'c0d1c0d1', repo: 'o/r', kind: 'issue', number: 3, title: 'gtm', startedBy: 'ada', status: 'stopped',
    prUrl: 'https://github.com/o/r/pull/7', createdAt: '2026-10-21T09:00:00.000Z', pendingMessages: [],
  });
  await t.fleet.reviewOnTag({ number: 7 });
  assert.equal(t.fleet.sessions().find((s) => s.review)?.startedBy, 'ada');
  const unknown = reviewSetup({ ownApp: () => app });
  unknown.github.pull = async () => ({ ...REVIEW_PULL, user: { login: app.login } });
  await unknown.fleet.reviewOnTag({ number: 7 });
  assert.equal(unknown.fleet.sessions().find((s) => s.review)?.startedBy, app.login, 'no session of its own opened it: as before');
});

test('QA the console labelled on a pull request its own session opened runs as that session\'s starter, found by branch before its URL is known', async () => {
  const t = qaSetup({ gates: AUTO_GATES, ownApp: () => APP });
  const pull = { ...QA_PULL, user: { login: APP.login } };
  t.github.pull = async () => pull;
  t.github.reviews = async () => reviewOn(pull.head.sha);
  t.github.labeledBy = async () => APP.login;
  t.store.state.sessions.push({
    id: 'c0d1c0d1', repo: 'o/r', kind: 'issue', number: 3, title: 'gtm', startedBy: 'joel', status: 'stopped',
    branch: QA_PULL.head.ref, prUrl: null, createdAt: '2026-10-21T09:00:00.000Z', pendingMessages: [],
  });
  assert.equal((await t.fleet.qaAfterReview({ number: 7 })).outcome, 'started');
  const session = t.fleet.sessions().find((s) => s.qa);
  assert.deepEqual([session.startedBy, session.qa.teamKey], ['joel', undefined]);
});

test('a review comments that it started, and that comment becomes the review\'s comment, or says it did not finish', async () => {
  const { fleet, calls } = reviewSetup();
  await fleet.reviewOnTag({ number: 7 });
  const [running] = calls.comments;
  assert.ok(running.body.startsWith('**Reviewing**') && running.body.includes('<img'));
  await fleet.reviewFinished(fleet.sessions()[0], REVIEW_RESULT);
  assert.deepEqual(calls.comments.at(-1), { id: 9001, body: REVIEW_RESULT.comment }, 'the review edits its started comment');

  const silent = reviewSetup();
  await silent.fleet.reviewOnTag({ number: 7 });
  await silent.fleet.reviewFinished(silent.fleet.sessions()[0], { ...REVIEW_RESULT, conclusion: null, comment: null });
  assert.match(silent.calls.comments.at(-1).body, /did not finish.*no verdict/);

  const bare = reviewSetup();
  await bare.fleet.reviewOnTag({ number: 7 });
  await bare.fleet.reviewFinished(bare.fleet.sessions()[0], { ...REVIEW_RESULT, comment: '' });
  assert.equal(bare.calls.comments.at(-1).body, '**Review finished**: approved, merge risk Low. Details in the review.\n', 'a verdict with no comment still ends the spinner');
  const commented = reviewSetup();
  await commented.fleet.reviewOnTag({ number: 7 });
  await commented.fleet.reviewFinished(commented.fleet.sessions()[0], { ...REVIEW_RESULT, conclusion: 'COMMENT', comment: '' });
  assert.match(commented.calls.comments.at(-1).body, /commented, no verdict/);

  const died = reviewSetup();
  await died.fleet.reviewOnTag({ number: 7 });
  died.store.state.sessions[0].status = 'failed';
  died.store.state.sessions[0].error = 'CannotPullContainerError: no image';
  await died.fleet.tick();
  assert.match(died.calls.comments.at(-1).body, /did not finish.*CannotPullContainerError/);
});

test('a session pull request is reviewed by the console that ran the session, whatever runsOn names, and skipped by the others', async () => {
  const internal = { login: 'woodshed-internal[bot]' };
  const cloud = { login: 'acme-woodshed[bot]' };
  const gates = { ...REVIEW_GATES, runsOn: internal.login };
  const sessionPull = { ...REVIEW_PULL, user: { login: cloud.login }, head: { ...REVIEW_PULL.head, ref: 'woodshed/ada-0b34fee6' } };

  const onCloud = reviewSetup({ ownApp: () => cloud, gates });
  onCloud.github.pull = async () => sessionPull;
  onCloud.store.state.sessions.push({
    id: '0b34fee6', repo: 'o/r', kind: 'task', number: null, title: 'qa video', startedBy: 'ada', status: 'running',
    branch: 'woodshed/ada-0b34fee6', prUrl: null, createdAt: '2026-10-21T09:00:00.000Z', pendingMessages: [],
  });
  assert.equal((await onCloud.fleet.reviewOnTag({ number: 7 })).outcome, 'started', 'its own session: runsOn does not stop it');
  assert.equal(onCloud.fleet.sessions().find((s) => s.review).startedBy, 'ada');

  const onInternal = reviewSetup({ ownApp: () => internal, gates });
  onInternal.github.pull = async () => sessionPull;
  assert.deepEqual(await onInternal.fleet.reviewOnTag({ number: 7 }), { outcome: 'ignored', reason: 'another console\'s session opened it' });

  const otherConsole = reviewSetup({ ownApp: () => cloud, gates: REVIEW_GATES });
  otherConsole.github.pull = async () => sessionPull;
  assert.equal((await otherConsole.fleet.reviewOnTag({ number: 7 })).outcome, 'ignored', 'another console of the App with no such session leaves it to the one that has it');

  const person = reviewSetup({ ownApp: () => cloud, gates });
  assert.equal((await person.fleet.reviewOnTag({ number: 7 })).outcome, 'ignored', 'a person\'s pull request still follows runsOn');
});

test('QA of another console\'s session pull request is neither labelled nor run here', async () => {
  const t = qaSetup({ gates: AUTO_GATES, ownApp: () => APP });
  t.github.pull = async () => ({ ...QA_PULL, user: { login: 'acme-woodshed[bot]' }, head: { ...QA_PULL.head, ref: 'woodshed/ada-0b34fee6' }, labels: [] });
  assert.deepEqual(await t.fleet.qaAutoLabel({ number: 7 }), { unrecorded: true });
});

test('a message statusd typed before a prompt came up is not typed again: it is in the agent\'s box', async () => {
  const { fleet, calls, statuses, fail } = setup();
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = fleet.sessions();
  statuses[session.id] = { state: 'done', branch: session.branch, head: 'abc' };
  await fleet.tick();
  fail.sendTyped = true;
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'comment', text: 'option 2', commentId: 79 });
  assert.equal(session.pendingMessages.length, 0, 'not held for a second try');
  fail.sendTyped = false;
  await fleet.tick();
  assert.equal(calls.statusd.filter((c) => c.path === '/send').length, 0, 'never typed again');
});

test('a message statusd says busy for is kept in the session\'s saved pendingMessages, and goes in order once it can', async () => {
  // Mid-turn statusd types nothing (a prompt could open under the Enter): the console keeps it, saved, so a stop
  // mid-turn does not lose it, and a later message waits behind it.
  const { fleet, calls, statuses, fail } = setup();
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = fleet.sessions();
  statuses[session.id] = { state: 'working', branch: session.branch, head: 'abc' };
  await fleet.tick();
  fail.sendBusy = true;
  assert.equal(await fleet.send(session, 'first'), 'queued');
  assert.deepEqual(session.pendingMessages, ['first']);
  assert.equal(await fleet.send(session, 'second'), 'queued', 'behind the one waiting, not tried before it');
  assert.deepEqual(session.pendingMessages, ['first', 'second']);
  await fleet.tick();
  assert.deepEqual(session.pendingMessages, ['first', 'second'], 'still busy: kept');
  fail.sendBusy = false;
  statuses[session.id] = { state: 'done', branch: session.branch, head: 'abc' };
  await fleet.tick();
  assert.deepEqual(calls.statusd.filter((c) => c.path === '/send' && !c.refused).map((c) => c.body.text), ['first', 'second']);
  assert.deepEqual(session.pendingMessages, []);
});

test('a message held while another goes in stays, and one the session refuses for good does not hold the rest', async () => {
  const { fleet, calls, statuses, fail } = setup();
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = fleet.sessions();
  statuses[session.id] = { state: 'working', branch: session.branch, head: 'abc' };
  await fleet.tick();
  fail.sendBusy = true;
  await fleet.send(session, 'too long', { id: 'page-id-0400' });
  await fleet.send(session, 'first');
  fail.sendBusy = false;
  // statusd refuses the first for good (over its length), and takes 'first' slowly: 'late' comes in meanwhile.
  let release;
  fail.sendFor = (text) => {
    if (text === 'too long') return Object.assign(new Error('statusd /send answered 400'), { status: 400, body: { error: 'text must be at most 8000 characters' } });
    if (text === 'first') return new Promise((resolve) => { release = resolve; });
    return null;
  };
  statuses[session.id] = { state: 'done', branch: session.branch, head: 'abc' };
  const ticking = fleet.tick();
  for (let i = 0; i < 50 && !release; i++) await new Promise((r) => setImmediate(r));
  assert.ok(release, 'first is on its way');
  assert.deepEqual(session.pendingMessages, ['first'], 'the one the session refuses for good is dropped, not held for ever');
  assert.deepEqual(session.refusedIds, ['page-id-0400'], 'and the page told, by its id');
  assert.equal(await fleet.send(session, 'late'), 'queued', 'behind the one going in');
  release();
  await ticking;
  assert.ok(session.pendingMessages.includes('late') || calls.statusd.some((c) => c.path === '/send' && c.body?.text === 'late' && !c.refused),
    'late is kept, or sent after first: never erased by first\'s acknowledgement');
  assert.ok(!session.pendingMessages.includes('first'));
});

test('a send that outlives its deadline may have gone in: it is not held, and never typed a second time', async () => {
  const { sendTimeoutMs } = await import('./fleet.mjs');
  const { fleet, calls, statuses, fail } = setup();
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = fleet.sessions();
  statuses[session.id] = { state: 'done', branch: session.branch, head: 'abc' };
  await fleet.tick();
  // 150 short lines, as the review measured: statusd types them a run at a time, longer than the old 5 s.
  const many = Array.from({ length: 150 }, (_, i) => `l${i}`).join('\n');
  assert.ok(sendTimeoutMs(many) > 5000 + 150 * 40, 'the deadline covers typing it');
  const timedOut = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const asked = [];
  fail.sendFor = (text) => { asked.push(text); return timedOut(); };
  assert.equal(await fleet.send(session, many), 'unknown', 'it may have gone in: not held to send again, and not said to be sent');
  assert.equal(fail.lastSendOpts.timeoutMs, sendTimeoutMs(many), 'the deadline sized to the message, not the 5 s default');
  assert.deepEqual(session.pendingMessages, []);
  // A held one whose send times out is let go too, not typed again on the next status read.
  fail.sendBusy = true;
  fail.sendFor = null;
  await fleet.send(session, 'held then timed out');
  fail.sendBusy = false;
  fail.sendFor = (text) => { asked.push(text); return timedOut(); };
  await fleet.tick();
  assert.deepEqual(session.pendingMessages, []);
  fail.sendFor = null;
  await fleet.tick();
  assert.deepEqual(asked, [many, 'held then timed out'], 'each tried once');
  void calls;
  // A connection refused never reached statusd: held, to try again.
  fail.sendFor = () => Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  assert.equal(await fleet.send(session, 'refused'), 'queued');
  assert.deepEqual(session.pendingMessages, ['refused']);
});

test('a queued message left in the agent\'s box is noted for the page, by length, until the box is empty again', async () => {
  const { fleet, statuses, fail } = setup();
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = fleet.sessions();
  statuses[session.id] = { state: 'done', branch: session.branch, head: 'abc' };
  await fleet.tick();
  fail.sendTyped = true;
  assert.equal(await fleet.send(session, 'a held message', { id: 'page-id-0001' }), 'in-box');
  assert.equal(session.leftInBox.id, 'page-id-0001', 'the page\'s own id for it');
  assert.equal(JSON.stringify(session.leftInBox).includes('held message'), false, 'never its text');
  fail.sendTyped = false;
  statuses[session.id] = { state: 'done', branch: session.branch, head: 'abc', boxText: true };
  await fleet.tick();
  assert.ok(session.leftInBox, 'still in the box');
  statuses[session.id] = { state: 'done', branch: session.branch, head: 'abc', boxText: false };
  await fleet.tick();
  assert.equal(session.leftInBox, null, 'sent or cleared in the TUI tab');
});

test('a message is held as statusd can type it: no control characters to block the queue, an empty one dropped', async () => {
  const { fleet, statuses, fail } = setup();
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = fleet.sessions();
  statuses[session.id] = { state: 'working', branch: session.branch, head: 'abc' };
  await fleet.tick();
  fail.sendBusy = true;
  assert.equal(await fleet.send(session, 'fix it\u0000 now\r\nplease'), 'queued');
  assert.deepEqual(session.pendingMessages, ['fix it now\nplease']);
  assert.equal(await fleet.send(session, '\u0000\u001b'), 'sent', 'nothing to type: not held to block the rest');
  assert.deepEqual(session.pendingMessages, ['fix it now\nplease']);
});

test('a held message the console sends is named by the page\'s id, so its bubble turns sent on that alone', async () => {
  const { fleet, statuses, fail } = setup();
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = fleet.sessions();
  statuses[session.id] = { state: 'working', branch: session.branch, head: 'abc' };
  await fleet.tick();
  fail.sendBusy = true;
  assert.equal(await fleet.send(session, 'go on', { id: 'page-id-0002' }), 'queued');
  assert.deepEqual(session.pendingMessages, [{ id: 'page-id-0002', text: 'go on' }]);
  assert.equal(await fleet.send(session, 'from a comment'), 'queued', 'one with no id, as a comment\'s');
  fail.sendBusy = false;
  statuses[session.id] = { state: 'done', branch: session.branch, head: 'abc' };
  await fleet.tick();
  assert.deepEqual(session.pendingMessages, []);
  assert.deepEqual(session.deliveredIds, ['page-id-0002']);
});

test('a held message whose send gets no answer in time is named for the page by its id, and never sent again', async () => {
  const { fleet, statuses, fail } = setup();
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = fleet.sessions();
  statuses[session.id] = { state: 'working', branch: session.branch, head: 'abc' };
  await fleet.tick();
  fail.sendBusy = true;
  await fleet.send(session, 'go on', { id: 'page-id-0003' });
  fail.sendBusy = false;
  const tried = [];
  fail.sendFor = (text) => { tried.push(text); return Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); };
  statuses[session.id] = { state: 'done', branch: session.branch, head: 'abc' };
  await fleet.tick();
  assert.deepEqual(session.pendingMessages, [], 'out of the queue');
  assert.deepEqual(session.unknownIds, ['page-id-0003'], 'the page is told, by its id');
  assert.equal(session.deliveredIds, undefined, 'not said to be sent');
  fail.sendFor = null;
  await fleet.tick();
  assert.deepEqual(tried, ['go on'], 'tried once');
});

test('through a statusd from before the guarded send, a message goes in only while the agent is plainly idle', async () => {
  // A session started before the upgrade: its statusd types blind, Enter and all, so a prompt on screen would take it.
  const { fleet, calls, statuses } = setup();
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = fleet.sessions();
  statuses[session.id] = { state: 'needs-you', branch: session.branch, head: 'abc', safeSend: false };
  await fleet.tick();
  assert.equal(await fleet.send(session, 'approve it please'), 'queued', 'held, not typed into the approval');
  assert.equal(calls.statusd.filter((c) => c.path === '/send').length, 0);
  statuses[session.id] = { state: 'done', branch: session.branch, head: 'abc', safeSend: false };
  await fleet.tick();
  assert.deepEqual(calls.statusd.filter((c) => c.path === '/send').map((c) => c.body.text), ['approve it please'], 'sent once it is idle');
});

test('through a statusd from before the guarded send, nothing is typed on an old idle read, and a queue goes one a read', async () => {
  // Its idle state is only as fresh as the last read: an approval may be up by now, and the first message sets it working.
  const { fleet, calls, statuses } = setup();
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = fleet.sessions();
  statuses[session.id] = { state: 'done', branch: session.branch, head: 'abc', safeSend: false };
  await fleet.tick();
  const sends = () => calls.statusd.filter((c) => c.path === '/send').map((c) => c.body.text);
  assert.equal(await fleet.send(session, 'one'), 'queued', 'held for the next read, not typed on the last one');
  assert.equal(await fleet.send(session, 'two'), 'queued');
  assert.deepEqual(sends(), []);
  await fleet.tick();
  assert.deepEqual(sends(), ['one'], 'one message for one read');
  await fleet.tick();
  assert.deepEqual(sends(), ['one', 'two']);
  assert.deepEqual(session.pendingMessages, []);
});

test('a direct send with no answer in time is said to be unknown, not sent, and not held', async () => {
  const { fleet, statuses, fail } = setup();
  await fleet.handleTrigger({ number: 42, login: 'joel', trigger: 'label', title: 'x', kind: 'issue' });
  const [session] = fleet.sessions();
  statuses[session.id] = { state: 'done', branch: session.branch, head: 'abc' };
  await fleet.tick();
  fail.sendFor = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  assert.equal(await fleet.send(session, 'go on', { id: 'page-id-0004' }), 'unknown');
  assert.deepEqual(session.pendingMessages, []);
});

test('a My Woodshed session that cannot be typed into is told at a later check, with nothing held for a Resume', async () => {
  const { fleet, github, statuses, calls, store, advance } = setup();
  const session = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it' });
  github.pull = async (number) => ({ number, created_at: '2026-10-21T10:05:00Z', state: 'open', head: { sha: 'abc' }, user: { login: 'joel' } });
  github.reviews = async () => [];
  github.checkRuns = async () => e2eRuns((n) => (n === 2 ? 'failure' : 'success'));
  statuses[session.id] = { state: 'not-running', prUrl: 'https://github.com/o/r/pull/9' };
  await fleet.tick();
  await fleet.tick();
  const sent = () => calls.statusd.filter((c) => c.path === '/send' && c.id === session.id);
  assert.deepEqual([sent().length, session.pendingMessages], [0, []], 'claude is not open: nothing typed in, nothing held');
  statuses[session.id] = { state: 'done', prUrl: 'https://github.com/o/r/pull/9' };
  advance(60_000);
  await fleet.tick();
  assert.equal(sent().length, 1);
  assert.match(sent()[0].body.text, /e2e suite failed on PR #9/);
  assert.deepEqual(session.pendingMessages, []);
});

test('a My Woodshed session that reports another pull request hears nothing more of the first while it is on the other', async () => {
  const { fleet, github, statuses, calls, store, advance } = setup();
  const session = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it' });
  github.pull = async (number) => ({ number, created_at: '2026-10-21T10:05:00Z', state: 'open', head: { sha: 'abc' }, user: { login: 'joel' } });
  github.reviews = async () => [];
  github.checkRuns = async () => e2eRuns();
  statuses[session.id] = { state: 'done', prUrl: 'https://github.com/o/r/pull/9' };
  await fleet.tick();
  await fleet.tick();
  statuses[session.id] = { state: 'done', prUrl: 'https://github.com/o/r/pull/10' };
  github.checkRuns = async () => e2eRuns((n) => (n === 2 ? 'failure' : 'success'));
  advance(60_000);
  await fleet.tick();
  await fleet.tick();
  const sent = calls.statusd.filter((c) => c.path === '/send' && c.id === session.id).map((c) => c.body.text);
  assert.deepEqual(store.state.slackPending.map((p) => p.number), [9, 10], '#9 waits for the session to be back on it');
  assert.ok(sent.every((t) => !/PR #9\b/.test(t) || /passed/.test(t)), 'nothing about #9 after it left it');
  assert.ok(sent.some((t) => /e2e suite failed on PR #10/.test(t)));
});

test('a My Woodshed session\'s pull request on another repo than its project is not watched', async () => {
  const { fleet, github, statuses, calls, store } = setup();
  const session = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it' });
  // Its project is no longer on the console's list, so the console falls back to the default project, whose repo
  // has a #9 of its own.
  Object.assign(session, { project: 'gone', repo: 'someone/else' });
  github.pull = async (number) => ({ number, created_at: '2026-10-21T10:05:00Z', state: 'open', head: { sha: 'abc' }, user: { login: 'joel' } });
  github.reviews = async () => [];
  github.checkRuns = async () => e2eRuns((n) => (n === 2 ? 'failure' : 'success'));
  statuses[session.id] = { state: 'done', prUrl: 'https://github.com/someone/else/pull/9' };
  await fleet.tick();
  await fleet.tick();
  assert.deepEqual(store.state.slackPending ?? [], []);
  assert.deepEqual(calls.statusd.filter((c) => c.path === '/send' && c.id === session.id), []);
});

test('a My Woodshed session that reports a pull request on another repo hears nothing of its own until it is back', async () => {
  const { fleet, github, statuses, calls, store, advance } = setup();
  const session = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it' });
  github.pull = async (number) => ({ number, created_at: '2026-10-21T10:05:00Z', state: 'open', head: { sha: 'abc' }, user: { login: 'joel' } });
  github.reviews = async () => [];
  github.checkRuns = async () => e2eRuns();
  statuses[session.id] = { state: 'done', prUrl: 'https://github.com/o/r/pull/9' };
  await fleet.tick();
  statuses[session.id] = { state: 'done', prUrl: 'https://github.com/someone/else/pull/9' };
  github.checkRuns = async () => e2eRuns((n) => (n === 2 ? 'failure' : 'success'));
  advance(60_000);
  await fleet.tick();
  assert.equal(session.prUrl, 'https://github.com/o/r/pull/9', 'its own repo\'s pull request is kept');
  assert.deepEqual(store.state.slackPending.map((p) => p.number), [9], 'its watch waits');
  assert.deepEqual(calls.statusd.filter((c) => c.path === '/send' && c.id === session.id), []);

  statuses[session.id] = { state: 'done', prUrl: 'https://github.com/o/r/pull/9' };
  advance(60_000);
  await fleet.tick();
  assert.deepEqual(store.state.slackPending.map((p) => p.number), [9]);
  assert.match(calls.statusd.filter((c) => c.path === '/send' && c.id === session.id).at(-1)?.body.text ?? '', /e2e suite failed on PR #9/);
});

test('a My Woodshed session on a branch with no pull request (or a failed lookup) hears nothing until it is back, then nothing twice', async () => {
  const { fleet, github, statuses, calls, store, advance } = setup();
  const session = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it' });
  github.pull = async (number) => ({ number, created_at: '2026-10-21T10:05:00Z', state: 'open', head: { sha: 'abc' }, user: { login: 'joel' } });
  github.reviews = async () => [];
  github.checkRuns = async () => e2eRuns();
  statuses[session.id] = { state: 'done', prUrl: 'https://github.com/o/r/pull/9' };
  await fleet.tick();
  github.checkRuns = async () => e2eRuns((n) => (n === 2 ? 'failure' : 'success'));
  advance(60_000);
  await fleet.tick();
  const sent = () => calls.statusd.filter((c) => c.path === '/send' && c.id === session.id);
  assert.equal(sent().length, 1, 'told of the failure while on it');
  statuses[session.id] = { state: 'done', prUrl: null };
  github.pull = async (number) => ({ number, created_at: '2026-10-21T10:05:00Z', state: 'open', head: { sha: 'def' }, user: { login: 'joel' } });
  github.checkRuns = async () => e2eRuns((n) => (n === 3 ? 'failure' : 'success'));
  advance(60_000);
  await fleet.tick();
  assert.deepEqual([store.state.slackPending.map((p) => p.number), sent().length], [[9], 1], 'waits, told nothing');
  statuses[session.id] = { state: 'done', prUrl: 'https://github.com/o/r/pull/9' };
  advance(60_000);
  await fleet.tick();
  assert.equal(sent().length, 2);
  assert.match(sent()[1].body.text, /e2e run \(3\/4\)/, 'back: told what changed, and not the failure it heard before');
  github.checkRuns = async () => e2eRuns((n) => (n === 3 ? 'failure' : 'success'));
  advance(60_000);
  await fleet.tick();
  assert.equal(sent().length, 2, 'nothing twice');
});

test('a private session keeps the branch the console made for it, and one started on a branch has none', async () => {
  const { fleet, statuses } = setup();
  const own = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it' });
  assert.equal(own.madeBranch, `woodshed/joel-${own.id}`);
  statuses[own.id] = { state: 'working', branch: 'woodshed/ana-dev-x' };
  await fleet.tick();
  assert.deepEqual([own.branch, own.madeBranch], ['woodshed/ana-dev-x', `woodshed/joel-${own.id}`], 'a checkout does not move it');
  const onBranch = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it', workOn: 'feature/shared' });
  assert.equal(onBranch.madeBranch, undefined);
});

test('a private watch whose project left the console ends, reading nothing of the default repo', async () => {
  const projects = [
    { name: 'r', repo: 'o/r', default: true },
    { name: 'web', repo: 'example-org/web', default: false },
  ];
  const web = {
    async pull(number) { return { number, created_at: '2026-10-21T10:05:00Z', state: 'open', head: { sha: 'abc' }, user: { login: 'joel' } }; },
    async reviews() { return []; },
    async checkRuns() { return e2eRuns(); },
  };
  const { fleet, github, statuses, store, advance } = setup({ projects, githubFor: (project) => (project.name === 'web' ? web : null) });
  const session = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it', project: projects[1] });
  statuses[session.id] = { state: 'done', prUrl: 'https://github.com/example-org/web/pull/9' };
  await fleet.tick();
  assert.deepEqual(store.state.slackPending.map((p) => [p.number, p.project]), [[9, 'web']]);
  const defaultReads = [];
  github.pull = async (number) => { defaultReads.push(number); return { number, state: 'closed', head: { sha: 'zzz' } }; };
  projects.splice(1, 1);
  advance(60_000);
  await fleet.tick();
  assert.deepEqual([store.state.slackPending, defaultReads], [[], []]);
});

test('a private watch on the default project ends when the default project is replaced by another repo', async () => {
  const projects = [{ name: 'r', repo: 'o/r', default: true }];
  const { fleet, github, statuses, store, advance } = setup({ projects });
  const session = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it' });
  github.pull = async (number) => ({ number, created_at: '2026-10-21T10:05:00Z', state: 'open', head: { sha: 'abc' }, user: { login: 'joel' } });
  github.reviews = async () => [];
  github.checkRuns = async () => e2eRuns();
  statuses[session.id] = { state: 'done', prUrl: 'https://github.com/o/r/pull/9' };
  await fleet.tick();
  assert.deepEqual(store.state.slackPending.map((p) => [p.number, p.repo]), [[9, 'o/r']]);
  const reads = [];
  github.pull = async (number) => { reads.push(number); return { number, state: 'closed', head: { sha: 'zzz' } }; };
  projects.splice(0, 1, { name: 'other', repo: 'o/other', default: true });
  advance(60_000);
  await fleet.tick();
  assert.deepEqual([store.state.slackPending, reads], [[], []]);
});

test('a private session whose claude closed since its last status read is not typed into', async () => {
  const { fleet, github, statuses, calls, advance } = setup();
  const session = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it' });
  const prUrl = 'https://github.com/o/r/pull/9';
  github.pull = async (number) => ({ number, created_at: '2026-10-21T10:05:00Z', state: 'open', head: { sha: 'abc' }, user: { login: 'joel' } });
  github.reviews = async () => [];
  github.checkRuns = async () => e2eRuns();
  statuses[session.id] = { state: 'done', prUrl };
  await fleet.tick();
  // claude closes while the console reads GitHub, after this tick's status read.
  github.checkRuns = async () => {
    statuses[session.id] = { state: 'not-running', prUrl };
    return e2eRuns((n) => (n === 2 ? 'failure' : 'success'));
  };
  advance(60_000);
  await fleet.tick();
  const sent = () => calls.statusd.filter((c) => c.path === '/send' && c.id === session.id);
  assert.deepEqual(sent(), []);
  statuses[session.id] = { state: 'done', prUrl };
  github.checkRuns = async () => e2eRuns((n) => (n === 2 ? 'failure' : 'success'));
  advance(60_000);
  await fleet.tick();
  assert.equal(sent().length, 1, 'told once claude is open again');
});

test('a private session that moved off its pull request since the last status read is not typed into, and agentOnly is asked', async () => {
  const { fleet, github, statuses, calls, advance } = setup();
  const session = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it' });
  const prUrl = 'https://github.com/o/r/pull/9';
  github.pull = async (number) => ({ number, created_at: '2026-10-21T10:05:00Z', state: 'open', head: { sha: 'abc' }, user: { login: 'joel' } });
  github.reviews = async () => [];
  github.checkRuns = async () => e2eRuns();
  statuses[session.id] = { state: 'done', prUrl };
  await fleet.tick();
  github.checkRuns = async () => {
    statuses[session.id] = { state: 'done', prUrl: 'https://github.com/o/r/pull/10' };
    return e2eRuns((n) => (n === 2 ? 'failure' : 'success'));
  };
  advance(60_000);
  await fleet.tick();
  const sent = () => calls.statusd.filter((c) => c.path === '/send' && c.id === session.id);
  assert.deepEqual(sent(), []);
  statuses[session.id] = { state: 'done', prUrl };
  github.checkRuns = async () => e2eRuns((n) => (n === 2 ? 'failure' : 'success'));
  advance(60_000);
  await fleet.tick();
  assert.equal(sent().length, 1);
  assert.deepEqual([sent()[0].body.agentOnly, sent()[0].body.prUrl, sent()[0].body.headSha], [true, prUrl, 'abc'], 'statusd checks the pull request and its commit too');
  assert.equal(sent()[0].body.withinMs, 20_000, 'and types it only while the console still waits');
});

test('a private session that starts stopping while its status is read again is not typed into', async () => {
  const { fleet, github, statuses, calls, advance } = setup();
  const session = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it' });
  const prUrl = 'https://github.com/o/r/pull/9';
  github.pull = async (number) => ({ number, created_at: '2026-10-21T10:05:00Z', state: 'open', head: { sha: 'abc' }, user: { login: 'joel' } });
  github.reviews = async () => [];
  github.checkRuns = async () => e2eRuns();
  statuses[session.id] = { state: 'done', prUrl };
  await fleet.tick();
  github.checkRuns = async () => {
    // The read just before typing in answers as the owner presses Stop.
    Object.defineProperty(statuses, session.id, { configurable: true, get() { session.status = 'stopping'; return { state: 'done', prUrl }; } });
    return e2eRuns((n) => (n === 2 ? 'failure' : 'success'));
  };
  advance(60_000);
  await fleet.tick();
  assert.deepEqual(calls.statusd.filter((c) => c.path === '/send' && c.id === session.id), []);
});

test('a private session on an older image, whose statusd types into its pane unchecked, is not watched', async () => {
  const { fleet, github, statuses, calls, store } = setup();
  const session = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it' });
  github.pull = async (number) => ({ number, created_at: '2026-10-21T10:05:00Z', state: 'open', head: { sha: 'abc' }, user: { login: 'joel' } });
  github.reviews = async () => [];
  github.checkRuns = async () => e2eRuns((n) => (n === 2 ? 'failure' : 'success'));
  statuses[session.id] = { state: 'done', prUrl: 'https://github.com/o/r/pull/9', agentOnlySend: false };
  await fleet.tick();
  await fleet.tick();
  assert.deepEqual([store.state.slackPending ?? [], calls.statusd.filter((c) => c.path === '/send' && c.id === session.id)], [[], []]);
});

test('a push while a private session\'s status is read again leaves the old commit\'s feedback untold', async () => {
  const { fleet, github, statuses, calls, advance } = setup();
  const session = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it' });
  const prUrl = 'https://github.com/o/r/pull/9';
  let head = 'abc';
  github.pull = async (number) => ({ number, created_at: '2026-10-21T10:05:00Z', state: 'open', head: { sha: head }, user: { login: 'joel' } });
  github.reviews = async () => [];
  github.checkRuns = async () => e2eRuns();
  statuses[session.id] = { state: 'done', prUrl };
  await fleet.tick();
  let reads = 0;
  github.checkRuns = async () => {
    // The status read just before typing in is the second of this tick: the session pushes while it answers.
    Object.defineProperty(statuses, session.id, { configurable: true, get() { reads += 1; if (reads === 2) head = 'def'; return { state: 'done', prUrl }; } });
    return e2eRuns((n) => (n === 2 ? 'failure' : 'success'));
  };
  advance(60_000);
  await fleet.tick();
  assert.deepEqual(calls.statusd.filter((c) => c.path === '/send' && c.id === session.id), []);
});

test('a guarded send never lets statusd type past the end of the watch\'s wait', async () => {
  const retention = { afterCloseMs: 3 * 24 * HOUR, withoutPrMs: 7 * 24 * HOUR, openPrMs: 14 * 24 * HOUR, slackGiveUpMs: 10 * 60_000 };
  const { fleet, github, statuses, calls, advance } = setup({ retention });
  const session = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it' });
  const prUrl = 'https://github.com/o/r/pull/9';
  github.pull = async (number) => ({ number, created_at: '2026-10-21T10:05:00Z', state: 'open', head: { sha: 'abc' }, user: { login: 'joel' } });
  github.reviews = async () => [];
  github.checkRuns = async () => e2eRuns();
  statuses[session.id] = { state: 'done', prUrl };
  await fleet.tick();
  github.checkRuns = async () => e2eRuns((n) => (n === 2 ? 'failure' : 'success'));
  advance(10 * 60_000 - 5_000);
  await fleet.tick();
  const sent = calls.statusd.filter((c) => c.path === '/send' && c.id === session.id);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].body.withinMs <= 5_000, `withinMs ${sent[0].body.withinMs} is no more than what is left of the wait`);
  assert.equal(sent[0].body.notAfter, Date.parse('2026-10-21T10:00:00.000Z') + 10 * 60_000 - 5_000 + sent[0].body.withinMs, 'and the same deadline in absolute time');
});

test('the review report credits Codex when Claude Code wrote no verdict', async (t) => {
  const { createServer } = await import('node:http');
  const { createSessionApi } = await import('./sessionApi.mjs');
  const { reviewVerdict } = await import('./pullGates.mjs');
  const review = { ...REVIEW_GATES.review, heading: '## Claude review' };
  const { fleet, calls } = reviewSetup({
    gates: { ...REVIEW_GATES, review },
    reviewAgents: { forReview: async () => ({ agents: ['claude', 'codex'] }) },
  });
  await fleet.reviewOnTag({ number: 7 });
  const [session] = fleet.sessions();
  const server = createServer(createSessionApi({ fleet }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/review-report`, {
    method: 'POST',
    headers: { authorization: `Bearer ${session.token}` },
    body: JSON.stringify({
      ...REVIEW_RESULT, conclusion: 'REQUEST_CHANGES', agents: ['codex'],
      summary: "The link is wrong.\n\nClaude Code wrote no verdict, so this is Codex's alone.",
    }),
  });
  assert.equal(response.status, 204);
  const posted = { ...calls.reviews[0], user: { login: review.author } };
  console.log('Proof: POST /review-report', response.status, posted.body.split('\n')[0]);
  assert.match(posted.body, /^## Codex review — REQUEST_CHANGES\n/);
  assert.equal(reviewVerdict([posted], review), posted);
});

test('a session that asked a question waits for its answer until it is sent a message or works again', async () => {
  const { fleet, statuses, answers } = setup();
  const child = await fleet.startPrivate({ owner: 'joel', prompt: 'Write NOTES.md' });
  statuses[child.id] = { state: 'working' };
  await fleet.tick();
  // Asked mid-turn, as reply --question is: still working until its turn on the question ends.
  fleet.noteQuestion(child, { to: 'aaaa0001' });
  assert.ok(child.askedAt);
  await fleet.tick();
  assert.ok(child.askedAt, 'the turn it asked in is not its answer');
  statuses[child.id] = { state: 'done' };
  await fleet.tick();
  assert.equal(child.askedSettled, true);
  statuses[child.id] = { state: 'working' };
  await fleet.tick();
  assert.equal(child.askedAt, null, 'working again: answered in its own Chat or TUI');

  fleet.noteQuestion(child, { to: 'aaaa0001' });
  statuses[child.id] = { state: 'done' };
  await fleet.tick();
  await fleet.send(child, 'Customers.');
  assert.equal(child.askedAt, null, 'a message typed into it answers it');

  // A message left in its box unsent (a prompt came up as it was typed) is no answer yet.
  fleet.noteQuestion(child, { to: 'aaaa0001' });
  statuses[child.id] = { state: 'done' };
  await fleet.tick();
  answers['/send'] = { then: (_, reject) => reject(Object.assign(new Error('statusd /send answered 409'), { status: 409, body: { typed: true } })) };
  assert.equal(await fleet.send(child, 'Customers.'), 'in-box');
  assert.ok(child.askedAt, 'still asking: the answer is in its box, not sent');
  delete answers['/send'];

  // Answered in its own TUI with a turn too quick for a status read to see it working: its newer last message says so.
  fleet.noteQuestion(child, { to: 'aaaa0001' });
  statuses[child.id] = { state: 'done', lastMessage: { role: 'assistant', text: 'Developers or customers?', at: '2026-10-21T10:05:00.000Z' } };
  await fleet.tick();
  assert.ok(child.askedAt);
  await fleet.tick();
  assert.ok(child.askedAt, 'nothing new: still asking');
  statuses[child.id] = { state: 'done', lastMessage: { role: 'assistant', text: 'Writing it for customers.', at: '2026-10-21T10:06:00.000Z' } };
  await fleet.tick();
  assert.equal(child.askedAt, null, 'a turn since');

  // Stopped with a question open: its Resume starts with none.
  fleet.noteQuestion(child, { to: 'aaaa0001' });
  await fleet.stop(child, 'stopped from the console', { by: 'joel' });
  assert.deepEqual([child.status, child.askedAt], ['stopped', null]);
});

function fakeAttachments() {
  const written = {};
  return {
    written,
    async claim() { return 0; },
    async put({ sessionId, files, after }) { written[sessionId] = { files, after }; return files.length; },
  };
}

test('Hand off stops a running private session, pushing its work, and starts a new one on its branch with the agent picked and the conversation attached', async () => {
  const attachments = fakeAttachments();
  const { fleet, calls, statuses, answers } = setup({ attachments });
  const first = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it', workOn: 'joel/fix', name: 'Fix the login' });
  statuses[first.id] = { state: 'done', branch: 'joel/fix' };
  await fleet.tick();
  answers['/transcript'] = { agent: 'claude', entries: [{ role: 'user', text: 'Fix it', at: null }, { role: 'assistant', text: 'Half done.', at: null }] };

  await assert.rejects(fleet.handOffPrivate({ owner: 'mia', id: first.id, agent: 'codex' }), /no session you can open/);
  await assert.rejects(fleet.handOffPrivate({ owner: 'joel', id: first.id, agent: 'gemini' }), /the agent must be one of/);
  assert.equal(first.status, 'running', 'a refusal leaves it running');

  const next = await fleet.handOffPrivate({ owner: 'joel', id: first.id, agent: 'codex', model: 'gpt-6.1-sol', note: 'Only the tests are left.' });
  assert.equal(first.status, 'stopped');
  assert.equal(first.stopReason, 'handed off to Codex');
  assert.equal(first.handedOffTo, next.id);
  const paths = calls.statusd.filter((c) => c.id === first.id).map((c) => c.path);
  assert.ok(paths.indexOf('/transcript') < paths.indexOf('/checkpoint'), 'the conversation is read before the stop, which pushes its work');
  assert.equal(next.owner, 'joel');
  assert.equal(next.branch, 'joel/fix', 'the same branch');
  assert.equal(next.title, 'Fix the login');
  assert.deepEqual(next.options, { agent: 'codex', model: 'gpt-6.1-sol', effort: '', permissionMode: 'auto' });
  assert.equal(next.handedOffFrom, first.id);
  assert.match(next.prompt, /^Only the tests are left\.\n/);
  assert.match(next.prompt, /from a Claude Code session/);
  const { files } = attachments.written[next.id];
  assert.equal(files[0].name, 'handoff.md');
  assert.match(files[0].text, /### The agent\n\nHalf done\./);
  assert.equal(next.attachments, 1);

  await assert.rejects(fleet.handOffPrivate({ owner: 'joel', id: first.id, agent: 'claude' }), /only a running session/);
});

test('Hand off without the conversation reads none and attaches nothing; a tainted session or an unreadable conversation is refused, still running', async () => {
  const attachments = fakeAttachments();
  const { fleet, calls, statuses, answers } = setup({ attachments });
  const first = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it', workOn: 'joel/fix', agent: 'codex' });
  statuses[first.id] = { state: 'done', branch: 'joel/fix' };
  await fleet.tick();

  answers['/transcript'] = Promise.reject(new Error('statusd /transcript answered 500'));
  answers['/transcript'].catch(() => {});
  await assert.rejects(fleet.handOffPrivate({ owner: 'joel', id: first.id, agent: 'claude' }), /conversation could not be read/);
  assert.equal(first.status, 'running');

  first.taintedAt = '2026-10-21T10:00:00.000Z';
  await assert.rejects(fleet.handOffPrivate({ owner: 'joel', id: first.id, agent: 'claude', conversation: false }), /production data/);
  delete first.taintedAt;

  const before = calls.statusd.filter((c) => c.path === '/transcript').length;
  const next = await fleet.handOffPrivate({ owner: 'joel', id: first.id, agent: 'claude', conversation: false });
  assert.equal(calls.statusd.filter((c) => c.path === '/transcript').length, before, 'no read');
  assert.equal(attachments.written[next.id], undefined);
  assert.match(next.prompt, /from a Codex session/);
  assert.match(next.prompt, /was not handed over/);
  assert.equal(next.options.agent, 'claude');
});

test('a hand-off whose push is refused leaves the session running with its checkout, and starts nothing', async () => {
  const attachments = fakeAttachments();
  const { fleet, calls, statuses, answers, alive, store } = setup({ attachments });
  const first = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it', workOn: 'joel/fix' });
  statuses[first.id] = { state: 'done', branch: 'joel/fix' };
  await fleet.tick();
  answers['/transcript'] = { entries: [{ role: 'user', text: 'Fix it', at: null }] };
  const refused = Object.assign(new Error('statusd /checkpoint answered 500'), { status: 500, body: { error: 'Command failed: git push -u origin HEAD\n! [rejected] HEAD -> joel/fix (fetch first)' } });
  answers['/checkpoint'] = Promise.reject(refused);
  answers['/checkpoint'].catch(() => {});
  const before = store.state.sessions.length;
  await assert.rejects(fleet.handOffPrivate({ owner: 'joel', id: first.id, agent: 'codex' }), {
    shown: true, message: /its work could not be pushed \(Command failed: git push -u origin HEAD\): it keeps running/,
  });
  assert.equal(first.status, 'running');
  assert.equal(first.stopReason, null);
  assert.ok(alive.has(`c-${first.id}`), 'its container, and the checkout in it, stay');
  assert.ok(!calls.stopped.includes(`c-${first.id}`));
  assert.deepEqual(calls.statusd.find((c) => c.path === '/checkpoint').body, { keepRunningOnFailure: true }, 'statusd lets it run on');
  assert.equal(store.state.sessions.length, before, 'no new session');
  assert.deepEqual(attachments.written, {});
});

test('a hand-off and a lockdown never overlap: a lockdown under way refuses the hand-off, and a hand-off refuses a lockdown', async () => {
  const attachments = fakeAttachments();
  const { fleet, statuses, answers, launcher, store } = setup({ attachments });
  const first = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it', workOn: 'joel/fix' });
  statuses[first.id] = { state: 'done', branch: 'joel/fix' };
  await fleet.tick();
  first.mayUseProduction = true;
  let unlock;
  launcher.lockDown = () => new Promise((resolve) => { unlock = resolve; });
  const lockdown = fleet.taint(first, { why: 'test' });
  await assert.rejects(fleet.handOffPrivate({ owner: 'joel', id: first.id, agent: 'codex' }), /seen production data/);
  unlock(null);
  await lockdown;
  assert.ok(first.taintedAt);

  const second = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it', workOn: 'joel/two' });
  statuses[second.id] = { state: 'done', branch: 'joel/two' };
  await fleet.tick();
  second.mayUseProduction = true;
  let release;
  answers['/transcript'] = new Promise((resolve) => { release = resolve; });
  const before = store.state.sessions.length;
  const handing = fleet.handOffPrivate({ owner: 'joel', id: second.id, agent: 'codex' });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(fleet.taint(second, { why: 'test' }), /being handed off/, 'the first production call is refused');
  assert.equal(second.taintedAt, undefined);
  // Had a lockdown won anyway, what was read goes nowhere.
  second.taintedAt = '2026-10-21T10:00:00.000Z';
  release({ entries: [{ role: 'assistant', text: 'order 42: paid', at: null }] });
  await assert.rejects(handing, /seen production data/);
  assert.equal(second.status, 'running');
  assert.equal(store.state.sessions.length, before, 'no replacement');
  assert.deepEqual(attachments.written, {}, 'no attachment');
});

test('a hand-off checks the branch before it stops anything, and gives the new agent no looser a permission mode than the old one had', async () => {
  const { fleet, statuses, answers, github } = setup({ attachments: fakeAttachments() });
  github.defaultBranch = async () => 'main';
  answers['/transcript'] = { entries: [] };
  const onMain = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it', workOn: 'joel/fix', permissionMode: 'plan' });
  statuses[onMain.id] = { state: 'done', branch: 'main' };
  await fleet.tick();
  assert.equal(onMain.branch, 'main', 'the agent checked out the default branch');
  await assert.rejects(fleet.handOffPrivate({ owner: 'joel', id: onMain.id, agent: 'codex' }), /main is not a branch name a session can work on/);
  assert.equal(onMain.status, 'running');

  statuses[onMain.id] = { state: 'done', branch: 'joel/fix' };
  await fleet.tick();
  const toCodex = await fleet.handOffPrivate({ owner: 'joel', id: onMain.id, agent: 'codex' });
  assert.equal(toCodex.options.permissionMode, 'plan', 'plan is a Codex mode too');
  const edits = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it', workOn: 'joel/edits', permissionMode: 'acceptEdits' });
  statuses[edits.id] = { state: 'done', branch: 'joel/edits' };
  await fleet.tick();
  const fromEdits = await fleet.handOffPrivate({ owner: 'joel', id: edits.id, agent: 'codex' });
  assert.equal(fromEdits.options.permissionMode, 'plan', 'Codex has no acceptEdits, and its next mode runs commands unasked: read-only');
  const auto = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it', workOn: 'joel/auto' });
  statuses[auto.id] = { state: 'done', branch: 'joel/auto' };
  await fleet.tick();
  const toGrok = await fleet.handOffPrivate({ owner: 'joel', id: auto.id, agent: 'grok' });
  assert.deepEqual([toGrok.options.agent, toGrok.options.permissionMode], ['grok', 'auto'], 'auto to auto, on another agent of the registry');
});

test('the hand-off file is written by the real attachments store and goes out in the new session\'s tar', async (t) => {
  const { createAttachments } = await import('./attachments.mjs');
  const { execFileSync } = await import('node:child_process');
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { PassThrough } = await import('node:stream');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'woodshed-handoff-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const attachments = createAttachments({ dir });
  const { fleet, statuses, answers, calls } = setup({ attachments });
  const first = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it', workOn: 'joel/fix' });
  statuses[first.id] = { state: 'done', branch: 'joel/fix' };
  await fleet.tick();
  answers['/transcript'] = { entries: [{ role: 'assistant', text: 'MARKER-7f3: the token check was inverted', at: null }] };
  const next = await fleet.handOffPrivate({ owner: 'joel', id: first.id, agent: 'codex' });
  assert.equal(calls.started.filter((c) => c.id === next.id).at(-1).env.ATTACHMENTS, '1', 'the container is told to fetch one');
  const out = new PassThrough();
  const chunks = [];
  out.on('data', (c) => chunks.push(c));
  out.writeHead = () => {};
  await attachments.send(next.id, out);
  const tarFile = path.join(dir, 'got.tar');
  await fsp.writeFile(tarFile, Buffer.concat(chunks));
  assert.deepEqual(execFileSync('tar', ['tf', tarFile], { encoding: 'utf8' }).trim().split('\n'), ['1-handoff.md']);
  assert.match(execFileSync('tar', ['xOf', tarFile, '1-handoff.md'], { encoding: 'utf8' }), /MARKER-7f3: the token check was inverted/);
  assert.equal(await attachments.has(first.id), false, 'nothing under the old session');
});

test('a Stop pressed while a hand-off reads the conversation ends the hand-off: nothing is attached and nothing starts', async () => {
  const attachments = fakeAttachments();
  const { fleet, statuses, answers, store } = setup({ attachments });
  const first = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it', workOn: 'joel/fix' });
  statuses[first.id] = { state: 'done', branch: 'joel/fix' };
  await fleet.tick();
  const before = store.state.sessions.length;

  // The ordinary stop's push is refused, so it stops anyway, and is done before the read is.
  let release;
  answers['/transcript'] = new Promise((resolve) => { release = resolve; });
  answers['/checkpoint'] = Promise.reject(Object.assign(new Error('statusd /checkpoint answered 500'), { status: 500 }));
  answers['/checkpoint'].catch(() => {});
  const handing = fleet.handOffPrivate({ owner: 'joel', id: first.id, agent: 'codex' });
  await new Promise((resolve) => setImmediate(resolve));
  await fleet.stop(first, 'stopped from the console', { by: 'joel' });
  assert.equal(first.status, 'stopped');
  release({ entries: [{ role: 'assistant', text: 'Half done.', at: null }] });
  await assert.rejects(handing, { shown: true, message: /it was stopped meanwhile: nothing was handed off/ });
  assert.equal(first.stopReason, 'stopped from the console');
  assert.equal(first.handedOffTo, undefined);

  // A stop still pushing when the read comes back ends it the same way.
  const second = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it', workOn: 'joel/two' });
  statuses[second.id] = { state: 'done', branch: 'joel/two' };
  await fleet.tick();
  const beforeSecond = store.state.sessions.length;
  answers['/transcript'] = new Promise((resolve) => { release = resolve; });
  let push;
  answers['/checkpoint'] = new Promise((resolve) => { push = resolve; });
  const handingSecond = fleet.handOffPrivate({ owner: 'joel', id: second.id, agent: 'codex' });
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = fleet.stop(second, 'stopped from the console', { by: 'joel' });
  assert.equal(second.status, 'stopping');
  release({ entries: [] });
  await assert.rejects(handingSecond, { shown: true, message: /it was stopped meanwhile: nothing was handed off/ });
  push({ committed: true, head: 'def' });
  await stopping;
  assert.equal(second.status, 'stopped');
  assert.equal(second.stopReason, 'stopped from the console');
  assert.equal(store.state.sessions.length, beforeSecond, 'no new session');
  assert.equal(beforeSecond, before + 1, 'only the second one started meanwhile');
  assert.deepEqual(attachments.written, {}, 'no attachment');
});

test('a Stop pressed while a hand-off pushes is carried out when the push fails', async () => {
  const { fleet, statuses, answers, alive } = setup({ attachments: fakeAttachments() });
  const first = await fleet.startPrivate({ owner: 'joel', prompt: 'Fix it', workOn: 'joel/fix' });
  statuses[first.id] = { state: 'done', branch: 'joel/fix' };
  await fleet.tick();
  answers['/transcript'] = { entries: [] };
  let refuse;
  answers['/checkpoint'] = new Promise((_, reject) => { refuse = reject; });
  answers['/checkpoint'].catch(() => {});
  const handing = fleet.handOffPrivate({ owner: 'joel', id: first.id, agent: 'codex' });
  for (let i = 0; i < 20 && first.status !== 'stopping'; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(first.status, 'stopping');
  await fleet.stop(first, 'stopped from the console', { by: 'joel' });
  answers['/checkpoint'] = { committed: false, head: 'abc' };
  refuse(Object.assign(new Error('statusd /checkpoint answered 500'), { status: 500, body: { error: 'Command failed: git push -u origin HEAD' } }));
  await assert.rejects(handing, /its work could not be pushed \(Command failed: git push -u origin HEAD\): it was stopped, as asked meanwhile/);
  assert.equal(first.status, 'stopped');
  assert.equal(first.stopReason, 'stopped from the console');
  assert.equal(first.stoppedBy, 'joel');
  assert.ok(!alive.has(`c-${first.id}`));
});
