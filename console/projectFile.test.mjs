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
    review: null, suites: [{ name: 'e2e suite', workflow: '.github/workflows/e2e.yml', jobs: 'e2e run', rerun: '[e2e]' }], qa: null, mergeRisk: null, autoMerge: null,
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

test('githubAccess is the file\'s, full with no file or none written, and null when the file could not be read', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const reader = (projectFile) => createProjectReader({ github: { projectFile } });
  assert.equal(await reader(async () => `${PROJECT}githubAccess: repo\n`).githubAccess(), 'repo');
  assert.equal(await reader(async () => PROJECT).githubAccess(), 'full', 'left out');
  assert.equal(await reader(async () => null).githubAccess(), 'full', 'no project file');
  assert.equal(await reader(async () => { throw new Error('gh api failed: HTTP 502'); }).githubAccess(), null);
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

test('a repo with no project file on its default branch is read from the installation\'s, and its own wins', async (t) => {
  const logs = [];
  t.mock.method(console, 'log', (message, fields) => logs.push([message, fields]));
  const supplied = { text: PROJECT.replace('editor: true', 'editor: false'), path: '/files/acme/app.yaml' };
  const fromInstallation = createProjectReader({ github: { projectFile: async () => null }, installationFile: () => supplied });
  assert.deepEqual(await fromInstallation.appendedFor('app-env'), ['DATABASE_HOST', 'PORT']);
  assert.deepEqual(logs.at(-1), ['projectFile: read', { found: true, from: 'installation', envFiles: 2, pullRequests: false, databases: [] }]);

  let asked = 0;
  const own = createProjectReader({ github: { projectFile: async () => PROJECT.replace('PORT={{PORT}}', 'OWN=1') }, installationFile: () => { asked += 1; return supplied; } });
  assert.deepEqual(await own.appendedFor('app-env'), ['DATABASE_HOST', 'OWN']);
  assert.equal(logs.at(-1)[1].from, 'default branch');
  assert.equal(asked, 0, 'the installation\'s file is not read while the repo has its own');

  const neither = createProjectReader({ github: { projectFile: async () => null }, installationFile: () => null });
  assert.equal(await neither.pullRequests(), null);
  assert.equal(logs.at(-1)[1].from, 'none');
});

test('a malformed installation file is an unread file, as a malformed repo file is', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const reader = createProjectReader({ github: { projectFile: async () => null }, installationFile: () => ({ text: 'version: 1\nenvfiles: []\n' }) });
  await assert.rejects(reader.pullRequests(), /the project file could not be read: .*envfiles, which is not a field/);
  assert.equal(await reader.databases(), null);
});

test('a default branch\'s file that does not parse gives way to the installation\'s, saying why; with none it is unread', async (t) => {
  const logs = [];
  t.mock.method(console, 'log', (message, fields) => logs.push([message, fields]));
  t.mock.method(console, 'warn', (message, fields) => logs.push([message, fields]));
  const old = 'version: 1\ndatabase: null\n';
  const supplied = { text: PROJECT, path: '/files/acme/app.yaml' };
  const reader = createProjectReader({ github: { projectFile: async () => old }, installationFile: () => supplied });
  assert.deepEqual(await reader.appendedFor('app-env'), ['DATABASE_HOST', 'PORT']);
  assert.equal(await reader.pullRequests(), null, 'read, so nothing waits on it');
  const [message, fields] = logs.at(-1);
  assert.equal(message, 'projectFile: read');
  assert.equal(fields.from, 'installation');
  assert.match(fields.repoFileError, /has database, which is not a field/);

  const alone = createProjectReader({ github: { projectFile: async () => old }, installationFile: () => null });
  await assert.rejects(alone.pullRequests(), /the project file could not be read: .*has database, which is not a field/);
  assert.equal(logs.at(-1)[0], 'projectFile: not readable');

  const bothBad = createProjectReader({ github: { projectFile: async () => old }, installationFile: () => ({ text: 'version: 1\nenvfiles: []\n' }) });
  await assert.rejects(bothBad.pullRequests(), /envfiles, which is not a field/, 'a malformed installation file is unread too');
});

test('with no repo yet the reader asks GitHub nothing, and reads the default repo again once there is one', async () => {
  const github = { repo: '', asked: 0, async projectFile() { this.asked += 1; return PROJECT; } };
  const reader = createProjectReader({ github, now: () => 0 });
  assert.equal(await reader.pullRequests(), null, 'no file, and no error: nothing waits on it');
  assert.equal(github.asked, 0);
  github.repo = 'acme/app';
  assert.deepEqual(await reader.appendedFor('app-env'), ['DATABASE_HOST', 'PORT'], 'the same clock: the cache follows the repo, not only the time');
  assert.equal(github.asked, 1);
});
