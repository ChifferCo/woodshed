// The environment a test gives a program it starts: this process's own, less what reaches a Herdr core, plus a core of
// its own.
//
// A Woodshed session whose owner picked Herdr runs its agent in a herdr-core terminal named claude, and every program
// in it, a test run included, inherits WOODSHED_TERMINAL=herdr and the agent's HC_TERMINAL_ID and HC_TERMINAL_SOCKET.
// A statusd started with those (session/statusd.test.mjs did) reads and types into that claude: `hc keys claude esc`
// interrupts the very agent running the tests. Unsetting the HC_ variables alone is not enough, since hc with none goes
// to the default core under XDG_STATE_HOME, which is the agent's too. So a test's program never gets them: it gets a
// scratch HC_SESSION and XDG folders, and whatever runs hc there reaches a core nobody else uses.
//
// test/hcIsolation.test.mjs fails when a test file copies process.env into a program's environment some other way, or
// when this process still holds them once this is imported.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// What picks the agent's terminal or a Herdr core, and is never handed down.
export const HERDR_VARIABLES = ['WOODSHED_TERMINAL', 'WOODSHED_HC_BIN', 'HC_TERMINAL_ID', 'HC_TERMINAL_SOCKET', 'HC_SCOPE', 'HC_SESSION'];

// And never this test process's own: a module read in it (statusd.mjs picks tmux or Herdr as it loads) or a program it
// starts without an environment of its own would take them. Import this before the module under test.
for (const name of HERDR_VARIABLES) delete process.env[name];

let scratch = null;

// One scratch folder per test process, short enough for a socket path (107 bytes on Linux), removed at its exit.
function scratchDir() {
  if (scratch) return scratch;
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wshc-'));
  for (const sub of ['run', 'state', 'config', 'data']) fs.mkdirSync(path.join(scratch, sub), { mode: 0o700 });
  process.once('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));
  return scratch;
}

/**
 * @param {NodeJS.ProcessEnv} [base]  the environment to start from, this process's by default
 * @returns {NodeJS.ProcessEnv}  base, without HERDR_VARIABLES, on a scratch hc core
 */
export function isolatedEnv(base = process.env) {
  const dir = scratchDir();
  const env = { ...base };
  for (const name of HERDR_VARIABLES) delete env[name];
  return {
    ...env,
    HC_SESSION: 'test',
    XDG_RUNTIME_DIR: path.join(dir, 'run'),
    XDG_STATE_HOME: path.join(dir, 'state'),
    XDG_CONFIG_HOME: path.join(dir, 'config'),
    XDG_DATA_HOME: path.join(dir, 'data'),
  };
}
