import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig, requireClosedWhenReachable, requireRepo } from '../console/config.mjs';
import { defaultProject } from '../console/projects.mjs';
import { createProvider, providerName } from './console.mjs';

test('the provider follows WOODSHED_PROVIDER, or the launcher as it always did', () => {
  assert.equal(providerName({}), 'local', 'the docker launcher is the default, so the local provider is');
  assert.equal(providerName({ WOODSHED_CLOUD_LAUNCHER: 'docker' }), 'local');
  assert.equal(providerName({ WOODSHED_CLOUD_LAUNCHER: 'ecs' }), 'aws');
  assert.equal(providerName({ WOODSHED_PROVIDER: 'aws', WOODSHED_CLOUD_LAUNCHER: 'ecs' }), 'aws');
});

test('a provider and a launcher that disagree, or an unknown provider, stop the start', () => {
  assert.throws(() => providerName({ WOODSHED_PROVIDER: 'aws' }), /WOODSHED_PROVIDER=aws needs WOODSHED_CLOUD_LAUNCHER=ecs \(it is docker\)/);
  assert.throws(() => providerName({ WOODSHED_PROVIDER: 'local', WOODSHED_CLOUD_LAUNCHER: 'ecs' }), /needs WOODSHED_CLOUD_LAUNCHER=docker/);
  assert.throws(() => providerName({ WOODSHED_PROVIDER: 'hetzner' }), /unknown WOODSHED_PROVIDER "hetzner" \(expected aws or local\)/);
});

test('each provider hands the console a launcher, and AWS the CLI its stores go through', () => {
  const local = createProvider(loadConfig({ GH_TOKEN: 'x' }), {});
  // With no secrets folder the dashboard chooses the store: a slot that has none until then.
  assert.deepEqual([local.name, local.secrets.configured(), typeof local.secrets.configure, local.dbAdmin, local.webhooks, typeof local.launcher.start],
    ['local', false, 'function', null, null, 'function']);
  const env = { GH_TOKEN: 'x', WOODSHED_CLOUD_LAUNCHER: 'ecs', WOODSHED_CLOUD_ECS_CLUSTER: 'c', WOODSHED_CLOUD_ECS_TASK_DEFINITION: 't', WOODSHED_CLOUD_DATABASES: '' };
  const aws = createProvider(loadConfig(env), env);
  assert.deepEqual([aws.name, typeof aws.launcher.start, aws.dbAdmin, aws.databases], ['aws', 'function', null, []]);
});

test('the AWS provider makes the databases Terraform names, and stops at start when its settings disagree', () => {
  const base = { GH_TOKEN: 'x', WOODSHED_CLOUD_LAUNCHER: 'ecs', WOODSHED_CLOUD_ECS_CLUSTER: 'c', WOODSHED_CLOUD_ECS_TASK_DEFINITION: 't' };
  const start = (more) => createProvider(loadConfig({ ...base, ...more }), { ...base, ...more });
  const both = start({ WOODSHED_CLOUD_DATABASES: 'postgres,mongo', WOODSHED_CLOUD_ECS_DB_ADMIN_TASK_DEFINITION: 'd' });
  assert.deepEqual([both.databases, typeof both.dbAdmin.start, both.words.databasesPlace], [['postgres', 'mongo'], 'function', 'RDS and Mongo']);
  const pg = start({ WOODSHED_CLOUD_DATABASES: 'postgres', WOODSHED_CLOUD_ECS_DB_ADMIN_TASK_DEFINITION: 'd' });
  assert.deepEqual([pg.databases, pg.words.databasesPlace], [['postgres'], 'RDS']);
  assert.equal(start({ WOODSHED_CLOUD_DATABASES: '' }).words.databasesPlace, null);
  assert.throws(() => start({}), /WOODSHED_CLOUD_DATABASES is not set/);
  assert.throws(() => start({ WOODSHED_CLOUD_DATABASES: 'postgres' }), /names postgres, and there is no WOODSHED_CLOUD_ECS_DB_ADMIN_TASK_DEFINITION/);
  assert.throws(() => start({ WOODSHED_CLOUD_DATABASES: '', WOODSHED_CLOUD_ECS_DB_ADMIN_TASK_DEFINITION: 'd' }), /names no database for it to make/);
  // Each engine on its own: Mongo without Postgres.
  assert.deepEqual(start({ WOODSHED_CLOUD_DATABASES: 'mongo', WOODSHED_CLOUD_ECS_DB_ADMIN_TASK_DEFINITION: 'd' }).databases, ['mongo']);
  assert.throws(() => start({ WOODSHED_CLOUD_DATABASES: 'postgres,redis' }), /redis is not a database/);
});

test('a setting only AWS can serve stops a start on the local provider, naming it', () => {
  const env = { GH_TOKEN: 'x', WOODSHED_CLOUD_HOMES_BUCKET: 'b', WOODSHED_CLOUD_WEBHOOK_QUEUE: 'q' };
  assert.throws(() => createProvider(loadConfig(env), env),
    /WOODSHED_CLOUD_HOMES_BUCKET, WOODSHED_CLOUD_WEBHOOK_QUEUE need the aws provider; this console runs on the local provider/);
  const off = { GH_TOKEN: 'x', WOODSHED_CLOUD_WEBHOOK_QUEUE: '0' };
  assert.equal(createProvider(loadConfig(off), off).name, 'local', 'a queue turned off asks for nothing');
});

test('a setting only the local provider serves stops a start on AWS, naming it', () => {
  const env = { GH_TOKEN: 'x', WOODSHED_CLOUD_LAUNCHER: 'ecs', WOODSHED_CLOUD_ECS_CLUSTER: 'c', WOODSHED_CLOUD_ECS_TASK_DEFINITION: 't', WOODSHED_LOCAL_SECRETS_DIR: '/s' };
  assert.throws(() => createProvider(loadConfig(env), env), /WOODSHED_LOCAL_SECRETS_DIR needs the local provider; this console runs on the aws provider/);
  const files = { ...env, WOODSHED_LOCAL_SECRETS_DIR: '', WOODSHED_CLOUD_PROJECT_FILES_DIR: '/srv/project-files' };
  assert.throws(() => createProvider(loadConfig(files), files), /WOODSHED_CLOUD_PROJECT_FILES_DIR needs the local provider; this console runs on the aws provider/);
});

test('a console with no repo, or one that is not owner/name, will not start: no repo is the default', () => {
  assert.deepEqual(loadConfig({ GH_TOKEN: 'x' }).projects, []);
  assert.throws(() => requireRepo(loadConfig({ GH_TOKEN: 'x' })), /WOODSHED_CLOUD_REPO \(or WOODSHED_CLOUD_PROJECTS\) must name the repo this installation works on, as owner\/name/);
  assert.throws(() => requireRepo(loadConfig({ GH_TOKEN: 'x', WOODSHED_CLOUD_REPO: 'just-a-name' })), /owner\/name/);
  assert.doesNotThrow(() => requireRepo(loadConfig({ GH_TOKEN: 'x', WOODSHED_CLOUD_REPO: ' acme/web.app ' })));
  assert.equal(defaultProject(loadConfig({ GH_TOKEN: 'x', WOODSHED_CLOUD_REPO: ' acme/web.app ' })).repo, 'acme/web.app');
});

test('a console other machines reach will not start without sign-in required', () => {
  const at = (host, extra = {}) => () => requireClosedWhenReachable(loadConfig({ GH_TOKEN: 'x', WOODSHED_CLOUD_REPO: 'acme/app', ...(host ? { WOODSHED_CLOUD_HOST: host } : {}), ...extra }));
  for (const host of [null, '127.0.0.1', '127.0.1.1', '::1', 'localhost']) assert.doesNotThrow(at(host), String(host));
  assert.throws(at('0.0.0.0'), /WOODSHED_CLOUD_HOST is 0\.0\.0\.0, which other machines reach, and sign-in is not required: set WOODSHED_CLOUD_REQUIRE_SIGN_IN=1/);
  assert.throws(at('203.0.113.10'), /set WOODSHED_CLOUD_REQUIRE_SIGN_IN=1/);
  assert.doesNotThrow(at('0.0.0.0', { WOODSHED_CLOUD_REQUIRE_SIGN_IN: '1' }), 'sign-in from the first request: as the base box runs');
});

test('the env files are secret=path pairs, from WOODSHED_CLOUD_ENV_FILES; none without it, and a bad pair stops the start', async () => {
  const { envFiles } = await import('../console/config.mjs');
  assert.deepEqual(loadConfig({ GH_TOKEN: 'x' }).envFiles, []);
  assert.deepEqual(envFiles({ WOODSHED_CLOUD_ENV_FILES: 'api-env=api/.env, web-env=web/.env.local' }),
    [{ secret: 'api-env', path: 'api/.env' }, { secret: 'web-env', path: 'web/.env.local' }]);
  assert.throws(() => envFiles({ WOODSHED_CLOUD_ENV_FILES: 'api-env' }), /secret=path pairs/);
  assert.throws(() => envFiles({ WOODSHED_CLOUD_ENV_FILES: 'Bad_Name=x' }), /secret=path pairs/);
});

test('the install secrets are secret=VARIABLE pairs, from WOODSHED_CLOUD_INSTALL_SECRETS, in none of Woodshed\'s own variables', async () => {
  const { installSecrets } = await import('../console/config.mjs');
  assert.deepEqual(loadConfig({ GH_TOKEN: 'x' }).installSecrets, []);
  assert.deepEqual(loadConfig({ GH_TOKEN: 'x', WOODSHED_CLOUD_INSTALL_SECRETS: 'registry-token=REGISTRY_TOKEN, other-token=_OTHER' }).installSecrets,
    [{ secret: 'registry-token', variable: 'REGISTRY_TOKEN' }, { secret: 'other-token', variable: '_OTHER' }]);
  const bad = (value, files) => () => installSecrets({ WOODSHED_CLOUD_INSTALL_SECRETS: value, WOODSHED_CLOUD_ENV_FILES: files });
  assert.throws(bad('registry-token'), /secret=VARIABLE pairs/);
  assert.throws(bad('Registry=REGISTRY_TOKEN'), /secret=VARIABLE pairs/);
  assert.throws(bad('registry-token=registry_token'), /secret=VARIABLE pairs/);
  assert.throws(bad('registry-token=1TOKEN'), /secret=VARIABLE pairs/);
  assert.throws(bad('registry-token=WOODSHED_TOKEN'), /one of Woodshed's own session variables/);
  assert.throws(bad('registry-token=GH_TOKEN'), /one of Woodshed's own session variables/);
  assert.throws(bad('api-env=TOKEN', 'api-env=api/.env'), /is an env file's, or named twice/);
  assert.throws(bad('registry-token=API_ENV', 'api-env=api/.env'), /is an env file's, or named twice/);
  assert.throws(bad('a-token=TOKEN,b-token=TOKEN'), /pair 2 is an env file's, or named twice/);
  // A value pasted where a name belongs is said by its place, and never repeated into the console's log.
  assert.throws(bad('ok-token=OK,registry-token=ghp_pastedValue123'), (err) => /pair 2 is not/.test(err.message) && !err.message.includes('ghp_'));
});

// Terraform cannot import the list, so its install_secrets validation repeats it: they must not drift apart.
test('Terraform refuses the same session variables for an install secret as the console does', async () => {
  const { SESSION_VARIABLES } = await import('../console/config.mjs');
  const fs = await import('node:fs');
  const tf = fs.readFileSync(new URL('./aws/terraform/variables.tf', import.meta.url), 'utf8');
  const block = tf.slice(tf.indexOf('variable "install_secrets"'), tf.indexOf('variable "database_env_secrets"'));
  const listed = /!contains\(\s*\[("SESSION_ID"[^\]]*)\]/.exec(block)?.[1] ?? '';
  assert.deepEqual([...listed.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]), [...SESSION_VARIABLES]);
  assert.match(block, /!startswith\(env_name, "WOODSHED_"\)/);
});
