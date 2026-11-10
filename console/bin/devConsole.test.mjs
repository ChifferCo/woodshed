import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
