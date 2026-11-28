import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildCodebaseMap, extractImports } from './codebaseMap.mjs';

const AUTHOR = ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false'];

function makeTempRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-cmap-test-'));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf8');
  }
  execFileSync('git', [...AUTHOR, '-C', dir, 'add', '-A']);
  execFileSync('git', [...AUTHOR, '-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

test('extractImports parses JS/TS, Python, Go, Rust, CSS and shell local imports', () => {
  const js = extractImports('src/a.mjs', `
    import { x } from './b.mjs';
    export * from '../shared/c';
    const d = require('./d.cjs');
    // import { ignored } from './commented.mjs';
    import pkg from 'node:fs';
  `);
  assert.deepEqual(js.sort(), ['../shared/c', './b.mjs', './d.cjs']);

  const py = extractImports('pkg/a.py', `
    from .helper import run
    import pkg.db as db
  `);
  assert.ok(py.includes('py:.helper'));
  assert.ok(py.includes('py:pkg.db'));

  const rs = extractImports('src/lib.rs', `
    pub mod router;
    use crate::store::Item;
  `);
  assert.ok(rs.includes('rs-mod:router'));
  assert.ok(rs.includes('rs-use:crate::store::Item'));
});

test('buildCodebaseMap scans whole repo, promotes src/* modules, extracts cross-module edges and overlays diff (including deleted files)', async (t) => {
  const cfgRel = ['..', '..', 'config', 'webhooks.json'].join('/');
  const dir = makeTempRepo({
    '.gitignore': 'ignored.mjs\n',
    'README.md': '# Repo\n',
    'config/webhooks.json': '{ "timeoutMs": 5000 }\n',
    'src/api/server.mjs': "import { deliver } from '../webhooks/deliver.mjs';\nexport const run = () => deliver();\n",
    'src/webhooks/deliver.mjs': `import cfg from '${cfgRel}' with { type: 'json' };\nimport { retry } from './retry.mjs';\nexport function deliver() { return [cfg, retry()]; }\n`,
    'src/webhooks/retry.mjs': 'export function retry() { return 1; }\n',
    'src/db/pool.mjs': 'export const pool = {};\n',
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Ignored file must not appear on the map.
  fs.writeFileSync(path.join(dir, 'ignored.mjs'), 'export const nope = 1;\n');

  const diffFiles = [
    { path: 'src/webhooks/deliver.mjs', status: 'modified', additions: 14, deletions: 3, hunks: [{}, {}] },
    { path: 'src/webhooks/retry.mjs', status: 'added', additions: 20, deletions: 0, hunks: [{}] },
    { path: 'src/webhooks/old.mjs', status: 'deleted', additions: 0, deletions: 18, hunks: [{}] },
  ];

  const map = await buildCodebaseMap({ rootDir: dir, diffFiles });
  const modIds = map.modules.map((m) => m.id).sort();
  assert.deepEqual(modIds, ['(root)', 'config', 'src/api', 'src/db', 'src/webhooks']);
  assert.equal(map.changedFiles, 3);
  assert.equal(map.truncated, false);

  const webhooks = map.modules.find((m) => m.id === 'src/webhooks');
  assert.equal(webhooks.changedCount, 3);
  assert.equal(webhooks.addedCount, 1);
  assert.equal(webhooks.modifiedCount, 1);
  assert.equal(webhooks.deletedCount, 1);
  assert.equal(webhooks.additions, 34);
  assert.equal(webhooks.deletions, 21);
  assert.ok(webhooks.files.some((f) => f.path === 'src/webhooks/old.mjs' && f.status === 'deleted'));

  // Ignored file excluded.
  const allPaths = map.modules.flatMap((m) => m.files.map((f) => f.path));
  assert.equal(allPaths.includes('ignored.mjs'), false);

  // Module-to-module edges: src/api -> src/webhooks and src/webhooks -> config.
  const edgePairs = map.moduleEdges.map((e) => `${e.from}->${e.to}:${e.touchesChange}`);
  assert.ok(edgePairs.includes('src/api->src/webhooks:true'), edgePairs.join(', '));
  assert.ok(edgePairs.includes('src/webhooks->config:true'), edgePairs.join(', '));

  // File-to-file edge within src/webhooks too.
  assert.ok(map.fileEdges.some((e) => e.from === 'src/webhooks/deliver.mjs' && e.to === 'src/webhooks/retry.mjs'));

  // Every module gets a human-readable summary.
  for (const m of map.modules) assert.equal(typeof m.summary, 'string');
  const cfg = map.modules.find((m) => m.id === 'config');
  assert.match(cfg.summary, /Configuration files/);
});

test('buildCodebaseMap extracts module summaries from README.md and entrypoint comments', async (t) => {
  const dir = makeTempRepo({
    'session/README.md': '# The session image\n\nOne image holds everything a session needs except the databases.\n',
    'session/entrypoint.sh': '#!/bin/sh\necho hi\n',
    'worker/index.mjs': '// Runs background webhook jobs with retries.\nexport function start() {}\n',
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const map = await buildCodebaseMap({ rootDir: dir, diffFiles: [] });
  const session = map.modules.find((m) => m.id === 'session');
  const worker = map.modules.find((m) => m.id === 'worker');
  assert.match(session.summary, /The session image/);
  assert.match(session.summary, /everything a session needs/);
  assert.equal(worker.summary, 'Runs background webhook jobs with retries.');
});
