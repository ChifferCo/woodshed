import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadConfig, requireClosedWhenReachable, requireRepo } from '../console/config.mjs';
import { defaultProject } from '../console/projects.mjs';
import { createProvider, providerName } from './console.mjs';

test('the provider follows WOODSHED_PROVIDER, or the launcher as it always did', () => {
  assert.equal(providerName({}), 'local', 'the docker launcher is the default, so the local provider is');
  assert.equal(providerName({ WOODSHED_LAUNCHER: 'docker' }), 'local');
  assert.equal(providerName({ WOODSHED_LAUNCHER: 'ecs' }), 'aws');
  assert.equal(providerName({ WOODSHED_PROVIDER: 'aws', WOODSHED_LAUNCHER: 'ecs' }), 'aws');
});

test('a provider and a launcher that disagree, or an unknown provider, stop the start', () => {
  assert.throws(() => providerName({ WOODSHED_PROVIDER: 'aws' }), /WOODSHED_PROVIDER=aws needs WOODSHED_LAUNCHER=ecs \(it is docker\)/);
  assert.throws(() => providerName({ WOODSHED_PROVIDER: 'local', WOODSHED_LAUNCHER: 'ecs' }), /needs WOODSHED_LAUNCHER=docker/);
  assert.throws(() => providerName({ WOODSHED_PROVIDER: 'hetzner' }), /unknown WOODSHED_PROVIDER "hetzner" \(expected aws or local\)/);
});

test('each provider hands the console a launcher, and AWS the CLI its stores go through', () => {
  const local = createProvider(loadConfig({ GH_TOKEN: 'x' }), {});
  // With no secrets folder the dashboard chooses the store: a slot that has none until then.
  assert.deepEqual([local.name, local.secrets.configured(), typeof local.secrets.configure, local.dbAdmin, local.webhooks, typeof local.launcher.start],
    ['local', false, 'function', null, null, 'function']);
  const env = { GH_TOKEN: 'x', WOODSHED_LAUNCHER: 'ecs', WOODSHED_ECS_CLUSTER: 'c', WOODSHED_ECS_TASK_DEFINITION: 't', WOODSHED_DATABASES: '' };
  const aws = createProvider(loadConfig(env), env);
  assert.deepEqual([aws.name, typeof aws.launcher.start, aws.dbAdmin, aws.databases], ['aws', 'function', null, []]);
});

test('the AWS provider makes the databases Terraform names, and stops at start when its settings disagree', () => {
  const base = { GH_TOKEN: 'x', WOODSHED_LAUNCHER: 'ecs', WOODSHED_ECS_CLUSTER: 'c', WOODSHED_ECS_TASK_DEFINITION: 't' };
  const start = (more) => createProvider(loadConfig({ ...base, ...more }), { ...base, ...more });
  const both = start({ WOODSHED_DATABASES: 'postgres,mongo', WOODSHED_ECS_DB_ADMIN_TASK_DEFINITION: 'd' });
  assert.deepEqual([both.databases, typeof both.dbAdmin.start, both.words.databasesPlace], [['postgres', 'mongo'], 'function', 'RDS and Mongo']);
  const pg = start({ WOODSHED_DATABASES: 'postgres', WOODSHED_ECS_DB_ADMIN_TASK_DEFINITION: 'd' });
  assert.deepEqual([pg.databases, pg.words.databasesPlace], [['postgres'], 'RDS']);
  assert.equal(start({ WOODSHED_DATABASES: '' }).words.databasesPlace, null);
  assert.throws(() => start({}), /WOODSHED_DATABASES is not set/);
  assert.throws(() => start({ WOODSHED_DATABASES: 'postgres' }), /names postgres, and there is no WOODSHED_ECS_DB_ADMIN_TASK_DEFINITION/);
  assert.throws(() => start({ WOODSHED_DATABASES: '', WOODSHED_ECS_DB_ADMIN_TASK_DEFINITION: 'd' }), /names no database for it to make/);
  // Each engine on its own: Mongo without Postgres.
  assert.deepEqual(start({ WOODSHED_DATABASES: 'mongo', WOODSHED_ECS_DB_ADMIN_TASK_DEFINITION: 'd' }).databases, ['mongo']);
  assert.throws(() => start({ WOODSHED_DATABASES: 'postgres,redis' }), /redis is not a database/);
});

test('a setting only AWS can serve stops a start on the local provider, naming it', () => {
  const env = { GH_TOKEN: 'x', WOODSHED_HOMES_BUCKET: 'b', WOODSHED_WEBHOOK_QUEUE: 'q' };
  assert.throws(() => createProvider(loadConfig(env), env),
    /WOODSHED_HOMES_BUCKET, WOODSHED_WEBHOOK_QUEUE need the aws provider; this console runs on the local provider/);
  const off = { GH_TOKEN: 'x', WOODSHED_WEBHOOK_QUEUE: '0' };
  assert.equal(createProvider(loadConfig(off), off).name, 'local', 'a queue turned off asks for nothing');
});

test('a setting only the local provider serves stops a start on AWS, naming it', () => {
  const env = { GH_TOKEN: 'x', WOODSHED_LAUNCHER: 'ecs', WOODSHED_ECS_CLUSTER: 'c', WOODSHED_ECS_TASK_DEFINITION: 't', WOODSHED_LOCAL_SECRETS_DIR: '/s' };
  assert.throws(() => createProvider(loadConfig(env), env), /WOODSHED_LOCAL_SECRETS_DIR needs the local provider; this console runs on the aws provider/);
  const files = { ...env, WOODSHED_LOCAL_SECRETS_DIR: '', WOODSHED_PROJECT_FILES_DIR: '/srv/project-files' };
  assert.throws(() => createProvider(loadConfig(files), files), /WOODSHED_PROJECT_FILES_DIR needs the local provider; this console runs on the aws provider/);
});

test('a console may start with no repo, but one it names must be owner/name', () => {
  assert.deepEqual(loadConfig({ GH_TOKEN: 'x' }).projects, []);
  assert.doesNotThrow(() => requireRepo(loadConfig({ GH_TOKEN: 'x' })), 'no repo: an admin adds the first on the Console settings page');
  assert.equal(defaultProject(loadConfig({ GH_TOKEN: 'x' })).repo, '');
  assert.throws(() => requireRepo(loadConfig({ GH_TOKEN: 'x', WOODSHED_REPO: 'just-a-name' })), /owner\/name/);
  assert.doesNotThrow(() => requireRepo(loadConfig({ GH_TOKEN: 'x', WOODSHED_REPO: ' acme/web.app ' })));
  assert.equal(defaultProject(loadConfig({ GH_TOKEN: 'x', WOODSHED_REPO: ' acme/web.app ' })).repo, 'acme/web.app');
});

test('a console other machines reach will not start without sign-in required', () => {
  const at = (host, extra = {}) => () => requireClosedWhenReachable(loadConfig({ GH_TOKEN: 'x', WOODSHED_REPO: 'acme/app', ...(host ? { WOODSHED_HOST: host } : {}), ...extra }));
  for (const host of [null, '127.0.0.1', '127.0.1.1', '::1', 'localhost']) assert.doesNotThrow(at(host), String(host));
  assert.throws(at('0.0.0.0'), /WOODSHED_HOST is 0\.0\.0\.0, which other machines reach, and sign-in is not required: set WOODSHED_REQUIRE_SIGN_IN=1/);
  assert.throws(at('203.0.113.10'), /set WOODSHED_REQUIRE_SIGN_IN=1/);
  assert.doesNotThrow(at('0.0.0.0', { WOODSHED_REQUIRE_SIGN_IN: '1' }), 'sign-in from the first request: as the base box runs');
});

test('WOODSHED_ENV_FILES and WOODSHED_DB_ENV_SECRETS are not read any more: a console that still has them says so, and starts', (t) => {
  const warned = [];
  t.mock.method(console, 'warn', (...args) => warned.push(args));
  const config = loadConfig({ GH_TOKEN: 'x' });
  assert.equal('envFiles' in config || 'dbEnvSecrets' in config, false);
  assert.equal(warned.length, 0, 'nothing to say without them');
  // Even a value that was never a pair: it is not read, so it cannot stop the start, and it is never repeated.
  const old = loadConfig({ GH_TOKEN: 'x', WOODSHED_ENV_FILES: 'api-env=api/.env,ghp_pastedValue123', WOODSHED_CLOUD_DB_ENV_SECRETS: 'api-env' });
  assert.equal('envFiles' in old, false);
  const said = warned.filter(([message]) => message === 'console: ignored: env files are Repo settings now');
  assert.deepEqual(said.map(([, fields]) => fields), [{ settings: ['WOODSHED_ENV_FILES', 'WOODSHED_DB_ENV_SECRETS'] }]);
  assert.ok(!JSON.stringify(warned).includes('ghp_'));
});

test('the install secrets are secret=VARIABLE pairs, from WOODSHED_INSTALL_SECRET_PAIRS, in none of Woodshed\'s own variables', async () => {
  const { installSecrets } = await import('../console/config.mjs');
  assert.deepEqual(loadConfig({ GH_TOKEN: 'x' }).installSecrets, []);
  assert.deepEqual(loadConfig({ GH_TOKEN: 'x', WOODSHED_INSTALL_SECRET_PAIRS: 'registry-token=REGISTRY_TOKEN, other-token=_OTHER' }).installSecrets,
    [{ secret: 'registry-token', variable: 'REGISTRY_TOKEN' }, { secret: 'other-token', variable: '_OTHER' }]);
  const bad = (value) => () => installSecrets({ WOODSHED_INSTALL_SECRET_PAIRS: value });
  assert.throws(bad('registry-token'), /secret=VARIABLE pairs/);
  assert.throws(bad('Registry=REGISTRY_TOKEN'), /secret=VARIABLE pairs/);
  assert.throws(bad('registry-token=registry_token'), /secret=VARIABLE pairs/);
  assert.throws(bad('registry-token=1TOKEN'), /secret=VARIABLE pairs/);
  assert.throws(bad('registry-token=WOODSHED_TOKEN'), /one of Woodshed's own session variables/);
  assert.throws(bad('registry-token=GH_TOKEN'), /one of Woodshed's own session variables/);
  assert.throws(bad('a-token=TOKEN,b-token=TOKEN'), /pair 2 is named twice/);
  assert.throws(bad('a-token=TOKEN,a-token=OTHER'), /pair 2 is named twice/);
  // A value pasted where a name belongs is said by its place, and never repeated into the console's log.
  assert.throws(bad('ok-token=OK,registry-token=ghp_pastedValue123'), (err) => /pair 2 is not/.test(err.message) && !err.message.includes('ghp_'));
  assert.throws(bad('registry-token=REGISTRY_TOKEN=ghp_pastedValue123'), (err) => /pair 1 is not/.test(err.message) && !err.message.includes('ghp_'));
  // The place counts the commas as written, empty pairs too.
  assert.throws(bad('a-token=A,,b-token=bad'), /pair 3 is not/);
  for (const name of ['anthropic-api-key', 'openai-api-key', 'github-app-key', 'github-app-client-secret', 'github-webhook-secret', 'slack-bot-token', 'slack-signing-secret']) {
    assert.throws(bad(`${name}=REGISTRY_TOKEN`), /one of the console's own secrets/, name);
  }
});

// Terraform cannot import the list, so its install_secrets validation repeats it: they must not drift apart.
test('Terraform refuses the same session variables for an install secret as the console does', async () => {
  const { SESSION_VARIABLES } = await import('../shared/reservedNames.mjs');
  const fs = await import('node:fs');
  const tf = fs.readFileSync(new URL('./aws/terraform/variables.tf', import.meta.url), 'utf8');
  const block = tf.slice(tf.indexOf('variable "install_secrets"'), tf.indexOf('variable "database_env_secrets"'));
  const listed = /!contains\(\s*\[("SESSION_ID"[^\]]*)\]/.exec(block)?.[1] ?? '';
  assert.deepEqual([...listed.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]), [...SESSION_VARIABLES]);
  assert.match(block, /!startswith\(env_name, "WOODSHED_"\)/);
});

test('the console\'s own secrets are the ones Terraform refuses for an install secret, and the project file\'s check for an env file', async () => {
  const { CONSOLE_SECRETS } = await import('../shared/reservedNames.mjs');
  const { secretSpecs } = await import('../console/secrets.mjs');
  const fs = await import('node:fs');
  assert.deepEqual(secretSpecs().map((s) => s.name).sort(), [...CONSOLE_SECRETS].sort());
  const tf = fs.readFileSync(new URL('./aws/terraform/variables.tf', import.meta.url), 'utf8');
  const block = tf.slice(tf.indexOf('variable "install_secrets"'), tf.indexOf('variable "database_env_secrets"'));
  const listed = /!contains\(\s*\[("anthropic-api-key"[^\]]*)\]/.exec(block)?.[1] ?? '';
  assert.deepEqual([...listed.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]).sort(), [...CONSOLE_SECRETS].sort());
});

test('WOODSHED_START_CHECK=1 loads the console and its settings, then exits without listening; a bad setting fails it', () => {
  const file = fileURLToPath(new URL('./console.mjs', import.meta.url));
  const run = (env) => spawnSync(process.execPath, [file], { env: { PATH: process.env.PATH, HOME: process.env.HOME, GH_TOKEN: 'x', WOODSHED_START_CHECK: '1', ...env }, encoding: 'utf8', timeout: 30_000 });
  const ok = run({});
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /console: start check passed/);
  assert.doesNotMatch(ok.stdout, /console: listening/);
  const bad = run({ WOODSHED_PROVIDER: 'nowhere' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /console: could not start.*unknown WOODSHED_PROVIDER "nowhere"/s);
});
