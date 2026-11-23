// A `gh` for the dev console's review session (devReviewSession.mjs) with DEV_CONSOLE_REVIEW_PR=1: one made-up open
// pull request on the session's branch, kept in a JSON file beside it, answering each call the shed's review makes
// (shared/review/github.mjs, merge.mjs, shared/prStatus.mjs) as GitHub would for it: the pull request's status, the
// draft review and its comments, a verdict, a rename and a squash-merge. It carries a made-up review by Claude Code and
// Codex, as the console's reviewer App posts one (shared/review/aiReviews.mjs reads it), and a Merge risk and a QA check
// (shared/review/prChecks.mjs), for the AI reviews tab. Nothing reaches GitHub: any other call fails
// with what it was, so a call this does not know is seen rather than sent to a real gh.

import fs from 'node:fs';
import path from 'node:path';

const SCRIPT = String.raw`
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const file = process.env.DEV_REVIEW_GH_STATE;
const s = JSON.parse(fs.readFileSync(file, 'utf8'));
const save = () => fs.writeFileSync(file, JSON.stringify(s, null, 2));
const args = process.argv.slice(2);
const out = (v) => { process.stdout.write(typeof v === 'string' ? v + '\n' : JSON.stringify(v) + '\n'); process.exit(0); };
const fail = (why) => { process.stderr.write('dev review gh: ' + why + '\n'); process.exit(1); };
const fields = {};
for (let i = 0; i < args.length; i++) if (args[i] === '-f' || args[i] === '-F') { const [k, ...v] = args[++i].split('='); fields[k] = v.join('='); }
const head = () => execFileSync('git', ['-C', s.repo, 'rev-parse', 'HEAD']).toString().trim();
const at = () => new Date().toISOString();
const id = (p) => p + '_' + Math.random().toString(36).slice(2, 10);
const rollup = () => s.checks.map((c) => ({ status: 'COMPLETED', conclusion: c }));
// The made-up AI review is left out, so the review and merge @local try here start from review required, as before it.
const people = () => s.verdicts.filter((v) => !v.bot);
const decision = () => (people().some((v) => v.state === 'CHANGES_REQUESTED') ? 'CHANGES_REQUESTED' : people().some((v) => v.state === 'APPROVED') ? 'APPROVED' : 'REVIEW_REQUIRED');
const url = 'https://github.com/' + s.slug + '/pull/' + s.number;
// The session's earlier pull requests, on branches of their own: no comments or verdicts, only what a review reads.
const other = (n) => (s.others || []).find((o) => String(o.number) === String(n)) || null;
const urlOf = (o) => 'https://github.com/' + s.slug + '/pull/' + o.number;
// Whose draft and threads a call is about: an earlier pull request's own, else the checkout's (s).
const byPrId = (prId) => (s.others || []).find((o) => 'PR_dev' + o.number === prId) || s;
const byReviewId = (rid) => [s, ...(s.others || [])].find((h) => h.pending && h.pending.id === rid) || s;
const byCommentId = (cid) => [s, ...(s.others || [])].find((h) => h.pending && h.pending.comments.some((c) => c.id === cid)) || s;
const otherView = (o) => ({ id: 'PR_dev' + o.number, number: o.number, title: o.title, body: o.body, author: { login: s.login },
  headRefName: o.branch, headRefOid: o.sha, baseRefName: s.base, isCrossRepository: false, state: 'OPEN', url: urlOf(o), isDraft: false,
  additions: o.additions, deletions: o.deletions, changedFiles: o.changedFiles, files: [], reviewDecision: 'REVIEW_REQUIRED',
  mergeStateStatus: 'CLEAN', statusCheckRollup: rollup() });

if (args[0] === 'api' && args[1] === 'user') out(s.login);
if (args[0] === 'pr' && args[1] === 'list') {
  const branch = args[args.indexOf('--head') + 1];
  const o = (s.others || []).find((x) => x.branch === branch);
  if (o) out([{ number: o.number, title: o.title, headRefName: o.branch, state: 'OPEN', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', url: urlOf(o), statusCheckRollup: rollup() }]);
  if (branch !== s.branch) out([]);
  out([{ number: s.number, title: s.title, headRefName: s.branch, state: s.state, isDraft: false, reviewDecision: decision(), url, statusCheckRollup: rollup() }]);
}
if (args[0] === 'pr' && args[1] === 'view' && other(args[2])) out(otherView(other(args[2])));
if (args[0] === 'pr' && args[1] === 'view') {
  out({ id: 'PR_dev', number: s.number, title: s.title, state: s.state, isDraft: false, reviewDecision: decision(), headRefOid: head(),
    baseRefName: s.base, mergeStateStatus: 'CLEAN', statusCheckRollup: rollup() });
}
if (args[0] === 'pr' && args[1] === 'review') {
  const state = args.includes('--approve') ? 'APPROVED' : args.includes('--request-changes') ? 'CHANGES_REQUESTED' : 'COMMENTED';
  const bodyFile = args[args.indexOf('--body-file') + 1];
  const body = args.includes('--body-file') ? fs.readFileSync(bodyFile, 'utf8') : '';
  // Kept on the pull request it names: an earlier one's verdict never lands on the checkout's.
  const o = other(args[2]);
  (o ? (o.verdicts ||= []) : s.verdicts).push({ id: id('PRR'), author: s.login, state, body, at: at() });
  save();
  out('');
}
if (args[0] === 'api' && args[1] === '-X' && args[2] === 'PATCH') {
  s.title = fields.title;
  save();
  out(s.title);
}
if (args[0] === 'api' && args[1] === '-X' && args[2] === 'POST' && /\/comments$/.test(args[3])) {
  const h = other((/\/pulls\/(\d+)\//.exec(args[3]) || [])[1]) || s;
  (h.threads ||= []).push({ id: id('PRRT'), path: fields.path, line: Number(fields.line), side: fields.side, comments: [{ id: id('PRRC'), author: s.login, body: fields.body, pending: false, at: at() }] });
  save();
  out({ id: 1, node_id: 'x', html_url: url + '#discussion' });
}
if (args[0] === 'api' && args[1] === '-X' && args[2] === 'PUT' && /\/merge$/.test(args[3])) {
  if (fields.sha !== head()) fail('HTTP 409: Head branch was modified');
  s.state = 'MERGED';
  s.mergedAs = fields.commit_title;
  save();
  out('0123456789abcdef0123456789abcdef01234567');
}
if (args[0] === 'api' && args[1] === 'graphql') {
  const q = fields.query || '';
  if (q.includes('isMergeQueueEnabled')) out({ isMergeQueueEnabled: false, isInMergeQueue: false });
  if (q.includes('addPullRequestReview(')) {
    const h = byPrId(fields.id);
    h.pending = { id: id('PRR'), comments: [] };
    save();
    out({ data: { addPullRequestReview: { pullRequestReview: { id: h.pending.id } } } });
  }
  if (q.includes('addPullRequestReviewThread')) {
    const h = byReviewId(fields.r);
    if (!h.pending || h.pending.id !== fields.r) fail('no such pending review');
    const c = { id: id('PRRC'), path: fields.p, line: Number(fields.l), side: fields.s, body: fields.b };
    h.pending.comments.push(c);
    save();
    out({ data: { addPullRequestReviewThread: { thread: { diffSide: c.side, startLine: null, comments: { nodes: [{ id: c.id, path: c.path, line: c.line, originalLine: c.line, body: c.body }] } } } } });
  }
  if (q.includes('submitPullRequestReview')) {
    const h = byReviewId(fields.id);
    if (!h.pending || h.pending.id !== fields.id) fail('no such pending review');
    const state = { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' }[fields.e];
    for (const c of h.pending.comments) (h.threads ||= []).push({ id: id('PRRT'), path: c.path, line: c.line, side: c.side, comments: [{ id: c.id, author: s.login, body: c.body, pending: false, at: at() }] });
    (h.verdicts ||= []).push({ id: h.pending.id, author: s.login, state, body: fields.b || '', at: at() });
    h.pending = null;
    save();
    out({ data: { submitPullRequestReview: { pullRequestReview: { state } } } });
  }
  if (q.includes('deletePullRequestReview(')) {
    byReviewId(fields.id).pending = null;
    save();
    out({ data: {} });
  }
  if (q.includes('deletePullRequestReviewComment')) {
    const h = byCommentId(fields.id);
    if (h.pending) h.pending.comments = h.pending.comments.filter((c) => c.id !== fields.id);
    if (h.pending && !h.pending.comments.length) h.pending = null;
    save();
    out({ data: {} });
  }
  if (q.includes('reviewThreads') && other(fields.pr)) {
    const o = other(fields.pr);
    const pending = o.pending ? o.pending.comments : [];
    const thread = (t, c, state) => ({ id: t, path: c.path, diffSide: c.side, line: c.line, startLine: null, isResolved: false, isOutdated: false,
      comments: { pageInfo: { hasNextPage: false }, nodes: [{ id: c.id, fullDatabaseId: null, author: { login: c.author || s.login }, body: c.body, state, url: state === 'PENDING' ? null : urlOf(o), createdAt: c.at || at(), viewerCanDelete: true, viewerDidAuthor: true }] } });
    out({ data: { repository: { pullRequest: {
      id: 'PR_dev' + o.number, headRefOid: o.sha, body: o.body, bodyHTML: '', author: { login: s.login }, createdAt: s.createdAt, url: urlOf(o),
      reviews: { nodes: o.pending ? [{ id: o.pending.id, comments: { nodes: pending.map((c) => ({ id: c.id, path: c.path, line: c.line, originalLine: c.line, body: c.body })) } }] : [] },
      comments: { nodes: [] },
      reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [
        ...(o.threads || []).map((t) => thread(t.id, { ...t.comments[0], path: t.path, line: t.line, side: t.side }, 'SUBMITTED')),
        ...pending.map((c) => thread('T' + c.id, c, 'PENDING')),
      ] },
      verdicts: { nodes: (o.verdicts || []).map((v) => ({ id: v.id, author: { login: v.author }, state: v.state, body: v.body, url: urlOf(o), submittedAt: v.at, isMinimized: false, viewerDidAuthor: v.author === s.login })) },
    } } } });
  }
  if (q.includes('reviewThreads')) {
    const pendingThreads = (s.pending ? s.pending.comments : []).map((c) => ({ id: 'T' + c.id, path: c.path, diffSide: c.side, line: c.line, startLine: null, isResolved: false, isOutdated: false,
      comments: { pageInfo: { hasNextPage: false }, nodes: [{ id: c.id, fullDatabaseId: null, author: { login: s.login }, body: c.body, state: 'PENDING', url: null, createdAt: at(), viewerCanDelete: true, viewerDidAuthor: true }] } }));
    const posted = s.threads.map((t) => ({ id: t.id, path: t.path, diffSide: t.side, line: t.line, originalLine: t.line, startLine: null, isResolved: !!t.resolved, isOutdated: false,
      comments: { pageInfo: { hasNextPage: false }, nodes: t.comments.map((c, i) => ({ id: c.id, fullDatabaseId: null, author: { login: c.author }, body: c.body, state: 'SUBMITTED', url: url, createdAt: c.at, viewerCanDelete: c.author === s.login, viewerDidAuthor: c.author === s.login, pullRequestReview: i === 0 && t.review ? { id: t.review } : null })) } }));
    out({ data: { repository: { pullRequest: {
      id: 'PR_dev', headRefOid: head(), baseRefName: s.base, body: s.body, bodyHTML: '', author: { login: s.login }, createdAt: s.createdAt, url,
      labels: { nodes: (s.labels || []).map((name) => ({ name })) },
      commits: { nodes: [{ commit: { oid: head(), checkSuites: { nodes: (s.checkRuns || []).map((r) => ({ app: { slug: r.app, name: r.app }, checkRuns: { nodes: [{
        name: r.name, status: 'COMPLETED', conclusion: r.conclusion, title: r.title, summary: r.summary, detailsUrl: null, permalink: url + '/checks', startedAt: s.createdAt, completedAt: s.createdAt,
      }] } })) } } }] },
      reviews: { nodes: s.pending ? [{ id: s.pending.id, comments: { nodes: s.pending.comments.map((c) => ({ id: c.id, path: c.path, line: c.line, originalLine: c.line, body: c.body })) } }] : [] },
      verdicts: { nodes: s.verdicts.map((v) => ({ id: v.id, author: { __typename: v.bot ? 'Bot' : 'User', login: v.author }, state: v.state, body: v.body, url, submittedAt: v.at, isMinimized: false, viewerDidAuthor: v.author === s.login, commit: { oid: v.commit === 'head' ? head() : v.commit || head() } })) },
      comments: { nodes: s.comments.map((c) => ({ id: c.id, fullDatabaseId: '1', author: { login: c.author }, body: c.body, url, createdAt: c.at, isMinimized: false, viewerCanDelete: false, viewerDidAuthor: false })) },
      reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [...posted, ...pendingThreads] },
    } } } });
  }
}
fail('not a call the dev review gh answers: ' + args.slice(0, 4).join(' '));
`;

/**
 * @param {string} dir  where to write `gh` and its state; put it first on the review host's PATH
 * @param {{repo: string, branch: string, base: string, slug: string, number: number, title: string, login: string,
 *          others?: {number: number, branch: string, sha: string, title: string, body: string, additions: number, deletions: number, changedFiles: number}[]}} pr
 *   `others`: the session's earlier pull requests, each on its own branch
 * @returns {{dir: string, state: string}}
 */
export function writeDevReviewGh(dir, { repo, branch, base, slug, number, title, login, others = [] }) {
  fs.mkdirSync(dir, { recursive: true });
  const state = path.join(dir, 'state.json');
  const now = new Date().toISOString();
  fs.writeFileSync(state, JSON.stringify({
    repo, branch, base, slug, number, title, login, others, state: 'OPEN', createdAt: now,
    body: 'Subscribers that answer 5xx or 429 used to miss the event. This retries them with backoff.\n\n- `retry.mjs` holds the policy\n- `deliver.mjs` loops on it',
    checks: ['SUCCESS', 'SUCCESS', 'SUCCESS'],
    // The review's Merge risk check and its label, and a QA run's check, on the head commit (shared/review/prChecks.mjs).
    labels: ['merge risk: medium'],
    checkRuns: [
      { app: 'woodshed-reviewer', name: 'Merge risk', conclusion: 'NEUTRAL', title: 'Medium: retries change how every webhook is delivered',
        summary: 'Every delivery now goes through the retry loop, so a bug in it reaches every subscriber. The policy is small and tested, and nothing outside \`src/webhooks/\` changes.\n\nSet by the AI review. It does not block merging.' },
      { app: 'woodshed-console', name: 'QA', conclusion: 'SUCCESS', title: '3 of 3 test cases passed',
        summary: 'Passed\n\n| Test case | Result |\n| --- | --- |\n| A 503 is retried, then delivered | passed |\n| A 404 is not retried | passed |\n| Retry-After is honoured | passed |' },
    ],
    // As the reviewer App posts a review by both (console/fleet.mjs submitReview, codeReview.mjs mergeVerdicts).
    verdicts: [{
      id: 'PRR_devai', author: 'woodshed-reviewer', bot: true, state: 'CHANGES_REQUESTED', at: now, commit: 'head',
      body: '## Claude Code and Codex review — REQUEST_CHANGES\n\n### Claude Code: APPROVE\n\nThe retry policy is small and tested: \`shouldRetry\`, \`backoffMs\` and \`retryAfterMs\` each have a case. Every attempt carries the same \`x-event-id\`, so a subscriber can drop repeats.\n\n### Codex: REQUEST_CHANGES\n\nA delivery that fails on a network error is retried, but one cut off by its own timeout is too: \`AbortSignal.timeout\` throws, \`res\` stays null, and \`shouldRetry(undefined)\` is true. That is intended, but nothing caps the total time a delivery can take.',
    }],
    comments: [{ id: 'IC_dev1', author: 'octocat', body: 'Does this need a dead-letter queue before it ships?', at: now }],
    threads: [
      { id: 'PRRT_devai1', review: 'PRR_devai', path: 'src/webhooks/deliver.mjs', line: 14, side: 'RIGHT', comments: [{ id: 'PRRC_devai1', author: 'woodshed-reviewer', body: '**Codex:** Each attempt waits up to \`config.timeoutMs\` and then up to \`config.maxDelayMs\`, for \`maxRetries + 1\` attempts: a slow subscriber holds the worker for minutes. Cap the whole delivery, not only each wait.', at: now }, { id: 'PRRC_devai1r', author: 'octocat', body: 'The worker has its own deadline, I think?', at: now }] },
      { id: 'PRRT_devai2', review: 'PRR_devai', path: 'src/webhooks/retry.mjs', line: 3, side: 'RIGHT', comments: [{ id: 'PRRC_devai2', author: 'woodshed-reviewer', body: '**Claude Code:** 408 is retried. That is right for a proxy timing out, but a subscriber that answers 408 on purpose will be called five times.', at: now }] },
      { id: 'PRRT_dev1', path: 'src/webhooks/retry.mjs', line: 3, side: 'RIGHT', comments: [{ id: 'PRRC_dev1', author: 'octocat', body: 'Should 408 be here? Some proxies send it for a slow upload.', at: now }] },
    ],
    pending: null,
  }, null, 2));
  const gh = path.join(dir, 'gh');
  fs.writeFileSync(gh, `#!${process.execPath}\nprocess.env.DEV_REVIEW_GH_STATE ??= ${JSON.stringify(state)};\n${SCRIPT}`, { mode: 0o755 });
  return { dir, state };
}
