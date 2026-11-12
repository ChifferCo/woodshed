// The console's settings, all from the environment. README.md lists them.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

import { ENGINE_NAMES } from '../shared/databases/index.mjs';
import { currentName, envValue } from '../shared/envNames.mjs';
import { secretEnvName } from '../shared/project.mjs';
import { isSessionVariable } from '../shared/reservedNames.mjs';
import { defaultProject, loadProjects } from './projects.mjs';
import { secretSpecs } from './secrets.mjs';

const HOUR_MS = 3_600_000;
export const DEFAULT_CONSOLE_NAME = 'Woodshed';
// Printable, short enough for a tab and a home screen, and nothing HTML or a script's string would read as its own.
const CONSOLE_NAME_RE = /^[^\p{C}<>"'`]{1,40}$/u;
const warnedConsoleNames = new Set();

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readSessionEnv(file) {
  if (!file) return {};
  const env = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') throw new Error(`${file}: ${key} must be a string`);
  }
  return env;
}

// Without a GitHub App, the token GitHub calls go out with also pushes for the
// sessions unless the session env names its own.
function ghToken(env) {
  if (env.GH_TOKEN) return env.GH_TOKEN;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    // A console being set up has no App yet and may have no gh either: the setup page is how it gets one.
    console.warn('console: no GitHub App and no gh token, so no GitHub access until the App is set up at /setup/github');
    return null;
  }
}

// The key comes from a file on a dev box. With a secret store (AWS's, or the local provider's folder), without a file,
// it comes from its secret, read at start and again whenever the Secrets page replaces it; until that has a value,
// the console runs without GitHub.
function githubApp(env) {
  const appId = envValue(env, 'GITHUB_APP_ID');
  const installationId = envValue(env, 'GITHUB_APP_INSTALLATION_ID');
  if (!appId) return null;
  if (envValue(env, 'GITHUB_BROKER_URL') || envValue(env, 'GITHUB_BROKER_TOKEN_FILE')) {
    throw new Error('WOODSHED_GITHUB_APP_ID and WOODSHED_GITHUB_BROKER_URL cannot both be set: a console has a GitHub App of its own, or borrows GitHub access from its host, not both');
  }
  const keyFile = envValue(env, 'GITHUB_APP_KEY_FILE') || null;
  const keyFromSecret = !keyFile && (envValue(env, 'LAUNCHER') === 'ecs' || Boolean(env.WOODSHED_LOCAL_SECRETS_DIR));
  if (!installationId || !(keyFile || keyFromSecret)) {
    throw new Error('WOODSHED_GITHUB_APP_ID needs WOODSHED_GITHUB_APP_INSTALLATION_ID, and WOODSHED_GITHUB_APP_KEY_FILE without a secret store (AWS, or WOODSHED_LOCAL_SECRETS_DIR)');
  }
  return { appId, installationId, keyFile, keyFromSecret };
}

/** @returns {string}  `WOODSHED_CONSOLE_NAME` trimmed, or the default when it is unset or not a name the console shows */
export function consoleName(env) {
  const value = envValue(env, 'CONSOLE_NAME');
  if (value === undefined || value.trim() === '') return DEFAULT_CONSOLE_NAME;
  const name = value.trim();
  if (CONSOLE_NAME_RE.test(name)) return name;
  if (!warnedConsoleNames.has(value)) {
    warnedConsoleNames.add(value);
    console.warn('console: WOODSHED_CONSOLE_NAME is not 1 to 40 printable characters without < > " \' or `, using the default', { length: value.length, name: DEFAULT_CONSOLE_NAME });
  }
  return DEFAULT_CONSOLE_NAME;
}

// Hosted mode's GitHub access, borrowed from the host's broker (githubBroker.mjs): both settings or neither. The token
// file is only checked for being there; its value is read at each call, and never kept in the config.
function githubBroker(env) {
  const names = ['GITHUB_BROKER_URL', 'GITHUB_BROKER_TOKEN_FILE'];
  const set = names.filter((name) => envValue(env, name));
  if (!set.length) return null;
  if (set.length === 1) throw new Error(`${currentName(set[0])} needs ${currentName(names.find((n) => !envValue(env, n)))} too`);
  let url;
  try {
    url = new URL(envValue(env, 'GITHUB_BROKER_URL'));
  } catch {
    throw new Error('WOODSHED_GITHUB_BROKER_URL is not a URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('WOODSHED_GITHUB_BROKER_URL must be http(s)');
  return { url: url.href, tokenFile: envValue(env, 'GITHUB_BROKER_TOKEN_FILE') };
}

// Hosted mode's sign-in (trustedIdentity.mjs). Short enough to guess is no secret.
const MIN_IDENTITY_SECRET_CHARS = 32;
function trustedIdentitySecret(env) {
  const secret = envValue(env, 'TRUSTED_IDENTITY_SECRET');
  if (!secret) return null;
  if (secret.length < MIN_IDENTITY_SECRET_CHARS) throw new Error(`WOODSHED_TRUSTED_IDENTITY_SECRET must be at least ${MIN_IDENTITY_SECRET_CHARS} characters`);
  return secret;
}

// What an installation's sessions can get a copy of: the database engines (shared/databases/), each on its own.
export const DATABASES = ENGINE_NAMES;

/**
 * The databases an installation runs, from a comma-separated list such as `postgres,mongo`, in DATABASES' order.
 * @param {string} value
 * @param {string} setting  what to name in an error
 * @returns {string[]}
 */
export function databaseList(value, setting) {
  const names = String(value ?? '').split(',').map((n) => n.trim()).filter(Boolean);
  const unknown = names.filter((n) => !DATABASES.includes(n));
  if (unknown.length) throw new Error(`${setting}: ${unknown.join(', ')} is not a database (${DATABASES.join(' or ')})`);
  if (new Set(names).size !== names.length) throw new Error(`${setting} names a database twice`);
  return DATABASES.filter((n) => names.includes(n));
}

// The local provider's databases: where dbAdmin.mjs's runs reach each, Postgres by its host and root user (both or
// neither, so a console never starts half set up) and Mongo by host:port. The root passwords are in the local secret
// store (providers/local/dbAdminRunner.mjs).
function localDatabases(env) {
  const pg = ['WOODSHED_LOCAL_DB_POSTGRES_HOST', 'WOODSHED_LOCAL_DB_POSTGRES_ROOT_USER'];
  const pgSet = pg.filter((name) => env[name]);
  if (pgSet.length === 1) throw new Error(`${pgSet[0]} needs ${pg.find((n) => !env[n])} too`);
  const postgres = pgSet.length ? { host: env.WOODSHED_LOCAL_DB_POSTGRES_HOST, rootUser: env.WOODSHED_LOCAL_DB_POSTGRES_ROOT_USER } : null;
  const mongo = env.WOODSHED_LOCAL_DB_MONGO_HOST ? { host: env.WOODSHED_LOCAL_DB_MONGO_HOST } : null;
  if (!postgres && !mongo) return null;
  return {
    postgresHost: postgres?.host ?? null, postgresRootUser: postgres?.rootUser ?? null, mongoHost: mongo?.host ?? null,
    network: env.WOODSHED_LOCAL_DOCKER_NETWORK || null,
  };
}

// The local provider's webhook receiver: where it listens, and the public address GitHub and Slack post to, which a
// proxy in front of it serves (the Settings page sets `<url>/github` on the GitHub App).
function localWebhooks(env) {
  if (!env.WOODSHED_LOCAL_WEBHOOK_PORT) return null;
  const port = Number(env.WOODSHED_LOCAL_WEBHOOK_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`WOODSHED_LOCAL_WEBHOOK_PORT is not a port: ${env.WOODSHED_LOCAL_WEBHOOK_PORT}`);
  return { host: env.WOODSHED_LOCAL_WEBHOOK_HOST || '127.0.0.1', port, url: (env.WOODSHED_LOCAL_WEBHOOK_URL || '').replace(/\/+$/, '') || null };
}

function tlsAskPort(env) {
  const value = envValue(env, 'TLS_ASK_PORT');
  if (!value) return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`WOODSHED_TLS_ASK_PORT is not a port: ${value}`);
  return port;
}

function localLogin(env) {
  const login = (envValue(env, 'LOCAL_LOGIN') || 'local').trim();
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) throw new Error('WOODSHED_LOCAL_LOGIN must be a handle: letters, digits and hyphens');
  return login;
}

// A comma-separated setting's pairs, each with its place among the commas as written, empty ones counted. An error names
// a bad pair by that place and never quotes it: a pair that is not what it should be may be a token pasted in by mistake.
function pairsOf(value) {
  return (value || '').split(',').map((pair, i) => ({ pair: pair.trim(), place: i + 1 })).filter(({ pair }) => pair);
}

/**
 * `WOODSHED_ENV_FILES`: the secrets that hold the repo's env files, as `secret=path` pairs, the project file's
 * `envFiles` (docs/reference.md, "The project file"): `api-env=api/.env,web-env=web/.env.local`.
 * @returns {{secret: string, path: string}[]}
 */
export function envFiles(env) {
  return pairsOf(envValue(env, 'ENV_FILES')).map(({ pair, place }) => {
    const [secret, ...rest] = pair.split('=');
    const file = rest.join('=').trim();
    if (!/^[a-z0-9-]+$/.test(secret.trim()) || !file) throw new Error(`WOODSHED_ENV_FILES wants secret=path pairs, as api-env=api/.env: pair ${place} is not`);
    return { secret: secret.trim(), path: file };
  });
}

/**
 * `WOODSHED_INSTALL_SECRET_PAIRS`: the secrets the repo's dependency installs read, as `secret=VARIABLE` pairs, each
 * the variable a session gets it in (`registry-token=REGISTRY_TOKEN`). Terraform sets it from `install_secrets`.
 * @param {NodeJS.ProcessEnv} env
 * @param {{secret: string}[]} files  envFiles(env), whose secrets and variables an install secret cannot share
 * @returns {{secret: string, variable: string}[]}
 */
export function installSecrets(env, files = envFiles(env)) {
  const taken = new Set(files.flatMap(({ secret }) => [secret, secretEnvName(secret)]));
  // The console's own secrets, which a session never holds: Terraform's install_secrets refuses the same names.
  const consoles = new Set(secretSpecs({ envFiles: [] }).map(({ name }) => name));
  const pairs = pairsOf(envValue(env, 'INSTALL_SECRETS')).map(({ pair, place }) => {
    const parts = pair.split('=').map((part) => part.trim());
    const [secret, variable = ''] = parts;
    // A third part is refused too, rather than dropped: it is most likely a value pasted after the name.
    if (parts.length !== 2 || !/^[a-z0-9-]+$/.test(secret) || !/^[A-Z_][A-Z0-9_]*$/.test(variable)) {
      throw new Error(`WOODSHED_INSTALL_SECRET_PAIRS wants secret=VARIABLE pairs, as registry-token=REGISTRY_TOKEN: pair ${place} is not`);
    }
    if (consoles.has(secret)) throw new Error(`WOODSHED_INSTALL_SECRET_PAIRS: pair ${place} names one of the console's own secrets, which sessions never get`);
    if (isSessionVariable(variable)) {
      throw new Error(`WOODSHED_INSTALL_SECRET_PAIRS: pair ${place}'s variable is one of Woodshed's own session variables`);
    }
    if (taken.has(secret) || taken.has(variable)) throw new Error(`WOODSHED_INSTALL_SECRET_PAIRS: pair ${place} is an env file's, or named twice`);
    taken.add(secret).add(variable);
    return { secret, variable };
  });
  return pairs;
}

// The console menu's GitHub Actions links, as `label=file.yml` pairs, comma-separated: the workflows in the repo that
// build the images and apply the infrastructure. Each installation names its own; with none, the menu has no such
// group.
export function actionsWorkflows(value) {
  return String(value ?? '').split(',').map((pair) => pair.trim()).filter(Boolean).map((pair) => {
    const at = pair.lastIndexOf('=');
    const label = pair.slice(0, at).trim();
    const file = pair.slice(at + 1).trim();
    if (at < 1 || !label || !/^[A-Za-z0-9._-]+\.ya?ml$/.test(file)) {
      throw new Error(`WOODSHED_ACTIONS_WORKFLOWS: "${pair}" is not label=file.yml`);
    }
    return { label, file };
  });
}

// Terraform names the AWS resources after its name_prefix and passes their names. A base box whose stack was written
// before it did passes none, and its resources are named woodshed-cloud: these fallbacks go once every box has had an
// apply that passes them.
const OLD_AWS_PREFIX = 'woodshed-cloud';

function webhookQueue(env) {
  const value = envValue(env, 'WEBHOOK_QUEUE');
  if (value === '0') return '';
  if (value) return value;
  return envValue(env, 'LAUNCHER') === 'ecs' ? `${OLD_AWS_PREFIX}-webhooks` : '';
}

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|\[::1\]|localhost)$/i;

/**
 * Without sign-in every gate lets a request through and the first visitor is an admin, which is safe only on a console
 * nothing but this machine reaches. Bound to anything but loopback, sign-in must be required from the first request.
 * A reverse proxy in front of a loopback console is the operator's to fence (providers/local/README.md).
 */
export function requireClosedWhenReachable(config) {
  if (LOOPBACK.test(config.host) || config.requireSignIn) return;
  throw new Error(`WOODSHED_HOST is ${config.host}, which other machines reach, and sign-in is not required: set WOODSHED_REQUIRE_SIGN_IN=1 (with the GitHub App) or WOODSHED_TRUSTED_IDENTITY_SECRET, or bind 127.0.0.1 behind a proxy`);
}

/**
 * Nothing in Woodshed names a repo of its own: an installation says which ones it works on, or none, and an admin adds
 * them on the Console settings page. A repo it does name must be GitHub's owner/name.
 */
export function requireRepo(config) {
  const { repo } = defaultProject(config);
  if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('WOODSHED_REPO (or WOODSHED_PROJECTS) must name a repo as owner/name, or be left unset for a console that starts with none');
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {{readGhToken?: boolean}} [opts]  false leaves `gh auth token` unasked, for a caller that takes the defaults
 *   from here and gives the console its GitHub access another way
 */
export function loadConfig(env = process.env, { readGhToken = true } = {}) {
  const port = number(envValue(env, 'PORT'), 7690);
  const app = githubApp(env);
  const broker = githubBroker(env);
  const identitySecret = trustedIdentitySecret(env);
  const databases = envValue(env, 'DATABASES');
  return {
    // What the pages, the installed app and the console's GitHub comments call this console.
    consoleName: consoleName(env),
    host: envValue(env, 'HOST') || '127.0.0.1',
    port,
    publicUrl: (envValue(env, 'PUBLIC_URL') || `http://localhost:${port}`).replace(/\/+$/, ''),
    extraHosts: (envValue(env, 'HOSTS') || '').split(',').map((h) => h.trim()).filter(Boolean),
    // Session apps answer at `<id>.<appDomain>`; empty turns them off.
    appDomain: (envValue(env, 'APP_DOMAIN') || '').trim().toLowerCase(),
    // Where a reverse proxy asks before getting a certificate on demand (tlsAsk.mjs), on 127.0.0.1; none turns it off.
    tlsAskPort: tlsAskPort(env),
    // On a console the internet reaches, sign-in never goes optional: not before the client secret is set,
    // nor while a new one is unproven.
    // A trusted proxy's identity header is sign-in, and always required (trustedIdentity.mjs).
    requireSignIn: envValue(env, 'REQUIRE_SIGN_IN') === '1' || Boolean(identitySecret),
    trustedIdentitySecret: identitySecret,
    stateDir: envValue(env, 'STATE_DIR') || '/var/lib/woodshed-cloud',
    // The repos this installation works on (projects.mjs), or none until an admin adds one on the Console settings page.
    projects: loadProjects(env),
    // A folder of `<owner>/<name>.yaml` project files, each for a repo with no .woodshed/project.yaml of its own
    // (shared/project.mjs, installationProjectFile). The local provider hands a session its repo's.
    projectFilesDir: envValue(env, 'PROJECT_FILES_DIR') || null,
    actionsWorkflows: actionsWorkflows(envValue(env, 'ACTIONS_WORKFLOWS')),
    label: envValue(env, 'LABEL') || 'woodshed',
    // The secrets holding the repo's env files, which the Secrets page and My settings show. None when it has none.
    envFiles: envFiles(env),
    // The ones of those the databases' commands read: their `envFiles` in the project file, which the db-admin run is given.
    dbEnvSecrets: (envValue(env, 'DB_ENV_SECRETS') || '').split(',').map((s) => s.trim()).filter(Boolean),
    // The secrets the repo's installs read, each with the variable a session gets it in. None when it has none.
    installSecrets: installSecrets(env),
    pollGitHub: envValue(env, 'POLL_GITHUB') !== '0',
    pollMs: number(envValue(env, 'POLL_SECONDS'), 30) * 1000,
    tickMs: 10_000,
    // A starting session's statusd alone, so its page opens claude's terminal within a couple of seconds.
    startingCheckMs: 2_000,
    // Shared sessions at once, until the Console settings page says otherwise, as it does for the limits below.
    maxRunning: number(envValue(env, 'MAX_SESSIONS'), 5),
    limits: {
      idleMs: number(envValue(env, 'IDLE_HOURS'), 1) * HOUR_MS,
      lifetimeMs: number(envValue(env, 'LIFETIME_HOURS'), 8) * HOUR_MS,
      startTimeoutMs: 15 * 60_000,
    },
    launcher: {
      kind: envValue(env, 'LAUNCHER') || 'docker',
      image: envValue(env, 'IMAGE') || 'woodshed-session',
      memory: envValue(env, 'SESSION_MEMORY') || '6g',
      cpus: envValue(env, 'SESSION_CPUS') || '2',
      ecs: {
        cluster: envValue(env, 'ECS_CLUSTER'),
        taskDefinition: envValue(env, 'ECS_TASK_DEFINITION'),
        // Makes, resets and drops each person's own databases (databases.mjs); without it there are none.
        dbAdminTaskDefinition: envValue(env, 'ECS_DB_ADMIN_TASK_DEFINITION') || null,
        // Which databases that task makes: Terraform's `databases` (providers/aws/index.mjs checks the two agree).
        databases: databases === undefined ? null : databaseList(databases, 'WOODSHED_DATABASES'),
        subnets: (envValue(env, 'ECS_SUBNETS') || '').split(',').filter(Boolean),
        securityGroup: envValue(env, 'ECS_SECURITY_GROUP'),
        logGroup: envValue(env, 'ECS_LOG_GROUP'),
      },
    },
    // In AWS the queue Terraform makes, found by name; `0` turns it off. Elsewhere none, so a dev box only polls.
    webhookQueue: webhookQueue(env),
    fallbackPollMs: number(envValue(env, 'FALLBACK_POLL_SECONDS'), 300) * 1000,
    sessionEnv: readSessionEnv(envValue(env, 'SESSION_ENV_FILE')),
    // Where woodshed-db.mjs's connections go (dbTunnel.mjs), as `host:port`; without both, no tunnel.
    tunnelTargets: { pg: envValue(env, 'TUNNEL_POSTGRES') || null, mongo: envValue(env, 'TUNNEL_MONGO') || null },
    // Where each person's Claude home is kept between their private sessions (the aws provider's homeStore.mjs); none turns that off.
    homesBucket: envValue(env, 'HOMES_BUCKET') || null,
    // The same on the local provider, as files in a folder only the console's user can open.
    localHomesDir: env.WOODSHED_LOCAL_HOMES_DIR || null,
    localDatabases: localDatabases(env),
    localWebhooks: localWebhooks(env),
    // The docker network local sessions and db-admin runs join (providers/local/compose.yml's `woodshed`).
    localDockerNetwork: env.WOODSHED_LOCAL_DOCKER_NETWORK || null,
    githubApp: app,
    // Hosted mode: no App of its own, every installation token from the host's broker. Null otherwise.
    githubBroker: broker,
    // Who a local console with no sign-in treats the person using it as, for My Woodshed (server.mjs, soloLoginOf).
    localLogin: localLogin(env),
    // The Secrets page's store. In AWS, Secrets Manager: it needs the base box role's access to these secrets.
    secrets: envValue(env, 'LAUNCHER') === 'ecs' ? { prefix: envValue(env, 'SECRET_PREFIX') || `${OLD_AWS_PREFIX}/` } : null,
    // On the local provider, a folder only the console's user can open; none leaves it without a Secrets page.
    localSecretsDir: env.WOODSHED_LOCAL_SECRETS_DIR || null,
    // The key that folder's files are sealed with, in a file of its own outside it (providers/local/secretKey.mjs).
    localSecretsKeyFile: env.WOODSHED_LOCAL_SECRETS_KEY_FILE || null,
    webhookFunction: envValue(env, 'WEBHOOK_FUNCTION') || (envValue(env, 'LAUNCHER') === 'ecs' ? `${OLD_AWS_PREFIX}-webhooks` : ''),
    ghToken: app || broker || !readGhToken ? null : ghToken(env),
    // Where sessions fetch GitHub tokens; only with an App, and only on an address sessions can reach.
    sessionApi: { host: envValue(env, 'SESSION_API_HOST') || null, port: number(envValue(env, 'SESSION_API_PORT'), 7691) },
  };
}
