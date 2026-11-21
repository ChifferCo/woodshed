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
  assert.deepEqual(secretsIn(`x ${aws} AKIA${'N'.repeat(16)}`, `old ${aws}`), [{ line: 1, kind: 'an AWS access key' }], 'a new one beside it is new');
});

test('credential headers distinguish literals from references and placeholders', () => {
  const options = { credentialHeaders: true };
  const inputs = [
    'curl -H "Authorization: Bearer $TOKEN"',
    'Authorization: Bearer <token>',
    'interface Request { authorization: string; }',
    JSON.stringify({ content: 'const headers = {\n  Authorization: token\n};' }),
    JSON.stringify({ content: 'interface Request {\n  authorization: string;\n  cookie?: string;\n}' }),
    'const headers = { authorization: token, cookie: req.headers.cookie };',
    'const headers = { authorization: getToken() };',
    'Authorization: process.env.API_TOKEN',
    '{"cookie":"Cookie preferences","headers":{"Authorization":"Bearer ${token}"}}',
    'Cookie: session=$SESSION',
    'curl -H "Cookie: theme=${THEME}" -H "Cookie: session=$SESSION"',
  ];
  for (const input of inputs) assert.deepEqual(secretsIn(input, '', options), [], input);
  for (const input of ['Authorization: Basic abc=', 'X-Api-Key: abc', 'Cookie: theme=$THEME; session=abc==']) {
    assert.deepEqual(secretsIn(input, '', options), [{ line: 1, kind: 'a credential header' }]);
    assert.deepEqual(secretsIn(input, input, options), []);
  }
  const digest = (response) => `Authorization: Digest username="fixture", response="${response}"`;
  assert.deepEqual(secretsIn(digest('new-inert-response'), digest('old-inert-response'), options), [
    { line: 1, kind: 'a credential header' },
  ]);
  assert.deepEqual(secretsIn('Cookie: theme=${THEME}; session=abc==', '', options), [{ line: 1, kind: 'a credential header' }]);
  assert.deepEqual(secretsIn('Cookie: session=cookie:inert-fixture', '', options), [{ line: 1, kind: 'a credential header' }]);
});

test('embedded JSON inspection allows ordinary tool output and refuses when decoding exceeds its budget', () => {
  let output = JSON.stringify({ headers: { Accept: 'application/json' }, note: 'x'.repeat(4096) });
  output = JSON.stringify({ stdout: output });
  assert.deepEqual(secretsIn(output, '', { credentialHeaders: true }), []);
  for (let layer = 0; layer < 7; layer++) output = JSON.stringify({ stdout: output });
  assert.deepEqual(secretsIn(output, '', { credentialHeaders: true }), [
    { line: 1, kind: 'embedded JSON exceeds the credential scan budget' },
  ]);
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
  const commit = await freeze(git, checkout, { tree: found.tree, message: 'woodshed move --from herdr test' });
  const pushed = await pushBranch(git, checkout, { commit, branch: 'woodshed/move-test' });
  assert.deepEqual(pushed, { ok: true });

  assert.equal(sh(['rev-parse', 'refs/heads/main'], root), checkout.head, 'the branch did not move');
  assert.equal(sh(['status', '--porcelain'], root), statusBefore, 'the files and the index are as they were');
  assert.ok(fs.readFileSync(path.join(root, '.git', 'index')).equals(indexBefore), 'the person\'s index is not rewritten');
  const onGithub = sh(['--git-dir', path.join(path.dirname(root), 'github.git'), 'ls-tree', '-r', '--name-only', 'woodshed/move-test'], root).split('\n');
  assert.deepEqual(onGithub.sort(), ['.gitignore', 'README.md', 'services/api/index.js', 'services/api/new.js', 'staged.txt']);
  assert.equal(sh(['--git-dir', path.join(path.dirname(root), 'github.git'), 'log', '-1', '--format=%P %s', 'woodshed/move-test'], root), `${checkout.head} woodshed move --from herdr test`);

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

test('what the push would send is looked through: a secret in a commit not pushed yet, though a later one took it out, and a log too large to read', async (t) => {
  const { root, sh, git } = repoFor(t);
  const token = `ghp_${'b2'.repeat(18)}`;
  fs.writeFileSync(path.join(root, 'config.js'), `module.exports = "${token}";\n`);
  sh(['add', 'config.js'], root);
  sh(['commit', '-q', '-m', 'add config'], root);
  fs.writeFileSync(path.join(root, 'config.js'), 'module.exports = process.env.TOKEN;\n');
  sh(['commit', '-q', '-am', 'take the token out'], root);
  const checkout = await checkoutOf(git, root);
  const found = await survey(git, checkout, { tag: 'test' });
  t.after(() => fs.rmSync(path.dirname(found.index), { recursive: true, force: true }));
  assert.deepEqual(found.secrets, [{ path: 'config.js', line: 1, kind: 'a GitHub token' }], 'the earlier commit would be pushed with it');
  assert.deepEqual(found.files, [], 'the working tree itself is clean');

  sh(['push', '-q', 'origin', 'main'], root);
  sh(['fetch', '-q', 'origin'], root);
  const pushed = await survey(git, await checkoutOf(git, root), { tag: 'test' });
  t.after(() => fs.rmSync(path.dirname(pushed.index), { recursive: true, force: true }));
  assert.deepEqual(pushed.secrets, [], 'once GitHub has that commit, the move adds nothing to it');

  fs.writeFileSync(path.join(root, 'debug.log'), `${'line\n'.repeat(400)}${token}\n`);
  const big = await survey(git, await checkoutOf(git, root), { tag: 'test', scanBytes: 1000 });
  t.after(() => fs.rmSync(path.dirname(big.index), { recursive: true, force: true }));
  assert.deepEqual(big.secrets, [{ path: 'debug.log', line: null, kind: 'file too large to check for secrets (1 MB)' }]);
  fs.writeFileSync(path.join(root, 'debug.log'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.alloc(5000, 7)]));
  const binary = await survey(git, await checkoutOf(git, root), { tag: 'test', scanBytes: 1000 });
  t.after(() => fs.rmSync(path.dirname(binary.index), { recursive: true, force: true }));
  assert.deepEqual(binary.secrets, [{ path: 'debug.log', line: null, kind: 'file too large to check for secrets (1 MB)' }]);
});

test('outgoing trees are screened for credential names even when the blob is known or has several names', async (t) => {
  const { root, sh, git } = repoFor(t);
  const known = `ghp_${'e1'.repeat(18)}`;
  const duplicate = `AKIA${'E'.repeat(16)}`;
  const directory = `fixture-${known}`;
  fs.mkdirSync(path.join(root, directory));
  // The directory name goes out even though the README bytes already exist on the destination.
  sh(['mv', 'README.md', `${directory}/moved.md`], root);
  sh(['commit', '-qm', 'move the readme'], root);
  sh(['mv', `${directory}/moved.md`, 'README.md'], root);
  sh(['commit', '-qm', 'put the readme back'], root);
  // The ordinary path sorts first, so rev-list can omit the second name for this new blob.
  fs.writeFileSync(path.join(root, 'a-first.txt'), 'identical fixture bytes');
  fs.writeFileSync(path.join(root, `z-backup\n${duplicate}.txt`), 'identical fixture bytes');
  const result = await survey(git, await checkoutOf(git, root));
  t.after(() => fs.rmSync(path.dirname(result.index), { recursive: true, force: true }));
  assert.deepEqual(result.secrets.map((s) => s.kind).sort(), ['a GitHub token', 'an AWS access key']);
  assert.ok(result.secrets.every((s) => /^a name in Git tree [0-9a-f]{12}$/.test(s.path)));
  assert.deepEqual(result.files, [], 'refusal carries no offending paths');
  assert.ok(!JSON.stringify(result).includes(known) && !JSON.stringify(result).includes(duplicate));
});

test('a remote that pushes to more than one place is refused: the move pushes to the one repo it checked', async (t) => {
  const { root, sh, git } = repoFor(t);
  sh(['config', '--add', 'remote.origin.pushurl', 'https://github.com/acme/app.git'], root);
  sh(['config', '--add', 'remote.origin.pushurl', 'https://github.com/someone/mirror.git'], root);
  assert.match((await checkoutOf(git, root)).error, /remote origin pushes to 2 places, and the move pushes to one/);
});

test('a push rewritten to another repo is refused, and a branch deleted on GitHub does not hide what it held', async (t) => {
  const { root, sh, git, bare } = repoFor(t);
  sh(['config', 'url.https://github.com/someone/mirror.git.pushInsteadOf', 'https://github.com/acme/app.git'], root);
  assert.match((await checkoutOf(git, root)).error, /is acme\/app, but git pushes it to https:\/\/github\.com\/someone\/mirror\.git/);
  sh(['config', '--unset', 'url.https://github.com/someone/mirror.git.pushInsteadOf'], root);

  // A branch with a credential, pushed, then deleted on GitHub: this checkout's tracking ref for it lives on.
  const token = `ghp_${'c3'.repeat(18)}`;
  sh(['checkout', '-q', '-b', 'old'], root);
  fs.writeFileSync(path.join(root, 'creds.js'), `module.exports = "${token}";\n`);
  sh(['add', 'creds.js'], root);
  sh(['commit', '-q', '-m', 'creds'], root);
  sh(['push', '-q', 'origin', 'old'], root);
  sh(['--git-dir', bare, 'branch', '-D', 'old'], root);
  assert.ok(sh(['rev-parse', 'refs/remotes/origin/old'], root), 'the stale tracking ref');
  fs.rmSync(path.join(root, 'creds.js'));
  sh(['commit', '-q', '-am', 'no creds'], root);
  const found = await survey(git, await checkoutOf(git, root), { tag: 'test' });
  t.after(() => fs.rmSync(path.dirname(found.index), { recursive: true, force: true }));
  assert.deepEqual(found.secrets, [{ path: 'creds.js', line: 1, kind: 'a GitHub token' }]);
});

test('what GitHub already has is asked of where the push goes, when it fetches from elsewhere', async (t) => {
  const { root, dir, sh, git } = repoFor(t);
  const token = `ghp_${'d4'.repeat(18)}`;
  fs.writeFileSync(path.join(root, 'creds.js'), `module.exports = "${token}";\n`);
  sh(['add', 'creds.js'], root);
  sh(['commit', '-q', '-m', 'creds'], root);
  sh(['push', '-q', 'origin', 'main'], root);
  // Pushes now go to a second, empty repo, which has never seen that commit; fetches still come from the first.
  const second = path.join(dir, 'second.git');
  sh(['init', '-q', '--bare', '-b', 'main', second], dir);
  sh(['config', `url.${second}.pushInsteadOf`, 'https://github.com/acme/app.git'], root);
  fs.rmSync(path.join(root, 'creds.js'));
  const found = await survey(git, await checkoutOf(git, root), { tag: 'test' });
  t.after(() => fs.rmSync(path.dirname(found.index), { recursive: true, force: true }));
  assert.deepEqual(found.secrets, [{ path: 'creds.js', line: 1, kind: 'a GitHub token' }]);
});

test('a token pasted into the message of a commit not pushed yet is found, said by the commit and never shown', async (t) => {
  const { root, sh, git } = repoFor(t);
  fs.writeFileSync(path.join(root, 'notes.md'), 'nothing secret\n');
  sh(['add', 'notes.md'], root);
  sh(['commit', '-q', '-m', 'wip', '-m', `token was xoxb-${'1'.repeat(12)}-abcdef`], root);
  const found = await survey(git, await checkoutOf(git, root), { tag: 'test' });
  t.after(() => fs.rmSync(path.dirname(found.index), { recursive: true, force: true }));
  const sha = sh(['rev-parse', 'HEAD'], root).slice(0, 12);
  assert.deepEqual(found.secrets, [{ path: `the message of commit ${sha}`, line: 3, kind: 'a Slack token' }]);
});

test('a UTF-16 text file is read for secrets, not skipped as binary', async (t) => {
  const { root, git } = repoFor(t);
  const text = `log line\nkey AKIA${'U'.repeat(16)}\n`;
  fs.writeFileSync(path.join(root, 'windows.log'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
  fs.writeFileSync(path.join(root, 'no-bom.log'), Buffer.from(text, 'utf16le'));
  const found = await survey(git, await checkoutOf(git, root), { tag: 'test' });
  t.after(() => fs.rmSync(path.dirname(found.index), { recursive: true, force: true }));
  assert.deepEqual(found.secrets.map((s) => `${s.path}:${s.line} ${s.kind}`).sort(), ['no-bom.log:2 an AWS access key', 'windows.log:2 an AWS access key']);
});

test('a push reached through a chain of url rewrites is refused', async (t) => {
  const { root, bare, sh, git } = repoFor(t);
  const url = 'https://github.com/acme/app.git';
  sh(['config', `url.${bare}.pushInsteadOf`, url], root);
  for (const rule of ['insteadOf', 'pushInsteadOf']) {
    const key = `url.https://github.com/someone/mirror.git.${rule}`;
    sh(['config', key, bare], root);
    assert.equal(sh(['remote', 'get-url', '--push', 'origin'], root), bare);
    assert.match((await checkoutOf(git, root)).error, /through more than one url rewrite/);
    sh(['config', '--unset', key], root);
  }
  const cannotResolve = (args, opts) => args[0] === 'ls-remote' ? { code: 128, stdout: '' } : git(args, opts);
  assert.match((await checkoutOf(cannotResolve, root)).error, /no verifiable push URL/);
});
