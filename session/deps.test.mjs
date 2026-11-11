import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { imagePlatform } from './pruneDeps.mjs';

const DEPS = path.join(import.meta.dirname, 'deps.sh');
const DOCKERFILE = fs.readFileSync(path.join(import.meta.dirname, 'Dockerfile'), 'utf8');

// The shell of the Dockerfile's RUN that runs `deps.sh <command>`, as it is written there, without its mounts.
function dockerfileRun(command) {
  const runs = DOCKERFILE.replace(/\\\n/g, ' ').split('\n').filter((line) => line.startsWith('RUN '));
  const run = runs.find((line) => line.includes(`woodshed-deps.sh ${command} `));
  assert.ok(run, `a RUN runs deps.sh ${command}`);
  return run.replace(/^RUN\s+/, '').replace(/--mount=\S+\s+/g, '');
}

function write(root, files) {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
}

// Two installs whose commands stand in for a package manager: each keeps a folder in its dir, the first a folder in the
// home too, and leaves something it does not keep.
const MANIFEST = [
  'install\tapi\tdeps.lock .registryrc\tvendor ~/.cache/tool\ttrue\tmkdir -p vendor ~/.cache/tool && cp deps.lock vendor/ && printf %s "$REGISTRY_TOKEN" > vendor/token && echo built > ~/.cache/tool/x && touch stray',
  'install\tweb\tdeps.lock pkgs/*/manifest\tvendor\ttrue\tmkdir -p vendor && ls pkgs > vendor/pkgs',
].join('\n') + '\n';
const CONTEXT = { 'api/deps.lock': 'a1', 'api/.registryrc': 'r', 'web/deps.lock': 'w1', 'web/pkgs/a/manifest': 'm', 'web/pkgs/b/manifest': 'm' };

// The install_env build secret: the installation's install secrets as `NAME=value` lines, a value with a space in
// it quoted, as the image workflow writes it.
const INSTALL_ENV = "REGISTRY_TOKEN='registry-secret'\nOTHER_TOKEN='two $words'\n";

// The deps stage: woodshed-deps/ copied into the checkout's path, then the Dockerfile's install RUN with its mounts
// and secret where the test put them.
function depsStage(t, { manifest = MANIFEST, installEnv = INSTALL_ENV, path: PATH = process.env.PATH } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-deps-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repoDir = path.join(root, 'work/app');
  write(repoDir, CONTEXT);
  write(root, { installs: manifest, ...(installEnv && { secret: installEnv }) });
  const script = dockerfileRun('install')
    .replaceAll('/tmp/woodshed-installs', path.join(root, 'installs'))
    .replaceAll('/tmp/woodshed-deps.sh', DEPS)
    .replaceAll('/run/secrets/install_env', path.join(root, 'secret'))
    .replaceAll('/tmp/woodshed-home', path.join(root, 'home'))
    .replaceAll('/woodshed-out', path.join(root, 'out'));
  fs.mkdirSync(path.join(root, 'out'));
  const run = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH, REPO_DIR: repoDir } });
  return { root, repoDir, out: path.join(root, 'out'), ...run };
}

// The final stage: a fresh clone of the same files, the stage's copies over it, then the Dockerfile's check RUN.
function finalStage(stage, { clone = CONTEXT } = {}) {
  const repoDir = path.join(stage.root, 'final/work/app');
  const records = path.join(stage.root, 'final/work/.woodshed-deps');
  fs.rmSync(path.join(stage.root, 'final'), { recursive: true, force: true });
  write(repoDir, clone);
  fs.cpSync(path.join(stage.out, 'checkout'), repoDir, { recursive: true });
  fs.cpSync(path.join(stage.out, 'records'), records, { recursive: true });
  const script = dockerfileRun('check')
    .replaceAll('/tmp/woodshed-installs', path.join(stage.root, 'installs'))
    .replaceAll('/tmp/woodshed-deps.sh', DEPS);
  return spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH, REPO_DIR: repoDir, WOODSHED_DEPS_RECORDS: records } });
}

test('the image\'s install runs each command in its dir with the install secrets in their variables, and keeps only its output', (t) => {
  const stage = depsStage(t);
  assert.equal(stage.status, 0, stage.stderr);
  assert.match(stage.stdout, /deps: install secrets in REGISTRY_TOKEN OTHER_TOKEN\ndeps: installing api\ndeps: installing web\ndeps: installed \(2 installs\)/);
  assert.doesNotMatch(stage.stdout + stage.stderr, /registry-secret|two \$words/, 'a value is never printed');
  const kept = (file) => fs.readFileSync(path.join(stage.out, file), 'utf8');
  assert.equal(kept('checkout/api/vendor/deps.lock'), 'a1');
  assert.equal(kept('checkout/api/vendor/token'), 'registry-secret');
  assert.equal(kept('home/.cache/tool/x'), 'built\n');
  assert.equal(kept('checkout/web/vendor/pkgs'), 'a\nb\n');
  assert.ok(!fs.existsSync(path.join(stage.out, 'checkout/api/stray')), 'what the install does not keep stays behind');
  assert.ok(!fs.existsSync(path.join(stage.root, 'home')), 'the build\'s own home, and its caches, are gone');
  assert.deepEqual(kept('records/web/built-from').split('\n').filter(Boolean).map((line) => line.split(/\s+/)[1]),
    ['deps.lock', 'pkgs/a/manifest', 'pkgs/b/manifest']);
});

test('with no build secret the install runs without the install secrets', (t) => {
  const stage = depsStage(t, { installEnv: null });
  assert.equal(stage.status, 0, stage.stderr);
  assert.equal(fs.readFileSync(path.join(stage.out, 'checkout/api/vendor/token'), 'utf8'), '');
  assert.match(stage.stdout, /deps: no install secrets/);
});

test('an install that reads stdin does not take the installs after it', (t) => {
  const manifest = 'install\tapi\tdeps.lock\tvendor\ttrue\tcat > /dev/null && mkdir -p vendor\ninstall\tweb\tdeps.lock\tvendor\ttrue\tmkdir -p vendor\n';
  const stage = depsStage(t, { manifest });
  assert.equal(stage.status, 0, stage.stderr);
  assert.match(stage.stdout, /deps: installing web\ndeps: installed \(2 installs\)/);
});

test('a failed install, or one that does not make what it keeps, fails the build naming its dir', (t) => {
  const failed = depsStage(t, { manifest: 'install\tapi\tdeps.lock\tvendor\ttrue\tfalse\n' });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /deps: the install in api failed: false/);
  const nothing = depsStage(t, { manifest: 'install\tapi\tdeps.lock\tvendor\ttrue\ttrue\n' });
  assert.notEqual(nothing.status, 0);
  assert.match(nothing.stderr, /deps: the install in api made no vendor/);
});

test('the final stage passes when the clone has the context\'s files, and fails when one differs or a glob matches more', (t) => {
  const stage = depsStage(t);
  assert.equal(stage.status, 0, stage.stderr);
  const same = finalStage(stage);
  assert.equal(same.status, 0, same.stderr);
  const changed = finalStage(stage, { clone: { ...CONTEXT, 'api/deps.lock': 'a2' } });
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /deps: api's files in the build context are not the cloned commit's: build from that commit/);
  const added = finalStage(stage, { clone: { ...CONTEXT, 'web/pkgs/c/manifest': 'm' } });
  assert.match(added.stderr, /deps: web's files in the build context are not the cloned commit's/);
});

test('a project with no installs builds and checks nothing', (t) => {
  const stage = depsStage(t, { manifest: '' });
  assert.equal(stage.status, 0, stage.stderr);
  assert.match(stage.stdout, /installed \(0 installs\)/);
  assert.equal(finalStage(stage).status, 0);
});

// An install that makes a node_modules with a native package's variant for this machine's libc and for the other one,
// a lone variant for the other, and a source map: the command copies it from `made`, as a package manager would write it.
function nodeModulesInstall(root, { prune = true, output = 'node_modules' } = {}) {
  const { libc } = imagePlatform();
  const other = libc === 'musl' ? 'glibc' : 'musl';
  const made = path.join(root, 'made');
  const pkg = (name, fields) => write(made, { [`${name}/package.json`]: JSON.stringify({ name, ...fields }), [`${name}/index.js`]: '' });
  pkg('bin', { optionalDependencies: { 'bin-this': '1', 'bin-other': '1' } });
  pkg('bin-this', { libc: [libc] });
  pkg('bin-other', { libc: [other] });
  pkg('lone-other', { libc: [other] });
  write(made, { 'bin/index.js.map': '{"version":3}' });
  return `install\tapi\tdeps.lock\t${output}\t${prune}\tcp -r ${made} node_modules\n`;
}

const kept = (stage, name) => fs.existsSync(path.join(stage.out, 'checkout/api/node_modules', name));

test('each install\'s node_modules is pruned before the image keeps it, and the log says what went', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-deps-made-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stage = depsStage(t, { manifest: nodeModulesInstall(root) });
  assert.equal(stage.status, 0, stage.stderr);
  assert.match(stage.stdout, /deps: installing api\ndeps: pruned \S+ \(1 packages not for linux \S+ \S+, 1 source maps, 0\.0 MB\): bin-other\n/);
  assert.ok(kept(stage, 'bin-this') && kept(stage, 'bin/index.js') && kept(stage, 'lone-other'), 'a variant with no sibling for this image stays');
  assert.ok(!kept(stage, 'bin-other') && !kept(stage, 'bin/index.js.map'));
});

test('prune: false keeps an install\'s node_modules whole, and an output that is no node_modules is never pruned', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-deps-made-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const off = depsStage(t, { manifest: nodeModulesInstall(root, { prune: false }) });
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stdout, /deps: not pruning api \(prune: false\)/);
  assert.ok(kept(off, 'bin-other') && kept(off, 'bin/index.js.map'));
  const vendor = depsStage(t, { manifest: 'install\tapi\tdeps.lock\tvendor\ttrue\tmkdir -p vendor && echo {} > vendor/x.js.map\n' });
  assert.equal(vendor.status, 0, vendor.stderr);
  assert.doesNotMatch(vendor.stdout, /pruned/);
  assert.ok(fs.existsSync(path.join(vendor.out, 'checkout/api/vendor/x.js.map')));
});

test('a prune that fails warns, and the install and the image go on with everything it kept', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-deps-made-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // A node that always fails, ahead of the real one: the prune is the one thing here that runs node.
  write(root, { 'bin/node': '#!/bin/sh\nexit 1\n' });
  fs.chmodSync(path.join(root, 'bin/node'), 0o755);
  const stage = depsStage(t, { manifest: nodeModulesInstall(root), path: `${path.join(root, 'bin')}:${process.env.PATH}` });
  assert.equal(stage.status, 0, stage.stderr);
  assert.match(stage.stderr, /deps: WARNING: pruning api failed, what is left of it is kept/);
  assert.match(stage.stdout, /deps: installed \(1 installs\)/);
  assert.ok(kept(stage, 'bin-other') && kept(stage, 'bin-this'));
});
