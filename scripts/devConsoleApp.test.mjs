import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.join(import.meta.dirname, 'devConsoleApp.sh');

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function run(home, port, command) {
  return spawnSync('bash', [SCRIPT, command], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, DEV_CONSOLE_PORT: String(port), SESSION_ID: 'abcd1234' }, timeout: 60_000,
  });
}

// What statusd's Start app and Stop app run for Woodshed's own app (.woodshed/project.yaml).
test('start leaves the dev console answering under a session app name, with its log written; stop stops it', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-console-app-'));
  const port = await freePort();
  t.after(() => {
    run(home, port, 'stop');
    fs.rmSync(home, { recursive: true, force: true });
  });

  const started = run(home, port, 'start');
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /up at http:\/\/localhost:\d+\/s\/aaaa1111/);
  const page = await fetch(`http://127.0.0.1:${port}/s/aaaa1111`, { headers: { host: 'abcd1234.apps.example.com' } });
  assert.equal(page.status, 200);
  // readyGate tells the app was started by this log having something in it.
  assert.ok(fs.statSync(path.join(home, '.cache/woodshed-dev-console/console.log')).size > 0);

  const again = run(home, port, 'start');
  assert.equal(again.status, 0);
  assert.match(again.stdout, /already answers/);

  const stopped = run(home, port, 'stop');
  assert.equal(stopped.status, 0, stopped.stderr);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`));
  assert.match(run(home, port, 'stop').stdout, /no dev console started/);
});
