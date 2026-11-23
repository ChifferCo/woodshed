import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HERDR_VARIABLES, isolatedEnv } from './isolatedEnv.mjs';

// A test run inside a Woodshed session whose agent runs in Herdr must never reach that agent's hc core: statusd started
// with the session's own environment typed Esc into claude, interrupting the agent running the suite (isolatedEnv.mjs).
const WOODSHED = path.resolve(import.meta.dirname, '..');
const AGENT_PANE = path.join(WOODSHED, 'session/agentPane.mjs');

// What a test process inherits in such a session: the agent's terminal and core.
const HERDR_SESSION = {
  WOODSHED_TERMINAL: 'herdr', HC_TERMINAL_ID: 't1', HC_TERMINAL_SOCKET: '/home/node/.local/state/herdr-core/default/default.sock',
  HC_SCOPE: 'x', XDG_STATE_HOME: '/home/node/.local/state',
};

test('no test hands this process\'s environment to a program but through isolatedEnv', () => {
  const files = execFileSync('git', ['ls-files', '*.test.mjs', '**/*.test.mjs'], { cwd: WOODSHED, encoding: 'utf8' }).split('\n').filter(Boolean);
  const copies = /\.\.\.process\.env\b(?!\.)|env:\s*process\.env\b(?!\.)|Object\.(?:entries|assign|keys)\(\s*(?:\{\},\s*)?process\.env\s*\)/;
  const found = [];
  for (const file of files) {
    fs.readFileSync(path.join(WOODSHED, file), 'utf8').split('\n').forEach((line, i) => {
      if (copies.test(line)) found.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(found, [], 'start from isolatedEnv() (test/isolatedEnv.mjs), which keeps the agent\'s hc core out of reach');
});

test('importing isolatedEnv takes the Herdr variables out of this test process too', () => {
  for (const name of HERDR_VARIABLES) assert.equal(process.env[name], undefined, name);
});

test('isolatedEnv drops every variable that reaches a Herdr core, and puts hc on a scratch core of its own', () => {
  const env = isolatedEnv({ ...HERDR_SESSION, PATH: '/usr/bin', HOME: '/home/node', LANG: 'C.UTF-8' });
  for (const name of HERDR_VARIABLES.filter((n) => n !== 'HC_SESSION')) assert.equal(env[name], undefined, name);
  assert.equal(env.HC_SESSION, 'test');
  assert.deepEqual([env.PATH, env.HOME, env.LANG], ['/usr/bin', '/home/node', 'C.UTF-8'], 'everything else is kept');
  for (const name of ['XDG_RUNTIME_DIR', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) {
    assert.ok(env[name].startsWith(os.tmpdir()), `${name} is scratch: ${env[name]}`);
    assert.ok(fs.statSync(env[name]).isDirectory());
  }
  // hc's socket goes under the state folder: <state>/herdr-core/<session>/<session>.sock, within Linux's 107 bytes.
  assert.ok(path.join(env.XDG_STATE_HOME, 'herdr-core/test/test.sock').length < 100);
  assert.equal(isolatedEnv().XDG_STATE_HOME, env.XDG_STATE_HOME, 'one scratch core per test process');
});

// A recording hc and tmux first on the PATH: each call is kept with what it was told of its terminal and core.
function recorders(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wshc-rec-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'calls');
  for (const name of ['hc', 'tmux']) {
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh
printf '%s %s|%s|%s|%s|%s\\n' "${name}" "$*" "\${HC_TERMINAL_ID-}" "\${HC_TERMINAL_SOCKET-}" "\${HC_SESSION-}" "\${XDG_STATE_HOME-}" >> ${JSON.stringify(log)}
exit 1
`, { mode: 0o755 });
  }
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
  return { bin: dir, calls };
}

// statusd's Esc to the agent (POST /interrupt), as agentPane sends it, in a program started with `env`.
function sendEsc(env) {
  const script = `import { execFile } from 'node:child_process'; import { promisify } from 'node:util';
    import { agentPane } from ${JSON.stringify(AGENT_PANE)};
    await agentPane(promisify(execFile)).keys('Escape').catch(() => {});`;
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
}

test('a program started from a Herdr session\'s environment types into its agent, and one started through isolatedEnv cannot', (t) => {
  const raw = recorders(t);
  sendEsc({ ...HERDR_SESSION, PATH: `${raw.bin}:/usr/bin:/bin` });
  assert.deepEqual(raw.calls(), [`hc keys --json -- claude esc|t1|${HERDR_SESSION.HC_TERMINAL_SOCKET}||/home/node/.local/state`],
    'what interrupted the agent running the suite: Esc into the terminal named claude, on its own core');

  const isolated = recorders(t);
  sendEsc(isolatedEnv({ ...HERDR_SESSION, PATH: `${isolated.bin}:/usr/bin:/bin` }));
  const calls = isolated.calls();
  assert.ok(calls.length > 0 && calls.every((c) => c.startsWith('tmux ')), `only tmux, the pane of a session that is not Herdr's: ${calls}`);
});

test('hc run by a test through isolatedEnv is told of no terminal, and of its scratch core alone', (t) => {
  const rec = recorders(t);
  const env = isolatedEnv({ ...HERDR_SESSION, PATH: `${rec.bin}:/usr/bin:/bin` });
  spawnSync('hc', ['ls'], { env });
  assert.deepEqual(rec.calls(), [`hc ls|||test|${env.XDG_STATE_HOME}`]);
});
