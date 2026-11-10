import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDbAdminRunner, taskOutcome } from './dbAdminRunner.mjs';

// What the console does with these runs is in console/databases.test.mjs, over this runner.
const ECS = { cluster: 'woodshed-cloud', dbAdminTaskDefinition: 'woodshed-cloud-db-admin', subnets: ['subnet-1'], securityGroup: 'sg-1' };

test('taskOutcome is done once the container exits, before the task itself is called STOPPED', () => {
  const deprovisioning = (exitCode) => ({ lastStatus: 'DEPROVISIONING', containers: [{ name: 'db-admin', lastStatus: 'STOPPED', exitCode }] });
  assert.deepEqual(taskOutcome(deprovisioning(0)), { done: true, ok: true, reason: null });
  assert.equal(taskOutcome(deprovisioning(1)).reason, 'the task exited with 1');
  assert.deepEqual(taskOutcome({ lastStatus: 'DEPROVISIONING', containers: [{ name: 'db-admin', lastStatus: 'STOPPED' }] }), { done: false },
    'a container stopped with no exit code yet waits for the task\'s own stop reason');
});

test('taskOutcome reads the db-admin container\'s exit code, and a task that never ran from its stop reason', () => {
  assert.deepEqual(taskOutcome({ lastStatus: 'RUNNING' }), { done: false });
  assert.deepEqual(taskOutcome({ lastStatus: 'RUNNING', containers: [{ name: 'db-admin', lastStatus: 'RUNNING' }] }), { done: false });
  assert.deepEqual(taskOutcome({ lastStatus: 'STOPPED', containers: [{ name: 'db-admin', exitCode: 0 }] }), { done: true, ok: true, reason: null });
  assert.equal(taskOutcome({ lastStatus: 'STOPPED', containers: [{ name: 'db-admin', exitCode: 1 }] }).reason, 'the task exited with 1');
  assert.equal(taskOutcome({ lastStatus: 'STOPPED', stoppedReason: 'CannotPullContainerError', containers: [{ name: 'db-admin' }] }).reason, 'CannotPullContainerError');
  assert.equal(taskOutcome(null).ok, false);
});

test('outcomes come back in the order asked, a task ECS has forgotten as failed', async () => {
  const aws = async () => ({ tasks: [{ taskArn: 'b', lastStatus: 'STOPPED', containers: [{ name: 'db-admin', exitCode: 0 }] }] });
  const outcomes = await createDbAdminRunner({ ecs: ECS, aws }).outcomes(['a', 'b']);
  assert.deepEqual(outcomes.map((o) => o.ok), [false, true]);
});

test('a run AWS starts nothing for is refused with its reason', async () => {
  const aws = async () => ({ tasks: [], failures: [{ reason: 'RESOURCE:MEMORY' }] });
  await assert.rejects(createDbAdminRunner({ ecs: ECS, aws }).start(['reset', 'joel']), /RESOURCE:MEMORY/);
});
