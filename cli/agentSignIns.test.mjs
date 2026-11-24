import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createCliSignIn } from '../console/cliSignIn.mjs';
import { cliMayCall } from '../console/cliSessions.mjs';
import { createProjectAccess } from '../console/projectAccess.mjs';
import { createHandler } from '../console/server.mjs';
import { createUserSettings } from '../console/userSettings.mjs';
import { createViewPrefs } from '../console/viewPrefs.mjs';
import { readSignInFile, shownFile, signInFile } from './agentSignIns.mjs';
import { createCredentials } from './credentials.mjs';
import { EXIT, main } from './woodshed.mjs';

const GROK_MARKER = 'GROKSECRETMARKER0123456789';
const OPENCODE_MARKER = 'OPENCODESECRETMARKER0123456789';
const GROK_LOGIN = { default: { key: GROK_MARKER, refresh: `${GROK_MARKER}-refresh` } };
const OPENCODE_LOGIN = { anthropic: { type: 'api', key: OPENCODE_MARKER } };

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// A console's real handler, command line sign-in and My settings over an in-memory secret store, with two people on it.
// The command line is signed in as mia-dev, in a home of the test's own holding made-up sign-in files.
// `standIn(method, pathname, init)`: a Response in place of the console's own answer, for a gateway or another console.
async function consoleFor(t, { standIn = () => null } = {}) {
  const store = { state: { people: { 'mia-dev': { claudeTokenAt: '2026-11-01T00:00:00.000Z' }, 'ola-dev': {} } }, save() {} };
  const saved = new Map();
  const secrets = {
    read: async (name) => saved.get(name) ?? null, save: async (name, value) => { saved.set(name, value); },
    remove: async (name) => { saved.delete(name); }, configured: () => true,
  };
  const userSettings = createUserSettings({ store, secrets });
  const cli = createCliSignIn({ store: { state: {}, save() {} } });
  const projects = [{ name: 'app', repo: 'acme/app', default: true }];
  const auth = { enabled: () => true, available: () => true, sessionFor: async () => null, canWrite: async () => true };
  const config = { host: '127.0.0.1', publicUrl: 'http://pending', extraHosts: [], repo: 'acme/app', projects, label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const viewPrefs = createViewPrefs(store);
  const projectAccess = createProjectAccess({ config, githubFor: () => auth, viewPrefs });
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth, cli, userSettings, projectAccess, viewPrefs });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const origin = `http://localhost:${port}`;
  config.publicUrl = origin;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-cli-signin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const credentials = createCredentials({ platform: 'test', dir: path.join(dir, 'woodshed') });
  const asked = [];
  const run = async (args) => {
    let out = '';
    let err = '';
    const code = await main(args, {
      env: { XDG_CONFIG_HOME: dir }, home, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } },
      sleep: async () => {}, hostname: 'mia-laptop', platform: 'test', credentials,
      fetch: (url, init) => {
        asked.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
        return standIn(init?.method ?? 'GET', new URL(url).pathname, init) ?? fetch(url, init);
      },
      openBrowser: (url) => { cli.decide({ code: new URL(url).searchParams.get('code'), login: 'mia-dev', approve: true }); },
    });
    assert.doesNotMatch(out + err, new RegExp(`${GROK_MARKER}|${OPENCODE_MARKER}`), 'never prints the file\'s content');
    return { code, out, err, lines: out.trim().split('\n').filter(Boolean).map((l) => (l.startsWith('{') ? JSON.parse(l) : l)) };
  };
  const signed = await run(['login', '--console', origin]);
  assert.equal(signed.code, EXIT.done, signed.err);
  asked.length = 0;
  const write = (rel, text) => {
    const file = path.join(home, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { mode: 0o600 });
  };
  const token = credentials.storeFor(JSON.parse(fs.readFileSync(path.join(dir, 'woodshed', 'cli.json'), 'utf8')).consoles[origin].store).read(origin);
  return { origin, run, asked, saved, home, write, userSettings, token };
}

// Each log line the console writes while `fn` runs, as its text and fields.
async function logged(fn) {
  const lines = [];
  const was = console.log;
  console.log = (...args) => { lines.push(args); };
  try {
    await fn();
  } finally {
    console.log = was;
  }
  return lines;
}

test('sign-in push saves this computer\'s file as the token\'s own person\'s sign-in, and nobody else\'s', async (t) => {
  const c = await consoleFor(t);
  c.write('.grok/auth.json', `${JSON.stringify(GROK_LOGIN, null, 2)}\n`);
  c.write('.local/share/opencode/auth.json', JSON.stringify(OPENCODE_LOGIN));
  let grok;
  const log = await logged(async () => { grok = await c.run(['sign-in', 'push', 'grok', '--console', c.origin]); });
  assert.equal(grok.code, EXIT.done, grok.err);
  assert.equal(grok.out, `Saved your Grok Build sign-in on ${c.origin}, from ${path.join('~', '.grok', 'auth.json')}. Your next Grok Build session uses it.\n`);
  assert.deepEqual(c.asked, ['GET /api/cli/me', 'POST /api/my/agent-auth/grok']);
  assert.equal(c.saved.get('users/mia-dev/grok-auth'), JSON.stringify(GROK_LOGIN), 'saved as compact JSON, as My settings saves it');
  assert.deepEqual([...c.saved.keys()].filter((name) => name.startsWith('users/ola-dev/')), [], 'never another person\'s');
  assert.equal(c.userSettings.view('mia-dev').agentAuth.grok.set, true);
  assert.equal(c.userSettings.view('ola-dev').agentAuth.grok.set, false);
  const call = log.find(([text]) => text === 'cliSessions: call');
  assert.equal(call?.[1].login, 'mia-dev');
  assert.equal(call?.[1].path, '/api/my/agent-auth/grok');
  assert.ok(log.some(([text, fields]) => text === 'userSettings: Grok Build sign-in saved' && fields.login === 'mia-dev'));
  assert.doesNotMatch(JSON.stringify(log), new RegExp(GROK_MARKER), 'the console logs no value either');

  const opencode = await c.run(['sign-in', 'push', 'opencode', '--json', '--console', c.origin]);
  assert.equal(opencode.code, EXIT.done, opencode.err);
  const [entry] = opencode.lines;
  assert.deepEqual({ ...entry, savedAt: typeof entry.savedAt }, {
    event: 'sign-in', agent: 'opencode', file: path.join(c.home, '.local', 'share', 'opencode', 'auth.json'), console: c.origin,
    saved: true, replaced: false, savedAt: 'string',
  });
  assert.equal(c.saved.get('users/mia-dev/opencode-auth'), JSON.stringify(OPENCODE_LOGIN));
});

test('sign-in push replaces a saved sign-in only with --replace', async (t) => {
  const c = await consoleFor(t);
  c.write('.grok/auth.json', JSON.stringify(GROK_LOGIN));
  await c.userSettings.setAgentAuth('mia-dev', 'grok', 'xai-0123456789abcdefghij');
  const kept = await c.run(['sign-in', 'push', 'grok', '--console', c.origin]);
  assert.equal(kept.code, EXIT.refused);
  assert.match(kept.err, /has a Grok Build sign-in of yours saved already\. Nothing was sent: add --replace/);
  assert.ok(!c.asked.includes('POST /api/my/agent-auth/grok'));
  assert.equal(c.saved.get('users/mia-dev/grok-auth'), 'xai-0123456789abcdefghij');

  const replaced = await c.run(['sign-in', 'push', 'grok', '--replace', '--console', c.origin]);
  assert.equal(replaced.code, EXIT.done, replaced.err);
  assert.match(replaced.out, /^Replaced your Grok Build sign-in/);
  assert.equal(c.saved.get('users/mia-dev/grok-auth'), JSON.stringify(GROK_LOGIN));
});

test('sign-in push refuses a malformed or missing file here, and sends nothing', async (t) => {
  const c = await consoleFor(t);
  c.write('.grok/auth.json', `{"default": "${GROK_MARKER}"}`);
  const bad = await c.run(['sign-in', 'push', 'grok', '--console', c.origin]);
  assert.equal(bad.code, EXIT.refused);
  assert.match(bad.err, new RegExp(`${escaped(path.join('~', '.grok', 'auth.json'))} is not a Grok Build sign-in: that is not a Grok Build auth\\.json: run grok login, then paste ~/\\.grok/auth\\.json\\. Nothing was sent\\.`));
  c.write('.local/share/opencode/auth.json', `not json ${OPENCODE_MARKER}`);
  const badJson = await c.run(['sign-in', 'push', 'opencode', '--json', '--console', c.origin]);
  assert.equal(badJson.code, EXIT.refused);
  assert.equal(badJson.lines[0].status, 'refused');
  assert.deepEqual(c.asked, [], 'not even asked who is signed in');

  fs.rmSync(path.join(c.home, '.grok'), { recursive: true });
  const missing = await c.run(['sign-in', 'push', 'grok', '--console', c.origin]);
  assert.equal(missing.code, EXIT.waiting);
  assert.match(missing.err, new RegExp(`No Grok Build sign-in on this computer: ${escaped(path.join('~', '.grok', 'auth.json'))} is not there\\. Run grok login first\\.`));
  assert.deepEqual(c.saved.size, 0);
});

test('the command line\'s token reaches the sign-in save alone: never its removal, and never from a page', async (t) => {
  assert.ok(cliMayCall('POST', '/api/my/agent-auth/grok'));
  assert.ok(cliMayCall('POST', '/api/my/agent-auth/opencode'));
  for (const [method, pathname] of [['POST', '/api/my/agent-auth/grok/remove'], ['POST', '/api/my/agent-auth/claude'], ['GET', '/api/my/agent-auth/grok'], ['POST', '/api/my/codex-auth'], ['POST', '/api/my/claude-token']]) {
    assert.equal(cliMayCall(method, pathname), false, `${method} ${pathname}`);
  }
  const c = await consoleFor(t);
  await c.userSettings.setAgentAuth('mia-dev', 'grok', 'xai-0123456789abcdefghij');
  const post = (pathname, headers = {}) => fetch(`${c.origin}${pathname}`, {
    method: 'POST', headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ value: 'xai-abcdefghij0123456789' }),
  });
  const removed = await post('/api/my/agent-auth/grok/remove');
  assert.equal(removed.status, 403);
  assert.equal(c.saved.get('users/mia-dev/grok-auth'), 'xai-0123456789abcdefghij');
  const fromPage = await post('/api/my/agent-auth/grok', { origin: c.origin });
  assert.equal(fromPage.status, 403);
  assert.equal(c.saved.get('users/mia-dev/grok-auth'), 'xai-0123456789abcdefghij');
  // The answer says whether one is saved, and never the page's whole view or the value.
  const ok = await post('/api/my/agent-auth/grok');
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.deepEqual(Object.keys(body).sort(), ['agent', 'savedAt', 'set']);
  assert.equal(body.set, true);
  // The console's own check, as the page's: a value that is not a sign-in is refused with its words.
  const refused = await fetch(`${c.origin}/api/my/agent-auth/opencode`, {
    method: 'POST', headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ value: 'nope' }),
  });
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /paste the contents of ~\/\.local\/share\/opencode\/auth\.json/);
});

test('each agent\'s file is where the agent keeps it', () => {
  const home = path.join(path.sep, 'home', 'mia');
  assert.equal(signInFile('grok', { env: {}, home }), path.join(home, '.grok', 'auth.json'));
  assert.equal(signInFile('grok', { env: { GROK_HOME: path.join(path.sep, 'g') }, home }), path.join(path.sep, 'g', 'auth.json'));
  assert.equal(signInFile('grok', { env: { GROK_HOME: path.join(path.sep, 'g'), GROK_AUTH_PATH: path.join(path.sep, 'a.json') }, home }), path.join(path.sep, 'a.json'));
  assert.equal(signInFile('grok', { env: { GROK_HOME: '' }, home }), path.join(home, '.grok', 'auth.json'), 'an empty one is unset, as grok reads it');
  assert.equal(signInFile('opencode', { env: {}, home }), path.join(home, '.local', 'share', 'opencode', 'auth.json'));
  assert.equal(signInFile('opencode', { env: { XDG_DATA_HOME: path.join(path.sep, 'd') }, home }), path.join(path.sep, 'd', 'opencode', 'auth.json'));
  assert.equal(shownFile(path.join(home, '.grok', 'auth.json'), home), path.join('~', '.grok', 'auth.json'));
  assert.equal(shownFile(path.join(path.sep, 'd', 'x'), home), path.join(path.sep, 'd', 'x'));
  assert.deepEqual(readSignInFile('grok', { env: {}, home: path.join(os.tmpdir(), 'woodshed-no-such-home') }).found, false);
});

// A gateway, or a console other than Woodshed's, that answers the save with what it was sent: the command line says only
// its own words for the status, so none of the sign-in reaches the output, in text or in --json, however short it is.
test('sign-in push never repeats anything of the console\'s answer, so an echoed sign-in is never shown', async (t) => {
  let answer = null;
  const standIn = (method, pathname, init) => {
    if (method !== 'POST' || !pathname.startsWith('/api/my/agent-auth/') || !answer) return null;
    const { value } = JSON.parse(init.body);
    const [status, body] = answer(value);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  const c = await consoleFor(t);
  const echoing = await consoleFor(t, { standIn });
  // A short key, shorter than any run a check of the echo would look for, and a login.
  const SHORT = 'xai-shortkey12';
  echoing.write('.grok/auth.json', SHORT);
  echoing.write('.local/share/opencode/auth.json', JSON.stringify(OPENCODE_LOGIN));
  const never = (out, ...values) => {
    for (const v of values) assert.ok(!(out.out + out.err).includes(v), `${v.slice(0, 6)}… is never shown`);
  };
  const statuses = [[400, 'refused it (400). Its log says why; or save it on My settings.', EXIT.refused],
    [409, 'refused it (409). Its log says why; or save it on My settings.', EXIT.refused],
    [403, 'did not take it (403): a console from before the command line could save a sign-in. Save it on My settings.', EXIT.refused],
    [413, 'refused it (413): it is larger than the console takes. Save it on My settings.', EXIT.refused],
    [502, 'answered 502. Try again, or save it on My settings.', EXIT.failed]];
  for (const [status, words, code] of statuses) {
    // The key's part after `xai-`: shorter than a run a check of the echo would look for, and not the whole value.
    answer = (value) => [status, { error: `no: ${value.startsWith('xai-') ? value.slice(4) : value} \u001b[0m` }];
    const text = await echoing.run(['sign-in', 'push', 'grok', '--console', echoing.origin]);
    assert.equal(text.code, code, String(status));
    assert.equal(text.err.trim(), `woodshed: ${echoing.origin} ${words}`);
    never(text, SHORT.slice(4));
    const json = await echoing.run(['sign-in', 'push', 'opencode', '--json', '--console', echoing.origin]);
    assert.equal(json.code, code, `${status} --json`);
    assert.ok(JSON.stringify(json.lines).includes(words.replace(/\.$/, '')), `${status} --json says the command's words`);
    never(json, JSON.stringify(OPENCODE_LOGIN), OPENCODE_MARKER);
  }
  // A success that echoes it: savedAt is a timestamp or nothing.
  answer = (value) => [200, { agent: 'grok', set: true, savedAt: value }];
  const echoedOk = await echoing.run(['sign-in', 'push', 'grok', '--json', '--console', echoing.origin]);
  assert.equal(echoedOk.code, EXIT.done);
  assert.equal(echoedOk.lines[0].savedAt, null);
  never(echoedOk, SHORT);
  assert.equal(c.saved.size, 0);
});
