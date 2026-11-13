import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { summary, writeOwnFiles } from './ownFiles.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ownFiles.mjs');

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-own-files-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  git('init', '-q');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env*\nsecret\n');
  fs.mkdirSync(path.join(dir, 'app'));
  fs.writeFileSync(path.join(dir, 'app/.env.tracked'), 'tracked\n');
  git('add', '-f', '.gitignore', 'app/.env.tracked');
  return dir;
}

test('only files git ignores and does not track are written, readable by the session alone', (t) => {
  const dir = repo(t);
  fs.symlinkSync(os.tmpdir(), path.join(dir, 'secret'));
  fs.symlinkSync(path.join(dir, '..', `nowhere-${process.pid}`), path.join(dir, '.env.dangling'));
  const result = writeOwnFiles(dir, {
    'app/.env.production': 'NOTION_TOKEN=a\n',
    'new/dir/.env': 'X=1\n',
    'README.md': 'not ignored',
    'app/.env.tracked': 'would change a tracked file',
    'secret/x': 'through a symlink out of the repo',
    '../escape': 'up',
    'app/.env.number': 42,
    '.env.dangling': 'through a symlink to nowhere',
  });
  assert.deepEqual(result.written, ['app/.env.production', 'new/dir/.env']);
  assert.deepEqual(Object.fromEntries(result.skipped.map(({ file, why }) => [file, why])), {
    'README.md': 'git does not ignore it',
    'app/.env.tracked': 'git tracks it',
    'secret/x': 'a folder on its path leads out of the repo',
    '../escape': 'not a path in the repo',
    'app/.env.number': 'not text',
    '.env.dangling': 'it is a symlink in the checkout',
  });
  assert.equal(fs.existsSync(path.join(dir, '..', `nowhere-${process.pid}`)), false);
  assert.equal(fs.readFileSync(path.join(dir, 'app/.env.production'), 'utf8'), 'NOTION_TOKEN=a\n');
  assert.equal(fs.statSync(path.join(dir, 'app/.env.production')).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(dir, 'app/.env.tracked'), 'utf8'), 'tracked\n', 'the tracked file is as it was');
  assert.equal(fs.existsSync(path.join(os.tmpdir(), 'x')) && fs.readFileSync(path.join(os.tmpdir(), 'x'), 'utf8') === 'through a symlink out of the repo', false);
  assert.match(summary(result), /^written: app\/\.env\.production, new\/dir\/\.env, skipped: README\.md \(git does not ignore it\)/);
});

test('the command deletes the JSON it read, says what it did, and exits 3 when it skipped one', (t) => {
  const dir = repo(t);
  const json = path.join(dir, '..', `own-files-${process.pid}.json`);
  fs.writeFileSync(json, JSON.stringify({ '.env.local': 'A=1', 'README.md': 'x' }));
  const run = spawnSync('node', [SCRIPT, 'write', dir, json], { encoding: 'utf8' });
  assert.equal(run.status, 3);
  assert.equal(run.stdout, 'written: .env.local, skipped: README.md (git does not ignore it)');
  assert.equal(fs.existsSync(json), false, 'the person\'s secrets are not left in the JSON');
  assert.equal(fs.readFileSync(path.join(dir, '.env.local'), 'utf8'), 'A=1');
});
