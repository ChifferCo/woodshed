// The project file: what a session needs to know about the repo it works on, so nothing here names that repo's
// directories, commands or ports. It is `.woodshed/project.yaml` in the repo (docs/reference.md, "The project file").
//
//   node project.mjs get <field>         a field, dotted (`app.start`); an array prints one item a line (a mapping as
//                                        JSON), a missing field prints nothing
//   node project.mjs env                 the project's `env`, as `export` lines for the entrypoint to eval
//   node project.mjs write-env-files     each of `envFiles`: its secret's text, the owner's own lines, then its lines;
//                                        prints each file, with the variables its lines need that are unset
//   node project.mjs file <rules|setup>  the text of the file that field names, empty without one
//   node project.mjs secret-vars         the variables the env files' secrets arrive in, one a line
//   node project.mjs installs            `dependencies.installs` as the manifest session/deps.sh reads: one `install`
//                                        line each (installsManifest)
//
// The repo is REPO_DIR. The checkout's own file is read first, so a branch can change it; a branch from before the file
// existed gets the default branch's, and a repo with neither gets EMPTY_PROJECT: no dependencies, env files, databases or app.
// Only `version` must be written; a field that can be none and is left out is none. A misspelt field is refused.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ENGINE_NAMES } from './databases/index.mjs';
import { defaultBranchOf } from './defaultBranch.mjs';
import { parseYaml } from './yamlLite.mjs';
import { isMain } from './isMain.mjs';

export const PROJECT_FILE = '.woodshed/project.yaml';
// While Woodshed Cloud is in beta the format changes in place, with every project file in the same change (README.md,
// "Changing the format").
export const PROJECT_VERSION = 1;

/**
 * Where the session image keeps a repo's checkout: `/work/<name>`. The image workflow passes the same path to the
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
  '': ['version', 'dependencies', 'env', 'envFiles', 'databases', 'app', 'editor', 'rules', 'setup', 'pullRequests'],
  dependencies: ['installs'],
  'dependencies.installs': ['dir', 'files', 'command', 'output'],
  envFiles: ['path', 'secret', 'lines'],
  databases: ['engine', 'dir', 'migrate', 'seed', 'envFiles', 'paths', 'migrations', 'migrationsTable', 'dump', 'user', 'name'],
  'databases.migrationsTable': ['table', 'column'],
  'databases.dump': ['skip', 'extensions'],
  app: ['start', 'stop', 'frontendPort', 'backendPort', 'logs', 'paths', 'howToProve'],
  pullRequests: ['review', 'suites', 'qa', 'mergeRisk'],
  'pullRequests.review': ['author', 'heading', 'workflow', 'rerun', 'commentAuthor'],
  'pullRequests.suites': ['name', 'workflow', 'jobs', 'rerun'],
  'pullRequests.qa': ['check', 'label', 'heading', 'author'],
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

function envFile(value, field) {
  const file = fields(value, field, PROJECT_FIELDS.envFiles, { secret: null, lines: [] });
  return { path: repoPath(file.path, `${field}.path`), secret: nullable(file.secret, `${field}.secret`, secretName), lines: list(file.lines, `${field}.lines`, string) };
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

function app(value) {
  const a = fields(value, 'app', PROJECT_FIELDS.app,
    { stop: null, logs: {}, paths: [] });
  return {
    start: string(a.start, 'app.start'), stop: nullable(a.stop, 'app.stop', string),
    frontendPort: port(a.frontendPort, 'app.frontendPort'), backendPort: port(a.backendPort, 'app.backendPort'),
    logs: stringMap(a.logs, 'app.logs'), paths: list(a.paths, 'app.paths', repoPath), howToProve: string(a.howToProve, 'app.howToProve'),
  };
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
    const f = fields(q, 'pullRequests.qa', PROJECT_FIELDS['pullRequests.qa']);
    return {
      check: string(f.check, 'pullRequests.qa.check'), label: string(f.label, 'pullRequests.qa.label'),
      heading: string(f.heading, 'pullRequests.qa.heading'), author: string(f.author, 'pullRequests.qa.author'),
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
  dependencies: { installs: [] }, env: {}, envFiles: [], databases: [], app: null, editor: false, rules: null, setup: null, pullRequests: null,
};

/**
 * @param {unknown} raw  the file, parsed
 * @returns {{version: number, dependencies: {installs: {dir: string, files: string[], command: string,
 *   output: string[]}[]}, env: Record<string, string>,
 *   envFiles: {path: string, secret: string|null, lines: string[]}[], databases: object[], app: object|null,
 *   editor: boolean, rules: string|null, setup: string|null, pullRequests: object|null}}
 * @throws {Error}  naming the field that is wrong or missing
 */
export function parseProject(raw) {
  // The version first: another format's fields would otherwise read as misspelt.
  if (Object.hasOwn(raw ?? {}, 'version') && raw.version !== PROJECT_VERSION) {
    fail(`version must be ${PROJECT_VERSION}, the format this Woodshed Cloud reads (it is ${JSON.stringify(raw.version)})`);
  }
  const project = fields(raw, '', PROJECT_FIELDS[''], TOP_DEFAULTS);
  const envFiles = list(project.envFiles, 'envFiles', envFile);
  return {
    version: project.version,
    dependencies: dependencies(project.dependencies),
    env: stringMap(project.env, 'env'),
    envFiles,
    databases: databases(project.databases, envFiles.map((f) => f.secret).filter(Boolean)),
    app: nullable(project.app, 'app', app),
    editor: boolean(project.editor, 'editor'),
    rules: nullable(project.rules, 'rules', repoPath),
    setup: nullable(project.setup, 'setup', repoPath),
    pullRequests: nullable(project.pullRequests, 'pullRequests', pullRequests),
  };
}

/** What a repo with no project file gets: Woodshed Cloud's own rules, and nothing else. */
export const EMPTY_PROJECT = Object.freeze({
  version: PROJECT_VERSION, dependencies: { installs: [] }, env: {}, envFiles: [], databases: [], app: null, editor: false, rules: null, setup: null,
  pullRequests: null,
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

/** @returns {ReturnType<typeof parseProject> & {from: 'checkout'|'default branch'|'none'}} */
export function loadProject(repoDir) {
  const file = readRepoFile(repoDir, PROJECT_FILE);
  if (!file) return { ...EMPTY_PROJECT, from: 'none' };
  let raw;
  try {
    raw = parseYaml(file.text);
  } catch (err) {
    fail(`not read as YAML (${err.message})`);
  }
  if (raw === null) fail(`is empty: write version: ${PROJECT_VERSION} at least (docs/reference.md, "The project file")`);
  return { ...parseProject(raw), from: file.from };
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
 * An env file as the session writes it: the shared secret's text, the owner's own lines, then the project's lines.
 * dotenv keeps the last value of a repeated key, so the project's lines win, then the owner's.
 */
export function envFileText({ base, own, lines, env }) {
  const withOwn = own ? `${base}\n\n# Your own lines, from My settings\n${own}` : base;
  const rendered = lines.map((line) => renderLine(line, env)).filter((line) => line !== null);
  return `${withOwn}\n\n# Woodshed Cloud overrides\n${rendered.join('\n')}\n`;
}

/**
 * @param {{project: ReturnType<typeof parseProject>, repoDir: string, env: NodeJS.ProcessEnv}} args
 *   `env.OWN_FILES` is the owner's own lines, as the console's `/settings` answer has them: `{<secret>: text}`
 * @returns {{path: string, baseBytes: number, own: boolean}[]}
 */
export function writeEnvFiles({ project, repoDir, env }) {
  const own = env.OWN_FILES ? JSON.parse(env.OWN_FILES) : {};
  return project.envFiles.map((file) => {
    const base = file.secret ? env[secretEnvName(file.secret)] ?? '' : '';
    const ownLines = file.secret ? own[file.secret] ?? '' : '';
    const target = path.join(repoDir, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, envFileText({ base, own: ownLines, lines: file.lines, env }));
    const unset = unsetPlaceholders(file.lines, env);
    return { path: file.path, baseBytes: Buffer.byteLength(base), own: Boolean(ownLines), ...(unset.length && { unset }) };
  });
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
 * @param {{env: Record<string, string>, envFiles: {lines: string[]}[]}} project
 */
export function usesVariable(project, name) {
  if (name in project.env) return true;
  return project.envFiles.some((f) => f.lines.some((line) => line.startsWith(`${name}=`) || line.includes(`{{${name}}}`) || line.includes(`{{${name}?}}`))) ||
    Object.values(project.env).some((value) => value.includes(`{{${name}}}`));
}

/** @returns {string[]}  the engines an installation must host for the project: one for each of its databases */
export function neededDatabases(project) {
  return project.databases.map((d) => d.engine);
}

export function field(project, dotted) {
  return dotted.split('.').reduce((value, key) => (value && typeof value === 'object' ? value[key] : undefined), project);
}

function main([command, arg]) {
  const repoDir = process.env.REPO_DIR || process.cwd();
  const project = loadProject(repoDir);
  if (command === 'get') {
    const value = field(project, arg ?? '');
    if (value === undefined || value === null) return;
    const text = (v) => (typeof v === 'object' ? JSON.stringify(v) : v);
    process.stdout.write(`${Array.isArray(value) ? value.map(text).join('\n') : text(value)}\n`);
  } else if (command === 'env') {
    const lines = exportLines({ project, env: process.env });
    if (lines.length) process.stdout.write(`${lines.join('\n')}\n`);
  } else if (command === 'write-env-files') {
    const written = writeEnvFiles({ project, repoDir, env: process.env });
    const unset = (w) => (w.unset ? `, unset: ${w.unset.join(' ')}` : '');
    process.stdout.write(`${written.map((w) => `${w.path} (base: ${w.baseBytes} bytes${w.own ? ', own lines' : ''}${unset(w)})`).join(', ') || 'none'}\n`);
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
  } else {
    throw new Error(`unknown command: ${command} (expected get, env, write-env-files, file, uses, secret-vars or installs)`);
  }
}

if (isMain(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`project: ${err.message}\n`);
    process.exit(1);
  }
}
