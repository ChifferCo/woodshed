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

const REF = 'refs/pr-assets/12-rail-card';

function urls(sha, ...names) {
  return names.map((name) => `https://github.com/acme/app/blob/${sha}/${name}?raw=true`);
}

test('it pushes images to a pr-assets ref, not a branch, prints their URLs, and leaves the checkout alone', (t) => {
  const { dir, bare, repo } = cloneWithOrigin(t);
  const before = image(dir, 'before.png', 'before');
  const after = image(dir, 'after.png', 'after');
  const statusBefore = git(repo, 'status', '--porcelain');
  const headBefore = git(repo, 'rev-parse', 'HEAD');

  const first = run(repo, '12-rail-card', `before.png=${before}`, `after.png=${after}`);
  assert.equal(first.status, 0, first.stderr);
  const sha = git(bare, 'rev-parse', REF);
  assert.deepEqual(first.stdout.trim().split('\n'), urls(sha, 'after.png', 'before.png'));
  assert.match(first.stderr, /A re-run gives new URLs/);
  assert.deepEqual(git(bare, 'ls-tree', '--name-only', REF).split('\n'), ['after.png', 'before.png']);
  assert.equal(git(bare, 'show', `${REF}:before.png`), 'before');
  assert.equal(git(bare, 'branch', '--list'), '', 'origin gets no branch');
  assert.equal(git(repo, 'status', '--porcelain'), statusBefore, 'the working tree and the index are as they were');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), headBefore);
  assert.equal(git(repo, 'branch', '--list'), '* master', 'no local branch is made');
});

test('a re-run replaces the ref with one parentless commit holding the latest set of images', (t) => {
  const { dir, bare, repo } = cloneWithOrigin(t);
  assert.equal(run(repo, '12-rail-card', `before.png=${image(dir, 'before.png', 'before')}`, `after.png=${image(dir, 'after.png', 'after')}`).status, 0);
  const firstSha = git(bare, 'rev-parse', REF);

  const second = run(repo, '12-rail-card', `after.png=${image(dir, 'after2.png', 'after, again')}`, `detail.png=${image(dir, 'detail.png', 'detail')}`);
  assert.equal(second.status, 0, second.stderr);
  const sha = git(bare, 'rev-parse', REF);
  assert.notEqual(sha, firstSha);
  assert.deepEqual(second.stdout.trim().split('\n'), urls(sha, 'after.png', 'before.png', 'detail.png'), 'every image gets a URL at the new commit');
  assert.deepEqual(git(bare, 'ls-tree', '--name-only', REF).split('\n'), ['after.png', 'before.png', 'detail.png']);
  assert.equal(git(bare, 'show', `${REF}:after.png`), 'after, again', 'a name used again is replaced');
  assert.equal(git(bare, 'rev-list', '--count', REF), '1', 'the old commit is not kept as a parent');
});

test('it refuses to overwrite a ref that moved since it read it', (t) => {
  const { dir, bare, repo } = cloneWithOrigin(t);
  assert.equal(run(repo, '12-rail-card', `a.png=${image(dir, 'a.png', 'a')}`).status, 0);
  const sha = git(bare, 'rev-parse', REF);
  // A wrapper git whose ls-remote reports a stale sha, standing in for another run that pushed in between.
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const realGit = execFileSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!/usr/bin/env bash\nif [ "$1" = ls-remote ]; then echo "${'0'.repeat(39)}1\t$3"; exit 0; fi\nexec ${realGit} "$@"\n`, { mode: 0o755 });
  const raced = spawnSync('bash', [SCRIPT, '12-rail-card', `b.png=${image(dir, 'b.png', 'b')}`], {
    cwd: repo,
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME },
  });
  assert.notEqual(raced.status, 0);
  assert.match(raced.stderr, /stale info/);
  assert.equal(git(bare, 'rev-parse', REF), sha, 'the ref is left as the other run pushed it');
});

test('it refuses a missing file or a pair without a name, and pushes nothing', (t) => {
  const { dir, bare, repo } = cloneWithOrigin(t);
  const missing = run(repo, '3-x', `shot.png=${path.join(dir, 'nope.png')}`);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Expected <name>=<existing file>/);
  assert.equal(run(repo, '3-x', image(dir, 'a.png', 'a')).status, 1);
  assert.equal(run(repo, '3-x').status, 1, 'no image at all');
  assert.equal(git(bare, 'for-each-ref'), '', 'nothing is pushed');
});

test('it reads owner/repo from an ssh origin too', (t) => {
  const { dir, bare, repo } = cloneWithOrigin(t);
  git(repo, 'remote', 'set-url', 'origin', 'git@github.com:acme/app.git');
  git(repo, 'config', `url.${bare}.insteadOf`, 'git@github.com:acme/app.git');
  const result = run(repo, '4-ssh', `a.png=${image(dir, 'a.png', 'a')}`);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), urls(git(bare, 'rev-parse', 'refs/pr-assets/4-ssh'), 'a.png'));
});
