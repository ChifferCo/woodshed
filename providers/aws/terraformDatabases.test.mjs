import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { hostedEngines } from '../../shared/databases/index.mjs';

// The databases are optional (`databases` in variables.tf), so what was always there gained a `count`. An installation
// from before must keep each at its address, or the next apply destroys and makes again its RDS instance and secrets:
// these read the Terraform as text, since no test here runs terraform. The console's DNS zone is optional the same way
// (`domain`), and a zone made again gets new nameservers, so it is held to the same rules.
const DIR = path.join(import.meta.dirname, 'terraform');
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.tf'));
const text = files.map((f) => fs.readFileSync(path.join(DIR, f), 'utf8')).join('\n');
const counted = [...text.matchAll(/^resource "([a-z0-9_]+)" "([a-z0-9_]+)" \{\n {2}count = local\.(postgres|mongo|db_admin|own_domain) \? 1 : 0\n/gm)]
  .map((m) => ({ address: `${m[1]}.${m[2]}`, by: m[3] }));
const moved = [...text.matchAll(/^moved \{\n {2}from = ([a-z0-9_.]+)\n {2}to {3}= ([a-z0-9_.]+)\[0\]\n\}/gm)].map((m) => [m[1], m[2]]);

test('every resource a database or the domain decides has a moved block from the address it had before', () => {
  assert.deepEqual(counted.map((c) => c.address).sort(), [
    'aws_db_instance.postgres', 'aws_db_subnet_group.main', 'aws_ecs_task_definition.db_admin', 'aws_iam_role.db_admin_execution',
    'aws_iam_role.db_admin_task', 'aws_iam_role_policy.db_admin_execution', 'aws_iam_role_policy.db_admin_task',
    'aws_iam_role_policy_attachment.db_admin_execution', 'aws_route53_record.console', 'aws_route53_record.console_caa',
    'aws_route53_record.session_apps', 'aws_route53_zone.console', 'aws_secretsmanager_secret.mongo_root', 'aws_security_group.database',
    'aws_ssm_document.refresh_db_template',
  ]);
  for (const { address } of counted) assert.ok(moved.some(([from, to]) => from === address && to === address), `${address} has no moved block`);
  for (const [from, to] of moved) assert.equal(from, to, 'a moved block only adds the index');
  assert.equal(moved.length, counted.length, 'no moved block for a resource that has no count');
});

test('nothing reads a counted resource as if it were still one', () => {
  for (const { address } of counted) {
    const bare = text.split('\n').filter((line) => new RegExp(`\\b${address.replace('.', '\\.')}\\.`).test(line) && !/^ {2}(from|to) /.test(line));
    assert.deepEqual(bare, [], `${address} without an index or a splat`);
  }
});

test('the rules and settings keyed by a database keep their keys, and come only with it', () => {
  assert.match(text, /for_each = local\.postgres \? \{\n {4}base_box = aws_security_group\.base_box\.id\n {4}sessions = aws_security_group\.sessions\.id\n {2}\} : \{\}/,
    'the Postgres ingress rules keep base_box and sessions');
  assert.match(text, /local\.mongo \? \{ mongo = 27017 \} : \{\}/, 'the Mongo ingress rule keeps its key, mongo');
  const stack = fs.readFileSync(path.join(DIR, 'baseBoxStack.sh.tftpl'), 'utf8');
  assert.match(stack, /%\{ if mongo ~\}\n {2}# Every database has a user of its own[^]*?\n {2}mongo:\n[^]*?%\{ endif ~\}\n%\{ for name, service in services ~\}/);
  assert.match(stack, /%\{ if mongo ~\}\n\/usr\/local\/bin\/\$\{name_prefix\}-mongo-root\n%\{ endif ~\}/);
  assert.match(stack, / {6}- \$\{prefix\}DATABASES=\$\{databases\}\n/);
  assert.match(stack, /%\{ if db_admin_task != "" ~\}\n {6}- \$\{prefix\}ECS_DB_ADMIN_TASK_DEFINITION=\$\{db_admin_task\}\n%\{ endif ~\}/);
});

test('an installation with both databases gets the db-admin entryPoint and secrets in the order they always had', () => {
  const ecs = fs.readFileSync(path.join(DIR, 'ecs.tf'), 'utf8');
  const hosts = /db_admin_hosts = concat\(([^]*?)\n {2}\)/.exec(ecs)[1];
  assert.ok(hosts.indexOf('"--pg-host"') < hosts.indexOf('"--pg-root-user"') && hosts.indexOf('"--pg-ca"') < hosts.indexOf('"--mongo-host"'));
  const secrets = /secrets = concat\(([^]*?)\n {4}\)/.exec(ecs)[1];
  assert.ok(secrets.indexOf('PG_ROOT_PASSWORD') < secrets.indexOf('MONGO_ROOT_PASSWORD'));
});

// The seed's env files come from the default project's repo settings (session/dbAdmin.mjs, seedEnvFiles): the entryPoint
// names the project, which a run cannot override, and the task role reads that project's values and no other repo's.
test('the db-admin task seeds from the default project\'s repo settings, and may read only that project\'s', () => {
  const ecs = fs.readFileSync(path.join(DIR, 'ecs.tf'), 'utf8');
  const entryPoint = /entryPoint = concat\(([^]*?)\n {4}\)/.exec(ecs)[1];
  assert.match(entryPoint, /"--repo", [^\n]+,\n {8}"--project", local\.seed_project,\n {8}"--",/);
  const statement = /sid {5}= "TheSeedsEnvFiles"[^]*?resources = concat\(([^]*?)\n {4}\)/.exec(ecs)[1];
  assert.match(statement, /"arn:aws:secretsmanager:\$\{var\.region\}:\$\{local\.account_id\}:secret:\$\{local\.p\}\/repos\/\$\{local\.seed_project\}\/env\/\*"/);
  assert.doesNotMatch(statement, /repos\/\*/, 'never every repo\'s');
  assert.doesNotMatch(statement, /users\//, 'never anyone\'s own values');
  const database = fs.readFileSync(path.join(DIR, 'database.tf'), 'utf8');
  assert.match(database, /seed_project = coalesce\(\n {4}one\(\[for p in var\.projects : p\.name if p\.default \|\| length\(var\.projects\) == 1\]\),/,
    'the projects\' default first, as console/projects.mjs\'s defaultProject');
});

// A session's databases are its engines' (shared/databases/): the task definition gives each engine's server in the
// names that engine reads, and names no app's variable.
test('the session task definition gives each engine\'s server in its engine\'s names', () => {
  const block = /session_services = merge\(([^]*?)\n {2}\)/.exec(text)?.[1] ?? '';
  const names = [...block.matchAll(/^\s+([A-Z][A-Z0-9_]*)\s+=/gm), ...block.matchAll(/\{ ([A-Z][A-Z0-9_]*) =/g)].map((m) => m[1]);
  assert.deepEqual(names.sort(), ['PGHOST', 'PGPORT', 'PGSSLMODE', 'PGSSLROOTCERT', 'WOODSHED_CONSOLE_URL', 'WOODSHED_MONGO_HOST']);
  assert.deepEqual(hostedEngines(Object.fromEntries(names.map((n) => [n, 'x']))), ['postgres', 'mongo']);
  assert.doesNotMatch(text, /\bDB_(HOST|PORT|USER|PASSWD|NAME)\b|\bMONGO_(HOST|DB)\b/);
});
