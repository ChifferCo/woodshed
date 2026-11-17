import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROXY = path.join(import.meta.dirname, 'qaBrowser.mjs');

// A stand-in for Playwright's MCP server: it answers each request, writes its "video" only when asked to close the
// browser (after a moment, as ffmpeg takes), and on stdin's end exits at once, as the real one does.
const FAKE_SERVER = `
const fs = require('node:fs');
const [log, video] = process.argv.slice(2);
let buf = '';
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    fs.appendFileSync(log, (msg.params?.name ?? msg.method) + '\\n');
    if (msg.params?.name === 'browser_close') {
      setTimeout(() => { fs.writeFileSync(video, 'whole'); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n'); }, 300);
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { echoed: msg.params?.name ?? msg.method } }) + '\\n');
    }
  }
});
process.stdin.on('end', () => { fs.appendFileSync(log, 'stdin ended\\n'); process.exit(0); });
`;

function start(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-browser-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const server = path.join(dir, 'server.cjs');
  fs.writeFileSync(server, FAKE_SERVER);
  const log = path.join(dir, 'log');
  const video = path.join(dir, 'video.webm');
  const proxy = spawn('node', [PROXY, 'node', server, log, video], { stdio: ['pipe', 'pipe', 'inherit'] });
  let out = '';
  proxy.stdout.on('data', (c) => { out += c; });
  const exited = new Promise((resolve) => proxy.on('exit', resolve));
  const send = (msg) => proxy.stdin.write(`${JSON.stringify(msg)}\n`);
  const lines = () => out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { proxy, send, lines, exited, log: () => fs.readFileSync(log, 'utf8').trim().split('\n'), video };
}

async function until(check) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
}

test('when claude goes, the proxy closes the browser and waits for it before letting the server exit', async (t) => {
  const { proxy, send, lines, exited, log, video } = start(t);
  send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_navigate' } });
  await until(() => lines().length === 1);
  assert.deepEqual(lines(), [{ jsonrpc: '2.0', id: 1, result: { echoed: 'browser_navigate' } }], 'claude\'s calls pass through');
  proxy.stdin.end();
  assert.equal(await exited, 0);
  assert.deepEqual(log(), ['browser_navigate', 'browser_close', 'stdin ended'], 'the server ends only after the close');
  assert.equal(fs.readFileSync(video, 'utf8'), 'whole');
  assert.equal(lines().length, 1, 'the close\'s answer is the proxy\'s own, never claude\'s');
});

test('a signal to claude\'s process group closes the browser the same way', async (t) => {
  const { proxy, send, lines, exited, log, video } = start(t);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  await until(() => lines().length === 1);
  proxy.kill('SIGTERM');
  await exited;
  assert.deepEqual(log(), ['initialize', 'browser_close', 'stdin ended']);
  assert.equal(fs.readFileSync(video, 'utf8'), 'whole');
});
