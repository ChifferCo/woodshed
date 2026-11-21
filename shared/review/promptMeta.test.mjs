// node --test shared/review/promptMeta.test.mjs
//
// What a worktree review's prompts call the change. Its record holds a title and body the shed made up ("Work in
// progress on <branch>", "This worktree is 5 commits ahead of main."), and the Q&A's first question kept asking what a
// pull request titled "Work in progress" was for. Once the branch has a pull request, the prompts get its own title and
// description. `gh` and `claude` are stand-ins first on the PATH; the stand-in claude writes each prompt to a file.

import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'review-prompt-meta-'));
const BIN = path.join(DIR, 'bin');
const PROMPTS = path.join(DIR, 'prompts');
fs.mkdirSync(BIN);
fs.mkdirSync(PROMPTS);
fs.writeFileSync(path.join(BIN, 'claude'), `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf('-p') + 1];
fs.writeFileSync(${JSON.stringify(PROMPTS)} + '/' + Date.now() + '-' + process.pid + '.txt', prompt);
const ids = [...prompt.matchAll(/^--- id: (\\S+)$/gm)].map((m) => m[1]);
const out = !argv.includes('--system-prompt')
  ? { answers: ids.map((id) => ({ id, answer: 'Answer.' })) }
  : ids.length ? { questions: [] } : { questions: ['What is this?'] };
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, num_turns: 1, total_cost_usd: 0.001, structured_output: out }));
`, { mode: 0o755 });
// gh: the branch's pull request for prStatus's \`pr list\`, and its description for \`pr view\`.
fs.writeFileSync(path.join(BIN, 'gh'), `#!/usr/bin/env node
const argv = process.argv.slice(2);
const head = argv[argv.indexOf('--head') + 1];
if (argv[0] === 'pr' && argv[1] === 'list') {
  process.stdout.write(JSON.stringify(head === 'with-pr' ? [{
    number: 114, title: 'fix(console): keep QA recordings', headRefName: 'with-pr', state: 'OPEN', isDraft: false,
    url: 'https://github.com/acme/app/pull/114', statusCheckRollup: [],
  }] : []));
} else if (argv[0] === 'pr' && argv[1] === 'view' && argv[2] === '114') {
  process.stdout.write(JSON.stringify({
    number: 114, title: 'fix(console): keep QA recordings', body: 'Recordings were lost on a restart.',
    headRefOid: 'abcdef1234567', headRefName: 'with-pr', baseRefName: 'main', state: 'OPEN', url: 'https://github.com/acme/app/pull/114',
  }));
} else { process.stderr.write('unexpected gh ' + argv.join(' ')); process.exit(1); }
`, { mode: 0o755 });
process.env.PATH = `${BIN}:${process.env.PATH}`;
process.env.WOODSHED_REVIEWS = path.join(DIR, 'reviews');

const REPO = path.join(DIR, 'repo');
const git = (...args) => execFileSync('git', ['-C', REPO, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
fs.mkdirSync(REPO);
git('init', '-q');
git('remote', 'add', 'origin', 'https://github.com/acme/app.git');
fs.writeFileSync(path.join(REPO, 'a.mjs'), '// a\n');
git('add', '-A');
git('commit', '-q', '-m', 'snapshot');
const SNAPSHOT = git('rev-parse', 'HEAD');

const { handleReviewRequest } = await import('./index.mjs');
const { writeSessionReview, writeDiff, readQa } = await import('./store.mjs');
const { configurePrStatus, schedulePrRefresh } = await import('../prStatus.mjs');
configurePrStatus({ repoRoot: REPO });

function makeReview(session, branch) {
  writeSessionReview({
    session,
    review: {
      kind: 'worktree', branch, worktree: REPO, headSha: SNAPSHOT, snapshot: SNAPSHOT, createdAt: new Date().toISOString(),
      meta: {
        number: null, title: `Work in progress on ${branch}`, body: 'This worktree is 5 commits ahead of main.',
        headRefName: branch, baseRefName: 'main', state: 'WORKTREE',
      },
    },
  });
  writeDiff({ session, diff: { files: [{ path: 'a.mjs', additions: 1, deletions: 0, status: 'modified', hunks: [] }] } });
}

async function call(method, url) {
  const res = { status: 0, body: null };
  const ctx = { reqId: 'test', repoRoot: REPO, log: () => {}, json: (_res, status, body) => { res.status = status; res.body = body; } };
  await handleReviewRequest({ method, url, headers: {} }, {}, ctx);
  return res;
}

async function firstQuestionPrompt(session) {
  for (const f of fs.readdirSync(PROMPTS)) fs.rmSync(path.join(PROMPTS, f));
  assert.equal((await call('POST', `/reviews/${session}/qa`)).status, 200);
  const end = Date.now() + 20_000;
  while (readQa(session)?.status !== 'ready') {
    if (Date.now() > end) throw new Error(`Q&A did not finish: ${JSON.stringify(readQa(session))}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const prompts = fs.readdirSync(PROMPTS).sort().map((f) => fs.readFileSync(path.join(PROMPTS, f), 'utf8'));
  return prompts.find((p) => p.startsWith('Here is the pull request'));
}

test('a worktree review whose branch has a pull request asks about its title and description', async () => {
  await schedulePrRefresh(['with-pr']);
  makeReview('claude-11112222', 'with-pr');
  const prompt = await firstQuestionPrompt('claude-11112222');
  assert.match(prompt, /^title: fix\(console\): keep QA recordings$/m);
  assert.match(prompt, /Recordings were lost on a restart\./);
  assert.doesNotMatch(prompt, /Work in progress|commits ahead of/);
});

test('a worktree review with no pull request keeps its own header', async () => {
  await schedulePrRefresh(['no-pr']);
  makeReview('claude-33334444', 'no-pr');
  const prompt = await firstQuestionPrompt('claude-33334444');
  assert.match(prompt, /^title: Work in progress on no-pr$/m);
});
