import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDatabaseGate } from './databaseGate.mjs';
import { createProjectReader } from './projectFile.mjs';

const FILE = (engines) => JSON.stringify({ version: 1, databases: engines.map((engine) => ({ engine, dir: 'api' })) });

test('the gate refuses while the default branch\'s project file needs an engine the installation does not host', async () => {
  let text = FILE(['postgres', 'mongo']);
  let clock = 0;
  const reader = createProjectReader({ github: { projectFile: async () => text }, now: () => clock });
  const gate = createDatabaseGate({ projectDatabases: reader.databases, hosted: ['postgres'] });
  assert.equal(gate.last(), null, 'nothing known before the first read');
  assert.equal(await gate.refusal(), 'the project file\'s databases need mongo, which this installation does not host (it hosts postgres)');
  assert.match(gate.last(), /need mongo/);
  text = FILE(['postgres']);
  clock = 11 * 60_000;
  assert.equal(await gate.refusal(), null, 'the file dropped the database: sessions start again');
  assert.equal(gate.last(), null);
});

test('a project file that cannot be read, or that is not there, refuses nothing: the session checks its own copy', async () => {
  const unreadable = createDatabaseGate({ projectDatabases: createProjectReader({ github: { projectFile: async () => 'version: [' } }).databases, hosted: [] });
  assert.equal(await unreadable.refusal(), null);
  const none = createDatabaseGate({ projectDatabases: createProjectReader({ github: { projectFile: async () => null } }).databases, hosted: [] });
  assert.equal(await none.refusal(), null);
});

test('a file that stops being read after a refusal is logged as not read, not as hosted again', async (t) => {
  const logged = [];
  t.mock.method(console, 'warn', (message) => logged.push(message));
  t.mock.method(console, 'log', (message) => logged.push(message));
  let databases = [{ engine: 'mongo' }];
  const gate = createDatabaseGate({ projectDatabases: async () => databases, hosted: ['postgres'] });
  assert.match(await gate.refusal(), /need mongo/);
  databases = null;
  assert.equal(await gate.refusal(), null);
  assert.deepEqual(logged, ['console: project databases not hosted', 'console: project file not read, its databases not checked']);
});
