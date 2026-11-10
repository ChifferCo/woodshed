import { test } from 'node:test';
import assert from 'node:assert/strict';

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const WRAPPER = fileURLToPath(new URL('./bin/claude', import.meta.url));
const NAMES = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN'];

// A stand-in for the real claude: what it was given, and what a command it runs would see after CLAUDE_ENV_FILE.
function fakeClaude(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-wrapper-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = path.join(dir, 'claude');
  fs.writeFileSync(real, `#!/bin/bash
node -e 'const e = process.env; console.log(JSON.stringify({ args: process.argv.slice(1), own: Object.fromEntries(${JSON.stringify(NAMES)}.map((n) => [n, e[n] ?? null])) }))' -- "$@"
[ -z "\${CLAUDE_ENV_FILE:-}" ] || { source "$CLAUDE_ENV_FILE"; rm -f "$CLAUDE_ENV_FILE"; }
env | grep -oE '^(${NAMES.join('|')})=' | tr -d = | sort | tr '\\n' ' '
`, { mode: 0o755 });
  return { dir, real };
}

async function claude(t, env) {
  const { dir, real } = fakeClaude(t);
  const { stdout } = await run(WRAPPER, ['-p', 'hi'], { env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, WOODSHED_REAL_CLAUDE: real, ...env } });
  const [first, children] = stdout.split('\n');
  return { ...JSON.parse(first), children: children.trim().split(' ').filter(Boolean) };
}

const SESSION = { SESSION_TOKEN: 'sess-123', WOODSHED_CONSOLE_URL: 'http://10.0.0.5:7691' };

test('on the team key, claude gets the session token as its key and the proxy, and nothing it runs keeps them', async (t) => {
  const got = await claude(t, { ...SESSION, WOODSHED_CLAUDE_AUTH: 'key' });
  assert.deepEqual(got.args, ['-p', 'hi']);
  assert.deepEqual(got.own, { ANTHROPIC_API_KEY: 'sess-123', ANTHROPIC_BASE_URL: 'http://10.0.0.5:7691/anthropic', CLAUDE_CODE_OAUTH_TOKEN: null });
  assert.deepEqual(got.children, [], 'the api server claude starts reads only its api/.env');
});

test('on a Claude plan, claude gets the session token as its OAuth token, and no key from anywhere', async (t) => {
  const got = await claude(t, { ...SESSION, WOODSHED_CLAUDE_AUTH: 'plan', ANTHROPIC_API_KEY: 'sk-ant-api03-team' });
  assert.deepEqual(got.own, { ANTHROPIC_API_KEY: null, ANTHROPIC_BASE_URL: 'http://10.0.0.5:7691/anthropic', CLAUDE_CODE_OAUTH_TOKEN: 'sess-123' });
  assert.deepEqual(got.children, []);
});

test('in a private session, claude gets its owner\'s token from the file, and calls Anthropic directly', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-token-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'claude-token');
  fs.writeFileSync(file, 'sk-ant-oat01-owner', { mode: 0o600 });
  const got = await claude(t, {
    ...SESSION, WOODSHED_CLAUDE_AUTH: 'own', WOODSHED_CLAUDE_TOKEN_FILE: file,
    ANTHROPIC_API_KEY: 'sk-ant-api03-team', ANTHROPIC_BASE_URL: 'http://elsewhere',
  });
  assert.deepEqual(got.own, { ANTHROPIC_API_KEY: null, ANTHROPIC_BASE_URL: null, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-owner' });
  assert.deepEqual(got.children, [], 'nothing claude runs gets the owner\'s token');
});

test('with no proxy chosen, claude runs as it is, on the key in the environment', async (t) => {
  const got = await claude(t, { ...SESSION, ANTHROPIC_API_KEY: 'sk-ant-api03-docker' });
  assert.deepEqual(got.own, { ANTHROPIC_API_KEY: 'sk-ant-api03-docker', ANTHROPIC_BASE_URL: null, CLAUDE_CODE_OAUTH_TOKEN: null });
  assert.deepEqual(got.children, ['ANTHROPIC_API_KEY'], 'the docker launcher\'s key reaches everything, as before');
});
