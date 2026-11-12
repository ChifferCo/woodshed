import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadProject } from './project.mjs';
import { commandProblems, repoProblems } from './projectCheck.mjs';
import { fixtureApp, fixtureCheckout, fixtureProject } from './projectFixture.mjs';

const SCRIPT = path.join(import.meta.dirname, 'project.mjs');

const CI = `name: CI
on:
  pull_request:
    paths-ignore: ['docs/**']
jobs:
  e2e:
    name: \${{ format('E2E ({0}/2)', matrix.shard) }}
    strategy:
      matrix:
        shard: [1, 2]
    runs-on: ubuntu-latest
    steps:
      - run: |
          # Runs the suite
          name: not a job's name
  lint:
    runs-on: ubuntu-latest
`;

// A checkout whose project file uses every check, all of them passing: each test breaks one field.
const FILES = {
  '.gitignore': 'api/.env\napi/node_modules/\n',
  'api/package.json': JSON.stringify({ scripts: { migrate: 'knex migrate', seed: 'knex seed' } }),
  'api/deps.lock': '',
  'api/.npmrc': '//registry.example.com/:_authToken=${REGISTRY_TOKEN}\n',
  'api/db/migrations/001.sql': '',
  'api/config.env': 'A=1\n',
  'scripts/app.sh': '#!/bin/bash\n',
  'web/index.html': '',
  '.github/workflows/ci.yml': CI,
  '.github/workflows/review.yml': 'on: pull_request\njobs:\n  review:\n    uses: acme/reviews/.github/workflows/review.yml@main\n',
  '.woodshed/rules.md': '- Run `make check`.\n',
};

const DB = {
  engine: 'postgres', dir: 'api', migrate: 'npm run migrate', seed: 'npm run seed', envFiles: ['api-env'], paths: ['api/db'],
  migrations: 'api/db/migrations', migrationsTable: null, dump: null, user: null, name: null,
};

const PROJECT = {
  dependencies: { installs: [{ dir: 'api', files: ['package.json', 'deps.lock', '.npmrc', '*.toml'], command: 'npm ci', output: ['node_modules'] }] },
  env: { PORT: '8080', DATABASE_URL: '{{PG_URL}}' },
  envFiles: [{ path: 'api/.env', secret: 'api-env', lines: ['DB={{PGDATABASE}}', 'STORE={{STORE_URL}}', 'KEY={{KEY?}}'] }],
  databases: [DB],
  app: fixtureApp({
    start: 'PORT=9000 bash scripts/app.sh start', stop: 'bash scripts/app.sh stop', logs: { api: '~/.cache/app/{{CHECKOUT}}/api.log' }, paths: ['web/', 'api'],
  }),
  pullRequests: {
    review: { author: 'ci[bot]', heading: '## Review', workflow: '.github/workflows/review.yml', rerun: null, commentAuthor: null },
    suites: [{ name: 'E2E', workflow: '.github/workflows/ci.yml', jobs: 'E2E', rerun: null }],
    qa: null, mergeRisk: null,
  },
  rules: '.woodshed/rules.md',
};

function checkout(t, { project = {}, files = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-check-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fixtureCheckout(dir);
  const all = { ...FILES, ...files, '.woodshed/project.yaml': fixtureProject({ ...PROJECT, ...project }) };
  for (const [file, text] of Object.entries(all)) {
    if (text === null) continue;
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'files'], { stdio: 'ignore' });
  return dir;
}

function problems(t, setup) {
  const dir = checkout(t, setup);
  return repoProblems(loadProject(dir, { projectFilesDir: null }), dir);
}

function cli(dir) {
  return spawnSync(process.execPath, [SCRIPT, 'check'], { encoding: 'utf8', env: { PATH: process.env.PATH, REPO_DIR: dir } });
}

// One problem, naming the field, where the passing checkout had none.
function assertProblem(t, setup, pattern) {
  const found = problems(t, setup);
  assert.equal(found.length, 1, found.join('\n'));
  assert.match(found[0], pattern);
}

test('a project file whose every field is right for its checkout passes, and check prints what a session takes', (t) => {
  const dir = checkout(t);
  assert.deepEqual(repoProblems(loadProject(dir, { projectFilesDir: null }), dir), []);
  const run = cli(dir);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^install variables: 1 \(REGISTRY_TOKEN in api\/\.npmrc\)$/m);
  assert.match(run.stdout, /^from the session: 2 \(STORE_URL, KEY\)$/m, 'not the databases\' variables, the env\'s own or Woodshed\'s');
  assert.match(run.stdout, /^pull requests: review \.github\/workflows\/review\.yml, suites 1 \(E2E in \.github\/workflows\/ci\.yml\)$/m);
});

test('check names every problem at once, one line each, and exits 1', (t) => {
  const dir = checkout(t, { project: { rules: '.woodshed/gone.md', env: { GH_TOKEN: 'x' } } });
  const run = cli(dir);
  assert.equal(run.status, 1);
  assert.deepEqual(run.stderr.trim().split('\n'), [
    'project: .woodshed/project.yaml: rules names .woodshed/gone.md, which is not in the checkout or on the default branch',
    'project: .woodshed/project.yaml: env.GH_TOKEN is one of Woodshed\'s own session variables, which the project cannot set',
  ]);
});

test('a repo with no project file has nothing to check', (t) => {
  const dir = checkout(t, { files: { '.woodshed/rules.md': null } });
  fs.rmSync(path.join(dir, '.woodshed/project.yaml'));
  assert.match(cli(dir).stdout, /^no \.woodshed\/project\.yaml/);
});

test('pullRequests: the review\'s and each suite\'s workflow are in the checkout', (t) => {
  const gates = (change) => ({ pullRequests: { ...PROJECT.pullRequests, ...change } });
  assertProblem(t, { project: gates({ review: { ...PROJECT.pullRequests.review, workflow: '.github/workflows/gone.yml' } }) },
    /^pullRequests\.review\.workflow is \.github\/workflows\/gone\.yml, which is not in the checkout or on the default branch$/);
  assertProblem(t, { project: gates({ suites: [{ ...PROJECT.pullRequests.suites[0], workflow: '.github/workflows/e2e.yml' }] }) },
    /^pullRequests\.suites\[0\]\.workflow is \.github\/workflows\/e2e\.yml, which is not in the checkout/);
});

test('pullRequests: each suite\'s jobs start some job\'s check run name in its workflow', (t) => {
  const suite = (jobs) => ({ pullRequests: { ...PROJECT.pullRequests, suites: [{ ...PROJECT.pullRequests.suites[0], jobs }] } });
  for (const jobs of ['E2E (1', 'lint', 'li']) assert.deepEqual(problems(t, { project: suite(jobs) }), [], jobs);
  assertProblem(t, { project: suite('Unit') },
    /^pullRequests\.suites\[0\]\.jobs is "Unit", and no job of \.github\/workflows\/ci\.yml has a name starting with it \(its jobs: e2e \(".*E2E.*"\), lint\)$/);
});

test('pullRequests: a suite\'s workflow has an on: section the console can read its path filters from', (t) => {
  assertProblem(t, { files: { '.github/workflows/ci.yml': CI.replace('on:\n', 'on: &triggers\n') } },
    /^pullRequests\.suites\[0\]\.workflow \.github\/workflows\/ci\.yml's on: section is not read \(.*anchor.*\): the console reads its paths-ignore from it$/);
});

test('envFiles: one entry a file and a secret, and no secret Woodshed keeps for itself', (t) => {
  const file = PROJECT.envFiles[0];
  const files = (...list) => ({ project: { envFiles: list, databases: [] } });
  assertProblem(t, files(file, { ...file, secret: 'web-env' }), /^envFiles has api\/\.env more than once: one entry a file$/);
  assertProblem(t, { project: { envFiles: [file, { ...file, path: 'web/.env' }] }, files: { '.gitignore': 'api/.env\nweb/.env\n' } },
    /^envFiles has the secret api-env more than once: one file a secret$/);
  assertProblem(t, files({ ...file, secret: 'github-app-key' }), /^envFiles\[0\]\.secret is github-app-key, one of the console's own secrets, which no session is handed$/);
  assertProblem(t, files({ ...file, secret: 'gh-token' }), /^envFiles\[0\]\.secret gh-token reaches the session as GH_TOKEN, one of Woodshed's own session variables/);
  assertProblem(t, files({ ...file, secret: 'woodshed-x' }), /reaches the session as WOODSHED_X/);
});

test('envFiles: each path is a file git ignores, never one it tracks, a folder or the project file', (t) => {
  const at = (p) => ({ project: { envFiles: [{ ...PROJECT.envFiles[0], path: p }] } });
  assertProblem(t, at('api/.env.local'), /^envFiles\[0\]\.path api\/\.env\.local is not ignored by git \(\.gitignore\): a session could commit its secret$/);
  assertProblem(t, at('api/config.env'), /^envFiles\[0\]\.path api\/config\.env is tracked by git/);
  assertProblem(t, at('api/db'), /^envFiles\[0\]\.path is api\/db, which is a folder in the checkout$/);
  assertProblem(t, at('.woodshed/project.yaml'), /^envFiles\[0\]\.path is \.woodshed\/project\.yaml, which a session cannot write over$/);
  assertProblem(t, at('.git/config'), /^envFiles\[0\]\.path is \.git\/config/);
});

test('envFiles and env: each line is NAME=value, and a placeholder is written in capitals in double braces', (t) => {
  const lines = (...l) => ({ project: { envFiles: [{ ...PROJECT.envFiles[0], lines: l }] } });
  assert.deepEqual(problems(t, lines('export A=1', 'B.C=2', 'D=', '# A comment')), []);
  assertProblem(t, lines('just words'), /^envFiles\[0\]\.lines\[0\] is not NAME=value: "just words"$/);
  assertProblem(t, lines('DB={{ PGHOST }}'), /^envFiles\[0\]\.lines\[0\] has \{\{ PGHOST \}\}, which is not a placeholder: write \{\{NAME\}\} or \{\{NAME\?\}\}, in capitals$/);
  assertProblem(t, lines('A=1', 'DB={{pgHost}}'), /^envFiles\[0\]\.lines\[1\] has \{\{pgHost\}\}/);
  assertProblem(t, { project: { env: { URL: 'http://{{ host }}' } } }, /^env\.URL has \{\{ host \}\}, which is not a placeholder/);
  assertProblem(t, { project: { env: { PATH: '/bin' } } }, /^env\.PATH is one of Woodshed's own session variables/);
});

test('dependencies.installs: each dir is a folder with the files it names, and its command\'s script is there', (t) => {
  const install = PROJECT.dependencies.installs[0];
  const with_ = (change) => ({ project: { dependencies: { installs: [{ ...install, ...change }] } } });
  assertProblem(t, with_({ dir: 'mobile' }), /^dependencies\.installs\[0\]\.dir is mobile, which is not a folder in the checkout$/);
  assertProblem(t, with_({ files: ['package.json', 'yarn.lock'] }), /^dependencies\.installs\[0\]\.files\[1\] is yarn\.lock, and api\/yarn\.lock is not in the checkout$/);
  assertProblem(t, with_({ command: 'npm ci && bash scripts/postinstall.sh' }), /^dependencies\.installs\[0\]\.command runs api\/scripts\/postinstall\.sh, which is not in the checkout$/);
});

test('databases: the dir, paths and migrations are in the checkout, migrations under paths, and its commands\' scripts there', (t) => {
  const db = (change) => ({ project: { databases: [{ ...DB, ...change }] } });
  assertProblem(t, db({ dir: 'server' }), /^databases\[0\]\.dir is server, which is not a folder in the checkout$/);
  assertProblem(t, db({ paths: ['api/db', 'api/seeds'] }), /^databases\[0\]\.paths\[1\] is api\/seeds, which is not in the checkout$/);
  assertProblem(t, db({ migrations: 'api/db/migrate' }), /^databases\[0\]\.migrations is api\/db\/migrate, which is not a folder in the checkout$/);
  assertProblem(t, db({ paths: ['api/package.json'] }), /^databases\[0\]\.migrations is api\/db\/migrations, which is under none of its paths/);
  assertProblem(t, db({ seed: 'npm run seed:all' }), /^databases\[0\]\.seed runs `npm run seed:all`, and api\/package\.json has no seed:all script$/);
  assertProblem(t, db({ dir: 'web', paths: [], migrations: null, seed: null }), /^databases\[0\]\.migrate runs `npm run migrate`, and web\/package\.json is not in the checkout$/);
});

test('app: ports a session leaves free and an unprivileged user can listen on, its scripts, paths and logs', (t) => {
  const app = (change) => ({ project: { app: { ...PROJECT.app, ...change } } });
  assertProblem(t, app({ frontendPort: 80 }), /^app\.frontendPort is 80: a session runs the app as an unprivileged user, which cannot listen below 1024$/);
  assertProblem(t, app({ backendPort: 7682 }), /^app\.backendPort is 7682, which statusd listens on in every session$/);
  assertProblem(t, app({ backendPort: 7685 }), /^app\.backendPort is 7685, which the Postgres viewer \(pgweb\) listens on/);
  assertProblem(t, app({ start: 'bash ../setup.sh start' }), /^app\.start runs \.\.\/setup\.sh, which is outside the repo$/, 'in a git checkout, where git would exit 128 on it');
  assertProblem(t, app({ start: './scripts/start.sh' }), /^app\.start runs scripts\/start\.sh, which is not in the checkout$/);
  assert.deepEqual(problems(t, app({ start: 'npm ci && node api/node_modules/.bin/serve' })), [], 'a script git ignores is an install\'s or a build\'s');
  assertProblem(t, app({ stop: 'npm run stop' }), /^app\.stop runs `npm run stop`, and package\.json is not in the checkout$/);
  assertProblem(t, app({ paths: ['web/', 'mobile/'] }), /^app\.paths\[1\] is mobile\/, and nothing in the checkout starts with it$/);
  assert.deepEqual(problems(t, app({ paths: ['we', 'api/db/'] })), [], 'a prefix of a name is enough');
  assertProblem(t, app({ logs: { api: '/var/log/api.log' } }), /^app\.logs\.api must be under the home/);
});

test('apps: every app\'s ports, commands, paths and logs are checked, each named by its place in the list', (t) => {
  const web = { name: 'web', label: 'Web', ...PROJECT.app };
  const admin = { name: 'admin', ...PROJECT.app, frontendPort: 3000, paths: ['web/'] };
  const apps = (change) => ({ project: { app: null, apps: [web, { ...admin, ...change }] } });
  assert.deepEqual(problems(t, apps({})), [], 'two apps that are right pass');
  assertProblem(t, apps({ frontendPort: 7682 }), /^apps\[1\]\.frontendPort is 7682, which statusd listens on in every session$/);
  assertProblem(t, apps({ backendPort: 443 }), /^apps\[1\]\.backendPort is 443: a session runs the app as an unprivileged user/);
  assertProblem(t, apps({ start: 'bash scripts/admin.sh' }), /^apps\[1\]\.start runs scripts\/admin\.sh, which is not in the checkout$/);
  assertProblem(t, apps({ stop: 'npm run stop' }), /^apps\[1\]\.stop runs `npm run stop`, and package\.json is not in the checkout$/);
  assertProblem(t, apps({ paths: ['admin/'] }), /^apps\[1\]\.paths\[0\] is admin\/, and nothing in the checkout starts with it$/);
  assertProblem(t, apps({ logs: { admin: '../admin.log' } }), /^apps\[1\]\.logs\.admin must be under the home/);
  const run = cli(checkout(t, apps({})));
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^apps: 2 \(web: `PORT=9000 bash scripts\/app\.sh start`, frontend on 3001, the default; admin: `.+`, frontend on 3000\)$/m);
});

test('rules and setup name files in the checkout', (t) => {
  assertProblem(t, { project: { setup: '.woodshed/setup.md' } }, /^setup names \.woodshed\/setup\.md, which is not in the checkout/);
});

test('a command\'s scripts are checked up to a cd, and words the shell would expand are left alone', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-command-'));
  try {
    const check = (command) => commandProblems(command, { repoDir, dir: '.', field: 'app.start' });
    assert.deepEqual(check('cd web && ./start.sh'), [], 'after cd, the folder is the command\'s own');
    assert.deepEqual(check('node -e "require(1)" && bash -c \'./x.sh\''), []);
    assert.deepEqual(check('"$HOME/bin/run" && ~/x.sh && $(pwd)/y.sh && /usr/bin/env true'), []);
    assert.deepEqual(check('make dev && docker compose up -d && node server'), [], 'a program from PATH, and a node module name');
    assert.deepEqual(check('A=1 B=2 python3 manage.py runserver | tee log'), ['app.start runs manage.py, which is not in the checkout']);
    assert.deepEqual(check('bash ../setup.sh && ../bin/dev && node api/../../x.js'), [
      'app.start runs ../setup.sh, which is outside the repo', 'app.start runs ../bin/dev, which is outside the repo',
      'app.start runs ../x.js, which is outside the repo',
    ], 'named, never asked of git');
    assert.deepEqual(commandProblems('bash ../../tool.sh', { repoDir, dir: 'api', field: 'databases[0].seed' }), ['databases[0].seed runs ../tool.sh, which is outside the repo']);
    assert.deepEqual(check('bin/dev; pnpm run dev'), ['app.start runs bin/dev, which is not in the checkout', 'app.start runs `pnpm run dev`, and package.json is not in the checkout']);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
