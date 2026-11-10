import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ENGINE_NAMES } from '../shared/databases/index.mjs';
import { envFiles, loadConfig, requireRepo } from '../console/config.mjs';
import { defaultProject } from '../console/projects.mjs';
import { createProvider, providerName } from '../providers/console.mjs';

// install.sh's functions, run in bash with its main left out (WOODSHED_INSTALL_LIB=1).
const SCRIPT = path.resolve(import.meta.dirname, '..', 'install.sh');

function runInstallFunction(body, env = {}) {
  return execFileSync('bash', ['-c', `set -euo pipefail; . "${SCRIPT}"; ${body}`], {
    env: { PATH: process.env.PATH, HOME: os.tmpdir(), WOODSHED_INSTALL_LIB: '1', ...env },
    encoding: 'utf8',
  });
}

function readEnvFile(file) {
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

test('install.sh parses and sourcing it runs nothing', () => {
  execFileSync('bash', ['-n', SCRIPT]);
  assert.equal(runInstallFunction('echo sourced'), 'sourced\n');
});

test('validRepo takes owner/name and refuses anything else', () => {
  for (const repo of ['acme/app', 'Acme-Co/app.web', 'a_b/c-d']) assert.equal(runInstallFunction(`validRepo '${repo}' && echo ok`), 'ok\n', repo);
  for (const repo of ['acme', 'acme/app/extra', 'acme/app;rm', '', '/app']) {
    assert.equal(runInstallFunction(`validRepo '${repo}' && echo ok || echo no`), 'no\n', repo);
  }
});

test('the stack.env install.sh writes starts a console on the local provider, and is kept on a second run', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-install-'));
  const file = path.join(home, 'stack.env');
  const write = `writeStackEnv "${file}" "${home}" acme/app woodshed-session:acme-app app-env=api/.env app-env 'postgres mongo' woodshed`;
  runInstallFunction(write);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const env = readEnvFile(file);
  assert.match(env.WOODSHED_LOCAL_PG_ROOT_PASSWORD, /^[0-9a-f]{48}$/);
  assert.notEqual(env.WOODSHED_LOCAL_PG_ROOT_PASSWORD, env.WOODSHED_LOCAL_MONGO_ROOT_PASSWORD);
  assert.equal(env.WOODSHED_CLOUD_SUPERVISED, '1');

  runInstallFunction(`writeSessionEnv "${env.WOODSHED_CLOUD_SESSION_ENV_FILE}" host.docker.internal 'postgres mongo'`);
  const config = loadConfig(env);
  requireRepo(config);
  assert.equal(providerName(env), 'local');
  assert.equal(defaultProject(config).repo, 'acme/app');
  assert.deepEqual(envFiles(env), [{ secret: 'app-env', path: 'api/.env' }]);
  fs.mkdirSync(env.WOODSHED_LOCAL_SECRETS_DIR, { recursive: true });
  runInstallFunction(`node "${path.resolve(import.meta.dirname, '../providers/local/bin/secret.mjs')}" new-key "${env.WOODSHED_LOCAL_SECRETS_KEY_FILE}" >/dev/null`);
  assert.equal(createProvider(config, env).name, 'local');
  assert.equal(env.WOODSHED_LOCAL_DB_POSTGRES_HOST, 'postgres');
  assert.equal(env.WOODSHED_LOCAL_DOCKER_NETWORK, 'woodshed');

  const before = fs.readFileSync(file, 'utf8');
  runInstallFunction(write.replace('acme/app', 'other/repo'));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('projectSettings reads the env files and the seed secrets from the repository\'s project file', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-install-repo-'));
  fs.mkdirSync(path.join(repo, '.woodshed'));
  fs.writeFileSync(path.join(repo, '.woodshed/project.yaml'), [
    'version: 1',
    'envFiles:',
    '  - path: api/.env',
    '    secret: api-env',
    '    lines: []',
    '  - path: web/.env.local',
    '    secret: web-env',
    '    lines: []',
    'databases:',
    '  - engine: postgres',
    '    dir: api',
    '    envFiles: [api-env]',
    '  - engine: mongo',
    '    dir: api',
    '    envFiles: [api-env]',
    '',
  ].join('\n'));
  const woodshed = path.resolve(import.meta.dirname, '..');
  assert.equal(runInstallFunction(`projectSettings "${woodshed}" "${repo}"`), 'api-env=api/.env,web-env=web/.env.local\napi-env\npostgres mongo\n');

  // A shallow clone with no project file, as fetchRepo makes for a repository that has none.
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-install-origin-'));
  const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git(['init', '-q', '-b', 'main'], origin);
  fs.writeFileSync(path.join(origin, 'a.txt'), 'a');
  git(['add', '.'], origin);
  git(['commit', '-q', '-m', 'a'], origin);
  const clone = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-install-clone-')), 'repo');
  git(['clone', '-q', '--depth', '1', `file://${origin}`, clone]);
  assert.equal(runInstallFunction(`projectSettings "${woodshed}" "${clone}"`), '\n\nnone\n');
});

test('a second run moves only the session API address in session-env.json, keeping a shared service added by hand', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-install-senv-')), 'session-env.json');
  runInstallFunction(`writeSessionEnv "${file}" host.docker.internal 'postgres mongo'`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const added = { ...JSON.parse(fs.readFileSync(file, 'utf8')), WOODSHED_SERVICES: 'S3_ENDPOINT', S3_ENDPOINT: 'http://s3:4566' };
  fs.writeFileSync(file, JSON.stringify(added));
  runInstallFunction(`writeSessionEnv "${file}" 172.18.0.1 'postgres mongo'`);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ...added, WOODSHED_CONSOLE_URL: 'http://172.18.0.1:7691' });
});

test('an install made for one repository refuses another, and takes its own or a first one', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-install-other-'));
  const file = path.join(home, 'stack.env');
  assert.equal(runInstallFunction(`refuseOtherRepo "${file}" acme/app && echo ok`), 'ok\n');
  runInstallFunction(`writeStackEnv "${file}" "${home}" acme/app woodshed-session:acme-app '' '' 'postgres mongo' woodshed`);
  assert.equal(runInstallFunction(`refuseOtherRepo "${file}" acme/app && echo ok`), 'ok\n');
  assert.throws(
    () => runInstallFunction(`refuseOtherRepo "${file}" other/repo`, {}),
    (err) => err.status === 1 && /this install works on acme\/app: set WOODSHED_HOME to another folder for other\/repo/.test(err.stderr),
  );
});

// A repository with no databases whose Postgres is on its own compose network. Before, every shared session
// waited on a db-admin run that refused the project file.
test('a repository with no database gets no database stack, and its sessions join the network it names', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-install-nodb-'));
  const file = path.join(home, 'stack.env');
  runInstallFunction(`writeStackEnv "${file}" "${home}" acme/app woodshed-session:acme-app '' '' none app_default`);
  const env = readEnvFile(file);
  assert.deepEqual(Object.keys(env).filter((key) => /^WOODSHED_LOCAL_(DB_|PG_|MONGO_|DATA_DIR)/.test(key)), []);
  assert.equal(env.WOODSHED_LOCAL_DOCKER_NETWORK, 'app_default');
  runInstallFunction(`writeSessionEnv "${env.WOODSHED_CLOUD_SESSION_ENV_FILE}" host.docker.internal ''`);
  assert.deepEqual(JSON.parse(fs.readFileSync(env.WOODSHED_CLOUD_SESSION_ENV_FILE, 'utf8')), { WOODSHED_CONSOLE_URL: 'http://host.docker.internal:7691' });

  const config = loadConfig(env);
  fs.mkdirSync(env.WOODSHED_LOCAL_SECRETS_DIR, { recursive: true });
  runInstallFunction(`node "${path.resolve(import.meta.dirname, '../providers/local/bin/secret.mjs')}" new-key "${env.WOODSHED_LOCAL_SECRETS_KEY_FILE}" >/dev/null`);
  assert.equal(createProvider(config, env).dbAdmin, null, 'no db-admin, so the console makes no databases for sessions');

  const bare = path.join(home, 'bare.env');
  runInstallFunction(`writeStackEnv "${bare}" "${home}" acme/app woodshed-session:acme-app '' '' none ''`);
  assert.equal(readEnvFile(bare).WOODSHED_LOCAL_DOCKER_NETWORK, undefined);
});

test('sessions on a Mac reach the session API through host.docker.internal', () => {
  assert.equal(runInstallFunction('sessionApiHost Darwin'), '127.0.0.1 host.docker.internal');
});

test('the launcher starts the console again only when it exits with 75', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-install-launch-'));
  const src = path.join(home, 'src');
  fs.mkdirSync(path.join(src, 'providers'), { recursive: true });
  // A stand-in console: exits 75 on its first run, then 3.
  fs.writeFileSync(path.join(src, 'providers/console.mjs'), [
    "import fs from 'node:fs';",
    `const count = '${path.join(home, 'runs')}';`,
    "const runs = fs.existsSync(count) ? Number(fs.readFileSync(count, 'utf8')) + 1 : 1;",
    'fs.writeFileSync(count, String(runs));',
    'process.exit(runs === 1 ? 75 : 3);',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(home, 'stack.env'), 'WOODSHED_PROVIDER=local\n');
  runInstallFunction(`writeLauncher "${home}/bin/woodshed" "${home}" "${src}"`);
  assert.throws(() => execFileSync(path.join(home, 'bin/woodshed'), { stdio: 'ignore' }), (err) => err.status === 3);
  assert.equal(fs.readFileSync(path.join(home, 'runs'), 'utf8'), '2');
});

// Each database engine the local provider hosts is a compose file of its own, named for it, which install.sh starts for
// each engine the project's databases are on.
test('every database engine has the local provider\'s compose file, and install.sh starts it by its name', () => {
  const local = path.join(import.meta.dirname, '../providers/local');
  const databases = fs.readdirSync(local).filter((f) => /\.yml$/.test(f) && f !== 'compose.yml' && !f.includes('example'));
  assert.deepEqual(databases.sort(), ENGINE_NAMES.map((name) => `${name}.yml`).sort());
  const script = fs.readFileSync(path.join(import.meta.dirname, '../install.sh'), 'utf8');
  assert.ok(script.includes('files+=(-f "$src/providers/local/$engine.yml")'));
});
