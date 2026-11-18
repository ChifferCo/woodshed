import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const HERE = import.meta.dirname;
const REVIEW_SH = path.join(HERE, 'review.sh');
const REVIEW_MJS = path.join(HERE, '../shared/codeReview/codeReview.mjs');

// A fake claude that reviews only when it is given a prompt naming the repo, as the real one needs a prompt at all.
const FAKE_CLAUDE = `#!/bin/bash
prompt=$4
if [ -z "$prompt" ]; then echo '{"type":"result","subtype":"error_during_execution","is_error":true}'; exit 1; fi
case "$prompt" in *Acme/widgets/blob/*) ;; *) echo '{"type":"result","subtype":"wrong_repo","is_error":true}'; exit 1 ;; esac
dir=$(printf '%s' "$prompt" | grep -o '[^ \`]*/context\\.md' | head -1 | sed 's#/context\\.md$##')
echo APPROVE > "$dir/verdict.txt"
echo 'Looks right.' > "$dir/summary.md"
printf 'LOW\\nOnly a docs page.\\n' > "$dir/merge-risk.md"
echo '[{"path":"README.md","line":1,"body":"Say what it is for."}]' > "$dir/inline-comments.json"
echo '{"type":"result","subtype":"success","is_error":false,"num_turns":3,"total_cost_usd":0.25}'
`;

// A fake codex that asks for changes, so the merged verdict is visibly the stricter one. It reviews only when run on
// the team key, through the console, as session/bin/codex does with WOODSHED_CODEX_AUTH=key, or on the author's own
// sign-in in its home, which it refreshes, as codex does with a ChatGPT login.
const FAKE_CODEX = `#!/bin/bash
[ "$1" = exec ] && [ "$2" = --skip-git-repo-check ] || exit 2
case "$WOODSHED_CODEX_AUTH" in
  key) ;;
  own) h=\${CODEX_HOME:-$HOME/.codex}; [ -s "$h/auth.json" ] || exit 5
       echo '{"tokens":{"refresh_token":"rt-2"},"last_refresh":"2026-11-18T11:00:00Z"}' > "$h/auth.json" ;;
  *) exit 2 ;;
esac
prompt=$6
case "$prompt" in "You are Codex"*) ;; *) exit 3 ;; esac
dir=$(printf '%s' "$prompt" | grep -o '[^ \`]*/context\\.md' | head -1 | sed 's#/context\\.md$##')
[ -s "$dir/context.md" ] || exit 4
echo REQUEST_CHANGES > "$dir/verdict.txt"
echo 'The link is wrong.' > "$dir/summary.md"
printf 'MEDIUM\\nA link people follow.\\n' > "$dir/merge-risk.md"
echo '[{"path":"README.md","line":1,"body":"This link 404s."}]' > "$dir/inline-comments.json"
echo '{"type":"turn.completed"}'
`;

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function runReview(t, { origin = 'https://github.com/Acme/widgets.git', agents = null, codex = FAKE_CODEX, ownLogin = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-sh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessionDir = path.join(dir, 'session');
  const bin = path.join(dir, 'fakebin');
  const codexHome = path.join(dir, 'codex-home');
  const given = path.join(dir, 'codex-given');
  fs.mkdirSync(codexHome);
  if (ownLogin) {
    fs.writeFileSync(path.join(codexHome, 'auth.json'), ownLogin);
    fs.writeFileSync(given, ownLogin);
  }
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(sessionDir, 'bin'), { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(sessionDir, 'bin', 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  fs.writeFileSync(path.join(sessionDir, 'bin', 'codex'), codex, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/bash\necho "# Pull request: Add GTM"\n', { mode: 0o755 });
  execFileSync('bash', ['-c', `git init -q -b main "${repo}" && cd "${repo}" && echo hi > README.md && git add -A &&
    git -c user.email=t@t -c user.name=t commit -qm base ${origin ? `&& git remote add origin "${origin}"` : ''}`]);
  const reports = [];
  const consoleServer = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      reports.push({ path: req.url, body: JSON.parse(body), auth: req.headers.authorization });
      res.writeHead(204).end();
    });
  });
  t.after(() => consoleServer.close());
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, SESSION_DIR: sessionDir, REPO_DIR: repo, PR: '7', REVIEW_BASE: 'main',
    SESSION_TOKEN: 'tok', WOODSHED_CONSOLE_URL: `http://127.0.0.1:${consoleServer.address().port}`, REVIEW_SCRIPT: REVIEW_MJS,
    REVIEW_RUNNING: path.join(dir, 'running'), REVIEW_AUTHOR: 'rev[bot]', GIT_ALLOW_PROTOCOL: 'file',
  };
  delete env.GITHUB_REPOSITORY;
  delete env.WOODSHED_CODEX_AUTH;
  env.CODEX_HOME = codexHome;
  env.REVIEW_CODEX_GIVEN = given;
  if (agents) env.REVIEW_AGENTS = agents;
  let output = '';
  await new Promise((resolve) => {
    const child = spawn('bash', [REVIEW_SH], { env });
    child.stdout.on('data', (c) => { output += c; });
    child.stderr.on('data', (c) => { output += c; });
    child.on('close', resolve);
  });
  return { reports, output };
}

test('a review in a session, where GitHub Actions\' variables are not set, finds its repo from the checkout and reports the verdict', async (t) => {
  const { reports, output } = await runReview(t);
  assert.match(output, /Reviewing the diff of Acme\/widgets/);
  assert.match(output, /Claude ended \(subtype=success is_error=false turns=3\)/);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].path, '/review-report');
  assert.equal(reports[0].body.conclusion, 'APPROVE');
  assert.deepEqual(reports[0].body.inlineComments, [{ path: 'README.md', line: 1, body: 'Say what it is for.' }]);
});

test('a review that cannot name its repo says so and reports no verdict, rather than starting claude with no prompt', async (t) => {
  const { reports, output } = await runReview(t, { origin: null });
  assert.match(output, /Could not write the review prompt/);
  assert.equal(reports[0].body.conclusion, null);
});

test('with Codex beside Claude Code, both review the same diff and the stricter verdict is reported', async (t) => {
  const { reports, output } = await runReview(t, { agents: 'claude codex' });
  assert.match(output, /Reviewing the diff of Acme\/widgets with Claude Code and Codex/);
  assert.match(output, /Codex ended \(exit=0\)/);
  assert.equal(reports.length, 1);
  const { body } = reports[0];
  assert.equal(body.conclusion, 'REQUEST_CHANGES');
  assert.equal(body.mergeRisk.tier, 'Medium');
  assert.equal(body.costUsd, 0.25, 'Claude\'s cost, which codex does not report');
  assert.deepEqual(body.inlineComments.map((c) => c.body), ['**Claude Code:** Say what it is for.', '**Codex:** This link 404s.']);
});

test('a Codex that fails leaves Claude Code\'s review, which says Codex wrote none', async (t) => {
  const { reports, output } = await runReview(t, { agents: 'claude codex', codex: '#!/bin/bash\necho "the console has no OpenAI key" >&2\nexit 1\n' });
  assert.match(output, /Codex ended \(exit=1\)/);
  assert.equal(reports[0].body.conclusion, 'APPROVE');
  assert.match(reports[0].body.summary, /Codex wrote no verdict/);
});

test('with Claude Code alone, codex is never run', async (t) => {
  const { reports, output } = await runReview(t, { codex: '#!/bin/bash\ntouch "$REPO_DIR/codex-ran"\nexit 1\n' });
  assert.doesNotMatch(output, /Codex/);
  assert.equal(reports[0].body.conclusion, 'APPROVE');
  assert.deepEqual(reports[0].body.inlineComments, [{ path: 'README.md', line: 1, body: 'Say what it is for.' }]);
});

test('a review on the author\'s own Codex sign-in runs codex on it, and sends the login codex refreshed back', async (t) => {
  const login = '{"tokens":{"refresh_token":"rt-1"},"last_refresh":"2026-11-18T10:00:00Z"}';
  const { reports, output } = await runReview(t, { agents: 'claude codex', ownLogin: login });
  assert.match(output, /Codex reviews on the author's own Codex sign-in/);
  assert.match(output, /Codex ended \(exit=0\)/);
  assert.match(output, /refreshed Codex sign-in sent back \(status: 204\)/);
  const back = reports.find((r) => r.path === '/codex-auth');
  assert.equal(back.body.tokens.refresh_token, 'rt-2', 'the refreshed login, not the one given');
  assert.equal(back.auth, 'Bearer tok', 'as the session');
  assert.equal(reports.find((r) => r.path === '/review-report').body.conclusion, 'REQUEST_CHANGES');
});

test('with no sign-in of the author\'s, codex runs on the team key and nothing is sent back', async (t) => {
  const { reports, output } = await runReview(t, { agents: 'claude codex' });
  assert.match(output, /Codex reviews on the team's OpenAI key/);
  assert.deepEqual(reports.map((r) => r.path), ['/review-report']);
});
