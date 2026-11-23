// session/bin's grok and opencode: each runs the agent by its path, and hands an owner's own key to that agent alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { isolatedEnv } from '../test/isolatedEnv.mjs';

const run = promisify(execFile);

// The wrapper run over a stand-in for the agent, which prints its arguments and the key variables it got.
async function wrapped(t, name, { auth = null, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-wrapper-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = path.join(dir, name);
  fs.writeFileSync(real, '#!/bin/bash\nnode -e \'console.log(JSON.stringify({argv: process.argv.slice(1), xai: process.env.XAI_API_KEY ?? null, projectConfig: process.env.OPENCODE_DISABLE_PROJECT_CONFIG ?? null}))\' -- "$@"\n', { mode: 0o755 });
  const authFile = path.join(dir, 'agent-auth');
  if (auth !== null) fs.writeFileSync(authFile, auth, { mode: 0o600 });
  const variable = { grok: 'WOODSHED_REAL_GROK', opencode: 'WOODSHED_REAL_OPENCODE' }[name];
  const { stdout } = await run(fileURLToPath(new URL(`./bin/${name}`, import.meta.url)), ['--model', 'm', 'hi there'], {
    env: isolatedEnv({ PATH: process.env.PATH, HOME: dir, [variable]: real, WOODSHED_AGENT_AUTH_FILE: authFile, ...env }),
  });
  return JSON.parse(stdout);
}

test('grok gets an xAI key in XAI_API_KEY, and nothing for a login, which is in its own auth.json', async (t) => {
  assert.deepEqual(await wrapped(t, 'grok', { auth: 'xai-abc123' }), { argv: ['--model', 'm', 'hi there'], xai: 'xai-abc123', projectConfig: null });
  assert.equal((await wrapped(t, 'grok', { auth: '{"x":{"key":"k"}}' })).xai, null);
  assert.equal((await wrapped(t, 'grok')).xai, null);
});

test('opencode never reads the repo\'s own config, which could send the owner\'s key elsewhere', async (t) => {
  assert.deepEqual(await wrapped(t, 'opencode', { auth: '{"anthropic":{"type":"api","key":"k"}}' }), { argv: ['--model', 'm', 'hi there'], xai: null, projectConfig: '1' });
});
