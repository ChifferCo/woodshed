import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkoutDir, EMPTY_PROJECT, envFileText, expandPath, exportLines, installsManifest, loadProject, neededDatabases, parseProject, renderLine, secretEnvName, unsetPlaceholders, usesVariable, writeEnvFiles } from './project.mjs';
import { fixtureApp, fixtureProject } from './projectFixture.mjs';

const SCRIPT = path.join(import.meta.dirname, 'project.mjs');

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-project-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a placeholder is its variable, empty when unset, and a `?` one leaves its line out when empty', () => {
  assert.equal(renderLine('PGHOST={{PGHOST}}', { PGHOST: 'db' }), 'PGHOST=db');
  assert.equal(renderLine('APP_TEST_DB={{PGDATABASE}}_test', {}), 'APP_TEST_DB=_test');
  assert.equal(renderLine('KEY={{KEY?}}', {}), null);
  assert.equal(renderLine('KEY={{KEY?}}', { KEY: 'k' }), 'KEY=k');
  assert.equal(renderLine('lower={{lower}}', { lower: 'x' }), 'lower={{lower}}', 'only capital names are placeholders');
});

test('the variables lines need and the environment leaves empty are named once each, and a `?` one is not', () => {
  const lines = ['STORE={{STORE_URL}}', 'COPY={{STORE_URL}}/x', 'PDF={{PDF_URL}}', 'KEY={{KEY?}}', 'DB={{PGHOST}}'];
  assert.deepEqual(unsetPlaceholders(lines, { PGHOST: 'db', PDF_URL: '' }), ['STORE_URL', 'PDF_URL']);
  assert.deepEqual(unsetPlaceholders(lines, { PGHOST: 'db', PDF_URL: 'p', STORE_URL: 's' }), []);
});

test('an env file is the secret, the owner\'s own lines, then the project\'s, so the project\'s win', () => {
  assert.equal(envFileText({ base: 'A=1', own: 'B=2', lines: ['A={{X}}', 'K={{K?}}'], env: { X: '3' } }),
    'A=1\n\n# Your own lines, from My settings\nB=2\n\n# Woodshed Cloud overrides\nA=3\n');
  assert.equal(envFileText({ base: '', own: '', lines: [], env: {} }), '\n\n# Woodshed Cloud overrides\n\n');
});

test('a wrong project file names the field', () => {
  const full = (overrides) => parseProject({ ...EMPTY_PROJECT, ...overrides });
  const db = { engine: 'postgres', dir: '.', migrate: null, seed: null, envFiles: [], paths: [], migrations: null, user: null, name: null };
  assert.throws(() => parseProject([]), /the file must be a mapping of version, dependencies/);
  assert.throws(() => parseProject({ ...EMPTY_PROJECT, version: 3 }), /version must be 1, the format this Woodshed Cloud reads \(it is 3\)/);
  assert.throws(() => full({ dependencies: ['api'] }), /dependencies must be a mapping of installs/);
  assert.throws(() => full({ envFiles: [{ path: '../x', secret: null, lines: [] }] }), /envFiles\[0\]\.path must be a path inside the repo/);
  assert.throws(() => full({ envFiles: [{ path: 'x', secret: 'Api_Env', lines: [] }] }), /envFiles\[0\]\.secret must be lowercase/);
  assert.throws(() => full({ envFiles: [{ secret: null }] }), /envFiles\[0\] is missing path/);
  assert.throws(() => full({ app: fixtureApp({ frontendPort: 'web' }) }), /app\.frontendPort must be a port number/);
  assert.throws(() => full({ env: { PORT: 9000 } }), /env\.PORT must be a string: quote it/);
  assert.throws(() => full({ databases: [{ ...db, envFiles: ['api-env'] }] }), /databases\[0\]\.envFiles names api-env, which no envFiles entry has/);
  assert.throws(() => full({ databases: [{ ...db, engine: 'mysql' }] }), /databases\[0\]\.engine must be one of postgres, mongo \(it is "mysql"\)/);
  const { engine, ...noEngine } = db;
  assert.throws(() => full({ databases: [noEngine] }), /databases\[0\] is missing engine/);
  assert.throws(() => full({ databases: [db, { ...db, dir: 'other' }] }), /databases has postgres more than once: one database an engine/);
  assert.throws(() => full({ database: db }), /has database, which is not a field/, 'the one-database section from before the engines');
  assert.throws(() => full({ databases: db }), /databases must be a list/);
  assert.throws(() => exportLines({ project: full({ env: { 'A-B': 'x' } }), env: {} }), /env\.A-B is not a variable name/);
});

test('a postgres database names its migrations table, as its tool keeps it, and nothing is assumed without one', () => {
  const full = (overrides) => parseProject({ ...EMPTY_PROJECT, ...overrides });
  const db = { engine: 'postgres', dir: '.', migrate: null, seed: null, envFiles: [], paths: [], migrations: null, user: null, name: null };
  assert.equal(full({ databases: [db] }).databases[0].migrationsTable, null, 'left out is none, not some tool\'s table');
  const prisma = { table: '_prisma_migrations', column: 'migration_name' };
  assert.deepEqual(full({ databases: [{ ...db, migrationsTable: prisma }] }).databases[0].migrationsTable, prisma);
  assert.deepEqual(full({ databases: [{ ...db, migrationsTable: { table: 'app.schema_versions', column: 'version' } }] }).databases[0].migrationsTable,
    { table: 'app.schema_versions', column: 'version' });
  const bad = (migrationsTable) => () => full({ databases: [{ ...db, migrationsTable }] });
  assert.throws(bad({ table: 'x; DROP TABLE y', column: 'name' }), /databases\[0\]\.migrationsTable\.table must be a lowercase name, or schema\.name/);
  assert.throws(bad({ table: 'app.SchemaVersions', column: 'name' }), /migrationsTable\.table must be a lowercase name/, 'Postgres would fold it');
  assert.throws(bad({ table: 'a.b.c', column: 'name' }), /migrationsTable\.table must be a lowercase name, or schema\.name/);
  assert.throws(bad({ table: 'm', column: 'na me' }), /migrationsTable\.column must be a lowercase name$/);
  assert.throws(bad({ table: 'm' }), /migrationsTable is missing column/);
  assert.throws(bad('knex_migrations'), /migrationsTable must be a mapping of table, column/);
  assert.throws(() => full({ databases: [{ ...db, engine: 'mongo', migrationsTable: prisma }] }), /databases\[0\]\.migrationsTable is for a postgres database only/);
});

test('what a dump leaves out is the project\'s to say, and nothing without it', () => {
  const full = (overrides) => parseProject({ ...EMPTY_PROJECT, ...overrides });
  const db = { engine: 'postgres', dir: '.', migrate: null, seed: null, envFiles: [], paths: [], migrations: null, user: null, name: null };
  const mongo = { ...db, engine: 'mongo' };
  assert.deepEqual(full({ databases: [db] }).databases[0].dump, { skip: [], extensions: [] }, 'left out: every row, and no extension named');
  assert.deepEqual(full({ databases: [{ ...db, dump: { skip: ['audit_log', 'app.events'], extensions: ['postgis'] } }] }).databases[0].dump,
    { skip: ['audit_log', 'app.events'], extensions: ['postgis'] });
  assert.deepEqual(full({ databases: [{ ...mongo, dump: { skip: ['sessions.cache'] } }] }).databases[0].dump, { skip: ['sessions.cache'], extensions: [] });
  const bad = (database) => () => full({ databases: [database] });
  assert.throws(bad({ ...db, dump: { skip: ["x' --file=/etc/passwd"] } }), /databases\[0\]\.dump\.skip\[0\] must be a lowercase name, or schema\.name/);
  assert.throws(bad({ ...db, dump: { extensions: ['a.b'] } }), /dump\.extensions\[0\] must be a lowercase name$/);
  assert.throws(bad({ ...mongo, dump: { skip: ['a b'] } }), /dump\.skip\[0\] must be a collection's name/);
  assert.throws(bad({ ...mongo, dump: { extensions: ['pg_trgm'] } }), /dump\.extensions is for a postgres database only/);
  assert.throws(bad({ ...db, dump: { skips: [] } }), /dump has skips, which is not a field/);
});

// A field that can be none may be left out, and is none. What the field needs to work must be written, and a misspelt
// name is refused, so a typo is never read as "none".
test('only version must be written: a field left out is none, and a misspelt one still stops the read', () => {
  assert.deepEqual(parseProject({ version: 1 }), EMPTY_PROJECT, 'a file with only its version is a repo with nothing');
  const { app, ...noApp } = EMPTY_PROJECT;
  assert.equal(parseProject(noApp).app, null);
  assert.deepEqual(parseProject({ version: 1, envFiles: [{ path: 'api/.env' }] }).envFiles, [{ path: 'api/.env', secret: null, lines: [] }]);
  const { stop, logs, paths, ...lean } = fixtureApp();
  assert.deepEqual(parseProject({ version: 1, app: lean }).app, { ...lean, stop: null, logs: {}, paths: [] });
  const [db] = parseProject({ version: 1, databases: [{ engine: 'mongo', dir: '.' }] }).databases;
  assert.deepEqual([db.migrate, db.seed, db.envFiles, db.paths, db.migrations, db.user, db.name], [null, null, [], [], null, null, null]);
  assert.throws(() => parseProject({ version: 2 }), /version must be 1/, 'the version still is');
  const { version, ...noVersion } = EMPTY_PROJECT;
  assert.throws(() => parseProject(noVersion), /is missing version/);
  assert.throws(() => parseProject({ ...EMPTY_PROJECT, envfiles: [] }), /has envfiles, which is not a field \(expected version, dependencies, env, envFiles/);
  const { howToProve, ...noAdvice } = fixtureApp();
  assert.throws(() => parseProject({ ...EMPTY_PROJECT, app: noAdvice }), /app is missing howToProve/);
  assert.throws(() => parseProject({ ...EMPTY_PROJECT, app: { ...fixtureApp(), stopp: 'x' } }), /app has stopp, which is not a field/);
  assert.throws(() => parseProject({ ...EMPTY_PROJECT, app: {} }), /app is missing start, frontendPort, backendPort, howToProve$/);
  assert.deepEqual(parseProject({ ...EMPTY_PROJECT, app: null }).app, null, 'null still says it has none');
});

const API_INSTALL = { dir: 'api', files: ['deps.lock'], command: 'make deps', output: ['vendor', '~/.cache/tool'] };

test('dependencies are the installs the image runs, in the repo\'s own words, and name no variable', () => {
  const dependencies = { installs: [API_INSTALL, { ...API_INSTALL, dir: '.', files: ['a.lock', 'pkgs/*/manifest'] }] };
  assert.deepEqual(parseProject({ ...EMPTY_PROJECT, dependencies }).dependencies, dependencies);
  assert.deepEqual(parseProject(EMPTY_PROJECT).dependencies, { installs: [] }, 'none: nothing to install');
  const wrong = (d) => () => parseProject({ ...EMPTY_PROJECT, dependencies: { installs: [], ...d } });
  const one = (i) => wrong({ installs: [{ ...API_INSTALL, ...i }] });
  assert.throws(wrong({ tokenVariable: 'REGISTRY_TOKEN' }), /dependencies has tokenVariable, which is not a field/);
  assert.throws(one({ dir: '../x' }), /installs\[0\]\.dir must be a path inside the repo/);
  assert.throws(one({ files: [] }), /installs\[0\]\.files must name at least one file/);
  assert.throws(one({ files: ['../deps.lock'] }), /installs\[0\]\.files\[0\] must be a path inside the repo/);
  assert.throws(one({ files: ['my deps.lock'] }), /installs\[0\]\.files\[0\] must have no spaces/);
  assert.throws(one({ command: 'make\ndeps' }), /installs\[0\]\.command must be one line/);
  assert.throws(one({ output: ['/opt/x'] }), /installs\[0\]\.output\[0\] must be a path under the install's dir, or ~\/ for the home/);
  assert.throws(one({ output: ['~/'] }), /not the home itself/);
  assert.throws(one({ output: 'vendor' }), /installs\[0\]\.output must be a list/);
  assert.throws(one({ output: [] }), /installs\[0\]\.output must name at least one folder/);
  assert.throws(one({ output: ['dist*'] }), /installs\[0\]\.output\[0\] must be a path, not a glob/);
  assert.deepEqual(parseProject({ ...EMPTY_PROJECT, dependencies: {} }).dependencies, { installs: [] }, 'installs left out: none');
  const { output, ...noOutput } = API_INSTALL;
  assert.throws(wrong({ installs: [{ ...noOutput, outputs: output }] }), /installs\[0\] is missing output; and has outputs, which is not a field/);
  assert.throws(wrong({ installs: [API_INSTALL, API_INSTALL] }), /has api more than once/);
});

test('the installs\' manifest is one tab-separated line each, for session/deps.sh', () => {
  assert.equal(installsManifest({ installs: [] }), '');
  assert.equal(installsManifest({ installs: [{ ...API_INSTALL, files: ['a', 'b/*'], command: 'a && b' }] }),
    'install\tapi\ta b/*\tvendor ~/.cache/tool\ta && b\n');
});

const REVIEW = { author: 'ci[bot]', heading: '## Review', workflow: '.github/workflows/review.yml', rerun: '[review]', commentAuthor: null };
const PULL_REQUESTS = {
  review: REVIEW,
  suites: [{ name: 'e2e suite', workflow: '.github/workflows/e2e.yml', jobs: 'e2e run', rerun: null }],
  qa: { check: 'QA', label: 'qa', heading: '## QA', author: 'ci[bot]' },
  mergeRisk: { check: 'Merge risk' },
};

test('pullRequests names the repo\'s own review, suites, QA and Merge risk checks', () => {
  assert.deepEqual(parseProject({ ...EMPTY_PROJECT, pullRequests: PULL_REQUESTS }).pullRequests, PULL_REQUESTS);
  assert.equal(parseProject({ ...EMPTY_PROJECT, pullRequests: null }).pullRequests, null, 'null: no gates of the repo\'s');
  const none = { review: null, suites: [], qa: null, mergeRisk: null };
  assert.deepEqual(parseProject({ ...EMPTY_PROJECT, pullRequests: none }).pullRequests, none);
});

test('a wrong pullRequests section names the field', () => {
  const full = (pullRequests) => parseProject({ ...EMPTY_PROJECT, pullRequests });
  const { suites, ...noSuites } = PULL_REQUESTS;
  assert.deepEqual(full(noSuites).pullRequests.suites, [], 'left out is none');
  const { commentAuthor, rerun, ...lean } = REVIEW;
  assert.deepEqual(full({ ...PULL_REQUESTS, review: lean }).pullRequests.review, { ...lean, rerun: null, commentAuthor: null });
  const { heading, ...noHeading } = REVIEW;
  assert.throws(() => full({ ...PULL_REQUESTS, review: noHeading }), /pullRequests\.review is missing heading/);
  assert.throws(() => full({ ...PULL_REQUESTS, review: { ...REVIEW, workflow: '../x.yml' } }), /pullRequests\.review\.workflow must be a path inside the repo/);
  assert.throws(() => full({ ...PULL_REQUESTS, suites: [{ name: 'x' }] }), /pullRequests\.suites\[0\] is missing workflow, jobs$/);
  assert.throws(() => full({ ...PULL_REQUESTS, qa: { ...PULL_REQUESTS.qa, label: '' } }), /pullRequests\.qa\.label must be a non-empty string/);
  assert.throws(() => full({ ...PULL_REQUESTS, review: null }), /pullRequests\.mergeRisk needs pullRequests\.review/);
});

test('editor is true or false, and off when left out, so a branch from before it still starts', () => {
  assert.equal(parseProject({ ...EMPTY_PROJECT, editor: true }).editor, true);
  assert.equal(parseProject({ ...EMPTY_PROJECT, editor: false }).editor, false);
  const { editor, ...without } = EMPTY_PROJECT;
  assert.equal(parseProject(without).editor, false);
  assert.equal(EMPTY_PROJECT.editor, false, 'a repo with no project file');
  assert.throws(() => parseProject({ ...EMPTY_PROJECT, editor: 'yes' }), /editor must be true or false/);
  assert.throws(() => parseProject({ ...EMPTY_PROJECT, editr: true }), /has editr, which is not a field/);
});

test('githubAccess is full or repo, and full when left out', () => {
  assert.equal(parseProject({ ...EMPTY_PROJECT, githubAccess: 'repo' }).githubAccess, 'repo');
  assert.equal(parseProject({ ...EMPTY_PROJECT, githubAccess: 'full' }).githubAccess, 'full');
  const { githubAccess, ...without } = EMPTY_PROJECT;
  assert.equal(parseProject(without).githubAccess, 'full');
  assert.throws(() => parseProject({ ...EMPTY_PROJECT, githubAccess: 'scoped' }), /githubAccess must be one of full, repo \(it is "scoped"\)/);
  assert.throws(() => parseProject({ ...EMPTY_PROJECT, githubAccess: true }), /githubAccess must be one of full, repo/);
});

test('consoleLinks is true or false, and on when left out, so the console links as it did before the setting', () => {
  assert.equal(parseProject({ ...EMPTY_PROJECT, consoleLinks: false }).consoleLinks, false);
  assert.equal(parseProject({ ...EMPTY_PROJECT, consoleLinks: true }).consoleLinks, true);
  const { consoleLinks, ...without } = EMPTY_PROJECT;
  assert.equal(parseProject(without).consoleLinks, true);
  assert.equal(EMPTY_PROJECT.consoleLinks, true, 'a repo with no project file');
  assert.throws(() => parseProject({ ...EMPTY_PROJECT, consoleLinks: 'no' }), /consoleLinks must be true or false/);
});

test('pullRequests left out is none, and another version is named before its fields', () => {
  const { pullRequests, ...without } = EMPTY_PROJECT;
  assert.equal(parseProject(without).pullRequests, null);
  assert.throws(() => parseProject({ ...EMPTY_PROJECT, version: 3, reviewers: [] }), /version must be 1, .*\(it is 3\)/);
});

test('an empty project file, or one that is only comments, says what to write', (t) => {
  const dir = scratch(t);
  fs.mkdirSync(path.join(dir, '.woodshed'));
  fs.writeFileSync(path.join(dir, '.woodshed/project.yaml'), '# nothing yet\n');
  assert.throws(() => loadProject(dir), /\.woodshed\/project\.yaml: is empty: write version: 1 at least/);
});

test('a checkout without the file reads the default branch\'s, and a repo with neither is an empty project', (t) => {
  // What a session of this repo would have exported, whatever the session running the test has.
  const before = process.env.DEFAULT_BRANCH;
  t.after(() => {
    if (before === undefined) delete process.env.DEFAULT_BRANCH;
    else process.env.DEFAULT_BRANCH = before;
  });
  process.env.DEFAULT_BRANCH = 'main';
  const dir = scratch(t);
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'empty');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  assert.deepEqual(loadProject(dir), { ...EMPTY_PROJECT, from: 'none' });
  fs.mkdirSync(path.join(dir, '.woodshed'));
  fs.writeFileSync(path.join(dir, '.woodshed/project.yaml'), fixtureProject({ dependencies: { installs: [API_INSTALL] } }));
  git('add', '.');
  git('commit', '-q', '-m', 'project');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-q', '-b', 'old', 'HEAD');
  git('rm', '-q', '.woodshed/project.yaml');
  git('commit', '-q', '-m', 'a branch from before the file');
  const project = loadProject(dir);
  assert.deepEqual([project.from, project.dependencies.installs], ['default branch', [API_INSTALL]]);
});

// Only "the default branch has no such file" is an empty project: a git failure read that way would start a session
// with no env files, and only `from: none` in its log.
// A Woodshed session exports DEFAULT_BRANCH, so the test clears it first: without that it passes in CI and fails in
// every session.
test('a checkout without the file whose default branch cannot be read is an error, not an empty project', (t) => {
  const before = process.env.DEFAULT_BRANCH;
  t.after(() => {
    if (before === undefined) delete process.env.DEFAULT_BRANCH;
    else process.env.DEFAULT_BRANCH = before;
  });
  delete process.env.DEFAULT_BRANCH;
  const dir = scratch(t);
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'trunk']);
  assert.throws(() => loadProject(dir), /\.woodshed\/project\.yaml: not in the checkout, and the repo's default branch could not be told/);
  const notARepo = scratch(t);
  assert.throws(() => loadProject(notARepo), /default branch could not be told/);
  process.env.DEFAULT_BRANCH = 'trunk';
  assert.throws(() => loadProject(dir), /the default branch's copy could not be read \(fatal: invalid object name 'origin\/trunk'/);
});

test('paths fill in the home and the checkout\'s folder name', () => {
  assert.equal(expandPath('~/.cache/servers/{{CHECKOUT}}/a.log', { repoDir: '/work/app', home: '/home/node' }), '/home/node/.cache/servers/app/a.log');
  assert.equal(expandPath('logs/a.log', { repoDir: '/work/x' }), '/work/x/logs/a.log');
});

test('the CLI writes the env files from their secrets\' variables, and prints the exports, fields and files', (t) => {
  const dir = scratch(t);
  fs.mkdirSync(path.join(dir, '.woodshed'));
  fs.writeFileSync(path.join(dir, '.woodshed/project.yaml'), fixtureProject({
    dependencies: { installs: [API_INSTALL] },
    env: { PORT: '8080', URL: 'http://localhost:{{PORT}}' },
    envFiles: [{ path: 'api/.env', secret: 'api-env', lines: ['DB={{PGDATABASE}}'] }],
    rules: '.woodshed/rules.md',
  }));
  fs.writeFileSync(path.join(dir, '.woodshed/rules.md'), '- Run `make check`.\n');
  const cli = (args, env = {}) => execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, REPO_DIR: dir, ...env } });
  assert.equal(cli(['installs']), 'install\tapi\tdeps.lock\tvendor ~/.cache/tool\tmake deps\n');
  assert.equal(cli(['get', 'app.start']), '');
  assert.equal(cli(['env'], { PORT: '1' }), "export PORT='8080'\nexport URL='http://localhost:1'\n",
    'a value is filled in from the variables as they were, before any of these is set');
  assert.equal(cli(['secret-vars']), 'API_ENV\n');
  assert.equal(cli(['file', 'rules']), '- Run `make check`.\n');
  assert.equal(cli(['file', 'setup']), '');
  assert.equal(cli(['write-env-files'], { API_ENV: 'SECRET=1', PGDATABASE: 'app', OWN_FILES: '{"api-env":"MINE=1"}' }), 'api/.env (base: 8 bytes, own lines)\n');
  assert.equal(fs.readFileSync(path.join(dir, 'api/.env'), 'utf8'),
    'SECRET=1\n\n# Your own lines, from My settings\nMINE=1\n\n# Woodshed Cloud overrides\nDB=app\n');
});

test('check prints what a session takes from the project file, and fails as a start would', (t) => {
  const dir = scratch(t);
  fs.mkdirSync(path.join(dir, '.woodshed'));
  const file = path.join(dir, '.woodshed/project.yaml');
  const cli = (args) => execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, REPO_DIR: dir } });
  fs.writeFileSync(file, fixtureProject({
    dependencies: { installs: [API_INSTALL] },
    envFiles: [{ path: 'api/.env', secret: 'api-env', lines: ['DB={{PGDATABASE}}'] }],
    app: fixtureApp(),
    rules: '.woodshed/rules.md',
  }));
  fs.writeFileSync(path.join(dir, '.woodshed/rules.md'), '- Run `make check`.\n');
  const out = cli(['check']);
  assert.match(out, /^\.woodshed\/project\.yaml: read from the checkout\n/);
  assert.match(out, /^installs: 1 \(api\)$/m);
  assert.match(out, /^env files: 1 \(api\/\.env from api-env\)$/m);
  assert.match(out, /^app: `.+`, frontend on \d+$/m);
  fs.rmSync(path.join(dir, '.woodshed/rules.md'));
  assert.throws(() => cli(['check']), (err) => /not in the checkout/.test(err.stderr), 'a rules file that is not there fails the check');
  fs.writeFileSync(file, 'version: 1\nenvfiles: []\n');
  assert.throws(() => cli(['check']), (err) => /envfiles/.test(err.stderr), 'a misspelt field fails the check');
});

test('checkoutDir is /work/<name>, the folder the session image clones into', () => {
  assert.equal(checkoutDir('acme/app'), '/work/app');
  assert.equal(checkoutDir('acme/web-app'), '/work/web-app');
  assert.throws(() => checkoutDir('web-app'), /not a repo/);
});

test('a project uses a variable when its env exports it, an env file writes it, or either takes it from the session', () => {
  const project = { ...EMPTY_PROJECT, env: { REDIS_URL: 'redis://127.0.0.1:6379', API: '{{PDF_URL}}' }, envFiles: [{ path: 'a/.env', secret: null, lines: ['PGHOST={{PGHOST}}', 'KEY={{S3?}}'] }] };
  for (const name of ['REDIS_URL', 'PDF_URL', 'PGHOST', 'S3']) assert.equal(usesVariable(project, name), true, name);
  for (const name of ['MONGODB_URI', 'PGHOS', 'REDIS']) assert.equal(usesVariable(project, name), false, name);
  assert.equal(usesVariable(EMPTY_PROJECT, 'REDIS_URL'), false);
});

test('a project needs the engine of each of its databases, whatever its env lines name', () => {
  const database = { engine: 'mongo', dir: 'api', migrate: null, seed: null, envFiles: [], paths: [], migrations: null, user: null, name: null };
  assert.deepEqual(neededDatabases(EMPTY_PROJECT), []);
  assert.deepEqual(neededDatabases({ ...EMPTY_PROJECT, databases: [database] }), ['mongo'], 'Mongo on its own');
  assert.deepEqual(neededDatabases({ ...EMPTY_PROJECT, databases: [{ ...database, engine: 'postgres' }, database] }), ['postgres', 'mongo']);
  assert.deepEqual(neededDatabases({ ...EMPTY_PROJECT, envFiles: [{ path: 'a/.env', secret: null, lines: ['H={{PGHOST}}'] }] }), [],
    'a line naming an engine\'s variable is no database: it is left unset');
});
