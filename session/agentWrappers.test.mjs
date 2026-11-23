// session/bin's grok, agy and opencode: each runs the agent by its path, and hands an owner's own key to that agent alone.
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
  fs.writeFileSync(real, '#!/bin/bash\nnode -e \'console.log(JSON.stringify({argv: process.argv.slice(1), xai: process.env.XAI_API_KEY ?? null, gemini: process.env.GEMINI_API_KEY ?? null, update: process.env.AGY_CLI_DISABLE_AUTO_UPDATE ?? null, dbus: process.env.DBUS_SESSION_BUS_ADDRESS ?? null, projectConfig: process.env.OPENCODE_DISABLE_PROJECT_CONFIG ?? null}))\' -- "$@"\n', { mode: 0o755 });
  const authFile = path.join(dir, 'agent-auth');
  if (auth !== null) fs.writeFileSync(authFile, auth, { mode: 0o600 });
  const variable = { grok: 'WOODSHED_REAL_GROK', agy: 'WOODSHED_REAL_AGY', opencode: 'WOODSHED_REAL_OPENCODE' }[name];
  const { stdout } = await run(fileURLToPath(new URL(`./bin/${name}`, import.meta.url)), ['--model', 'm', 'hi there'], {
    env: isolatedEnv({ PATH: process.env.PATH, HOME: dir, [variable]: real, WOODSHED_AGENT_AUTH_FILE: authFile, ...env }),
  });
  return JSON.parse(stdout);
}

test('grok gets an xAI key in XAI_API_KEY, and nothing for a login, which is in its own auth.json', async (t) => {
  assert.deepEqual(await wrapped(t, 'grok', { auth: 'xai-abc123' }), { argv: ['--model', 'm', 'hi there'], xai: 'xai-abc123', gemini: null, update: null, dbus: null, projectConfig: null });
  assert.equal((await wrapped(t, 'grok', { auth: '{"x":{"key":"k"}}' })).xai, null);
  assert.equal((await wrapped(t, 'grok')).xai, null);
});

test('agy gets a Gemini key in GEMINI_API_KEY, and never updates itself', async (t) => {
  assert.deepEqual(await wrapped(t, 'agy', { auth: 'AIzaSyExample' }), { argv: ['--model', 'm', 'hi there'], xai: null, gemini: 'AIzaSyExample', update: 'true', dbus: null, projectConfig: null });
});

test('agy gets no key for a Google sign-in, and no D-Bus, so it keeps that sign-in in its file', async (t) => {
  const login = '{"token":{"access_token":"a","refresh_token":"r"},"auth_method":"consumer"}';
  const out = await wrapped(t, 'agy', { auth: login, env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' } });
  assert.deepEqual([out.gemini, out.dbus, out.update], [null, null, 'true']);
});

test('opencode never reads the repo\'s own config, which could send the owner\'s key elsewhere', async (t) => {
  assert.deepEqual(await wrapped(t, 'opencode', { auth: '{"anthropic":{"type":"api","key":"k"}}' }), { argv: ['--model', 'm', 'hi there'], xai: null, gemini: null, update: null, dbus: null, projectConfig: '1' });
});

// woodshed-sign-in over a stand-in agy, which signs in by writing its file where it is told HOME is, and a stand-in
// console's /agent-sign-in.
test('woodshed-sign-in sends the Google sign-in agy saved to the console, never printing it, and keeps no copy', async (t) => {
  const http = await import('node:http');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-in-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const login = '{"token":{"access_token":"at-secret","refresh_token":"rt-secret"},"auth_method":"consumer"}';
  const real = path.join(dir, 'agy');
  // What it got: no key, D-Bus or sign-in of the session's own, and the onboarding the entrypoint writes.
  fs.writeFileSync(real, `#!/bin/bash\nprintf '%s %s %s' "\${GEMINI_API_KEY:-none}" "$(jq -c . "$HOME/.gemini/antigravity-cli/cache/onboarding.json")" "$*" > ${JSON.stringify(path.join(dir, 'seen'))}\nprintf '%s' '${login}' > "$HOME/.gemini/antigravity-cli/antigravity-oauth-token"\n`, { mode: 0o755 });
  const got = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; }).on('end', () => {
      got.push({ url: req.url, auth: req.headers.authorization, agent: req.headers['x-woodshed-agent'], body });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const ownKey = path.join(dir, 'agent-auth');
  fs.writeFileSync(ownKey, 'AIzaSyTheSessionsOwnKey', { mode: 0o600 });
  const { stdout, stderr } = await run(fileURLToPath(new URL('./bin/woodshed-sign-in', import.meta.url)), ['antigravity'], {
    env: isolatedEnv({
      PATH: process.env.PATH, HOME: dir, WOODSHED_REAL_AGY: real, WOODSHED_AGENT_AUTH_FILE: ownKey, GEMINI_API_KEY: 'AIzaSyExported', TMPDIR: dir,
      WOODSHED_CONSOLE_URL: `http://127.0.0.1:${server.address().port}`, SESSION_TOKEN: 'session-token',
    }),
  });
  assert.deepEqual(got, [{ url: '/agent-sign-in', auth: 'Bearer session-token', agent: 'antigravity', body: login }]);
  assert.equal(fs.readFileSync(path.join(dir, 'seen'), 'utf8'), 'none {"consumerOnboardingComplete":true,"enterpriseOnboardingComplete":false,"onboardingComplete":true} -p Say ok.');
  assert.match(stdout, /Saved on My settings/);
  assert.doesNotMatch(stdout + stderr, /secret/, 'the sign-in is never printed');
  assert.ok(!fs.existsSync(path.join(dir, '.gemini')), 'nothing is written in the session\'s own home');
  assert.deepEqual(fs.readdirSync('/tmp').filter((f) => f.startsWith('woodshed-sign-in.')).filter((f) => fs.statSync(path.join('/tmp', f)).mtimeMs > Date.now() - 60_000), [], 'its folder is gone');
});

test('woodshed-sign-in says so when agy did not sign in, and sends nothing', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-in-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = path.join(dir, 'agy');
  fs.writeFileSync(real, '#!/bin/bash\nexit 1\n', { mode: 0o755 });
  await assert.rejects(run(fileURLToPath(new URL('./bin/woodshed-sign-in', import.meta.url)), ['antigravity'], {
    env: isolatedEnv({ PATH: process.env.PATH, HOME: dir, WOODSHED_REAL_AGY: real, WOODSHED_CONSOLE_URL: 'http://127.0.0.1:9', SESSION_TOKEN: 't' }),
  }), (err) => /No sign-in was saved/.test(err.stderr));
  await assert.rejects(run(fileURLToPath(new URL('./bin/woodshed-sign-in', import.meta.url)), ['grok'], { env: isolatedEnv({ PATH: process.env.PATH }) }),
    (err) => err.code === 2 && /usage/.test(err.stderr));
});
