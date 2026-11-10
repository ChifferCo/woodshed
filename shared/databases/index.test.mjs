import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ENGINES, ENGINE_NAMES, databaseCommands, databaseEnv, engine, hostedEngines, notHostedReason, viewersOf } from './index.mjs';

const PG = { engine: 'postgres', dir: 'api', migrate: 'make migrate', seed: 'make seed', envFiles: [], paths: [], migrations: null, user: 'app_user', name: 'app' };
const MONGO = { ...PG, engine: 'mongo', migrate: null, seed: 'make seed-mongo', user: null, name: null };
const CREDENTIALS = { user: 'woodshed__0a1b2c3d', password: 'ab'.repeat(24), name: 'woodshed__0a1b2c3d' };

// What an engine is: a new one is a module with these, and the rest of Woodshed reads it from them alone.
test('every engine has the whole interface', () => {
  assert.deepEqual(ENGINE_NAMES, ['postgres', 'mongo']);
  for (const [name, e] of Object.entries(ENGINES)) {
    assert.equal(e.name, name);
    assert.equal(typeof e.label, 'string', name);
    assert.ok(e.flags.length > 0 && e.flags.every((f) => /^[a-z]+-[a-z-]+$/.test(f)), `${name}'s db-admin flags`);
    assert.match(e.rootPassword, /^[A-Z]+_ROOT_PASSWORD$/, name);
    for (const fn of ['loadDriver', 'hostedIn', 'givenIn', 'sessionEnv', 'seedEnv', 'startViewers', 'admin']) assert.equal(typeof e[fn], 'function', `${name}.${fn}`);
    assert.ok(Array.isArray(e.secretVariables) && e.secretVariables.length > 0, name);
    for (const v of e.viewers) assert.ok(/^[a-z-]+$/.test(v.route) && Number.isInteger(v.port) && v.name && v.program, `${name}'s viewer ${v.route}`);
  }
  const flags = ENGINE_NAMES.flatMap((name) => ENGINES[name].flags);
  assert.equal(new Set(flags).size, flags.length, 'no two engines share a flag');
  const routes = viewersOf(ENGINE_NAMES).map((v) => v.route);
  assert.equal(new Set(routes).size, routes.length, 'no two viewers share a route');
  assert.throws(() => engine('mysql'), /no database engine called mysql \(there are postgres, mongo\)/);
});

test('an installation hosts the engines whose server the session\'s environment names', () => {
  assert.deepEqual(hostedEngines({}), []);
  assert.deepEqual(hostedEngines({ PGHOST: 'db' }), ['postgres']);
  assert.deepEqual(hostedEngines({ WOODSHED_MONGO_HOST: 'mongo:27017' }), ['mongo']);
  assert.deepEqual(hostedEngines({ PGHOST: 'db', MONGODB_URI: 'mongodb://x' }), ['postgres', 'mongo']);
});

test('a project whose databases need an engine the installation does not host is refused, naming both', () => {
  assert.equal(notHostedReason({ project: { databases: [] }, hosted: [] }), null);
  assert.equal(notHostedReason({ project: { databases: [PG] }, hosted: ['postgres', 'mongo'] }), null);
  assert.equal(notHostedReason({ project: { databases: [PG, MONGO] }, hosted: ['postgres'] }),
    'the project file\'s databases need mongo, which this installation does not host (it hosts postgres)');
  assert.equal(notHostedReason({ project: { databases: [MONGO] }, hosted: [] }),
    'the project file\'s databases need mongo, which this installation does not host (it hosts none)');
});

test('each engine gives a session its own variables, from the installation\'s server and the console\'s credentials', () => {
  const both = databaseEnv({ project: { databases: [PG, MONGO] }, env: { PGHOST: 'db.rds', PGSSLMODE: 'verify-full', WOODSHED_MONGO_HOST: '10.0.0.10:27017' }, credentials: CREDENTIALS });
  assert.deepEqual(both, {
    PGHOST: 'db.rds', PGPORT: '5432', PGUSER: CREDENTIALS.user, PGPASSWORD: CREDENTIALS.password, PGDATABASE: CREDENTIALS.name, PGSSLMODE: 'verify-full',
    PG_URL: `postgres://${CREDENTIALS.user}:${CREDENTIALS.password}@db.rds:5432/${CREDENTIALS.name}?sslmode=verify-full`,
    MONGODB_URI: `mongodb://${CREDENTIALS.user}:${CREDENTIALS.password}@10.0.0.10:27017/${CREDENTIALS.name}?authSource=${CREDENTIALS.name}`,
  });
  // Only the project's databases: a Mongo the installation hosts and the project does not use is no variable.
  assert.deepEqual(Object.keys(databaseEnv({ project: { databases: [PG] }, env: { PGHOST: 'db', WOODSHED_MONGO_HOST: 'm:1' }, credentials: CREDENTIALS })),
    ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PG_URL']);
  // The docker launcher: what the environment names, then the project file's user and name.
  const given = databaseEnv({ project: { databases: [PG, MONGO] }, env: { PGHOST: 'db', PGPASSWORD: 'p@ss', MONGODB_URI: 'mongodb://given/x' } });
  assert.deepEqual([given.PGUSER, given.PGDATABASE, given.MONGODB_URI], ['app_user', 'app', 'mongodb://given/x']);
  assert.equal(given.PG_URL, 'postgres://app_user:p%40ss@db:5432/app', 'escaped in the URL');
});

test('the template commands are each database\'s migrate, then its seed for a new template, in the list\'s order', () => {
  const project = { databases: [PG, MONGO] };
  assert.deepEqual(databaseCommands(project, 'seed').map((c) => `${c.engine}: ${c.command}`), ['postgres: make migrate', 'postgres: make seed', 'mongo: make seed-mongo']);
  assert.deepEqual(databaseCommands(project, 'migrate').map((c) => c.command), ['make migrate']);
});

test('each engine\'s viewers start on the session\'s own database, with the password out of their arguments', () => {
  const started = [];
  const env = { PGHOST: 'db', PGUSER: 'u', PGPASSWORD: 'secret', PGDATABASE: 'd', MONGODB_URI: 'mongodb://u:secret@m:27017/d?authSource=d' };
  for (const name of ENGINE_NAMES) engine(name).startViewers({ env, sessionId: '0a1b2c3d', own: false, start: (v) => started.push(v), log: () => {} });
  assert.deepEqual(started.map((v) => v.name), ['pgweb', 'mongo-express']);
  for (const v of started) assert.ok(!v.args.join(' ').includes('secret'), `${v.name}'s arguments`);
  assert.match(started[0].env.PGWEB_DATABASE_URL, /^postgres:\/\/u:secret@db:5432\/d\?sslmode=disable$/);
  assert.equal(started[1].env.ME_CONFIG_SITE_BASEURL, '/mongo/0a1b2c3d/');
  const own = [];
  engine('mongo').startViewers({ env, sessionId: '0a1b2c3d', own: true, start: (v) => own.push(v), log: () => {} });
  assert.deepEqual(own.map((v) => v.env.ME_CONFIG_MONGODB_URL), [env.MONGODB_URI, 'mongodb://u:secret@m:27017/d__restore?authSource=d'],
    'a private session\'s second viewer is on its restore copy');
});

test('pgweb\'s connection string encodes the user, password and database, so a password with @, / or # still connects', () => {
  const started = [];
  const env = { PGHOST: 'db', PGPORT: '5432', PGUSER: 'app user', PGPASSWORD: 'p@ss/w#rd', PGDATABASE: 'app', PGSSLMODE: 'disable' };
  engine('postgres').startViewers({ env, sessionId: '0a1b2c3d', own: false, start: (v) => started.push(v), log: () => {} });
  const target = new URL(started[0].env.PGWEB_DATABASE_URL);
  assert.deepEqual([decodeURIComponent(target.username), decodeURIComponent(target.password), target.hostname, target.pathname],
    ['app user', 'p@ss/w#rd', 'db', '/app']);
});
