import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fixtureProject, fixtureProjectFiles } from '../../shared/projectFixture.mjs';
import { DOCKER_SOCKET, OLD_SESSION_LABEL, SESSION_LABEL, createDockerLauncher, parseDockerPort } from './dockerLauncher.mjs';
import { PROJECT_FILES_MOUNT, projectFileMounts } from './projectFileMounts.mjs';

test('parseDockerPort reads the host port docker published', () => {
  assert.equal(parseDockerPort('127.0.0.1:49153'), 49153);
  assert.equal(parseDockerPort('0.0.0.0:49153\n[::]:49153'), 49153);
  assert.equal(parseDockerPort(''), null);
});

function launch({ projectFilesDir, repo = 'acme/app', env = {} }) {
  const runs = [];
  const launcher = createDockerLauncher({
    image: 'woodshed-session', memory: '6g', cpus: '2', projectFilesDir, repo,
    run: async (args, given) => {
      if (args[0] === 'run') runs.push({ args, env: given });
      return args[0] === 'port' ? '127.0.0.1:49153' : '';
    },
  });
  return launcher.start('a1b2c3d4', { SESSION_ID: 'a1b2c3d4', ...env }).then(() => runs[0]);
}

test('a session is labelled woodshed.session, and what lists them reads that and the label it had before', async () => {
  const { args } = await launch({ projectFilesDir: null });
  const labels = args.flatMap((a, i) => (args[i - 1] === '--label' ? [a] : []));
  assert.deepEqual(labels, [`${SESSION_LABEL}=a1b2c3d4`]);
  assert.equal(SESSION_LABEL, 'woodshed.session');
  // Nothing in the console lists sessions by label: the README's removal step does, and must still find a container
  // started before the rename.
  const readme = fs.readFileSync(path.join(import.meta.dirname, 'README.md'), 'utf8');
  for (const label of [SESSION_LABEL, OLD_SESSION_LABEL]) {
    assert.ok(readme.includes(`docker ps -aq --filter label=${label} | xargs -r docker rm -f`), label);
  }
});

function mountsOf(args) {
  return args.flatMap((a, i) => (args[i - 1] === '--mount' ? [a] : []));
}

test('a session gets its repo\'s and the image\'s repo\'s installation project files, each mounted read-only, and no other', async (t) => {
  t.mock.method(console, 'log', () => {});
  const dir = fixtureProjectFiles(fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-files-')), {
    'acme/app': fixtureProject(), 'Other/Web': fixtureProject(), 'acme/secret-plans': fixtureProject(),
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const own = await launch({ projectFilesDir: dir });
  assert.deepEqual(mountsOf(own.args), [`type=bind,source=${path.join(dir, 'acme/app.yaml')},target=${PROJECT_FILES_MOUNT}/acme/app.yaml,readonly`]);
  assert.equal(own.env.WOODSHED_PROJECT_FILES_DIR, PROJECT_FILES_MOUNT);
  assert.ok(own.args.includes('WOODSHED_PROJECT_FILES_DIR'), 'passed by name, as every variable is');
  assert.equal(own.env.WOODSHED_CLOUD_PROJECT_FILES_DIR, PROJECT_FILES_MOUNT, 'and under its old name, for an older session image');
  assert.ok(own.args.includes('WOODSHED_CLOUD_PROJECT_FILES_DIR'));

  const other = await launch({ projectFilesDir: dir, env: { PROJECT_REPO: 'other/web' } });
  assert.deepEqual(mountsOf(other.args), [
    `type=bind,source=${path.join(dir, 'acme/app.yaml')},target=${PROJECT_FILES_MOUNT}/acme/app.yaml,readonly`,
    `type=bind,source=${path.join(dir, 'Other/Web.yaml')},target=${PROJECT_FILES_MOUNT}/other/web.yaml,readonly`,
  ]);

  const none = await launch({ projectFilesDir: dir, repo: 'acme/nothing' });
  assert.deepEqual(mountsOf(none.args), []);
  assert.equal(none.env.WOODSHED_PROJECT_FILES_DIR, undefined, 'a repo with no file there reads none, as one with no folder');
  assert.equal(none.env.WOODSHED_CLOUD_PROJECT_FILES_DIR, undefined);
  assert.deepEqual(mountsOf((await launch({ projectFilesDir: null })).args), []);
  assert.deepEqual(mountsOf((await launch({ projectFilesDir: path.join(dir, 'missing') })).args), []);
});

test('a mount\'s path with a comma or a quote is one CSV field, as docker reads --mount', (t) => {
  const dir = fixtureProjectFiles(fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-files,"odd"-')), { 'acme/app': fixtureProject() });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const [, value] = projectFileMounts({ dir, repos: ['acme/app'] }).args;
  assert.equal(value, `type=bind,"source=${path.join(dir, 'acme/app.yaml').replaceAll('"', '""')}",target=${PROJECT_FILES_MOUNT}/acme/app.yaml,readonly`);
});

test('on another machine\'s daemon every docker call goes there, the ports are published on its private address, and the console is told that address', async (t) => {
  t.mock.method(console, 'log', () => {});
  const calls = [];
  const launcher = createDockerLauncher({
    image: 'woodshed-session', memory: '6g', cpus: '2', repo: 'acme/app', dockerHost: 'ssh://woodshed@10.8.0.12', reachHost: '10.8.0.12',
    run: async (args, env, { dockerHost }) => {
      calls.push({ verb: args[0], args, env, dockerHost });
      return args[0] === 'port' ? '10.8.0.12:49153' : '';
    },
  });
  const started = await launcher.start('a1b2c3d4', { SESSION_ID: 'a1b2c3d4' });
  assert.deepEqual(started, { ref: 'woodshed-a1b2c3d4', host: '10.8.0.12', termPort: 49153, statusPort: 49153, shellPort: 49153 });
  const runArgs = calls.find((c) => c.verb === 'run').args;
  assert.deepEqual(runArgs.filter((a, i) => runArgs[i - 1] === '-p'), ['10.8.0.12::7681', '10.8.0.12::7682', '10.8.0.12::7684']);
  await launcher.isAlive('woodshed-a1b2c3d4');
  await launcher.logTail('woodshed-a1b2c3d4');
  await launcher.stop('woodshed-a1b2c3d4');
  assert.deepEqual([...new Set(calls.map((c) => c.dockerHost))], ['ssh://woodshed@10.8.0.12'], 'run, port, inspect, logs and rm alike');
});

test('on this machine the ports stay on loopback', async (t) => {
  t.mock.method(console, 'log', () => {});
  let runArgs;
  const launcher = createDockerLauncher({
    image: 'i', memory: '6g', cpus: '2', run: async (args, env, opts) => {
      if (args[0] === 'run') runArgs = { args, dockerHost: opts.dockerHost };
      return args[0] === 'port' ? '127.0.0.1:49153' : '';
    },
  });
  assert.equal((await launcher.start('a1b2c3d4', {})).host, '127.0.0.1');
  assert.deepEqual(runArgs.args.filter((a, i) => runArgs.args[i - 1] === '-p'), ['127.0.0.1::7681', '127.0.0.1::7682', '127.0.0.1::7684']);
  assert.equal(runArgs.dockerHost, null);
});

test('a session\'s environment cannot point the console\'s docker calls at another daemon', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  let run;
  const launcher = createDockerLauncher({
    image: 'i', memory: '6g', cpus: '2', dockerHost: 'ssh://woodshed@10.8.0.12', reachHost: '10.8.0.12',
    run: async (args, env) => {
      if (args[0] === 'run') run = { args, env };
      return args[0] === 'port' ? '10.8.0.12:1' : '';
    },
  });
  await launcher.start('a1b2c3d4', { SESSION_ID: 'a1b2c3d4', DOCKER_HOST: 'tcp://elsewhere:2375', DOCKER_CONTEXT: 'x' });
  assert.equal(run.env.DOCKER_HOST, undefined);
  assert.equal(run.args.includes('DOCKER_HOST'), false);
  assert.equal(run.args.includes('DOCKER_CONTEXT'), false);
});

test('a remote docker host mounts the project files from its own copy of the folder', async (t) => {
  t.mock.method(console, 'log', () => {});
  const dir = fixtureProjectFiles(fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-files-')), { 'acme/app': fixtureProject() });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let runArgs;
  const launcher = createDockerLauncher({
    image: 'i', memory: '6g', cpus: '2', repo: 'acme/app', projectFilesDir: dir, projectFilesHostDir: '/srv/woodshed/project-files',
    dockerHost: 'ssh://woodshed@10.8.0.12', reachHost: '10.8.0.12',
    run: async (args) => {
      if (args[0] === 'run') runArgs = args;
      return args[0] === 'port' ? '10.8.0.12:1' : '';
    },
  });
  await launcher.start('a1b2c3d4', {});
  assert.deepEqual(mountsOf(runArgs), [`type=bind,source=/srv/woodshed/project-files/acme/app.yaml,target=${PROJECT_FILES_MOUNT}/acme/app.yaml,readonly`]);
});

// A launcher whose docker answers the socket's group as `group`, recording every call.
function hostDockerLauncher({ hostDocker, group = '0' }) {
  const calls = [];
  const launcher = createDockerLauncher({
    image: 'woodshed-session', memory: '6g', cpus: '2', hostDocker,
    run: async (args, env) => {
      calls.push({ args, env });
      if (args.includes('--entrypoint')) return `${group}\n`;
      return args[0] === 'port' ? '127.0.0.1:49153' : '';
    },
  });
  const sessionRun = () => calls.filter((c) => c.args[0] === 'run' && c.args.includes('--name')).at(-1);
  const probes = () => calls.filter((c) => c.args.includes('--entrypoint'));
  return { launcher, sessionRun, probes };
}

test('with the machine\'s Docker, a session gets its socket, the socket\'s group and the variables that say so, and the group is asked once', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { launcher, sessionRun, probes } = hostDockerLauncher({ hostDocker: true, group: '988' });
  await launcher.start('a1b2c3d4', { SESSION_ID: 'a1b2c3d4', SESSION_KIND: 'private' });
  const { args, env } = sessionRun();
  assert.deepEqual(args.filter((a, i) => args[i - 1] === '-v'), [`${DOCKER_SOCKET}:${DOCKER_SOCKET}`]);
  assert.deepEqual(args.filter((a, i) => args[i - 1] === '--group-add'), ['988']);
  assert.ok(args.includes('DOCKER_HOST=unix:///var/run/docker.sock'), 'its value inline: the CLI\'s own environment never gets it');
  assert.ok(args.includes('WOODSHED_SESSION_DOCKER=1'));
  assert.equal(env.DOCKER_HOST, undefined);
  assert.ok(args.indexOf('-v') < args.indexOf('woodshed-session'), 'before the image');

  // The group is asked of a container with the socket mounted, as uid 1000's container will see it.
  const [probe] = probes();
  assert.deepEqual(probe.args, ['run', '--rm', '--network', 'none', '--entrypoint', 'stat', '-v', `${DOCKER_SOCKET}:${DOCKER_SOCKET}`, 'woodshed-session', '-c', '%g', DOCKER_SOCKET]);

  await launcher.start('b1b2c3d4', { SESSION_ID: 'b1b2c3d4' });
  assert.equal(probes().length, 1, 'once per console');
  assert.ok(sessionRun().args.includes('WOODSHED_SESSION_DOCKER=1'), 'a shared session gets it too: anyone who starts one has the machine');
});

test('without the machine\'s Docker, or for a question from Slack, a session gets no socket, and a session env file cannot say it has one', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  for (const [hostDocker, env] of [[false, {}], [true, { SESSION_MODE: 'ask' }]]) {
    const { launcher, sessionRun, probes } = hostDockerLauncher({ hostDocker });
    await launcher.start('a1b2c3d4', { SESSION_ID: 'a1b2c3d4', WOODSHED_SESSION_DOCKER: '1', ...env });
    const { args, env: given } = sessionRun();
    assert.equal(args.includes('-v'), false);
    assert.equal(args.includes('--group-add'), false);
    assert.equal(args.some((a) => a.startsWith('DOCKER_HOST')), false);
    assert.equal(args.some((a) => a.startsWith('WOODSHED_SESSION_DOCKER')), false);
    assert.equal(given.WOODSHED_SESSION_DOCKER, undefined);
    assert.equal(probes().length, 0);
  }
});

test('a socket that cannot be given stops the start and says how to turn it off, and is asked again next time', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  let fail = true;
  const launcher = createDockerLauncher({
    image: 'i', memory: '6g', cpus: '2', hostDocker: true,
    run: async (args) => {
      if (args.includes('--entrypoint')) {
        if (fail) throw Object.assign(new Error('exit 125'), { stderr: 'docker: Error response from daemon: invalid mount config\n' });
        return '0';
      }
      return args[0] === 'port' ? '127.0.0.1:1' : '';
    },
  });
  await assert.rejects(launcher.start('a1b2c3d4', {}), /WOODSHED_SESSION_DOCKER=0 turns that off\), and its socket could not be given to the session: docker: Error response from daemon: invalid mount config$/);
  fail = false;
  await launcher.start('a1b2c3d4', {});
});
