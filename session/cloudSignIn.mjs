// A private session's sign-in to the clouds the installation lists (shared/oidcConnections.mjs), as its owner, with no
// key of its own. The console hands the session a short-lived OpenID Connect token for each (POST /cloud-token,
// console/oidcIssuer.mjs), kept in a file only the session's user reads, and each cloud's own CLI and SDKs trade that
// file for the cloud's credentials themselves, reading it again whenever theirs expire:
//
//   aws    ~/.aws/config: a profile per connection with `role_arn` and `web_identity_token_file`, the first also the default
//   azure  AZURE_CLIENT_ID, AZURE_TENANT_ID and AZURE_FEDERATED_TOKEN_FILE (Azure's SDKs), and Terraform's ARM_* the same;
//          the az CLI signs in once with `woodshed-cloud az-login`
//   gcp    an external_account credential file per connection: GOOGLE_APPLICATION_CREDENTIALS (the SDKs, Terraform) and
//          CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE (gcloud) name the first
//   token  only the token file, for anything else that takes one (Vault's JWT login, a Kubernetes exec plugin)
//
//   node cloudSignIn.mjs setup <connections.json>   the entrypoint, after the owner's settings: writes the above, gets
//                                                   the first tokens and prints the variables to export, KEY=VALUE
//   node cloudSignIn.mjs refresh                    new tokens now (statusd does this every REFRESH_EVERY_MS)
//   node cloudSignIn.mjs status                     each connection, and how long its token has left; never the token
//
// Nothing here is in the saved Claude home: the files are written again at every start.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseConnections } from '../shared/oidcConnections.mjs';
import { isMain } from '../shared/isMain.mjs';

export const CLOUD_DIR = '/tmp/woodshed-cloud';
// Tokens last 15 minutes (oidcIssuer.mjs), so two refreshes can fail before a cloud sees an expired one.
export const REFRESH_EVERY_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
// The start waits out a console restart (each redeploy) as the entrypoint's consoleCall does: about 40 s.
const START_TRIES = 9;
const START_RETRY_MS = 5_000;

const connectionsFile = (dir) => path.join(dir, 'connections.json');
export const tokenFile = (dir, name) => path.join(dir, `${name}.jwt`);
const gcpFile = (dir, name) => path.join(dir, `${name}.gcp.json`);

async function writePrivate(file, text) {
  // Renamed into place, so a CLI never reads half a token.
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, text, { mode: 0o600 });
  await fs.rename(temp, file);
}

/** AWS's role session name allows [\w+=,.@-], 2 to 64 characters: CloudTrail shows it beside the role. */
export function roleSessionName({ login, sessionId }) {
  const name = `woodshed-${login || 'session'}-${sessionId || ''}`.replace(/[^\w+=,.@-]/g, '-').replace(/-+$/, '');
  return name.slice(0, 64);
}

/** ~/.aws/config for the aws connections: each its own profile, the first also the default. */
export function awsConfig(connections, { dir, login, sessionId }) {
  const aws = connections.filter((c) => c.type === 'aws');
  if (!aws.length) return null;
  const body = (c) => [
    `role_arn = ${c.roleArn}`,
    `web_identity_token_file = ${tokenFile(dir, c.name)}`,
    `role_session_name = ${roleSessionName({ login, sessionId })}`,
    ...(c.region ? [`region = ${c.region}`] : []),
  ].join('\n');
  return [
    '# Written by Woodshed at the session\'s start (session/cloudSignIn.mjs). Each profile signs in as the session\'s owner',
    '# with a token from the console; `woodshed-cloud status` lists them. Changes here last until the session stops.',
    '',
    '[default]', body(aws[0]), '',
    ...aws.flatMap((c) => [`[profile ${c.name}]`, body(c), '']),
  ].join('\n');
}

/** Google's external_account credential config: the token file traded at Google's STS, then for the service account. */
export function gcpCredentials(connection, dir) {
  return {
    type: 'external_account',
    audience: `//iam.googleapis.com/${connection.provider}`,
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    token_url: 'https://sts.googleapis.com/v1/token',
    credential_source: { file: tokenFile(dir, connection.name) },
    ...(connection.serviceAccount ? {
      service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${connection.serviceAccount}:generateAccessToken`,
    } : {}),
  };
}

/** The variables Azure's and Google's tools read, for the first connection of each: [name, value] pairs. */
export function envFor(connections, dir) {
  const env = [];
  const azure = connections.find((c) => c.type === 'azure');
  if (azure) {
    const file = tokenFile(dir, azure.name);
    env.push(['AZURE_CLIENT_ID', azure.clientId], ['AZURE_TENANT_ID', azure.tenantId], ['AZURE_FEDERATED_TOKEN_FILE', file]);
    // Terraform's azurerm provider, which reads its own names.
    env.push(['ARM_USE_OIDC', 'true'], ['ARM_CLIENT_ID', azure.clientId], ['ARM_TENANT_ID', azure.tenantId], ['ARM_OIDC_TOKEN_FILE_PATH', file]);
    if (azure.subscriptionId) env.push(['AZURE_SUBSCRIPTION_ID', azure.subscriptionId], ['ARM_SUBSCRIPTION_ID', azure.subscriptionId]);
  }
  const gcp = connections.find((c) => c.type === 'gcp');
  if (gcp) env.push(['GOOGLE_APPLICATION_CREDENTIALS', gcpFile(dir, gcp.name)], ['CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE', gcpFile(dir, gcp.name)]);
  return env;
}

/**
 * One connection's token from the console, written to its file.
 * @returns {Promise<{name: string, ok: true, expiresAt: string}|{name: string, ok: false, status: number|null, error: string}>}
 */
async function fetchToken({ consoleUrl, token, dir, name, fetchImpl }) {
  let res;
  try {
    res = await fetchImpl(`${consoleUrl}/cloud-token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ connection: name }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return { name, ok: false, status: null, error: err?.message ?? String(err) };
  }
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // An answer that is not JSON is the console's error page, or something else in its place.
  }
  if (res.status !== 200 || typeof body?.token !== 'string') {
    return { name, ok: false, status: res.status, error: body?.error ?? text.slice(0, 200) };
  }
  await writePrivate(tokenFile(dir, name), body.token);
  return { name, ok: true, expiresAt: body.expiresAt };
}

/**
 * A new token for every connection.
 * @param {{consoleUrl: string, token: string, dir?: string, fetchImpl?: typeof fetch}} opts
 * @returns {Promise<ReturnType<typeof fetchToken>[]>}  each connection's outcome; nothing when there are none
 */
export async function refreshTokens({ consoleUrl, token, dir = CLOUD_DIR, fetchImpl = fetch }) {
  const connections = await readConnections(dir);
  return Promise.all(connections.map(({ name }) => fetchToken({ consoleUrl, token, dir, name, fetchImpl })));
}

export async function readConnections(dir = CLOUD_DIR) {
  try {
    return parseConnections(JSON.parse(await fs.readFile(connectionsFile(dir), 'utf8')));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

const transient = (r) => !r.ok && (r.status === null || r.status === 408 || r.status === 429 || r.status >= 500);

/**
 * At start: checks what the console sent, writes each cloud's config and the first tokens.
 * @param {{connections: unknown, consoleUrl: string, token: string, home: string, login: string, sessionId: string,
 *          dir?: string, fetchImpl?: typeof fetch, retryMs?: number}} opts
 * @returns {Promise<{env: [string, string][], results: object[], connections: object[]}>}
 * @throws {Error}  when the list is not one shared/oidcConnections.mjs reads, which writes nothing
 */
export async function setup({ connections: raw, consoleUrl, token, home, login, sessionId, dir = CLOUD_DIR, fetchImpl = fetch, retryMs = START_RETRY_MS }) {
  // The console checked them already; they are checked again because they go into files and the environment.
  const connections = parseConnections(raw);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  await writePrivate(connectionsFile(dir), `${JSON.stringify(connections)}\n`);
  const aws = awsConfig(connections, { dir, login, sessionId });
  if (aws) {
    await fs.mkdir(path.join(home, '.aws'), { recursive: true, mode: 0o700 });
    await writePrivate(path.join(home, '.aws', 'config'), aws);
  }
  for (const c of connections.filter((x) => x.type === 'gcp')) {
    await writePrivate(gcpFile(dir, c.name), `${JSON.stringify(gcpCredentials(c, dir), null, 2)}\n`);
  }
  let results = await refreshTokens({ consoleUrl, token, dir, fetchImpl });
  for (let attempt = 1; attempt < START_TRIES && results.some(transient); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, retryMs));
    const again = await Promise.all(results.map((r) => (transient(r) ? fetchToken({ consoleUrl, token, dir, name: r.name, fetchImpl }) : r)));
    results = again;
  }
  return { env: envFor(connections, dir), results, connections };
}

/** Each connection and its token's time left, read from the token file's own `exp`. */
export async function status(dir = CLOUD_DIR, now = Date.now()) {
  const connections = await readConnections(dir);
  return Promise.all(connections.map(async (c) => {
    let left = null;
    try {
      const claims = JSON.parse(Buffer.from((await fs.readFile(tokenFile(dir, c.name), 'utf8')).split('.')[1], 'base64url'));
      left = Math.round(claims.exp - now / 1000);
    } catch {
      // No token yet, or one that is not a JWT: shown as none.
    }
    return { ...c, tokenFile: tokenFile(dir, c.name), secondsLeft: left };
  }));
}

function sessionEnv() {
  const consoleUrl = process.env.WOODSHED_CONSOLE_URL;
  const token = process.env.SESSION_TOKEN;
  if (!consoleUrl || !token) throw new Error('needs WOODSHED_CONSOLE_URL and SESSION_TOKEN, as a session has');
  return { consoleUrl, token };
}

function failed(results) {
  return results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.status ?? 'no answer'} ${r.error}`).join('; ');
}

if (isMain(import.meta.url)) {
  const [command, arg] = process.argv.slice(2);
  try {
    if (command === 'setup') {
      const raw = JSON.parse(await fs.readFile(arg, 'utf8'));
      const { env, results, connections } = await setup({
        connections: raw, ...sessionEnv(), home: os.homedir(), login: (process.env.STARTED_BY || '').toLowerCase(), sessionId: process.env.SESSION_ID,
      });
      for (const [name, value] of env) process.stdout.write(`${name}=${value}\n`);
      const bad = failed(results);
      process.stderr.write(`connections: ${connections.map((c) => `${c.name} (${c.type})`).join(', ')}${bad ? `; no token for ${bad}` : ''}\n`);
    } else if (command === 'refresh') {
      const results = await refreshTokens(sessionEnv());
      const bad = failed(results);
      if (bad) throw new Error(`no token for ${bad}`);
      process.stdout.write(`${results.length ? results.map((r) => `${r.name}: until ${r.expiresAt}`).join('\n') : 'no cloud connections in this session'}\n`);
    } else if (command === 'status') {
      const list = await status();
      if (!list.length) process.stdout.write('No cloud connections in this session: only a My Woodshed session gets them, where the console lists some.\n');
      for (const c of list) {
        const where = c.type === 'aws' ? `profile ${c.name}` : c.type === 'gcp' ? `credentials ${gcpFile(CLOUD_DIR, c.name)}` : `token ${c.tokenFile}`;
        const left = c.secondsLeft === null ? 'no token yet' : c.secondsLeft > 0 ? `token good for ${Math.floor(c.secondsLeft / 60)} min` : 'token expired';
        process.stdout.write(`${c.name} (${c.type}): ${where}, ${left}\n`);
      }
      if (list.some((c) => c.type === 'aws') && process.env.AWS_ACCESS_KEY_ID) {
        process.stdout.write('Note: AWS_ACCESS_KEY_ID is set in this shell, and the AWS CLI uses it before any profile: unset it to sign in as yourself.\n');
      }
    } else {
      throw new Error('usage: cloudSignIn.mjs setup <connections.json> | refresh | status');
    }
  } catch (err) {
    process.stderr.write(`cloudSignIn: ${err.message}\n`);
    process.exit(1);
  }
}
