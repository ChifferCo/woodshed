import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPrAnnouncer } from './prAnnouncer.mjs';
import { pullRequestFilters, reviewVerdict, suiteNeverRuns, suiteOutcome } from './pullGates.mjs';

const MINUTE = 60_000;
const REVIEW = { author: 'review-bot[bot]', heading: '## Code review', workflow: '.github/workflows/review.yml', rerun: '[review]', commentAuthor: 'review-bot[bot]' };
const SUITE = { name: 'e2e suite', workflow: '.github/workflows/e2e.yml', jobs: 'e2e run', rerun: '[e2e]' };
const GATES = { review: REVIEW, suites: [SUITE], qa: { check: 'QA', label: 'qa', heading: '## QA', author: 'qa-bot[bot]' }, mergeRisk: { check: 'Merge risk' } };
const E2E_WORKFLOW = [
  'name: e2e', '', 'on:', '  push:', '    branches: [main]', '  pull_request:', '    paths-ignore:',
  "      - 'docs/**'", "      - '**/*.md'", "      - '.github/workflows/**'", "      - '!.github/workflows/e2e.yml'", '',
  'jobs:', '  run:', "    name: ${{ format('e2e run ({0}/{1})', matrix.shard, 4) }}", '    steps:', '      - run: |', '          echo [ not yaml lite',
].join('\n');

let reviewIds = 0;
const verdict = (state, commitId = 'abc') => ({
  id: ++reviewIds, user: { login: 'review-bot[bot]' }, state, body: `## Code review — ${state}`, commit_id: commitId,
  html_url: `https://github.com/acme/app/pull/7#pullrequestreview-${reviewIds}`,
});
const shard = (n, conclusion = 'success', status = 'completed') => ({
  name: `e2e run (${n}/4)`, status, conclusion, html_url: `https://github.com/acme/app/runs/${n}`,
});
const allShards = (conclusion) => [1, 2, 3, 4].map((n) => shard(n, conclusion));
// What GitHub really shows for a skipped matrix, as on a draft or a commit without the tag.
const UNEXPANDED_SKIP = {
  name: "matrix.machines == 'flaky' && 'Flaky check' || format('e2e run ({0}/{1})', matrix.shard, 4)",
  status: 'completed', conclusion: 'skipped', html_url: 'https://github.com/acme/app/runs/9',
};

function setup({
  reviews = [verdict('APPROVED')], runs = allShards('success'), pull = {}, heard = false, files = ['app/page.tsx'], qaWaitMs, flowing = false,
  gates = GATES, workflows = { '.github/workflows/e2e.yml': E2E_WORKFLOW },
} = {}) {
  let clock = Date.parse('2026-10-26T12:00:00.000Z');
  const github = {
    reviews: async () => reviews,
    checkRuns: async () => runs,
    pullFiles: async () => files,
    defaultBranchFile: async (path) => workflows[path] ?? null,
    comments: [],
    comment: async function (number, body) { github.comments.push({ number, body }); return 1; },
    issueComments: async () => github.onPr,
    workflows: {
      41700000001: { path: '.github/workflows/review.yml', head_sha: 'abc' },
      41700000002: { path: '.github/workflows/review.yml', head_sha: 'other-pr' },
      999: { path: '.github/workflows/sneaky.yml', head_sha: 'abc' },
    },
    workflowRun: async (id) => github.workflows[id] ?? null,
    onPr: [],
    edits: [],
    updateComment: async (id, body) => { github.edits.push({ id, body }); return id; },
    reads: 0,
    pull: async (number) => ({
      reads: ++github.reads,
      number, title: 'Add GTM', html_url: `https://github.com/acme/app/pull/${number}`, state: 'open', draft: false, head: { sha: 'abc' },
      created_at: '2026-10-26T12:00:00Z', ...pull,
    }),
  };
  const slack = { available: true, posts: [], async postPr(pr) { this.posts.push(pr); return true; } };
  const store = { state: {}, save() {} };
  const told = [];
  const dropped = [];
  const gaveUp = [];
  const events = {
    feedback: (item, text) => { told.push(text); return heard; }, dropped: (item, why) => { dropped.push(why); },
    gaveUp: (item, info) => { gaveUp.push({ sessionId: item.sessionId, ...info }); },
  };
  const holder = { gates };
  const announcer = createPrAnnouncer({
    store, github, slack, gates: async () => (typeof holder.gates === 'function' ? holder.gates() : holder.gates), now: () => clock, events,
    ...(qaWaitMs && { qaWaitMs: () => qaWaitMs }), webhooksFlowing: () => flowing, fallbackMs: 5 * MINUTE,
  });
  const session = { id: 's1', prUrl: 'https://github.com/acme/app/pull/7', createdAt: '2026-10-26T11:00:00Z' };
  return { announcer, github, slack, store, session, told, dropped, gaveUp, holder, advance: (ms) => { clock += ms; } };
}

test('the review verdict is its author\'s latest, and only a body under its heading counts', () => {
  assert.equal(reviewVerdict([verdict('CHANGES_REQUESTED'), verdict('APPROVED')], REVIEW)?.state, 'APPROVED');
  assert.equal(reviewVerdict([verdict('APPROVED'), verdict('CHANGES_REQUESTED')], REVIEW)?.state, 'CHANGES_REQUESTED');
  assert.equal(reviewVerdict([{ user: { login: 'octocat' }, state: 'APPROVED', body: '## Code review' }], REVIEW), null);
  assert.equal(reviewVerdict([{ user: { login: 'review-bot[bot]' }, state: 'APPROVED', body: 'LGTM' }], REVIEW), null);
  assert.equal(reviewVerdict([verdict('APPROVED')], null), null, 'no review configured');
});

test('a suite is green only when every job under its name ran and passed', () => {
  const green = (runs) => suiteOutcome(runs, SUITE) === 'green';
  assert.equal(green(allShards('success')), true);
  assert.equal(green(allShards('skipped')), false, 'the workflow passes with every job skipped');
  assert.equal(green([...allShards('success').slice(0, 3), shard(4, 'failure')]), false);
  assert.equal(green([...allShards('success').slice(0, 3), shard(4, null, 'in_progress')]), false);
  assert.equal(green([{ name: 'Lint', status: 'completed', conclusion: 'success' }]), false);
});

test('an approved pull request with a green suite is posted, then no longer waits', async () => {
  const { announcer, slack, store, session } = setup();
  await announcer.track(session);
  await announcer.check();
  assert.deepEqual(slack.posts.map((p) => [p.title, p.url]), [['Add GTM', 'https://github.com/acme/app/pull/7']], 'the one line, as before');
  assert.match(slack.posts[0].brief, /^👉 \*\*Please look before merging\*\*/, 'the thread starts with the verdict: the post above has the title');
  assert.deepEqual(store.state.slackPending, []);
});

for (const [why, opts] of [
  ['no verdict yet', { reviews: [] }],
  ['changes requested', { reviews: [verdict('APPROVED'), verdict('CHANGES_REQUESTED')] }],
  ['the suite skipped', { runs: allShards('skipped') }],
  ['a shard failed', { runs: [...allShards('success').slice(0, 3), shard(4, 'failure')] }],
]) {
  test(`a pull request is not posted with ${why}, and keeps waiting`, async () => {
    const { announcer, slack, store, session } = setup(opts);
    await announcer.track(session);
    await announcer.check();
    assert.deepEqual(slack.posts, []);
    assert.equal(store.state.slackPending.length, 1);
  });
}

test('it is posted on the first check after it turns approved and green, at most once a minute', async () => {
  const { announcer, github, slack, session, advance } = setup({ reviews: [] });
  await announcer.track(session);
  await announcer.check();
  github.reviews = async () => [verdict('APPROVED')];
  await announcer.check();
  assert.deepEqual(slack.posts, [], 'the next check is a minute away');
  advance(MINUTE);
  await announcer.check();
  assert.equal(slack.posts.length, 1);
});

test('a closed pull request, or one waiting over a week, is never posted', async () => {
  const closed = setup({ pull: { state: 'closed' } });
  await closed.announcer.track(closed.session);
  await closed.announcer.check();
  assert.deepEqual([closed.slack.posts, closed.store.state.slackPending], [[], []]);

  const stale = setup({ reviews: [] });
  await stale.announcer.track(stale.session);
  stale.advance(8 * 24 * 60 * MINUTE);
  await stale.announcer.check();
  assert.deepEqual(stale.store.state.slackPending, []);
});

test('the suite\'s outcome tells running, failed and skipped apart', () => {
  const outcome = (runs) => suiteOutcome(runs, SUITE);
  assert.equal(outcome([]), 'none');
  assert.equal(outcome([...allShards('success').slice(0, 3), shard(4, null, 'in_progress')]), 'running');
  assert.equal(outcome(allShards('success')), 'green');
  assert.equal(outcome([...allShards('success').slice(0, 3), shard(4, 'failure')]), 'failed');
  assert.equal(outcome([...allShards('skipped').slice(0, 3), shard(4, 'timed_out')]), 'failed');
  assert.equal(outcome(allShards('skipped')), 'skipped');
  assert.equal(outcome([UNEXPANDED_SKIP]), 'skipped', 'a skipped matrix keeps its unexpanded name, the jobs\' name quoted in it');
  assert.equal(outcome([{ ...UNEXPANDED_SKIP, conclusion: 'success' }]), 'none', 'only a skipped one');
});

test('a posted pull request tells the fleet, which stops its session', async () => {
  const { announcer, session, dropped, told } = setup();
  await announcer.track(session);
  assert.deepEqual([...announcer.waitingSessions()], ['s1']);
  await announcer.check();
  assert.deepEqual(dropped, ['posted']);
  assert.equal(told.length, 1, 'only the approval note');
  assert.match(told[0], /is APPROVE/);
  assert.match(told[0], /once QA has finished on it/);
  assert.match(told[0], /a commit whose subject has \[review\]\[e2e\]/, 'the re-run tags are the project file\'s');
  assert.deepEqual([...announcer.waitingSessions()], []);
});

test('changes asked for on the head commit are handed to the session once', async () => {
  const { announcer, github, session, told, advance } = setup({ reviews: [verdict('APPROVED'), verdict('CHANGES_REQUESTED')] });
  await announcer.track(session);
  await announcer.check();
  assert.equal(told.length, 1);
  assert.match(told[0], /^The review verdict on PR #7 at abc asks for changes: https:\/\/github\.com\/acme\/app\/pull\/7#pullrequestreview-\d+\./);
  assert.match(told[0], /push a commit whose subject has \[review\]\[e2e\]\./);
  advance(MINUTE);
  await announcer.check();
  assert.equal(told.length, 1, 'the same verdict is not handed over again');

  github.reviews = async () => [verdict('CHANGES_REQUESTED', 'older')];
  github.pull = async (number) => ({ number, title: 't', html_url: 'u', state: 'open', head: { sha: 'def' }, created_at: '2026-10-26T12:00:00Z' });
  advance(MINUTE);
  await announcer.check();
  assert.equal(told.length, 1, 'a verdict on an older commit says nothing about the new one');
});

test('a failed or skipped suite is handed to the session once for each commit', async () => {
  const failed = setup({ runs: [...allShards('success').slice(0, 3), shard(4, 'failure')] });
  await failed.announcer.track(failed.session);
  await failed.announcer.check();
  assert.equal(failed.told.length, 1);
  assert.match(failed.told[0], /^The e2e suite failed on PR #7 at abc: e2e run \(4\/4\) https:\/\/github\.com\/acme\/app\/runs\/4\./);
  assert.match(failed.told[0], /push a commit whose subject has \[e2e\]\./);
  failed.advance(MINUTE);
  await failed.announcer.check();
  assert.equal(failed.told.length, 1);

  const skipped = setup({ runs: allShards('skipped') });
  await skipped.announcer.track(skipped.session);
  await skipped.announcer.check();
  assert.match(skipped.told[0], /^The e2e suite was skipped on PR #7 at abc/);
  assert.match(skipped.told[0], /whose subject does not have \[e2e\]/);
  assert.match(skipped.told[0], /gh run list --workflow=e2e\.yml --branch/);
  assert.match(skipped.told[0], /git commit --allow-empty -m "\[e2e\] Run the e2e suite"/);
  assert.match(skipped.told[0], /Needs a human:.*Started by @/s, 'a stuck session tags whoever started it');

  const draft = setup({ runs: [UNEXPANDED_SKIP] });
  await draft.announcer.track(draft.session);
  await draft.announcer.check();
  assert.match(draft.told[0], /^The e2e suite was skipped on PR #7 at abc/);

  const running = setup({ reviews: [], runs: [shard(1, null, 'in_progress')] });
  await running.announcer.track(running.session);
  await running.announcer.check();
  assert.deepEqual(running.told, [], 'nothing while it runs');
});

test('a failed check logs GitHub\'s reason from gh, not only the command, and keeps waiting', async (t) => {
  const { announcer, github, slack, store, session } = setup();
  await announcer.track(session);
  github.checkRuns = async () => {
    throw Object.assign(new Error('Command failed: gh api repos/acme/app/commits/abc/check-runs'), {
      stderr: 'gh: Resource not accessible by integration (HTTP 403)\n',
    });
  };
  const warn = t.mock.method(console, 'warn', () => {});
  await announcer.check();
  assert.deepEqual(warn.mock.calls.map((c) => c.arguments), [
    ['slack: pull request check failed', { number: 7, message: 'gh: Resource not accessible by integration (HTTP 403)' }],
  ]);
  assert.deepEqual(slack.posts, []);
  assert.equal(store.state.slackPending.length, 1);
});

test('a project file that cannot be read holds the pull request, rather than posting it with no gates', async (t) => {
  const { announcer, slack, store, session, holder, advance } = setup();
  holder.gates = () => { throw new Error('the project file could not be read: HTTP 502'); };
  const warn = t.mock.method(console, 'warn', () => {});
  await announcer.track(session);
  await announcer.check();
  assert.deepEqual(slack.posts, []);
  assert.equal(store.state.slackPending.length, 1);
  assert.match(warn.mock.calls[0].arguments[1].message, /project file could not be read/);
  holder.gates = GATES;
  advance(MINUTE);
  await announcer.check();
  assert.equal(slack.posts.length, 1, 'posted once it can be read');
});

test('a pull request that gives up waiting gets a comment tagging whoever started its session', async () => {
  const { announcer, github, session, dropped, gaveUp, advance } = setup({
    reviews: [], runs: allShards('skipped'), pull: { body: 'Started by @octocat via [Woodshed Cloud](https://x/s/1).\n\nCloses #26385' },
  });
  await announcer.track(session);
  advance(1000 * 60 * 60 * 24 * 30);
  await announcer.check();
  assert.deepEqual(dropped, ['not approved and green in time']);
  assert.deepEqual(github.comments.map((c) => c.number), [7, 26385], 'the PR and the ticket it closes');
  assert.match(github.comments[0].body, /^Needs a human: @octocat this pull request did not pass its review and checks in time/);
  assert.match(github.comments[1].body, /The pull request is #7: https:\/\/github.com\/acme\/app\/pull\/7$/);
  assert.match(github.comments[0].body, /Review verdict: none\. E2e suite: skipped\./);
  assert.deepEqual(gaveUp, [{
    sessionId: 's1', number: 7, url: 'https://github.com/acme/app/pull/7', review: 'none', suites: [{ name: 'e2e suite', outcome: 'skipped' }],
  }], 'and its session hears it, for the assignee');
});

test('giving up without a starter on the PR still comments, and a failed comment does not stop the drop', async () => {
  const { announcer, github, session, dropped, advance } = setup({ reviews: [], runs: allShards('skipped') });
  github.comment = async () => { throw new Error('no'); };
  await announcer.track(session);
  advance(1000 * 60 * 60 * 24 * 30);
  await announcer.check();
  assert.deepEqual(dropped, ['not approved and green in time']);
});

test('an approval is handed to the session once, and the post waits a grace period for it to read the notes', async () => {
  const { announcer, slack, session, told, dropped, advance } = setup({ heard: true });
  await announcer.track(session);
  await announcer.check();
  assert.equal(told.length, 1);
  assert.match(told[0], /is APPROVE/);
  assert.deepEqual(slack.posts, [], 'held');
  advance(2 * MINUTE);
  await announcer.check();
  assert.deepEqual(slack.posts, [], 'still inside the grace period');
  assert.equal(told.length, 1, 'told once');
  advance(4 * MINUTE);
  await announcer.check();
  assert.equal(slack.posts.length, 1);
  assert.deepEqual(dropped, ['posted']);
});

test('an approval nobody heard (a private or deleted session) is posted at once', async () => {
  const { announcer, slack, session } = setup({ heard: false });
  await announcer.track(session);
  await announcer.check();
  assert.equal(slack.posts.length, 1);
});

test('a workflow\'s path filters are read from its on: section alone, as GitHub applies them', () => {
  const filters = pullRequestFilters(E2E_WORKFLOW);
  assert.deepEqual(filters, { pathsIgnore: ['docs/**', '**/*.md', '.github/workflows/**', '!.github/workflows/e2e.yml'], paths: null });
  assert.equal(suiteNeverRuns(['docs/a/b.txt', 'README.md', 'app/notes.md'], filters), true);
  assert.equal(suiteNeverRuns(['docs/a.txt', 'app/page.tsx'], filters), false);
  assert.equal(suiteNeverRuns(['.github/workflows/ci.yml'], filters), true);
  assert.equal(suiteNeverRuns(['.github/workflows/e2e.yml'], filters), false, 'a ! pattern takes a path back');
  assert.equal(suiteNeverRuns(['docsx/a.txt'], filters), false);
  assert.equal(suiteNeverRuns([], filters), false);
  assert.equal(suiteNeverRuns(null, filters), false, 'more files than were read');
  const only = pullRequestFilters("on:\n  pull_request:\n    paths: ['app/**']\njobs: {}\n");
  assert.equal(suiteNeverRuns(['docs/a.txt'], only), true, 'paths: nothing it names was touched');
  assert.equal(suiteNeverRuns(['docs/a.txt', 'app/x/y.ts'], only), false);
  assert.deepEqual(pullRequestFilters('on: [push, pull_request]\n'), { pathsIgnore: null, paths: null });
  assert.throws(() => pullRequestFilters('name: x\n'), /no on: section/);
});

test('an approved pull request touching only ignored paths is posted without waiting for a suite that never runs', async (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const { announcer, slack, session, dropped } = setup({ runs: [], files: ['docs/guide.txt'] });
  await announcer.track(session);
  await announcer.check();
  assert.equal(slack.posts.length, 1);
  assert.deepEqual(dropped, ['posted']);
  assert.ok(log.mock.calls.some((c) => c.arguments[0] === 'slack: a suite does not run for these paths, not waiting for it'));
});

test('a pull request that touches the app still waits for its suite', async () => {
  const { announcer, slack, session } = setup({ runs: [], files: ['docs/guide.txt', 'app/page.tsx'] });
  await announcer.track(session);
  await announcer.check();
  assert.deepEqual(slack.posts, []);
});

test('a suite workflow that cannot be read is waited for, with a warning, and read again at the next check', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const { announcer, github, slack, session, advance } = setup({ runs: [], files: ['docs/guide.txt'], workflows: {} });
  await announcer.track(session);
  await announcer.check();
  assert.deepEqual(slack.posts, [], 'not skipped');
  assert.deepEqual(warn.mock.calls[0].arguments, ['slack: a suite\'s path filters not read, waiting for it', {
    number: 7, suite: 'e2e suite', workflow: '.github/workflows/e2e.yml', message: 'the workflow file is not on the default branch',
  }]);
  github.defaultBranchFile = async () => E2E_WORKFLOW;
  advance(MINUTE);
  await announcer.check();
  assert.equal(slack.posts.length, 1, 'read again, and then skipped');
});

test('an approval of an older commit does not post a newer head', async () => {
  const { announcer, slack, session } = setup({ reviews: [verdict('APPROVED', 'old')] });
  await announcer.track(session);
  await announcer.check();
  assert.deepEqual(slack.posts, [], 'the head is not reviewed yet');
});

test('the files of a pull request that still needs the suite are read once for each commit', async () => {
  const { announcer, github, session, advance } = setup({ runs: [], files: ['app/page.tsx'] });
  let reads = 0;
  const read = github.pullFiles;
  github.pullFiles = async (n) => { reads++; return read(n); };
  await announcer.track(session);
  await announcer.check();
  advance(2 * MINUTE);
  await announcer.check();
  assert.equal(reads, 1);
});

const QA_LABELLED = { labels: [{ name: 'qa' }] };
const qaCheck = (title, conclusion, status = 'completed') => ({
  name: 'QA', app: { slug: 'github-actions' }, status, conclusion, output: { title }, html_url: 'https://github.com/acme/app/runs/50',
});

test('a labelled pull request waits for its QA check after the grace period, then its brief quotes QA', async () => {
  const { announcer, github, slack, session, advance } = setup({ pull: QA_LABELLED });
  await announcer.track(session);
  await announcer.check();
  assert.deepEqual(slack.posts, [], 'approved and green, but QA has not finished');
  github.checkRuns = async () => [...allShards('success'), qaCheck('Waiting for the review to approve this commit', 'neutral')];
  advance(MINUTE);
  await announcer.check();
  assert.deepEqual(slack.posts, [], 'the neutral check posted before the approval is not a QA result');
  github.checkRuns = async () => [...allShards('success'), qaCheck('Pass: 4 test cases passed', 'success')];
  advance(MINUTE);
  await announcer.check();
  assert.equal(slack.posts.length, 1);
  assert.match(slack.posts[0].brief, /\nQA ✅ 4\/4 passed/);
});

test('a QA check that does not finish in time is said to be not run, after the Console setting\'s wait', async () => {
  const { announcer, slack, session, advance } = setup({ pull: QA_LABELLED, qaWaitMs: 10 * MINUTE });
  await announcer.track(session);
  await announcer.check();
  advance(9 * MINUTE);
  await announcer.check();
  assert.deepEqual(slack.posts, []);
  advance(2 * MINUTE);
  await announcer.check();
  assert.match(slack.posts[0].brief, /\nQA not run \(it did not finish within 10 minutes\)/);
});

test('a pull request without the QA label is not held for a QA run that never starts', async () => {
  const { announcer, slack, session } = setup();
  await announcer.track(session);
  await announcer.check();
  assert.match(slack.posts[0].brief, /\nQA not run \(no qa label\)/);
});

test('the brief is one PR comment, written once and then updated in place, and the post links it', async () => {
  const first = setup();
  await first.announcer.track(first.session);
  await first.announcer.check();
  assert.equal(first.github.comments.length, 1);
  assert.match(first.github.comments[0].body, /^## 🧭 Decision brief\n/);
  assert.match(first.slack.posts[0].brief, /\[Full brief →\]\(https:\/\/github\.com\/acme\/app\/pull\/7#issuecomment-1\)$/);

  const again = setup();
  again.github.onPr = [{ id: 42, user: { login: 'woodshed-cloud[bot]', type: 'Bot' }, body: '## 🧭 Decision brief\n\nold' }];
  await again.announcer.track(again.session);
  await again.announcer.check();
  assert.deepEqual(again.github.comments, [], 'no second comment');
  assert.equal(again.github.edits.length, 1);
  assert.equal(again.github.edits[0].id, 42);
  assert.match(again.slack.posts[0].brief, /#issuecomment-42\)$/);
});

test('a brief comment a person wrote with the same heading is not the one updated', async () => {
  const { announcer, github, session } = setup();
  github.onPr = [{ id: 5, user: { login: 'octocat', type: 'User' }, body: '## 🧭 Decision brief\n\nmine' }];
  await announcer.track(session);
  await announcer.check();
  assert.deepEqual(github.edits, []);
  assert.equal(github.comments.length, 1);
});

const riskCheck = (title, run) => ({
  name: 'Merge risk', status: 'completed', conclusion: 'neutral', app: { slug: 'github-actions' }, head_sha: 'abc',
  details_url: `https://github.com/acme/app/actions/runs/${run}`, output: { title, summary: title },
});

test('a merge risk check is trusted only when GitHub says its run is the review\'s workflow', async () => {
  const real = setup({ runs: [...allShards('success'), riskCheck('Low: Only docs.', 41700000001)] });
  await real.announcer.track(real.session);
  await real.announcer.check();
  assert.match(real.slack.posts[0].brief, /^QA /m);
  assert.equal(real.slack.posts[0].tier, 'Low', 'the post is tagged with the trusted tier');

  for (const [why, run] of [['another workflow', 999], ['the review of another pull request', 41700000002]]) {
    const sneaky = setup({ runs: [...allShards('success'), riskCheck('Low: Trust me.', run)] });
    await sneaky.announcer.track(sneaky.session);
    await sneaky.announcer.check();
    assert.match(sneaky.slack.posts[0].brief, /^\*\*Self-assessed risk\*\* \(no Merge risk check\)/m, why);
    assert.equal(sneaky.slack.posts[0].tier, null, 'an untrusted tier never tags the post');
  }
});

test('while webhooks arrive, a waiting pull request is read when one marks it, or every fallback period', async () => {
  const { announcer, github, session, advance } = setup({ reviews: [], flowing: true });
  await announcer.track(session);
  const tracked = github.reads;
  await announcer.check();
  assert.equal(github.reads, tracked + 1, 'read at once the first time');
  advance(MINUTE);
  await announcer.check();
  assert.equal(github.reads, tracked + 1, 'a minute later it waits for a webhook');
  assert.deepEqual(announcer.stale([7, 99]), [7], 'only a waiting pull request is marked');
  await announcer.check();
  assert.equal(github.reads, tracked + 2, 'read at the next check after the webhook');
  advance(5 * MINUTE);
  await announcer.check();
  assert.equal(github.reads, tracked + 3, 'and after the fallback period without one');
});

test('while webhooks arrive, a pull request in its approval grace period is still read every minute', async () => {
  const { announcer, slack, session, advance } = setup({ heard: true, flowing: true });
  await announcer.track(session);
  await announcer.check();
  assert.deepEqual(slack.posts, [], 'held');
  for (let minute = 1; minute <= 4; minute++) {
    advance(MINUTE);
    await announcer.check();
  }
  assert.deepEqual(slack.posts, [], 'still inside the grace period at the fourth minute');
  advance(MINUTE);
  await announcer.check();
  assert.equal(slack.posts.length, 1, 'posted at the check the grace period ends on, with no webhook to say so');
});

test('with no gates, a pull request is posted once it is out of draft and its checks pass, waiting for nothing else', async () => {
  const { announcer, github, slack, session, told, advance } = setup({
    gates: null, reviews: [], runs: [{ name: 'lint', status: 'in_progress', conclusion: null }], pull: { draft: true, ...QA_LABELLED },
  });
  let reviewReads = 0;
  github.reviews = async () => { reviewReads += 1; return []; };
  await announcer.track(session);
  await announcer.check();
  assert.deepEqual(slack.posts, [], 'a draft');
  const pull = github.pull;
  github.pull = async (n) => ({ ...(await pull(n)), draft: false });
  advance(MINUTE);
  await announcer.check();
  assert.deepEqual(slack.posts, [], 'a check is still running');
  github.checkRuns = async () => [{ name: 'lint', status: 'completed', conclusion: 'success' }];
  advance(MINUTE);
  await announcer.check();
  assert.equal(slack.posts.length, 1);
  assert.deepEqual([told, reviewReads], [[], 0], 'no approval to hold for, and no review read');
  const { brief } = slack.posts[0];
  assert.match(brief, /\nQA not run \(not configured\)/);
  assert.match(brief, /\*\*Risks:\*\* the review comment is not configured/);
  assert.doesNotMatch(brief, /Merge risk|Self-assessed/, 'no merge risk gate, no merge risk line');
  assert.doesNotMatch(github.comments[0].body, /### Merge risk/);
  assert.equal(slack.posts[0].tier, undefined, 'no risk tag on the post');
  assert.match(github.comments[0].body, /### Checks\nWith every other check green\./);
});

test('with no gates, a pull request with no checks yet waits 2 minutes for some to show', async () => {
  const { announcer, github, slack, session, advance } = setup({ gates: null, runs: [] });
  await announcer.track(session);
  await announcer.check();
  assert.deepEqual(slack.posts, [], 'its checks may not have shown yet');
  github.checkRuns = async () => [{ name: 'lint', status: 'in_progress', conclusion: null }];
  advance(MINUTE);
  await announcer.check();
  assert.deepEqual(slack.posts, [], 'one showed and is running');
  github.checkRuns = async () => [];
  advance(MINUTE / 2);
  await announcer.check();
  assert.deepEqual(slack.posts, [], 'still within the wait');
  advance(MINUTE / 2);
  await announcer.check();
  assert.equal(slack.posts.length, 1, 'a repo with no CI is posted once the 2 minutes are over');
});

test('with two suites, each one\'s failure on the same commit is handed over', async () => {
  const smoke = { name: 'smoke tests', workflow: '.github/workflows/smoke.yml', jobs: 'smoke', rerun: '[smoke]' };
  const smokeRun = (conclusion, status = 'completed') => ({ name: 'smoke', status, conclusion, html_url: 'https://github.com/acme/app/runs/20' });
  const { announcer, github, session, told, advance } = setup({
    gates: { ...GATES, suites: [SUITE, smoke] }, runs: [...allShards('success').slice(0, 3), shard(4, 'failure'), smokeRun(null, 'in_progress')],
  });
  await announcer.track(session);
  await announcer.check();
  assert.equal(told.length, 1);
  assert.match(told[0], /^The e2e suite failed/);
  github.checkRuns = async () => [...allShards('success'), smokeRun('failure')];
  advance(MINUTE);
  await announcer.check();
  assert.equal(told.length, 2, 'the same outcomes on the same commit, from another suite');
  assert.match(told[1], /^The smoke tests failed/);
});

test('with no gates, a draft that never leaves draft gives up with a comment saying so', async () => {
  const { announcer, github, session, dropped, gaveUp, advance } = setup({ gates: null, runs: [], pull: { draft: true } });
  await announcer.track(session);
  advance(1000 * 60 * 60 * 24 * 30);
  await announcer.check();
  assert.deepEqual(dropped, ['not approved and green in time']);
  assert.match(github.comments[0].body, /It is still a draft\./);
  assert.deepEqual(gaveUp[0].suites, []);
  assert.equal(gaveUp[0].review, 'not configured');
});

test('a review alone, with no suites, posts on its approval', async () => {
  const { announcer, slack, session } = setup({ gates: { ...GATES, suites: [], qa: null }, runs: [] });
  await announcer.track(session);
  await announcer.check();
  assert.equal(slack.posts.length, 1);
  assert.match(slack.posts[0].brief, /\nQA not run \(not configured\)/);
});

test('a suite without a re-run tag tells the session to push a commit, with no tag', async () => {
  const { announcer, told } = setup({ gates: { ...GATES, review: { ...REVIEW, rerun: null }, suites: [{ ...SUITE, rerun: null }] }, runs: allShards('skipped') });
  await announcer.track({ id: 's1', prUrl: 'https://github.com/acme/app/pull/7', createdAt: '2026-10-26T11:00:00Z' });
  await announcer.check();
  assert.doesNotMatch(told[0], /\[e2e\]|\[review\]|subject does not have/);
  assert.match(told[0], /git commit --allow-empty -m "Run the e2e suite"/);
});

test('another project\'s pull request is read on its repo, with its gates, and a webhook marks it by project', async () => {
  const { announcer, github, slack, store, session } = setup();
  const toolsReads = [];
  const tools = {
    ...github,
    pull: async (number) => { toolsReads.push(number); return github.pull(number); },
  };
  const gatesAsked = [];
  const two = createPrAnnouncer({
    store, github, githubOf: (name) => (name === 'tools' ? tools : null), slack,
    gates: async (project) => { gatesAsked.push(project); return GATES; }, events: {},
  });
  const onTools = { ...session, id: 's2', prUrl: 'https://github.com/acme/tools/pull/7' };
  await two.track(session, { name: 'app', default: true });
  await two.track(onTools, { name: 'tools', default: false });
  assert.deepEqual(store.state.slackPending.map((p) => [p.number, p.project ?? null]), [[7, null], [7, 'tools']], 'two different #7s');
  assert.deepEqual(toolsReads, [7]);
  assert.deepEqual(two.stale([7], 'tools'), [7]);
  assert.deepEqual(two.stale([8], 'tools'), []);
  await two.check();
  assert.deepEqual(gatesAsked, [null, 'tools'], 'each read with its own project\'s gates');
  assert.equal(slack.posts.length, 2);
  assert.deepEqual(store.state.slackPending, []);
});

// Two projects, `app` the default and `tools` added, through the real Slack client and a Slack that answers each post.
async function twoProjects({ appChannel = null, toolsChannel = null, consoleChannel = 'C0CONSOLE01' } = {}) {
  const { createSlack } = await import('./slack.mjs');
  const { github, store, session } = setup({ gates: null, runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] });
  store.state.settings = { slackChannel: consoleChannel };
  const posts = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    posts.push(body);
    return { status: 200, async json() { return { ok: true, ts: body.thread_ts ?? `${posts.length}.0` }; } };
  };
  const slack = createSlack({ store, secrets: { async read() { return 'xoxb-1'; } }, fetchImpl });
  if (appChannel) slack.setProjectChannel({ project: 'app', channel: appChannel, by: 'mia-dev' });
  if (toolsChannel) slack.setProjectChannel({ project: 'tools', channel: toolsChannel, by: 'mia-dev' });
  const dropped = [];
  const announcer = createPrAnnouncer({
    store, github, githubOf: () => github, defaultProjectName: () => 'app', slack, gates: async () => null,
    events: { dropped: (item, why) => { dropped.push({ item, why }); } },
  });
  const onTools = { ...session, id: 's2', prUrl: 'https://github.com/acme/tools/pull/8' };
  await announcer.track(session, { name: 'app', default: true });
  await announcer.track(onTools, { name: 'tools', default: false });
  return { announcer, slack, store, posts, dropped };
}

test('a project with its own channel has its pull request posted there, and the other project\'s goes to the console\'s', async () => {
  const { announcer, posts, dropped } = await twoProjects({ toolsChannel: 'C0TOOLS001' });
  await announcer.check();
  const lines = posts.filter((p) => !p.thread_ts);
  assert.deepEqual(lines.map((p) => [p.channel, p.text.split(' - ')[1]]), [
    ['C0CONSOLE01', 'https://github.com/acme/app/pull/7'],
    ['C0TOOLS001', 'https://github.com/acme/app/pull/8'],
  ]);
  assert.deepEqual(dropped.map((d) => [d.item.sessionId, d.why, d.item.post]), [
    ['s1', 'posted', { channel: 'C0CONSOLE01', ts: '1.0' }],
    ['s2', 'posted', { channel: 'C0TOOLS001', ts: '3.0' }],
  ], 'where each post is goes to the fleet with it');
});

test('the default project\'s own channel counts too, by its name', async () => {
  const { announcer, posts } = await twoProjects({ appChannel: 'C0APPPRS01' });
  await announcer.check();
  assert.deepEqual(posts.filter((p) => !p.thread_ts).map((p) => p.channel), ['C0APPPRS01', 'C0CONSOLE01']);
});

test('the decision brief threads under its own project\'s post', async () => {
  const { announcer, posts } = await twoProjects({ toolsChannel: 'C0TOOLS001' });
  await announcer.check();
  const byTs = new Map(posts.filter((p) => !p.thread_ts).map((p, i) => [`${posts.indexOf(p) + 1}.0`, p.channel]));
  const replies = posts.filter((p) => p.thread_ts);
  assert.equal(replies.length, 2, 'one brief for each');
  for (const r of replies) assert.equal(r.channel, byTs.get(r.thread_ts), 'in the channel of the post it threads under');
  assert.deepEqual(replies.map((r) => r.channel), ['C0CONSOLE01', 'C0TOOLS001']);
});

test('with no console channel, a project without its own waits while one with its own is posted', async () => {
  const { announcer, posts, store } = await twoProjects({ toolsChannel: 'C0TOOLS001', consoleChannel: '' });
  await announcer.check();
  assert.deepEqual(posts.filter((p) => !p.thread_ts).map((p) => p.channel), ['C0TOOLS001']);
  assert.deepEqual(store.state.slackPending.map((p) => p.number), [7], 'the other still waits, as with no channel before');
});
