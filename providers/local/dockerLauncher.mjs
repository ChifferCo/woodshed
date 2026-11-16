// The local provider's launcher: session containers in docker, on the console's own host or on another machine's
// daemon (`dockerHost`), such as one reached over a private network. AWS's is
// ../aws/ecsLauncher.mjs, Fargate tasks; the console uses whichever its provider hands it.
//
// A launcher returns an endpoint the console can reach: the host plus the
// ports, ttyd on claude (7681 in the container), statusd (7682) and ttyd on a
// plain shell (7684).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { bothNames } from '../../shared/envNames.mjs';
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
// What finds a session's containers (providers/local/README.md, "Removing it"). Containers started before this one was
// named carry OLD_SESSION_LABEL instead, so what lists them reads both for one release; the old one goes after it.
export const SESSION_LABEL = 'woodshed.session';
export const OLD_SESSION_LABEL = 'woodshed-cloud.session';
const DOCKER_SETTINGS = new Set(['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']);

// The daemon's socket, where `docker run -v` finds it on the machine (Docker Desktop and OrbStack give this path to every
// container for their VM's daemon) and where a session finds it.
export const DOCKER_SOCKET = '/var/run/docker.sock';
// Sysbox's runtime, under which a container can run a Docker daemon of its own without being privileged
// (https://github.com/nestybox/sysbox), and the image's script that starts that daemon before the entrypoint.
export const SYSBOX_RUNTIME = 'sysbox-runc';
export const OWN_DOCKER_START = '/opt/woodshed/session/ownDocker.sh';
const OWN_DOCKER_RECHECK_MS = 10 * 60_000;
// What says a session has it (`1` the machine's, `own` its own), to claude's rules (writeRules in session/entrypoint.sh) and the project file's scripts.
// Only the launcher sets it: one from the session env file is left out.
const SESSION_DOCKER = 'WOODSHED_SESSION_DOCKER';

/**
 * @param {{image: string, memory: string, cpus: string, network?: string|null, projectFilesDir?: string|null,
 *          projectFilesHostDir?: string|null, repo?: string|null, dockerHost?: string|null, reachHost?: string|null}} opts
 *   `network` is the docker network sessions join, to reach the shared services by name (compose.yml's `woodshed`);
 *   `projectFilesDir` the installation's folder of project files, and `repo` the image's repo, owner/name
 *   (projectFileMounts.mjs). `dockerHost` is another machine's daemon, as DOCKER_HOST takes it (`ssh://woodshed@10.8.0.12`):
 *   every docker call goes there, and `projectFilesHostDir` is where that machine has the project files. `reachHost`
 *   is the address the console reaches the sessions' ports on (that machine's private address); they are published
 *   on it alone, and on 127.0.0.1 without it. `ownDocker` (`auto` or `required`) gives every session but a question
 *   from Slack a Docker daemon of its own, inside its container, where the machine has Sysbox; `hostDocker` gives them
 *   the machine's daemon's socket instead where they get no own one, which is root on that machine (config.mjs,
 *   sessionDocker). `run(args, env, {dockerHost})` stands in for the docker CLI in tests
 */
export function createDockerLauncher({
  image, memory, cpus, network = null, projectFilesDir = null, projectFilesHostDir = null, repo = null, dockerHost = null, reachHost = null,
  ownDocker = false, hostDocker = false, run = null,
}) {
  const bind = reachHost || '127.0.0.1';
  const cliEnv = (env) => ({ ...process.env, ...env, ...(dockerHost ? { DOCKER_HOST: dockerHost } : {}) });

  async function docker(args, env) {
    if (run) return run(args, env, { dockerHost });
    const { stdout } = await execFileAsync('docker', args, { env: cliEnv(env) });
    return stdout.trim();
  }

  // The group that owns the socket inside a container, which the session's node user (uid 1000) joins to use it: root's
  // (0) on Docker Desktop and OrbStack, the docker group's on Linux. Asked of a container rather than read from this
  // machine's own socket, so it is right wherever the daemon runs. Once per console, and again after a failure.
  let socketGroup = null;
  function hostSocketGroup() {
    socketGroup ??= docker(['run', '--rm', '--network', 'none', '--entrypoint', 'stat', '-v', `${DOCKER_SOCKET}:${DOCKER_SOCKET}`, image, '-c', '%g', DOCKER_SOCKET])
      .then((out) => {
        const gid = String(out).trim();
        if (!/^\d+$/.test(gid)) throw new Error(`stat said ${JSON.stringify(gid.slice(0, 80))}`);
        console.log('launcher: sessions get this machine\'s Docker', { socket: DOCKER_SOCKET, group: Number(gid) });
        return gid;
      })
      .catch((err) => {
        socketGroup = null;
        throw new Error(`sessions use this machine's Docker (WOODSHED_SESSION_DOCKER=0 turns that off), and its socket could not be given to the session: ${String(err?.stderr || err?.message || err).trim().split('\n')[0]}`);
      });
    return socketGroup;
  }

  // Whether sessions can run a Docker daemon of their own: the daemon has Sysbox's runtime, which runs the session's
  // container as an unprivileged user of the machine that is root only inside it, and the image has the daemon and
  // ownDocker.sh, which starts it (an image built before them has neither). A yes is kept for the console's life; a
  // no is asked again after OWN_DOCKER_RECHECK_MS, so Sysbox installed later reaches new sessions without a restart,
  // and a failure to ask at the next start. The answer is `{own: true}` or `{own: false, why}`.
  let ownDockerCheck = null;
  let ownDockerNoAt = 0;
  function ownDockerAvailable() {
    if (ownDockerNoAt && Date.now() - ownDockerNoAt >= OWN_DOCKER_RECHECK_MS) {
      ownDockerCheck = null;
      ownDockerNoAt = 0;
    }
    ownDockerCheck ??= (async () => {
      const runtimes = JSON.parse(await docker(['info', '--format', '{{json .Runtimes}}']) || '{}');
      if (!runtimes || !Object.hasOwn(runtimes, SYSBOX_RUNTIME)) return { own: false, why: `the machine's Docker has no ${SYSBOX_RUNTIME} runtime: install Sysbox (providers/local/README.md, "Docker in a session")` };
      const found = await docker(['run', '--rm', '--network', 'none', '--entrypoint', 'sh', image, '-c', `command -v dockerd >/dev/null && test -x ${OWN_DOCKER_START} && echo yes || echo no`]);
      if (String(found).trim() !== 'yes') return { own: false, why: 'the session image has no Docker daemon: an image built before it, build it again' };
      return { own: true };
    })().then(
      (answer) => {
        if (!answer.own) ownDockerNoAt = Date.now();
        console.log('launcher: sessions get their own Docker', answer.own
          ? { own: true, runtime: SYSBOX_RUNTIME }
          : { own: false, why: answer.why, instead: hostDocker ? 'this machine\'s Docker' : (ownDocker === 'required' ? 'no start' : 'no Docker') });
        return answer;
      },
      (err) => {
        ownDockerCheck = null;
        throw new Error(`could not ask the machine's Docker whether sessions can have their own: ${String(err?.stderr || err?.message || err).trim().split('\n')[0]}`);
      },
    );
    return ownDockerCheck;
  }

  /** @returns {Promise<{before: string[], after: string[]}>}  `docker run`'s arguments that give the session a Docker, before the image and after it */
  async function dockerArgs(sessionId, env) {
    const none = { before: [], after: [] };
    // A question from Slack reads and answers, and anyone in the workspace can ask one: it never gets a Docker.
    if (env.SESSION_MODE === 'ask') return none;
    if (ownDocker) {
      const { own, why } = await ownDockerAvailable();
      if (own) {
        console.log('launcher: session given its own Docker', { sessionId });
        // Root inside the container, which Sysbox maps to an unprivileged user of the machine, for ownDocker.sh to start
        // the daemon; it then runs the entrypoint as node. Naming the entrypoint drops the image's CMD, so it is given again.
        return {
          before: ['--runtime', SYSBOX_RUNTIME, '--user', '0', '--entrypoint', OWN_DOCKER_START, '-e', `DOCKER_HOST=unix://${DOCKER_SOCKET}`, '-e', `${SESSION_DOCKER}=own`],
          after: ['session'],
        };
      }
      if (ownDocker === 'required') throw new Error(`WOODSHED_SESSION_DOCKER=own, and this session cannot have its own Docker: ${why}`);
    }
    if (!hostDocker) return none;
    const group = await hostSocketGroup();
    console.log('launcher: session given this machine\'s Docker', { sessionId });
    return { before: ['-v', `${DOCKER_SOCKET}:${DOCKER_SOCKET}`, '--group-add', group, '-e', `DOCKER_HOST=unix://${DOCKER_SOCKET}`, '-e', `${SESSION_DOCKER}=1`], after: [] };
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
      const named = Object.fromEntries(Object.entries(given).filter(([key]) => !DOCKER_SETTINGS.has(key) && key !== SESSION_DOCKER));
      if (Object.keys(named).length !== Object.keys(given).length) console.warn('launcher: docker\'s own settings left out of the session\'s environment', { sessionId });
      const withDocker = await dockerArgs(sessionId, given);
      // Both names while a session image older than shared/envNames.mjs, which reads only the old one, may be running;
      // the old name goes in a later release.
      const env = mounts.repos.length ? { ...named, ...bothNames('PROJECT_FILES_DIR', PROJECT_FILES_MOUNT) } : named;
      const args = [
        'run', '-d', '--name', ref, '--init', '--memory', memory, '--cpus', cpus,
        '--add-host=host.docker.internal:host-gateway',
        '-p', `${bind}::7681`, '-p', `${bind}::7682`, '-p', `${bind}::7684`,
        '--label', `${SESSION_LABEL}=${sessionId}`,
        ...(network ? ['--network', network] : []),
        ...mounts.args,
        ...withDocker.before,
      ];
      for (const key of Object.keys(env)) args.push('-e', key);
      args.push(image, ...withDocker.after);
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
