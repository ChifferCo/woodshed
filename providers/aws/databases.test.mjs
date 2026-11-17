import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseProject, EMPTY_PROJECT } from '../../shared/project.mjs';
import { fixtureCheckout, fixtureProject } from '../../shared/projectFixture.mjs';
import { databasesCheck, tfvarsDatabases } from './databases.mjs';

const PG = { engine: 'postgres', dir: 'api', migrate: 'npm run migrate' };
const MONGO = { engine: 'mongo', dir: 'worker' };
const project = (databases) => parseProject({ ...EMPTY_PROJECT, databases });
const CLI = path.join(import.meta.dirname, 'databases.mjs');

test('the tfvars\' databases are read as Terraform reads them, and anything else is refused, not guessed', () => {
  assert.deepEqual(tfvarsDatabases('region = "eu-west-1"\ndatabases = ["postgres"]\n'), ['postgres']);
  assert.deepEqual(tfvarsDatabases('databases = []'), []);
  assert.deepEqual(tfvarsDatabases('databases = [\n  "postgres", # RDS\n  "mongo",\n]\n'), ['postgres', 'mongo']);
  assert.deepEqual(tfvarsDatabases('# databases = ["mongo"]\n// databases = []\n/* databases = [] */\ndatabases = ["mongo"]\n'), ['mongo'], 'a commented-out one is no assignment');
  assert.deepEqual(tfvarsDatabases('name = "a # b"\ndatabases = ["postgres"]'), ['postgres'], 'a # in a string is no comment');
  assert.throws(() => tfvarsDatabases('region = "eu-west-1"\n'), /does not set databases, which has no default/);
  assert.throws(() => tfvarsDatabases('databases = []\ndatabases = ["mongo"]'), /more than once/);
  assert.throws(() => tfvarsDatabases('databases = var.engines'), /is not a list of engines/);
  assert.throws(() => tfvarsDatabases('databases = [postgres]'), /postgres, which is not an engine's name in quotes/);
  assert.throws(() => tfvarsDatabases('databases = ["redis"]'), /redis, which is not an engine \(postgres or mongo\)/);
  assert.deepEqual(tfvarsDatabases('database_name = "app"\ndatabase_user = "root"\ndatabases = ["postgres"]'), ['postgres'], 'not the other database_ settings');
});

test('an engine the project file needs and the tfvars leaves out stops the deploy, saying what to set', () => {
  assert.deepEqual(databasesCheck(project([PG]), []).problems,
    ['the project file\'s databases need postgres, and the tfvars\' databases hosts none: set databases = ["postgres"] in the tfvars (with database_name and database_user, which postgres needs), or take it out of the project file']);
  assert.match(databasesCheck(project([PG, MONGO]), ['mongo']).problems[0], /need postgres, and the tfvars' databases hosts mongo: set databases = \["postgres", "mongo"\]/);
  assert.match(databasesCheck(project([MONGO]), ['postgres']).problems[0], /set databases = \["postgres", "mongo"\] in the tfvars, or/, 'only postgres needs the two settings');
  assert.deepEqual(databasesCheck(project([PG, MONGO]), ['mongo', 'postgres']), { problems: [], warnings: [] });
  assert.deepEqual(databasesCheck(project([]), []), { problems: [], warnings: [] });
});

test('an engine the tfvars hosts and the project file does not use is only a warning', () => {
  const { problems, warnings } = databasesCheck(project([PG]), ['postgres', 'mongo']);
  assert.deepEqual(problems, []);
  assert.match(warnings[0], /hosts mongo, which this project file does not use: leave it if another project's file does, or take it out of the tfvars, which destroys its data/);
  assert.match(databasesCheck(project([]), ['postgres']).warnings[0], /hosts postgres/, 'a repo with no project file uses none');
});

test('the CLI checks the checkout\'s project file against the tfvars it is given', () => {
  const dir = fixtureCheckout(fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-aws-databases-')));
  fs.mkdirSync(path.join(dir, '.woodshed'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.woodshed/project.yaml'), fixtureProject({ databases: [PG] }));
  const tfvars = path.join(dir, 'terraform.tfvars');
  const run = (text, ...args) => {
    fs.writeFileSync(tfvars, text);
    return spawnSync('node', [CLI, ...(args.length ? args : ['check', '--tfvars', tfvars])], { cwd: dir, encoding: 'utf8', env: { ...process.env, REPO_DIR: '' } });
  };

  const ok = run('databases = ["postgres"]\n');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /hosts every engine the project file's databases need/);
  assert.equal(ok.stderr, '');

  const warned = run('databases = ["postgres", "mongo"]\n');
  assert.equal(warned.status, 0, warned.stderr);
  assert.match(warned.stderr, /^databases: warning: the tfvars' databases hosts mongo/);

  const missing = run('databases = []\n');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^databases: the project file's databases need postgres, and the tfvars' databases hosts none: set databases = \["postgres"\]/);

  assert.match(run('databases = []\n', 'check').stderr, /check takes --tfvars/);
  assert.match(run('', 'check', '--tfvars', path.join(dir, 'none.tfvars')).stderr, /none\.tfvars could not be read \(ENOENT\)/);
  assert.match(run('', 'plan').stderr, /unknown command: plan/);
});

test('the README\'s step runs the CLI as it takes its arguments', () => {
  const readme = fs.readFileSync(path.join(import.meta.dirname, 'README.md'), 'utf8');
  assert.match(readme, /\n {10}node woodshed\/providers\/aws\/databases\.mjs check --tfvars "\$TFVARS"\n/);
});
