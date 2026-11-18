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
[ -n "$CLAUDE_ARGS_COPY" ] && printf '%s\\n' "$@" > "$CLAUDE_ARGS_COPY"
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
// sign-in in its home, which it refreshes, as codex does with a ChatGPT login; and only with no tools, its prompt on
// stdin and its answer asked for as JSON, written where -o says, as codex does.
const FAKE_CODEX = `#!/bin/bash
[ "$1" = exec ] || exit 2
args=" $* "
for need in "--sandbox read-only" "--disable shell_tool" "--disable unified_exec" "--disable apps" "--disable hooks" 'web_search="disabled"'; do
  [[ "$args" == *" $need "* ]] || { echo "codex was given a tool: no $need" >&2; exit 6; }
done
while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift ;; --output-schema) schema=$2; shift ;; esac; shift; done
[ -s "$schema" ] && [ -n "$out" ] || exit 7
case "$WOODSHED_CODEX_AUTH" in
  key) ;;
  own) h=\${CODEX_HOME:-$HOME/.codex}; [ -s "$h/auth.json" ] || exit 5
       echo '{"tokens":{"refresh_token":"rt-2"},"last_refresh":"2026-11-18T11:00:00Z"}' > "$h/auth.json" ;;
  *) exit 2 ;;
esac
prompt=$(cat)
case "$prompt" in "You are Codex"*) ;; *) exit 3 ;; esac
[ -n "$CODEX_PROMPT_COPY" ] && printf '%s' "$prompt" > "$CODEX_PROMPT_COPY"
[[ "$prompt" == *"/context.md ====="* ]] || exit 4
echo '{"verdict":"REQUEST_CHANGES","summary":"The link is wrong.","mergeRisk":"MEDIUM\\nA link people follow.","comment":"> [!WARNING]","inlineComments":[{"path":"README.md","line":1,"body":"This link 404s."}],"resolved":[]}' > "$out"
echo '{"type":"turn.completed"}'
`;

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function runReview(t, { origin = 'https://github.com/Acme/widgets.git', agents = null, codex = FAKE_CODEX, ownLogin = null, promptCopy = null, codexMinutes = null, claudeArgs = null } = {}) {
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
  // A branch that changes docs/guide.md and adds a link out of the checkout, against origin/main.
  execFileSync('bash', ['-c', `git init -q -b main "${repo}" && cd "${repo}" && echo hi > README.md && mkdir docs &&
    echo 'Docs folder notes' > docs/README.md && echo old > docs/guide.md && echo 'outside secret' > "${dir}/outside.txt" &&
    git add -A && git -c user.email=t@t -c user.name=t commit -qm base && git update-ref refs/remotes/origin/main HEAD &&
    echo 'new guide text' > docs/guide.md && ln -s "${dir}/outside.txt" docs/link.md && git add -A &&
    git -c user.email=t@t -c user.name=t commit -qm change ${origin ? `&& git remote add origin "${origin}"` : ''}`]);
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
  if (promptCopy) env.CODEX_PROMPT_COPY = promptCopy;
  if (codexMinutes) env.REVIEW_CODEX_MINUTES = codexMinutes;
  if (claudeArgs) env.CLAUDE_ARGS_COPY = claudeArgs;
  let output = '';
  await new Promise((resolve) => {
    const child = spawn('bash', [REVIEW_SH], { env });
    child.stdout.on('data', (c) => { output += c; });
    child.stderr.on('data', (c) => { output += c; });
    child.on('close', resolve);
  });
  return { reports, output, repo, codexHome, given };
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

test('Codex, with no tools, gets what Claude reads in its prompt: the context, the diff, each changed file and its folder\'s README, never a link out', async (t) => {
  const promptCopy = path.join(os.tmpdir(), `codex-prompt-${process.pid}-${Date.now()}.md`);
  t.after(() => fs.rmSync(promptCopy, { force: true }));
  const { output } = await runReview(t, { agents: 'claude codex', promptCopy });
  assert.match(output, /Codex ended \(exit=0\)/, 'the fake codex runs only with no tools');
  const prompt = fs.readFileSync(promptCopy, 'utf8');
  assert.match(prompt, /^You are Codex/);
  assert.match(prompt, /you have no tools/);
  assert.match(prompt, /===== FILE: \S+\/codex\/context\.md =====\n# Pull request #7\n# Pull request: Add GTM/);
  assert.match(prompt, /===== FILE: \S+\/codex\/pr\.diff =====/);
  assert.match(prompt, /===== FILE: \S+\/codex\/files\/docs\/guide\.md =====\nnew guide text/);
  assert.match(prompt, /===== FILE: \S+\/codex\/files\/docs\/README\.md =====\nDocs folder notes/);
  assert.doesNotMatch(prompt, /outside secret/, 'a link out of the checkout is not followed');
});

test('a Codex that takes too long is stopped, and Claude Code\'s review goes out alone', async (t) => {
  const started = Date.now();
  const { reports, output } = await runReview(t, { agents: 'claude codex', codex: '#!/bin/bash\nsleep 30\n', codexMinutes: '0.02' });
  assert.ok(Date.now() - started < 20_000, 'it did not wait for codex');
  assert.match(output, /Codex took longer than 0\.02 minutes and was stopped/);
  assert.equal(reports[0].body.conclusion, 'APPROVE');
  assert.match(reports[0].body.summary, /Codex wrote no verdict/);
});

test('Claude\'s tools reach the checkout and its own review files alone, never Codex\'s files or the author\'s Codex sign-in', async (t) => {
  const claudeArgs = path.join(os.tmpdir(), `claude-args-${process.pid}-${Date.now()}.txt`);
  t.after(() => fs.rmSync(claudeArgs, { force: true }));
  const { repo, codexHome, given } = await runReview(t, { agents: 'claude codex', claudeArgs });
  const args = fs.readFileSync(claudeArgs, 'utf8').split('\n');
  const list = (flag) => args[args.indexOf(flag) + 1].split(',');
  const allowed = list('--allowedTools');
  const denied = list('--disallowedTools');
  for (const tool of ['Read', 'Grep', 'Glob']) assert.ok(allowed.includes(`${tool}(/${repo}/**)`), `${tool} in the checkout`);
  for (const tool of ['Write', 'Edit']) assert.ok(allowed.includes(`${tool}(/${repo}/.review/*)`), `${tool} of its own review files`);
  assert.ok(allowed.every((a) => /^[A-Za-z]+\(/.test(a)), 'no tool allowed on every path');
  for (const p of [`${repo}/.review/codex`, codexHome, path.dirname(given)]) {
    for (const tool of ['Read', 'Grep', 'Glob', 'Write', 'Edit']) assert.ok(denied.includes(`${tool}(/${p}/**)`), `${tool} denied in ${p}`);
  }
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
