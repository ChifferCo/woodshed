import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveTerminalImage } from './terminalImages.mjs';

const TYPES = new Map([['png', 'image/png'], ['jpg', 'image/jpeg']]);

// A fake home with one allowed root and a sibling that shares its prefix.
function makeTree() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-img-'));
  const root = path.join(home, 'app');
  const write = (rel, contents = 'x') => {
    const file = path.join(home, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    return file;
  };
  const resolve = (requested, cwd) => resolveTerminalImage({ requested, cwd, roots: [root], home, types: TYPES });
  return { home, root, write, resolve };
}

test('serves an image under a root, by absolute path or ~/', () => {
  const { write, resolve } = makeTree();
  const file = write('app/.playwright-mcp/qa/Shot.PNG');
  assert.deepEqual(resolve(file), { file, mime: 'image/png' });
  assert.deepEqual(resolve('~/app/.playwright-mcp/qa/Shot.PNG'), { file, mime: 'image/png' });
});

test('refuses anything outside the roots, however it is spelled', () => {
  const { home, write, resolve } = makeTree();
  write('secret.png');
  write('app-notes/shot.png');  // shares the root's prefix
  assert.equal(resolve(path.join(home, 'secret.png')), null);
  assert.equal(resolve(path.join(home, 'app', '..', 'secret.png')), null);
  assert.equal(resolve('~/app-notes/shot.png'), null);
  assert.equal(resolve('app/shot.png'), null);  // relative, with no session to resolve it against
  assert.equal(resolve('../secret.png', path.join(home, 'app')), null);
});

test('resolves a relative path against the session directory', () => {
  const { root, write, resolve } = makeTree();
  const file = write('app/.playwright-mcp/evt-qa-1.png');
  assert.deepEqual(resolve('.playwright-mcp/evt-qa-1.png', root), { file, mime: 'image/png' });
});

test('follows a symlink before deciding, and types the file by its target', () => {
  const { home, write, resolve } = makeTree();
  const secret = write('secret.png');
  const page = write('app/page.html');
  fs.mkdirSync(path.join(home, 'app', 'links'), { recursive: true });
  fs.symlinkSync(secret, path.join(home, 'app', 'links', 'out.png'));
  fs.symlinkSync(page, path.join(home, 'app', 'links', 'page.png'));
  assert.equal(resolve('~/app/links/out.png'), null);
  assert.equal(resolve('~/app/links/page.png'), null);
});

test('refuses a file that is not an image', () => {
  const { write, resolve } = makeTree();
  write('app/.env');
  write('app/notes.txt');
  assert.equal(resolve('~/app/.env'), null);
  assert.equal(resolve('~/app/notes.txt'), null);
  assert.equal(resolve('~/app/missing.png'), null);
});
