import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MAX_CLI_PROCESSES, awsCli, cliError, ecsLauncher, sessionOverrides, taskPrivateIp } from './ecsLauncher.mjs';

const ARN = 'arn:aws:ecs:us-east-1:123:task/woodshed-cloud/abc123';

function runningTask({ ip = '10.42.1.57', lastStatus = 'PROVISIONING' } = {}) {
  return {
    taskArn: ARN, lastStatus, desiredStatus: 'RUNNING',
    attachments: [{ type: 'ElasticNetworkInterface', details: ip ? [{ name: 'privateIPv4Address', value: ip }] : [] }],
  };
}

function fakeAws(answers) {
  const calls = [];
  async function aws(args) {
    calls.push(args);
    const key = `${args[0]} ${args[1]}`;
    const answer = answers[key];
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? answer(args) : answer;
  }
  return { aws, calls };
}

function launcher(aws) {
  return ecsLauncher({
    cluster: 'woodshed-cloud', taskDefinition: 'woodshed-cloud-session', subnets: ['subnet-a', 'subnet-b'],
    securityGroup: 'sg-sessions', logGroup: '/woodshed-cloud/sessions', aws, sleep: async () => {},
  });
}

test('sessionOverrides passes only per-session keys, so secrets never ride in a run', () => {
  const env = { SESSION_ID: 's', SESSION_TOKEN: 't', GH_TOKEN: 'secret', ANTHROPIC_API_KEY: 'secret', ISSUE: '7', PGHOST: 'db' };
  assert.deepEqual(sessionOverrides(env).map((o) => o.name), ['SESSION_ID', 'SESSION_TOKEN', 'ISSUE']);
});

test('a private session\'s run says what it is and how claude runs, and never carries its owner\'s token', () => {
  const env = { SESSION_ID: 's', SESSION_KIND: 'private', MODEL: 'opus', EFFORT: 'high', PERMISSION_MODE: 'plan', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-secret' };
  assert.deepEqual(sessionOverrides(env).map((o) => o.name), ['SESSION_ID', 'SESSION_KIND', 'MODEL', 'EFFORT', 'PERMISSION_MODE']);
});

test('a review-only session\'s flag reaches the task, or its entrypoint dies on a branch with nothing to work on', () => {
  const names = sessionOverrides({ SESSION_ID: 's', BRANCH: 'a/b', REVIEW_ONLY: '1' }).map((o) => o.name);
  assert.ok(names.includes('REVIEW_ONLY'));
});

test('a question from Slack reaches the task as one, or its entrypoint starts a coding session and dies asking for databases', () => {
  const names = sessionOverrides({ SESSION_ID: 's', SESSION_MODE: 'ask', ASKED_BY: 'Ana Lima', PROMPT: 'why?' }).map((o) => o.name);
  assert.deepEqual(names, ['SESSION_ID', 'PROMPT', 'SESSION_MODE', 'ASKED_BY']);
});

test('every variable the fleet sets for each kind of session reaches an ECS task', async () => {
  const { createFleet } = await import('../../console/fleet.mjs');
  const started = [];
  const launcher = {
    kind: 'fake',
    refFor: (id) => `c-${id}`,
    async start(id, env) { started.push(env); return { ref: `c-${id}`, host: '127.0.0.1', termPort: 1, statusPort: 2 }; },
    async taskState() { return { alive: true }; },
    async logTail() { return ''; },
    async stop() {},
  };
  const config = {
    projects: [{ name: 'r', repo: 'o/r', default: true }, { name: 'tools', repo: 'o/tools', default: false }], label: 'woodshed', publicUrl: 'https://console.test', maxRunning: 5,
    limits: { idleMs: 3_600_000, lifetimeMs: 3_600_000, startTimeoutMs: 900_000 },
    sessionEnv: {}, ghToken: null, pollMs: 30_000, fallbackPollMs: 300_000, maxPrivatePerPerson: 3,
  };
  const databases = { available: true, async createForSession() {}, async sweep() {} };
  const fleet = createFleet({ config, store: { state: { sessions: [], github: null }, save() {} }, launcher, github: {}, databases, statusd: async () => ({}) });
  await fleet.createSession({ kind: 'ask', number: null, title: 'q', startedBy: 'slack:U1', trigger: 'slack', prompt: 'why?', slack: { channel: 'C1', threadTs: '1.1', user: 'U1', name: 'Ana' } });
  await fleet.createSession({ kind: 'issue', number: 7, title: 'i', startedBy: 'joel', trigger: 'label', prompt: 'p', options: { model: 'opus', effort: 'high', permissionMode: 'plan' } });
  await fleet.createSession({ kind: 'pr', number: 8, title: 'r', startedBy: 'joel', trigger: 'console', branch: 'a/b', reviewOnly: true });
  await fleet.createSession({ kind: 'task', number: null, title: 't', startedBy: 'joel', trigger: 'my-woodshed', prompt: 'p', owner: 'joel', attach: async () => 2 });
  await fleet.createSession({ kind: 'task', number: null, title: 'c', startedBy: 'joel', trigger: 'my-woodshed', prompt: 'p', owner: 'joel', options: { agent: 'codex', model: 'gpt-5.5', effort: 'high', permissionMode: 'auto' } });
  await fleet.createSession({ kind: 'task', number: null, title: 'o', startedBy: 'joel', trigger: 'my-woodshed', prompt: 'p', owner: 'joel', project: config.projects[1] });
  assert.equal(started.length, 6);
  const set = new Set(started.flatMap((env) => Object.keys(env)));
  for (const name of ['SESSION_MODE', 'ASKED_BY', 'ISSUE', 'PR', 'MODEL', 'REVIEW_ONLY', 'SESSION_KIND', 'ATTACHMENTS', 'AGENT', 'PROJECT_REPO']) {
    assert.ok(set.has(name), `the sessions above set ${name}`);
  }
  for (const env of started) {
    const passed = new Set(sessionOverrides(env).map((o) => o.name));
    assert.deepEqual(Object.keys(env).filter((k) => !passed.has(k)), [], `${env.SESSION_MODE ?? 'issue'} session`);
  }
});

test('sessionOverrides cuts a long prompt to fit the ECS overrides limit', () => {
  const [prompt] = sessionOverrides({ PROMPT: 'x'.repeat(20_000) });
  assert.ok(prompt.value.length < 6200);
  assert.match(prompt.value, /Cut short/);
});

test('cliError gives AWS reason without the command line, which carries the session tokens', () => {
  const args = ['ecs', 'run-task', '--overrides', '{"containerOverrides":[{"environment":[{"name":"SESSION_TOKEN","value":"tok-123"}]}]}'];
  const err = Object.assign(new Error(`Command failed: aws ${args.join(' ')}\naws: [ERROR]: An error occurred (AccessDeniedException) when calling the RunTask operation: not authorized`), {
    stderr: '\naws: [ERROR]: An error occurred (AccessDeniedException) when calling the RunTask operation: not authorized\n',
  });
  const out = cliError(args, err);
  assert.equal(out.message, 'aws ecs run-task failed: An error occurred (AccessDeniedException) when calling the RunTask operation: not authorized');
  assert.doesNotMatch(out.message, /tok-123/);
  assert.match(out.stderr, /AccessDeniedException/);
});

test('cliError keeps the cause when aws itself could not run', () => {
  const err = Object.assign(new Error('spawn aws ENOENT'), { code: 'ENOENT', stderr: '' });
  assert.equal(cliError(['ecs', 'describe-tasks'], err).message, 'aws ecs describe-tasks failed: could not run the aws CLI (ENOENT)');
});

test('cliError says when aws was stopped for taking too long', () => {
  const err = Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', code: null, stderr: '' });
  assert.equal(cliError(['sqs', 'receive-message'], err).message, 'aws sqs receive-message failed: no answer within 60 s');
});

test('taskPrivateIp reads the address from the network interface', () => {
  assert.equal(taskPrivateIp(runningTask()), '10.42.1.57');
  assert.equal(taskPrivateIp(runningTask({ ip: null })), null);
  assert.equal(taskPrivateIp(null), null);
});

test('start runs the task with the session id and waits for its address', async () => {
  let describes = 0;
  const { aws, calls } = fakeAws({
    'ecs run-task': { tasks: [{ taskArn: ARN }] },
    'ecs describe-tasks': () => ({ tasks: [runningTask({ ip: ++describes > 1 ? '10.42.1.57' : null })] }),
  });
  const started = await launcher(aws).start('0a1b2c3d', { SESSION_ID: '0a1b2c3d', GH_TOKEN: 'secret' });

  assert.deepEqual(started, { ref: ARN, host: '10.42.1.57', termPort: 7681, statusPort: 7682, shellPort: 7684 });
  const run = calls[0];
  assert.equal(run[run.indexOf('--started-by') + 1], '0a1b2c3d');
  assert.doesNotMatch(run.join(' '), /secret/);
  const network = JSON.parse(run[run.indexOf('--network-configuration') + 1]);
  assert.deepEqual(network.awsvpcConfiguration.securityGroups, ['sg-sessions']);
  assert.equal(run[run.indexOf('--propagate-tags') + 1], 'TASK_DEFINITION');
});

test('shared and private sessions run from the one task definition, which holds no database password', async () => {
  const { aws, calls } = fakeAws({
    'ecs run-task': { tasks: [{ taskArn: ARN }] },
    'ecs describe-tasks': { tasks: [runningTask()] },
  });
  const launcher = ecsLauncher({
    cluster: 'woodshed-cloud', taskDefinition: 'woodshed-cloud-session',
    subnets: ['subnet-a'], securityGroup: 'sg-sessions', logGroup: '/woodshed-cloud/sessions', aws, sleep: async () => {},
  });
  await launcher.start('0a1b2c3d', { SESSION_ID: '0a1b2c3d', SESSION_KIND: 'private' });
  await launcher.start('1a1b2c3d', { SESSION_ID: '1a1b2c3d' });
  const definitions = calls.filter((c) => c[1] === 'run-task').map((c) => c[c.indexOf('--task-definition') + 1]);
  assert.deepEqual(definitions, ['woodshed-cloud-session', 'woodshed-cloud-session']);
});

test('start reports why a task stopped before it had an address', async () => {
  const { aws } = fakeAws({
    'ecs run-task': { tasks: [{ taskArn: ARN }] },
    'ecs describe-tasks': { tasks: [{ ...runningTask({ ip: null }), lastStatus: 'STOPPED', stoppedReason: 'CannotPullContainerError' }] },
  });
  await assert.rejects(launcher(aws).start('0a1b2c3d', {}), /CannotPullContainerError/);
});

test('start stops the task when an AWS call fails while it waits for the address', async () => {
  const { aws, calls } = fakeAws({
    'ecs run-task': { tasks: [{ taskArn: ARN }] },
    'ecs describe-tasks': new Error('ThrottlingException: Rate exceeded'),
    'ecs stop-task': {},
  });
  await assert.rejects(launcher(aws).start('0a1b2c3d', {}), /ThrottlingException/);
  const stop = calls.find((c) => `${c[0]} ${c[1]}` === 'ecs stop-task');
  assert.ok(stop, 'the task must be stopped, or it keeps billing with nothing tracking it');
  assert.equal(stop[stop.indexOf('--task') + 1], ARN);
});

test('start fails clearly when run-task starts nothing', async () => {
  const { aws } = fakeAws({ 'ecs run-task': { tasks: [], failures: [{ reason: 'RESOURCE:MEMORY' }] } });
  await assert.rejects(launcher(aws).start('0a1b2c3d', {}), /RESOURCE:MEMORY/);
});

test('isAlive is false for a stopped or missing task', async () => {
  const states = [{ tasks: [runningTask({ lastStatus: 'RUNNING' })] }, { tasks: [{ lastStatus: 'STOPPED' }] }, { tasks: [], failures: [{ reason: 'MISSING' }] }];
  const { aws } = fakeAws({ 'ecs describe-tasks': () => states.shift() });
  const l = launcher(aws);
  assert.equal(await l.isAlive(ARN), true);
  assert.equal(await l.isAlive(ARN), false);
  assert.equal(await l.isAlive(ARN), false);
});

test('taskState gives when ECS began the pull, once it has', async () => {
  const states = [{ tasks: [runningTask({ lastStatus: 'PENDING' })] }, { tasks: [{ ...runningTask({ lastStatus: 'PENDING' }), pullStartedAt: '2026-10-27T12:23:55.137000+00:00' }] }];
  const { aws } = fakeAws({ 'ecs describe-tasks': () => states.shift() });
  const l = launcher(aws);
  assert.deepEqual(await l.taskState(ARN), { alive: true, pullStartedAt: null });
  assert.deepEqual(await l.taskState(ARN), { alive: true, pullStartedAt: '2026-10-27T12:23:55.137Z' });
});

test('taskStates reads many tasks in one describe per 100, and a task ECS forgot is not alive', async () => {
  const arns = Array.from({ length: 101 }, (_, i) => `${ARN}-${i}`);
  const { aws, calls } = fakeAws({
    'ecs describe-tasks': (args) => ({ tasks: args.slice(5).filter((arn) => !arn.endsWith('-7')).map((arn) => ({ ...runningTask({ lastStatus: 'RUNNING' }), taskArn: arn })) }),
  });
  const states = await launcher(aws).taskStates(arns);
  assert.deepEqual(calls.map((c) => c.length - 5), [100, 1], 'one call for the first 100, one for the rest');
  assert.equal(states.size, 101);
  assert.deepEqual(states.get(`${ARN}-0`), { alive: true, pullStartedAt: null });
  assert.deepEqual(states.get(`${ARN}-7`), { alive: false, pullStartedAt: null });
});

test('logTail ends with the stop reason, which explains a task that never ran', async () => {
  const { aws, calls } = fakeAws({
    'ecs describe-tasks': { tasks: [{ lastStatus: 'STOPPED', stoppedReason: 'ResourceInitializationError: unable to pull secrets' }] },
    'logs get-log-events': { events: [{ message: '[woodshed] Env files written\n' }] },
  });
  const tail = await launcher(aws).logTail(ARN);
  assert.equal(tail.split('\n').pop(), 'ResourceInitializationError: unable to pull secrets');
  const logs = calls.find((c) => c[0] === 'logs');
  assert.equal(logs[logs.indexOf('--log-stream-name') + 1], 'session/session/abc123');
});

// A session that exited on its own logged why; the console shows the tail's last line as the failure.
test('logTail ends with the session\'s own last line when its container exited, not ECS\'s exit notice', async () => {
  const error = 'ERROR: .woodshed/project.yaml: has consoleLinks, which is not a field';
  const { aws } = fakeAws({
    'ecs describe-tasks': { tasks: [{ lastStatus: 'STOPPED', stoppedReason: 'Essential container in task exited' }] },
    'logs get-log-events': { events: [{ message: 'Project repo cloned\n' }, { message: `${error}\n` }] },
  });
  assert.equal((await launcher(aws).logTail(ARN)).split('\n').pop(), error);

  const { aws: silent } = fakeAws({
    'ecs describe-tasks': { tasks: [{ lastStatus: 'STOPPED', stoppedReason: 'Essential container in task exited' }] },
    'logs get-log-events': { events: [] },
  });
  assert.equal(await launcher(silent).logTail(ARN), 'Essential container in task exited');
});

test('stop by session id finds the task a lost start left running', async () => {
  const { aws, calls } = fakeAws({ 'ecs list-tasks': { taskArns: [ARN] }, 'ecs stop-task': {} });
  const l = launcher(aws);
  await l.stop(l.refFor('0a1b2c3d'));
  assert.deepEqual(calls.map((c) => `${c[0]} ${c[1]}`), ['ecs list-tasks', 'ecs stop-task']);
  assert.equal(calls[0][calls[0].indexOf('--started-by') + 1], '0a1b2c3d');
});

test('find gives the task a lost start began, by its session id, once it has an address', async () => {
  let ip = null;
  const { aws, calls } = fakeAws({ 'ecs list-tasks': { taskArns: [ARN] }, 'ecs describe-tasks': () => ({ tasks: [runningTask({ ip })] }) });
  const l = launcher(aws);
  assert.equal(await l.find('0a1b2c3d'), null, 'no address yet');
  ip = '10.42.1.16';
  assert.deepEqual(await l.find('0a1b2c3d'), { ref: ARN, host: '10.42.1.16', termPort: 7681, statusPort: 7682, shellPort: 7684 });
  assert.equal(calls[0][calls[0].indexOf('--started-by') + 1], '0a1b2c3d');

  const none = launcher(fakeAws({ 'ecs list-tasks': { taskArns: [] } }).aws);
  assert.equal(await none.find('0a1b2c3d'), null, 'no task at all');
});

test('stop treats a task ECS has already removed as stopped, and still throws on other errors', async () => {
  const gone = Object.assign(new Error('Command failed'), {
    stderr: 'An error occurred (InvalidParameterException) when calling the StopTask operation: The referenced task was not found.',
  });
  await launcher(fakeAws({ 'ecs stop-task': gone }).aws).stop(ARN);

  const throttled = Object.assign(new Error('Command failed'), { stderr: 'An error occurred (ThrottlingException): Rate exceeded' });
  await assert.rejects(launcher(fakeAws({ 'ecs stop-task': throttled }).aws).stop(ARN), /Command failed/);
});

test('no more than MAX_CLI_PROCESSES aws processes run at once, and a failed one frees its slot', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-aws-'));
  // Each copy leaves a file while it runs, records how many it saw, then answers like the CLI.
  await fs.writeFile(path.join(dir, 'aws'), `#!/bin/bash
touch "${dir}/running.$$"
ls "${dir}" | grep -c '^running\\.' >> "${dir}/seen"
sleep 0.2
rm "${dir}/running.$$"
[ "$1" = fail ] && { echo 'An error occurred (Boom)' >&2; exit 254; }
echo '{"ok": true}'
`, { mode: 0o755 });
  const path0 = process.env.PATH;
  process.env.PATH = `${dir}:${path0}`;
  t.after(async () => { process.env.PATH = path0; await fs.rm(dir, { recursive: true, force: true }); });

  const calls = Array.from({ length: 7 }, (_, i) => awsCli([i === 0 ? 'fail' : 'ok']));
  const results = await Promise.allSettled(calls);
  assert.equal(results[0].status, 'rejected');
  assert.deepEqual(results.slice(1).map((r) => r.value), Array(6).fill({ ok: true }));
  const seen = (await fs.readFile(path.join(dir, 'seen'), 'utf8')).trim().split('\n').map(Number);
  assert.equal(seen.length, 7);
  assert.ok(Math.max(...seen) <= MAX_CLI_PROCESSES, `at most ${MAX_CLI_PROCESSES} at once, saw ${Math.max(...seen)}`);
  assert.equal(Math.max(...seen), MAX_CLI_PROCESSES);

  // A slot the failed call kept would leave one fewer for this batch.
  await fs.rm(path.join(dir, 'seen'));
  await Promise.all(Array.from({ length: MAX_CLI_PROCESSES }, () => awsCli(['ok'])));
  const again = (await fs.readFile(path.join(dir, 'seen'), 'utf8')).trim().split('\n').map(Number);
  assert.equal(Math.max(...again), MAX_CLI_PROCESSES);
});
