import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defaultBranchOf } from './defaultBranch.mjs';

function repo(t, branch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'default-branch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' });
  git('init', '-q', '-b', branch);
  git('commit', '-q', '--allow-empty', '-m', 'empty');
  return { dir, git };
}

test('DEFAULT_BRANCH is believed first', (t) => {
  assert.equal(defaultBranchOf(repo(t, 'main').dir, { DEFAULT_BRANCH: 'trunk' }), 'trunk');
});

test('otherwise it is what origin/HEAD points at, whatever the name', (t) => {
  const { dir, git } = repo(t, 'develop');
  git('update-ref', 'refs/remotes/origin/develop', 'HEAD');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
  assert.equal(defaultBranchOf(dir, {}), 'develop');
});

test('with no origin/HEAD it is the one of main and master the remote has, and null when neither', (t) => {
  const main = repo(t, 'x');
  main.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  assert.equal(defaultBranchOf(main.dir, {}), 'main');
  const master = repo(t, 'x');
  master.git('update-ref', 'refs/remotes/origin/master', 'HEAD');
  assert.equal(defaultBranchOf(master.dir, {}), 'master');
  assert.equal(defaultBranchOf(repo(t, 'x').dir, {}), null);
});
