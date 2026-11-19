import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWebhookUrl } from './webhookUrl.mjs';

test('the function URL is read once, at its /github path, and a failed read is tried again', async () => {
  let calls = 0;
  let fail = true;
  async function aws(args) {
    calls++;
    assert.deepEqual(args, ['lambda', 'get-function-url-config', '--function-name', 'hooks']);
    if (fail) throw new Error('AccessDenied');
    return { FunctionUrl: 'https://abc.lambda-url.us-east-1.on.aws/' };
  }
  const webhookUrl = createWebhookUrl({ functionName: 'hooks', aws });
  await assert.rejects(webhookUrl(), /AccessDenied/);
  fail = false;
  assert.equal(await webhookUrl(), 'https://abc.lambda-url.us-east-1.on.aws/github');
  assert.equal(await webhookUrl(), 'https://abc.lambda-url.us-east-1.on.aws/github');
  assert.equal(calls, 2);
});

test('Slack\'s events Request URL is the same function URL, at its /slack path', async () => {
  const slackEventsUrl = createWebhookUrl({ functionName: 'hooks', aws: async () => ({ FunctionUrl: 'https://abc.lambda-url.us-east-1.on.aws/' }), path: '/slack' });
  assert.equal(await slackEventsUrl(), 'https://abc.lambda-url.us-east-1.on.aws/slack');
});
