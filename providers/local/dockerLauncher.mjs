// The local provider's launcher: session containers in docker, on the console's own host or on another machine's
// daemon (`dockerHost`), such as a hosted org's compute reached over a private network. AWS's is
// ../aws/ecsLauncher.mjs, Fargate tasks; the console uses whichever its provider hands it.
//
// A launcher returns an endpoint the console can reach: the host plus the
// ports, ttyd on claude (7681 in the container), statusd (7682) and ttyd on a
// plain shell (7684).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { PROJECT_FILES_MOUNT, projectFileMounts } from './projectFileMounts.mjs';

const execFileAsync = promisify(execFile);

/**
 * @param {string} output  `docker port <name> 7681` output, e.g. "127.0.0.1:49153"
 * @returns {number|null}
 */
export function parseDockerPort(output) {
  const match = /:(\d+)\s*$/m.exec(output || '');
  return match ? Number(match[1]) : null;
}

// The docker CLI's own settings: a session's environment never chooses which daemon the console's calls go to.
const DOCKER_SETTINGS = new Set(['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']);

/**
 * @param {{image: string, memory: string, cpus: string, network?: string|null, projectFilesDir?: string|null,
 *          projectFilesHostDir?: string|null, repo?: string|null, dockerHost?: string|null, reachHost?: string|null}} opts
 *   `network` is the docker network sessions join, to reach the shared services by name (compose.yml's `woodshed`);
 *   `projectFilesDir` the installation's folder of project files, and `repo` the image's repo, owner/name
 *   (projectFileMounts.mjs). `dockerHost` is another machine's daemon, as DOCKER_HOST takes it (`ssh://woodshed@10.8.0.12`):
 *   every docker call goes there, and `projectFilesHostDir` is where that machine has the project files. `reachHost`
 *   is the address the console reaches the sessions' ports on (that machine's private address); they are published
 *   on it alone, and on 127.0.0.1 without it. `run(args, env, {dockerHost})` stands in for the docker CLI in tests
 */
export function createDockerLauncher({
  image, memory, cpus, network = null, projectFilesDir = null, projectFilesHostDir = null, repo = null, dockerHost = null, reachHost = null, run = null,
}) {
  const bind = reachHost || '127.0.0.1';
  const cliEnv = (env) => ({ ...process.env, ...env, ...(dockerHost ? { DOCKER_HOST: dockerHost } : {}) });

  async function docker(args, env) {
    if (run) return run(args, env, { dockerHost });
    const { stdout } = await execFileAsync('docker', args, { env: cliEnv(env) });
    return stdout.trim();
  }

  return {
    kind: 'docker',

    refFor(sessionId) {
      return `woodshed-${sessionId}`;
    },

    /**
     * @param {string} sessionId
     * @param {Record<string, string>} env  passed by name only, so no secret shows up in `ps`
     * @returns {Promise<{ref: string, host: string, termPort: number, statusPort: number, shellPort: number}>}
     */
    async start(sessionId, given) {
      const ref = this.refFor(sessionId);
      const mounts = projectFileMounts({ dir: projectFilesDir, hostDir: projectFilesHostDir, repos: [repo, given.PROJECT_REPO] });
      if (projectFilesDir) console.log('launcher: installation project files', { sessionId, mounted: mounts.repos });
      const named = Object.fromEntries(Object.entries(given).filter(([key]) => !DOCKER_SETTINGS.has(key)));
      if (Object.keys(named).length !== Object.keys(given).length) console.warn('launcher: docker\'s own settings left out of the session\'s environment', { sessionId });
      const env = mounts.repos.length ? { ...named, WOODSHED_CLOUD_PROJECT_FILES_DIR: PROJECT_FILES_MOUNT } : named;
      const args = [
        'run', '-d', '--name', ref, '--init', '--memory', memory, '--cpus', cpus,
        '--add-host=host.docker.internal:host-gateway',
        '-p', `${bind}::7681`, '-p', `${bind}::7682`, '-p', `${bind}::7684`,
        '--label', `woodshed-cloud.session=${sessionId}`,
        ...(network ? ['--network', network] : []),
        ...mounts.args,
      ];
      for (const key of Object.keys(env)) args.push('-e', key);
      args.push(image);
      try {
        await docker(args, env);
        const termPort = parseDockerPort(await docker(['port', ref, '7681']));
        const statusPort = parseDockerPort(await docker(['port', ref, '7682']));
        const shellPort = parseDockerPort(await docker(['port', ref, '7684']));
        if (!termPort || !statusPort || !shellPort) throw new Error(`no published ports for ${ref}`);
        if (dockerHost) console.log('launcher: session on another docker host', { sessionId, reachHost: bind });
        return { ref, host: bind, termPort, statusPort, shellPort };
      } catch (err) {
        // `docker run` can create the container and still fail; nothing else would remove it.
        await this.stop(ref);
        throw err;
      }
    },

    async isAlive(ref) {
      try {
        return (await docker(['inspect', '-f', '{{.State.Running}}', ref])) === 'true';
      } catch (err) {
        // Only a missing container is gone; a docker daemon hiccup must not end a live session.
        if (/No such (object|container)/i.test(`${err?.stderr ?? ''}${err?.message ?? ''}`)) return false;
        throw err;
      }
    },

    async logTail(ref, lines = 30) {
      try {
        if (run) return String(await run(['logs', '--tail', String(lines), ref], undefined, { dockerHost })).trim();
        const { stdout, stderr } = await execFileAsync('docker', ['logs', '--tail', String(lines), ref], { env: cliEnv() });
        return `${stdout}${stderr}`.trim();
      } catch {
        return '';
      }
    },

    async stop(ref) {
      await docker(['rm', '-f', ref]).catch((err) => {
        console.warn('launcher: docker rm failed', { ref, message: err?.message?.split('\n')[0] });
      });
    },
  };
}
