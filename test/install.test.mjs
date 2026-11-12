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
import { fixtureCheckout, fixtureProject, fixtureProjectFiles } from '../shared/projectFixture.mjs';

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

test('with no terminal, a question fails with what to set instead of waiting', { skip: !fs.existsSync('/usr/bin/setsid') && 'no setsid to drop the terminal' }, () => {
  // setsid leaves the controlling terminal behind, as a coding agent's shell or CI has none.
  assert.throws(() => execFileSync('setsid', ['-w', 'bash', '-c', `. "${SCRIPT}"; ask 'Which GitHub repository? '`], {
    env: { PATH: process.env.PATH, HOME: os.tmpdir(), WOODSHED_INSTALL_LIB: '1' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }), (err) => err.status === 1 && err.stderr === 'woodshed install: no terminal to ask on: set it in the environment instead (Which GitHub repository? )\n');
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
  assert.equal(env.WOODSHED_SUPERVISED, '1');

  runInstallFunction(`writeSessionEnv "${env.WOODSHED_SESSION_ENV_FILE}" host.docker.internal 'postgres mongo'`);
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
  runInstallFunction(`writeSessionEnv "${env.WOODSHED_SESSION_ENV_FILE}" host.docker.internal ''`);
  assert.deepEqual(JSON.parse(fs.readFileSync(env.WOODSHED_SESSION_ENV_FILE, 'utf8')), { WOODSHED_CONSOLE_URL: 'http://host.docker.internal:7691' });

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

// A stand-in docker whose `pull` exits with `code`, and that records each call.
function fakeDocker(code) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-install-docker-'));
  fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env bash\necho "$*" >> "${bin}/calls"\nexit ${code}\n`, { mode: 0o755 });
  const calls = () => (fs.existsSync(path.join(bin, 'calls')) ? fs.readFileSync(path.join(bin, 'calls'), 'utf8').trim().split('\n') : []);
  return { PATH: `${bin}:${process.env.PATH}`, calls };
}

test('the session image is built on the published runtime when it can be pulled', () => {
  const docker = fakeDocker(0);
  assert.equal(runInstallFunction('sessionRuntime 2>/dev/null', { PATH: docker.PATH }), 'ghcr.io/chifferco/woodshed-session-runtime:latest');
  assert.deepEqual(docker.calls(), ['pull --quiet ghcr.io/chifferco/woodshed-session-runtime:latest']);
});

test('the session image builds its own runtime when the published one cannot be pulled', () => {
  const docker = fakeDocker(1);
  assert.equal(runInstallFunction('sessionRuntime 2>/dev/null', { PATH: docker.PATH }), 'runtime');
});

test('an empty WOODSHED_SESSION_RUNTIME builds the runtime here without asking a registry', () => {
  const docker = fakeDocker(0);
  assert.equal(runInstallFunction('sessionRuntime 2>/dev/null', { PATH: docker.PATH, WOODSHED_SESSION_RUNTIME: '' }), 'runtime');
  assert.deepEqual(docker.calls(), []);
});

test('with WOODSHED_PROJECT_FILES_DIR, a repository with no project file is read from the installation\'s, and the folder saved in stack.env', () => {
  const woodshed = path.resolve(import.meta.dirname, '..');
  const clone = fixtureCheckout(fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-install-files-clone-')), { repo: 'acme/app' });
  const files = fixtureProjectFiles(fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-install-files-')), {
    'acme/app': fixtureProject({ envFiles: [{ path: 'api/.env', secret: 'api-env', lines: [] }], databases: [{ engine: 'postgres', dir: 'api', envFiles: ['api-env'] }] }),
  });
  const env = { DEFAULT_BRANCH: process.env.DEFAULT_BRANCH || 'main' };
  assert.equal(runInstallFunction(`projectSettings "${woodshed}" "${clone}" "${files}" 2>/dev/null`, env), 'api-env=api/.env\napi-env\npostgres\n');
  assert.equal(runInstallFunction(`projectSettings "${woodshed}" "${clone}" "" 2>/dev/null`, env), '\n\nnone\n', 'without the folder, an empty project');
  assert.match(runInstallFunction(`projectSettings "${woodshed}" "${clone}" "${files}" 2>&1 >/dev/null`, env), /project file from installation/);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-install-files-home-'));
  const file = path.join(home, 'stack.env');
  runInstallFunction(`writeStackEnv "${file}" "${home}" acme/app woodshed-session:acme-app api-env=api/.env api-env postgres woodshed && saveProjectFilesDir "${file}" "${files}"`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const written = readEnvFile(file);
  assert.equal(written.WOODSHED_PROJECT_FILES_DIR, files);
  runInstallFunction(`writeSessionEnv "${written.WOODSHED_SESSION_ENV_FILE}" host.docker.internal postgres`);
  assert.equal(loadConfig(written).projectFilesDir, files);
  assert.equal(written.WOODSHED_REPO, 'acme/app', 'the rest of the file is kept');

  runInstallFunction(`saveProjectFilesDir "${file}" /srv/project-files && saveProjectFilesDir "${file}" /srv/project-files && saveProjectFilesDir "${file}" ""`);
  const moved = fs.readFileSync(file, 'utf8');
  assert.equal(moved.match(/^WOODSHED_PROJECT_FILES_DIR=/gm).length, 1);
  assert.deepEqual({ ...readEnvFile(file) }, { ...written, WOODSHED_PROJECT_FILES_DIR: '/srv/project-files' });
  assert.equal(runInstallFunction(`savedSetting "${file}" WOODSHED_PROJECT_FILES_DIR`), '/srv/project-files\n', 'a second run reads it back');
});

// An install made before the installation had the repo's file keeps settings of no project file: install.sh says so.
test('a stack.env written for another project file is named, and one written for this one is not', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-install-stale-'));
  const file = path.join(home, 'stack.env');
  runInstallFunction(`writeStackEnv "${file}" "${home}" acme/app woodshed-session:acme-app '' '' none ''`);
  const now = "$'api-env=api/.env\\napi-env\\npostgres'";
  assert.match(runInstallFunction(`warnStaleStackEnv "${file}" ${now} postgres none`), /stack\.env was written for another project file/);
  assert.equal(runInstallFunction(`warnStaleStackEnv "${file}" $'\\n\\nnone' none none`), '');
  const current = path.join(home, 'current.env');
  runInstallFunction(`writeStackEnv "${current}" "${home}" acme/app woodshed-session:acme-app api-env=api/.env api-env 'mongo postgres' woodshed`);
  assert.equal(runInstallFunction(`warnStaleStackEnv "${current}" $'api-env=api/.env\\napi-env\\nmongo postgres' 'mongo postgres' 'postgres mongo'`), '');
});

test('WOODSHED_BUILD_ONLY fetches the repository and builds its image where DOCKER_HOST points, and sets nothing else up', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-build-only-'));
  const out = runInstallFunction([
    'checkTools() { :; }',
    'fetchRepo() { echo "fetch $1 $2"; }',
    'buildImage() { echo "build $2 $4 on ${DOCKER_HOST:-here}"; }',
    'writeStackEnv() { echo "stack.env written"; }',
    'main',
  ].join('; '), { WOODSHED_HOME: home, WOODSHED_REPO: 'acme/app', GH_TOKEN: 't', WOODSHED_BUILD_ONLY: '1', DOCKER_HOST: 'ssh://woodshed@10.8.0.12' });
  assert.match(out, /fetch acme\/app .*\/repos\/acme-app\n/);
  assert.match(out, /build acme\/app woodshed-session:acme-app on ssh:\/\/woodshed@10\.8\.0\.12\n/);
  assert.doesNotMatch(out, /stack\.env written/);
  assert.equal(fs.existsSync(path.join(home, 'stack.env')), false);
});

// A stack.env written before the rename keeps working: install.sh reads its old names, says each once, and moves only
// the line it rewrites.
test('a stack.env with the old WOODSHED_CLOUD_ names is read, named as deprecated and still starts the console', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-install-old-names-'));
  const file = path.join(home, 'stack.env');
  runInstallFunction(`writeStackEnv "${file}" "${home}" acme/app woodshed-session:acme-app app-env=api/.env app-env postgres woodshed`);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^WOODSHED_(?!LOCAL_|PROVIDER)/gm, 'WOODSHED_CLOUD_'), { mode: 0o600 });
  const old = readEnvFile(file);
  assert.ok(old.WOODSHED_CLOUD_REPO && !old.WOODSHED_REPO, 'the file has the old names only');

  assert.equal(runInstallFunction(`savedConsoleSetting "${file}" REPO`), 'acme/app\n');
  assert.equal(runInstallFunction(`refuseOtherRepo "${file}" acme/app && echo same`), 'same\n');
  const said = runInstallFunction(`warnOldNames "${file}" 2>&1`);
  assert.match(said, /^woodshed install: deprecated variable, use WOODSHED_REPO \(.*stack\.env has WOODSHED_CLOUD_REPO\)$/m);
  assert.equal(said.match(/WOODSHED_CLOUD_REPO\)/g).length, 1, 'once a name');
  assert.doesNotMatch(said, /acme\/app|app-env/, 'names only, never a value');
  assert.equal(runInstallFunction(`set -a; . "${file}"; set +a; consoleSetting STATE_DIR`), `${home}/console`);
  runInstallFunction(`set -a; . "${file}"; set +a; writeSessionEnv "$(consoleSetting SESSION_ENV_FILE)" host.docker.internal postgres`);
  assert.ok(fs.existsSync(path.join(home, 'session-env.json')), 'the session env goes where the old name says');

  runInstallFunction(`saveProjectFilesDir "${file}" /srv/project-files`);
  runInstallFunction(`saveProjectFilesDir "${file}" /srv/other-files`);
  const moved = readEnvFile(file);
  assert.equal(moved.WOODSHED_PROJECT_FILES_DIR, '/srv/other-files', 'written under the new name');
  assert.ok(!('WOODSHED_CLOUD_PROJECT_FILES_DIR' in moved));
  assert.equal(moved.WOODSHED_CLOUD_REPO, 'acme/app', 'the rest of the file is kept as it was');

  const config = loadConfig(moved, { readGhToken: false });
  assert.equal(config.port, 7690);
  assert.equal(config.stateDir, `${home}/console`);
  assert.equal(config.projectFilesDir, '/srv/other-files');
  assert.equal(defaultProject(config).repo, 'acme/app');
  assert.deepEqual(envFiles(moved), [{ secret: 'app-env', path: 'api/.env' }]);
});
