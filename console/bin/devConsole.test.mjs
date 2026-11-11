import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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

// CLAUDE.md proves console changes with it, so it must start with nothing set in the shell.
test('the dev console starts with no WOODSHED_CLOUD_* settings and serves its sessions', async (t) => {
  const port = await freePort();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('WOODSHED_')));
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
});

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

// Woodshed's own app (scripts/devConsoleApp.sh) is reached through a session's app proxy, under the session's app name.
test('with DEV_CONSOLE_ANY_HOST=1 the dev console answers under any host name, and still refuses another origin', async (t) => {
  const port = await freePort();
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('WOODSHED_'))), DEV_CONSOLE_ANY_HOST: '1' };
  const child = spawn(process.execPath, [SCRIPT, String(port)], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(() => child.kill());
  const host = 'abcd1234.apps.example.com';
  let status = null;
  for (let i = 0; i < 50 && status !== 200 && child.exitCode === null; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    status = await get(port, { host }).catch(() => null);
  }
  assert.equal(status, 200, 'a page under the app proxy\'s host name');
  const write = { method: 'POST', path: '/api/sessions/aaaa1111/stop', headers: { 'x-woodshed': '1' } };
  assert.notEqual(await get(port, { host, ...write, headers: { ...write.headers, origin: `https://${host}` } }), 403, 'a write from its own page');
  assert.equal(await get(port, { host, ...write, headers: { ...write.headers, origin: 'https://evil.example' } }), 403, 'a write from another page');
});
