import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isMain } from '../shared/isMain.mjs';

const WOODSHED = path.resolve(import.meta.dirname, '..');

// A script started through a symlinked folder must still run, not exit 0 unseen: the session image once kept its old
// path as a symlink, and the db-admin task ran through it.
test('a session script run through a symlink to the woodshed folder still runs', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isMain-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const link = path.join(dir, 'woodshedCloud');
  fs.symlinkSync(WOODSHED, link);
  const run = (script) => spawnSync(process.execPath, [path.join(link, script)], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  const dbAdmin = run('session/dbAdmin.mjs');
  assert.equal(dbAdmin.status, 1, 'refuses a run without its flags, rather than doing nothing');
  assert.match(dbAdmin.stdout + dbAdmin.stderr, /the entryPoint must end its flags with --/);
  const project = run('shared/project.mjs');
  assert.equal(project.status, 1);
  assert.match(project.stderr, /^project: /);
});

test('a module imported by another is not main', () => {
  assert.equal(isMain(new URL('../shared/project.mjs', import.meta.url).href), false);
});
