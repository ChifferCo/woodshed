import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { main } from './woodshed.mjs';

const origin = 'https://console.example';
const install = 'https://github.com/apps/woodshed-example/installations/new';

function cliFor(t, { status = 200, body, signedIn = true, isTerminal = true } = {}) {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-repo-cli-'));
  t.after(() => fs.rmSync(configHome, { recursive: true, force: true }));
  const dir = path.join(configHome, 'woodshed');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'cli.json'), JSON.stringify({ current: origin, consoles: { [origin]: { store: 'file' } } }));
  const opened = [];
  const requests = [];
  return {
    opened, requests,
    async run(...args) {
      let out = '';
      let err = '';
      const code = await main(['repo', ...args], {
        env: { XDG_CONFIG_HOME: configHome }, isTerminal,
        credentials: { storeFor: () => ({ read: () => signedIn ? 'test-token' : null }) },
        stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } },
        openBrowser: (url) => opened.push(url),
        fetch: async (url, { method, body: requestBody, headers }) => {
          requests.push({ url, method, body: requestBody && JSON.parse(requestBody) });
          assert.equal(headers.authorization, 'Bearer test-token');
          assert.equal(headers.origin, undefined);
          return Response.json(body, { status });
        },
      });
      return { code, out, err };
    },
  };
}

test('repo list reports connected and available repos in text and JSON', async (t) => {
  const list = {
    canChange: true,
    projects: [{ name: 'app', repo: 'acme/app', githubAppAccess: false }],
    available: [{ repo: 'acme/web', githubAppAccess: true }],
  };
  const c = cliFor(t, { body: list });
  const plain = await c.run('list');
  assert.equal(plain.code, 0);
  assert.match(plain.out, /acme\/app \(app\) · App has no access/);
  assert.match(plain.out, /acme\/web · App has access/);
  const json = await c.run('list', '--json');
  assert.deepEqual(JSON.parse(json.out), { event: 'repo-list', console: origin, ...list });
  assert.deepEqual(c.requests[0], { url: `${origin}/api/cli/repos`, method: 'GET', body: undefined });
});

test('repo add and remove send owner/name and report the saved name', async (t) => {
  const c = cliFor(t, { body: { repo: 'acme/web', name: 'tunnel' } });
  for (const [action, event, args] of [['add', 'repo-added', ['--name', 'tunnel']], ['remove', 'repo-removed', []]]) {
    const { code, out } = await c.run(action, 'acme/web', ...args, '--json');
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(out), { event, console: origin, repo: 'acme/web', name: 'tunnel' });
  }
  assert.deepEqual(c.requests, [
    { url: `${origin}/api/cli/repos`, method: 'POST', body: { repo: 'acme/web', name: 'tunnel' } },
    { url: `${origin}/api/cli/repos/remove`, method: 'POST', body: { repo: 'acme/web' } },
  ]);
});

test('GitHub App access exits 2, prints the link and retry, and opens only from a terminal with browser allowed', async (t) => {
  const options = { status: 409, body: { status: 'needs-github-app', error: 'Install the App on acme.', url: install } };
  const c = cliFor(t, options);
  const plain = await c.run('add', 'acme/web');
  assert.equal(plain.code, 2);
  assert.ok(plain.out.includes(install));
  assert.match(plain.out, /run woodshed repo add acme\/web again/);
  const json = await c.run('add', 'acme/web', '--json', '--no-browser');
  assert.equal(json.code, 2);
  assert.deepEqual(JSON.parse(json.out), { event: 'error', ...options.body, repo: 'acme/web' });
  assert.deepEqual(c.opened, [install]);
  const noTerminal = cliFor(t, { ...options, isTerminal: false });
  assert.equal((await noTerminal.run('add', 'acme/web')).code, 2);
  assert.deepEqual(noTerminal.opened, []);
  const untrusted = cliFor(t, { ...options, body: { ...options.body, url: 'https://github.com@elsewhere.example' } });
  const blocked = await untrusted.run('add', 'acme/web', '--json');
  assert.equal(JSON.parse(blocked.out).url, null);
  assert.deepEqual(untrusted.opened, []);
});

test('repo usage, permission refusals, sign-in and failures have distinct exit codes', async (t) => {
  const c = cliFor(t, { signedIn: false });
  assert.equal((await c.run('add', 'acme/web', '--extra')).code, 1);
  assert.equal((await c.run('remove', 'acme/web', '--name', 'web')).code, 1);
  assert.equal((await c.run('list')).code, 2);
  assert.equal(c.requests.length, 0);
  for (const [status, code, label] of [[400, 1, 'error'], [401, 2, 'signed-out'], [403, 3, 'refused'], [409, 3, 'refused'], [502, 1, 'error']]) {
    const other = cliFor(t, { status, body: { error: 'console reply' } });
    const output = await other.run('add', 'acme/web', '--name', 'tunnel', '--json');
    assert.equal(output.code, code);
    assert.equal(JSON.parse(output.out).status, label);
  }
});
