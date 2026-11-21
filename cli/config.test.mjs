import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createCliSignIn } from '../console/cliSignIn.mjs';
import { createHandler } from '../console/server.mjs';
import { createUserSettings } from '../console/userSettings.mjs';
import { CONFIG_KEYS } from './config.mjs';
import { createCredentials } from './credentials.mjs';
import { EXIT, main } from './woodshed.mjs';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// A console's real handler, command line sign-in and My settings (userSettings.mjs) over a secret store that keeps
// nothing. mia-dev has a Claude token saved and GitHub connected unless the test says otherwise; the command line is
// signed in as her. `asked` is every path the command line called after it signed in.
async function consoleFor(t, { claudeToken = true, github = true } = {}) {
  const record = {
    ...(claudeToken ? { claudeTokenAt: '2026-11-01T00:00:00.000Z' } : {}),
    ...(github ? { github: { connectedAt: '2026-11-01T00:00:00.000Z', name: 'Mia Dev', email: 'mia@example.com' } } : {}),
  };
  const store = { state: { people: { 'mia-dev': record } }, save() {} };
  const secrets = { read: async () => null, save: async () => {}, remove: async () => {}, configured: () => true };
  const userSettings = createUserSettings({ store, secrets });
  const cli = createCliSignIn({ store: { state: {}, save() {} } });
  let saved = null;
  const projects = [{ name: 'app', repo: 'acme/app' }, { name: 'tools', repo: 'acme/tools' }];
  const projectAccess = {
    view: async () => ({ projects, defaultProject: saved ?? 'app', saved: Boolean(saved) }),
    forStart: async (login, name) => projects.find((p) => p.name === (name ?? 'app')) ?? null,
    setDefault: async (login, name) => {
      if (!projects.some((p) => p.name === name)) return null;
      saved = name;
      return projectAccess.view(login);
    },
  };
  const auth = { enabled: () => true, available: () => true, sessionFor: async () => null, canWrite: async () => true };
  const config = { host: '127.0.0.1', publicUrl: 'http://pending', extraHosts: [], repo: 'acme/app', label: 'woodshed', maxRunning: 5, limits: { idleMs: 1, lifetimeMs: 1 } };
  const handle = createHandler({ config, fleet: { sessions: () => [], find: () => null }, auth, cli, userSettings, projectAccess, viewPrefs: { view: () => null } });
  const server = http.createServer((req, res) => { handle(req, res); });
  const port = await listen(server);
  t.after(() => server.close());
  const origin = `http://localhost:${port}`;
  config.publicUrl = origin;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-cli-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const credentials = createCredentials({ platform: 'test', dir: path.join(dir, 'woodshed') });
  const asked = [];
  const run = async (args, { signedIn = true } = {}) => {
    let out = '';
    let err = '';
    const code = await main(args, {
      env: { XDG_CONFIG_HOME: signedIn ? dir : path.join(dir, 'nobody') }, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } },
      sleep: async () => {}, hostname: 'mia-laptop', platform: 'test', credentials,
      fetch: (url, init) => {
        asked.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
        return fetch(url, init);
      },
      openBrowser: (url) => { cli.decide({ code: new URL(url).searchParams.get('code'), login: 'mia-dev', approve: true }); },
    });
    return { code, out, err, lines: out.trim().split('\n').filter(Boolean).map((l) => (l.startsWith('{') ? JSON.parse(l) : l)) };
  };
  const signed = await run(['login', '--console', origin]);
  assert.equal(signed.code, EXIT.done, signed.err);
  asked.length = 0;
  return { origin, run, asked, userSettings };
}

test('config list and get print the person\'s choices, and --json gives every key', async (t) => {
  const c = await consoleFor(t);
  const listed = await c.run(['config', 'list']);
  assert.equal(listed.code, EXIT.done, listed.err);
  assert.match(listed.out, /^terminal {13}tmux\n/);
  assert.match(listed.out, /\nclaude-token-shared {2}on\n/);
  assert.match(listed.out, /\ndefault-repo {9}app\n/);
  assert.match(listed.out, /\ngithub-email {9}mia@example\.com\n$/);

  const json = await c.run(['config', 'list', '--json']);
  assert.deepEqual(json.lines, [{
    console: c.origin,
    config: { terminal: 'tmux', reviews: 'default', 'codex-reviews': 'off', 'claude-token-shared': 'on', 'default-repo': 'app', 'github-name': 'Mia Dev', 'github-email': 'mia@example.com' },
  }]);
  assert.deepEqual(Object.keys(json.lines[0].config), Object.keys(CONFIG_KEYS));

  assert.equal((await c.run(['config', 'get', 'github-name'])).out, 'Mia Dev\n', 'the bare value, for a script');
  assert.deepEqual((await c.run(['config', 'get', 'reviews', '--json'])).lines, [{ key: 'reviews', value: 'default' }]);
  assert.deepEqual(c.asked, Array(4).fill('GET /api/cli/config'));
});

test('config set changes a choice through the page\'s route, and says when it reaches only new sessions', async (t) => {
  const c = await consoleFor(t);
  const terminal = await c.run(['config', 'set', 'terminal', 'herdr']);
  assert.equal(terminal.code, EXIT.done, terminal.err);
  assert.equal(terminal.out, 'terminal is herdr. Your next private session starts in it; running ones keep theirs.\n');
  assert.equal(c.userSettings.terminal('mia-dev'), 'herdr');
  assert.deepEqual(c.asked, ['GET /api/cli/config', 'POST /api/my/terminal']);
  const again = await c.run(['config', 'set', 'terminal', 'herdr', '--json']);
  assert.deepEqual([again.lines[0].event, again.lines[0].value, again.lines[0].changed, again.lines[0].note], ['set', 'herdr', false, undefined], 'nothing changed, so nothing to say about new sessions');

  assert.equal((await c.run(['config', 'set', 'reviews', 'codex'])).code, EXIT.done);
  assert.equal(c.userSettings.reviewAgents('mia-dev'), 'codex');
  const reviews = await c.run(['config', 'set', 'reviews', 'default', '--json']);
  assert.equal(reviews.lines[0].value, 'default');
  assert.equal(c.userSettings.reviewAgents('mia-dev'), null, 'default is the console\'s null: the most there is');

  assert.equal((await c.run(['config', 'set', 'claude-token-shared', 'off'])).out, 'claude-token-shared is off. It applies to each shared session you start or resume from now on; running ones keep theirs.\n');
  assert.equal(c.userSettings.usesOwnTokenForShared('mia-dev'), false);

  const repo = await c.run(['config', 'set', 'default-repo', 'acme/tools', '--json']);
  assert.equal(repo.code, EXIT.done, repo.err);
  assert.equal(repo.lines[0].value, 'tools', 'owner/name, as session new\'s --repo takes it, saved as the console\'s name');
  assert.equal((await c.run(['config', 'set', 'default-repo', 'app'])).out, 'default-repo is app.\n');

  assert.equal((await c.run(['config', 'set', 'github-name', 'Mia D.'])).out, 'github-name is Mia D.. Your next session commits with it.\n');
  assert.equal((await c.run(['config', 'set', 'github-email', '--', 'mia@example.org'])).code, EXIT.done);
  assert.deepEqual(c.userSettings.gitIdentity('mia-dev'), { name: 'Mia D.', email: 'mia@example.org' }, 'the other half is kept');
});

test('an unknown key, a bad value or a secret exits 3 and says what is valid, and a secret is never sent', async (t) => {
  const c = await consoleFor(t);
  const unknown = await c.run(['config', 'set', 'colour', 'blue']);
  assert.equal(unknown.code, EXIT.refused);
  assert.match(unknown.err, /unknown key colour\. Keys: terminal, reviews, codex-reviews, claude-token-shared, default-repo, github-name, github-email/);

  const terminal = await c.run(['config', 'set', 'terminal', 'screen', '--json']);
  assert.equal(terminal.code, EXIT.refused);
  assert.deepEqual(terminal.lines, [{ event: 'error', status: 'refused', error: 'terminal cannot be screen: the terminal must be one of tmux, herdr. Valid: tmux, herdr' }], 'the console\'s own check');
  const reviews = await c.run(['config', 'set', 'reviews', 'everyone']);
  assert.equal(reviews.code, EXIT.refused);
  assert.match(reviews.err, /Valid: none, claude, codex, both, default/);
  const onOff = await c.run(['config', 'set', 'codex-reviews', 'yes']);
  assert.equal(onOff.code, EXIT.refused);
  assert.match(onOff.err, /codex-reviews cannot be yes\. Valid: on, off/);
  const repo = await c.run(['config', 'set', 'default-repo', 'acme/secret']);
  assert.equal(repo.code, EXIT.refused);
  assert.match(repo.err, /Valid: acme\/app, acme\/tools/);
  const email = await c.run(['config', 'set', 'github-email', 'not-an-email']);
  assert.equal(email.code, EXIT.refused);
  assert.match(email.err, /that is not an email address\. Valid: an email address/);

  c.asked.length = 0;
  for (const args of [['set', 'claude-token', 'sk-ant-oat01-x'], ['get', 'claude-token'], ['set', 'codex-auth', 'sk-x'], ['get', 'tmux-conf'], ['set', 'env', 'A=1']]) {
    const out = await c.run(['config', ...args]);
    assert.equal(out.code, EXIT.refused, args.join(' '));
    assert.match(out.err, new RegExp(`${args[1]} is a secret, or holds one: woodshed config never reads or sets one\\. Save it on My settings: ${c.origin}/settings`));
  }
  assert.deepEqual(c.asked, [], 'nothing was sent to the console');
});

test('a change My settings needs first exits 3 and points there; signed out exits 2', async (t) => {
  const c = await consoleFor(t, { claudeToken: false, github: false });
  assert.equal((await c.run(['config', 'get', 'claude-token-shared'])).out, 'off\n', 'a switch with no token saved has no effect');
  const shared = await c.run(['config', 'set', 'claude-token-shared', 'on']);
  assert.equal(shared.code, EXIT.refused);
  assert.equal(shared.err, `woodshed: save your Claude token first. On My settings: ${c.origin}/settings\n`);
  const codex = await c.run(['config', 'set', 'codex-reviews', 'on']);
  assert.equal(codex.code, EXIT.refused);
  assert.match(codex.err, /save your Codex sign-in first/);
  const name = await c.run(['config', 'set', 'github-name', 'Mia']);
  assert.equal(name.code, EXIT.refused);
  assert.match(name.err, /connect GitHub first/);
  assert.equal((await c.run(['config', 'get', 'github-name'])).out, '\n', 'none until GitHub is connected');

  const out = await c.run(['config', 'list', '--console', c.origin], { signedIn: false });
  assert.equal(out.code, EXIT.waiting);
  assert.match(out.out, /Not signed in/);
  assert.equal((await c.run(['config', 'set', 'terminal'])).code, EXIT.failed, 'a set with no value is a usage error');
  assert.match((await c.run(['config', '--help'])).out, /^Usage: woodshed config/);
});
