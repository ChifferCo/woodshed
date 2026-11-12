import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

const SCRIPT = path.join(import.meta.dirname, 'devConsole.mjs');

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startsAndServes(t, env) {
  const port = await freePort();
  const child = spawn(process.execPath, [SCRIPT, String(port)], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  t.after(() => child.kill());
  let sessions = null;
  for (let i = 0; i < 50 && sessions === null && child.exitCode === null; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    sessions = await fetch(`http://127.0.0.1:${port}/api/sessions`).then((r) => r.json()).catch(() => null);
  }
  assert.ok(sessions, `the dev console answered (stderr: ${stderr.slice(0, 300)})`);
  assert.ok((sessions.sessions ?? sessions).length > 0);
}

const SHELL = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('WOODSHED_')));

// CLAUDE.md proves console changes with it, so it must start with nothing set in the shell.
test('the dev console starts with no console settings and serves its sessions', (t) => startsAndServes(t, SHELL));

// A real console's settings in the shell, under either name, and a session's own variables, are left behind.
test('the dev console leaves the shell\'s console settings out, under the old names and the new', (t) => startsAndServes(t, {
  ...SHELL, WOODSHED_LAUNCHER: 'ecs', WOODSHED_CLOUD_LAUNCHER: 'ecs', WOODSHED_REQUIRE_SIGN_IN: '1', WOODSHED_CLOUD_REQUIRE_SIGN_IN: '1',
  WOODSHED_CLOUD_GITHUB_APP_ID: '1', WOODSHED_INSTALL_SECRETS: 'REGISTRY_TOKEN', WOODSHED_PROJECT_FILES_DIR: '/nowhere',
}));

function get(port, { host, method = 'GET', path: urlPath = '/api/sessions', headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: { host, ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

function startSessionApp(t, extraEnv) {
  return freePort().then((port) => {
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('WOODSHED_') && key !== 'SESSION_APP_DOMAIN')),
      DEV_CONSOLE_SESSION_APP: '1', SESSION_ID: 'abcd1234', ...extraEnv,
    };
    const child = spawn(process.execPath, [SCRIPT, String(port)], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    t.after(() => child.kill());
    return { port, child, stderr: () => stderr };
  });
}

async function firstAnswer(port, child, host) {
  let status = null;
  for (let i = 0; i < 50 && status !== 200 && child.exitCode === null; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    status = await get(port, { host }).catch(() => null);
  }
  return status;
}

// Woodshed's own app (scripts/devConsoleApp.sh) is reached through a session's app proxy, under the session's app name.
test('with DEV_CONSOLE_SESSION_APP=1 the dev console answers under the session\'s app name, and refuses other names and origins', async (t) => {
  const { port, child } = await startSessionApp(t, { SESSION_APP_DOMAIN: 'apps.example.com' });
  const host = 'abcd1234.apps.example.com';
  assert.equal(await firstAnswer(port, child, host), 200, 'a page under the app proxy\'s host name');
  assert.equal(await get(port, { host: 'ABCD1234.Apps.Example.com:443' }), 200, 'the same name in other case, with a port');
  assert.equal(await get(port, { host: `localhost:${port}` }), 200, 'a page on loopback, for the session\'s own browser');
  const write = { method: 'POST', path: '/api/sessions/aaaa1111/stop', headers: { 'x-woodshed': '1' } };
  assert.notEqual(await get(port, { host, ...write, headers: { ...write.headers, origin: `https://${host}` } }), 403, 'a write from its own page');
  assert.equal(await get(port, { host, ...write, headers: { ...write.headers, origin: 'https://evil.example' } }), 403, 'a write from another page');
  // A DNS-rebound page sends a Host and an Origin that agree, on a name that is not the session's.
  assert.equal(await get(port, { host: 'evil.example', ...write, headers: { ...write.headers, origin: 'http://evil.example' } }), 421);
  assert.equal(await get(port, { host: 'abcd1234.attacker.example', ...write, headers: { ...write.headers, origin: 'http://abcd1234.attacker.example' } }), 421, 'the session\'s id under another domain');
  assert.equal(await get(port, { host: 'abcd1234.apps.example.com.attacker.example' }), 421, 'the session\'s app name inside another domain');
  assert.equal(await get(port, { host: 'ffff0000.apps.example.com' }), 421, 'another session\'s app name');
  assert.equal(await upgradeStatus(port, 'abcd1234.attacker.example'), 421, 'a websocket under another domain');
});

// A new image under a console from before SESSION_APP_DOMAIN still opens its app.
test('with no SESSION_APP_DOMAIN the dev console lets in any name whose first label is the session id, and warns once', async (t) => {
  const { port, child, stderr } = await startSessionApp(t, {});
  assert.equal(await firstAnswer(port, child, 'abcd1234.apps.example.com'), 200);
  assert.equal(await get(port, { host: 'ffff0000.apps.example.com' }), 421, 'another session\'s app name');
  assert.equal(stderr().match(/no SESSION_APP_DOMAIN/g)?.length, 1);
});

function upgradeStatus(port, host) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
    });
    let data = '';
    socket.on('data', (d) => { data += d; });
    socket.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1] ?? 0)));
    socket.on('error', reject);
  });
}

test('DEV_CONSOLE_SESSION_APP=1 without a session id does not start', () => {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('WOODSHED_') && key !== 'SESSION_ID')), DEV_CONSOLE_SESSION_APP: '1' };
  const run = spawnSync(process.execPath, [SCRIPT, '0'], { env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /needs the session's SESSION_ID/);
});
