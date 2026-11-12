// A session's calls to the console while the console restarts, as it does for a few seconds on each redeploy: the
// calls safe to repeat wait for it, and a refusal (a 4xx) still fails at once. Against a real HTTP server standing in
// for the console, with the real curl, which is what the session image runs.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { withRetries } from './settingsSync.mjs';

const SESSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = fs.readFileSync(path.join(SESSION_DIR, 'entrypoint.sh'), 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-console-retries-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// The retries' 5 s pause, shortened so the test takes seconds; everything else is the script as it is written.
const fast = (text) => text.replaceAll('--retry-delay 5', '--retry-delay 1');

function fn(name) {
  const at = ENTRYPOINT.indexOf(`\n${name}() {`);
  assert.ok(at >= 0, `${name} is in entrypoint.sh`);
  return ENTRYPOINT.slice(at + 1, ENTRYPOINT.indexOf('\n}\n', at) + 2);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * The console's session API, away for `awayMs` after it is made: `refuse` is not listening yet (connection refused,
 * the box rebooting), `drop` takes each connection and closes it with no answer (`Empty reply from server`, what a
 * console being stopped gave). Then it answers `answer(req)`.
 */
async function fakeConsole({ away = 'drop', awayMs = 2_000, answer }) {
  const port = await freePort();
  const calls = [];
  const startedAt = Date.now();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const dropped = Date.now() - startedAt < awayMs;
      calls.push({ url: req.url, auth: req.headers.authorization, body, dropped });
      if (dropped) return req.socket.destroy();
      const { status = 200, json } = answer(req);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  const listen = () => server.listen(port, '127.0.0.1');
  if (away === 'refuse') setTimeout(listen, awayMs);
  else listen();
  after(() => server.close());
  return { url: `http://127.0.0.1:${port}`, calls };
}

function bash(script, env) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', script], { env: { PATH: process.env.PATH, ...env } });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    const startedAt = Date.now();
    child.on('close', (status) => resolve({ status, out, seconds: (Date.now() - startedAt) / 1000 }));
  });
}

const SETTINGS = { files: { 'api-env': 'OWN=1' }, ownFiles: {}, git: { name: 'Octo Cat', email: 'octo@example.com' }, database: null, claudeToken: 'sk-ant-oat-owner' };

function fetchOwnerSettings(consoleUrl) {
  const home = fs.mkdtempSync(path.join(TMP, 'home-'));
  const script = [
    'set -euo pipefail',
    'log() { echo "[woodshed] $*"; }',
    'die() { log "ERROR: $*"; exit 1; }',
    `SETTINGS_ANSWER=${home}/settings.json`,
    `OWN_CLAUDE_TOKEN_FILE=${home}/claude-token OWN_FILES_JSON=${home}/own-files.json OWN_CODEX_AUTH_FILE=${home}/codex-auth`,
    fast(fn('consoleCall')),
    fn('useDatabaseFrom'),
    fn('fetchOwnerSettings'),
    'fetchOwnerSettings',
    'echo "token: $(cat "$OWN_CLAUDE_TOKEN_FILE")"',
    'echo "answer left: $([ -e "$SETTINGS_ANSWER" ] && echo yes || echo no)"',
  ].join('\n');
  return bash(script, { HOME: home, SESSION_KIND: 'private', SESSION_TOKEN: 'session-token', WOODSHED_CONSOLE_URL: consoleUrl, STARTED_BY: 'octocat' });
}

for (const away of ['drop', 'refuse']) {
  test(`a private session gets its owner's settings from a console that ${away === 'drop' ? 'drops connections' : 'refuses connections'} while it restarts`, async () => {
    const fake = await fakeConsole({ away, answer: () => ({ json: SETTINGS }) });
    const run = await fetchOwnerSettings(fake.url);
    assert.equal(run.status, 0, run.out);
    assert.match(run.out, /Owner's settings fetched/);
    assert.match(run.out, /token: sk-ant-oat-owner/);
    assert.match(run.out, /answer left: no/, 'the answer, which holds the token, is deleted once read');
    const answered = fake.calls.filter((c) => !c.dropped);
    assert.equal(answered.length, 1);
    if (away === 'drop') assert.ok(fake.calls.some((c) => c.dropped), 'the console dropped the first tries');
    assert.ok(fake.calls.every((c) => c.auth === 'Bearer session-token'), 'every try carries the session token');
  });
}

test('a 409 from the console stops the start at once, with its reason', async () => {
  const fake = await fakeConsole({ awayMs: 0, answer: () => ({ status: 409, json: { error: '@octocat has no Claude token saved on My settings' } }) });
  const run = await fetchOwnerSettings(fake.url);
  assert.equal(run.status, 1, run.out);
  assert.match(run.out, /ERROR: could not get the owner's settings from the console \(status 409\): @octocat has no Claude token saved on My settings/);
  assert.equal(fake.calls.length, 1, 'a 4xx is not tried again');
  assert.ok(run.seconds < 1, `it failed at once (${run.seconds} s)`);
});

test('a console that stays away fails the start with status 000, once its retries ran out', async () => {
  const port = await freePort();
  const run = await fetchOwnerSettings(`http://127.0.0.1:${port}`);
  assert.equal(run.status, 1, run.out);
  assert.match(run.out, /ERROR: could not get the owner's settings from the console \(status 000\)/);
  assert.equal(run.out.match(/Failed to connect/g)?.length, 9, 'the first try and 8 more');
});

test('a 503 is tried again: a shared session\'s databases arrive once they are copied', async () => {
  let n = 0;
  const fake = await fakeConsole({ awayMs: 0, answer: () => (++n < 3 ? { status: 503, json: { error: 'still copying' } } : { json: { database: { user: 'u', password: 'p', name: 'woodshed__ab12cd34' } } }) });
  const home = fs.mkdtempSync(path.join(TMP, 'home-'));
  const script = [
    'set -euo pipefail', 'log() { echo "[woodshed] $*"; }', 'die() { log "ERROR: $*"; exit 1; }',
    'databases() { case "$1" in hosted) echo postgres ;; *) : ;; esac; }',
    `SETTINGS_ANSWER=${home}/settings.json DATABASE_WAIT_SECONDS=60`,
    fast(fn('consoleCall')), fn('useDatabaseFrom'), fn('fetchSessionDatabases'), 'fetchSessionDatabases',
  ].join('\n');
  const run = await bash(script, { HOME: home, SESSION_KIND: 'shared', SESSION_TOKEN: 't', WOODSHED_CONSOLE_URL: fake.url });
  assert.equal(run.status, 0, run.out);
  assert.match(run.out, /Session's databases fetched \(database: woodshed__ab12cd34/);
  assert.equal(fake.calls.length, 3);
});

// git's credential helper and gh's wrapper, so a push made during a redeploy waits for the console too.
const GITHUB_TOKEN_SH = fs.readFileSync(path.join(SESSION_DIR, 'githubToken.sh'), 'utf8');

function githubToken(consoleUrl) {
  const dir = fs.mkdtempSync(path.join(TMP, 'gh-'));
  return bash(fast(GITHUB_TOKEN_SH).replace('CACHE=/tmp/woodshed-github-token', `CACHE=${dir}/cache`), { SESSION_TOKEN: 't', WOODSHED_CONSOLE_URL: consoleUrl });
}

test('githubToken.sh waits out a console restart, and says a 409\'s reason at once', async () => {
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const fake = await fakeConsole({ answer: () => ({ json: { token: 'ghs_minted', expiresAt } }) });
  const run = await githubToken(fake.url);
  assert.equal(run.status, 0, run.out);
  assert.match(run.out, /ghs_minted/);
  assert.ok(fake.calls.some((c) => c.dropped));

  const refused = await fakeConsole({ awayMs: 0, answer: () => ({ status: 409, json: { error: 'connect GitHub again' } }) });
  const no = await githubToken(refused.url);
  assert.equal(no.status, 1, no.out);
  assert.match(no.out, /could not get a GitHub token \(status 409\): connect GitHub again/);
  assert.equal(refused.calls.length, 1);
});

test('the settings pull at start tries again while the console is away, and not after a refusal', async () => {
  let tries = 0;
  const away = async () => {
    tries += 1;
    if (tries < 3) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    if (tries < 4) throw Object.assign(new Error('the console answered 502'), { status: 502 });
    return { version: 3 };
  };
  assert.deepEqual(await withRetries(away, { delayMs: 1 }), { version: 3 });
  assert.equal(tries, 4);

  let refusedTries = 0;
  const refused = async () => { refusedTries += 1; throw Object.assign(new Error('the console answered 413'), { status: 413 }); };
  await assert.rejects(withRetries(refused, { delayMs: 1 }), /413/);
  assert.equal(refusedTries, 1);

  let gone = 0;
  await assert.rejects(withRetries(async () => { gone += 1; throw new Error('socket hang up'); }, { tries: 3, delayMs: 1 }), /hang up/);
  assert.equal(gone, 3);
});
