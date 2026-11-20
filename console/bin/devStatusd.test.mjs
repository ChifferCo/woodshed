import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import { statusdReady } from './devStatusd.mjs';

const run = (code) => spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });

test('a statusd that says it listens is ready', async (t) => {
  const child = run("console.log('statusd: listening', { port: 1 }); setTimeout(() => {}, 5000)");
  t.after(() => child.kill());
  await statusdReady(child);
});

test('a statusd that exits before it listens is a failed start, with what it wrote', async () => {
  // As one that lost its port to another process between the probe and its own listen.
  const child = run("console.error('Error: listen EADDRINUSE: address already in use 127.0.0.1:4000'); process.exit(1)");
  await assert.rejects(statusdReady(child), /statusd exited before it listened \(code 1\):\n.*EADDRINUSE/);
});

test('a statusd that says nothing in time is a failed start, not a wait for ever', async (t) => {
  const child = run('setTimeout(() => {}, 5000)');
  t.after(() => child.kill());
  await assert.rejects(statusdReady(child, { ms: 300 }), /did not listen within 0.3 s/);
});

test('a statusd that cannot be spawned is a failed start', async () => {
  const child = spawn('/nonexistent/statusd', [], { stdio: ['ignore', 'pipe', 'pipe'] });
  await assert.rejects(statusdReady(child), /statusd did not start: .*ENOENT/);
});
