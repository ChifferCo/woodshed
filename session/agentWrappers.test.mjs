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

test('the image gives Grok Build a root-owned policy that runs no MCP server and only the session\'s own hooks', () => {
  const policy = fs.readFileSync(fileURLToPath(new URL('./grokRequirements.toml', import.meta.url)), 'utf8');
  const settings = policy.split('\n').filter((line) => /^[a-z_]+ = /.test(line) && !line.startsWith('hooks = ') && !line.startsWith('matcher = '));
  assert.deepEqual(settings, ['allow_managed_mcp_servers_only = true', 'enable_all_project_mcp_servers = false', 'allowed_mcp_servers = []', 'allow_managed_hooks_only = true']);
  // The same events hookState.mjs reads, each to hookState alone.
  assert.deepEqual([...policy.matchAll(/^\[\[hooks\.(\w+)\]\]$/gm)].map((m) => m[1]).sort(), ['Notification', 'PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'StopCancelled', 'StopFailure', 'UserPromptSubmit']);
  const commands = [...policy.matchAll(/command = "([^"]*)"/g)].map((m) => m[1]);
  assert.equal(commands.length, 8);
  assert.deepEqual([...new Set(commands)], ['node /opt/woodshed/session/hookState.mjs']);
  const dockerfile = fs.readFileSync(fileURLToPath(new URL('./Dockerfile', import.meta.url)), 'utf8');
  assert.match(dockerfile, /^COPY --chmod=644 woodshed\/session\/grokRequirements\.toml \/etc\/grok\/requirements\.toml$/m, 'no --chown: root owns it, so node cannot change it');
  // Its folder made first, as root, and openable by node: a COPY that made it would give it the file's 644.
  const made = dockerfile.indexOf('RUN install -d -m 755 /etc/grok');
  assert.ok(made > 0 && made < dockerfile.indexOf('/etc/grok/requirements.toml'));
  assert.ok(dockerfile.lastIndexOf('USER node', made) < dockerfile.lastIndexOf('FROM ', made), 'made while the stage is still root');
});
