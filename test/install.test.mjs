import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
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

test('WOODSHED_IMAGE tags the session image as the console runs it, for the console\'s Update', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-build-image-'));
  const out = runInstallFunction([
    'checkTools() { :; }',
    'fetchRepo() { :; }',
    'buildImage() { echo "build $4"; }',
    'main',
  ].join('; '), { WOODSHED_HOME: home, WOODSHED_REPO: 'acme/app', GH_TOKEN: 't', WOODSHED_BUILD_ONLY: '1', WOODSHED_IMAGE: 'woodshed-session' });
  assert.match(out, /build woodshed-session\n/);
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

// A stand-in tailscale on the PATH: it says this machine's MagicDNS name and records each `serve` it was asked for.
function fakeTailscale() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-tailscale-'));
  const log = path.join(dir, 'calls');
  fs.writeFileSync(path.join(dir, 'tailscale'), `#!/usr/bin/env bash
if [ "$1" = status ]; then echo '{"Self":{"DNSName":"mac.tail1234.ts.net."}}'; exit 0; fi
echo "$*" >>"${log}"
`, { mode: 0o755 });
  return { dir, calls: () => fs.readFileSync(log, 'utf8').trim().split('\n') };
}

test('WOODSHED_TAILSCALE serves the console and each app port to the tailnet, and names the console by its MagicDNS name', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-install-'));
  const file = path.join(home, 'stack.env');
  fs.writeFileSync(file, 'WOODSHED_PORT=7690\nWOODSHED_PUBLIC_URL=http://localhost:7690\n', { mode: 0o600 });
  const ts = fakeTailscale();
  runInstallFunction(`setUpTailscale "${file}"`, { PATH: `${ts.dir}:${process.env.PATH}`, WOODSHED_APP_PORTS: '7701-7703' });
  const env = readEnvFile(file);
  assert.equal(env.WOODSHED_PUBLIC_URL, 'https://mac.tail1234.ts.net');
  assert.equal(env.WOODSHED_APP_PORTS, '7701-7703');
  assert.equal(env.WOODSHED_PORT, '7690', 'the rest of the file is kept');
  assert.deepEqual(ts.calls(), [
    'serve --bg --https=443 http://127.0.0.1:7690',
    'serve --bg --https=7701 http://127.0.0.1:7701', 'serve --bg --https=7702 http://127.0.0.1:7702', 'serve --bg --https=7703 http://127.0.0.1:7703',
  ], 'serve, never funnel');
  const config = loadConfig(env);
  assert.deepEqual(config.appPorts, [7701, 7702, 7703]);
});

test('WOODSHED_TAILSCALE=shared, for others on the tailnet, serves the console alone, with no app ports', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-install-'));
  const file = path.join(home, 'stack.env');
  fs.writeFileSync(file, 'WOODSHED_APP_PORTS=7701-7710\n', { mode: 0o600 });
  const ts = fakeTailscale();
  runInstallFunction(`setUpTailscale "${file}"`, { PATH: `${ts.dir}:${process.env.PATH}`, WOODSHED_TAILSCALE: 'shared' });
  const env = readEnvFile(file);
  assert.equal(env.WOODSHED_PUBLIC_URL, 'https://mac.tail1234.ts.net');
  assert.equal(env.WOODSHED_APP_PORTS, undefined, 'taken out');
  assert.deepEqual(ts.calls(), ['serve --bg --https=443 http://127.0.0.1:7690']);
  fs.writeFileSync(file, 'WOODSHED_REQUIRE_SIGN_IN=1\nWOODSHED_APP_PORTS=7701-7710\n', { mode: 0o600 });
  runInstallFunction(`setUpTailscale "${file}"`, { PATH: `${ts.dir}:${process.env.PATH}`, WOODSHED_TAILSCALE: '1' });
  assert.equal(readEnvFile(file).WOODSHED_APP_PORTS, undefined, 'a console that already requires sign-in keeps none on a later run');
});

// main, run as a person runs it, with the slow or outside parts stood in for: docker answers yes to everything (the
// image is there, so nothing is built), the session API's address is the Mac's, and each call to buildImage or
// fetchRepo is said.
function runMain(env, extra = []) {
  const docker = fakeDocker(0);
  return runInstallFunction([
    'checkTools() { :; }',
    'sessionApiHost() { echo "127.0.0.1 host.docker.internal"; }',
    'buildImage() { echo "build repo=$2 image=$4"; }',
    ...extra,
    'main 2>&1',
  ].join('; '), { PATH: docker.PATH, WOODSHED_NO_START: '1', ...env });
}

test('with no WOODSHED_REPO, install.sh asks nothing, fetches nothing, and sets up a console with no repo on the generic image', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-install-norepo-'));
  const out = runMain({ WOODSHED_HOME: home }, ['fetchRepo() { echo "fetched $1"; }', 'githubToken() { echo "token asked"; }']);
  assert.doesNotMatch(out, /fetched|token asked|Which GitHub repository/);
  assert.match(out, /Using the session image woodshed-session:generic/);
  assert.match(out, /No repository yet, so no databases/);
  assert.match(out, /Repositories are added in the console: Console settings, Repos, at http:\/\/localhost:7690\/console-settings#card-projects/);
  const env = readEnvFile(path.join(home, 'stack.env'));
  assert.equal(env.WOODSHED_REPO, undefined, 'the console starts with no repo');
  assert.equal(env.WOODSHED_IMAGE, 'woodshed-session:generic');
  assert.deepEqual(Object.keys(env).filter((key) => /^WOODSHED_LOCAL_(DB_|PG_|MONGO_|DATA_DIR|DOCKER_NETWORK)/.test(key)), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(env.WOODSHED_SESSION_ENV_FILE, 'utf8')), { WOODSHED_CONSOLE_URL: 'http://host.docker.internal:7691' });
  const config = loadConfig(env, { readGhToken: false });
  requireRepo(config);
  assert.equal(defaultProject(config).repo, '');
  assert.equal(createProvider(config, env).dbAdmin, null);

  // Again with no repo: the same install, nothing asked.
  const before = fs.readFileSync(path.join(home, 'stack.env'), 'utf8');
  assert.doesNotMatch(runMain({ WOODSHED_HOME: home }), /Which GitHub repository|fetch/);
  assert.equal(fs.readFileSync(path.join(home, 'stack.env'), 'utf8'), before);
});

test('sessions use this machine\'s Docker with nothing set, and WOODSHED_SESSION_DOCKER=0 is saved in stack.env, where a later run keeps it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-install-docker-'));
  const file = path.join(home, 'stack.env');
  runMain({ WOODSHED_HOME: home });
  assert.equal(readEnvFile(file).WOODSHED_SESSION_DOCKER, undefined, 'nothing to say for the default');
  assert.equal(loadConfig(readEnvFile(file), { readGhToken: false }).launcher.hostDocker, true);

  runMain({ WOODSHED_HOME: home, WOODSHED_SESSION_DOCKER: '0' });
  assert.equal(readEnvFile(file).WOODSHED_SESSION_DOCKER, '0');
  assert.equal(loadConfig(readEnvFile(file), { readGhToken: false }).launcher.hostDocker, false);
  runMain({ WOODSHED_HOME: home });
  assert.equal(readEnvFile(file).WOODSHED_SESSION_DOCKER, '0', 'a run that does not set it keeps it');

  runMain({ WOODSHED_HOME: home, WOODSHED_SESSION_DOCKER: '1' });
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.match(/^WOODSHED_SESSION_DOCKER=/gm).length, 1);
  assert.equal(readEnvFile(file).WOODSHED_SESSION_DOCKER, '1');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  assert.throws(() => runMain({ WOODSHED_HOME: home, WOODSHED_SESSION_DOCKER: 'yes' }), (err) => /WOODSHED_SESSION_DOCKER is 0 .* or 1 .*, not yes/.test(err.stdout));
});

test('with the generic image missing, install.sh builds it with no repository and no token', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-install-norepo-build-'));
  const out = runInstallFunction([
    'checkTools() { :; }',
    'githubToken() { echo "token asked"; }',
    'buildImage() { echo "build repo=[$2] dir=[$3] image=$4 token=[$5]"; }',
    'main',
  ].join('; '), { WOODSHED_HOME: home, WOODSHED_BUILD_ONLY: '1' });
  assert.match(out, /build repo=\[\] dir=\[\] image=woodshed-session:generic token=\[\]/);
  assert.doesNotMatch(out, /token asked/);
});

test('the generic image is built from session/ and shared/ alone, with no checkout, installs or token', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-install-generic-'));
  const docker = fakeDocker(0);
  const woodshed = path.resolve(import.meta.dirname, '..');
  runInstallFunction(`buildImage "${woodshed}" "" "" woodshed-session:generic "" "${home}/build" "" >/dev/null 2>&1`, { PATH: docker.PATH });
  const build = docker.calls().find((call) => call.startsWith('build '));
  assert.match(build, /--build-arg REPO= --build-arg REPO_DIR=\/work\/\.no-checkout -t woodshed-session:generic /);
  assert.doesNotMatch(build, /--secret/, 'nothing to clone, so no token');
  assert.deepEqual(fs.readdirSync(path.join(home, 'build/woodshed-deps')), []);
  assert.equal(fs.readFileSync(path.join(home, 'build/woodshed-deps.installs'), 'utf8'), '');
  assert.equal(fs.readFileSync(path.join(home, 'build/woodshed-deps.editor'), 'utf8'), 'true\n');
  assert.ok(fs.existsSync(path.join(home, 'build/woodshed/session/entrypoint.sh')));
});

test('a later run with WOODSHED_REPO gives a repo-less install that repo\'s image and databases, keeping the rest of stack.env', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-install-addrepo-'));
  runMain({ WOODSHED_HOME: home });
  const file = path.join(home, 'stack.env');
  // As a Tailscale run left it, and a line of the owner's.
  runInstallFunction(`setStackSetting "${file}" PUBLIC_URL https://mac.tail1234.ts.net`);
  fs.appendFileSync(file, 'WOODSHED_MAX_SESSIONS=3\n');
  const project = fixtureProject({ envFiles: [{ path: 'api/.env', secret: 'api-env', lines: [] }], databases: [{ engine: 'postgres', dir: 'api', envFiles: ['api-env'] }] });
  const fetch = `fetchRepo() { mkdir -p "$2/.woodshed"; printf '%s' '${project}' >"$2/.woodshed/project.yaml"; echo "fetched $1"; }`;
  const out = runMain({ WOODSHED_HOME: home, WOODSHED_REPO: 'acme/app', GH_TOKEN: 't' }, [fetch]);
  assert.match(out, /fetched acme\/app/);
  assert.match(out, /This install had no repository: it works on acme\/app now/);
  assert.match(out, /Starting postgres/);
  const env = readEnvFile(file);
  assert.equal(env.WOODSHED_REPO, 'acme/app');
  assert.equal(env.WOODSHED_IMAGE, 'woodshed-session:acme-app');
  assert.equal(env.WOODSHED_ENV_FILES, 'api-env=api/.env');
  assert.equal(env.WOODSHED_DB_ENV_SECRETS, 'api-env');
  assert.equal(env.WOODSHED_LOCAL_DB_POSTGRES_HOST, 'postgres');
  assert.match(env.WOODSHED_LOCAL_PG_ROOT_PASSWORD, /^[0-9a-f]{48}$/);
  assert.equal(env.WOODSHED_LOCAL_DOCKER_NETWORK, 'woodshed');
  assert.equal(env.WOODSHED_PUBLIC_URL, 'https://mac.tail1234.ts.net', 'the Tailscale name is kept');
  assert.equal(env.WOODSHED_MAX_SESSIONS, '3', 'and the owner\'s line');
  const text = fs.readFileSync(file, 'utf8');
  for (const name of ['WOODSHED_REPO', 'WOODSHED_IMAGE', 'WOODSHED_PUBLIC_URL', 'WOODSHED_SESSION_API_HOST', 'WOODSHED_STATE_DIR']) {
    assert.equal(text.match(new RegExp(`^${name}=`, 'gm')).length, 1, name);
  }
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(env.WOODSHED_SESSION_ENV_FILE, 'utf8')).PGHOST, 'postgres', 'sessions reach the new server');
  assert.equal(defaultProject(loadConfig(env, { readGhToken: false })).repo, 'acme/app');

  assert.throws(() => runMain({ WOODSHED_HOME: home, WOODSHED_REPO: 'other/repo', GH_TOKEN: 't' }),
    (err) => /this install works on acme\/app: set WOODSHED_HOME to another folder for other\/repo/.test(err.stdout));
  assert.match(runMain({ WOODSHED_HOME: home, GH_TOKEN: 't' }, [fetch]), /fetched acme\/app/, 'with none named, it keeps its repo');
});

test('the ports the console listens on: its own, the session API\'s, and the app ports only for Tailscale for one person', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-install-ports-')), 'stack.env');
  const ports = (env = {}) => runInstallFunction(`consolePorts "${file}"`, env).trim().split('\n');
  assert.deepEqual(ports(), ['7690', '7691']);
  assert.deepEqual(ports({ WOODSHED_TAILSCALE: '1' }), ['7690', '7691', '7701', '7702', '7703', '7704', '7705', '7706', '7707', '7708', '7709', '7710']);
  assert.deepEqual(ports({ WOODSHED_TAILSCALE: 'shared' }), ['7690', '7691']);
  fs.writeFileSync(file, 'WOODSHED_PORT=8690\nWOODSHED_APP_PORTS=8701-8702,8705\n');
  assert.deepEqual(ports(), ['8690', '7691', '8701', '8702', '8705'], 'as stack.env has them');
});

// A server on a free loopback port, in a process of its own, until `stop`.
function listener(script = '') {
  const port = 40000 + Math.floor(Math.random() * 20000);
  const child = spawn('node', ['-e', `${script}require('node:net').createServer().listen(${port}, '127.0.0.1', () => console.log('up'))`], { stdio: ['ignore', 'pipe', 'inherit'] });
  return { port, child, up: new Promise((resolve) => child.stdout.once('data', resolve)), stop: () => child.kill() };
}

// A stand-in lsof that prints `lines` as `-F pcn` does.
function fakeLsof(lines) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-install-lsof-'));
  fs.writeFileSync(path.join(bin, 'lsof'), `#!/usr/bin/env bash\nprintf '%s\\n' ${lines.map((l) => `'${l}'`).join(' ')}\n`, { mode: 0o755 });
  return `${bin}:${process.env.PATH}`;
}

test('a port is held where it would collide: loopback or every address, not the tailnet\'s, nor by Tailscale\'s own serve', () => {
  const port = 40000 + Math.floor(Math.random() * 20000);
  const holder = (lines) => runInstallFunction(`portHolder ${port} || echo free`, { PATH: fakeLsof(lines) });
  assert.equal(holder(['p41', 'cnode', `n127.0.0.1:${port}`]), '41 node\n');
  assert.equal(holder(['p41', 'cnode', `n*:${port}`]), '41 node\n');
  assert.equal(holder(['p41', 'cnode', `n[::1]:${port}`]), '41 node\n');
  assert.equal(holder(['p41', 'cnode', `n100.101.1.2:${port}`]), 'free\n', 'only on the tailnet\'s address');
  assert.equal(holder(['p52', 'cIPNExtension', `n*:${port}`]), 'free\n', 'tailscale serve handing the port to the console');
  assert.equal(runInstallFunction(`portHolder ${port} 172.18.0.1 || echo free`, { PATH: fakeLsof(['p41', 'cnode', `n172.18.0.1:${port}`]) }), '41 node\n', 'the session API\'s own address');
});

test('a port something else holds stops install.sh before anything is built, naming what holds it', async () => {
  const other = listener();
  await other.up;
  try {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-install-taken-'));
    assert.throws(() => runInstallFunction([
      'checkTools() { :; }',
      'buildImage() { echo built; }',
      'main',
    ].join('; '), { WOODSHED_HOME: home, WOODSHED_PORT: String(other.port), WOODSHED_SESSION_API_PORT: String(other.port + 1) }), (err) => {
      assert.equal(err.status, 1);
      assert.doesNotMatch(err.stdout, /built/);
      const named = new RegExp(`woodshed install: port ${other.port}, which the console needs, is taken by node \\(pid ${other.child.pid}: node -e`);
      const unnamed = new RegExp(`woodshed install: port ${other.port}, which the console needs, is taken, and this machine will not say by what`);
      assert.match(err.stderr, hasPortTool ? named : unnamed);
      return true;
    });
  } finally {
    other.stop();
  }
});

const hasPortTool = ['lsof', 'ss'].some((tool) => {
  try { execFileSync('bash', ['-c', `command -v ${tool}`], { stdio: 'ignore' }); return true; } catch { return false; }
});

test('this install\'s own console holding the ports is not refused, and its pid is given to restart it', { skip: !hasPortTool && 'no lsof or ss to say whose a port is' }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-install-own-'));
  const src = path.join(home, 'src');
  fs.mkdirSync(path.join(src, 'providers'), { recursive: true });
  const port = 40000 + Math.floor(Math.random() * 20000);
  fs.writeFileSync(path.join(src, 'providers/console.mjs'), `import net from 'node:net';\nnet.createServer().listen(${port}, '127.0.0.1', () => console.log('up'));\n`);
  const other = path.join(home, 'other.env');
  fs.writeFileSync(other, `WOODSHED_PORT=${port}\nWOODSHED_SESSION_API_PORT=${port + 1}\nWOODSHED_STATE_DIR=${home}-other/console\n`);
  runInstallFunction(`writeLauncher "${home}/bin/woodshed" "${home}" "${src}"`);
  // Started as install.sh starts it, by the launcher's full path; then by hand from its folder, with the state folder
  // in its environment.
  for (const [how, stackEnv, start] of [
    ['its launcher', `WOODSHED_PORT=${port}\nWOODSHED_SESSION_API_PORT=${port + 1}\n`, [path.join(home, 'bin/woodshed'), { cwd: home }]],
    ['its environment', `WOODSHED_PORT=${port}\nWOODSHED_SESSION_API_PORT=${port + 1}\nWOODSHED_STATE_DIR=${home}/console\n`, ['./bin/woodshed', { cwd: home }]],
  ]) {
    fs.writeFileSync(path.join(home, 'stack.env'), stackEnv);
    const own = spawn(start[0], { ...start[1], stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((resolve) => own.stdout.once('data', resolve));
    try {
      const pid = runInstallFunction(`checkPorts "${home}" "${home}/stack.env"`);
      assert.match(pid, /^\d+$/, how);
      assert.notEqual(pid, String(own.pid), 'the console, not its launcher');
      assert.throws(() => runInstallFunction(`checkPorts "${home}-other" "${other}"`), (err) => /is taken by node/.test(err.stderr), 'another install\'s is refused');
      runInstallFunction(`stopOwnConsole ${pid} ${port}`);
      assert.equal(runInstallFunction(`portHolder ${port} || echo free`), 'free\n');
    } finally {
      own.kill();
    }
  }
});
