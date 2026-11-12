import { test } from 'node:test';
import assert from 'node:assert/strict';

import { leakPattern, taskDefinitionEnv, taskDefinitionSecrets } from './askInImageEnv.mjs';

// An installation with a registry token: the image gets it, and the leak check looks for it. A repo's env files are
// not task secrets: the session asks the console for them.
const INSTALL_SECRETS = [{ secret: 'registry-token', variable: 'REGISTRY_TOKEN' }];

test('the task definition\'s secrets are the install secrets, by the variable each arrives in, and no env file\'s', () => {
  assert.deepEqual(taskDefinitionSecrets({ installSecrets: INSTALL_SECRETS }), ['REGISTRY_TOKEN']);
  const env = taskDefinitionEnv({ installSecrets: INSTALL_SECRETS, port: 7697 });
  assert.equal(env.REGISTRY_TOKEN, 'ASK_IN_IMAGE=must-be-unset');
  assert.equal(env.WOODSHED_INSTALL_SECRETS, 'REGISTRY_TOKEN', 'the variables runAsk unsets');
  assert.equal(env.WOODSHED_CONSOLE_URL, 'http://host.docker.internal:7697');
  assert.ok(!('WOODSHED_SERVICES' in env) && !('PGHOST' in env), 'an ask reads no database or shared service');
  assert.ok(!('API_ENV' in env), 'an env file\'s old secret is not in the task definition');
  assert.deepEqual(taskDefinitionSecrets({}), [], 'no install secrets without the setting');
  assert.ok(!('WOODSHED_INSTALL_SECRETS' in taskDefinitionEnv({ port: 7697 })));
});

test('the leak check matches a tmux line that still holds any of them, and nothing else', () => {
  const leak = new RegExp(leakPattern({ installSecrets: INSTALL_SECRETS }));
  for (const line of ['REGISTRY_TOKEN=x', 'GH_TOKEN=x']) assert.ok(leak.test(line), line);
  assert.ok(!new RegExp(leakPattern({})).test('REGISTRY_TOKEN=x'));
  for (const line of ['OTHER_ENV=x', 'REGISTRY_TOKEN_EXTRA=x', 'PATH=/bin', '-GH_TOKEN']) assert.ok(!leak.test(line), line);
});
