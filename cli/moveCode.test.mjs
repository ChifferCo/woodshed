import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkoutOf, deleteBranch, freeze, githubRepo, gitRunner, pushBranch, secretName, secretsIn, survey } from './moveCode.mjs';
import { repoFor } from './moveFixtures.mjs';

const GIT_ENV = { GIT_AUTHOR_NAME: 'Mia', GIT_AUTHOR_EMAIL: 'mia@example.com', GIT_COMMITTER_NAME: 'Mia', GIT_COMMITTER_EMAIL: 'mia@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

test('a GitHub remote is read as owner/name in each way git says it, and another host is none', () => {
  for (const url of ['https://github.com/acme/app.git', 'https://github.com/acme/app', 'git@github.com:acme/app.git', 'ssh://git@github.com/acme/app.git', 'https://x-access-token:abc@github.com/acme/app.git']) {
    assert.equal(githubRepo(url), 'acme/app', url);
  }
  assert.equal(githubRepo('https://gitlab.com/acme/app.git'), null);
  assert.equal(githubRepo('/tmp/app.git'), null);
});

test('secrets are found by name and by content, said by kind and line, and an example env file is not one', () => {
  assert.equal(secretName('.env'), 'an env file');
  assert.equal(secretName('services/api/.env.production'), 'an env file');
  assert.equal(secretName('.env.example'), null);
  assert.equal(secretName('certs/server.pem'), 'a key file');
  assert.equal(secretName('home/.ssh/id_ed25519'), 'an SSH private key');
  assert.equal(secretName('id_ed25519.pub'), null);
  assert.equal(secretName('config/credentials.json'), 'a credentials file');
  assert.equal(secretName('src/index.js'), null);
  const key = ['-----BEGIN OPENSSH PRIVATE', 'KEY-----'].join(' ');
  assert.deepEqual(secretsIn(`a\n${key}\nb`), [{ line: 2, kind: 'a private key' }]);
  assert.deepEqual(secretsIn(`const k = "AKIA${'Q'.repeat(16)}";`), [{ line: 1, kind: 'an AWS access key' }]);
  assert.deepEqual(secretsIn(`token: ghp_${'a1'.repeat(18)}`), [{ line: 1, kind: 'a GitHub token' }]);
  assert.deepEqual(secretsIn(`//registry.npmjs.org/:_authToken=${'x'.repeat(20)}`), [{ line: 1, kind: 'an npm token' }]);
  assert.deepEqual(secretsIn('//registry.npmjs.org/:_authToken=${NPM_TOKEN}'), [], 'a variable is no token');
  const aws = `AKIA${'Q'.repeat(16)}`;
  assert.deepEqual(secretsIn(`x ${aws}\ny`, `old ${aws}`), [], 'one the commit already held is not the move\'s doing');
});

test('the work is frozen from a temporary index: untracked files in, ignored ones out, and the person\'s index, branch and files untouched', async (t) => {
  const { root, sh, git } = repoFor(t);
  fs.writeFileSync(path.join(root, 'README.md'), '# app, changed\n');
  fs.writeFileSync(path.join(root, 'services', 'api', 'new.js'), 'new file\n');
  fs.writeFileSync(path.join(root, 'staged.txt'), 'staged\n');
  sh(['add', 'staged.txt'], root);
  fs.writeFileSync(path.join(root, '.env'), 'DATABASE_URL=postgres://local\n');
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules', 'x.js'), '');
  const statusBefore = sh(['status', '--porcelain'], root);
  const indexBefore = fs.readFileSync(path.join(root, '.git', 'index'));

  const checkout = await checkoutOf(git, path.join(root, 'services', 'api'));
  assert.equal(checkout.repo, 'acme/app');
  assert.equal(checkout.subdir, 'services/api');
  assert.equal(checkout.remote, 'origin');
  assert.equal(checkout.branch, 'main');
  const found = await survey(git, checkout, { tag: 'test' });
  t.after(() => fs.rmSync(path.dirname(found.index), { recursive: true, force: true }));
  assert.deepEqual(found.files.map((f) => `${f.status} ${f.path}`).sort(), ['A services/api/new.js', 'A staged.txt', 'M README.md']);
  assert.deepEqual(found.secrets, []);
  assert.deepEqual(found.ignoredEnv, ['.env'], 'the ignored env file is named, so the person knows it stays');
  const commit = await freeze(git, checkout, { tree: found.tree, message: 'woodshed move test' });
  const pushed = await pushBranch(git, checkout, { commit, branch: 'woodshed/move-test' });
  assert.deepEqual(pushed, { ok: true });

  assert.equal(sh(['rev-parse', 'refs/heads/main'], root), checkout.head, 'the branch did not move');
  assert.equal(sh(['status', '--porcelain'], root), statusBefore, 'the files and the index are as they were');
  assert.ok(fs.readFileSync(path.join(root, '.git', 'index')).equals(indexBefore), 'the person\'s index is not rewritten');
  const onGithub = sh(['--git-dir', path.join(path.dirname(root), 'github.git'), 'ls-tree', '-r', '--name-only', 'woodshed/move-test'], root).split('\n');
  assert.deepEqual(onGithub.sort(), ['.gitignore', 'README.md', 'services/api/index.js', 'services/api/new.js', 'staged.txt']);
  assert.equal(sh(['--git-dir', path.join(path.dirname(root), 'github.git'), 'log', '-1', '--format=%P %s', 'woodshed/move-test'], root), `${checkout.head} woodshed move test`);

  assert.equal(await deleteBranch(git, checkout, 'woodshed/move-test'), true);
  assert.throws(() => sh(['--git-dir', path.join(path.dirname(root), 'github.git'), 'rev-parse', '--verify', 'woodshed/move-test'], root));
});

test('nothing changed freezes as HEAD itself, a secret is found in a new file and in a changed one, and a refused push says why', async (t) => {
  const { root, bare, sh, git } = repoFor(t);
  const checkout = await checkoutOf(git, root);
  const clean = await survey(git, checkout, { tag: 'test' });
  t.after(() => fs.rmSync(path.dirname(clean.index), { recursive: true, force: true }));
  assert.equal(await freeze(git, checkout, { tree: clean.tree, message: 'x' }), checkout.head);

  fs.writeFileSync(path.join(root, 'deploy.key'), 'whatever\n');
  fs.appendFileSync(path.join(root, 'README.md'), `aws: AKIA${'Z'.repeat(16)}\n`);
  const dirty = await survey(git, checkout, { tag: 'test' });
  t.after(() => fs.rmSync(path.dirname(dirty.index), { recursive: true, force: true }));
  assert.deepEqual(dirty.secrets, [{ path: 'README.md', line: 2, kind: 'an AWS access key' }, { path: 'deploy.key', line: null, kind: 'a key file' }]);
  assert.ok(!JSON.stringify(dirty.secrets).includes('AKIA'), 'never the value');

  // GitHub refusing the push: a hook on the bare repo, as a protected branch or a rule would.
  fs.writeFileSync(path.join(bare, 'hooks', 'pre-receive'), '#!/bin/sh\necho "pushes are refused here" >&2\nexit 1\n', { mode: 0o755 });
  const refused = await pushBranch(git, checkout, { commit: checkout.head, branch: 'woodshed/move-x' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /pre-receive hook declined|refused/);
  assert.equal(sh(['rev-parse', 'HEAD'], root), checkout.head);
});

test('a folder outside a checkout, or a checkout with no GitHub remote, is said plainly', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-move-nogit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = gitRunner({ env: { ...process.env, ...GIT_ENV, GIT_CEILING_DIRECTORIES: path.dirname(dir) } });
  assert.match((await checkoutOf(git, dir)).error, /is not in a git checkout/);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  assert.match((await checkoutOf(git, dir)).error, /has no remote/);
  execFileSync('git', ['remote', 'add', 'origin', 'https://mia:hunter2@gitlab.com/acme/app.git'], { cwd: dir });
  const error = (await checkoutOf(git, dir)).error;
  assert.match(error, /is not a GitHub repo/);
  assert.ok(!error.includes('hunter2'), 'a password in the URL is not printed');
});
