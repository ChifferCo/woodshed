import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDatabases, databaseName } from './databases.mjs';
// The real ECS runner over a fake AWS CLI.
import { createDbAdminRunner } from '../providers/aws/dbAdminRunner.mjs';

const ECS = { cluster: 'woodshed-cloud', dbAdminTaskDefinition: 'woodshed-cloud-db-admin', subnets: ['subnet-1'], securityGroup: 'sg-1' };

function fakes() {
  const store = { state: {}, saves: 0, save() { this.saves++; } };
  const values = new Map();
  const secrets = {
    read: async (name) => values.get(name) ?? null,
    save: async (name, value) => { values.set(name, value); },
    remove: async (name) => { values.delete(name); },
  };
  const calls = [];
  const tasks = new Map();
  let next = 0;
  const aws = async (args) => {
    calls.push(args);
    if (args[1] === 'run-task') {
      const taskArn = `arn:task/${++next}`;
      tasks.set(taskArn, { taskArn, lastStatus: 'RUNNING', containers: [{ name: 'db-admin' }] });
      return { tasks: [{ taskArn }] };
    }
    if (args[1] === 'describe-tasks') return { tasks: args.slice(args.indexOf('--tasks') + 1).map((a) => tasks.get(a)).filter(Boolean) };
    return {};
  };
  const finish = (taskArn, exitCode) => tasks.set(taskArn, { taskArn, lastStatus: 'STOPPED', containers: [{ name: 'db-admin', exitCode }] });
  return { store, values, secrets, calls, aws, finish, tasks };
}

test('a session tried again after AWS had no room does not copy its databases twice', async () => {
  const { store, secrets, aws, calls } = fakes();
  const databases = createDatabases({ store, secrets, dbAdmin: createDbAdminRunner({ ecs: ECS, aws }) });
  await databases.createForSession('0a1b2c3d');
  await databases.createForSession('0a1b2c3d');
  assert.equal(calls.filter((c) => c[1] === 'run-task').length, 1);
});

test('a drop that never finished can be asked for again once it is past the retry time', async () => {
  let clock = Date.parse('2026-10-26T10:00:00Z');
  const { store, secrets, aws, calls } = fakes();
  const databases = createDatabases({ store, secrets, dbAdmin: createDbAdminRunner({ ecs: ECS, aws }), now: () => clock });
  store.state.sessionDatabases = { '0a1b2c3d': { status: 'working', action: 'remove', taskArn: 'arn:task/old', startedAt: new Date(clock).toISOString() } };
  await assert.rejects(databases.dropSessionNow('0a1b2c3d', 'joel'), /still running/);
  clock += 11 * 60_000;
  await databases.dropSessionNow('0a1b2c3d', 'joel');
  assert.ok(calls.some((c) => c[1] === 'stop-task' && c.includes('arn:task/old')), 'the stuck task is stopped first');
  assert.equal(calls.filter((c) => c[1] === 'run-task').length, 1);
});

test('the databases a person has are on the engines the provider hosts, and none without a db-admin', () => {
  const f = fakes();
  const both = createDatabases({ store: f.store, secrets: f.secrets, dbAdmin: createDbAdminRunner({ ecs: ECS, aws: f.aws }), engines: ['postgres', 'mongo'] });
  assert.deepEqual([both.view('mia').engines, both.view('mia').labels], [['postgres', 'mongo'], ['Postgres', 'Mongo']]);
  const pg = createDatabases({ store: f.store, secrets: f.secrets, dbAdmin: createDbAdminRunner({ ecs: ECS, aws: f.aws }), engines: ['postgres'] });
  assert.deepEqual(pg.engines, ['postgres']);
  const none = createDatabases({ store: f.store, secrets: f.secrets, dbAdmin: null, engines: ['postgres'] });
  assert.deepEqual([none.available, none.engines], [false, []]);
});

test('databaseName matches what dbAdmin.mjs makes for a login', () => {
  assert.equal(databaseName('Octocat'), 'woodshed_octocat');
  assert.equal(databaseName('mia-dev'), 'woodshed_mia_dev');
});

test('a person\'s databases: a password of their own, the task\'s reset, then ready once it exits 0', async () => {
  const f = fakes();
  const db = createDatabases({ store: f.store, secrets: f.secrets, dbAdmin: createDbAdminRunner({ ecs: ECS, aws: f.aws }), now: () => Date.parse('2026-10-24T10:00:00Z') });
  assert.equal(db.view('mia-dev').status, 'none');
  assert.equal(await db.credentials('mia-dev'), null);

  await db.create('mia-dev');
  const password = f.values.get('users/mia-dev/database');
  assert.match(password, /^[0-9a-f]{48}$/, 'hex, which dbAdmin.mjs accepts and a URI needs no escaping for');
  const run = f.calls.find((c) => c[1] === 'run-task');
  const overrides = JSON.parse(run[run.indexOf('--overrides') + 1]);
  assert.deepEqual(overrides, { containerOverrides: [{ name: 'db-admin', command: ['reset', 'mia-dev'] }] }, 'only a command: no environment, no host');
  assert.equal(db.view('mia-dev').status, 'working');
  assert.equal(await db.credentials('mia-dev'), null, 'not while the task runs');
  await assert.rejects(db.create('mia-dev'), /busy/, 'one change at a time');

  await db.poll();
  assert.equal(db.view('mia-dev').status, 'working');
  f.finish('arn:task/1', 0);
  await db.poll();
  assert.equal(db.view('mia-dev').status, 'ready');
  assert.deepEqual(await db.credentials('mia-dev'), { user: 'woodshed_mia_dev', password, name: 'woodshed_mia_dev' });

  await db.create('mia-dev');
  assert.equal(db.view('mia-dev').action, 'reset');
  assert.equal(f.values.get('users/mia-dev/database'), password, 'a reset keeps the password');
});

test('a failed task is shown with its reason, and trying again starts a new one', async () => {
  const f = fakes();
  const db = createDatabases({ store: f.store, secrets: f.secrets, dbAdmin: createDbAdminRunner({ ecs: ECS, aws: f.aws }) });
  await db.create('mia-dev');
  f.finish('arn:task/1', 1);
  await db.poll();
  assert.equal(db.view('mia-dev').status, 'failed');
  assert.equal(db.view('mia-dev').error, 'the task exited with 1');
  await db.create('mia-dev');
  assert.equal(db.view('mia-dev').action, 'create');
  assert.equal(db.view('mia-dev').error, null);
});

test('a task with no result in 30 minutes is stopped and called failed', async () => {
  const f = fakes();
  let clock = Date.parse('2026-10-24T10:00:00Z');
  const db = createDatabases({ store: f.store, secrets: f.secrets, dbAdmin: createDbAdminRunner({ ecs: ECS, aws: f.aws }), now: () => clock });
  await db.create('mia-dev');
  clock += 31 * 60_000;
  await db.poll();
  assert.equal(db.view('mia-dev').status, 'failed');
  assert.ok(f.calls.some((c) => c[1] === 'stop-task'));
});

test('Remove My Woodshed drops them with the task, and forgets the record once that succeeds', async () => {
  const f = fakes();
  const db = createDatabases({ store: f.store, secrets: f.secrets, dbAdmin: createDbAdminRunner({ ecs: ECS, aws: f.aws }) });
  await db.remove('mia-dev');
  assert.equal(f.calls.length, 0, 'nothing to drop for someone who never had any');

  await db.create('mia-dev');
  f.finish('arn:task/1', 0);
  await db.poll();
  await db.remove('mia-dev');
  const run = f.calls.filter((c) => c[1] === 'run-task').pop();
  assert.deepEqual(JSON.parse(run[run.indexOf('--overrides') + 1]).containerOverrides[0].command, ['drop', 'mia-dev']);
  f.finish('arn:task/2', 0);
  await db.poll();
  assert.equal(db.view('mia-dev').status, 'none');
});

test('Remove My Woodshed while a task is still running stops it and drops them', async () => {
  const f = fakes();
  const db = createDatabases({ store: f.store, secrets: f.secrets, dbAdmin: createDbAdminRunner({ ecs: ECS, aws: f.aws }) });
  await db.create('mia-dev');
  await db.remove('mia-dev');
  assert.ok(f.calls.some((c) => c[1] === 'stop-task' && c.includes('arn:task/1')));
  const run = f.calls.filter((c) => c[1] === 'run-task').pop();
  assert.deepEqual(JSON.parse(run[run.indexOf('--overrides') + 1]).containerOverrides[0].command, ['drop', 'mia-dev']);
  assert.equal(db.view('mia-dev').status, 'working');
});

test('a shared session\'s databases: copied with a password of their own, handed out once ready', async () => {
  const f = fakes();
  const db = createDatabases({ store: f.store, secrets: f.secrets, dbAdmin: createDbAdminRunner({ ecs: ECS, aws: f.aws }) });
  assert.deepEqual(await db.sessionDatabase('0a1b2c3d'), { status: 'none', database: null, error: null });

  await db.createForSession('0a1b2c3d');
  const password = f.values.get('sessions/0a1b2c3d/database');
  assert.match(password, /^[0-9a-f]{48}$/);
  const run = f.calls.find((c) => c[1] === 'run-task');
  assert.deepEqual(JSON.parse(run[run.indexOf('--overrides') + 1]).containerOverrides, [{ name: 'db-admin', command: ['clone', '0a1b2c3d'] }]);
  assert.deepEqual(await db.sessionDatabase('0a1b2c3d'), { status: 'working', database: null, error: null }, 'nothing until the copy is made');

  f.finish('arn:task/1', 0);
  await db.poll();
  assert.deepEqual(await db.sessionDatabase('0a1b2c3d'), {
    status: 'ready', database: { user: 'woodshed__0a1b2c3d', password, name: 'woodshed__0a1b2c3d' }, error: null,
  });
  assert.equal(db.view('0a1b2c3d').status, 'none', 'a session\'s databases are not a person\'s');
});

test('the sweep drops an ended session\'s databases and its password, and leaves an active one alone', async () => {
  const f = fakes();
  const db = createDatabases({ store: f.store, secrets: f.secrets, dbAdmin: createDbAdminRunner({ ecs: ECS, aws: f.aws }) });
  await db.createForSession('0a1b2c3d');
  await db.createForSession('1b2c3d4e');
  f.finish('arn:task/1', 0);
  f.finish('arn:task/2', 0);
  await db.poll();

  await db.sweep(new Set(['0a1b2c3d', '1b2c3d4e']));
  assert.equal(f.calls.filter((c) => c[1] === 'run-task').length, 2, 'both still active: nothing to drop');

  await db.sweep(new Set(['1b2c3d4e']));
  const run = f.calls.filter((c) => c[1] === 'run-task').pop();
  assert.deepEqual(JSON.parse(run[run.indexOf('--overrides') + 1]).containerOverrides[0].command, ['drop-session', '0a1b2c3d']);
  assert.equal((await db.sessionDatabase('0a1b2c3d')).status, 'none', 'never handed out once its drop has started');
  await db.sweep(new Set(['1b2c3d4e']));
  assert.equal(f.calls.filter((c) => c[1] === 'run-task').length, 3, 'one drop at a time');

  f.finish('arn:task/3', 0);
  await db.poll();
  assert.equal(f.store.state.sessionDatabases['0a1b2c3d'], undefined);
  assert.equal(f.values.has('sessions/0a1b2c3d/database'), false, 'the password goes with them');
  assert.ok(f.values.has('sessions/1b2c3d4e/database'));
});

test('a session that ends while its copy is still running has the copy stopped, then dropped', async () => {
  const f = fakes();
  const db = createDatabases({ store: f.store, secrets: f.secrets, dbAdmin: createDbAdminRunner({ ecs: ECS, aws: f.aws }) });
  await db.createForSession('0a1b2c3d');
  await db.sweep(new Set());
  assert.ok(f.calls.some((c) => c[1] === 'stop-task' && c.includes('arn:task/1')));
  const run = f.calls.filter((c) => c[1] === 'run-task').pop();
  assert.deepEqual(JSON.parse(run[run.indexOf('--overrides') + 1]).containerOverrides[0].command, ['drop-session', '0a1b2c3d']);
});

test('a drop that failed is tried again by a later sweep, not by every one', async () => {
  const f = fakes();
  let clock = Date.parse('2026-10-26T10:00:00Z');
  const db = createDatabases({ store: f.store, secrets: f.secrets, dbAdmin: createDbAdminRunner({ ecs: ECS, aws: f.aws }), now: () => clock });
  await db.createForSession('0a1b2c3d');
  f.finish('arn:task/1', 1);
  await db.poll();
  assert.equal((await db.sessionDatabase('0a1b2c3d')).status, 'failed', 'a failed copy');
  await db.sweep(new Set());
  f.finish('arn:task/2', 1);
  await db.poll();
  await db.sweep(new Set());
  assert.equal(f.calls.filter((c) => c[1] === 'run-task').length, 2, 'not straight away');
  clock += 11 * 60_000;
  await db.sweep(new Set());
  assert.equal(f.calls.filter((c) => c[1] === 'run-task').length, 3);
  assert.ok(f.values.has('sessions/0a1b2c3d/database'), 'kept until a drop works');
});

test('a copy that never starts takes its password with it, and a drop whose password stays is tried again', async () => {
  const f = fakes();
  const refusing = async (args) => (args[1] === 'run-task' ? { tasks: [], failures: [{ reason: 'RESOURCE:MEMORY' }] } : f.aws(args));
  const db = createDatabases({ store: f.store, secrets: f.secrets, dbAdmin: createDbAdminRunner({ ecs: ECS, aws: refusing }) });
  await assert.rejects(db.createForSession('0a1b2c3d'), /RESOURCE:MEMORY/);
  assert.equal(f.values.has('sessions/0a1b2c3d/database'), false, 'no record for the sweep to find, so no password either');

  const ok = createDatabases({ store: f.store, secrets: f.secrets, dbAdmin: createDbAdminRunner({ ecs: ECS, aws: f.aws }) });
  await ok.createForSession('1b2c3d4e');
  f.finish('arn:task/1', 0);
  await ok.poll();
  await ok.sweep(new Set());
  f.finish('arn:task/2', 0);
  const remove = f.secrets.remove;
  f.secrets.remove = async () => { throw new Error('ThrottlingException'); };
  await assert.rejects(ok.poll(), /Throttling/);
  assert.ok(f.store.state.sessionDatabases['1b2c3d4e'], 'the record stays while its password does');
  f.secrets.remove = remove;
  await ok.poll();
  assert.equal(f.store.state.sessionDatabases['1b2c3d4e'], undefined);
  assert.equal(f.values.has('sessions/1b2c3d4e/database'), false);
});

test('without a db-admin task definition there are no own databases', async () => {
  const f = fakes();
  const db = createDatabases({ store: f.store, secrets: f.secrets, dbAdmin: null });
  assert.equal(db.available, false);
  await assert.rejects(db.create('mia-dev'), /no db-admin task/);
});

test('a resumed shared session keeps the databases it has, and copies none again', async () => {
  const f = fakes();
  const db = createDatabases({ store: f.store, secrets: f.secrets, dbAdmin: createDbAdminRunner({ ecs: ECS, aws: f.aws }) });
  await db.createForSession('0a1b2c3d');
  f.finish('arn:task/1', 0);
  await db.poll();
  const copies = () => f.calls.filter((c) => c[1] === 'run-task').length;
  assert.equal(copies(), 1);
  await db.createForSession('0a1b2c3d');
  assert.equal(copies(), 1);
  assert.equal((await db.sessionDatabase('0a1b2c3d')).status, 'ready');
  await db.sweep(new Set(['0a1b2c3d']));
  assert.equal(copies(), 1, 'a kept session\'s databases are left alone by the sweep');
});
