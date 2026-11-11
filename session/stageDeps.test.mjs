import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fixtureCheckout, fixtureProject, fixtureProjectFiles } from '../shared/projectFixture.mjs';

const SCRIPT = path.join(import.meta.dirname, 'stageDeps.sh');

// A repo with the project file's installs, and each file given holding its own path.
function repoWith(t, installs, files, { editor = true } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-deps-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, '.woodshed'));
  fs.writeFileSync(path.join(repo, '.woodshed/project.yaml'), fixtureProject({ dependencies: { installs }, editor }));
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), file);
  }
  return repo;
}

function install(dir, files, overrides = {}) {
  return { dir, files, command: 'make deps', output: ['vendor'], ...overrides };
}

function stage(repo) {
  const dest = path.join(repo, 'staged');
  const run = spawnSync('bash', [SCRIPT, dest], { cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH } });
  return { ...run, dest };
}

function stagedFiles(dest) {
  return fs.readdirSync(dest, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(path.relative(dest, e.parentPath), e.name)).sort();
}

test('it stages each install\'s files, in the repo\'s own layout, and nothing else', (t) => {
  const repo = repoWith(t, [install('api', ['deps.lock', '.registryrc']), install('web/app', ['deps.lock'])], [
    'api/deps.lock', 'api/.registryrc', 'api/index.js', 'web/app/deps.lock', 'other/deps.lock',
  ]);
  const { status, stdout, stderr, dest } = stage(repo);
  assert.equal(status, 0, stderr);
  assert.deepEqual(stagedFiles(dest), ['api/.registryrc', 'api/deps.lock', 'web/app/deps.lock']);
  assert.match(stdout, /staged api \(2 files\)/);
  assert.equal(fs.readFileSync(path.join(dest, 'api/deps.lock'), 'utf8'), 'api/deps.lock');
});

test('a glob stages every file it matches in its folder, and none under the install\'s output', (t) => {
  const repo = repoWith(t, [install('.', ['deps.lock', 'pkgs/*/manifest', 'vendor/*/manifest', 'tools/*.json'])], [
    'deps.lock', 'pkgs/a/manifest', 'pkgs/b/manifest', 'pkgs/b/index.js', 'vendor/x/manifest', 'tools/.hidden.json',
  ]);
  const { status, stderr, dest } = stage(repo);
  assert.equal(status, 0, stderr);
  assert.deepEqual(stagedFiles(dest), ['deps.lock', 'pkgs/a/manifest', 'pkgs/b/manifest', 'tools/.hidden.json']);
});

test('a glob that matches nothing stages nothing, and a named file that is missing fails, naming it', (t) => {
  const repo = repoWith(t, [install('api', ['deps.lock', 'pkgs/*/manifest', '.registryrc'])], ['api/deps.lock']);
  const run = stage(repo);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /stageDeps: api has no \.registryrc, which its install's files name/);
  fs.writeFileSync(path.join(repo, 'api/.registryrc'), 'x');
  assert.equal(stage(repo).status, 0, 'the glob matching nothing is not an error');
});

test('an install whose dir is not in the repo fails, naming it', (t) => {
  const repo = repoWith(t, [install('gone', ['deps.lock'])], []);
  const run = stage(repo);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /stageDeps: gone, an install's dir, is not a folder in the repo/);
});

test('the manifest goes beside the folder, with each install\'s command and output', (t) => {
  const repo = repoWith(t, [install('api', ['deps.lock'], { command: 'make deps && make tools', output: ['vendor', '~/.cache/tool'] })], ['api/deps.lock']);
  const { dest } = stage(repo);
  assert.equal(fs.readFileSync(`${dest}.installs`, 'utf8'),
    'install\tapi\tdeps.lock\tvendor ~/.cache/tool\ttrue\tmake deps && make tools\n');
  assert.deepEqual(stagedFiles(dest), ['api/deps.lock'], 'the checkout gets no manifest');
});

test('a project with no installs stages an empty folder', (t) => {
  const repo = repoWith(t, [], []);
  const { status, dest } = stage(repo);
  assert.equal(status, 0);
  assert.deepEqual(fs.readdirSync(dest), []);
  assert.equal(fs.readFileSync(`${dest}.installs`, 'utf8'), '');
});

test('a repo whose project file does not read fails instead of staging nothing', (t) => {
  const repo = repoWith(t, [], []);
  fs.writeFileSync(path.join(repo, '.woodshed/project.yaml'), fixtureProject({ dependencies: ['api'] }));
  const run = stage(repo);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /the project file's dependencies could not be read/);
});

test('the project file\'s editor goes beside the folder, never inside it, for the Dockerfile to read', (t) => {
  for (const editor of [true, false]) {
    const repo = repoWith(t, [install('api', ['deps.lock'])], ['api/deps.lock'], { editor });
    const out = execFileSync('bash', [SCRIPT, path.join(repo, 'staged')], { cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(fs.readFileSync(path.join(repo, 'staged.editor'), 'utf8'), `${editor}\n`);
    assert.match(out, new RegExp(`stageDeps: editor ${editor}`));
    assert.deepEqual(stagedFiles(path.join(repo, 'staged')), ['api/deps.lock'], 'the checkout gets no flag file');
  }
});

test('a repo with no project file stages the installs of the installation\'s file for it, and its own file wins', (t) => {
  const repo = fixtureCheckout(fs.mkdtempSync(path.join(os.tmpdir(), 'stage-deps-installation-')), { repo: 'acme/app' });
  const files = fixtureProjectFiles(fs.mkdtempSync(path.join(os.tmpdir(), 'stage-deps-files-')), {
    'acme/app': fixtureProject({ dependencies: { installs: [install('api', ['deps.lock'])] }, editor: true }),
  });
  t.after(() => [repo, files].forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
  fs.mkdirSync(path.join(repo, 'api'));
  fs.writeFileSync(path.join(repo, 'api/deps.lock'), 'api/deps.lock');
  const run = (env) => spawnSync('bash', [SCRIPT, path.join(repo, 'staged')], {
    cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH, DEFAULT_BRANCH: process.env.DEFAULT_BRANCH || 'main', ...env },
  });

  const supplied = run({ WOODSHED_CLOUD_PROJECT_FILES_DIR: files });
  assert.equal(supplied.status, 0, supplied.stderr);
  assert.match(supplied.stdout, /stageDeps: project file from installation\n/);
  assert.deepEqual(stagedFiles(path.join(repo, 'staged')), ['api/deps.lock']);
  assert.equal(fs.readFileSync(path.join(repo, 'staged.installs'), 'utf8'), 'install\tapi\tdeps.lock\tvendor\ttrue\tmake deps\n');
  assert.equal(fs.readFileSync(path.join(repo, 'staged.editor'), 'utf8'), 'true\n');

  const without = run({});
  assert.equal(without.status, 0, without.stderr);
  assert.match(without.stdout, /stageDeps: project file from none\n/);
  assert.equal(fs.readFileSync(path.join(repo, 'staged.installs'), 'utf8'), '');

  fs.mkdirSync(path.join(repo, '.woodshed'));
  fs.writeFileSync(path.join(repo, '.woodshed/project.yaml'), fixtureProject({ editor: false }));
  const own = run({ WOODSHED_CLOUD_PROJECT_FILES_DIR: files });
  assert.match(own.stdout, /stageDeps: project file from checkout\n/);
  assert.equal(fs.readFileSync(path.join(repo, 'staged.installs'), 'utf8'), '');
  assert.equal(fs.readFileSync(path.join(repo, 'staged.editor'), 'utf8'), 'false\n');
});
