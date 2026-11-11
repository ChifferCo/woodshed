import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { imagePlatform, pruneDeps } from './pruneDeps.mjs';

const SCRIPT = path.join(import.meta.dirname, 'pruneDeps.mjs');
const GLIBC = { os: 'linux', cpu: 'x64', libc: 'glibc' };

// A node_modules of packages, each `folder: package.json fields` (a nested one's name is after its last node_modules/),
// with a file inside each so its size counts.
function nodeModules(t, packages, files = {}) {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-prune-')), 'node_modules');
  t.after(() => fs.rmSync(path.dirname(root), { recursive: true, force: true }));
  for (const [name, fields] of Object.entries(packages)) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, 'package.json'), JSON.stringify({ name: name.split('node_modules/').at(-1), version: '1.0.0', ...fields }));
    fs.writeFileSync(path.join(root, name, 'binding.node'), 'x'.repeat(1000));
  }
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

const has = (root, name) => fs.existsSync(path.join(root, name, 'package.json'));

// A native package with a variant a libc, as @next/swc and its kind publish them.
function swcPair() {
  return {
    'swc': { optionalDependencies: { 'swc-linux-x64-gnu': '1.0.0', 'swc-linux-x64-musl': '1.0.0' } },
    'swc-linux-x64-gnu': { os: ['linux'], cpu: ['x64'], libc: ['glibc'] },
    'swc-linux-x64-musl': { os: ['linux'], cpu: ['x64'], libc: ['musl'] },
  };
}

test('a gnu and musl pair keeps the variant for the image\'s libc and drops the other', (t) => {
  const root = nodeModules(t, swcPair());
  const removed = pruneDeps({ roots: [root], platform: GLIBC });
  assert.deepEqual(removed.packages, ['swc-linux-x64-musl']);
  assert.ok(has(root, 'swc-linux-x64-gnu') && has(root, 'swc'));
  assert.ok(!fs.existsSync(path.join(root, 'swc-linux-x64-musl')));
  assert.ok(removed.bytes >= 1000);
  const onMusl = nodeModules(t, swcPair());
  assert.deepEqual(pruneDeps({ roots: [onMusl], platform: { ...GLIBC, libc: 'musl' } }).packages, ['swc-linux-x64-gnu'], 'and the other way on a musl image');
});

test('scoped and nested packages are pruned too', (t) => {
  const root = nodeModules(t, {
    '@next/swc-linux-x64-gnu': { libc: ['glibc'] },
    '@next/swc-linux-x64-musl': { libc: ['musl'] },
    'next': { optionalDependencies: { '@next/swc-linux-x64-gnu': '1', '@next/swc-linux-x64-musl': '1' } },
    'tool/node_modules/@scope/bin-gnu': { libc: ['glibc'] },
    'tool/node_modules/@scope/bin-musl': { libc: ['musl'] },
    'tool/node_modules/@scope/bin': { optionalDependencies: { '@scope/bin-gnu': '1', '@scope/bin-musl': '1' } },
  });
  assert.deepEqual(pruneDeps({ roots: [root], platform: GLIBC }).packages.sort(), ['@next/swc-linux-x64-musl', '@scope/bin-musl']);
  assert.ok(has(root, '@next/swc-linux-x64-gnu') && has(root, 'tool/node_modules/@scope/bin-gnu'));
});

test('a variant for another libc is kept when nothing lists one for the image beside it', (t) => {
  const pair = swcPair();
  const root = nodeModules(t, { 'swc': pair.swc, 'swc-linux-x64-musl': pair['swc-linux-x64-musl'], 'lone-musl': { libc: ['musl'] } });
  assert.deepEqual(pruneDeps({ roots: [root], platform: GLIBC }).packages, []);
  assert.ok(has(root, 'swc-linux-x64-musl') && has(root, 'lone-musl'));
});

test('os and cpu count as npm reads them, negations included', (t) => {
  const root = nodeModules(t, {
    'esbuild': { optionalDependencies: { '@esbuild/linux-x64': '1', '@esbuild/linux-arm64': '1', '@esbuild/darwin-x64': '1', 'not-win': '1' } },
    '@esbuild/linux-x64': { os: ['linux'], cpu: ['x64'] },
    '@esbuild/linux-arm64': { os: ['linux'], cpu: ['arm64'] },
    '@esbuild/darwin-x64': { os: ['darwin'], cpu: ['x64'] },
    'not-win': { os: ['!win32'] },
  });
  assert.deepEqual(pruneDeps({ roots: [root], platform: GLIBC }).packages.sort(), ['@esbuild/darwin-x64', '@esbuild/linux-arm64']);
  assert.ok(has(root, '@esbuild/linux-x64') && has(root, 'not-win'));
});

test('source maps are dropped and every other file kept, a .map that is not JSON included', (t) => {
  const root = nodeModules(t, { lib: {} }, {
    'lib/index.js': 'code', 'lib/index.js.map': '{"version":3}', 'lib/types.d.ts.map': ' {"version":3}',
    'lib/data.map': 'not a source map', 'lib/es6.map/index.js': 'a folder named .map',
  });
  const removed = pruneDeps({ roots: [root], platform: GLIBC });
  assert.equal(removed.maps, 2);
  assert.ok(!fs.existsSync(path.join(root, 'lib/index.js.map')) && !fs.existsSync(path.join(root, 'lib/types.d.ts.map')));
  for (const kept of ['lib/index.js', 'lib/data.map', 'lib/es6.map/index.js', 'lib/package.json']) assert.ok(fs.existsSync(path.join(root, kept)), kept);
});

test('a symlinked package is never followed into', (t) => {
  const root = nodeModules(t, {}, { 'lib/index.js.map': '{}' });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-prune-link-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'src.js.map'), '{}');
  fs.symlinkSync(outside, path.join(root, 'workspace'));
  assert.equal(pruneDeps({ roots: [root], platform: GLIBC }).maps, 1);
  assert.ok(fs.existsSync(path.join(outside, 'src.js.map')));
});

test('the image\'s platform is node\'s own', () => {
  const platform = imagePlatform();
  assert.equal(platform.os, process.platform);
  assert.equal(platform.cpu, process.arch);
  if (process.platform === 'linux') assert.ok(['glibc', 'musl'].includes(platform.libc));
});

test('the CLI prints one summary line with the count and the MB', (t) => {
  const root = nodeModules(t, {}, { 'lib/index.js.map': '{}' });
  const run = spawnSync('node', [SCRIPT, root, path.join(root, 'missing')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^deps: pruned .* \(0 packages not for \S+ \S+.*, 1 source maps, 0\.0 MB\)\n$/);
});
