import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.join(import.meta.dirname, 'ownDocker.sh');

// ownDocker.sh with stand-ins on the PATH: `id` says root or not, `dockerd` listens on its socket (or exits at once),
// `docker version` answers once the socket is there, and `setpriv` prints what it was asked to run.
function runOwnDocker(t, { root = true, daemonStarts = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-own-docker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const socket = path.join(dir, 'docker.sock');
  const write = (name, text) => fs.writeFileSync(path.join(bin, name), text, { mode: 0o755 });
  write('id', `#!/bin/bash\ncase "$1" in -u) echo ${root ? 0 : 1000} ;; -un) echo ${root ? 'root' : 'node'} ;; esac\n`);
  write('dockerd', daemonStarts
    ? `#!/usr/bin/env node
const host = process.argv[process.argv.indexOf('--host') + 1].replace('unix://', '');
console.log('dockerd args', process.argv.slice(2).join(' '));
const server = require('node:net').createServer().listen(host);
setTimeout(() => server.close(), 3000).unref();
setTimeout(() => {}, 3000);
`
    : '#!/bin/bash\necho "failed to start daemon: Error initializing network controller"\nexit 1\n');
  write('docker', '#!/bin/bash\n[ "$1" = version ] && [ -S "${DOCKER_HOST#unix://}" ]\n');
  write('setpriv', '#!/bin/bash\necho "setpriv $*"\n');
  write('entrypoint.sh', '#!/bin/bash\necho "entrypoint as is: $*"\n');
  const log = path.join(dir, 'dockerd.log');
  const out = spawnSync('bash', [SCRIPT, 'session'], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      WOODSHED_DOCKER_SOCKET: socket,
      WOODSHED_DOCKERD_LOG: log,
      WOODSHED_DOCKER_WAIT_SECONDS: '5',
      WOODSHED_ENTRYPOINT: path.join(bin, 'entrypoint.sh'),
    },
  });
  return { ...out, log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : null, logMode: fs.existsSync(log) ? fs.statSync(log).mode & 0o777 : null, bin };
}

test('as root, it starts the daemon with its socket in the docker group, waits for it, then runs the entrypoint as node', (t) => {
  const { status, stdout, log, logMode, bin } = runOwnDocker(t);
  assert.equal(status, 0);
  assert.match(stdout, /\[woodshed \d\d:\d\d:\d\d\] Own Docker ready \(seconds: \d+, log: .*dockerd\.log\)/);
  assert.match(log, /dockerd args --group docker --host unix:\/\/.*docker\.sock/);
  assert.equal(logMode, 0o644, 'node reads the daemon\'s log');
  assert.ok(stdout.indexOf('Own Docker ready') < stdout.indexOf('setpriv'), 'claude starts once docker answers');
  assert.match(stdout, new RegExp(`setpriv --reuid=node --regid=node --init-groups env HOME=/home/node USER=node LOGNAME=node ${bin}/entrypoint\\.sh session\\n`));
  assert.doesNotMatch(stdout, /entrypoint as is/, 'never the entrypoint as root');
});

test('a daemon that does not start is said with its log, and the session starts anyway, as node', (t) => {
  const { status, stdout } = runOwnDocker(t, { daemonStarts: false });
  assert.equal(status, 0);
  assert.match(stdout, /WARNING: own Docker did not start \(seconds: \d+, log: .*\): failed to start daemon: Error initializing network controller/);
  assert.match(stdout, /setpriv --reuid=node --regid=node --init-groups .*entrypoint\.sh session/);
});

test('not run as root, it starts no daemon and runs the entrypoint as it is', (t) => {
  const { status, stdout, log } = runOwnDocker(t, { root: false });
  assert.equal(status, 0);
  assert.match(stdout, /WARNING: own Docker not started: ownDocker\.sh runs as node, not root/);
  assert.match(stdout, /entrypoint as is: session/);
  assert.doesNotMatch(stdout, /setpriv/);
  assert.equal(log, null);
});
