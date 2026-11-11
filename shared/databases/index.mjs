// The database engines a project file's `databases` can name, each a module here: postgres.mjs, mongo.mjs. An engine
// says how the db-admin task makes, copies and drops its databases, which variables a session gets for one, and its
// viewers. Adding one is a module here, its entry in ENGINES (engines.mjs), and its server in each provider
// (docs/reference.md, "Databases").
//
//   node databases/index.mjs env                the project's databases' variables, as `export` lines for the
//                                               entrypoint to eval. The console's credentials, when it made them,
//                                               are WOODSHED_DB_USER, WOODSHED_DB_PASSWORD and WOODSHED_DB_NAME
//   node databases/index.mjs check              nothing, or exit 1 naming an engine the project needs and this
//                                               installation does not host
//   node databases/index.mjs hosted             the engines the installation hosts, one a line
//   node databases/index.mjs given              `yes` when the environment names a database to use as it is
//   node databases/index.mjs commands <mode>    each database's `migrate`, and with `seed` its `seed` after, in the
//                                               list's order: engine, dir and command, each ended by a NUL
//   node databases/index.mjs secret-vars        every engine's variables that hold a password, one a line
//   node databases/index.mjs paths              every database's `paths`, one a line: what the templates are built from
//   node databases/index.mjs viewers            starts each hosted database's viewers, in the background
//
// The repo is REPO_DIR, read as project.mjs reads it.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

import { ENGINES, ENGINE_NAMES, engine } from './engines.mjs';
import { isMain } from '../isMain.mjs';
import { loadProject } from '../project.mjs';

export { ENGINES, ENGINE_NAMES, engine };

/** @returns {string[]}  the engines whose server the installation gives a session (its environment) */
export function hostedEngines(env) {
  return ENGINE_NAMES.filter((name) => ENGINES[name].hostedIn(env));
}

/** @returns {string[]}  the engines the project's databases need */
export function projectEngines(project) {
  return (project?.databases ?? []).map((d) => d.engine);
}

/**
 * @param {{project: {databases: {engine: string}[]}|null, hosted: string[]}} args
 * @returns {string|null}  why the project cannot have its databases here, or null when it can
 */
export function notHostedReason({ project, hosted }) {
  const missing = projectEngines(project).filter((name) => !hosted.includes(name));
  if (!missing.length) return null;
  const has = hosted.length ? `it hosts ${hosted.join(' and ')}` : 'it hosts none';
  return `the project file's databases need ${missing.join(' and ')}, which this installation does not host (${has})`;
}

/**
 * Every variable the project's databases give a session: each engine's own names (PGHOST, MONGODB_URI), which its env
 * file lines and `env` map to whatever the app reads.
 * @param {{project: {databases: object[]}, env: Record<string, string|undefined>,
 *          credentials?: {user: string, password: string, name: string}|null}} args
 * @returns {Record<string, string>}
 */
export function databaseEnv({ project, env, credentials = null }) {
  return Object.assign({}, ...project.databases.map((database) => engine(database.engine).sessionEnv({ env, database, credentials })));
}

/**
 * @param {'migrate'|'seed'} mode  `seed` for an empty next template, `migrate` for a copy of the current one
 * @returns {{engine: string, dir: string, command: string}[]}
 */
export function databaseCommands(project, mode) {
  return project.databases.flatMap((d) => [
    d.migrate && { engine: d.engine, dir: d.dir, command: d.migrate },
    mode === 'seed' && d.seed && { engine: d.engine, dir: d.dir, command: d.seed },
  ].filter(Boolean));
}

/** @returns {{route: string, port: number, name: string, engine: string, own?: boolean}[]}  the viewers those engines run */
export function viewersOf(engines) {
  return engines.flatMap((name) => engine(name).viewers.map((v) => ({ ...v, engine: name })));
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function credentialsFrom(env) {
  const { WOODSHED_DB_USER: user, WOODSHED_DB_PASSWORD: password, WOODSHED_DB_NAME: name } = env;
  return user && password && name ? { user, password, name } : null;
}

// A viewer outlives this process: the entrypoint goes on to become statusd.
function startDetached({ name, command, args, env, cwd }) {
  const out = fs.openSync(`/tmp/${name}.log`, 'a');
  spawn(command, args, { cwd, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', out, out] }).unref();
}

function main([command, arg]) {
  const env = process.env;
  const project = loadProject(env.REPO_DIR || process.cwd());
  const hosted = hostedEngines(env);
  const out = (lines) => { if (lines.length) process.stdout.write(`${lines.join('\n')}\n`); };
  if (command === 'env') {
    out(Object.entries(databaseEnv({ project, env, credentials: credentialsFrom(env) })).map(([name, value]) => `export ${name}=${shellQuote(value)}`));
  } else if (command === 'check') {
    const reason = notHostedReason({ project, hosted });
    if (reason) throw new Error(reason);
  } else if (command === 'hosted') {
    out(hosted);
  } else if (command === 'engines') {
    out(projectEngines(project));
  } else if (command === 'given') {
    if (project.databases.some((d) => engine(d.engine).givenIn(env))) out(['yes']);
  } else if (command === 'commands') {
    if (arg !== 'migrate' && arg !== 'seed') throw new Error('commands takes migrate or seed');
    process.stdout.write(databaseCommands(project, arg).map((c) => `${c.engine}\0${c.dir}\0${c.command}\0`).join(''));
  } else if (command === 'paths') {
    out([...new Set(project.databases.flatMap((d) => d.paths))]);
  } else if (command === 'secret-vars') {
    out(ENGINE_NAMES.flatMap((name) => ENGINES[name].secretVariables));
  } else if (command === 'viewers') {
    const engines = projectEngines(project).filter((name) => hosted.includes(name));
    const log = (...parts) => process.stdout.write(`${parts.join(' ')}\n`);
    for (const name of engines) engine(name).startViewers({ env, sessionId: env.SESSION_ID, own: env.SESSION_KIND === 'private', start: startDetached, log });
    out([`started: ${engines.join(' ') || 'none'}`]);
  } else {
    throw new Error(`unknown command: ${command} (expected env, check, hosted, engines, given, commands, paths, secret-vars or viewers)`);
  }
}

if (isMain(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`databases: ${err.message}\n`);
    process.exit(1);
  }
}
