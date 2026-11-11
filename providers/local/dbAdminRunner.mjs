// The local provider's db-admin runs: each is a container of the session image running session/dbAdmin.mjs, as the
// AWS provider's is a Fargate task (../aws/dbAdminRunner.mjs). The same calls, so console/databases.mjs makes, resets
// and drops databases the same on either.
//
// As the task definition does on AWS, this fixes the entrypoint and the flags (the hosts the root passwords go to)
// and the console picks only the command. The root passwords are `db-root/postgres` and `db-root/mongo` in the local
// secret store, each needed only for a database the console has an address for, handed over by name in the
// environment, never on a command line. A run sees only the secrets the AWS
// task role reads: the database password its command makes, and the env files the project's seed reads. They are copied into a
// folder of the run's own, mounted read-only, and that folder goes once the run is over.
//
// The runs' folders are under one the console's user alone can open (`runsDir`, in its state folder by default).
// Inside it, each run's folder and files can be read by anyone: the image runs as its own `node` user, whatever uid
// the console has, and only the container sees that folder from its mount. The docker daemon resolves the mount's
// path on its own host, so `runsDir` must be the same path there, as it is when the console runs on that machine.
// A daemon on another machine (`dockerHost`, as the docker launcher takes it) has no such folder: the run's container
// is created first, the folder copied into it with `docker cp`, and then it starts.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { secretFile } from '../../shared/fileSecrets.mjs';
import { PROJECT_FILES_MOUNT, projectFileMounts } from './projectFileMounts.mjs';

const execFileAsync = promisify(execFile);

const ROOT_SECRETS = { postgres: ['PG_ROOT_PASSWORD', 'db-root/postgres'], mongo: ['MONGO_ROOT_PASSWORD', 'db-root/mongo'] };
// Where a run's folder is mounted in the session image.
const SECRETS_MOUNT = '/run/woodshed-secrets';
// The entrypoint the task definition gives on AWS: env drops what Node or the loader would act on before dbAdmin.mjs.
const ENTRYPOINT = ['-u', 'NODE_OPTIONS', '-u', 'NODE_TLS_REJECT_UNAUTHORIZED', '-u', 'LD_PRELOAD', '-u', 'LD_LIBRARY_PATH', '-u', 'OPENSSL_CONF',
  'node', '/opt/woodshed/session/dbAdmin.mjs'];

/** @returns {string[]}  the secrets a command reads, beyond the seed's env files, by dbAdmin.mjs's names for them */
export function secretsFor(command) {
  const [action, owner] = command;
  if (action === 'reset') return [`users/${String(owner).toLowerCase()}/database`];
  if (action === 'clone') return [`sessions/${owner}/database`];
  return [];
}

/**
 * @returns {string}  whose a run is, for the label that keeps one failed run per owner: a person's (`user:<login>`), a
 *   session's (`session:<id>`) or the template's. Prefixed, so a login spelled like a session id, or `template`,
 *   is never taken for one
 */
export function ownerOf(command) {
  const [action, owner] = command;
  if (action === 'reset' || action === 'drop') return `user:${String(owner).toLowerCase()}`;
  if (action === 'clone' || action === 'drop-session') return `session:${owner}`;
  return action;
}

/**
 * @param {{status?: string, exitCode?: number}|null} state  `docker inspect`'s State, or null once the container is gone
 * @returns {{done: false}|{done: true, ok: boolean, reason: string|null}}
 */
export function containerOutcome(state) {
  if (!state) return { done: true, ok: false, reason: 'the container is gone, and its outcome with it' };
  if (state.status !== 'exited' && state.status !== 'dead') return { done: false };
  if (state.exitCode === 0) return { done: true, ok: true, reason: null };
  return { done: true, ok: false, reason: `the run exited with ${state.exitCode}` };
}

// The shared services, as the session env names them: their list, and each listed variable (session/dbAdmin.mjs,
// sharedServices).
function sharedServiceEnv(sessionEnv) {
  const names = (sessionEnv.WOODSHED_SERVICES ?? '').split(/\s+/).filter(Boolean);
  return names.length ? { WOODSHED_SERVICES: names.join(' '), ...Object.fromEntries(names.map((name) => [name, sessionEnv[name] ?? ''])) } : {};
}

/**
 * @param {{image: string, repoDir: string, secrets: {read: (name: string) => Promise<string|null>},
 *          postgresHost?: string|null, postgresRootUser?: string|null, mongoHost?: string|null, network?: string|null,
 *          sessionEnv?: Record<string, string>, runsDir?: string, docker?: (args: string[], env?: object) => Promise<string>}} opts
 *   `repoDir` is the checkout's folder in the image (`checkoutDir`); `seedSecrets` the env-file secrets the project's seed reads
 *   (its databases' `envFiles`); `mongoHost` is host:port and `postgresHost` a host on 5432, as dbAdmin.mjs takes them, and
 *   a database with no host is one the installation does not host; `network` is the docker
 *   network the databases are on, if any; `sessionEnv` gives the seed the shared services it lists in WOODSHED_SERVICES, as
 *   sessions get them; `projectFilesDir` the installation's folder of project files and `repo` the image's repo, owner/name,
 *   whose file there a run reads when the checkout has none (projectFileMounts.mjs); `dockerHost` another machine's
 *   daemon, which has the project files at `projectFilesHostDir`
 * @returns {{start: (command: string[]) => Promise<string>, stop: (id: string) => Promise<void>,
 *            outcomes: (ids: string[]) => Promise<Array<{done: false}|{done: true, ok: boolean, reason: string|null}>>}}
 */
export function createDbAdminRunner({
  image, repoDir, seedSecrets = [], secrets, postgresHost = null, postgresRootUser = null, mongoHost = null, network = null, sessionEnv = {},
  runsDir = path.join(os.tmpdir(), 'woodshed-db-admin'), docker, projectFilesDir = null, projectFilesHostDir = null, repo = null, dockerHost = null,
}) {
  const hostEnv = dockerHost ? { DOCKER_HOST: dockerHost } : {};
  const run = docker
    ? (args, env) => docker(args, env, { dockerHost })
    : (async (args, env) => (await execFileAsync('docker', args, { env: { ...process.env, ...env, ...hostEnv } })).stdout.trim());
  const folderOf = (id) => path.join(runsDir, id);

  // Readable by the container's user, whose uid need not be the console's: runsDir, 0700, keeps everyone else out.
  // Opened with the store's key here, in plain JSON (shared/fileSecrets.mjs), which is what dbAdmin.mjs reads: the run
  // never holds the key, and its folder goes when it ends.
  async function copySecrets(folder, names) {
    for (const name of names) {
      const value = await secrets.read(name);
      if (value === null) continue;
      const file = secretFile(folder, name);
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
      await fs.writeFile(file, JSON.stringify({ value }), { mode: 0o644 });
      await fs.chmod(file, 0o644);
    }
  }

  async function makeRunFolder(id) {
    await fs.mkdir(runsDir, { recursive: true, mode: 0o700 });
    await fs.chmod(runsDir, 0o700);
    const folder = folderOf(id);
    await fs.mkdir(folder, { mode: 0o755 });
    await fs.chmod(folder, 0o755);
    return folder;
  }

  // A failed run's container is kept for `docker logs`, and its environment holds the root passwords, so only the
  // last one for each owner (a person, a session, or the template) is: the next run for that owner, whatever its
  // action, removes the one before.
  async function removeEarlier(forLabel) {
    const ids = (await run(['ps', '-a', '-q', '--filter', 'label=woodshed.db-admin=1', '--filter', `label=woodshed.db-admin.for=${forLabel}`]))
      .split('\n').filter(Boolean);
    for (const id of ids) await run(['rm', '-f', id]);
    if (ids.length) console.log('local: earlier db-admin runs removed', { for: forLabel, count: ids.length });
  }

  const databases = [...(postgresHost ? ['postgres'] : []), ...(mongoHost ? ['mongo'] : [])];
  const hostFlags = [
    ...(postgresHost ? ['--pg-host', postgresHost, '--pg-root-user', postgresRootUser, '--pg-ca', 'none'] : []),
    ...(mongoHost ? ['--mongo-host', mongoHost] : []),
  ];

  async function rootPasswords() {
    const env = {};
    for (const [key, name] of databases.map((d) => ROOT_SECRETS[d])) {
      const value = await secrets.read(name);
      if (!value) throw new Error(`no ${name} in the local secret store: a db-admin run needs the database's root password`);
      env[key] = value;
    }
    return env;
  }

  async function start(command) {
    const id = `woodshed-db-admin-${command[0]}-${Date.now().toString(36)}`;
    const env = {
      ...(await rootPasswords()),
      ...sharedServiceEnv(sessionEnv),
    };
    const forLabel = ownerOf(command);
    await removeEarlier(forLabel);
    // Looked for at each run, so a file the installation adds later is read by the next one.
    const mounts = projectFileMounts({ dir: projectFilesDir, hostDir: projectFilesHostDir, repos: [repo] });
    const folder = await makeRunFolder(id);
    try {
      await copySecrets(folder, [...secretsFor(command), ...seedSecrets]);
      const container = [
        '--name', id, '--label', 'woodshed.db-admin=1', '--label', `woodshed.db-admin.for=${forLabel}`,
        '--add-host=host.docker.internal:host-gateway',
        ...(network ? ['--network', network] : []),
        ...Object.keys(env).flatMap((key) => ['-e', key]),
        ...(dockerHost ? [] : ['-v', `${folder}:${SECRETS_MOUNT}:ro`]), ...mounts.args, '--entrypoint', 'env', image, ...ENTRYPOINT,
        '--secrets-dir', SECRETS_MOUNT, ...hostFlags, '--secret-prefix', '', '--repo', repoDir,
        ...(mounts.repos.length ? ['--project-files-dir', PROJECT_FILES_MOUNT] : []), '--', ...command,
      ];
      if (dockerHost) {
        await run(['create', ...container], env);
        await run(['cp', `${folder}/.`, `${id}:${SECRETS_MOUNT}`]);
        await run(['start', id]);
      } else {
        await run(['run', '-d', ...container], env);
      }
    } catch (err) {
      await fs.rm(folder, { recursive: true, force: true });
      if (dockerHost) await run(['rm', '-f', id]).catch(() => {});
      throw err;
    }
    console.log('local: db-admin run started', { id, action: command[0], installationProjectFile: mounts.repos.length > 0, remote: Boolean(dockerHost) });
    return id;
  }

  async function forget(id) {
    await run(['rm', '-f', id]).catch((err) => console.warn('local: db-admin container not removed', { id, message: err.message.split('\n')[0] }));
    await fs.rm(folderOf(id), { recursive: true, force: true });
  }

  async function stop(id) {
    await forget(id);
    console.log('local: db-admin run stopped', { id });
  }

  async function inspect(id) {
    try {
      const state = JSON.parse(await run(['inspect', '-f', '{{json .State}}', id]));
      return { status: String(state.Status ?? '').toLowerCase(), exitCode: state.ExitCode };
    } catch (err) {
      if (/No such (object|container)/i.test(String(err?.stderr ?? err?.message ?? ''))) return null;
      throw err;
    }
  }

  // A failed run's container is kept, its log being the local stand-in for the task's CloudWatch stream
  // (`docker logs <id>`), until the next run for the same owner (removeEarlier). Its folder goes either way.
  async function finish(id, outcome) {
    console.log('local: db-admin run finished', { id, ok: outcome.ok, reason: outcome.reason, kept: !outcome.ok });
    if (outcome.ok) await forget(id);
    else await fs.rm(folderOf(id), { recursive: true, force: true });
  }

  async function outcomes(ids) {
    return Promise.all(ids.map(async (id) => {
      const outcome = containerOutcome(await inspect(id));
      if (outcome.done) await finish(id, outcome);
      return outcome;
    }));
  }

  return { start, stop, outcomes };
}
