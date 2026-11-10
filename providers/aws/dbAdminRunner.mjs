// The AWS provider's db-admin runs: each is a one-off Fargate task of the db-admin task definition, running
// session/dbAdmin.mjs with the command the console picked (console/databases.mjs).

const CONTAINER = 'db-admin';

/**
 * @param {object|null} task  one entry of `aws ecs describe-tasks`, or null once ECS has forgotten it
 * @returns {{done: false}|{done: true, ok: boolean, reason: string|null}}
 */
export function taskOutcome(task) {
  if (!task) return { done: true, ok: false, reason: 'the task is gone, and its outcome with it' };
  const container = task.containers?.find((c) => c.name === CONTAINER);
  const code = container?.exitCode;
  // Fargate takes another 20 to 30 seconds to call the task STOPPED once its one container has exited.
  const exited = container?.lastStatus === 'STOPPED' && typeof code === 'number';
  if (task.lastStatus !== 'STOPPED' && !exited) return { done: false };
  if (code === 0) return { done: true, ok: true, reason: null };
  return { done: true, ok: false, reason: code === undefined || code === null ? (task.stoppedReason ?? 'the task never ran') : `the task exited with ${code}` };
}

/**
 * @param {{ecs: {cluster: string, dbAdminTaskDefinition?: string|null, subnets: string[], securityGroup: string},
 *          aws: (args: string[]) => Promise<any>}} opts
 * @returns {{start: (command: string[]) => Promise<string>, stop: (id: string) => Promise<void>,
 *            outcomes: (ids: string[]) => Promise<Array<{done: false}|{done: true, ok: boolean, reason: string|null}>>}}
 *   `start` resolves to the run's id (the task's ARN), and `outcomes` gives each id's outcome in the order asked
 */
export function createDbAdminRunner({ ecs, aws }) {
  async function start(command) {
    const network = { awsvpcConfiguration: { subnets: ecs.subnets, securityGroups: [ecs.securityGroup], assignPublicIp: 'ENABLED' } };
    const out = await aws([
      'ecs', 'run-task', '--cluster', ecs.cluster, '--task-definition', ecs.dbAdminTaskDefinition, '--launch-type', 'FARGATE',
      '--started-by', `db-admin-${command[1]}`.slice(0, 36), '--network-configuration', JSON.stringify(network),
      '--overrides', JSON.stringify({ containerOverrides: [{ name: CONTAINER, command }] }), '--propagate-tags', 'TASK_DEFINITION',
    ]);
    const taskArn = out?.tasks?.[0]?.taskArn;
    if (!taskArn) throw new Error(`run-task started nothing: ${out?.failures?.[0]?.reason ?? 'no reason given'}`);
    return taskArn;
  }

  async function stop(taskArn) {
    await aws(['ecs', 'stop-task', '--cluster', ecs.cluster, '--task', taskArn, '--reason', 'replaced by a newer db-admin task']);
  }

  async function outcomes(taskArns) {
    const out = await aws(['ecs', 'describe-tasks', '--cluster', ecs.cluster, '--tasks', ...taskArns]);
    return taskArns.map((arn) => taskOutcome(out?.tasks?.find((t) => t.taskArn === arn) ?? null));
  }

  return { start, stop, outcomes };
}
