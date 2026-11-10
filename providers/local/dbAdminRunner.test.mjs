import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDatabases } from '../../console/databases.mjs';
import { containerOutcome, createDbAdminRunner, ownerOf, secretsFor } from './dbAdminRunner.mjs';
import { createSecretStore } from './secretStore.mjs';

function setup({ roots = true, mongoHost = 'mongo:27017' } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'local-db-admin-'));
  const secretsDir = path.join(base, 'secrets');
  const secrets = createSecretStore({ dir: secretsDir, key: crypto.randomBytes(32) });
  const calls = [];
  const containers = new Map();
  const mounted = {};
  const modes = {};
  const contents = {};
  async function docker(args, env) {
    calls.push({ args, env });
    if (args[0] === 'run') {
      const id = args[args.indexOf('--name') + 1];
      const folder = args[args.indexOf('-v') + 1].split(':')[0];
      mounted[id] = fs.readdirSync(folder, { recursive: true }).sort();
      contents[id] = Object.fromEntries(mounted[id].filter((n) => n.endsWith('.json')).map((n) => [n, JSON.parse(fs.readFileSync(path.join(folder, n), 'utf8'))]));
      modes[id] = { runs: fs.statSync(path.dirname(folder)).mode & 0o777, folder: fs.statSync(folder).mode & 0o777,
        files: fs.readdirSync(folder, { recursive: true }).filter((n) => n.endsWith('.json')).map((n) => fs.statSync(path.join(folder, n)).mode & 0o777) };
      const forLabel = args.find((a) => a.startsWith('woodshed.db-admin.for='));
      containers.set(id, { Status: 'running', for: forLabel });
      return `${id}-container-id`;
    }
    if (args[0] === 'inspect') {
      const state = containers.get(args.at(-1));
      if (!state) throw Object.assign(new Error('failed'), { stderr: `Error: No such object: ${args.at(-1)}` });
      return JSON.stringify(state);
    }
    if (args[0] === 'rm') containers.delete(args.at(-1));
    if (args[0] === 'ps') {
      const wanted = args.filter((a) => a.startsWith('label=woodshed.db-admin.for=')).map((a) => a.slice('label='.length));
      return [...containers].filter(([, c]) => wanted.includes(c.for)).map(([id]) => id).join('\n');
    }
    return '';
  }
  const runner = createDbAdminRunner({
    image: 'woodshed-session', repoDir: '/work/app', seedSecrets: ['api-env'], secrets, postgresHost: 'postgres', postgresRootUser: 'postgres', mongoHost,
    network: 'woodshed', sessionEnv: { WOODSHED_SERVICES: 'S3_ENDPOINT', S3_ENDPOINT: 'http://s3:4566', OTHER: 'x' },
    runsDir: path.join(base, 'runs'), docker,
  });
  return { runner, secrets, calls, containers, mounted, modes, contents, runsDir: path.join(base, 'runs'), ready: roots ? Promise.all([
    secrets.write('db-root/postgres', 'pg-root-pw'), secrets.write('db-root/mongo', 'mongo-root-pw'), secrets.write('api-env', 'A=1'),
    secrets.write('users/mia/claude-token', 'sk-ant-x'), secrets.write('github-app-key', 'PEM'),
  ]) : Promise.resolve() };
}

test('a run gets the fixed flags, the command after --, and the root passwords by name only', async () => {
  const f = setup();
  await f.ready;
  await f.secrets.save('users/mia/database', 'mia-pw', 'Mia’s');
  const id = await f.runner.start(['reset', 'mia']);
  const { args, env } = f.calls.find((c) => c.args[0] === 'run');
  assert.deepEqual(args.slice(args.indexOf('--secrets-dir')), ['--secrets-dir', '/run/woodshed-secrets', '--pg-host', 'postgres',
    '--pg-root-user', 'postgres', '--pg-ca', 'none', '--mongo-host', 'mongo:27017', '--secret-prefix', '', '--repo', '/work/app', '--', 'reset', 'mia']);
  assert.deepEqual(args.slice(args.indexOf('--entrypoint'), args.indexOf('--entrypoint') + 3), ['--entrypoint', 'env', 'woodshed-session']);
  assert.ok(args.includes('--network') && args[args.indexOf('--network') + 1] === 'woodshed');
  assert.equal(env.PG_ROOT_PASSWORD, 'pg-root-pw');
  assert.equal(env.MONGO_ROOT_PASSWORD, 'mongo-root-pw');
  assert.ok(!args.join(' ').includes('pg-root-pw') && !args.join(' ').includes('mia-pw'), 'no password on the command line');
  assert.match(id, /^woodshed-db-admin-reset-/);
});

test('an installation with no Mongo gives a run no Mongo host and no Mongo root password, and needs none', async () => {
  const f = setup({ roots: false, mongoHost: null });
  await f.secrets.write('db-root/postgres', 'pg-root-pw');
  await f.runner.start(['template']);
  const { args, env } = f.calls.find((c) => c.args[0] === 'run');
  assert.deepEqual(args.slice(args.indexOf('--secrets-dir')), ['--secrets-dir', '/run/woodshed-secrets', '--pg-host', 'postgres',
    '--pg-root-user', 'postgres', '--pg-ca', 'none', '--secret-prefix', '', '--repo', '/work/app', '--', 'template']);
  assert.deepEqual(Object.keys(env).sort(), ['PG_ROOT_PASSWORD', 'S3_ENDPOINT', 'WOODSHED_SERVICES']);
});

test('a run sees only the secrets the AWS task role reads: its own database password and api-env', async () => {
  const f = setup();
  await f.ready;
  await f.secrets.save('users/mia/database', 'mia-pw', 'Mia’s');
  await f.secrets.save('sessions/0a1b2c3d/database', 's-pw', 'session');
  const reset = await f.runner.start(['reset', 'Mia']);
  const clone = await f.runner.start(['clone', '0a1b2c3d']);
  const drop = await f.runner.start(['drop', 'mia']);
  assert.deepEqual(f.mounted[reset], ['api-env.json', 'users', 'users/mia', 'users/mia/database.json']);
  assert.deepEqual(f.mounted[clone], ['api-env.json', 'sessions', 'sessions/0a1b2c3d', 'sessions/0a1b2c3d/database.json']);
  assert.deepEqual(f.mounted[drop], ['api-env.json']);
  assert.deepEqual(secretsFor(['template']), []);
});

test('without the root passwords no run starts, and no folder is left behind', async () => {
  const f = setup({ roots: false });
  await assert.rejects(f.runner.start(['template']), /no db-root\/postgres in the local secret store/);
  assert.ok(!f.calls.some((c) => c.args[0] === 'run'));
  assert.ok(!fs.existsSync(f.runsDir) || fs.readdirSync(f.runsDir).length === 0);
});

test('outcomes read each container: running waits, exit 0 is removed, a failure is kept without its secrets', async () => {
  const f = setup();
  await f.ready;
  const ok = await f.runner.start(['template']);
  const bad = await f.runner.start(['drop', 'mia']);
  assert.deepEqual(await f.runner.outcomes([ok, bad]), [{ done: false }, { done: false }]);
  f.containers.set(ok, { Status: 'exited', ExitCode: 0 });
  f.containers.set(bad, { Status: 'exited', ExitCode: 1 });
  assert.deepEqual(await f.runner.outcomes([ok, bad, 'gone']), [
    { done: true, ok: true, reason: null },
    { done: true, ok: false, reason: 'the run exited with 1' },
    { done: true, ok: false, reason: 'the container is gone, and its outcome with it' },
  ]);
  assert.ok(!f.containers.has(ok), 'a run that worked is removed');
  assert.ok(f.containers.has(bad), 'a failed one is kept for docker logs');
  assert.deepEqual(fs.readdirSync(f.runsDir), [], 'no run keeps its secrets');
  await f.runner.stop(bad);
  assert.ok(!f.containers.has(bad));
});

test('containerOutcome maps docker\'s states', () => {
  assert.deepEqual(containerOutcome({ status: 'created' }), { done: false });
  assert.deepEqual(containerOutcome({ status: 'dead', exitCode: 137 }), { done: true, ok: false, reason: 'the run exited with 137' });
});

test('the console\'s databases make a person\'s copy over the local runner, ready once the run exits 0', async () => {
  const f = setup();
  await f.ready;
  const store = { state: {}, save() {} };
  const databases = createDatabases({ store, secrets: f.secrets, dbAdmin: f.runner });
  assert.equal(databases.available, true);
  assert.equal((await databases.create('mia')).status, 'working');
  assert.ok(await f.secrets.read('users/mia/database'), 'the console made the password before the run');
  const id = store.state.databases.mia.taskArn;
  f.containers.set(id, { Status: 'exited', ExitCode: 0 });
  await databases.poll();
  assert.equal(databases.view('mia').status, 'ready');
});

test('a run\'s folder is readable by the container\'s own user, inside one only the console\'s user can open', async () => {
  const f = setup();
  await f.ready;
  await f.secrets.save('users/mia/database', 'mia-pw', 'Mia’s');
  const id = await f.runner.start(['reset', 'mia']);
  assert.deepEqual(f.modes[id], { runs: 0o700, folder: 0o755, files: [0o644, 0o644] });
});

test('a failed run is kept until the next run for the same owner, whatever its action, which removes it first', async () => {
  const f = setup();
  await f.ready;
  await f.secrets.save('users/mia/database', 'mia-pw', 'Mia’s');
  const failed = await f.runner.start(['reset', 'Mia']);
  const other = await f.runner.start(['drop', 'joel']);
  f.containers.set(failed, { ...f.containers.get(failed), Status: 'exited', ExitCode: 1 });
  await f.runner.outcomes([failed]);
  assert.ok(f.containers.has(failed), 'kept for docker logs');
  const drop = await f.runner.start(['drop', 'mia']);
  assert.ok(!f.containers.has(failed), 'a later drop of the same person removes the failed reset, root passwords and all');
  assert.ok(f.containers.has(drop) && f.containers.has(other), 'another owner\'s run is left alone');
});

test('a run gets the plain value it needs, not the sealed file, and never the key', async () => {
  const f = setup();
  await f.ready;
  await f.secrets.save('users/mia/database', 'mia-pw', 'Mia’s');
  const id = await f.runner.start(['reset', 'mia']);
  assert.deepEqual(f.contents[id], { 'api-env.json': { value: 'A=1' }, 'users/mia/database.json': { value: 'mia-pw' } });
  const run = f.calls.find((c) => c.args[0] === 'run');
  assert.deepEqual(Object.keys(run.env).sort(), ['MONGO_ROOT_PASSWORD', 'PG_ROOT_PASSWORD', 'S3_ENDPOINT', 'WOODSHED_SERVICES'],
    'the services the session env lists, and nothing else of it');
});

test('an owner\'s label cannot be another\'s: a login spelled like a session id, or named template', () => {
  assert.equal(ownerOf(['reset', 'Mia']), 'user:mia');
  assert.equal(ownerOf(['drop', 'mia']), 'user:mia');
  assert.equal(ownerOf(['clone', '0a1b2c3d']), 'session:0a1b2c3d');
  assert.equal(ownerOf(['drop-session', '0a1b2c3d']), 'session:0a1b2c3d');
  assert.notEqual(ownerOf(['reset', '0a1b2c3d']), ownerOf(['clone', '0a1b2c3d']));
  assert.notEqual(ownerOf(['reset', 'template']), ownerOf(['template']));
});
