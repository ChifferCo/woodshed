// The project file: what a session needs to know about the repo it works on, so nothing here names that repo's
// directories, commands or ports. It is `.woodshed/project.yaml` in the repo (docs/reference.md, "The project file").
//
//   node project.mjs check               the file read as a session's start reads it, then checked against the
//                                        checkout (projectCheck.mjs): what a session takes from it, or each problem
//   node project.mjs get <field>         a field, dotted (`app.start`); an array prints one item a line (a mapping as
//                                        JSON), a missing field prints nothing
//   node project.mjs env                 the project's `env`, as `export` lines for the entrypoint to eval
//   node project.mjs write-env-files     each of `envFiles`: its defaults, the installation's text, the owner's own
//                                        lines, then its lines; from the console's repo settings when
//                                        REPO_SETTINGS_FILE names them, else from the legacy secrets as before;
//                                        prints each file, with the variables its lines need that are unset, then a
//                                        line for each warning (writeEnvFiles)
//   node project.mjs repo-settings       what REPO_SETTINGS_FILE holds, as keys and sizes, never a value
//   node project.mjs add-instructions <file>  the rules file <file>, with the installation's and the owner's
//                                        instructions from REPO_SETTINGS_FILE after it (instructionsText)
//   node project.mjs file <rules|setup>  the text of the file that field names, empty without one
//   node project.mjs secret-vars         the variables the env files' secrets arrive in, one a line
//   node project.mjs installs            `dependencies.installs` as the manifest session/deps.sh reads: one `install`
//                                        line each (installsManifest)
//   node project.mjs apps-rules          with several apps, the lines of a session's rules that name each and how to
//                                        prove a change in it (appsRules); nothing for one app or none
//
// The repo is REPO_DIR. The checkout's own file is read first, so a branch can change it; a branch from before the file
// existed gets the default branch's. A repo with neither gets the installation's file for it, when
// WOODSHED_PROJECT_FILES_DIR names a folder holding one (installationProjectFile), and otherwise EMPTY_PROJECT: no
// dependencies, env files, databases or app.
// Only `version` must be written; a field that can be none and is left out is none. A misspelt field is refused.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ENGINE_NAMES } from './databases/engines.mjs';
import { defaultBranchOf } from './defaultBranch.mjs';
import { envValue } from './envNames.mjs';
import { parseYaml } from './yamlLite.mjs';
import { isMain } from './isMain.mjs';
import { envKeyTable, instructionsText, layeredEnvText, sessionWiring } from './repoSettings.mjs';

export const PROJECT_FILE = '.woodshed/project.yaml';
// While Woodshed is in beta the format changes in place, with every project file in the same change (README.md,
// "Changing the format").
export const PROJECT_VERSION = 1;

/**
 * Where the session image keeps a repo's checkout: `/work/<name>`. The deploy workflow's session job passes the same path to the
 * Dockerfile as REPO_DIR, and the db-admin task is told it with `--repo`.
 * @param {string} repo  owner/name
 */
export function checkoutDir(repo) {
  const name = String(repo).split('/')[1];
  if (!name) throw new Error(`not a repo, owner/name: ${repo}`);
  return `/work/${name}`;
}

// Each section's fields, by its path ('' is the file): project.reference.yaml writes each one, which a test checks.
export const PROJECT_FIELDS = Object.freeze({
  '': ['version', 'dependencies', 'env', 'envFiles', 'databases', 'app', 'apps', 'editor', 'consoleLinks', 'githubAccess', 'rules', 'setup', 'pullRequests'],
  dependencies: ['installs'],
  'dependencies.installs': ['dir', 'files', 'command', 'output'],
  envFiles: ['path', 'secret', 'defaults', 'lines'],
  databases: ['engine', 'dir', 'migrate', 'seed', 'envFiles', 'paths', 'migrations', 'migrationsTable', 'dump', 'user', 'name'],
  'databases.migrationsTable': ['table', 'column'],
  'databases.dump': ['skip', 'extensions'],
  app: ['start', 'stop', 'frontendPort', 'backendPort', 'logs', 'paths', 'howToProve'],
  apps: ['name', 'label', 'start', 'stop', 'frontendPort', 'backendPort', 'logs', 'paths', 'howToProve'],
  pullRequests: ['review', 'suites', 'qa', 'mergeRisk'],
  'pullRequests.review': ['author', 'heading', 'workflow', 'rerun', 'commentAuthor'],
  'pullRequests.suites': ['name', 'workflow', 'jobs', 'rerun'],
  'pullRequests.qa': ['check', 'label', 'heading', 'author', 'runner'],
  'pullRequests.mergeRisk': ['check'],
});

const PLACEHOLDER = /\{\{([A-Z_][A-Z0-9_]*)(\?)?\}\}/g;

function fail(message) {
  throw new Error(`${PROJECT_FILE}: ${message}`);
}

// A field that can be none (`null`, `[]`, `{}`, `false`) may be left out, and is then that: `defaults` names each, with
// its value. Every other field must be written, and a name that is not a field (`envfiles`) stops the session at start,
// so a typo is never read as "none".
function fields(value, field, names, defaults = {}) {
  const where = field ? `${field} ` : '';
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${where || 'the file '}must be a mapping of ${names.join(', ')}`);
  const missing = names.filter((name) => !Object.hasOwn(value, name) && !Object.hasOwn(defaults, name));
  const unknown = Object.keys(value).filter((name) => !names.includes(name));
  const problems = [
    missing.length && `is missing ${missing.join(', ')}`,
    unknown.length && `has ${unknown.join(', ')}, which ${unknown.length > 1 ? 'are not fields' : 'is not a field'} (expected ${names.join(', ')})`,
  ].filter(Boolean);
  if (problems.length) fail(`${where}${problems.join('; and ')}`);
  return { ...defaults, ...value };
}

function boolean(value, field) {
  if (typeof value !== 'boolean') fail(`${field} must be true or false`);
  return value;
}

// How far a private session's GitHub token reaches: `full` is its owner's token as GitHub issued it, `repo` that token
// scoped by GitHub to this repo and the session permissions.
export const GITHUB_ACCESS = Object.freeze(['full', 'repo']);

function githubAccess(value) {
  if (!GITHUB_ACCESS.includes(value)) fail(`githubAccess must be one of ${GITHUB_ACCESS.join(', ')} (it is ${JSON.stringify(value)})`);
  return value;
}

function string(value, field) {
  if (typeof value !== 'string' || !value) fail(`${field} must be a non-empty string`);
  return value;
}

function nullable(value, field, read) {
  return value === null ? null : read(value, field);
}

function repoPath(value, field) {
  string(value, field);
  if (path.isAbsolute(value) || value.split('/').includes('..')) fail(`${field} must be a path inside the repo`);
  return value;
}

function list(value, field, read) {
  if (!Array.isArray(value)) fail(`${field} must be a list (write [] for none)`);
  return value.map((item, i) => read(item, `${field}[${i}]`));
}

function stringMap(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be a mapping (write {} for none)`);
  for (const [key, v] of Object.entries(value)) if (typeof v !== 'string') fail(`${field}.${key} must be a string: quote it`);
  return value;
}

function port(value, field) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) fail(`${field} must be a port number`);
  return value;
}

// A secret on the Secrets & webhooks tab reaches the task as its name in capitals: `app-env` is APP_ENV.
export function secretEnvName(secret) {
  return secret.toUpperCase().replace(/-/g, '_');
}

function secretName(value, field) {
  if (typeof value !== 'string' || !/^[a-z0-9-]+$/.test(value)) fail(`${field} must be lowercase letters, digits and dashes`);
  return value;
}

/**
 * The env file's name in the console's store of repo settings: its secret, or else its path as one (lowercase, each run
 * of anything but letters and digits a dash), so `web/.env.local` is `web-env-local`. Never the path itself: the local
 * secret store refuses a name segment starting with a dot.
 * @param {{path: string, secret: string|null}} file
 */
export function envFileKey({ path: file, secret }) {
  if (secret) return secret;
  const key = file.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!key) fail(`envFiles has ${JSON.stringify(file)}, whose path makes no key: give it a secret`);
  return key;
}

// A default is the repo's value, which an installation's or a person's replaces: a placeholder is the session's, so it
// belongs in `lines`, and the file is in git, so it is never a secret.
function defaultLine(value, field) {
  string(value, field);
  if (/\{\{[^{}]*\}\}/.test(value)) fail(`${field} has a {{…}} placeholder: a default is plain text, and a line the session fills in goes in lines`);
  return value;
}

function envFile(value, field) {
  const file = fields(value, field, PROJECT_FIELDS.envFiles, { secret: null, defaults: [], lines: [] });
  const read = {
    path: repoPath(file.path, `${field}.path`), secret: nullable(file.secret, `${field}.secret`, secretName),
    defaults: list(file.defaults, `${field}.defaults`, defaultLine), lines: list(file.lines, `${field}.lines`, string),
  };
  return { ...read, key: envFileKey(read) };
}

// One key a file: the console keeps each env file's values under it.
function envFileList(value) {
  const all = list(value, 'envFiles', envFile);
  all.forEach((file, i) => {
    const j = all.findIndex((other) => other.key === file.key);
    if (j < i) fail(`envFiles[${j}] (${all[j].path}) and envFiles[${i}] (${file.path}) both have the key ${file.key}: give one a secret of its own`);
  });
  return all;
}

// Written into SQL and into the dump commands as it is, so only a plain name, or `schema.name` where one may have a
// schema. Lowercase: Postgres folds an unquoted name to lowercase, so `SchemaVersions` would name another table.
const SQL_NAME = /^[a-z_][a-z0-9_]*$/;

function sqlName(value, field, { schema = false } = {}) {
  string(value, field);
  const parts = value.split('.');
  if (parts.length > (schema ? 2 : 1) || !parts.every((p) => SQL_NAME.test(p))) fail(`${field} must be a lowercase name${schema ? ', or schema.name' : ''}`);
  return value;
}

// The table where the database's migration tool records each migration it ran, one row a migration with its name in
// `column`. Restore a dump reads it; only Postgres has one.
function migrationsTable(value, field, engine) {
  if (value === null) return null;
  if (engine !== 'postgres') fail(`${field} is for a postgres database only (write null, or leave it out)`);
  const t = fields(value, field, PROJECT_FIELDS['databases.migrationsTable']);
  return { table: sqlName(t.table, `${field}.table`, { schema: true }), column: sqlName(t.column, `${field}.column`) };
}

// A Mongo collection's name, as mongodump's --excludeCollection takes it.
const COLLECTION_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

// What Restore a dump's commands leave out of a dump (console/public/dbRestore.js): `skip`, the tables whose rows
// (postgres) or the collections (mongo); and for postgres the `extensions` pg_dump keeps, the only ones its user may
// create. None given: every row, every collection, and pg_dump's own choice of extensions.
const NO_DUMP = Object.freeze({ skip: [], extensions: [] });
function dump(value, field, engine) {
  if (value === null) return NO_DUMP;
  const d = fields(value, field, PROJECT_FIELDS['databases.dump'], { skip: [], extensions: [] });
  const skip = engine === 'postgres'
    ? list(d.skip, `${field}.skip`, (v, f) => sqlName(v, f, { schema: true }))
    : list(d.skip, `${field}.skip`, (v, f) => {
      if (typeof v !== 'string' || !COLLECTION_NAME.test(v)) fail(`${f} must be a collection's name`);
      return v;
    });
  const extensions = list(d.extensions, `${field}.extensions`, sqlName);
  if (extensions.length && engine !== 'postgres') fail(`${field}.extensions is for a postgres database only`);
  return { skip, extensions };
}

// One database a session gets its own copy of, on the engine it names (shared/databases/): what its template is built
// with, and from.
function database(value, field, secrets) {
  const db = fields(value, field, PROJECT_FIELDS.databases,
    { migrate: null, seed: null, envFiles: [], paths: [], migrations: null, migrationsTable: null, dump: null, user: null, name: null });
  if (!ENGINE_NAMES.includes(db.engine)) fail(`${field}.engine must be one of ${ENGINE_NAMES.join(', ')} (it is ${JSON.stringify(db.engine)})`);
  const envFiles = list(db.envFiles, `${field}.envFiles`, secretName);
  const unknown = envFiles.filter((secret) => !secrets.includes(secret));
  if (unknown.length) fail(`${field}.envFiles names ${unknown.join(', ')}, which no envFiles entry has as its secret`);
  return {
    engine: db.engine, dir: repoPath(db.dir, `${field}.dir`),
    migrate: nullable(db.migrate, `${field}.migrate`, string), seed: nullable(db.seed, `${field}.seed`, string), envFiles,
    paths: list(db.paths, `${field}.paths`, repoPath), migrations: nullable(db.migrations, `${field}.migrations`, repoPath),
    migrationsTable: migrationsTable(db.migrationsTable, `${field}.migrationsTable`, db.engine),
    dump: dump(db.dump, `${field}.dump`, db.engine),
    user: nullable(db.user, `${field}.user`, string), name: nullable(db.name, `${field}.name`, string),
  };
}

// One an engine: a person's copy is `woodshed_<login>` on each engine's server, so two of one engine would be one.
function databases(value, secrets) {
  const all = list(value, 'databases', (d, where) => database(d, where, secrets));
  const engines = all.map((d) => d.engine);
  const repeated = engines.filter((e, i) => engines.indexOf(e) !== i);
  if (repeated.length) fail(`databases has ${[...new Set(repeated)].join(', ')} more than once: one database an engine`);
  return all;
}

// One word: the manifest (installsManifest) separates a list's items with spaces.
function word(value, field) {
  string(value, field);
  if (/\s/.test(value)) fail(`${field} must have no spaces`);
  return value;
}

// A path an install keeps: under its dir, or under the session's home as `~/...`.
function outputPath(value, field) {
  word(value, field);
  if (value.split('/').includes('..') || path.isAbsolute(value)) fail(`${field} must be a path under the install's dir, or ~/ for the home`);
  if (value === '~/' || value === '~') fail(`${field} must be a folder under the home, not the home itself`);
  // deps.sh expands the list unquoted: a glob would keep whatever matched at the time.
  if (/[*?[]/.test(value)) fail(`${field} must be a path, not a glob`);
  return value;
}

function install(value, field) {
  const i = fields(value, field, PROJECT_FIELDS['dependencies.installs']);
  const files = list(i.files, `${field}.files`, (f, where) => repoPath(word(f, where), where));
  if (!files.length) fail(`${field}.files must name at least one file: a change to them is what reinstalls`);
  const command = string(i.command, `${field}.command`);
  if (/[\t\n]/.test(command)) fail(`${field}.command must be one line (join commands with &&)`);
  const output = list(i.output, `${field}.output`, outputPath);
  // An install the image keeps nothing of does nothing; and the manifest has no empty field, which bash's read drops.
  if (!output.length) fail(`${field}.output must name at least one folder the image keeps`);
  return { dir: repoPath(i.dir, `${field}.dir`), files, command, output };
}

// The repo's dependency installs: what the image runs, keeps and records, and a session runs again when their files
// changed (session/deps.sh). Nothing here knows a package manager, or the variable a registry's token is in: that is
// the installation's (README.md, "Install secrets").
function dependencies(value) {
  const d = fields(value, 'dependencies', PROJECT_FIELDS.dependencies, { installs: [] });
  const installs = list(d.installs, 'dependencies.installs', install);
  const dirs = installs.map((i) => i.dir);
  const repeated = dirs.filter((dir, i) => dirs.indexOf(dir) !== i);
  if (repeated.length) fail(`dependencies.installs has ${repeated.join(', ')} more than once: one install a dir`);
  return { installs };
}

/** `dependencies.installs` as session/deps.sh reads it: `install\t<dir>\t<files>\t<output>\t<command>` lines. */
export function installsManifest({ installs }) {
  return installs.map((i) => `${['install', i.dir, i.files.join(' '), i.output.join(' '), i.command].join('\t')}\n`).join('');
}

function app(value, where = 'app', names = PROJECT_FIELDS.app) {
  const a = fields(value, where, names, { stop: null, logs: {}, paths: [], label: null });
  return {
    start: string(a.start, `${where}.start`), stop: nullable(a.stop, `${where}.stop`, string),
    frontendPort: port(a.frontendPort, `${where}.frontendPort`), backendPort: port(a.backendPort, `${where}.backendPort`),
    logs: stringMap(a.logs, `${where}.logs`), paths: list(a.paths, `${where}.paths`, repoPath), howToProve: string(a.howToProve, `${where}.howToProve`),
  };
}

// Where QA runs: `actions` in the repo's own CI, which posts the check (.github/actions/qa), `woodshed` in a QA session
// the console starts when the label goes on (console/qaSessions.mjs).
export const QA_RUNNERS = Object.freeze(['actions', 'woodshed']);

// What the console's Start app sends and statusd and the console show: short, and safe in a URL, a menu and a log line.
const APP_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
// The one app a project file's `app` gives, in the shape `apps` gives: a project with one app is a project of one.
export const SINGLE_APP_NAME = 'app';

function appName(value, field) {
  if (typeof value !== 'string' || !APP_NAME.test(value)) fail(`${field} must be lowercase letters, digits and dashes, at most 32`);
  return value;
}

// `apps`: several apps, one running at a time, the first the default. Each is an `app` with a name and a label.
function apps(value) {
  if (!Array.isArray(value)) fail('apps must be a list of apps, each with a name (write app for one)');
  const all = value.map((entry, i) => {
    const where = `apps[${i}]`;
    const read = app(entry, where, PROJECT_FIELDS.apps);
    const name = appName(entry.name, `${where}.name`);
    return { name, label: nullable(entry.label ?? null, `${where}.label`, string) ?? name, ...read };
  });
  const names = all.map((a) => a.name);
  const repeated = names.filter((n, i) => names.indexOf(n) !== i);
  if (repeated.length) fail(`apps has ${[...new Set(repeated)].join(', ')} more than once: each app needs a name of its own`);
  return all;
}

// `app` and `apps` are two ways to write one thing: `apps` is what statusd, readyGate and the check read, and `app` is
// its first, the default, which every reader of one app keeps reading.
function projectApps(project) {
  const single = project.app !== null;
  const several = project.apps !== null && !(Array.isArray(project.apps) && project.apps.length === 0);
  if (single && several) fail('has both app and apps: write app for one app, or apps for several');
  if (several) {
    const all = apps(project.apps);
    return { app: all[0], apps: all };
  }
  const one = nullable(project.app, 'app', (v) => app(v));
  return { app: one, apps: one ? [{ name: SINGLE_APP_NAME, label: SINGLE_APP_NAME, ...one }] : [] };
}

/**
 * The app a name picks: the default (the first) when it is missing.
 * @param {{apps: object[]}} project  parsed
 * @param {string|null|undefined} name
 * @returns {object|null}  null for a name that is not one of them, or a project with no app
 */
export function appNamed(project, name) {
  if (name === undefined || name === null || name === '') return project.apps[0] ?? null;
  return project.apps.find((a) => a.name === name) ?? null;
}

// What a pull request a session opens must pass before the console posts it to Slack, in the repo's own CI's words:
// the review whose verdict counts, the suites whose jobs must pass, and the QA and Merge risk checks the brief quotes.
// The console has no names of its own for any of them (console/prAnnouncer.mjs, decisionBrief.mjs).
function pullRequests(value) {
  const p = fields(value, 'pullRequests', PROJECT_FIELDS.pullRequests, { review: null, suites: [], qa: null, mergeRisk: null });
  const review = nullable(p.review, 'pullRequests.review', (r) => {
    const f = fields(r, 'pullRequests.review', PROJECT_FIELDS['pullRequests.review'], { rerun: null, commentAuthor: null });
    return {
      author: string(f.author, 'pullRequests.review.author'), heading: string(f.heading, 'pullRequests.review.heading'),
      workflow: repoPath(f.workflow, 'pullRequests.review.workflow'), rerun: nullable(f.rerun, 'pullRequests.review.rerun', string),
      commentAuthor: nullable(f.commentAuthor, 'pullRequests.review.commentAuthor', string),
    };
  });
  const suites = list(p.suites, 'pullRequests.suites', (s, where) => {
    const f = fields(s, where, PROJECT_FIELDS['pullRequests.suites'], { rerun: null });
    return {
      name: string(f.name, `${where}.name`), workflow: repoPath(f.workflow, `${where}.workflow`),
      jobs: string(f.jobs, `${where}.jobs`), rerun: nullable(f.rerun, `${where}.rerun`, string),
    };
  });
  const qa = nullable(p.qa, 'pullRequests.qa', (q) => {
    const f = fields(q, 'pullRequests.qa', PROJECT_FIELDS['pullRequests.qa'], { runner: 'actions', author: null });
    if (!QA_RUNNERS.includes(f.runner)) fail(`pullRequests.qa.runner must be one of ${QA_RUNNERS.join(', ')} (it is ${JSON.stringify(f.runner)})`);
    // A QA session's report is the console's check, so `woodshed` has no comment author to trust (sessions comment as the App).
    if (f.runner !== 'woodshed' && !Object.hasOwn(q, 'author')) fail('pullRequests.qa is missing author');
    const author = f.runner === 'woodshed' && !Object.hasOwn(q, 'author') ? null : string(f.author, 'pullRequests.qa.author');
    return {
      check: string(f.check, 'pullRequests.qa.check'), label: string(f.label, 'pullRequests.qa.label'),
      heading: string(f.heading, 'pullRequests.qa.heading'), author, runner: f.runner,
    };
  });
  const mergeRisk = nullable(p.mergeRisk, 'pullRequests.mergeRisk', (m) => {
    const f = fields(m, 'pullRequests.mergeRisk', PROJECT_FIELDS['pullRequests.mergeRisk']);
    // Trusted only from the review's own workflow run on the head commit, so it needs a review to come from.
    if (!review) fail('pullRequests.mergeRisk needs pullRequests.review: only the review\'s own workflow may post it');
    return { check: string(f.check, 'pullRequests.mergeRisk.check') };
  });
  return { review, suites, qa, mergeRisk };
}

// Only `version` must be written: everything else left out is none.
const TOP_DEFAULTS = {
  dependencies: { installs: [] }, env: {}, envFiles: [], databases: [], app: null, apps: null, editor: false, consoleLinks: true, githubAccess: 'full',
  rules: null, setup: null, pullRequests: null,
};

/**
 * @param {unknown} raw  the file, parsed
 * @returns {{version: number, dependencies: {installs: {dir: string, files: string[], command: string,
 *   output: string[]}[]}, env: Record<string, string>,
 *   envFiles: {path: string, secret: string|null, key: string, defaults: string[], lines: string[]}[], databases: object[],
 *   app: object|null,
 *   apps: {name: string, label: string}[],
 *   editor: boolean, consoleLinks: boolean, githubAccess: 'full'|'repo', rules: string|null, setup: string|null, pullRequests: object|null}}
 * @throws {Error}  naming the field that is wrong or missing
 */
export function parseProject(raw) {
  // The version first: another format's fields would otherwise read as misspelt.
  if (Object.hasOwn(raw ?? {}, 'version') && raw.version !== PROJECT_VERSION) {
    fail(`version must be ${PROJECT_VERSION}, the format this version of Woodshed reads (it is ${JSON.stringify(raw.version)})`);
  }
  const project = fields(raw, '', PROJECT_FIELDS[''], TOP_DEFAULTS);
  const envFiles = envFileList(project.envFiles);
  return {
    version: project.version,
    dependencies: dependencies(project.dependencies),
    env: stringMap(project.env, 'env'),
    envFiles,
    databases: databases(project.databases, envFiles.map((f) => f.secret).filter(Boolean)),
    ...projectApps(project),
    editor: boolean(project.editor, 'editor'),
    consoleLinks: boolean(project.consoleLinks, 'consoleLinks'),
    githubAccess: githubAccess(project.githubAccess),
    rules: nullable(project.rules, 'rules', repoPath),
    setup: nullable(project.setup, 'setup', repoPath),
    pullRequests: nullable(project.pullRequests, 'pullRequests', pullRequests),
  };
}

/** What a repo with no project file gets: Woodshed's own rules, and nothing else. */
export const EMPTY_PROJECT = Object.freeze({
  version: PROJECT_VERSION, dependencies: { installs: [] }, env: {}, envFiles: [], databases: [], app: null, apps: [], editor: false, consoleLinks: true,
  githubAccess: 'full', rules: null, setup: null, pullRequests: null,
});

// The default branch's copy, or null when it has no such file. Anything else git fails on (no remote branch, not a
// repository) is an error: read as "no file", it would start the session with no env files and only `from: none` to show for it.
function gitShow(repoDir, file) {
  const branch = defaultBranchOf(repoDir);
  if (!branch) return fail("not in the checkout, and the repo's default branch could not be told, so its copy could not be read");
  try {
    return execFileSync('git', ['-C', repoDir, 'show', `origin/${branch}:${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const stderr = String(err.stderr ?? '').trim();
    if (/path '.*' (does not exist in|exists on disk, but not in) 'origin\/.+'/.test(stderr)) return null;
    return fail(`not in the checkout, and the default branch's copy could not be read (${stderr.split('\n')[0] || err.message})`);
  }
}

/**
 * A file of the project's, from the checkout or else from the default branch.
 * @returns {{text: string, from: 'checkout'|'default branch'}|null}
 */
export function readRepoFile(repoDir, file) {
  const local = path.join(repoDir, file);
  if (fs.existsSync(local)) return { text: fs.readFileSync(local, 'utf8'), from: 'checkout' };
  const text = gitShow(repoDir, file);
  return text === null ? null : { text, from: 'default branch' };
}

/**
 * The repo a checkout is of, as GitHub names it, from its `origin`: every clone Woodshed makes (install.sh, the
 * session image, a session on another project) fetches from `https://github.com/<owner>/<name>.git`.
 * @returns {string|null}  owner/name, null when the origin is not on GitHub or the folder is no checkout
 */
export function repoOf(repoDir) {
  let url;
  try {
    url = execFileSync('git', ['-C', repoDir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
  const match = /^(?:https:\/\/(?:[^/@]*@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  return match ? `${match[1]}/${match[2]}` : null;
}

// The one entry in `dir` whose name is `name` in any case: GitHub's names are case-insensitive, and the folder's
// writer may not spell them as the checkout's origin does.
function entryIn(dir, name) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
  const found = names.filter((n) => n.toLowerCase() === name.toLowerCase());
  if (found.length > 1) fail(`the installation has ${found.map((n) => path.join(dir, n)).join(' and ')}, which name one repo: keep one`);
  return found.length ? path.join(dir, found[0]) : null;
}

/**
 * The project file the installation supplies for a repo that has none of its own: `<dir>/<owner>/<name>.yaml`, the
 * names matched in any case (docs/reference.md, "The project file"). A missing folder or file is none.
 * @param {{dir: string|null|undefined, repo: string}} args  `repo` is owner/name
 * @returns {{text: string, path: string}|null}
 */
export function installationProjectFile({ dir, repo }) {
  if (!dir) return null;
  const [owner, name] = String(repo).split('/');
  if (!owner || !name) throw new Error(`not a repo, owner/name: ${repo}`);
  const ownerDir = entryIn(dir, owner);
  const file = ownerDir && entryIn(ownerDir, `${name}.yaml`);
  if (!file || !fs.statSync(file).isFile()) return null;
  try {
    return { text: fs.readFileSync(file, 'utf8'), path: file };
  } catch (err) {
    // A session and the db-admin task read it as the image's node user, whose uid need not own it.
    if (err.code === 'EACCES') throw new Error(`the installation's project file ${file} cannot be read by uid ${process.getuid?.()}: make it readable by everyone`);
    throw err;
  }
}

// The repo's own file, or else the installation's. A folder is named only by WOODSHED_PROJECT_FILES_DIR, so
// the repo is told from the checkout only then; one that cannot be told is an error, not a repo with no file.
function projectFileOf(repoDir, { projectFilesDir, repo }) {
  const file = readRepoFile(repoDir, PROJECT_FILE);
  if (file || !projectFilesDir) return file;
  const of = repo ?? repoOf(repoDir);
  if (!of) fail(`not in the checkout or on the default branch, and the repo could not be told from its origin to find the installation's file in ${projectFilesDir}`);
  const supplied = installationProjectFile({ dir: projectFilesDir, repo: of });
  return supplied && { text: supplied.text, from: 'installation', path: supplied.path };
}

/**
 * @param {string} repoDir
 * @param {{projectFilesDir?: string|null, repo?: string}} [opts]  `projectFilesDir` is the installation's folder of
 *   project files (WOODSHED_PROJECT_FILES_DIR by default); `repo` is owner/name, told from the checkout's origin
 *   without it
 * @returns {ReturnType<typeof parseProject> & {from: 'checkout'|'default branch'|'installation'|'none'}}
 */
export function loadProject(repoDir, { projectFilesDir = envValue(process.env, 'PROJECT_FILES_DIR') || null, repo } = {}) {
  const file = projectFileOf(repoDir, { projectFilesDir, repo });
  if (!file) return { ...EMPTY_PROJECT, from: 'none' };
  try {
    return { ...readProjectText(file.text), from: file.from };
  } catch (err) {
    // The installation's file is wrong in the same ways a repo's is, and is named by its path.
    if (file.from === 'installation') err.message = err.message.replace(PROJECT_FILE, `the installation's project file ${file.path}`);
    throw err;
  }
}

function readProjectText(text) {
  let raw;
  try {
    raw = parseYaml(text);
  } catch (err) {
    fail(`not read as YAML (${err.message})`);
  }
  if (raw === null) fail(`is empty: write version: ${PROJECT_VERSION} at least (docs/reference.md, "The project file")`);
  return parseProject(raw);
}

/**
 * `{{NAME}}` is the variable's value, empty when it is unset. A line with `{{NAME?}}` is left out when NAME is empty.
 * @returns {string|null}  null when the line is left out
 */
export function renderLine(line, env) {
  let dropped = false;
  const text = line.replace(PLACEHOLDER, (_, name, optional) => {
    const value = env[name] ?? '';
    if (optional && !value) dropped = true;
    return value;
  });
  return dropped ? null : text;
}

/** A path from the project file, with `~` and `{{CHECKOUT}}` (the checkout's folder name) filled in. */
export function expandPath(value, { repoDir, home = os.homedir() }) {
  const withCheckout = value.replaceAll('{{CHECKOUT}}', path.basename(repoDir));
  return withCheckout.startsWith('~/') ? path.join(home, withCheckout.slice(2)) : path.resolve(repoDir, withCheckout);
}

/**
 * An env file as the session writes it: the repo's defaults, the shared secret's text, the owner's own lines, then the
 * project's lines (layeredEnvText in repoSettings.mjs). dotenv keeps the last value of a repeated key, so the project's
 * lines win, then the owner's, then the secret's.
 */
export function envFileText({ defaults = [], base, own, lines, env }) {
  const session = lines.map((line) => renderLine(line, env)).filter((line) => line !== null);
  return layeredEnvText({ defaults, installation: base, personal: own, session });
}

// Not the project file's fault, so not fail's prefix.
function badSettings(message) {
  throw new Error(message);
}

/**
 * A session's repo settings, as the console's `POST /repo-settings` answered them (the entrypoint keeps the answer in the
 * file REPO_SETTINGS_FILE names), each layer's text a string, or null for none: a key the answer leaves out, an empty
 * text and null are all none. A personal value counts only with `personalFor`, the private session's owner: a shared
 * session's answer has none, and one that did is dropped. No file is null: an older console, or none at all.
 * @param {string|null|undefined} file
 * @returns {{project: string, envFiles: Record<string, {installation: string|null, personal: string|null}>,
 *   instructions: {installation: string|null, personal: string|null}, personalFor: string|null}|null}
 */
export function readRepoSettings(file) {
  if (!file) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    // Never the parser's message: it quotes the text, which holds the values.
    badSettings(`the console's repo settings could not be read (${err.code ?? 'not JSON'})`);
  }
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObject(raw) || typeof raw.project !== 'string' || !isObject(raw.envFiles ?? {}) || !isObject(raw.instructions ?? {})) {
    badSettings("the console's repo settings are not the session API's answer");
  }
  const personalFor = typeof raw.personalFor === 'string' && raw.personalFor ? raw.personalFor : null;
  const text = (value, where) => {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') badSettings(`the console's repo settings have ${where} that is not text`);
    return value.trim() ? value : null;
  };
  const layers = (value, where) => {
    const given = isObject(value) ? value : {};
    return { installation: text(given.installation, `${where}.installation`), personal: personalFor ? text(given.personal, `${where}.personal`) : null };
  };
  return {
    project: raw.project,
    envFiles: Object.fromEntries(Object.entries(raw.envFiles ?? {}).map(([key, value]) => [key, layers(value, `envFiles.${key}`)])),
    instructions: layers(raw.instructions, 'instructions'),
    personalFor,
  };
}

const bytesOf = (value) => Buffer.byteLength(value ?? '');

/** What a repo settings answer holds, for the session's log: each layer's keys and sizes, never a value. */
export function repoSettingsSummary(settings) {
  const sized = (entries) => entries.filter(([, value]) => value).map(([name, value]) => `${name} (${bytesOf(value)} bytes)`).join(' ') || 'none';
  const files = Object.entries(settings.envFiles);
  return [
    `project: ${settings.project}`,
    `installation: ${sized(files.map(([key, layers]) => [key, layers.installation]))}`,
    `personal: ${sized(files.map(([key, layers]) => [key, layers.personal]))}`,
    `instructions: ${sized(Object.entries(settings.instructions))}`,
    `personal for: ${settings.personalFor ? `@${settings.personalFor}` : 'none'}`,
  ].join(', ');
}

// One env file's installation and personal text. With repo settings, each is the console's value; one with none falls
// back to the legacy text (the Terraform secret's variable, the /settings answer's own lines) while an installation
// still has it, which `legacy` names for the log's warning. Without repo settings, the legacy text as before.
function envFileLayers({ file, settings, env, own }) {
  const legacyInstallation = file.secret ? env[secretEnvName(file.secret)] ?? '' : '';
  const legacyPersonal = file.secret ? own[file.secret] ?? '' : '';
  if (!settings) return { installation: legacyInstallation, personal: legacyPersonal, legacy: [] };
  const given = settings.envFiles[file.key] ?? { installation: null, personal: null };
  const legacy = [];
  let installation = given.installation ?? '';
  if (!installation && legacyInstallation.trim()) {
    installation = legacyInstallation;
    legacy.push('installation');
  }
  let personal = given.personal ?? '';
  if (!personal && legacyPersonal.trim()) {
    personal = legacyPersonal;
    legacy.push('personal');
  }
  return { installation, personal, legacy };
}

// The keys a layer before the session's sets that the session's wiring replaces, for the log.
function sessionReplaced({ defaults, installation, personal, session, project, env }) {
  const services = (env.WOODSHED_SERVICES ?? '').split(/\s+/).filter(Boolean);
  const wiring = sessionWiring({ lines: session, env: project.env, services });
  const layers = { repo: defaults.join('\n'), installation, personal, session: session.join('\n') };
  return envKeyTable({ layers, wiring }).filter((row) => row.wins === 'session' && row.setBy.some((layer) => layer !== 'session')).map((row) => row.key);
}

/**
 * @param {{project: ReturnType<typeof parseProject>, repoDir: string, env: NodeJS.ProcessEnv,
 *   settings?: ReturnType<typeof readRepoSettings>}} args
 *   `env.OWN_FILES` is the owner's own lines, as the console's `/settings` answer has them: `{<secret>: text}`;
 *   `settings` the console's repo settings, null to write the files from the legacy secrets alone, as before them
 * @returns {{path: string, key: string, baseBytes: number, own: boolean, personalBytes: number, defaults?: number,
 *   unset?: string[], layers: string[], legacy: string[], replaced: string[]}[]}
 */
export function writeEnvFiles({ project, repoDir, env, settings = null }) {
  const own = env.OWN_FILES ? JSON.parse(env.OWN_FILES) : {};
  return project.envFiles.map((file) => {
    const { installation, personal, legacy } = envFileLayers({ file, settings, env, own });
    const session = file.lines.map((line) => renderLine(line, env)).filter((line) => line !== null);
    const target = path.join(repoDir, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, layeredEnvText({ defaults: file.defaults, installation, personal, session }));
    const unset = unsetPlaceholders(file.lines, env);
    const layers = [file.defaults.length && 'repo', installation && 'installation', personal && 'personal', session.length && 'session'].filter(Boolean);
    return {
      path: file.path, key: file.key, baseBytes: Buffer.byteLength(installation), own: Boolean(personal), personalBytes: Buffer.byteLength(personal),
      ...(file.defaults.length && { defaults: file.defaults.length }), ...(unset.length && { unset }), layers, legacy,
      replaced: sessionReplaced({ defaults: file.defaults, installation, personal, session, project, env }),
    };
  });
}

/**
 * What `write-env-files` prints: one line naming each file, then a line for each warning. Without repo settings, the
 * line Woodshed printed before them, byte for byte. With them, each file's layers and sizes, and the keys the session
 * replaced; each value taken from a legacy secret, and each key the answer holds that this checkout's project file
 * has no env file for, has a line of its own. Keys and sizes only, never a value.
 * @param {{written: ReturnType<typeof writeEnvFiles>, settings: ReturnType<typeof readRepoSettings>, project: ReturnType<typeof parseProject>}} args
 * @returns {string[]}
 */
export function writtenLines({ written, settings, project }) {
  const unset = (w) => (w.unset ? `, unset: ${w.unset.join(' ')}` : '');
  const defaults = (w) => (w.defaults ? `, defaults: ${w.defaults}` : '');
  if (!settings) return [written.map((w) => `${w.path} (base: ${w.baseBytes} bytes${defaults(w)}${w.own ? ', own lines' : ''}${unset(w)})`).join(', ') || 'none'];
  const legacy = (w, layer) => (w.legacy.includes(layer) ? ' from the legacy secret' : '');
  const summary = written.map((w) => `${w.path} (layers: ${w.layers.join(' ') || 'none'}${defaults(w)}, installation: ${w.baseBytes} bytes${legacy(w, 'installation')}`
    + `${w.own ? `, personal: ${w.personalBytes} bytes${legacy(w, 'personal')}` : ''}, replaced by the session: ${w.replaced.join(' ') || 'none'}${unset(w)})`).join(', ') || 'none';
  const secretOf = (w) => project.envFiles.find((f) => f.key === w.key)?.secret;
  const warnings = written.flatMap((w) => [
    w.legacy.includes('installation') && `WARNING: ${w.path} from the legacy env file secret ${secretOf(w)}: set it on Console settings → Repos`,
    w.legacy.includes('personal') && `WARNING: ${w.path}'s own lines from the legacy env file lines (${secretOf(w)}) of My settings: save them on its Repo settings`,
  ]).filter(Boolean);
  const known = new Set(project.envFiles.map((f) => f.key));
  const unused = Object.entries(settings.envFiles).filter(([key, layers]) => !known.has(key) && (layers.installation || layers.personal)).map(([key]) => key);
  if (unused.length) warnings.push(`Repo settings unused: this checkout's project file has no env file with the key (keys: ${unused.join(' ')})`);
  return [summary, ...warnings];
}

/** The variables lines need (`{{NAME}}`, not `{{NAME?}}`) that `env` leaves empty, such as a service the installation does not run. */
export function unsetPlaceholders(lines, env) {
  const names = lines.flatMap((line) => [...line.matchAll(PLACEHOLDER)].filter(([, , optional]) => !optional).map(([, name]) => name));
  return [...new Set(names)].filter((name) => !env[name]);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The project's `env` as `export` lines, values filled in from `env` as env file lines are. */
export function exportLines({ project, env }) {
  return Object.entries(project.env).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) fail(`env.${name} is not a variable name`);
    return `export ${name}=${shellQuote(renderLine(value, env) ?? '')}`;
  });
}

/**
 * Whether the project's env uses a variable: it exports it, writes it into an env file, or takes it from the session's
 * environment (`{{NAME}}`). A repo that never mentions Redis, say, is not given one.
 * @param {{env: Record<string, string>, envFiles: {defaults?: string[], lines: string[]}[]}} project
 */
export function usesVariable(project, name) {
  if (name in project.env) return true;
  return project.envFiles.some((f) => f.defaults?.some((line) => line.startsWith(`${name}=`))
    || f.lines.some((line) => line.startsWith(`${name}=`) || line.includes(`{{${name}}}`) || line.includes(`{{${name}?}}`))) ||
    Object.values(project.env).some((value) => value.includes(`{{${name}}}`));
}

/** @returns {string[]}  the engines an installation must host for the project: one for each of its databases */
export function neededDatabases(project) {
  return project.databases.map((d) => d.engine);
}

/**
 * What a session's rules say of a project with several apps: each one, how it starts and how to prove a change in it.
 * One app or none says nothing, so its rules read as they always did.
 * @returns {string}  markdown list lines, or ''
 */
export function appsRules({ apps }) {
  if (apps.length < 2) return '';
  const line = (a, i) => `  - \`${a.name}\`${a.label !== a.name ? ` (${a.label})` : ''}${i === 0 ? ', the default' : ''}: \`${a.start}\`, its frontend on port ${a.frontendPort}`
    + `${a.paths.length ? `, for changes under ${a.paths.map((p) => `\`${p}\``).join(', ')}` : ''}. To prove a change in it: ${a.howToProve}`;
  return [
    '- This project has several apps, and one runs at a time: starting another stops the one running first, with its `stop`. '
      + 'The console\'s Start app picks one, and Open app opens whichever runs. Prove each change in the app it is in, which you start yourself:',
    ...apps.map(line),
  ].join('\n');
}

export function field(project, dotted) {
  return dotted.split('.').reduce((value, key) => (value && typeof value === 'object' ? value[key] : undefined), project);
}

async function main([command, arg]) {
  // Before the project file is read: the session fetches its repo settings before its branch is checked out.
  if (command === 'repo-settings') {
    const settings = readRepoSettings(process.env.REPO_SETTINGS_FILE) ?? badSettings('repo-settings reads the file REPO_SETTINGS_FILE names');
    process.stdout.write(`${repoSettingsSummary(settings)}\n`);
    return;
  }
  const repoDir = process.env.REPO_DIR || process.cwd();
  const project = loadProject(repoDir);
  if (command === 'check') {
    // Loaded here, not imported: projectCheck.mjs imports this module.
    const { checkSummary } = await import('./projectCheck.mjs');
    process.stdout.write(`${checkSummary(project, repoDir).join('\n')}\n`);
  } else if (command === 'get') {
    const value = field(project, arg ?? '');
    if (value === undefined || value === null) return;
    const text = (v) => (typeof v === 'object' ? JSON.stringify(v) : v);
    process.stdout.write(`${Array.isArray(value) ? value.map(text).join('\n') : text(value)}\n`);
  } else if (command === 'env') {
    const lines = exportLines({ project, env: process.env });
    if (lines.length) process.stdout.write(`${lines.join('\n')}\n`);
  } else if (command === 'write-env-files') {
    const settings = readRepoSettings(process.env.REPO_SETTINGS_FILE);
    const written = writeEnvFiles({ project, repoDir, env: process.env, settings });
    process.stdout.write(`${writtenLines({ written, settings, project }).join('\n')}\n`);
  } else if (command === 'add-instructions') {
    if (!arg) fail('add-instructions takes the rules file');
    const settings = readRepoSettings(process.env.REPO_SETTINGS_FILE);
    if (!settings) return;
    const rules = fs.readFileSync(arg, 'utf8');
    const { installation, personal } = settings.instructions;
    const text = instructionsText({ rules, repoRules: Boolean(project.rules), installation, personal, login: settings.personalFor, repo: repoOf(repoDir) ?? settings.project });
    if (text === rules) return;
    fs.writeFileSync(arg, text);
    const sized = (value) => (value ? `${bytesOf(value)} bytes` : 'none');
    process.stdout.write(`installation: ${sized(installation)}, personal: ${sized(personal)}, added: ${bytesOf(text) - bytesOf(rules)} bytes\n`);
  } else if (command === 'file') {
    if (arg !== 'rules' && arg !== 'setup') fail('file takes rules or setup');
    const name = project[arg];
    const file = name ? readRepoFile(repoDir, name) : null;
    if (name && !file) fail(`${arg} names ${name}, which is not in the checkout or on the default branch`);
    if (file) process.stdout.write(file.text);
  } else if (command === 'uses') {
    if (usesVariable(project, arg ?? '')) process.stdout.write('yes\n');
  } else if (command === 'secret-vars') {
    const names = project.envFiles.filter((f) => f.secret).map((f) => secretEnvName(f.secret));
    if (names.length) process.stdout.write(`${names.join('\n')}\n`);
  } else if (command === 'installs') {
    process.stdout.write(installsManifest(project.dependencies));
  } else if (command === 'apps-rules') {
    const text = appsRules(project);
    if (text) process.stdout.write(`${text}\n`);
  } else {
    throw new Error(`unknown command: ${command} (expected check, get, env, write-env-files, repo-settings, add-instructions, file, uses, secret-vars, installs or apps-rules)`);
  }
}

if (isMain(import.meta.url)) {
  // Not awaited: check's import of projectCheck.mjs waits for this module, which a top-level await would never finish.
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(err.message.split('\n').map((line) => `project: ${line}\n`).join(''));
    process.exit(1);
  });
}
