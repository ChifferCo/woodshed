#!/usr/bin/env node
// Starts a session with its own Docker the way the console does, on a machine with Sysbox, and checks it from inside
// and out: the proof session/ownDocker.sh and the docker launcher's `ownDocker` need, which their tests (stand-ins for
// Docker) cannot give. .github/workflows/ownDocker.yml runs it on a GitHub runner; on a server with Sysbox:
//
//   node woodshed/providers/local/bin/ownDockerInImage.mjs <session image>
//
// The real launcher (dockerLauncher.mjs) decides and starts the container, with WOODSHED_SESSION_DOCKER=own's
// `required`, so a machine or image that cannot give a session its own Docker fails here as the start would. One thing
// is added to its `docker run`: ownDockerChecks.sh, mounted, which ownDocker.sh runs as node in the entrypoint's place
// (WOODSHED_ENTRYPOINT), since the entrypoint needs a console. Exits 1 when any check fails.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { createDockerLauncher, SYSBOX_RUNTIME, DOCKER_SOCKET } from '../dockerLauncher.mjs';

const image = process.argv[2];
if (!image) {
  console.error('usage: ownDockerInImage.mjs <session image>');
  process.exit(2);
}
const CHECKS = path.join(import.meta.dirname, 'ownDockerChecks.sh');
const CHECKS_IN = '/opt/woodshed-own-docker-checks.sh';
const docker = (args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();

const runs = [];
const launcher = createDockerLauncher({
  image, memory: '3g', cpus: '2', ownDocker: 'required',
  run: (args, env) => {
    // The session's own `docker run -d`, with the checks mounted: everything else is the launcher's.
    const sent = args[0] === 'run' && args[1] === '-d' ? ['run', '-d', '-v', `${CHECKS}:${CHECKS_IN}:ro`, ...args.slice(2)] : args;
    runs.push(sent);
    return execFileSync('docker', sent, { encoding: 'utf8', env: { ...process.env, ...env } }).trim();
  },
});

const failures = [];
const expect = (ok, what) => {
  console.log(`[host] ${ok ? 'ok' : 'FAIL'}: ${what}`);
  if (!ok) failures.push(what);
};

const sessionId = `proof${Date.now().toString(36)}`;
const started = await launcher.start(sessionId, { WOODSHED_ENTRYPOINT: CHECKS_IN });
const run = runs.find((args) => args[1] === '-d');
console.log('[host] docker run, as the launcher sent it (with the checks mounted):');
console.log(`  docker ${run.join(' ')}`);

let logs = '';
const deadline = Date.now() + 5 * 60_000;
while (Date.now() < deadline && !/\[check\] result: /.test(logs)) {
  await new Promise((r) => setTimeout(r, 2000));
  logs = await launcher.logTail(started.ref, 400);
  if (!(await launcher.isAlive(started.ref))) break;
}
console.log('[host] the session container\'s log:');
console.log(logs.replace(/^/gm, '  '));

const inspect = JSON.parse(docker(['inspect', started.ref]))[0];
expect(inspect.HostConfig.Runtime === SYSBOX_RUNTIME, `runs under ${SYSBOX_RUNTIME} (Runtime: ${inspect.HostConfig.Runtime})`);
expect(inspect.HostConfig.Privileged === false, 'not --privileged');
expect(!inspect.Mounts.some((m) => m.Destination === DOCKER_SOCKET || m.Source === DOCKER_SOCKET), 'the machine\'s Docker socket is not mounted');
expect(!(inspect.HostConfig.CapAdd || []).length, `no capabilities added (CapAdd: ${JSON.stringify(inspect.HostConfig.CapAdd)})`);
// Sysbox maps the container's root to an unprivileged range of the machine's ids: the daemon's process is not root here.
const dockerdUid = docker(['top', started.ref, '-eo', 'pid,uid,comm']).split('\n').find((l) => /\bdockerd$/.test(l.trim()))?.trim().split(/\s+/)[1];
expect(dockerdUid && dockerdUid !== '0' && dockerdUid !== 'root', `the session's dockerd runs as an unprivileged uid of the machine (uid: ${dockerdUid})`);
// The machine's own, but for the session's container (whose image is the one this was given).
const machineContainers = docker(['ps', '-a', '--format', '{{.Image}}']).split('\n').filter((i) => i && i !== image);
expect(!machineContainers.some((i) => /hello-world|own-docker-check|nginx|curl/.test(i)), `none of the session's containers is on the machine's Docker (others there: ${JSON.stringify(machineContainers)})`);
const machineImages = docker(['images', '--format', '{{.Repository}}']).split('\n');
expect(!machineImages.some((r) => /^(hello-world|own-docker-check.*|nginx|curlimages\/curl)$/.test(r)), 'none of the images the session pulled or built is on the machine\'s Docker');
expect(/Own Docker ready/.test(logs), 'ownDocker.sh logged Own Docker ready');
expect(/\[check\] result: pass/.test(logs), 'every check inside the session passed');

await launcher.stop(started.ref);
expect(!(await launcher.isAlive(started.ref)), 'the session is gone after its stop, its Docker with it');

console.log(failures.length ? `[host] result: fail (${failures.length})` : '[host] result: pass');
process.exit(failures.length ? 1 : 0);
