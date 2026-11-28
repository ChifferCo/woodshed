// session/antigravitySetup.sh and session/bin/agy, run as the entrypoint runs them, in a home and a checkout of the test's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { isolatedEnv } from '../test/isolatedEnv.mjs';

const run = promisify(execFile);
const SESSION_DIR = path.dirname(fileURLToPath(import.meta.url));

// A home and a checkout, and `configure(auth, env)` that runs configureAntigravity in them.
function session(t, { checkout = (repo) => fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'Use pnpm.\n') } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-agy-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(home);
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(tmp, 'woodshed-rules.md'), '# Woodshed rules\n');
  checkout(repo);
  const read = (file) => (fs.existsSync(path.join(home, file)) ? fs.readFileSync(path.join(home, file), 'utf8') : null);
  const configure = (auth = 'key', env = {}) => {
    const script = ['set -euo pipefail', 'log() { echo "[woodshed] $*"; }', 'die() { echo "ERROR: $*"; exit 1; }',
      'agentDir() { [ ! -L "$1" ] || die "$2\'s folder $1 is a symlink"; mkdir -p "$1"; chmod 700 "$1"; }',
      `. "${SESSION_DIR}/antigravitySetup.sh"`, `configureAntigravity ${auth}`].join('\n');
    try {
      const out = execFileSync('bash', ['-c', script], { encoding: 'utf8', env: isolatedEnv({ PATH: process.env.PATH, HOME: home, REPO_DIR: repo, SESSION_DIR, WOODSHED_RULES_FILE: path.join(tmp, 'woodshed-rules.md'), ...env }) });
      return { out, read };
    } catch (err) {
      return { out: String(err.stdout), failed: true, read };
    }
  };
  return { tmp, home, repo, read, configure };
}

test('the key\'s setup: the checkout trusted, onboarding done, its hooks, its rules, and nothing of the team\'s key', (t) => {
  const s = session(t);
  const done = s.configure('key');
  assert.ok(!done.failed, done.out);
  assert.match(done.out, /antigravity runs on the team's Gemini key, through the console/);
  const settings = JSON.parse(s.read('.gemini/antigravity-cli/settings.json'));
  assert.deepEqual(settings.trustedWorkspaces, [s.repo]);
  assert.deepEqual([settings.altScreenMode, settings.showTips, settings.showFeedbackSurvey, settings.enableTerminalSandbox], ['never', false, false, false]);
  // The credential and the permission mode are per run (antigravitySettings.mjs), never in the shared file.
  for (const key of ['modelProvider', 'agentMode', 'permissions', 'toolPermission']) assert.equal(key in settings, false, key);
  assert.deepEqual(JSON.parse(s.read('.gemini/antigravity-cli/cache/onboarding.json')), { consumerOnboardingComplete: true, enterpriseOnboardingComplete: true, onboardingComplete: true });
  assert.doesNotMatch(s.read('.gemini/antigravity-cli/settings.json'), /KEY|token/i);
  assert.equal(fs.statSync(path.join(s.home, '.gemini')).mode & 0o777, 0o700);
});

test('its hooks are the session\'s own, in the shape agy reads, each to hookState.mjs agy', (t) => {
  const s = session(t);
  s.configure('key');
  const hooks = JSON.parse(s.read('.gemini/config/hooks.json'));
  assert.deepEqual(Object.keys(hooks), ['woodshed']);
  const command = `node ${SESSION_DIR}/hookState.mjs agy`;
  const plain = ['SessionStart', 'PreInvocation', 'PostInvocation', 'Stop'];
  for (const event of plain) assert.deepEqual(hooks.woodshed[event], [{ type: 'command', command, timeout: 10 }], event);
  // The tool events nest their handlers under a matcher: a wrong shape is "command hook must specify 'command'".
  for (const event of ['PreToolUse', 'PostToolUse']) assert.deepEqual(hooks.woodshed[event], [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 10 }] }], event);
  assert.deepEqual(Object.keys(hooks.woodshed).sort(), [...plain, 'PreToolUse', 'PostToolUse'].sort());
});

test('the rules go in agy\'s global AGENTS.md, with the repo\'s CLAUDE.md where it has no AGENTS.md or GEMINI.md of its own', (t) => {
  const withAgents = session(t);
  withAgents.configure('key');
  assert.equal(withAgents.read('.gemini/AGENTS.md'), '# Woodshed rules\n', 'its own AGENTS.md is read by agy itself');
  const claudeOnly = session(t, { checkout: (repo) => fs.writeFileSync(path.join(repo, 'CLAUDE.md'), 'Use yarn.\n') });
  claudeOnly.configure('key');
  assert.equal(claudeOnly.read('.gemini/AGENTS.md'), '# Woodshed rules\n\n\n# The repo\'s own CLAUDE.md\n\nUse yarn.\n');
  const linked = session(t, { checkout: (repo) => { fs.writeFileSync(path.join(repo, '..', 'secret'), 'SENTINEL'); fs.symlinkSync('../secret', path.join(repo, 'CLAUDE.md')); } });
  const result = linked.configure('key');
  assert.equal(linked.read('.gemini/AGENTS.md'), '# Woodshed rules\n', 'never through a link');
  assert.match(result.out, /WARNING: the repo's CLAUDE\.md is a symlink/);
});

test('a second start adds to the trusted folders and never drops what is there, and rewrites the rest the same', (t) => {
  const s = session(t);
  fs.mkdirSync(path.join(s.home, '.gemini/antigravity-cli'), { recursive: true });
  fs.writeFileSync(path.join(s.home, '.gemini/antigravity-cli/settings.json'), JSON.stringify({ trustedWorkspaces: ['/elsewhere'], model: 'Gemini 3.1 Pro (Low)' }));
  s.configure('key');
  const first = s.read('.gemini/antigravity-cli/settings.json');
  s.configure('key');
  assert.equal(s.read('.gemini/antigravity-cli/settings.json'), first);
  const settings = JSON.parse(first);
  assert.deepEqual(settings.trustedWorkspaces, ['/elsewhere', s.repo].sort());
  assert.equal(settings.model, 'Gemini 3.1 Pro (Low)');
});

test('a link in agy\'s home stops the start, which would write where the link points', (t) => {
  for (const file of ['AGENTS.md', 'config/hooks.json', 'antigravity-cli/settings.json', 'antigravity-cli/cache/onboarding.json']) {
    const s = session(t);
    const target = path.join(s.tmp, 'elsewhere');
    fs.writeFileSync(target, 'SENTINEL');
    fs.mkdirSync(path.dirname(path.join(s.home, '.gemini', file)), { recursive: true });
    fs.symlinkSync(target, path.join(s.home, '.gemini', file));
    const result = s.configure('key');
    assert.ok(result.failed, file);
    assert.match(result.out, /is a symlink/, file);
    assert.equal(fs.readFileSync(target, 'utf8'), 'SENTINEL', `${file}: nothing was written through the link`);
  }
});

test('a rules file that points outside the checkout is never started on: agy reads it into its first request', (t) => {
  for (const [what, link] of [['AGENTS.md', (repo, elsewhere) => fs.symlinkSync(elsewhere, path.join(repo, 'AGENTS.md'))],
    ['GEMINI.md', (repo, elsewhere) => fs.symlinkSync(elsewhere, path.join(repo, 'GEMINI.md'))],
    ['.agents', (repo, elsewhere) => fs.symlinkSync(path.dirname(elsewhere), path.join(repo, '.agents'))],
    ['.agents/rules/a.md', (repo, elsewhere) => { fs.mkdirSync(path.join(repo, '.agents/rules'), { recursive: true }); fs.symlinkSync(elsewhere, path.join(repo, '.agents/rules/a.md')); }]]) {
    const s = session(t, { checkout: () => {} });
    const elsewhere = path.join(s.tmp, 'sign-in.json');
    fs.writeFileSync(elsewhere, 'SENTINEL');
    link(s.repo, elsewhere);
    const result = s.configure('key');
    assert.ok(result.failed, what);
    assert.match(result.out, /points outside the checkout/, what);
    assert.equal(s.read('.gemini/config/hooks.json'), null, `${what}: nothing written for agy`);
  }
  // A link to a file in the checkout is the repo's own choice.
  const inside = session(t, { checkout: (repo) => { fs.writeFileSync(path.join(repo, 'CLAUDE.md'), 'x'); fs.symlinkSync('CLAUDE.md', path.join(repo, 'AGENTS.md')); } });
  assert.ok(!inside.configure('key').failed);
});

test('a repo that ships hooks, MCP servers or plugins is a warning on the team\'s key, and stops a start that holds a sign-in', (t) => {
  const shipped = { checkout: (repo) => { fs.mkdirSync(path.join(repo, '.agents')); fs.writeFileSync(path.join(repo, '.agents/hooks.json'), '{}'); fs.mkdirSync(path.join(repo, '.agent/plugins'), { recursive: true }); } };
  const key = session(t, shipped);
  const warned = key.configure('key');
  assert.ok(!warned.failed, warned.out);
  assert.match(warned.out, /WARNING: the repo ships hooks, MCP servers or plugins that Antigravity CLI runs by itself \(files: .*\.agents\/hooks\.json .*\.agent\/plugins/);
  // The owner's own login, or another agent's beside it: what such code could read.
  const own = session(t, shipped).configure('own');
  assert.ok(own.failed);
  assert.match(own.out, /the repo ships \.agents\/hooks\.json \.agent\/plugins which Antigravity CLI would run as it opens, where it can read a saved sign-in/);
  for (const AGENT of ['grok', 'opencode']) {
    const beside = session(t, shipped);
    assert.ok(beside.configure('key', { AGENT }).failed, AGENT);
    assert.equal(beside.read('.gemini/config/hooks.json'), null, `${AGENT}: nothing written`);
  }
  // Rules and skills are text, which the agent could be told to follow anyway: no warning.
  const plain = session(t, { checkout: (repo) => { fs.mkdirSync(path.join(repo, '.agents/rules'), { recursive: true }); fs.writeFileSync(path.join(repo, '.agents/rules/a.md'), 'x'); } });
  assert.doesNotMatch(plain.configure('own').out, /ships/);
});

test('a repo that ships startup code stops a team-key start beside any agent whose personal credential is in the container', (t) => {
  const shipped = { checkout: (repo) => { fs.mkdirSync(path.join(repo, '.agents')); fs.writeFileSync(path.join(repo, '.agents/hooks.json'), '{}'); } };
  // Each place such a credential sits, as the entrypoint and the agents write them: a harmless dummy in each, never a real one.
  const held = [
    ['.config/woodshed/claude-token', 'a private claude session\'s owner\'s token', "the owner's Claude token"],
    ['.claude/.credentials.json', 'a claude login', "the owner's Claude login"],
    ['.config/woodshed/codex-auth', 'a codex session\'s sign-in as given', "the owner's Codex sign-in"],
    ['.codex/auth.json', 'a codex sign-in in its home', "the owner's Codex sign-in"],
    ['.config/woodshed/agent-auth', 'a Grok Build or OpenCode sign-in as given', "the owner's Grok Build or OpenCode sign-in"],
    ['.grok/auth.json', 'a Grok Build login', "the owner's Grok Build sign-in"],
    ['.local/share/opencode/auth.json', 'an OpenCode login', "the owner's OpenCode sign-in"],
  ];
  for (const [file, what, named] of held) {
    const s = session(t, shipped);
    fs.mkdirSync(path.dirname(path.join(s.home, file)), { recursive: true });
    fs.writeFileSync(path.join(s.home, file), '{"dummy":"not-a-real-credential"}\n', { mode: 0o600 });
    // As a claude or codex agent's session is started: AGENT names the primary, the team-key Antigravity is the one beside it.
    for (const AGENT of ['claude', 'codex']) {
      const r = s.configure('key', { AGENT });
      assert.ok(r.failed, `${what} (${AGENT}) stops the start`);
      assert.match(r.out, new RegExp(`where it can read a saved sign-in \\(${named.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`), what);
      assert.equal(s.read('.gemini/config/hooks.json'), null, `${what}: nothing written`);
    }
  }
  // No personal credential, and a team key with the session's token alone: a warning, as before.
  const bare = session(t, shipped);
  const warned = bare.configure('key', { AGENT: 'claude' });
  assert.ok(!warned.failed, warned.out);
  assert.match(warned.out, /WARNING: the repo ships hooks, MCP servers or plugins/);
  // An empty file is no credential.
  const empty = session(t, shipped);
  fs.mkdirSync(path.join(empty.home, '.config/woodshed'), { recursive: true });
  fs.writeFileSync(path.join(empty.home, '.config/woodshed/claude-token'), '');
  assert.ok(!empty.configure('key', { AGENT: 'claude' }).failed);
  // A checkout with no startup code is never held back by a credential.
  const quiet = session(t);
  fs.mkdirSync(path.join(quiet.home, '.config/woodshed'), { recursive: true });
  fs.writeFileSync(path.join(quiet.home, '.config/woodshed/claude-token'), 'dummy');
  assert.ok(!quiet.configure('key', { AGENT: 'claude' }).failed);
});

test('the owner\'s own Google login is written as agy\'s login file, 0600, never through a link, and never logged', (t) => {
  const login = '{"token":{"access_token":"made-up-access","token_type":"Bearer","refresh_token":"made-up-refresh","expiry":"2030-01-01T00:00:00Z"},"auth_method":"consumer"}';
  const withLogin = (s) => { fs.mkdirSync(path.join(s.home, '.config/woodshed'), { recursive: true }); fs.writeFileSync(path.join(s.home, '.config/woodshed/agent-auth'), login); };
  const s = session(t);
  withLogin(s);
  const done = s.configure('own', { OWN_AGENT_AUTH_FILE: path.join(s.home, '.config/woodshed/agent-auth') });
  assert.ok(!done.failed, done.out);
  const file = '.gemini/antigravity-cli/antigravity-oauth-token';
  assert.equal(s.read(file), login);
  assert.equal(fs.statSync(path.join(s.home, file)).mode & 0o777, 0o600);
  assert.doesNotMatch(done.out, /made-up/);
  const none = session(t).configure('own', { OWN_AGENT_AUTH_FILE: '/nonexistent' });
  assert.ok(none.failed);
  const bad = session(t);
  fs.mkdirSync(path.join(bad.home, '.config/woodshed'), { recursive: true });
  fs.writeFileSync(path.join(bad.home, '.config/woodshed/agent-auth'), 'sk-not-a-login');
  assert.match(bad.configure('own', { OWN_AGENT_AUTH_FILE: path.join(bad.home, '.config/woodshed/agent-auth') }).out, /not agy's login file/);
  const linked = session(t);
  withLogin(linked);
  const target = path.join(linked.tmp, 'elsewhere');
  fs.writeFileSync(target, 'SENTINEL');
  fs.mkdirSync(path.join(linked.home, '.gemini/antigravity-cli'), { recursive: true });
  fs.symlinkSync(target, path.join(linked.home, file));
  assert.ok(linked.configure('own', { OWN_AGENT_AUTH_FILE: path.join(linked.home, '.config/woodshed/agent-auth') }).failed);
  assert.equal(fs.readFileSync(target, 'utf8'), 'SENTINEL');
});

test('the settings for one run are written for its mode and its credential, and nowhere else', (t) => {
  const s = session(t);
  const file = path.join(s.tmp, 'agy-settings.json');
  const script = ['set -euo pipefail', 'die() { echo "ERROR: $*"; exit 1; }', `. "${SESSION_DIR}/antigravitySetup.sh"`, `ANTIGRAVITY_RUN_SETTINGS=${file}`, 'writeAntigravityRunSettings "$1"'].join('\n');
  execFileSync('bash', ['-c', script, 'x', 'key'], { env: isolatedEnv({ PATH: process.env.PATH, HOME: s.home, REPO_DIR: s.repo, SESSION_DIR, PERMISSION_MODE: 'default' }) });
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(settings.modelProvider, 'gemini');
  assert.deepEqual(settings.permissions.ask, [`write_file(${s.repo})`]);
});

// The wrapper over a stand-in for agy, which prints the arguments and the variables it got.
async function wrapped(t, { auth, env = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-wrapper-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = path.join(dir, 'agy');
  fs.writeFileSync(real, '#!/bin/bash\nnode -e \'const e = process.env; console.log(JSON.stringify({argv: process.argv.slice(1), key: e.GEMINI_API_KEY ?? null, base: e.GOOGLE_GEMINI_BASE_URL ?? null, update: e.AGY_CLI_DISABLE_AUTO_UPDATE ?? null, file: e.AGY_CLI_FORCE_FILE_TOKEN_STORAGE ?? null, team: e.TEAM_KEY ?? null}))\' -- "$@"\n', { mode: 0o755 });
  const { stdout } = await run(path.join(SESSION_DIR, 'bin/agy'), ['--model', 'm', '-i', 'hi there'], {
    env: isolatedEnv({ PATH: process.env.PATH, HOME: dir, WOODSHED_REAL_AGY: real, SESSION_TOKEN: 'the-session-token', WOODSHED_CONSOLE_URL: 'http://console:7690', ...(auth && { WOODSHED_AGY_AUTH: auth }), ...env }),
  });
  return JSON.parse(stdout);
}

test('agy on the team\'s key holds the session\'s token as its key and the console as its address, and never updates itself', async (t) => {
  assert.deepEqual(await wrapped(t, { auth: 'key' }), {
    argv: ['--model', 'm', '-i', 'hi there'], key: 'the-session-token', base: 'http://console:7690/gemini', update: 'true', file: 'true', team: null,
  });
});

test('agy on its owner\'s own login gets no key and no other address, whatever the session\'s environment holds', async (t) => {
  const result = await wrapped(t, { auth: 'own', env: { GEMINI_API_KEY: 'some-app-key', GOOGLE_GEMINI_BASE_URL: 'http://elsewhere' } });
  assert.deepEqual([result.key, result.base, result.update], [null, null, 'true']);
  assert.equal((await wrapped(t, {})).key, null, 'with no choice made it is the login, never the token');
});

test('the image installs a pinned agy, checked against the release manifest\'s sha512, in the runtime stage and again on an older runtime', () => {
  const dockerfile = fs.readFileSync(path.join(SESSION_DIR, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^ARG AGY_VERSION=\d+\.\d+\.\d+$/m);
  assert.match(dockerfile, /^ARG AGY_BUILD=\d+$/m);
  for (const arch of ['AMD64', 'ARM64']) assert.match(dockerfile, new RegExp(`^ARG AGY_SHA512_${arch}=[0-9a-f]{128}$`, 'm'), arch);
  const installs = dockerfile.split('\n').filter((line) => line.includes('/usr/local/bin/agy'));
  assert.equal(installs.length, 2, 'both stages');
  // Never the installer piped to a shell, which takes the latest unchecked, then runs the binary's own `install`.
  assert.doesNotMatch(dockerfile, /antigravity\.google\/cli\/install\.sh[^\n]*\|\s*(ba)?sh/);
  assert.equal([...dockerfile.matchAll(/echo "\$\{agy_sha\}  \/tmp\/agy\.tar\.gz" \| sha512sum -c -/g)].length, 2);
  // One marker, so a runtime built with these versions is reused, and one built before agy is not.
  const marker = 'grok ${GROK_VERSION}, opencode ${OPENCODE_VERSION}, agy ${AGY_VERSION}';
  assert.equal(dockerfile.split(marker).length - 1, 3, 'the check and both writes');
});
