// The local provider's launcher: session containers on the console's own host, with docker. AWS's is
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

/**
 * @param {{image: string, memory: string, cpus: string, network?: string|null, projectFilesDir?: string|null,
 *          repo?: string|null}} opts  `network` is the docker network sessions join, to reach the shared services by
 *   name (compose.yml's `woodshed`); `projectFilesDir` the installation's folder of project files, and `repo` the
 *   image's repo, owner/name (projectFileMounts.mjs); `run` stands in for the docker CLI in tests
 */
export function dockerLauncher({ image, memory, cpus, network = null, projectFilesDir = null, repo = null, run = null }) {
  async function docker(args, env) {
    if (run) return run(args, env);
    const { stdout } = await execFileAsync('docker', args, { env: env ? { ...process.env, ...env } : process.env });
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
      const mounts = projectFileMounts({ dir: projectFilesDir, repos: [repo, given.PROJECT_REPO] });
      if (projectFilesDir) console.log('launcher: installation project files', { sessionId, mounted: mounts.repos });
      const env = mounts.repos.length ? { ...given, WOODSHED_CLOUD_PROJECT_FILES_DIR: PROJECT_FILES_MOUNT } : given;
      const args = [
        'run', '-d', '--name', ref, '--init', '--memory', memory, '--cpus', cpus,
        '--add-host=host.docker.internal:host-gateway',
        '-p', '127.0.0.1::7681', '-p', '127.0.0.1::7682', '-p', '127.0.0.1::7684',
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
        return { ref, host: '127.0.0.1', termPort, statusPort, shellPort };
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
        const { stdout, stderr } = await execFileAsync('docker', ['logs', '--tail', String(lines), ref]);
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
