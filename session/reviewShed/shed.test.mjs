import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// The host over the shed's real review code and a real git checkout. No claude and no gh on the path: nothing here
// may need either to open the page, which is the property this pins. The Codex case stubs its CLI on PATH.
process.env.WOODSHED_REVIEWS = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-state-'));
process.env.PATH = '/usr/bin:/bin';
// A Woodshed session exports these; the fixtures' repos are on master.
delete process.env.DEFAULT_BRANCH;
delete process.env.REVIEW_ONLY;
const { createReviewHost } = await import('./host.mjs');

function checkout(t, { dirty }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-checkout-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-C', cwd, ...a], { stdio: 'pipe' });
  const remote = path.join(dir, 'remote.git');
  const repo = path.join(dir, 'repo');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', remote]);
  execFileSync('git', ['init', '-q', '-b', 'master', repo]);
  fs.writeFileSync(path.join(repo, 'a.mjs'), 'export const a = 1;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'start');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', 'origin', 'master');
  git(repo, 'remote', 'set-head', 'origin', 'master');
  git(repo, 'checkout', '-q', '-b', 'work');
  if (dirty) fs.writeFileSync(path.join(repo, 'a.mjs'), 'export const a = 2;\nexport const b = 3;\n');
  return repo;
}

async function serve(t, repoDir, sessionId, options = {}) {
  const host = createReviewHost({ repoDir, sessionId, sessionKind: 'shared', ...options });
  const server = http.createServer((req, res) => host.handle(req, res).then((done) => { if (!done) { res.writeHead(404); res.end(); } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/shed-review`;
  // The JSON of a call, or the response itself for the page.
  return (p, options) => fetch(base + p, options).then((r) => (r.headers.get('content-type')?.startsWith('application/json') ? r.json() : r));
}

test('opening the review of a checkout with changes makes the review, with its diff, and starts the analysis', async (t) => {
  const get = await serve(t, checkout(t, { dirty: true }), 'aaaaaaa1');
  const status = await get('/reviews/claude-aaaaaaa1');
  assert.equal(status.ok, true);
  assert.equal(status.kind, 'worktree');
  assert.notEqual(status.status, 'unknown', 'the analysis was started on opening');
  // The Q&A too, about this diff, without the Q&A tab asking: with no claude here it cannot run, but it was started.
  const qa = await get('/reviews/claude-aaaaaaa1/qa');
  assert.equal(qa.qa?.forDiff, status.createdAt, 'the Q&A was started on opening');
  assert.equal((await get('/reviews/claude-aaaaaaa1')).ok, true);
  const tab = await get(`/reviews/claude-aaaaaaa1/qa?forDiff=${encodeURIComponent(status.createdAt)}&first=1`, { method: 'POST' });
  assert.equal(tab.ok, true, 'the tab\'s first ask joins or keeps it');
  assert.equal((await get('/reviews/claude-aaaaaaa1/qa')).qa.startedAt, qa.qa.startedAt, 'opened again and the tab asking: the same run');
  assert.equal(status.livePr, null);
  const diff = await get('/reviews/claude-aaaaaaa1/diff');
  assert.deepEqual(diff.files.map((f) => f.path), ['a.mjs']);
  assert.equal(diff.files[0].language, 'c');
});

test('a checkout with nothing to review says so instead of opening an empty page', async (t) => {
  const get = await serve(t, checkout(t, { dirty: false }), 'bbbbbbb2');
  const status = await get('/reviews/claude-bbbbbbb2');
  assert.equal(status.ok, false);
  assert.match(status.error, /nothing to review/);
});

test('the page served is the shed\'s own, byte for byte', async (t) => {
  const { REVIEW_HTML } = await import('../../shared/review/page.mjs');
  const get = await serve(t, checkout(t, { dirty: true }), 'ccccccc3');
  const res = await get('/review?session=claude-ccccccc3');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), REVIEW_HTML);
});

test('Codex analysis passes a schema to the CLI and persists the streamed artifact', { timeout: 10_000 }, async (t) => {
  const repo = checkout(t, { dirty: true });
  const bin = path.join(repo, '..', 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}
const assert = require('node:assert/strict');
const fs = require('node:fs');
const schemaIndex = process.argv.indexOf('--output-schema');
assert.ok(schemaIndex > 0, 'Codex analysis requires --output-schema');
const schema = JSON.parse(fs.readFileSync(process.argv[schemaIndex + 1], 'utf8'));
assert.deepEqual(schema.required.sort(), ['architecture', 'decisions', 'diagram', 'groups', 'overview']);
assert.equal(schema.properties.groups.items.properties.files.items.properties.path.type, 'string');
assert.ok(schema.properties.diagram.anyOf.some((option) => option.type === 'null'));
assert.match(fs.readFileSync(0, 'utf8'), /a[.]mjs/);

const artifact = {
  overview: 'Codex explained the export changes.',
  architecture: 'A single module declares the exports.',
  decisions: [],
  diagram: null,
  groups: [{
    title: 'Exports', why: 'The module declares its public constants.',
    files: [{ path: 'a.mjs', preamble: 'Adds a new constant.', role: 'core' }],
  }],
};
for (const event of [
  { type: 'turn.started' },
  { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(artifact) } },
  { type: 'turn.completed' },
]) console.log(JSON.stringify(event));
`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });

  const session = 'claude-ddddddd4';
  const get = await serve(t, repo, 'ddddddd4', { agent: 'codex' });
  let status = await get(`/reviews/${session}`);
  assert.equal(status.ok, true);
  for (let attempt = 0; attempt < 100 && status.status === 'running'; attempt += 1) {
    await delay(50);
    status = await get(`/reviews/${session}`);
  }

  assert.equal(status.status, 'ready', status.error);
  const { readArtifact } = await import('../../shared/review/store.mjs');
  const saved = readArtifact(session);
  assert.deepEqual(saved, status.review);
  assert.equal(saved.overview, 'Codex explained the export changes.');
  assert.equal(saved.groups[0].files[0].path, 'a.mjs');
});

test('Codex chat gets the named file before the excerpt cutoff and is told to identify missing context', { timeout: 10_000 }, async (t) => {
  const repo = checkout(t, { dirty: true });
  fs.writeFileSync(path.join(repo, 'a-large.txt'), ('x'.repeat(2_000) + '\n').repeat(80));
  fs.writeFileSync(path.join(repo, 'z-feature.mjs'), 'export const contextCanary = true;\n');
  execFileSync('git', ['-C', repo, 'add', 'a-large.txt', 'z-feature.mjs']);
  const bin = path.join(repo, '..', 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}
const fs = require('node:fs');
const prompt = fs.readFileSync(0, 'utf8');
if (process.argv.includes('--output-schema')) process.exit(1);
const problems = [];
if (/current working directory/.test(prompt)) problems.push('prompt promises checkout access');
if (!prompt.includes('explain what context is missing')) problems.push('missing context guidance absent');
if (!prompt.includes('export const contextCanary = true')) problems.push('named hunk was omitted');
if (!prompt.includes('Remaining diff omitted')) problems.push('expected a truncated excerpt');
if (problems.length) {
  console.error(problems.join(', '));
  process.exit(1);
}
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'The named change was included.' } }));
console.log(JSON.stringify({ type: 'turn.completed' }));
`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });

  const base = '/reviews/claude-eeeeeee5';
  const get = await serve(t, repo, 'eeeeeee5', { agent: 'codex' });
  await get(base);
  const chat = await get(`${base}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'What changed in z-feature.mjs?' }),
  });
  assert.equal(chat.ok, true, chat.error);
  let status = await get(`${base}/explain/${chat.askId}`);
  for (let attempt = 0; attempt < 100 && status.status === 'running'; attempt += 1) {
    await delay(50);
    status = await get(`${base}/explain/${chat.askId}`);
  }
  assert.equal(status.status, 'ready', status.error);
  assert.equal(status.answer.text, 'The named change was included.');
});

// A session that opened #7 on `first`, then #8 on `second`, stacked on it, and has `second` checked out. GitHub is a
// stand-in gh, and the repo's origin is named as GitHub's by a stand-in git, over a bare remote with the pull requests'
// refs as GitHub publishes them.
function twoPullRequests(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-pulls-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-C', cwd, ...a], { stdio: 'pipe' }).toString().trim();
  const remote = path.join(dir, 'remote.git');
  const repo = path.join(dir, 'repo');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', remote]);
  execFileSync('git', ['init', '-q', '-b', 'master', repo]);
  fs.writeFileSync(path.join(repo, 'a.mjs'), 'export const a = 1;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'start');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', 'origin', 'master');
  git(repo, 'remote', 'set-head', 'origin', 'master');
  git(repo, 'checkout', '-q', '-b', 'first');
  fs.writeFileSync(path.join(repo, 'first.mjs'), 'export const first = 1;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
  git(repo, 'push', '-q', 'origin', 'first', 'first:refs/pull/7/head');
  const firstSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', '-b', 'second');
  fs.writeFileSync(path.join(repo, 'second.mjs'), 'export const second = 2;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'second');
  git(repo, 'push', '-q', 'origin', 'second', 'second:refs/pull/8/head');

  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
if [ "$3" = remote ] && [ "$4" = get-url ]; then echo https://github.com/acme/app.git; exit 0; fi
exec ${execFileSync('sh', ['-c', 'command -v git']).toString().trim()} "$@"
`, { mode: 0o755 });
  const pr7 = {
    number: 7, title: 'First', body: '', author: { login: 'mia' }, headRefName: 'first', headRefOid: firstSha, baseRefName: 'master',
    isCrossRepository: false, state: 'OPEN', url: 'https://github.com/acme/app/pull/7', isDraft: false, additions: 1, deletions: 0, changedFiles: 1, files: [],
  };
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'view' && args[2] === '7') { console.log(${JSON.stringify(JSON.stringify(pr7))}); process.exit(0); }
if (args[0] === 'pr' && args[1] === 'view' && args[2] === '--json') {
  // The branch checked out's pull request: #8 on second, stacked on first; #7 on first.
  const branch = require('node:child_process').execFileSync('git', ['branch', '--show-current']).toString().trim();
  console.log(JSON.stringify(branch === 'first' ? { number: 7, state: 'OPEN', baseRefName: 'master' } : { number: 8, state: 'OPEN', baseRefName: 'first' }));
  process.exit(0);
}
process.exit(1);
`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  return { repo, git, firstSha, worktrees: path.join(dir, 'worktrees') };
}

test('a session with two pull requests has a review of each, and the checkout\'s is against its pull request\'s base', { timeout: 20_000 }, async (t) => {
  const { repo, git, firstSha, worktrees } = twoPullRequests(t);
  const get = await serve(t, repo, 'fffffff6', { sessionKind: 'private', pullWorktreesDir: worktrees });
  const pulls = { headers: { 'x-woodshed-pulls': '7,8' } };

  // The checkout is `second`, whose #8 is stacked on `first`: only what #8 changes.
  const checkout = await get('/reviews/claude-fffffff6', pulls);
  assert.equal(checkout.ok, true, checkout.error);
  assert.equal(checkout.kind, 'worktree');
  assert.equal(checkout.baseRef, 'first');
  assert.deepEqual((await get('/reviews/claude-fffffff6/diff', pulls)).files.map((f) => f.path), ['second.mjs']);
  assert.deepEqual(checkout.reviews, [
    { review: 'claude-fffffff6', number: 8, checkout: true },
    { review: 'claude-fffffff6-pr7', number: 7, checkout: false },
  ]);

  // #7 is reviewed as GitHub has it, beside the checkout, which is left as it was.
  const first = await get('/reviews/claude-fffffff6-pr7', pulls);
  assert.equal(first.ok, true, first.error);
  assert.equal(first.kind, 'pr');
  assert.equal(first.pr, 7);
  assert.equal(first.headSha, firstSha);
  assert.equal(first.reviewBranch, null);
  assert.deepEqual(first.reviews, checkout.reviews);
  assert.deepEqual((await get('/reviews/claude-fffffff6-pr7/diff', pulls)).files.map((f) => f.path), ['first.mjs']);
  assert.equal(git(repo, 'branch', '--show-current'), 'second');
  assert.equal(git(repo, 'rev-parse', 'first'), firstSha);
  assert.equal(git(path.join(worktrees, 'claude-fffffff6-pr7'), 'rev-parse', 'HEAD'), firstSha);
  assert.equal(git(path.join(worktrees, 'claude-fffffff6-pr7'), 'branch', '--show-current'), '', 'detached: no branch taken');
  assert.equal(git(repo, 'status', '--porcelain'), '');
  // Its own state, beside the checkout's.
  assert.equal((await get('/reviews/claude-fffffff6', pulls)).kind, 'worktree');

  // #8 is the checkout: its review is the checkout's, and nothing is made for it.
  const eight = await get('/reviews/claude-fffffff6-pr8', pulls);
  assert.deepEqual([eight.ok, eight.status, eight.review], [false, 'checkout', 'claude-fffffff6']);
  assert.equal(fs.existsSync(path.join(worktrees, 'claude-fffffff6-pr8')), false);
  // A pull request the console did not name is not the session's.
  const nine = await get('/reviews/claude-fffffff6-pr9', pulls);
  assert.match(nine.error, /#9 is not one of this session's pull requests/);
  assert.match((await get('/reviews/claude-fffffff6-pr7', {})).error, /#7 is not one of this session's pull requests/, 'nor with no list from the console');
});

test('a pull request checked out after the checkout\'s review was taken is not sent to that review', { timeout: 20_000 }, async (t) => {
  const { repo, git, firstSha, worktrees } = twoPullRequests(t);
  const get = await serve(t, repo, 'fffffff7', { sessionKind: 'private', pullWorktreesDir: worktrees });
  const pulls = { headers: { 'x-woodshed-pulls': '7,8' } };
  // Taken on `second` (#8), then `first` (#7) is checked out.
  assert.equal((await get('/reviews/claude-fffffff7', pulls)).branch, 'second');
  git(repo, 'checkout', '-q', 'first');
  const seven = await get('/reviews/claude-fffffff7-pr7', pulls);
  assert.equal(seven.ok, true, seven.error);
  assert.equal(seven.kind, 'pr', 'its own review, not the checkout\'s of #8');
  assert.equal(seven.pr, 7);
  assert.equal(seven.headSha, firstSha);
  assert.equal(git(repo, 'branch', '--show-current'), 'first', 'the checkout is left on its branch');
});
