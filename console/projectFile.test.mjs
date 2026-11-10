import { test } from 'node:test';
import assert from 'node:assert/strict';

import { appendedBySecret, createProjectReader } from './projectFile.mjs';

const PROJECT = `
version: 1
dependencies:
  installs: []
env: {}
envFiles:
  - path: app/.env
    secret: app-env
    lines:
      - DATABASE_HOST={{PGHOST}}
      - PORT={{PORT}}
  - path: app/.env.local
    secret: null
    lines: [X=1]
databases: []
app: null
editor: true
rules: null
setup: null
pullRequests: null
`;

test('the variables each secret\'s env file always gets are its lines\' names; a file with no secret has none listed', () => {
  assert.deepEqual([...appendedBySecret(PROJECT)], [['app-env', ['DATABASE_HOST', 'PORT']]]);
});

test('the reader keeps what it read for a while, and a repo with no project file or an unreadable one lists nothing', async () => {
  let reads = 0;
  let clock = 0;
  const reader = createProjectReader({ github: { projectFile: async () => { reads += 1; return PROJECT; } }, now: () => clock });
  assert.deepEqual(await reader.appendedFor('app-env'), ['DATABASE_HOST', 'PORT']);
  assert.deepEqual(await reader.appendedFor('other'), []);
  assert.equal(reads, 1);
  clock = 11 * 60_000;
  await reader.appendedFor('app-env');
  assert.equal(reads, 2, 'read again after ten minutes');
  const none = createProjectReader({ github: { projectFile: async () => null } });
  assert.deepEqual(await none.appendedFor('app-env'), []);
  const broken = createProjectReader({ github: { projectFile: async () => { throw new Error('boom'); } } });
  assert.deepEqual(await broken.appendedFor('app-env'), []);
});

test('the gates for a pull request are the file\'s pullRequests; an unread file is an error, not a repo with none', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const gated = PROJECT.replace('pullRequests: null', [
    'pullRequests:', '  review: null', '  suites:', '    - name: e2e suite', '      workflow: .github/workflows/e2e.yml', '      jobs: e2e run',
    "      rerun: '[e2e]'", '  qa: null', '  mergeRisk: null',
  ].join('\n'));
  const reader = createProjectReader({ github: { projectFile: async () => gated } });
  assert.deepEqual(await reader.pullRequests(), {
    review: null, suites: [{ name: 'e2e suite', workflow: '.github/workflows/e2e.yml', jobs: 'e2e run', rerun: '[e2e]' }], qa: null, mergeRisk: null,
  });
  assert.equal(await createProjectReader({ github: { projectFile: async () => PROJECT } }).pullRequests(), null);
  assert.equal(await createProjectReader({ github: { projectFile: async () => null } }).pullRequests(), null, 'no project file');

  let clock = 0;
  let fail = true;
  const flaky = createProjectReader({ github: { projectFile: async () => { if (fail) throw new Error('HTTP 502'); return gated; } }, now: () => clock });
  await assert.rejects(flaky.pullRequests(), /the project file could not be read: HTTP 502/);
  fail = false;
  clock = 30_000;
  await assert.rejects(flaky.pullRequests(), /HTTP 502/, 'kept for a minute');
  clock = 61_000;
  assert.equal((await flaky.pullRequests()).suites.length, 1, 'a failed read is tried again after a minute, not ten');
  const broken = createProjectReader({ github: { projectFile: async () => PROJECT.replace('pullRequests: null', 'pullRequests: {reviews: null}') } });
  await assert.rejects(broken.pullRequests(), /pullRequests has reviews, which is not a field/);
});

test('consoleLinks is the file\'s, true with no file, and null, not a guess, when the file could not be read', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const reader = (projectFile) => createProjectReader({ github: { projectFile } });
  assert.equal(await reader(async () => `${PROJECT}consoleLinks: false\n`).consoleLinks(), false);
  assert.equal(await reader(async () => PROJECT).consoleLinks(), true, 'left out');
  assert.equal(await reader(async () => null).consoleLinks(), true, 'no project file');
  assert.equal(await reader(async () => { throw new Error('gh api failed: HTTP 502'); }).consoleLinks(), null);
});

test('files asked for at once share one read, and none of them sees an empty answer', async () => {
  let reads = 0;
  const github = { projectFile: async () => { reads += 1; await new Promise((r) => setTimeout(r, 20)); return PROJECT; } };
  const reader = createProjectReader({ github });
  const [a, b, c] = await Promise.all([reader.appendedFor('app-env'), reader.appendedFor('app-env'), reader.appendedFor('other')]);
  assert.deepEqual([a, b, c], [['DATABASE_HOST', 'PORT'], ['DATABASE_HOST', 'PORT'], []]);
  assert.equal(reads, 1);
});

test('the migrations Restore a dump counts are the files in the engine\'s database\'s migrations folder', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const withDbs = PROJECT.replace('databases: []', [
    'databases:', '  - engine: postgres', '    dir: api', '    paths: [api/db/]', '    migrations: api/db/migrations',
    '  - engine: mongo', '    dir: api',
  ].join('\n'));
  const listed = [];
  const github = { projectFile: async () => withDbs, fileNames: async (folder) => { listed.push(folder); return ['001_init.ts']; } };
  const reader = createProjectReader({ github });
  assert.deepEqual(await reader.migrationFiles('postgres'), ['001_init.ts']);
  assert.deepEqual(listed, ['api/db/migrations']);
  assert.deepEqual(await reader.migrationFiles('mongo'), [], 'a database that keeps no migrations');
  assert.deepEqual(await createProjectReader({ github: { ...github, projectFile: async () => PROJECT } }).migrationFiles('postgres'), [], 'no Postgres database');
  assert.deepEqual(await createProjectReader({ github: { ...github, projectFile: async () => null } }).migrationFiles('postgres'), [], 'no project file');
  assert.deepEqual(listed, ['api/db/migrations'], 'nothing listed without a folder');
  const broken = createProjectReader({ github: { ...github, projectFile: async () => { throw new Error('HTTP 502'); } } });
  await assert.rejects(broken.migrationFiles('postgres'), /the project file could not be read: HTTP 502/);
});
