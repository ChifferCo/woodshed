import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { createCodeEditor, editorArgs } from './codeEditor.mjs';

function listening(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// A stand-in openvscode-server: answers on the --port it is given, writes a line for each start, and its pid, since
// exec keeps the shell's.
async function fakeEditor(dir, { exits = false } = {}) {
  const bin = path.join(dir, 'openvscode-server');
  const body = exits ? 'exit 3' : `echo started >> '${path.join(dir, 'starts')}'
echo $$ > '${path.join(dir, 'pid')}'
exec node -e "require('http').createServer((q, r) => r.end('editor')).listen(Number(process.argv[1]), '127.0.0.1')" "$4"`;
  await fs.writeFile(bin, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  return bin;
}

test('editorArgs serves the editor under /__woodshed/code on loopback, on the checkout, with no token of its own', () => {
  const args = editorArgs({ port: 7688, repoDir: '/work/repo' });
  assert.deepEqual(args.slice(0, 6), ['--host', '127.0.0.1', '--port', '7688', '--server-base-path', '/__woodshed/code']);
  assert.ok(args.includes('--without-connection-token'));
  assert.equal(args[args.indexOf('--default-folder') + 1], '/work/repo');
});

test('ensure starts the editor once, for requests that arrive together, and waits until it answers', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'code-editor-'));
  const port = await freePort();
  const editor = createCodeEditor({ bin: await fakeEditor(dir), port, repoDir: dir, listening, logFile: path.join(dir, 'log') });
  t.after(async () => {
    const pid = Number(await fs.readFile(path.join(dir, 'pid'), 'utf8').catch(() => ''));
    if (pid) process.kill(pid);
  });

  assert.deepEqual(await Promise.all([editor.ensure(), editor.ensure(), editor.ensure()]), [true, true, true]);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'editor');
  assert.equal(await editor.ensure(), true);
  editor.forget();
  assert.equal(await editor.ensure(), true, 'found answering again, not started twice');
  assert.equal((await fs.readFile(path.join(dir, 'starts'), 'utf8')).trim().split('\n').length, 1);
});

test('ensure is false when the image has no editor, or it exits before answering', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'code-editor-'));
  const port = await freePort();
  const none = createCodeEditor({ bin: path.join(dir, 'missing'), port, repoDir: dir, listening });
  assert.equal(await none.ensure(), false);
  const exits = createCodeEditor({ bin: await fakeEditor(dir, { exits: true }), port, repoDir: dir, listening, logFile: path.join(dir, 'log'), timeoutMs: 5000 });
  const started = Date.now();
  assert.equal(await exits.ensure(), false);
  assert.ok(Date.now() - started < 4000, 'gives up when the process exits, not at the timeout');
});

test('ensure uses an editor already answering on the port, without starting another', async (t) => {
  const server = http.createServer((req, res) => res.end('already'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const editor = createCodeEditor({ bin: '/nonexistent', port: server.address().port, repoDir: '/', listening });
  assert.equal(await editor.ensure(), true);
});
