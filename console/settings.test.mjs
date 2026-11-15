import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

import { checkValue, secretSpecs } from './secrets.mjs';
// The real Secrets Manager store over a fake AWS CLI: what the Secrets tab does end to end.
import { createSecretStore } from '../providers/aws/secretStore.mjs';
import { createWebhookUrl } from '../providers/aws/webhookUrl.mjs';
import { createSettings } from './settings.mjs';

const ENV_FILES = [{ secret: 'api-env', path: 'api/.env' }, { secret: 'web-env', path: 'web/.env.local' }];
const INSTALL_SECRETS = [{ secret: 'registry-token', variable: 'REGISTRY_TOKEN' }];
const SPECS = secretSpecs({ envFiles: ENV_FILES, installSecrets: INSTALL_SECRETS });
const findSecret = (name) => SPECS.find((s) => s.name === name);

const PEM = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
const LAMBDA_URL = 'https://abc.lambda-url.us-east-1.on.aws/';

test('checkValue trims one-line values, keeps .env files whole and refuses anything else', () => {
  assert.equal(checkValue(findSecret('anthropic-api-key'), '  sk-ant-x\n'), 'sk-ant-x');
  assert.throws(() => checkValue(findSecret('anthropic-api-key'), 'two words'), /one line/);
  assert.throws(() => checkValue(findSecret('registry-token'), '   '), /empty/);
  assert.equal(checkValue(findSecret('api-env'), 'A=1\r\nB=2\n'), 'A=1\nB=2\n');
  assert.throws(() => checkValue(findSecret('api-env'), 'x'.repeat(70_000)), /64 KB/);
  assert.throws(() => checkValue(findSecret('github-app-key'), 'not a key'), /not a PEM private key/);
  assert.ok(checkValue(findSecret('github-app-key'), PEM).startsWith('-----BEGIN RSA PRIVATE KEY-----'));
});

// A Secrets Manager kept in memory, behind the same CLI calls the console makes.
function fakeAws(values = {}) {
  const calls = [];
  const changed = {};
  const written = [];
  async function aws(args) {
    const id = args[args.indexOf('--secret-id') + 1];
    calls.push([args[1], id]);
    if (args[1] === 'get-function-url-config') return { FunctionUrl: LAMBDA_URL };
    // A secret with no value yet has no version stages at all, as the real CLI prints it.
    if (args[1] === 'list-secrets') {
      assert.deepEqual(args.slice(2), ['--filters', 'Key=name,Values=woodshed-cloud/']);
      return {
        SecretList: Object.keys(values).map((name) => ({
          Name: name, Description: `about ${name}`, LastChangedDate: changed[name] ?? '2026-10-20T10:00:00Z',
          SecretVersionsToStages: values[name] === null ? null : { v1: ['AWSCURRENT'] },
        })),
      };
    }
    if (!(id in values)) throw Object.assign(new Error('aws secretsmanager failed'), { stderr: 'An error occurred (ResourceNotFoundException)' });
    if (args[1] === 'get-secret-value') return { SecretString: values[id] };
    if (args[1] === 'put-secret-value') {
      // Read the way the CLI reads it: the file the argument names, which only this user may open.
      const url = args[args.indexOf('--secret-string') + 1];
      assert.match(url, /^file:\/\/\//, 'a value never goes in the arguments');
      const file = url.slice('file://'.length);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      values[id] = fs.readFileSync(file, 'utf8');
      written.push(file);
      changed[id] = '2026-10-22T10:00:00Z';
    }
    return null;
  }
  return { aws, calls, values, written };
}

function setup({ values, keyRefused = false, githubFails = false, githubOff = false } = {}) {
  const store = fakeAws({
    'woodshed-cloud/anthropic-api-key': 'sk-ant-old',
    'woodshed-cloud/api-env': 'A=1\n',
    'woodshed-cloud/web-env': null,
    'woodshed-cloud/registry-token': 'npm_x',
    'woodshed-cloud/github-app-key': PEM,
    'woodshed-cloud/github-webhook-secret': null,
    ...values,
  });
  const hookCalls = [];
  let key = PEM;
  const appApi = {
    async hookConfig() { return githubOff ? { active: false, url: '', contentType: '', insecureSsl: '' } : { active: true, url: '', contentType: 'json', insecureSsl: '0' }; },
    async app() { return { slug: 'woodshed-cloud', events: ['issues'] }; },
    async deliveries() { return [{ guid: 'g-1', statusCode: 202 }]; },
    async setHookConfig(fields) {
      if (githubOff) throw Object.assign(new Error('GitHub refused PATCH /app/hook/config: HTTP 404 Not Found'), { status: 404 });
      if (githubFails) throw new Error('GitHub refused PATCH /app/hook/config: HTTP 401 Bad credentials');
      hookCalls.push(fields);
    },
  };
  const settings = createSettings({
    config: { repo: 'o/r', envFiles: ENV_FILES, installSecrets: INSTALL_SECRETS, githubApp: { appId: '1', installationId: '2' } },
    secrets: createSecretStore({ prefix: 'woodshed-cloud/', aws: store.aws, specs: SPECS }),
    appKey: { current: () => key, set: (pem) => { key = pem; } },
    appApi,
    webhookUrl: createWebhookUrl({ functionName: 'woodshed-cloud-webhooks', aws: store.aws }),
    checkKey: async () => { if (keyRefused) throw new Error('GitHub refused an installation token: HTTP 401'); },
  });
  return { settings, store, hookCalls, key: () => key };
}

test('the view lists every secret without a value, and the webhook as GitHub and the Lambda see it', async () => {
  const { settings } = setup();
  const view = await settings.view();
  assert.deepEqual(view.secrets.map((s) => [s.name, s.set, s.readable]), [
    ['anthropic-api-key', true, false], ['openai-api-key', false, false], ['api-env', true, true], ['web-env', false, true], ['registry-token', true, true],
    ['github-app-key', true, false], ['github-webhook-secret', false, true], ['github-app-client-secret', false, false],
    ['github-reviewer-app-key', false, false], ['slack-bot-token', false, false], ['slack-signing-secret', false, false],
  ]);
  assert.ok(!JSON.stringify(view).includes('sk-ant-old'));
  assert.equal(view.webhook.expectedUrl, 'https://abc.lambda-url.us-east-1.on.aws/github');
  assert.deepEqual(view.webhook.github.events, ['issues']);
});

test('a page load is one CLI call for the secrets, and the Lambda URL is read only once', async () => {
  const { settings, store } = setup();
  await settings.view();
  await settings.view();
  assert.deepEqual(store.calls.map(([call]) => call).sort(), ['get-function-url-config', 'list-secrets', 'list-secrets']);
});

test('GitHub\'s deliveries are read only once there is an App key', async () => {
  const { settings } = setup();
  assert.deepEqual(await settings.deliveries(), [{ guid: 'g-1', statusCode: 202 }]);
  const none = createSettings({
    config: { repo: 'o/r', envFiles: ENV_FILES, installSecrets: INSTALL_SECRETS, githubApp: { appId: '1', installationId: '2' } },
    secrets: createSecretStore({ prefix: 'woodshed-cloud/', aws: async () => null, specs: SPECS }),
    appKey: { current: () => null, set() {} }, appApi: { deliveries: async () => assert.fail('no key, no call') }, webhookUrl: async () => null,
  });
  await assert.rejects(none.deliveries(), (err) => err.shown && /App key is not set/.test(err.message));
});

test('setting the webhook while it is switched off in GitHub says to switch it on', async () => {
  const { settings } = setup({ values: { 'woodshed-cloud/github-webhook-secret': 'stored' }, githubOff: true });
  await assert.rejects(settings.applyWebhook(), (err) => err.shown && /switched off: tick Active/.test(err.message));
  const view = await settings.view();
  assert.equal(view.webhook.github.active, false);
});

test('a secret Terraform has not made yet shows as missing', async () => {
  const { settings, store } = setup();
  delete store.values['woodshed-cloud/registry-token'];
  const token = (await settings.view()).secrets.find((s) => s.name === 'registry-token');
  assert.deepEqual([token.exists, token.set, token.changedAt], [false, false, null]);
});

test('a session secret can be shown; the Anthropic key and the App key cannot', async () => {
  const { settings, store } = setup();
  store.values['woodshed-cloud/registry-token'] = 'npm-x';
  assert.equal(await settings.reveal('registry-token'), 'npm-x');
  await assert.rejects(settings.reveal('anthropic-api-key'), (err) => err.shown && /write-only/.test(err.message));
  await assert.rejects(settings.reveal('github-app-key'), (err) => err.shown && /write-only/.test(err.message));
  await assert.rejects(settings.reveal('web-env'), /no value yet/);
  await assert.rejects(settings.reveal('../other'), /no secret called/);
});

test('a new App key is kept only after GitHub accepts it, and is used at once', async () => {
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const refused = setup({ keyRefused: true });
  await assert.rejects(refused.settings.replace('github-app-key', other), /old one is kept/);
  assert.equal(refused.store.values['woodshed-cloud/github-app-key'], PEM);
  assert.equal(refused.key(), PEM);

  const accepted = setup();
  await accepted.settings.replace('github-app-key', other);
  assert.equal(accepted.store.values['woodshed-cloud/github-app-key'], other.trim());
  assert.equal(accepted.key(), other.trim());
});

test('rotating the webhook secret stores it, then sets it on the GitHub App with the Lambda URL', async () => {
  const { settings, store, hookCalls } = setup();
  await settings.rotateWebhookSecret();
  const secret = store.values['woodshed-cloud/github-webhook-secret'];
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.deepEqual(hookCalls, [{ url: 'https://abc.lambda-url.us-east-1.on.aws/github', secret }]);
  await assert.rejects(settings.replace('github-webhook-secret', 'mine'), /rotate/);
});

test('a value reaches the CLI in a file only the console can read, gone once the CLI is done', async () => {
  const { settings, store } = setup();
  await settings.replace('anthropic-api-key', 'sk-ant-new');
  assert.equal(store.values['woodshed-cloud/anthropic-api-key'], 'sk-ant-new');
  assert.equal(store.written.length, 1);
  assert.equal(fs.existsSync(store.written[0]), false);
});

test('when GitHub refuses the new webhook secret, the page says it is saved and to set it again', async () => {
  const { settings, store } = setup({ githubFails: true });
  await assert.rejects(settings.rotateWebhookSecret(), (err) => err.shown && /saved, but GitHub refused it/.test(err.message));
  assert.match(store.values['woodshed-cloud/github-webhook-secret'], /^[0-9a-f]{64}$/);
});

test('a payload URL must be https', async () => {
  const { settings, hookCalls } = setup();
  await assert.rejects(settings.setWebhookUrl('http://example.com/github'), /https/);
  await assert.rejects(settings.setWebhookUrl('nope'), /not a URL/);
  await settings.setWebhookUrl('https://example.com/github');
  assert.deepEqual(hookCalls, [{ url: 'https://example.com/github' }]);
});

test('a person\'s secret is created on its first save, and deleted at once, with no value on a command line', async () => {
  const calls = [];
  const existing = new Set();
  const aws = async (args) => {
    calls.push(args.slice(0, 2).join(' '));
    const id = args[args.indexOf(args.includes('--name') ? '--name' : '--secret-id') + 1];
    const file = args[args.indexOf('--secret-string') + 1];
    if (args.includes('--secret-string')) assert.match(file, /^file:\/\//, 'the value goes through a file');
    if (args[1] === 'put-secret-value' && !existing.has(id)) throw Object.assign(new Error('failed'), { stderr: 'ResourceNotFoundException' });
    if (args[1] === 'create-secret') existing.add(id);
    if (args[1] === 'delete-secret') {
      assert.ok(args.includes('--force-delete-without-recovery'));
      if (!existing.delete(id)) throw Object.assign(new Error('failed'), { stderr: 'ResourceNotFoundException' });
    }
    return {};
  };
  const secrets = createSecretStore({ prefix: 'woodshed-cloud/', aws, specs: SPECS });
  await secrets.save('users/joel/claude-token', 'sk-ant-1', 'Joel’s');
  await secrets.save('users/joel/claude-token', 'sk-ant-2', 'Joel’s');
  await secrets.remove('users/joel/claude-token');
  await secrets.remove('users/joel/claude-token');
  assert.deepEqual(calls, [
    'secretsmanager put-secret-value', 'secretsmanager create-secret', 'secretsmanager put-secret-value',
    'secretsmanager delete-secret', 'secretsmanager delete-secret',
  ]);
  assert.ok(!calls.join(' ').includes('sk-ant'));
});

test('a secret the console makes is named and tagged after the installation\'s prefix, as Terraform tags its own', async () => {
  const created = [];
  const aws = async (args) => {
    if (args[1] === 'put-secret-value') throw Object.assign(new Error('failed'), { stderr: 'ResourceNotFoundException' });
    if (args[1] === 'create-secret') created.push(args);
    return {};
  };
  await createSecretStore({ prefix: 'woodshed/', aws, specs: SPECS }).save('users/joel/claude-token', 'sk-ant-1', 'Joel’s');
  const [args] = created;
  assert.equal(args[args.indexOf('--name') + 1], 'woodshed/users/joel/claude-token');
  assert.equal(args[args.indexOf('--tags') + 1], 'Key=project,Value=woodshed');
});

test('the Secrets page lists one secret for each env file and each install secret the installation names, and none without', () => {
  const names = (opts) => secretSpecs(opts).map((s) => s.name);
  assert.deepEqual(names({ envFiles: [{ secret: 'app-env' }], installSecrets: INSTALL_SECRETS }).slice(0, 4),
    ['anthropic-api-key', 'openai-api-key', 'app-env', 'registry-token']);
  assert.ok(!names({ envFiles: [] }).includes('api-env'));
  assert.ok(!names({ envFiles: [] }).includes('registry-token'), 'no install secret the installation does not name');
  const specs = secretSpecs({ envFiles: [{ secret: 'app-env' }], installSecrets: INSTALL_SECRETS });
  assert.equal(specs.find((s) => s.name === 'app-env').kind, 'env');
  assert.deepEqual(specs.find((s) => s.name === 'registry-token'), { name: 'registry-token', group: 'session', kind: 'line', readable: true });
});
