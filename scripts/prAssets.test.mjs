import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.join(import.meta.dirname, 'prAssets.sh');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// A clone whose origin reads as github.com/acme/app but pushes to a bare repository on disk.
function cloneWithOrigin(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-assets-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bare = path.join(dir, 'origin.git');
  const repo = path.join(dir, 'repo');
  git(dir, 'init', '-q', '--bare', bare);
  git(dir, 'init', '-q', '-b', 'master', repo);
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
  git(repo, 'config', `url.${bare}.insteadOf`, 'https://github.com/acme/app.git');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-q', '-m', 'first');
  fs.writeFileSync(path.join(repo, 'README.md'), 'edited, not staged\n');
  return { dir, bare, repo };
}

function image(dir, name, bytes) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

function run(repo, ...args) {
  return spawnSync('bash', [SCRIPT, ...args], { cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
}

test('it pushes images to a pr-assets branch, prints their URLs, and leaves the checkout alone', (t) => {
  const { dir, bare, repo } = cloneWithOrigin(t);
  const before = image(dir, 'before.png', 'before');
  const after = image(dir, 'after.png', 'after');
  const statusBefore = git(repo, 'status', '--porcelain');
  const headBefore = git(repo, 'rev-parse', 'HEAD');

  const first = run(repo, '12-rail-card', `before.png=${before}`, `after.png=${after}`);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(first.stdout.trim().split('\n'), [
    'https://github.com/acme/app/blob/pr-assets/12-rail-card/before.png?raw=true',
    'https://github.com/acme/app/blob/pr-assets/12-rail-card/after.png?raw=true',
  ]);
  assert.deepEqual(git(bare, 'ls-tree', '--name-only', 'pr-assets/12-rail-card').split('\n').sort(), ['after.png', 'before.png']);
  assert.equal(git(bare, 'show', 'pr-assets/12-rail-card:before.png'), 'before');
  assert.equal(git(repo, 'status', '--porcelain'), statusBefore, 'the working tree and the index are as they were');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), headBefore);
  assert.equal(git(repo, 'branch', '--list'), '* master', 'no local branch is made');

  const replaced = image(dir, 'after2.png', 'after, again');
  const extra = image(dir, 'detail.png', 'detail');
  const second = run(repo, '12-rail-card', `after.png=${replaced}`, `detail.png=${extra}`);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(git(bare, 'ls-tree', '--name-only', 'pr-assets/12-rail-card').split('\n').sort(), ['after.png', 'before.png', 'detail.png']);
  assert.equal(git(bare, 'show', 'pr-assets/12-rail-card:after.png'), 'after, again', 'a name used again is replaced');
  assert.equal(git(bare, 'rev-list', '--count', 'pr-assets/12-rail-card'), '2', 'a second run adds a commit on top');
});

test('it refuses a missing file or a pair without a name, and pushes nothing', (t) => {
  const { dir, bare, repo } = cloneWithOrigin(t);
  const missing = run(repo, '3-x', `shot.png=${path.join(dir, 'nope.png')}`);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Expected <name>=<existing file>/);
  assert.equal(run(repo, '3-x', image(dir, 'a.png', 'a')).status, 1);
  assert.equal(run(repo, '3-x').status, 1, 'no image at all');
  assert.equal(git(bare, 'branch', '--list'), '');
});

test('it reads owner/repo from an ssh origin too', (t) => {
  const { dir, bare, repo } = cloneWithOrigin(t);
  git(repo, 'remote', 'set-url', 'origin', 'git@github.com:acme/app.git');
  git(repo, 'config', `url.${bare}.insteadOf`, 'git@github.com:acme/app.git');
  const result = run(repo, '4-ssh', `a.png=${image(dir, 'a.png', 'a')}`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'https://github.com/acme/app/blob/pr-assets/4-ssh/a.png?raw=true');
});
