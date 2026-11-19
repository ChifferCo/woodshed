import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fixtureProject, fixtureProjectFiles } from '../../shared/projectFixture.mjs';
import http from 'node:http';

import { DOCKER_SOCKET, OLD_SESSION_LABEL, OWN_DOCKER_START, SESSION_LABEL, createDockerLauncher, gatewayName, lockedNetworkName, parseDockerPort } from './dockerLauncher.mjs';
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
  assert.deepEqual(started, { ref: 'woodshed-a1b2c3d4', host: '10.8.0.12', termPort: 49153, statusPort: 49153, shellPort: 49153, docker: null });
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

// A launcher whose docker has the runtimes `runtimes` and an image that has its own daemon or not, recording every call.
function ownDockerLauncher({ ownDocker = 'auto', hostDocker = false, runtimes = { runc: {}, 'sysbox-runc': {} }, imageHasDaemon = true, infoFails = false }) {
  const calls = [];
  const launcher = createDockerLauncher({
    image: 'woodshed-session', memory: '6g', cpus: '2', ownDocker, hostDocker,
    run: async (args, env) => {
      calls.push({ args, env });
      if (args[0] === 'info') {
        if (infoFails) throw Object.assign(new Error('exit 1'), { stderr: 'Cannot connect to the Docker daemon\n' });
        return JSON.stringify(runtimes);
      }
      if (args.includes('--rm') && args.includes('sh')) return imageHasDaemon ? 'yes\n' : 'no\n';
      if (args.includes('--rm') && args.includes('stat')) return '988\n';
      return args[0] === 'port' ? '127.0.0.1:49153' : '';
    },
  });
  const sessionRun = () => calls.filter((c) => c.args[0] === 'run' && c.args.includes('--name')).at(-1);
  const checks = () => calls.filter((c) => c.args[0] === 'info' || (c.args.includes('--rm') && c.args.includes('sh')));
  return { launcher, sessionRun, checks };
}

test('where the machine has Sysbox, a session runs its own Docker: under sysbox-runc, as root for ownDocker.sh, which is given the image\'s command, and with no socket of the machine\'s', async (t) => {
  const logs = [];
  t.mock.method(console, 'log', (...line) => logs.push(line));
  for (const hostDocker of [false, true]) {
    const { launcher, sessionRun, checks } = ownDockerLauncher({ hostDocker });
    await launcher.start('a1b2c3d4', { SESSION_ID: 'a1b2c3d4' });
    const { args } = sessionRun();
    const image = args.indexOf('woodshed-session');
    assert.deepEqual(args.slice(image), ['woodshed-session', 'session'], 'the image\'s CMD, which naming the entrypoint drops');
    const before = args.slice(0, image);
    assert.equal(before[before.indexOf('--runtime') + 1], 'sysbox-runc');
    assert.equal(before[before.indexOf('--user') + 1], '0');
    assert.equal(before[before.indexOf('--entrypoint') + 1], OWN_DOCKER_START);
    assert.ok(before.includes('WOODSHED_SESSION_DOCKER=own'));
    assert.ok(before.includes('DOCKER_HOST=unix:///var/run/docker.sock'));
    assert.equal(before.includes('-v'), false, 'never the machine\'s socket');
    assert.equal(before.includes('--group-add'), false);
    assert.equal(before.includes('--privileged'), false);

    await launcher.start('b1b2c3d4', { SESSION_ID: 'b1b2c3d4', SESSION_KIND: 'private' });
    assert.ok(sessionRun().args.includes('WOODSHED_SESSION_DOCKER=own'));
    assert.deepEqual(checks().map((c) => c.args[0]), ['info', 'run'], 'asked once per console');
    assert.deepEqual(checks()[1].args, ['run', '--rm', '--network', 'none', '--entrypoint', 'sh', 'woodshed-session', '-c', `command -v dockerd >/dev/null && test -x ${OWN_DOCKER_START} && echo yes || echo no`]);
  }
  assert.deepEqual(logs.find(([m]) => m === 'launcher: sessions get their own Docker'), ['launcher: sessions get their own Docker', { own: true, runtime: 'sysbox-runc' }]);
});

test('a question from Slack gets no Docker of its own either', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { launcher, sessionRun, checks } = ownDockerLauncher({});
  await launcher.start('a1b2c3d4', { SESSION_ID: 'a1b2c3d4', SESSION_MODE: 'ask' });
  assert.equal(sessionRun().args.some((a) => a === '--runtime' || a.startsWith('WOODSHED_SESSION_DOCKER')), false);
  assert.equal(checks().length, 0);
});

test('without Sysbox, or with an image that has no daemon, a session falls back to the machine\'s Docker where that is on, and to none elsewhere, saying why once', async (t) => {
  const logs = [];
  t.mock.method(console, 'log', (...line) => logs.push(line));
  const cases = [
    [{ runtimes: { runc: {} }, hostDocker: true }, '1', /no sysbox-runc runtime: install Sysbox/, 'this machine\'s Docker'],
    [{ runtimes: { runc: {} }, hostDocker: false }, null, /no sysbox-runc runtime/, 'no Docker'],
    [{ imageHasDaemon: false, hostDocker: false }, null, /the session image has no Docker daemon: an image built before it, build it again/, 'no Docker'],
  ];
  for (const [opts, given, why, instead] of cases) {
    logs.length = 0;
    const { launcher, sessionRun, checks } = ownDockerLauncher(opts);
    await launcher.start('a1b2c3d4', { SESSION_ID: 'a1b2c3d4' });
    await launcher.start('b1b2c3d4', { SESSION_ID: 'b1b2c3d4' });
    const { args } = sessionRun();
    assert.equal(args.includes('--runtime'), false);
    assert.equal(args.find((a) => a.startsWith('WOODSHED_SESSION_DOCKER=')) ?? null, given && `WOODSHED_SESSION_DOCKER=${given}`);
    assert.equal(args.at(-1), 'woodshed-session', 'the image\'s own entrypoint and command');
    const said = logs.filter(([m]) => m === 'launcher: sessions get their own Docker');
    assert.equal(said.length, 1);
    assert.equal(said[0][1].own, false);
    assert.match(said[0][1].why, why);
    assert.equal(said[0][1].instead, instead);
    assert.equal(checks().filter((c) => c.args[0] === 'info').length, 1);
  }
});

test('required (the proof\'s) refuses a start that cannot have its own Docker, and a docker that does not answer is asked again', async (t) => {
  t.mock.method(console, 'log', () => {});
  const warnings = [];
  t.mock.method(console, 'warn', (...line) => warnings.push(line));
  const { launcher } = ownDockerLauncher({ ownDocker: 'required', runtimes: { runc: {} } });
  await assert.rejects(launcher.start('a1b2c3d4', {}), /^Error: this session was to have its own Docker, and cannot: the machine's Docker has no sysbox-runc runtime/);

  const failing = ownDockerLauncher({ ownDocker: 'required', infoFails: true });
  await assert.rejects(failing.launcher.start('a1b2c3d4', {}), /could not ask the machine's Docker whether sessions can have their own: Cannot connect to the Docker daemon$/);
  await assert.rejects(failing.launcher.start('a1b2c3d4', {}));
  assert.equal(failing.checks().length, 2, 'not kept: asked again at the next start');

  // Unasked (`auto`), a docker that does not answer the question does not fail the start: it goes on as without Sysbox.
  for (const hostDocker of [false, true]) {
    const auto = ownDockerLauncher({ infoFails: true, hostDocker });
    await auto.launcher.start('a1b2c3d4', {});
    const args = auto.sessionRun().args;
    assert.equal(args.includes('--runtime'), false);
    assert.equal(args.includes('/var/run/docker.sock:/var/run/docker.sock'), hostDocker);
    await auto.launcher.start('a1b2c3d4', {});
    assert.equal(auto.checks().length, 2, 'asked again at the next start');
  }
  assert.deepEqual(warnings[0], ['launcher: session started without its own Docker, the machine\'s Docker did not answer', { sessionId: 'a1b2c3d4', why: 'could not ask the machine\'s Docker whether sessions can have their own: Cannot connect to the Docker daemon' }]);
});

test('a machine with no Sysbox is asked again ten minutes later, so Sysbox installed then reaches new sessions without a restart', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const runtimes = { runc: {} };
  const { launcher, sessionRun, checks } = ownDockerLauncher({ runtimes });
  await launcher.start('a1b2c3d4', {});
  runtimes['sysbox-runc'] = {};
  t.mock.timers.tick(9 * 60_000);
  await launcher.start('a1b2c3d4', {});
  assert.equal(sessionRun().args.includes('--runtime'), false, 'the no is kept for a while');
  assert.equal(checks().length, 1);
  t.mock.timers.tick(60_000);
  await launcher.start('a1b2c3d4', {});
  assert.ok(sessionRun().args.includes('--runtime'));
  t.mock.timers.tick(60 * 60_000);
  await launcher.start('a1b2c3d4', {});
  assert.deepEqual(checks().map((c) => c.args[0]), ['info', 'info', 'run'], 'a yes is kept');
});

// A docker that keeps which networks each container is on, for the lockdown's tests.
function fakeDocker({ statusPort, networkGateway = '', fail = () => false }) {
  const state = {
    networks: { 'woodshed-a1b2c3d4': ['woodshed'] }, made: new Set(), removed: [], calls: [],
    hosts: '127.0.0.1\tlocalhost\n172.17.0.1\thost.docker.internal\n172.18.0.4\tpostgres-old\n',
  };
  const run = async (args) => {
    state.calls.push(args);
    if (fail(args, state)) throw Object.assign(new Error('docker said no'), { stderr: 'docker said no' });
    const [verb, sub] = args;
    const last = args.at(-1);
    if (verb === 'network' && sub === 'inspect') {
      const name = args.at(-1);
      if (!state.made.has(name)) throw new Error(`No such network: ${name}`);
      return JSON.stringify({ Name: name, Internal: true, IPAM: { Config: [{ Subnet: '172.30.0.0/16', ...(networkGateway ? { Gateway: networkGateway } : {}) }] } });
    }
    if (verb === 'network' && sub === 'create') { state.made.add(last); return ''; }
    if (verb === 'network' && sub === 'rm') { state.made.delete(last); state.removed.push(last); return ''; }
    if (verb === 'network' && sub === 'connect') { const [net, c] = args.slice(-2); (state.networks[c] ??= []).push(net); return ''; }
    if (verb === 'network' && sub === 'disconnect') { const [net, c] = args.slice(-2); state.networks[c] = (state.networks[c] ?? []).filter((n) => n !== net); return ''; }
    if (verb === 'inspect') {
      return JSON.stringify(Object.fromEntries((state.networks[last] ?? []).map((n) => [n, { IPAddress: last.endsWith('-gw') && n.startsWith('woodshed-locked-') ? '172.30.0.2' : '172.17.0.9' }])));
    }
    if (verb === 'run') {
      const name = args[args.indexOf('--name') + 1];
      state.networks[name] = [args[args.indexOf('--network') + 1]];
      return 'id';
    }
    if (verb === 'port') return `127.0.0.1:${statusPort}`;
    if (verb === 'exec' && args.includes('cat')) return state.hosts.trim();
    if (verb === 'exec') { state.hosts = args.find((a) => a.startsWith('WOODSHED_HOSTS=')).slice('WOODSHED_HOSTS='.length); return ''; }
    if (verb === 'rm') { delete state.networks[last]; state.removed.push(last); return ''; }
    return '';
  };
  return { state, run };
}

// statusd behind the gateway: any HTTP answer says the way in works.
async function statusdStandIn(t) {
  const server = http.createServer((req, res) => res.writeHead(401).end());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return server.address().port;
}

const SESSION_ENV = {
  SESSION_ID: 'a1b2c3d4', WOODSHED_CONSOLE_URL: 'http://host.docker.internal:7691', PGHOST: 'postgres', PGPORT: '5432',
  WOODSHED_SERVICES: 'S3_ENDPOINT', S3_ENDPOINT: 'http://s3:4566',
};

test('lockDown moves a running session onto an isolated network whose one other member is its gateway, and the console then reaches it through the gateway', async (t) => {
  t.mock.method(console, 'log', () => {});
  const statusPort = await statusdStandIn(t);
  const { state, run } = fakeDocker({ statusPort });
  const launcher = createDockerLauncher({ image: 'woodshed-session', memory: '6g', cpus: '2', network: 'woodshed', run });
  const endpoint = await launcher.lockDown('woodshed-a1b2c3d4', { sessionId: 'a1b2c3d4', env: SESSION_ENV, egressUrl: 'http://host.docker.internal:7693' });
  assert.deepEqual(endpoint, { host: '127.0.0.1', termPort: statusPort, statusPort, shellPort: statusPort, locked: true });

  const create = state.calls.find((c) => c[0] === 'network' && c[1] === 'create');
  assert.ok(create.includes('--internal'), 'no route out');
  assert.ok(create.includes('com.docker.network.bridge.gateway_mode_ipv4=isolated'), 'and no address of the machine\'s on it');
  assert.deepEqual(state.networks['woodshed-a1b2c3d4'], [lockedNetworkName('a1b2c3d4')], 'on the isolated network alone');
  assert.deepEqual(state.networks[gatewayName('a1b2c3d4')], ['woodshed', lockedNetworkName('a1b2c3d4')], 'the gateway on both');

  const gw = state.calls.find((c) => c[0] === 'run');
  const env = Object.fromEntries(gw.flatMap((a, i) => (gw[i - 1] === '-e' ? [a.split(/=(.*)/s).slice(0, 2)] : [])));
  assert.equal(env.WOODSHED_GATEWAY_SESSION, 'woodshed-a1b2c3d4');
  assert.equal(env.WOODSHED_GATEWAY_INBOUND, '7681,7682,7684');
  assert.equal(env.WOODSHED_GATEWAY_OUTBOUND, '7691=host.docker.internal:7691,7693=host.docker.internal:7693,5432=postgres:5432,4566=s3:4566',
    'the console, its egress proxy, the database and the shared service, and nothing else');
  assert.deepEqual(gw.filter((a, i) => gw[i - 1] === '-p'), ['127.0.0.1::7681', '127.0.0.1::7682', '127.0.0.1::7684']);
  assert.ok(!gw.some((a) => a.includes('docker.sock')), 'the gateway holds no Docker socket');

  assert.match(state.hosts, /^172\.30\.0\.2\thost\.docker\.internal postgres s3\t/m, 'the destinations\' names point at the gateway');
  assert.doesNotMatch(state.hosts, /172\.17\.0\.1/, 'and no longer at the machine');
  const order = state.calls.map((c) => (c[0] === 'exec' ? (c.includes('cat') ? 'read hosts' : 'write hosts') : c.slice(0, 2).join(' ')));
  assert.ok(order.lastIndexOf('network disconnect') < order.lastIndexOf('write hosts'), 'the names are pointed after the session left its network');
});

test('lockDown on a Docker that gives the isolated network an address of the machine\'s refuses, and leaves the session as it was', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const statusPort = await statusdStandIn(t);
  const { state, run } = fakeDocker({ statusPort, networkGateway: '172.30.0.1' });
  const launcher = createDockerLauncher({ image: 'woodshed-session', memory: '6g', cpus: '2', network: 'woodshed', run });
  await assert.rejects(launcher.lockDown('woodshed-a1b2c3d4', { sessionId: 'a1b2c3d4', env: SESSION_ENV }), /Docker 28 or newer/);
  assert.deepEqual(state.networks['woodshed-a1b2c3d4'], ['woodshed']);
  assert.ok(!state.made.has(lockedNetworkName('a1b2c3d4')), 'the network is removed again');
});

test('a lockdown that fails halfway puts the session back on its networks and its names back, and removes the gateway', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const statusPort = await statusdStandIn(t);
  const { state, run } = fakeDocker({ statusPort, fail: (args) => args[0] === 'exec' && !args.includes('cat') && !args.join(' ').includes('host.docker.internal\n172.18') && args.join(' ').includes('172.30.0.2') });
  const hostsBefore = state.hosts;
  const launcher = createDockerLauncher({ image: 'woodshed-session', memory: '6g', cpus: '2', network: 'woodshed', run });
  await assert.rejects(launcher.lockDown('woodshed-a1b2c3d4', { sessionId: 'a1b2c3d4', env: SESSION_ENV }), /docker said no/);
  assert.deepEqual(state.networks['woodshed-a1b2c3d4'], ['woodshed'], 'back on its own network, off the isolated one');
  assert.equal(state.hosts.trim(), hostsBefore.trim());
  assert.ok(state.removed.includes(gatewayName('a1b2c3d4')));
  assert.ok(state.removed.includes(lockedNetworkName('a1b2c3d4')));
});

test('lockDown refuses a destination given by its address, before it changes anything', async (t) => {
  const { state, run } = fakeDocker({ statusPort: 1 });
  const launcher = createDockerLauncher({ image: 'i', memory: '6g', cpus: '2', run });
  await assert.rejects(launcher.lockDown('woodshed-a1b2c3d4', { sessionId: 'a1b2c3d4', env: { ...SESSION_ENV, PGHOST: '10.0.0.5' } }), /given by its address/);
  assert.ok(!state.calls.some((c) => c[0] === 'network' && c[1] !== 'inspect'));
});

test('a tainted session is started locked down: on its isolated network alone, its names the gateway\'s, its ports the gateway\'s, and no Docker of the machine\'s', async (t) => {
  t.mock.method(console, 'log', () => {});
  const statusPort = await statusdStandIn(t);
  const { state, run } = fakeDocker({ statusPort });
  const launcher = createDockerLauncher({ image: 'woodshed-session', memory: '6g', cpus: '2', network: 'woodshed', hostDocker: true, run });
  const started = await launcher.start('a1b2c3d4', { ...SESSION_ENV, WOODSHED_TAINTED: '1', WOODSHED_EGRESS_PROXY: 'http://host.docker.internal:7693' });
  assert.deepEqual(started, { ref: 'woodshed-a1b2c3d4', host: '127.0.0.1', termPort: statusPort, statusPort, shellPort: statusPort, docker: null, locked: true });
  const session = state.calls.find((c) => c[0] === 'run' && c.includes('woodshed-a1b2c3d4'));
  assert.equal(session[session.indexOf('--network') + 1], lockedNetworkName('a1b2c3d4'));
  assert.ok(!session.includes('-p'), 'nothing published: the gateway publishes for it');
  assert.deepEqual(session.filter((a) => a.startsWith('--add-host')), ['--add-host=host.docker.internal:172.30.0.2', '--add-host=postgres:172.30.0.2', '--add-host=s3:172.30.0.2']);
  assert.ok(!session.some((a) => a.includes('docker.sock')));
});

test('a session that may use production never gets the machine\'s Docker, and says which Docker it got', async (t) => {
  t.mock.method(console, 'log', () => {});
  const runs = [];
  const launcher = createDockerLauncher({
    image: 'i', memory: '6g', cpus: '2', hostDocker: true,
    run: async (args) => {
      runs.push(args);
      if (args[0] === 'run' && args.includes('stat')) return '999';
      return args[0] === 'port' ? '127.0.0.1:49153' : '';
    },
  });
  const plain = await launcher.start('a1b2c3d4', { SESSION_ID: 'a1b2c3d4' });
  assert.equal(plain.docker, 'host');
  const production = await launcher.start('b1b2c3d4', { SESSION_ID: 'b1b2c3d4', WOODSHED_PROD_MCP: '1' });
  assert.equal(production.docker, null);
  const run = runs.filter((a) => a[0] === 'run' && a.includes('woodshed-b1b2c3d4'))[0];
  assert.ok(!run.some((a) => a.includes('docker.sock')));
});

test('stop takes a locked-down session\'s gateway and isolated network with it', async () => {
  const { state, run } = fakeDocker({ statusPort: 1 });
  const launcher = createDockerLauncher({ image: 'i', memory: '6g', cpus: '2', run });
  await launcher.stop('woodshed-a1b2c3d4');
  assert.deepEqual(state.removed, ['woodshed-a1b2c3d4', gatewayName('a1b2c3d4'), lockedNetworkName('a1b2c3d4')]);
});
