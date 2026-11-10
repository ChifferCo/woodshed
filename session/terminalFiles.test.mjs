import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { imageFor, saveUpload, scrollPane, uploadName } from './terminalFiles.mjs';

test('an upload is saved under its own name, and refused whole past the limit or empty', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'woodshed-uploads-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const saved = await saveUpload(Readable.from([Buffer.from('hello')]), { name: '../../etc/My Shot.PNG', dir });
  assert.equal(path.dirname(saved.path), dir);
  assert.match(path.basename(saved.path), /^\d{8}T\d{6}-[0-9a-f]{4}-My-Shot\.png$/);
  assert.equal(await fs.readFile(saved.path, 'utf8'), 'hello');

  await assert.rejects(saveUpload(Readable.from([Buffer.alloc(6)]), { name: 'big.bin', dir, maxBytes: 5 }), /over/);
  await assert.rejects(saveUpload(Readable.from([]), { name: 'empty.txt', dir }), /empty/);
  assert.deepEqual(await fs.readdir(dir), [path.basename(saved.path)], 'nothing left of the refused ones');
  assert.match(uploadName('notes.sh;rm -rf'), /-notes\.txt$/, 'an odd extension becomes txt');
});

test('a picture is served only from the repo, the uploads or the scratchpad, and only as a picture', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'woodshed-images-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repoDir = path.join(root, 'repo');
  const uploadsDir = path.join(root, 'uploads');
  const outside = path.join(root, 'outside');
  for (const d of [repoDir, uploadsDir, outside]) await fs.mkdir(d);
  await fs.writeFile(path.join(repoDir, 'shot.png'), 'png');
  await fs.writeFile(path.join(repoDir, 'page.html'), 'html');
  await fs.writeFile(path.join(outside, 'secret.png'), 'png');
  await fs.symlink(path.join(outside, 'secret.png'), path.join(repoDir, 'link.png'));
  await fs.symlink(path.join(repoDir, 'page.html'), path.join(repoDir, 'fake.png'));
  const opts = { repoDir, uploadsDir, home: root, tmpDir: root };

  assert.equal(imageFor('shot.png', opts)?.mime, 'image/png', 'relative to the repo');
  assert.equal(imageFor(path.join(repoDir, 'shot.png'), opts)?.file, path.join(repoDir, 'shot.png'));
  assert.equal(imageFor(path.join(outside, 'secret.png'), opts), null);
  assert.equal(imageFor('../outside/secret.png', opts), null);
  assert.equal(imageFor('link.png', opts), null, 'a link out of the roots');
  assert.equal(imageFor('fake.png', opts), null, 'a .png that is really a page');
  assert.equal(imageFor('page.html', opts), null);
});

test('a swipe sends wheel bytes to claude, copy mode to a shell, and nothing at the bottom', async () => {
  const calls = [];
  const tmux = (display) => async (cmd, args) => {
    calls.push(args);
    return { stdout: args[0] === 'display' ? display : '' };
  };
  assert.equal(await scrollPane(tmux('1 0'), { steps: -2, pane: 'agent' }), 'mouse');
  assert.deepEqual(calls.at(-1), ['send-keys', '-t', 'claude', '-l', '\x1b[<64;1;1M\x1b[<64;1;1M']);
  assert.equal(await scrollPane(tmux('0 0'), { steps: -3, pane: 'terminal' }), 'copy-mode');
  assert.deepEqual(calls.slice(-2), [['copy-mode', '-e', '-t', 'shell'], ['send-keys', '-t', 'shell', '-X', '-N', '3', 'scroll-up']]);
  calls.length = 0;
  assert.equal(await scrollPane(tmux('0 0'), { steps: 5, pane: 'terminal' }), 'bottom');
  assert.equal(calls.length, 1, 'only the probe');
  assert.equal(await scrollPane(tmux('1 0'), { steps: 900 }), 'mouse');
  assert.equal(calls.at(-1)[4].length, 40 * '\x1b[<65;1;1M'.length, 'capped at 40 notches');
  await assert.rejects(scrollPane(tmux('1 0'), { steps: 0 }), /steps/);
  await assert.rejects(scrollPane(tmux('1 0'), { steps: 1, pane: 'claude-aaaa' }), /pane must be/);
});
