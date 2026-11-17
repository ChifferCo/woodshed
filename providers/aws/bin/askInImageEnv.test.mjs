import { test } from 'node:test';
import assert from 'node:assert/strict';

import { leakPattern, taskDefinitionEnv, taskDefinitionSecrets } from './askInImageEnv.mjs';

// A repo with two env files' secrets, and an installation with a registry token: the image gets those, and the leak
// check looks for them.
const PROJECT = {
  envFiles: [{ path: 'api/.env', secret: 'api-env' }, { path: 'web/.env', secret: 'web-env' }, { path: 'x.env', secret: null }],
  dependencies: { installs: [] },
};
const INSTALL_SECRETS = [{ secret: 'registry-token', variable: 'REGISTRY_TOKEN' }];

test('the task definition\'s secrets are the project\'s env files and the install secrets, by the variable each arrives in', () => {
  assert.deepEqual(taskDefinitionSecrets({ project: PROJECT, installSecrets: INSTALL_SECRETS }), ['API_ENV', 'WEB_ENV', 'REGISTRY_TOKEN']);
  const env = taskDefinitionEnv({ project: PROJECT, installSecrets: INSTALL_SECRETS, port: 7697 });
  assert.equal(env.API_ENV, 'ASK_IN_IMAGE=must-be-unset');
  assert.equal(env.REGISTRY_TOKEN, 'ASK_IN_IMAGE=must-be-unset');
  assert.equal(env.WOODSHED_INSTALL_SECRETS, 'REGISTRY_TOKEN', 'the variables runAsk unsets');
  assert.equal(env.WOODSHED_CONSOLE_URL, 'http://host.docker.internal:7697');
  assert.ok(!('WOODSHED_SERVICES' in env) && !('PGHOST' in env), 'an ask reads no database or shared service');
  assert.ok(!('OTHER_ENV' in env), 'no env file the project does not list');
  assert.deepEqual(taskDefinitionSecrets({ project: { envFiles: [] } }), [], 'no install secrets without the setting');
  assert.ok(!('WOODSHED_INSTALL_SECRETS' in taskDefinitionEnv({ project: PROJECT, port: 7697 })));
});

test('the leak check matches a tmux line that still holds any of them, and nothing else', () => {
  const leak = new RegExp(leakPattern({ project: PROJECT, installSecrets: INSTALL_SECRETS }));
  for (const line of ['API_ENV=x', 'WEB_ENV=x', 'REGISTRY_TOKEN=x', 'GH_TOKEN=x']) assert.ok(leak.test(line), line);
  assert.ok(!new RegExp(leakPattern({ project: { envFiles: [] } })).test('REGISTRY_TOKEN=x'));
  for (const line of ['OTHER_ENV=x', 'API_ENV_EXTRA=x', 'PATH=/bin', '-API_ENV']) assert.ok(!leak.test(line), line);
});
