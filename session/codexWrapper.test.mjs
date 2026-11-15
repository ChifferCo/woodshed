import { test } from 'node:test';
import assert from 'node:assert/strict';

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const WRAPPER = fileURLToPath(new URL('./bin/codex', import.meta.url));

// A stand-in for the real codex: the arguments it was given.
async function codex(t, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-wrapper-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = path.join(dir, 'codex');
  fs.writeFileSync(real, '#!/bin/bash\nnode -e \'console.log(JSON.stringify(process.argv.slice(1)))\' -- "$@"\n', { mode: 0o755 });
  const { stdout } = await run(WRAPPER, ['exec', 'hi'], { env: { PATH: process.env.PATH, HOME: dir, WOODSHED_REAL_CODEX: real, ...env } });
  return JSON.parse(stdout);
}

test('codex runs inline, never on the alternate screen, on its own sign-in and on the team key', async (t) => {
  const own = await codex(t, {});
  assert.deepEqual(own, ['-c', 'tui.alternate_screen="never"', 'exec', 'hi']);
  const team = await codex(t, { WOODSHED_CODEX_AUTH: 'key', SESSION_TOKEN: 'sess-123', WOODSHED_CONSOLE_URL: 'http://10.0.0.5:7691' });
  assert.deepEqual(team.slice(0, 2), ['-c', 'tui.alternate_screen="never"']);
  assert.ok(team.includes('model_provider="woodshed"'), 'and through the console');
  assert.deepEqual(team.slice(-2), ['exec', 'hi']);
});
