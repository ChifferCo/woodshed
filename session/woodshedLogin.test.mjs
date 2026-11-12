// session/bin/woodshed-login's steps for /woodshed:remote-control, against a stand-in claude, in a tmux server of the
// test's own (TMUX_TMPDIR): never the session's own claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const LOGIN = fileURLToPath(new URL('./bin/woodshed-login', import.meta.url));
const hasTmux = (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// The stand-in: `claude auth login` prints a link and takes a code as the real one does (measured on Claude Code
// 2.1.322), writing a login for good-code alone. Any other claude says it opened, through the hook file, and keeps
// what is typed into it.
const FAKE_CLAUDE = `#!/bin/bash
if [ "$1" = auth ]; then
  echo 'Opening browser to sign in…'
  echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=abc"
  printf 'Paste code here if prompted > '
  read -r code
  if [ "$code" = good-code ]; then
    mkdir -p "$HOME/.claude" && echo '{"claudeAiOauth":{"accessToken":"x"}}' > "$HOME/.claude/.credentials.json"
    echo 'Login successful.'
    exit 0
  fi
  echo "Login failed: That code wasn't accepted."
  exit 1
fi
echo "$*" > "$WOODSHED_LOGIN_RUN_DIR/claude-args"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ state: "done", event: "SessionStart", at: Date.now() }))' "$WOODSHED_LOGIN_RUN_DIR/woodshed-claude-state.json"
while printf '❯ ' && IFS= read -r line; do echo "$line" >> "$WOODSHED_LOGIN_RUN_DIR/typed"; echo ' Remote Control'; done
`;

function setUp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-login-'));
  const bin = path.join(dir, 'bin');
  const runDir = path.join(dir, 'run');
  const home = path.join(dir, 'home');
  for (const d of [bin, runDir, home]) fs.mkdirSync(d);
  fs.copyFileSync(LOGIN, path.join(bin, 'woodshed-login'));
  fs.chmodSync(path.join(bin, 'woodshed-login'), 0o755);
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  const env = {
    PATH: process.env.PATH, HOME: home, TMUX_TMPDIR: dir, LANG: 'C.UTF-8', WOODSHED_CLAUDE_AUTH: 'own', WOODSHED_LOGIN_RUN_DIR: runDir,
    WOODSHED_LOGIN_URL_WAIT: '50', WOODSHED_LOGIN_CODE_WAIT: '50', WOODSHED_LOGIN_TURN_WAIT: '100', WOODSHED_LOGIN_START_WAIT: '100',
  };
  const tmux = (...args) => execFileSync('tmux', args, { env, encoding: 'utf8' });
  t.after(() => {
    try {
      tmux('kill-server');
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const login = (args, extra = {}) => run(path.join(bin, 'woodshed-login'), args, { env: { ...env, ...extra } }).then(
    ({ stdout }) => ({ code: 0, stdout }),
    (err) => ({ code: err.code, stdout: err.stdout, stderr: err.stderr }),
  );
  const until = async (check, what) => {
    for (let i = 0; i < 100; i++) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // What claude's pane shows says where a slow or stuck step stopped, which the log alone does not.
    let pane = 'none';
    try {
      pane = tmux('capture-pane', '-p', '-t', 'claude');
    } catch {}
    assert.fail(`${what} within 10 s; log: ${fs.existsSync(path.join(runDir, 'woodshed-login.log')) ? fs.readFileSync(path.join(runDir, 'woodshed-login.log'), 'utf8') : 'none'}; claude's pane: ${pane.trimEnd()}; state: ${fs.existsSync(path.join(runDir, 'woodshed-claude-state.json')) ? fs.readFileSync(path.join(runDir, 'woodshed-claude-state.json'), 'utf8') : 'none'}; now: ${Date.now()}`);
  };
  const hook = (fields) => fs.writeFileSync(path.join(runDir, 'woodshed-claude-state.json'), JSON.stringify({ at: Date.now(), ...fields }));
  return { bin, runDir, home, env, tmux, login, until, hook };
}

test('woodshed-login is for a session on its owner\'s own token only', async (t) => {
  const { login } = setUp(t);
  const got = await login(['start'], { WOODSHED_CLAUDE_AUTH: 'plan' });
  assert.equal(got.code, 1);
  assert.match(got.stderr, /My Woodshed session/);
});

test('start prints the sign-in link, and a refused code says so and asks for a new link', { skip: !hasTmux && 'no tmux' }, async (t) => {
  const { login, tmux } = setUp(t);
  const started = await login(['start']);
  assert.equal(started.code, 0, started.stderr);
  assert.match(started.stdout, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true&client_id=x&state=abc$/m);
  const refused = await login(['code', 'bad-code']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /not accepted: Login failed: That code wasn't accepted/);
  assert.throws(() => tmux('has-session', '-t', '=woodshed-login'), 'the sign-in is gone');
  const again = await login(['code', 'good-code']);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /no sign-in is waiting/);
});

test('a code that works reopens claude\'s conversation on the login once its turn ends, and types /remote-control', { skip: !hasTmux && 'no tmux' }, async (t) => {
  const { login, tmux, runDir, home, until, hook } = setUp(t);
  fs.writeFileSync(path.join(runDir, 'woodshed-claude-flags'), ' --settings /x/hooks.json --plugin-dir /x/claudePlugin');
  // claude's pane: a shell with the "running claude" in it, whose pid claude's Bash tool would have as CLAUDE_PID.
  tmux('new-session', '-d', '-s', 'claude', '-x', '200', '-y', '50', 'bash --norc');
  tmux('send-keys', '-t', 'claude', 'sleep 300', 'Enter');
  const panePid = tmux('display', '-p', '-t', 'claude', '#{pane_pid}').trim();
  let claudePid = '';
  await until(() => {
    try {
      claudePid = execFileSync('pgrep', ['-P', panePid, 'sleep'], { encoding: 'utf8' }).trim();
    } catch {}
    return Boolean(claudePid);
  }, 'the running claude started');

  assert.equal((await login(['start'])).code, 0);
  hook({ state: 'working', event: 'PreToolUse' });
  const signed = await login(['code', 'good-code'], { CLAUDE_PID: claudePid, CLAUDE_CODE_SESSION_ID: 'sess-1234' });
  assert.equal(signed.code, 0, signed.stderr);
  assert.match(signed.stdout, /Signed in/);
  assert.match(fs.readFileSync(path.join(home, '.claude/.credentials.json'), 'utf8'), /claudeAiOauth/);

  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.doesNotThrow(() => process.kill(Number(claudePid), 0), 'claude is left alone while its turn goes on');
  hook({ state: 'done', event: 'Stop' });
  await until(() => fs.existsSync(path.join(runDir, 'typed')), '/remote-control typed into the reopened claude');
  assert.throws(() => process.kill(Number(claudePid), 0), 'the old claude was stopped');
  assert.equal(fs.readFileSync(path.join(runDir, 'claude-args'), 'utf8').trim(), '--settings /x/hooks.json --plugin-dir /x/claudePlugin --resume sess-1234');
  assert.equal(fs.readFileSync(path.join(runDir, 'typed'), 'utf8'), '/remote-control\n');
  assert.match(fs.readFileSync(path.join(runDir, 'woodshed-login.log'), 'utf8'), /signed in[\s\S]*claude reopened[\s\S]*\/remote-control typed in/);
});

test('already on the login, start only types /remote-control once the turn ends', { skip: !hasTmux && 'no tmux' }, async (t) => {
  const { login, tmux, runDir, home, until, hook } = setUp(t);
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude/.credentials.json'), '{"claudeAiOauth":{}}');
  tmux('new-session', '-d', '-s', 'claude', '-x', '200', '-y', '50', `bash --norc -c 'while printf "❯ " && IFS= read -r l; do echo "$l" >> ${runDir}/typed; echo " Remote Control"; done'`);
  const got = await login(['start'], { WOODSHED_CLAUDE_ON_LOGIN: '1' });
  assert.equal(got.code, 0);
  assert.match(got.stdout, /Already signed in/);
  hook({ state: 'done', event: 'Stop' });
  await until(() => fs.existsSync(path.join(runDir, 'typed')), '/remote-control typed in');
  assert.equal(fs.readFileSync(path.join(runDir, 'typed'), 'utf8'), '/remote-control\n');
});
