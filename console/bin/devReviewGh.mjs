// A `gh` for the dev console's review session (devReviewSession.mjs) with DEV_CONSOLE_REVIEW_PR=1: one made-up open
// pull request on the session's branch, kept in a JSON file beside it, answering each call the shed's review makes
// (shared/review/github.mjs, merge.mjs, shared/prStatus.mjs) as GitHub would for it: the pull request's status, the
// draft review and its comments, a verdict, a rename and a squash-merge. Nothing reaches GitHub: any other call fails
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
const decision = () => (s.verdicts.some((v) => v.state === 'CHANGES_REQUESTED') ? 'CHANGES_REQUESTED' : s.verdicts.some((v) => v.state === 'APPROVED') ? 'APPROVED' : 'REVIEW_REQUIRED');
const url = 'https://github.com/' + s.slug + '/pull/' + s.number;

if (args[0] === 'api' && args[1] === 'user') out(s.login);
if (args[0] === 'pr' && args[1] === 'list') {
  const branch = args[args.indexOf('--head') + 1];
  if (branch !== s.branch) out([]);
  out([{ number: s.number, title: s.title, headRefName: s.branch, state: s.state, isDraft: false, reviewDecision: decision(), url, statusCheckRollup: rollup() }]);
}
if (args[0] === 'pr' && args[1] === 'view') {
  out({ id: 'PR_dev', number: s.number, title: s.title, state: s.state, isDraft: false, reviewDecision: decision(), headRefOid: head(),
    baseRefName: s.base, mergeStateStatus: 'CLEAN', statusCheckRollup: rollup() });
}
if (args[0] === 'pr' && args[1] === 'review') {
  const state = args.includes('--approve') ? 'APPROVED' : args.includes('--request-changes') ? 'CHANGES_REQUESTED' : 'COMMENTED';
  const bodyFile = args[args.indexOf('--body-file') + 1];
  const body = args.includes('--body-file') ? fs.readFileSync(bodyFile, 'utf8') : '';
  s.verdicts.push({ id: id('PRR'), author: s.login, state, body, at: at() });
  save();
  out('');
}
if (args[0] === 'api' && args[1] === '-X' && args[2] === 'PATCH') {
  s.title = fields.title;
  save();
  out(s.title);
}
if (args[0] === 'api' && args[1] === '-X' && args[2] === 'POST' && /\/comments$/.test(args[3])) {
  s.threads.push({ id: id('PRRT'), path: fields.path, line: Number(fields.line), side: fields.side, comments: [{ id: id('PRRC'), author: s.login, body: fields.body, pending: false, at: at() }] });
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
    s.pending = { id: id('PRR'), comments: [] };
    save();
    out({ data: { addPullRequestReview: { pullRequestReview: { id: s.pending.id } } } });
  }
  if (q.includes('addPullRequestReviewThread')) {
    if (!s.pending || s.pending.id !== fields.r) fail('no such pending review');
    const c = { id: id('PRRC'), path: fields.p, line: Number(fields.l), side: fields.s, body: fields.b };
    s.pending.comments.push(c);
    save();
    out({ data: { addPullRequestReviewThread: { thread: { diffSide: c.side, startLine: null, comments: { nodes: [{ id: c.id, path: c.path, line: c.line, originalLine: c.line, body: c.body }] } } } } });
  }
  if (q.includes('submitPullRequestReview')) {
    if (!s.pending || s.pending.id !== fields.id) fail('no such pending review');
    const state = { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' }[fields.e];
    for (const c of s.pending.comments) s.threads.push({ id: id('PRRT'), path: c.path, line: c.line, side: c.side, comments: [{ id: c.id, author: s.login, body: c.body, pending: false, at: at() }] });
    s.verdicts.push({ id: s.pending.id, author: s.login, state, body: fields.b || '', at: at() });
    s.pending = null;
    save();
    out({ data: { submitPullRequestReview: { pullRequestReview: { state } } } });
  }
  if (q.includes('deletePullRequestReview(')) {
    s.pending = null;
    save();
    out({ data: {} });
  }
  if (q.includes('deletePullRequestReviewComment')) {
    if (s.pending) s.pending.comments = s.pending.comments.filter((c) => c.id !== fields.id);
    if (s.pending && !s.pending.comments.length) s.pending = null;
    save();
    out({ data: {} });
  }
  if (q.includes('reviewThreads')) {
    const pendingThreads = (s.pending ? s.pending.comments : []).map((c) => ({ id: 'T' + c.id, path: c.path, diffSide: c.side, line: c.line, startLine: null, isResolved: false, isOutdated: false,
      comments: { pageInfo: { hasNextPage: false }, nodes: [{ id: c.id, fullDatabaseId: null, author: { login: s.login }, body: c.body, state: 'PENDING', url: null, createdAt: at(), viewerCanDelete: true, viewerDidAuthor: true }] } }));
    const posted = s.threads.map((t) => ({ id: t.id, path: t.path, diffSide: t.side, line: t.line, startLine: null, isResolved: false, isOutdated: false,
      comments: { pageInfo: { hasNextPage: false }, nodes: t.comments.map((c) => ({ id: c.id, fullDatabaseId: null, author: { login: c.author }, body: c.body, state: 'SUBMITTED', url: url, createdAt: c.at, viewerCanDelete: c.author === s.login, viewerDidAuthor: c.author === s.login })) } }));
    out({ data: { repository: { pullRequest: {
      id: 'PR_dev', headRefOid: head(), body: s.body, bodyHTML: '', author: { login: s.login }, createdAt: s.createdAt, url,
      reviews: { nodes: s.pending ? [{ id: s.pending.id, comments: { nodes: s.pending.comments.map((c) => ({ id: c.id, path: c.path, line: c.line, originalLine: c.line, body: c.body })) } }] : [] },
      verdicts: { nodes: s.verdicts.map((v) => ({ id: v.id, author: { login: v.author }, state: v.state, body: v.body, url, submittedAt: v.at, isMinimized: false, viewerDidAuthor: v.author === s.login })) },
      comments: { nodes: s.comments.map((c) => ({ id: c.id, fullDatabaseId: '1', author: { login: c.author }, body: c.body, url, createdAt: c.at, isMinimized: false, viewerCanDelete: false, viewerDidAuthor: false })) },
      reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [...posted, ...pendingThreads] },
    } } } });
  }
}
fail('not a call the dev review gh answers: ' + args.slice(0, 4).join(' '));
`;

/**
 * @param {string} dir  where to write `gh` and its state; put it first on the review host's PATH
 * @param {{repo: string, branch: string, base: string, slug: string, number: number, title: string, login: string}} pr
 * @returns {{dir: string, state: string}}
 */
export function writeDevReviewGh(dir, { repo, branch, base, slug, number, title, login }) {
  fs.mkdirSync(dir, { recursive: true });
  const state = path.join(dir, 'state.json');
  const now = new Date().toISOString();
  fs.writeFileSync(state, JSON.stringify({
    repo, branch, base, slug, number, title, login, state: 'OPEN', createdAt: now,
    body: 'Subscribers that answer 5xx or 429 used to miss the event. This retries them with backoff.\n\n- `retry.mjs` holds the policy\n- `deliver.mjs` loops on it',
    checks: ['SUCCESS', 'SUCCESS', 'SUCCESS'],
    verdicts: [],
    comments: [{ id: 'IC_dev1', author: 'octocat', body: 'Does this need a dead-letter queue before it ships?', at: now }],
    threads: [{ id: 'PRRT_dev1', path: 'src/webhooks/retry.mjs', line: 3, side: 'RIGHT', comments: [{ id: 'PRRC_dev1', author: 'octocat', body: 'Should 408 be here? Some proxies send it for a slow upload.', at: now }] }],
    pending: null,
  }, null, 2));
  const gh = path.join(dir, 'gh');
  fs.writeFileSync(gh, `#!${process.execPath}\nprocess.env.DEV_REVIEW_GH_STATE ??= ${JSON.stringify(state)};\n${SCRIPT}`, { mode: 0o755 });
  return { dir, state };
}
