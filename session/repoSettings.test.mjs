// A session's start with repo settings: the entrypoint's fetchRepoSettings against a real HTTP server standing in for
// the console's session API, with the real curl, then its writeEnvFiles and writeRules as they are written there.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fixtureCheckout, fixtureProject } from '../shared/projectFixture.mjs';

const SESSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHARED_DIR = path.resolve(SESSION_DIR, '../shared');
const ENTRYPOINT = fs.readFileSync(path.join(SESSION_DIR, 'entrypoint.sh'), 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-repo-settings-start-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function fn(name) {
  const at = ENTRYPOINT.indexOf(`\n${name}() {`);
  assert.ok(at >= 0, `${name} is in entrypoint.sh`);
  return ENTRYPOINT.slice(at + 1, ENTRYPOINT.indexOf('\n}\n', at) + 2);
}

const ANSWER = {
  project: 'app',
  envFiles: { 'api-env': { installation: 'AUTH_DOMAIN=installation.test\nLOG_LEVEL=warn', personal: 'LOG_LEVEL=debug-mine' } },
  instructions: { installation: 'Use pnpm, never npm.', personal: 'Answer in short sentences.' },
  personalFor: 'octocat',
};
const VALUES = ['installation.test', 'debug-mine', 'pnpm', 'short sentences', 'legacy.test'];

/** The console's session API: each call gets the next of `answers` (the last one again once they run out). */
function fakeConsole(answers) {
  const calls = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      calls.push({ url: req.url, auth: req.headers.authorization });
      const { status = 200, json } = answers[Math.min(calls.length, answers.length) - 1];
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    after(() => server.close());
    resolve({ url: `http://127.0.0.1:${server.address().port}`, calls });
  }));
}

function bash(script, env) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', script], { env: { PATH: process.env.PATH, ...env } });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('close', (status) => resolve({ status, out }));
  });
}

// A checkout whose project file has one env file with a secret, and rules of its own.
function checkout() {
  const dir = fixtureCheckout(fs.mkdtempSync(path.join(TMP, 'repo-')), { repo: 'acme/app' });
  fs.mkdirSync(path.join(dir, '.woodshed'));
  fs.writeFileSync(path.join(dir, '.woodshed/project.yaml'), fixtureProject({
    rules: '.woodshed/rules.md',
    envFiles: [{ path: 'api/.env', secret: 'api-env', defaults: ['LOG_LEVEL=info'], lines: ['DB_PASSWORD={{PGPASSWORD}}'] }],
  }));
  fs.writeFileSync(path.join(dir, '.woodshed/rules.md'), '- Run `make check` before every push.\n');
  return dir;
}

/**
 * fetchRepoSettings, then writeEnvFiles and writeRules as runSession calls them, then the file's removal. Prints what
 * each wrote, and whether the answer's file was there and readable by its user alone between them.
 */
async function start({ consoleUrl, kind = 'private', mode = '', env = {} }) {
  const home = fs.mkdtempSync(path.join(TMP, 'home-'));
  const tmp = fs.mkdtempSync(path.join(TMP, 'tmp-'));
  const repoDir = checkout();
  const script = [
    'set -euo pipefail', 'log() { echo "[woodshed] $*"; }', 'die() { log "ERROR: $*"; exit 1; }',
    'project() { node "$SHARED_DIR/project.mjs" "$@"; }', 'databases() { node "$SHARED_DIR/databases/index.mjs" "$@"; }',
    `REPO_SETTINGS_JSON=${home}/.config/woodshed/repo-settings.json`,
    fn('consoleCall').replaceAll('--retry-delay 5', '--retry-delay 1'), fn('fetchRepoSettings'),
    fn('writeEnvFiles'), fn('leaveOutConsoleLinks'), fn('writeRules').replaceAll('/tmp/', `${tmp}/`),
    'fetchRepoSettings',
    'if [ -f "$REPO_SETTINGS_JSON" ]; then echo "answer kept: $(stat -c %a "$REPO_SETTINGS_JSON")"; else echo "answer kept: no"; fi',
    'writeEnvFiles', 'writeRules', 'rm -f "$REPO_SETTINGS_JSON"',
  ].join('\n');
  const run = await bash(script, {
    HOME: home, SESSION_DIR, SHARED_DIR, REPO_DIR: repoDir, SESSION_KIND: kind, SESSION_MODE: mode, SESSION_TOKEN: 'session-token',
    WOODSHED_CONSOLE_URL: consoleUrl ?? '', BRANCH: 'woodshed/x', DEFAULT_BRANCH: 'main', STARTED_BY: 'octocat', PGPASSWORD: 'session-password', ...env,
  });
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
  return { ...run, env: read(path.join(repoDir, 'api/.env')), rules: read(path.join(tmp, 'woodshed-rules.md')), left: fs.existsSync(path.join(home, '.config/woodshed/repo-settings.json')) };
}

test('a private session writes its env files and rules from repo settings, and logs keys and sizes, never a value', async () => {
  const fake = await fakeConsole([{ json: ANSWER }]);
  const run = await start({ consoleUrl: fake.url, env: { API_ENV: 'AUTH_DOMAIN=legacy.test' } });
  assert.equal(run.status, 0, run.out);
  assert.deepEqual(fake.calls, [{ url: '/repo-settings', auth: 'Bearer session-token' }]);
  assert.match(run.out, /\[woodshed\] Repo settings fetched \(project: app, installation: api-env \(44 bytes\), personal: api-env \(20 bytes\), instructions: installation \(20 bytes\) personal \(26 bytes\), personal for: @octocat\)/);
  assert.match(run.out, /answer kept: 600/, 'the answer holds values: only the session\'s user reads it');
  assert.match(run.out, /\[woodshed\] Env files written \(api\/\.env \(layers: repo installation personal session, defaults: 1, installation: 44 bytes, personal: 20 bytes, replaced by the session: none\)\)/);
  assert.match(run.out, /\[woodshed\] Instructions added to the rules \(installation: 20 bytes, personal: 26 bytes/);
  assert.equal(run.env, '# From the repo (.woodshed/project.yaml)\nLOG_LEVEL=info\n\n# From this installation\nAUTH_DOMAIN=installation.test\nLOG_LEVEL=warn\n\n'
    + '# Your own lines, from My settings\nLOG_LEVEL=debug-mine\n\n# Woodshed overrides\nDB_PASSWORD=session-password\n');
  assert.match(run.rules, /Run `make check` before every push\.[\s\S]*# This installation's instructions for acme\/app\nUse pnpm, never npm\.\n\n# @octocat's own instructions for acme\/app\nAnswer in short sentences\.\n\n# Which instructions win\n/);
  assert.ok(run.rules.endsWith('Where they do not disagree, follow all of them.\n'));
  for (const value of VALUES) assert.ok(!run.out.includes(value), `${value} is not in the log`);
  assert.equal(run.left, false);
});

test('a shared session gets the installation\'s layer alone, whatever the answer says', async () => {
  const fake = await fakeConsole([{ json: { ...ANSWER, personalFor: null } }]);
  const run = await start({ consoleUrl: fake.url, kind: 'shared' });
  assert.equal(run.status, 0, run.out);
  assert.match(run.out, /personal: none, instructions: installation \(20 bytes\), personal for: none/);
  assert.match(run.out, /Instructions added to the rules \(installation: 20 bytes, personal: none, added: /);
  assert.doesNotMatch(run.env, /Your own lines|debug-mine/);
  assert.doesNotMatch(run.rules, /octocat's own|short sentences/);
  assert.match(run.rules, /# This installation's instructions for acme\/app\nUse pnpm/);
});

test('an empty installation value falls back to the legacy secret, with a warning; the rules are then as before', async () => {
  const fake = await fakeConsole([{ json: { project: 'app', envFiles: {}, instructions: { installation: null, personal: null }, personalFor: null } }]);
  const run = await start({ consoleUrl: fake.url, kind: 'shared', env: { API_ENV: 'AUTH_DOMAIN=legacy.test' } });
  assert.equal(run.status, 0, run.out);
  assert.match(run.out, /\[woodshed\] WARNING: api\/\.env from the legacy env file secret api-env: set it on Console settings → Repos/);
  assert.match(run.env, /^# From the repo \(\.woodshed\/project\.yaml\)\nLOG_LEVEL=info\n\n# From this installation\nAUTH_DOMAIN=legacy\.test\n/);
  assert.doesNotMatch(run.out, /Instructions added/);
  assert.doesNotMatch(run.rules, /Which instructions win/);
});

test('an older console answers 404: the session writes its env files from the legacy secrets as before', async () => {
  const fake = await fakeConsole([{ status: 404, json: { error: 'not found' } }]);
  const run = await start({ consoleUrl: fake.url, env: { API_ENV: 'AUTH_DOMAIN=legacy.test', OWN_FILES: JSON.stringify({ 'api-env': 'MINE=1' }) } });
  assert.equal(run.status, 0, run.out);
  assert.match(run.out, /\[woodshed\] Repo settings not offered by the console, using the legacy env files/);
  assert.match(run.out, /answer kept: no/);
  assert.match(run.out, /Env files written \(api\/\.env \(base: 23 bytes, defaults: 1, own lines\)\)/, 'the log line from before repo settings');
  assert.doesNotMatch(run.out, /WARNING/);
  assert.match(run.env, /AUTH_DOMAIN=legacy\.test/);
});

test('a 503 is tried again, and a refusal stops the start with the console\'s reason', async () => {
  const flaky = await fakeConsole([{ status: 503, json: { error: 'store down' } }, { status: 503, json: { error: 'store down' } }, { json: ANSWER }]);
  const ok = await start({ consoleUrl: flaky.url });
  assert.equal(ok.status, 0, ok.out);
  assert.equal(flaky.calls.length, 3);
  const refused = await fakeConsole([{ status: 401, json: { error: 'no active session has that token' } }]);
  const no = await start({ consoleUrl: refused.url });
  assert.equal(no.status, 1, no.out);
  assert.match(no.out, /ERROR: could not get the repo settings from the console \(status 401\): no active session has that token/);
  assert.equal(refused.calls.length, 1, 'a 4xx is not tried again');
  assert.equal(no.left, false);
});

test('an ask session, and a session with no console, ask for no repo settings', async () => {
  const fake = await fakeConsole([{ json: ANSWER }]);
  const ask = await start({ consoleUrl: fake.url, mode: 'ask', kind: 'shared' });
  assert.equal(ask.status, 0, ask.out);
  const none = await start({ consoleUrl: null, kind: 'shared' });
  assert.equal(none.status, 0, none.out);
  assert.equal(fake.calls.length, 0);
  assert.doesNotMatch(ask.out + none.out, /Repo settings/);
});

test('runSession fetches the repo settings with the owner\'s, and deletes them once the env files and the rules are written', () => {
  const body = fn('runSession');
  const at = (step) => {
    const i = body.indexOf(`\n  ${step}\n`);
    assert.ok(i >= 0, `${step} is a step of runSession`);
    return i;
  };
  assert.ok(at('fetchOwnerSettings') < at('fetchRepoSettings') && at('fetchRepoSettings') < at('progress settings'));
  assert.ok(at('writeEnvFiles') < at('writeRules') && at('writeRules') < at('rm -f "$REPO_SETTINGS_JSON"'));
  assert.ok(body.indexOf('configureCodex') < at('rm -f "$REPO_SETTINGS_JSON"'), 'codex\'s AGENTS.md is a copy of the rules with the instructions');
  assert.doesNotMatch(fn('runAsk'), /RepoSettings/);
});
