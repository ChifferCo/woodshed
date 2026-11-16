import { test } from 'node:test';
import assert from 'node:assert/strict';

import { blockerText, createDatabaseGate, projectFileUrl } from './databaseGate.mjs';
import { createProjectReader } from './projectFile.mjs';

const FILE = (engines) => JSON.stringify({ version: 1, databases: engines.map((engine) => ({ engine, dir: 'api' })) });
const API = { name: 'api', repo: 'acme/api' };
const WEB = { name: 'web', repo: 'acme/web' };

test('a project whose own file needs an engine the installation does not host is blocked, and no other', async () => {
  let text = FILE(['postgres', 'mongo']);
  let clock = 0;
  const reader = createProjectReader({ github: { projectFile: async () => text }, now: () => clock });
  const files = { api: reader.databases, web: async () => [{ engine: 'postgres' }] };
  const gate = createDatabaseGate({ projectDatabases: (p) => files[p.name](), hosted: ['postgres'], provider: 'aws', admins: () => ['ana', 'bo'] });
  assert.equal(gate.last('api'), null, 'nothing known before the first read');
  const blocker = await gate.blocker(API);
  assert.equal(blocker.reason, 'acme/api\'s project file asks for a Mongo database, and this console only runs Postgres.');
  assert.deepEqual(blocker.fix, [
    { text: 'Add "mongo" to databases in the installation\'s terraform.tfvars, then run terraform plan and terraform apply in providers/aws/terraform.' },
    { text: 'Or take the Mongo database out of acme/api\'s project file.', href: 'https://github.com/acme/api/blob/HEAD/.woodshed/project.yaml', label: 'Open the project file' },
  ]);
  assert.deepEqual(blocker.ask.who, ['ana', 'bo']);
  assert.match(blocker.ask.text, /acme\/api/);
  assert.equal(blocker.project, 'api');
  assert.equal(blocker.repo, 'acme/api');
  assert.match(gate.last('api'), /^acme\/api's project file asks for a Mongo database.*Add "mongo"/);
  assert.equal(await gate.blocker(WEB), null, 'another repo whose file needs only Postgres starts');
  assert.deepEqual(Object.keys(await gate.blockers([API, WEB])), ['api']);
  text = FILE(['postgres']);
  clock = 11 * 60_000;
  assert.equal(await gate.refusal(API), null, 'the file dropped the database: sessions start again');
  assert.equal(gate.last('api'), null);
});

test('the fix follows the provider, and a local install that named no repo gets install.sh again', async () => {
  const needs = async () => [{ engine: 'postgres' }];
  const local = createDatabaseGate({ projectDatabases: needs, hosted: [], provider: 'local' });
  const found = await local.blocker(API);
  assert.equal(found.reason, 'acme/api\'s project file asks for a Postgres database, and this console runs no database.');
  assert.match(found.fix[0].text, /WOODSHED_LOCAL_DB_\*/);
  const fix = (project) => [{ text: `Run WOODSHED_REPO=${project.repo} bash install.sh again on this machine.` }];
  const named = createDatabaseGate({ projectDatabases: needs, hosted: [], provider: 'local', fix });
  assert.equal(await named.refusal(API), 'acme/api\'s project file asks for a Postgres database, and this console runs no database. Run WOODSHED_REPO=acme/api bash install.sh again on this machine.');
  const other = createDatabaseGate({ projectDatabases: needs, hosted: [] });
  assert.match((await other.blocker(API)).fix[0].text, /^Whoever runs this console adds Postgres/);
  assert.equal((await other.blocker(API)).ask, undefined, 'no People list: nobody to name');
  const hosted = createDatabaseGate({ projectDatabases: needs, hosted: ['postgres'], fix: () => [{ text: 'never said' }] });
  assert.equal(await hosted.blocker(API), null);
});

test('a project file that cannot be read, or that is not there, blocks nothing: the session checks its own copy', async () => {
  const unreadable = createDatabaseGate({ projectDatabases: createProjectReader({ github: { projectFile: async () => 'version: [' } }).databases, hosted: [] });
  assert.equal(await unreadable.refusal(API), null);
  const none = createDatabaseGate({ projectDatabases: createProjectReader({ github: { projectFile: async () => null } }).databases, hosted: [] });
  assert.equal(await none.refusal(API), null);
});

test('the program\'s hook answers first, kept to the contract, and a hook that fails blocks nothing', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let answer = {
    reason: 'acme/api\'s session image is not built: the install secret NPM_TOKEN has no value.',
    fix: [
      { text: 'Give NPM_TOKEN a value.', href: '/console-settings/repos/api', label: 'Open its settings' },
      { text: 'Rebuild the image.', href: 'https://example.com/build', label: 'Build' },
      { text: 'A bad link is dropped.', href: 'javascript:alert(1)', label: 'x' },
      { nope: true },
    ],
    ask: { who: ['ana'], text: 'Please set NPM_TOKEN.' },
    project: 'forged',
  };
  let clock = 0;
  const asked = [];
  const readiness = async (p) => { asked.push(p); if (answer instanceof Error) throw answer; return answer; };
  const gate = createDatabaseGate({ projectDatabases: async () => [{ engine: 'mongo' }], hosted: [], readiness, now: () => clock });
  const blocker = await gate.blocker(API);
  assert.deepEqual(asked, [{ name: 'api', repo: 'acme/api' }]);
  assert.deepEqual(blocker, {
    project: 'api', repo: 'acme/api', reason: answer.reason,
    fix: [
      { text: 'Give NPM_TOKEN a value.', href: '/console-settings/repos/api', label: 'Open its settings' },
      { text: 'Rebuild the image.', href: 'https://example.com/build', label: 'Build' },
      { text: 'A bad link is dropped.' },
    ],
    ask: { who: ['ana'], text: 'Please set NPM_TOKEN.' },
  });
  assert.equal(blockerText(blocker), `${answer.reason} Give NPM_TOKEN a value.`);
  await gate.blocker(API);
  assert.equal(asked.length, 1, 'a fresh answer is kept a few seconds');
  answer = null;
  clock += 11_000;
  assert.match((await gate.blocker(API)).reason, /Mongo/, 'the hook said nothing: the engine check runs');
  answer = new Error('down');
  clock += 11_000;
  assert.match((await gate.blocker(API)).reason, /Mongo/);
});

test('each change of a project\'s answer is logged once, a file that stops being read as not read', async (t) => {
  const logged = [];
  t.mock.method(console, 'warn', (message) => logged.push(message));
  t.mock.method(console, 'log', (message) => logged.push(message));
  let databases = [{ engine: 'mongo' }];
  const gate = createDatabaseGate({ projectDatabases: async () => databases, hosted: ['postgres'] });
  assert.ok(await gate.blocker(API));
  assert.ok(await gate.blocker(API));
  databases = null;
  assert.equal(await gate.blocker(API), null);
  assert.deepEqual(logged, ['console: project databases not hosted', 'console: project file not read, its databases not checked']);
  assert.equal(projectFileUrl('acme/api'), 'https://github.com/acme/api/blob/HEAD/.woodshed/project.yaml');
});
