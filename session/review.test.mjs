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

// A fake codex that asks for changes, so the merged verdict is visibly the stricter one. It reviews only when it reaches
// OpenAI through the console, as the real one does: on a key (session/bin/codex with WOODSHED_CODEX_AUTH=key), or on a
// stand-in ChatGPT login in CODEX_HOME whose access token is the session's token, with ChatGPT's addresses pointed at
// the console. It keeps what it was given, for the tests to check.
const FAKE_CODEX = `#!/bin/bash
args=" $* "
case "$WOODSHED_CODEX_AUTH" in
  key) ;;
  own) base=$(printf '%s' "$args" | grep -o 'chatgpt_base_url="https://127\\.0\\.0\\.1:[0-9]*/backend-api"' | sed 's/^chatgpt_base_url="//; s/"$//')
       [ -n "$base" ] && [[ "$args" == *'openai_base_url="'"$base"'/codex"'* ]] || exit 5
       [ -s "$CODEX_CA_CERTIFICATE" ] || exit 5
       # A call as codex makes it: through the relay, trusting only the CA it was given, on the stand-in's token.
       token=$(jq -r .tokens.access_token "$CODEX_HOME/auth.json")
       curl -sS --fail --cacert "$CODEX_CA_CERTIFICATE" -o /dev/null -K - "$base/codex/models?client_version=1" \
         <<< "header = \\"Authorization: Bearer $token\\"" || exit 6
       [ -n "$CODEX_SEEN" ] && cp "$CODEX_HOME/auth.json" "$CODEX_SEEN" ;;
  *) exit 2 ;;
esac
while [ $# -gt 0 ] && [ "$1" != exec ]; do shift; done
[ "$2" = --skip-git-repo-check ] && [ "$3" = --sandbox ] && [ "$4" = danger-full-access ] || exit 2
prompt=$6
case "$prompt" in "You are Codex"*) ;; *) exit 3 ;; esac
case "$prompt" in *"Hold to step 6's bar for what blocks"*) ;; *) exit 7 ;; esac
case "$prompt" in *"do not reword one of them into a blocker"*) ;; *) exit 7 ;; esac
case "$prompt" in *"give every finding you have in this one review"*) ;; *) exit 7 ;; esac
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

async function runReview(t, { origin = 'https://github.com/Acme/widgets.git', agents = null, codex = FAKE_CODEX, via = null, account = null, codexMinutes = null, relay = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-sh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessionDir = path.join(dir, 'session');
  const bin = path.join(dir, 'fakebin');
  const codexHome = path.join(dir, 'codex-review-home');
  const seen = path.join(dir, 'codex-seen.json');
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
      reports.push({ path: req.url, body: body ? JSON.parse(body) : null, auth: req.headers.authorization });
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
  delete env.CODEX_HOME;
  env.REVIEW_CODEX_HOME = codexHome;
  env.CODEX_SEEN = seen;
  if (agents) env.REVIEW_AGENTS = agents;
  if (via) env.REVIEW_CODEX_AUTH = via;
  if (account) env.REVIEW_CODEX_ACCOUNT = account;
  env.REVIEW_CHATGPT_RELAY = relay ?? path.join(HERE, 'chatgptRelay.mjs');
  if (codexMinutes) env.REVIEW_CODEX_MINUTES = codexMinutes;
  let output = '';
  await new Promise((resolve) => {
    const child = spawn('bash', [REVIEW_SH], { env });
    child.stdout.on('data', (c) => { output += c; });
    child.stderr.on('data', (c) => { output += c; });
    child.on('close', resolve);
  });
  return { reports, output, standIn: fs.existsSync(seen) ? JSON.parse(fs.readFileSync(seen, 'utf8')) : null, codexHome };
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

test('with Codex alone, claude is never run and Codex\'s verdict is the one sent, as its own', async (t) => {
  const { reports, output } = await runReview(t, { agents: 'codex', via: 'key' });
  assert.match(output, /Reviewing the diff of Acme\/widgets with Codex\n/);
  assert.doesNotMatch(output, /Claude ended/);
  const { body } = reports.find((r) => r.path === '/review-report');
  assert.equal(body.conclusion, 'REQUEST_CHANGES');
  assert.equal(body.summary, 'The link is wrong.', 'no sections: one reviewer');
  assert.deepEqual(body.inlineComments, [{ path: 'README.md', line: 1, body: 'This link 404s.' }]);
});

test('with Claude Code alone, codex is never run', async (t) => {
  const { reports, output } = await runReview(t, { codex: '#!/bin/bash\ntouch "$REPO_DIR/codex-ran"\nexit 1\n' });
  assert.doesNotMatch(output, /Codex/);
  assert.equal(reports[0].body.conclusion, 'APPROVE');
  assert.deepEqual(reports[0].body.inlineComments, [{ path: 'README.md', line: 1, body: 'Say what it is for.' }]);
});

test('a review on the author\'s ChatGPT login gives codex a stand-in holding only the session\'s token, reaching the console through an https relay', async (t) => {
  const { reports, output, standIn, codexHome } = await runReview(t, { agents: 'claude codex', via: 'chatgpt', account: 'acct-ana' });
  assert.match(output, /Codex reviews on the author's ChatGPT login, which the console adds to its calls/);
  assert.match(output, /Codex ended \(exit=0\)/, 'the fake codex reached the console through the relay');
  const relayed = reports.find((r) => r.path.startsWith('/chatgpt/'));
  assert.equal(relayed.path, '/chatgpt/backend-api/codex/models?client_version=1');
  assert.equal(relayed.auth, 'Bearer tok', 'the session token, which the console swaps for the author\'s login');
  assert.equal(standIn.auth_mode, 'chatgpt');
  assert.equal(standIn.tokens.access_token, 'tok');
  assert.equal(standIn.tokens.refresh_token, 'woodshed-stand-in');
  assert.equal(standIn.tokens.account_id, 'acct-ana', 'the author\'s account, which codex looks for in ChatGPT\'s list');
  assert.ok(Date.now() - Date.parse(standIn.last_refresh) < 60_000, 'fresh, so codex does not try to refresh it');
  const claims = JSON.parse(Buffer.from(standIn.tokens.id_token.split('.')[1], 'base64url').toString('utf8'));
  assert.equal(claims['https://api.openai.com/auth'].chatgpt_account_id, 'acct-ana');
  assert.equal((fs.statSync(path.join(codexHome, 'auth.json')).mode & 0o777), 0o600);
  assert.ok(!fs.existsSync(path.join(codexHome, 'relay', 'ca-key.pem')), 'the CA\'s key is gone once the certificate is made');
  assert.equal(reports.filter((r) => r.path === '/codex-auth').length, 0, 'nothing is sent back: no sign-in was here');
  assert.equal(reports.find((r) => r.path === '/review-report').body.conclusion, 'REQUEST_CHANGES');
});

test('a relay that never says its port is stopped, and Claude Code\'s review goes out alone', async (t) => {
  const pidFile = path.join(os.tmpdir(), `relay-pid-${process.pid}-${Date.now()}`);
  const relay = path.join(os.tmpdir(), `hung-relay-${process.pid}-${Date.now()}.mjs`);
  fs.writeFileSync(relay, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`.replace('require(\'fs\')', '(await import(\'node:fs\'))'));
  t.after(() => { fs.rmSync(relay, { force: true }); fs.rmSync(pidFile, { force: true }); });
  const { reports, output } = await runReview(t, { agents: 'claude codex', via: 'chatgpt', account: 'acct-ana', relay });
  assert.match(output, /Could not start the relay to the console, so Codex does not review/);
  assert.equal(reports.find((r) => r.path === '/review-report').body.conclusion, 'APPROVE');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the relay was stopped');
});

test('on a key, codex goes through the console\'s OpenAI proxy and gets no login at all', async (t) => {
  const { reports, output, standIn } = await runReview(t, { agents: 'claude codex', via: 'key' });
  assert.match(output, /Codex reviews on a key the console adds to its calls/);
  assert.equal(standIn, null);
  assert.equal(reports[0].body.conclusion, 'REQUEST_CHANGES');
});

test('a Codex that takes too long is stopped, and Claude Code\'s review goes out alone', async (t) => {
  const started = Date.now();
  const { reports, output } = await runReview(t, { agents: 'claude codex', codex: '#!/bin/bash\nsleep 30\n', codexMinutes: '0.02' });
  assert.ok(Date.now() - started < 20_000, 'it did not wait for codex');
  assert.match(output, /Codex took longer than 0\.02 minutes and was stopped/);
  assert.equal(reports[0].body.conclusion, 'APPROVE');
  assert.match(reports[0].body.summary, /Codex wrote no verdict/);
});
