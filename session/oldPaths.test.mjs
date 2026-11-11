import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const WOODSHED = path.resolve(import.meta.dirname, '..');
// Inside another repo (woodshed/ in the one it grew up in) the scan covers that repo's workflows and docs too; as a
// repo of its own, all of it.
const TOP = spawnSync('git', ['-C', WOODSHED, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();
const PREFIX = path.relative(TOP, WOODSHED);
const SCANNED = PREFIX ? [PREFIX, '.github', '.woodshed', 'scripts', 'CLAUDE.md'] : ['.'];
const own = (rel) => `:!${PREFIX ? `${PREFIX}/` : ''}${rel}`;

// Woodshed lived at scripts/aws/woodshedCloud, and its images at /opt/scripts/aws/woodshedCloud, until it moved
// to woodshed/ (#26836). The image's compatibility symlink is gone, so a path naming the old place would fail only
// where it runs, in AWS.
test('nothing names Woodshed\'s old paths', () => {
  // The sync test keeps an old status line on purpose: a session from an older image still sends one.
  const grep = spawnSync('git', ['-C', TOP, 'grep', '-n', '-e', '/opt/scripts/aws', '-e', 'scripts/aws/woodshedCloud', '--',
    ...SCANNED, own('session/oldPaths.test.mjs'), own('session/settingsSync.test.mjs')],
  { encoding: 'utf8' });
  assert.ok(grep.status === 0 || grep.status === 1, grep.stderr);
  assert.equal(grep.stdout.trim(), '', 'git grep exits 1 when nothing matches');
});
