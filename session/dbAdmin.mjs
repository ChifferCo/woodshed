// The db-admin task: the only code that uses the databases' root passwords (RDS's master user, Mongo's root), which
// only this task's execution role can read. Each of the project file's `databases` is on an engine
// (shared/databases/), and every owner's databases are a copy of the templates, migrated and seeded from the default branch, with a
// user of their own, the same name and password on each engine:
//
//   template              builds the templates again from this image's checkout, then swaps them in; the image
//                         workflow runs it after each session image. Kept as they are when none of the databases'
//                         `paths` changed since the commit they were built from, and only migrated, from copies of
//                         themselves, when the one change is new migrations
//   reset <login>         (re)makes <login>'s user with the password in its secret, and their databases as a fresh
//                         copy of the templates; a person's first databases are a reset too
//   drop <login>          a person's databases and user, for Remove My Woodshed
//   clone <session id>    a shared session's databases, a fresh copy of the templates, with the password in its secret
//   drop-session <id>     those, once the session has ended
//
// The task definition's entryPoint fixes the flags, `node dbAdmin.mjs --region ... --`, and a run adds only the
// command after it. ECS lets whoever runs the task (the console) override the command and the environment but
// never the entryPoint, so the console chooses an action and an owner and nothing else: the hosts the root
// passwords go to come from the flags, never from the environment.
//
// On the local provider (providers/local/dbAdminRunner.mjs) a run is a container of this image, and the secrets it
// reads are files in a folder mounted read-only, `--secrets-dir`, in place of Secrets Manager's `--region`.
//
// Which engines a run has is which engines' flags the entryPoint gives (each engine's `flags`): the installation's
// choice. `--project-files-dir` is the installation's folder of project files (WOODSHED_CLOUD_PROJECT_FILES_DIR), read
// for a repo with no `.woodshed/project.yaml` of its own. A flag, not the variable: the project file names the commands
// the seed runs, so a run's overrides must not be able to point the task at another one. A project database on an
// engine the run has no flags for stops it; an installation with no database has no db-admin task at all.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { secretsClient } from './awsSecrets.mjs';
import { ENGINES, ENGINE_NAMES, engine } from '../shared/databases/index.mjs';
import { SEEDER, TEMPLATE_NEXT } from '../shared/databases/names.mjs';
import { fileSecretsClient } from '../shared/fileSecrets.mjs';
import { loadProject, PROJECT_FILE, secretEnvName } from '../shared/project.mjs';
import { isMain } from '../shared/isMain.mjs';

// Every run's own flags; each engine adds its own. Where the secrets are is one of SECRET_SOURCES.
const FLAGS = ['secret-prefix', 'repo'];
const OPTIONAL_FLAGS = ['project-files-dir'];
const SECRET_SOURCES = ['region', 'secrets-dir'];
const ACTIONS = { template: 'none', reset: 'login', drop: 'login', clone: 'session', 'drop-session': 'session' };
// A clone started while a refresh swaps the templates in waits for them, as does one before the first template.
const TEMPLATE_WAIT_MS = 5 * 60_000;
const TEMPLATE_POLL_MS = 10_000;
const COPY_ATTEMPTS = 3;
// Written by the image's build: the commit its checkout is.
const BUILD_SHA_FILE = '/work/build-sha';
const ENTRYPOINT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'entrypoint.sh');
// What the agent, the image and the task definition set, beside each run engine's root password. A run's overrides
// can set any variable, so the task refuses one it does not expect rather than trust a deny-list of the ones Node or a
// library would act on.
const EXPECTED_ENV = new Set([
  // Fargate's agent
  'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_EXECUTION_ENV', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'ECS_CONTAINER_METADATA_URI', 'ECS_CONTAINER_METADATA_URI_V4', 'ECS_AGENT_URI',
  // The image and the task definition
  'PATH', 'HOME', 'HOSTNAME', 'LANG', 'NODE_VERSION', 'YARN_VERSION', 'NODE_EXTRA_CA_CERTS', 'REPO_DIR', 'WOODSHED_SERVICES',
]);
const ROOT_PASSWORDS = new Set(ENGINE_NAMES.map((name) => ENGINES[name].rootPassword));
// A service's variable, and its URL: a host, an optional port and an optional path, in characters no shell or runtime
// reads as anything but text. Terraform's shared_services validation takes the same names.
const SERVICE_NAME = /^[A-Z][A-Z0-9_]*_(URL|ENDPOINT)$/;
const SERVICE_URL = /^https?:\/\/[A-Za-z0-9.-]+(:[0-9]+)?(\/[A-Za-z0-9._~\/-]*)?$/;

function log(message, fields = {}) {
  console.log(`[db-admin ${new Date().toISOString().slice(11, 19)}] ${message}`, JSON.stringify(fields));
}

function refuse(message) {
  return Object.assign(new Error(message), { refused: true });
}

/** @returns {string[]}  the engines this run makes, copies and drops: the ones its flags give a host for */
export function runDatabases(flags) {
  return ENGINE_NAMES.filter((name) => ENGINES[name].flags.some((f) => flags[f]));
}

/**
 * @param {string[]} argv  the entryPoint's flags, `--`, then the run's command
 * @returns {{flags: Record<string, string>, action: string, owner: string|null}}
 */
export function parseArgs(argv) {
  const end = argv.indexOf('--');
  if (end === -1) throw refuse('the entryPoint must end its flags with --');
  const known = [...FLAGS, ...OPTIONAL_FLAGS, ...SECRET_SOURCES, ...ENGINE_NAMES.flatMap((name) => ENGINES[name].flags)];
  const flags = {};
  for (let i = 0; i < end; i += 2) {
    const name = argv[i]?.replace(/^--/, '');
    if (!known.includes(name) || name in flags || i + 1 >= end) throw refuse(`bad flag: ${argv[i]}`);
    flags[name] = argv[i + 1];
  }
  const sources = SECRET_SOURCES.filter((f) => flags[f]);
  if (sources.length !== 1) throw refuse(`give one of ${SECRET_SOURCES.map((f) => `--${f}`).join(' or ')}`);
  // A file's name is the secret's own, so a folder of them has no prefix: there, and only there, it may be empty.
  const run = runDatabases(flags);
  const engineFlags = run.flatMap((name) => ENGINES[name].flags);
  const missing = [...FLAGS, ...engineFlags].filter((f) => !flags[f] && !(f === 'secret-prefix' && flags[f] === '' && flags['secrets-dir']));
  if (missing.length) throw refuse(`missing flags: ${missing.join(', ')}`);
  if (!run.length) throw refuse(`no database engine's flags: give ${ENGINE_NAMES.map((name) => `--${ENGINES[name].flags[0]}`).join(' or ')}`);
  const [action, owner = null, ...rest] = argv.slice(end + 1);
  const usage = 'template | reset <login> | drop <login> | clone <session id> | drop-session <session id>';
  if (!(action in ACTIONS) || rest.length) throw refuse(`usage: ${usage} (got: ${argv.slice(end + 1).join(' ')})`);
  if ((ACTIONS[action] === 'none') !== (owner === null)) throw refuse(`${action} ${ACTIONS[action] === 'none' ? 'takes nothing more' : 'needs an owner'}`);
  if (ACTIONS[action] === 'login') ownerName(owner);
  if (ACTIONS[action] === 'session') sessionName(owner);
  return { flags, action, owner };
}

/**
 * @param {string} login  a GitHub login
 * @returns {string}  the name of the person's user and database on every engine
 */
export function ownerName(login) {
  // A GitHub login, which can hold no underscore, so `-` to `_` makes no two logins the same name.
  if (!/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/i.test(login ?? '')) throw refuse(`not a GitHub login: ${login}`);
  return `woodshed_${login.toLowerCase().replace(/-/g, '_')}`;
}

/** @returns {string}  a shared session's user and database, from the console's 8-hex session id */
export function sessionName(id) {
  if (!/^[0-9a-f]{8}$/.test(id ?? '')) throw refuse(`not a session id: ${id}`);
  return `woodshed__${id}`;
}

/** @returns {string}  where a person's database password is kept, among their own secrets; the console makes it */
export function secretName(prefix, login) {
  return `${prefix}users/${login.toLowerCase()}/database`;
}

/** @returns {string}  where a shared session's database password is kept; the console makes it, and deletes it after */
export function sessionSecretName(prefix, id) {
  return `${prefix}sessions/${id}/database`;
}

function newPassword() {
  return crypto.randomBytes(24).toString('hex');
}

// A password goes into SQL as a literal, which no driver can bind; ours are hex, and anything else is refused.
function checkPassword(password, owner) {
  if (!/^[0-9a-f]{32,128}$/.test(password ?? '')) throw refuse(`the password saved for ${owner} is not one Woodshed made`);
  return password;
}

/**
 * Migrating a copy gives what a rebuild would only when nothing but new migration files came in: an edited or removed
 * migration has already run in the copy, and a seed or a change to the migration tool's config needs the seeds run
 * again. What a template is built from is the database's `paths`; the seeds also call the app's own code, whose changes
 * wait for the next rebuild.
 * @param {{builtFrom: string|null|undefined, buildSha: string|null, database: {paths: string[], migrations: string|null},
 *          changedSince: (sha: string, pathspecs: string[], diffFilter?: string) => Promise<boolean>}} args
 *   `builtFrom` the commit the template was built from; `buildSha` this image's
 * @returns {Promise<{action: 'keep'|'migrate'|'rebuild', reason: string}>}
 */
export async function templateDecision({ builtFrom, buildSha, database, changedSince }) {
  if (!buildSha) return { action: 'rebuild', reason: 'this image does not say its commit' };
  if (!builtFrom) return { action: 'rebuild', reason: 'the template does not say its commit' };
  if (builtFrom === buildSha) return { action: 'keep', reason: 'built from this commit' };
  const { paths, migrations } = database;
  if (!paths.length) return { action: 'rebuild', reason: 'the project file names no paths for it' };
  const named = paths.join(', ');
  if (!(await changedSince(builtFrom, paths))) return { action: 'keep', reason: `${named} unchanged` };
  if (!migrations) return { action: 'rebuild', reason: `${named} changed, and the project file names no migrations` };
  if (await changedSince(builtFrom, [...paths, `:(exclude)${migrations}`])) {
    return { action: 'rebuild', reason: `${named} changed outside its migrations` };
  }
  // `a`: every kind of change but an added file.
  if (await changedSince(builtFrom, [migrations], 'a')) return { action: 'rebuild', reason: 'a migration was edited or removed' };
  return { action: 'migrate', reason: 'only new migrations' };
}

const STRENGTH = { keep: 0, migrate: 1, rebuild: 2 };

/**
 * The templates are built together, since one seed may read another's database: the decision is the strongest of each
 * database's own.
 * @param {{action: string}[]} decisions
 */
export function combinedDecision(decisions) {
  return decisions.reduce((a, b) => (STRENGTH[b.action] > STRENGTH[a] ? b.action : a), 'keep');
}

/**
 * Compares trees only, so the image's partial clone needs no file contents from GitHub.
 * @returns {(sha: string, pathspecs: string[], diffFilter?: string) => Promise<boolean>}  true when those paths changed
 *   (only the kinds of change `diffFilter` names, when given), and when git cannot say, such as for a commit the
 *   checkout does not have
 */
export function gitChangedSince(repoDir) {
  return (sha, pathspecs, diffFilter) => new Promise((resolve) => {
    const filter = diffFilter ? [`--diff-filter=${diffFilter}`] : [];
    const child = spawn('git', ['-C', repoDir, 'diff-tree', '-r', '--quiet', ...filter, sha, 'HEAD', '--', ...pathspecs], { stdio: 'ignore' });
    child.on('error', () => resolve(true));
    child.on('exit', (code) => resolve(code !== 0));
  });
}

// The task builds and copies the project's databases, so a project with none is a mistake to stop on, not a default.
// The installation's folder is the flag's alone, never the environment's.
function readProject(flags) {
  const project = loadProject(flags.repo, { projectFilesDir: flags['project-files-dir'] || null });
  if (!project.databases.length) throw refuse(`${PROJECT_FILE} has no databases (databases: []), so there is nothing for this task to build or copy`);
  return project;
}

/**
 * @param {{flags: Record<string, string>, env: Record<string, string|undefined>, secrets?: {get: Function, put: Function},
 *          seed?: (args: {user: string, name: string, password: string, migrateOnly?: boolean}) => Promise<void>,
 *          buildSha?: string|null, changedSince?: (sha: string, pathspecs: string[], diffFilter?: string) => Promise<boolean>,
 *          databases?: {engine: string, dir: string, paths: string[], migrations: string|null}[],
 *          drivers?: Record<string, object>|null}} opts
 *   `buildSha` is the commit this image was built from; without it, the templates are always built again. `databases`
 *   are the project file's, read from the image's checkout. `drivers` stand in for each engine's, in tests
 */
export function createDbAdmin({
  flags, env, secrets = secretsClient({ region: flags.region }), seed, buildSha = null, changedSince = async () => true,
  databases = readProject(flags).databases, drivers = null,
}) {
  const run = runDatabases(flags);
  const missing = databases.filter((d) => !run.includes(d.engine)).map((d) => d.engine);
  if (missing.length) {
    throw refuse(`the project file's databases need ${missing.join(' and ')}, and this installation hosts ${run.join(' and ')} only: its db-admin task has no --${engine(missing[0]).flags[0]}`);
  }
  // Each engine's driver is borrowed from the project's own dependencies, in its database's dir.
  const admins = databases.map((database) => {
    const e = engine(database.engine);
    const driver = drivers?.[database.engine] ?? e.loadDriver(createRequire(path.join(flags.repo, database.dir, 'package.json')));
    return { database, engine: e, admin: e.admin({ flags, env, driver, log, refuse }) };
  });

  // Every engine's root connection, opened in the list's order and closed whatever happens.
  async function withRoots(work) {
    const opened = [];
    try {
      for (const a of admins) opened.push({ ...a, db: await a.admin.open() });
      return await work(opened);
    } finally {
      for (const { db } of opened) await db.close();
    }
  }

  async function templates(opened) {
    return Promise.all(opened.map(({ db }) => db.template()));
  }

  async function waitForTemplates(opened) {
    const deadline = Date.now() + TEMPLATE_WAIT_MS;
    for (;;) {
      const states = await templates(opened);
      if (states.every((t) => t.ready)) {
        const commits = [...new Set(states.map((t) => t.builtFrom))];
        if (commits.length > 1) log('WARNING: the templates were built from different commits', { commits });
        return states.map((t) => t.marker);
      }
      if (Date.now() > deadline) throw refuse('there is no database template: run the db_template_command output');
      log('Waiting for the template', { waitingFor: opened.filter((_, i) => !states[i].ready).map((o) => o.engine.name) });
      await sleep(TEMPLATE_POLL_MS);
    }
  }

  /**
   * The owner's databases on every engine, emptied and made again as a copy of the templates, owned by the owner's
   * user throughout. A refresh can drop and refill a template while this copies it, so a changed marker, or a copy
   * an engine says the template changed under, means copying them all again.
   */
  async function freshCopy(opened, name) {
    for (let attempt = 1; ; attempt++) {
      const dropped = [];
      for (const { db } of opened) dropped.push(await db.dropCopies(name));
      const markers = await waitForTemplates(opened);
      let changed = false;
      for (const [i, { db, engine: e }] of opened.entries()) {
        const copied = await db.copyTemplate(name);
        if (!copied) {
          changed = true;
          break;
        }
        log('Copied from the template', { name, engine: e.name, ...dropped[i], ...copied });
      }
      if (!changed) {
        const now = (await templates(opened)).map((t) => t.marker);
        if (now.every((m, i) => m === markers[i])) return;
      }
      if (attempt === COPY_ATTEMPTS) throw refuse('the template changed during every copy: try again once its refresh is done');
      log('The template changed during the copy, copying again', { name, attempt });
    }
  }

  async function passwordFor(secret, owner) {
    const saved = await secrets.get(secret);
    if (!saved) throw refuse(`no password in ${secret}: the console saves it before it starts the task`);
    return checkPassword(saved.trim(), owner);
  }

  async function remake(name, password, { restore }) {
    await withRoots(async (opened) => {
      for (const { db } of opened) await db.ensureUser({ name, password, restore });
      await freshCopy(opened, name);
    });
  }

  async function reset(login) {
    const name = ownerName(login);
    await remake(name, await passwordFor(secretName(flags['secret-prefix'], login), login), { restore: true });
    log('Reset done', { login, name });
  }

  async function clone(id) {
    const name = sessionName(id);
    await remake(name, await passwordFor(sessionSecretName(flags['secret-prefix'], id), id), { restore: false });
    log('Clone done', { session: id, name });
  }

  async function dropAll(name) {
    await withRoots(async (opened) => {
      for (const { db } of opened) await db.dropAll(name);
    });
  }

  async function drop(login) {
    await dropAll(ownerName(login));
    log('Dropped', { login });
  }

  async function dropSession(id) {
    await dropAll(sessionName(id));
    log('Dropped', { session: id });
  }

  async function prepareNext({ password, fromCurrent }) {
    await withRoots(async (opened) => {
      for (const { db } of opened) await db.prepareNext({ password, fromCurrent });
    });
  }

  /**
   * Seeds new templates beside the old ones, or migrates copies of the old ones when only new migrations came in, then
   * swaps them in. A clone during the swap waits for it. The password is only for the seed: nothing keeps it, and the
   * seeding user cannot log in afterwards.
   */
  async function template() {
    const states = await withRoots(templates);
    const decisions = await Promise.all(admins.map(({ database }, i) => templateDecision({
      builtFrom: states[i].ready ? states[i].builtFrom : null, buildSha, database, changedSince,
    })));
    const action = combinedDecision(decisions);
    const fields = {
      buildSha, action,
      databases: admins.map(({ engine: e }, i) => ({ engine: e.name, builtFrom: states[i].builtFrom, ...decisions[i] })),
    };
    if (action === 'keep') {
      log('Template kept', fields);
      return;
    }
    const password = newPassword();
    let migrated = false;
    if (action === 'migrate') {
      log('Migrating a copy of the template', fields);
      await prepareNext({ password, fromCurrent: true });
      // A migration that fails on the copy can still pass on an empty database, as CI builds it.
      migrated = await seed({ user: SEEDER, name: TEMPLATE_NEXT, password, migrateOnly: true }).then(() => true, (err) => {
        log('Migrating the copy failed, building the template again', { message: err.message });
        return false;
      });
    } else {
      log('Building the template again', fields);
    }
    if (!migrated) {
      await prepareNext({ password, fromCurrent: false });
      await seed({ user: SEEDER, name: TEMPLATE_NEXT, password });
    }
    await withRoots(async (opened) => {
      for (const { db, engine: e } of opened) log('Template swapped in', { engine: e.name, ...(await db.swapIn({ buildSha })) });
    });
  }

  /**
   * Each engine's upkeep after every run: Postgres closes the databases every user could connect to, Mongo gives
   * people's users the roles their restores need. One engine failing does not stop the next.
   * @returns {Promise<{engine: string, message: string, fields: object}[]>}
   */
  async function maintain() {
    const results = [];
    for (const { admin, engine: e } of admins) {
      try {
        const db = await admin.open();
        try {
          results.push({ engine: e.name, ...(await db.maintain()) });
        } finally {
          await db.close();
        }
      } catch (err) {
        if (err.refused) throw err;
        results.push({ engine: e.name, message: 'WARNING: upkeep failed', fields: { message: err.message } });
      }
    }
    return results;
  }

  return { template, reset, drop, clone, dropSession, maintain };
}

/**
 * @param {Record<string, string|undefined>} env
 * @param {Record<string, string>} flags  the entryPoint's: an engine's root password is expected only with its flags
 * @returns {string[]}  the names in the environment the task does not expect: neither its own nor a shared service's
 */
export function unexpectedEnv(env, flags) {
  const services = serviceNames(env);
  const roots = new Set(runDatabases(flags).map((name) => ENGINES[name].rootPassword));
  const expected = (name) => EXPECTED_ENV.has(name) || roots.has(name);
  return Object.keys(env).filter((name) => !expected(name) && !services.includes(name)).sort();
}

function serviceNames(env) {
  return (env.WOODSHED_SERVICES ?? '').split(/\s+/).filter(Boolean);
}

/**
 * The installation's shared services, which the seed gets as sessions do: each variable WOODSHED_SERVICES lists, set
 * to its URL. A run's overrides could add names to the list, and a variable bash or Node acts on (BASH_ENV, which bash
 * expands, NODE_OPTIONS) would run what its value says. So a name must end in _URL or _ENDPOINT, which none of those
 * does, and a value must be a plain URL, with no character a shell would expand.
 * @returns {Record<string, string>}
 */
export function sharedServices(env) {
  return Object.fromEntries(serviceNames(env).map((name) => {
    if (!SERVICE_NAME.test(name) || EXPECTED_ENV.has(name) || ROOT_PASSWORDS.has(name)) {
      throw refuse(`WOODSHED_SERVICES names ${name}, which is not a shared service's variable: one ending in _URL or _ENDPOINT`);
    }
    if (!SERVICE_URL.test(env[name] ?? '')) throw refuse(`${name}, a shared service's variable, must be a plain http(s) URL`);
    return [name, env[name]];
  }));
}

/**
 * The environment the next templates' commands run in: the shared services, then each project database's variables,
 * pointed at its engine's next template as the seeder, then the env files' secrets. None of the root passwords.
 * @param {{flags: Record<string, string>, env: Record<string, string|undefined>, databases: {engine: string}[],
 *          user: string, name: string, password: string, files: Record<string, string>}} args
 * @returns {Record<string, string>}
 */
export function seedEnv({ flags, env, databases, user, name, password, files }) {
  return {
    // The services first, so none can stand in for a variable the seed is given here.
    ...sharedServices(env),
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: os.userInfo().homedir,
    ...Object.assign({}, ...databases.map((d) => engine(d.engine).seedEnv({ flags, user, password, name }))),
    // The entrypoint's `seed` reads the project file again, for the commands: the same one as this task.
    ...(flags['project-files-dir'] && { WOODSHED_CLOUD_PROJECT_FILES_DIR: flags['project-files-dir'] }),
    ...files,
  };
}

/**
 * Seeds the next templates as their own user, through the entrypoint's `seed`, with an environment holding none of the
 * root passwords. Not a boundary: the seed runs as the same user as this process, so it could still read them from
 * /proc/1/environ. That is why the env files it writes come from Secrets Manager, never from the environment.
 * @param {{envFiles: () => Promise<Record<string, string>>}} args  `envFiles` the secrets the project's databases'
 *   `envFiles` name, by the variable each arrives in (project.mjs, secretEnvName)
 */
export function seedWith({ flags, env, databases, envFiles }) {
  return async ({ user, name, password, migrateOnly = false }) => {
    const files = await envFiles();
    await new Promise((resolve, reject) => {
      const child = spawn('bash', [ENTRYPOINT, migrateOnly ? 'migrate' : 'seed'], {
        stdio: 'inherit',
        env: seedEnv({ flags, env, databases, user, name, password, files }),
      });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${migrateOnly ? 'migrating' : 'seeding'} ${name} failed (exit ${code})`))));
    });
  };
}

async function main() {
  const { flags, action, owner } = parseArgs(process.argv.slice(2));
  const unexpected = unexpectedEnv(process.env, flags);
  if (unexpected.length) throw refuse(`the environment holds variables this task does not expect: ${unexpected.join(', ')}`);
  const services = Object.keys(sharedServices(process.env));
  log('Started', { action, owner, services, databases: runDatabases(flags) });
  const secrets = flags['secrets-dir'] ? fileSecretsClient({ dir: flags['secrets-dir'] }) : secretsClient({ region: flags.region });
  log('Secrets from', { source: flags['secrets-dir'] ? 'files' : 'Secrets Manager' });
  const { databases, from } = readProject(flags);
  const seedFiles = [...new Set(databases.flatMap((d) => d.envFiles))];
  log('Project read', { from, databases: databases.map((d) => ({ engine: d.engine, dir: d.dir, paths: d.paths })), envFiles: seedFiles });
  const envFiles = async () => Object.fromEntries(await Promise.all(seedFiles.map(
    async (secret) => [secretEnvName(secret), (await secrets.get(`${flags['secret-prefix']}${secret}`)) ?? ''],
  )));
  const buildSha = fs.existsSync(BUILD_SHA_FILE) ? fs.readFileSync(BUILD_SHA_FILE, 'utf8').trim() || null : null;
  const admin = createDbAdmin({
    flags, env: process.env, secrets, seed: seedWith({ flags, env: process.env, databases, envFiles }),
    buildSha, changedSince: gitChangedSince(flags.repo), databases,
  });
  if (action === 'template') await admin.template();
  if (action === 'reset') await admin.reset(owner);
  if (action === 'drop') await admin.drop(owner);
  if (action === 'clone') await admin.clone(owner);
  if (action === 'drop-session') await admin.dropSession(owner);
  // After the action, so a failure here never fails a copy a session waits on.
  const results = await admin.maintain().catch((err) => {
    log('WARNING: upkeep failed', { message: err.message });
    return [];
  });
  for (const { engine: name, message, fields } of results) log(message, { engine: name, ...fields });
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    log('ERROR', { message: err.message });
    process.exit(1);
  });
}
