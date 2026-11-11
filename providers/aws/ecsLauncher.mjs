// Sessions as Fargate tasks, through the `aws` CLI. The task definition holds
// the image, the shared services' addresses and the shared secrets; a run
// passes only what is per session. It holds no database password: every session
// gets its databases from the console's session API at start. A run includes the session's own statusd and
// ttyd tokens, which anyone who can describe the task can read: they are safe
// only because the sessions' security group admits the base box alone.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Everything else a session needs comes from the task definition.
// Never a person's own secret: anyone who can describe a task reads these. A private session fetches those at start.
const PER_SESSION_ENV = [
  'SESSION_ID', 'SESSION_TOKEN', 'TERMINAL_TOKEN', 'STARTED_BY', 'SESSION_URL', 'ISSUE', 'PR', 'BRANCH', 'PROMPT',
  'SESSION_KIND', 'AGENT', 'MODEL', 'EFFORT', 'PERMISSION_MODE', 'RESUME_SESSION', 'ATTACHMENTS', 'REVIEW_ONLY', 'SESSION_MODE', 'ASKED_BY', 'PROJECT_REPO',
];
const CONTAINER = 'session';
const IP_WAIT_MS = 90_000;
const IP_POLL_MS = 3_000;
const STARTED_BY_PREFIX = 'started-by:';
const ESSENTIAL_EXITED = 'Essential container in task exited';
const endpointOf = (taskArn, host) => ({ ref: taskArn, host, termPort: 7681, statusPort: 7682, shellPort: 7684 });
// ECS caps a run's overrides at 8192 characters; the prompt, a comment's text, is the only part that can grow.
const MAX_PROMPT_CHARS = 6000;
const TRUNCATED_NOTE = '\n\n[Cut short to fit the task. Read the whole comment on the issue or PR.]';

/**
 * execFile's own message starts with the whole command line, which holds the session's tokens in
 * `--overrides` and pushes AWS's reason past the first line the fleet keeps.
 * @param {string[]} args
 * @param {Error & {stderr?: string}} err
 * @returns {Error & {stderr: string}}  `aws <service> <action> failed: <AWS's message>`, stderr kept for callers
 */
export function cliError(args, err) {
  const stderr = String(err.stderr ?? '').trim();
  // An empty stderr means aws never ran (ENOENT and the like); the code says why without the command line.
  const quiet = err.killed ? `no answer within ${CLI_TIMEOUT_MS / 1000} s` : `could not run the aws CLI (${err.code ?? 'no output'})`;
  const reason = stderr.split('\n').filter(Boolean).pop() ?? quiet;
  return Object.assign(new Error(`aws ${args[0]} ${args[1]} failed: ${reason.replace(/^aws: \[ERROR\]: /, '')}`), { stderr });
}

// Every CLI call shares MAX_CLI_PROCESSES slots, so one that hangs must give its slot back. The longest
// call is the webhook queue's 20-second long-poll.
const CLI_TIMEOUT_MS = 60_000;
// The most tasks one `ecs describe-tasks` takes.
const DESCRIBE_LIMIT = 100;

// Whether a task still runs, and when Fargate began pulling its image: the end of the wait for AWS on a starting
// session's checklist. A task ECS no longer knows is not running.
function taskStateOf(task) {
  const alive = Boolean(task) && task.lastStatus !== 'STOPPED' && task.desiredStatus !== 'STOPPED';
  const pullStartedAt = task?.pullStartedAt ? new Date(task.pullStartedAt).toISOString() : null;
  return { alive, pullStartedAt };
}

/** @param {string[]} args */
export async function awsCli(args) {
  await cliSlot();
  try {
    const { stdout } = await execFileAsync('aws', [...args, '--output', 'json'], { maxBuffer: 8 * 1024 * 1024, timeout: CLI_TIMEOUT_MS });
    return stdout.trim() ? JSON.parse(stdout) : null;
  } catch (err) {
    if (err instanceof SyntaxError) throw err;
    throw cliError(args, err);
  } finally {
    releaseCliSlot();
  }
}

// One CLI process peaks at about 75 MB and the console's container has 512 MB: seven at once got the
// console OOM-killed. The webhook long-poll holds one slot for up to 20 seconds, so this leaves two.
export const MAX_CLI_PROCESSES = 3;
let cliRunning = 0;
const cliWaiting = [];

function cliSlot() {
  if (cliRunning < MAX_CLI_PROCESSES) {
    cliRunning += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => cliWaiting.push(resolve));
}

// A waiting call takes the slot over, so the count only drops when nobody is waiting.
function releaseCliSlot() {
  const next = cliWaiting.shift();
  if (next) next();
  else cliRunning -= 1;
}

/**
 * @param {object} task  one entry of `aws ecs describe-tasks`
 * @returns {string|null}  the task's private IP, once its network interface is attached
 */
export function taskPrivateIp(task) {
  const details = task?.attachments?.find((a) => a.type === 'ElasticNetworkInterface')?.details ?? [];
  return details.find((d) => d.name === 'privateIPv4Address')?.value ?? null;
}

/**
 * @param {Record<string, string>} env
 * @returns {{name: string, value: string}[]}  only the per-session keys, the prompt cut to fit
 */
export function sessionOverrides(env) {
  return PER_SESSION_ENV.filter((key) => env[key] !== undefined).map((name) => {
    const value = String(env[name]);
    if (name !== 'PROMPT' || value.length <= MAX_PROMPT_CHARS) return { name, value };
    return { name, value: value.slice(0, MAX_PROMPT_CHARS) + TRUNCATED_NOTE };
  });
}

/**
 * @param {{cluster: string, taskDefinition: string, subnets: string[], securityGroup: string,
 *          logGroup: string, aws?: typeof awsCli, sleep?: (ms: number) => Promise<void>}} opts
 */
export function ecsLauncher({ cluster, taskDefinition, subnets, securityGroup, logGroup, aws = awsCli, sleep }) {
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  async function describe(taskArn) {
    const out = await aws(['ecs', 'describe-tasks', '--cluster', cluster, '--tasks', taskArn]);
    return out?.tasks?.[0] ?? null;
  }

  // ECS forgets a stopped task after about an hour, and stopping it then fails; the fleet expects stop not to throw for a task that is gone.
  async function stopTask(taskArn, reason) {
    try {
      await aws(['ecs', 'stop-task', '--cluster', cluster, '--task', taskArn, '--reason', reason]);
    } catch (err) {
      if (!/task was not found/i.test(`${err?.stderr ?? ''} ${err?.message ?? ''}`)) throw err;
      console.log('launcher: task already gone', { taskArn });
    }
  }

  return {
    kind: 'ecs',

    // A task's ARN is only known once it runs; until then it is found by the session id it was started with.
    refFor(sessionId) {
      return `${STARTED_BY_PREFIX}${sessionId}`;
    },

    async start(sessionId, env) {
      const network = { awsvpcConfiguration: { subnets, securityGroups: [securityGroup], assignPublicIp: 'ENABLED' } };
      const overrides = { containerOverrides: [{ name: CONTAINER, environment: sessionOverrides(env) }] };
      const out = await aws([
        'ecs', 'run-task', '--cluster', cluster, '--task-definition', taskDefinition, '--launch-type', 'FARGATE',
        '--started-by', sessionId, '--network-configuration', JSON.stringify(network), '--overrides', JSON.stringify(overrides),
        // The task definition's `project` tag, so the bill shows a session's Fargate time under Woodshed Cloud.
        '--propagate-tags', 'TASK_DEFINITION',
      ]);
      const taskArn = out?.tasks?.[0]?.taskArn;
      if (!taskArn) throw new Error(`run-task started nothing: ${out?.failures?.[0]?.reason ?? 'no reason given'}`);
      console.log('launcher: task started', { sessionId, taskArn, private: env.SESSION_KIND === 'private' });

      // Once run-task succeeds, any failure here must stop the task: the session is marked failed and nothing else would.
      try {
        for (let waited = 0; waited < IP_WAIT_MS; waited += IP_POLL_MS) {
          const task = await describe(taskArn);
          const host = taskPrivateIp(task);
          if (host) return endpointOf(taskArn, host);
          if (task?.lastStatus === 'STOPPED') throw new Error(`task stopped before it had an address: ${task.stoppedReason ?? 'no reason given'}`);
          await wait(IP_POLL_MS);
        }
        throw new Error('task got no network address in time');
      } catch (err) {
        console.log('launcher: start failed, stopping the task', { sessionId, taskArn, error: err.message });
        await stopTask(taskArn, 'start failed in the Woodshed Cloud console');
        throw err;
      }
    },

    // A start this console lost, e.g. restarted while it waited for the task's address: the task it began, found by
    // the session id it was started with, once it has an address. Null while none runs or it has no address yet.
    async find(sessionId) {
      const taskArn = (await aws(['ecs', 'list-tasks', '--cluster', cluster, '--started-by', sessionId]))?.taskArns?.[0];
      if (!taskArn) return null;
      const host = taskPrivateIp(await describe(taskArn));
      return host ? endpointOf(taskArn, host) : null;
    },

    async isAlive(taskArn) {
      return (await this.taskState(taskArn)).alive;
    },

    async taskState(taskArn) {
      return taskStateOf(await describe(taskArn));
    },

    // taskState for many tasks in one describe per 100, as the fleet's tick asks for each running session's.
    async taskStates(taskArns) {
      const states = new Map();
      for (let i = 0; i < taskArns.length; i += DESCRIBE_LIMIT) {
        const out = await aws(['ecs', 'describe-tasks', '--cluster', cluster, '--tasks', ...taskArns.slice(i, i + DESCRIBE_LIMIT)]);
        for (const task of out?.tasks ?? []) states.set(task.taskArn, taskStateOf(task));
      }
      for (const taskArn of taskArns) if (!states.has(taskArn)) states.set(taskArn, taskStateOf(null));
      return states;
    },

    async logTail(taskArn, lines = 30) {
      const task = await describe(taskArn).catch(() => null);
      const stream = `session/${CONTAINER}/${taskArn.split('/').pop()}`;
      const events = await aws([
        'logs', 'get-log-events', '--log-group-name', logGroup, '--log-stream-name', stream, '--limit', String(lines), '--no-start-from-head',
      ]).catch(() => null);
      const text = (events?.events ?? []).map((e) => e.message.trimEnd()).join('\n');
      // A task that never ran has no logs; its stop reason (a pull or secrets error) is the line that explains it.
      // "Essential container in task exited" only says the session's process ended, so after its log it would hide
      // the line that says why.
      const reason = task?.stoppedReason === ESSENTIAL_EXITED && text ? null : task?.stoppedReason;
      return [text, reason].filter(Boolean).join('\n');
    },

    async stop(ref) {
      if (!ref) return;
      const taskArns = ref.startsWith(STARTED_BY_PREFIX)
        ? ((await aws(['ecs', 'list-tasks', '--cluster', cluster, '--started-by', ref.slice(STARTED_BY_PREFIX.length)]))?.taskArns ?? [])
        : [ref];
      for (const taskArn of taskArns) await stopTask(taskArn, 'stopped by the Woodshed Cloud console');
    },
  };
}
