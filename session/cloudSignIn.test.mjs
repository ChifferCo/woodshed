import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { awsConfig, envFor, gcpCredentials, refreshTokens, roleSessionName, setup, status, tokenFile } from './cloudSignIn.mjs';
import { parseConnections } from '../shared/oidcConnections.mjs';

const CONNECTIONS = parseConnections([
  { name: 'aws-dev', type: 'aws', roleArn: 'arn:aws:iam::123456789012:role/dev', region: 'us-east-1' },
  { name: 'aws-prod-read', type: 'aws', roleArn: 'arn:aws:iam::210987654321:role/read' },
  { name: 'azure', type: 'azure', clientId: '11111111-2222-3333-4444-555555555555', tenantId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', subscriptionId: '99999999-8888-7777-6666-555555555555' },
  { name: 'gcp', type: 'gcp', provider: 'projects/123/locations/global/workloadIdentityPools/woodshed/providers/console', serviceAccount: 'ws@p.iam.gserviceaccount.com' },
  { name: 'vault', type: 'token', audience: 'vault' },
]);

function tempDirs(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { dir: path.join(root, 'cloud'), home: path.join(root, 'home') };
}

/** A console that signs a JWT-shaped token per connection, `exp` an hour out. */
function consoleFetch({ fail = new Set(), calls = [] } = {}) {
  return async (url, { headers, body }) => {
    const { connection } = JSON.parse(body);
    calls.push({ url, connection, authorization: headers.authorization });
    if (fail.has(connection)) return new Response(JSON.stringify({ error: 'not now' }), { status: fail.get?.(connection) ?? 503 });
    const claims = Buffer.from(JSON.stringify({ sub: 'private:octocat', aud: connection, exp: Math.floor(Date.now() / 1000) + 900 })).toString('base64url');
    return new Response(JSON.stringify({ token: `h.${claims}.s`, expiresAt: new Date(Date.now() + 900_000).toISOString() }), { status: 200 });
  };
}

test('the AWS config gives each connection a profile, the first also the default, with the token file', () => {
  const text = awsConfig(CONNECTIONS, { dir: '/tmp/woodshed-cloud', login: 'octocat', sessionId: 'aaaa1111' });
  assert.match(text, /\[default\]\nrole_arn = arn:aws:iam::123456789012:role\/dev\nweb_identity_token_file = \/tmp\/woodshed-cloud\/aws-dev\.jwt\nrole_session_name = woodshed-octocat-aaaa1111\nregion = us-east-1/);
  assert.match(text, /\[profile aws-prod-read\]\nrole_arn = arn:aws:iam::210987654321:role\/read\nweb_identity_token_file = \/tmp\/woodshed-cloud\/aws-prod-read\.jwt/);
  assert.equal(awsConfig(CONNECTIONS.filter((c) => c.type !== 'aws'), { dir: '/x' }), null);
});

test('a role session name is what AWS allows, at most 64 characters', () => {
  assert.equal(roleSessionName({ login: 'octocat', sessionId: 'aaaa1111' }), 'woodshed-octocat-aaaa1111');
  assert.ok(roleSessionName({ login: 'a'.repeat(60), sessionId: 'bbbb2222' }).length <= 64);
});

test('Google\'s credential file trades the token at its STS, then for the service account', () => {
  const gcp = CONNECTIONS.find((c) => c.type === 'gcp');
  assert.deepEqual(gcpCredentials(gcp, '/tmp/woodshed-cloud'), {
    type: 'external_account',
    audience: '//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/woodshed/providers/console',
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    token_url: 'https://sts.googleapis.com/v1/token',
    credential_source: { file: '/tmp/woodshed-cloud/gcp.jwt' },
    service_account_impersonation_url: 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/ws@p.iam.gserviceaccount.com:generateAccessToken',
  });
});

test('Azure\'s and Google\'s tools get their variables; AWS needs none', () => {
  const env = Object.fromEntries(envFor(CONNECTIONS, '/c'));
  assert.equal(env.AZURE_CLIENT_ID, '11111111-2222-3333-4444-555555555555');
  assert.equal(env.AZURE_FEDERATED_TOKEN_FILE, '/c/azure.jwt');
  assert.equal(env.ARM_OIDC_TOKEN_FILE_PATH, '/c/azure.jwt');
  assert.equal(env.ARM_SUBSCRIPTION_ID, '99999999-8888-7777-6666-555555555555');
  assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, '/c/gcp.gcp.json');
  assert.equal(env.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE, '/c/gcp.gcp.json');
  assert.ok(!Object.keys(env).some((k) => k.startsWith('AWS_')));
  assert.deepEqual(envFor(CONNECTIONS.filter((c) => c.type === 'aws'), '/c'), []);
});

test('setup writes the configs and a token per connection, readable by the session\'s user alone', async (t) => {
  const { dir, home } = tempDirs(t);
  const calls = [];
  const { results } = await setup({
    connections: CONNECTIONS, consoleUrl: 'http://console:7691', token: 'session-token', home, login: 'octocat', sessionId: 'aaaa1111', dir, fetchImpl: consoleFetch({ calls }),
  });
  assert.ok(results.every((r) => r.ok));
  assert.deepEqual(calls.map((c) => c.connection).sort(), CONNECTIONS.map((c) => c.name).sort());
  assert.ok(calls.every((c) => c.url === 'http://console:7691/cloud-token' && c.authorization === 'Bearer session-token'));
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  for (const c of CONNECTIONS) assert.equal(fs.statSync(tokenFile(dir, c.name)).mode & 0o777, 0o600, c.name);
  assert.match(fs.readFileSync(path.join(home, '.aws', 'config'), 'utf8'), /\[profile aws-dev\]/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'gcp.gcp.json'), 'utf8')).type, 'external_account');
  const listed = await status(dir);
  assert.ok(listed.every((c) => c.secondsLeft > 800), 'each token has most of its 15 minutes');
});

test('setup refuses a list it cannot read, and writes nothing', async (t) => {
  const { dir, home } = tempDirs(t);
  await assert.rejects(setup({ connections: [{ name: 'x', type: 'aws', roleArn: 'nope' }], consoleUrl: 'http://c', token: 't', home, dir, fetchImpl: consoleFetch() }), /roleArn/);
  assert.equal(fs.existsSync(dir), false);
});

test('a console away at the start is waited for; a refusal is not', async (t) => {
  const { dir, home } = tempDirs(t);
  let tries = 0;
  const flaky = async (url, init) => {
    const { connection } = JSON.parse(init.body);
    if (connection === 'vault') return new Response('{"error":"only a My Woodshed session signs in to a cloud"}', { status: 403 });
    tries += 1;
    if (tries <= 2) throw new Error('ECONNREFUSED');
    return consoleFetch()(url, init);
  };
  const { results } = await setup({
    connections: CONNECTIONS.filter((c) => c.name === 'aws-dev' || c.name === 'vault'), consoleUrl: 'http://c', token: 't', home, dir, fetchImpl: flaky, retryMs: 1,
  });
  assert.deepEqual(results.map((r) => [r.name, r.ok, r.ok ? null : r.status]), [['aws-dev', true, null], ['vault', false, 403]]);
});

test('refresh with no connections asks for nothing', async (t) => {
  const { dir } = tempDirs(t);
  const calls = [];
  assert.deepEqual(await refreshTokens({ consoleUrl: 'http://c', token: 't', dir, fetchImpl: consoleFetch({ calls }) }), []);
  assert.equal(calls.length, 0);
});
