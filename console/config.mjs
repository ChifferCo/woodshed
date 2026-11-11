// The console's settings, all from the environment. README.md lists them.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

import { ENGINE_NAMES } from '../shared/databases/index.mjs';
import { secretEnvName } from '../shared/project.mjs';
import { defaultProject, loadProjects, projectsFrom } from './projects.mjs';

const HOUR_MS = 3_600_000;

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
  const { WOODSHED_CLOUD_GITHUB_APP_ID: appId, WOODSHED_CLOUD_GITHUB_APP_INSTALLATION_ID: installationId } = env;
  if (!appId) return null;
  if (env.WOODSHED_CLOUD_GITHUB_BROKER_URL || env.WOODSHED_CLOUD_GITHUB_BROKER_TOKEN_FILE) {
    throw new Error('WOODSHED_CLOUD_GITHUB_APP_ID and WOODSHED_CLOUD_GITHUB_BROKER_URL cannot both be set: a console has a GitHub App of its own, or borrows GitHub access from its host, not both');
  }
  const keyFile = env.WOODSHED_CLOUD_GITHUB_APP_KEY_FILE || null;
  const keyFromSecret = !keyFile && (env.WOODSHED_CLOUD_LAUNCHER === 'ecs' || Boolean(env.WOODSHED_LOCAL_SECRETS_DIR));
  if (!installationId || !(keyFile || keyFromSecret)) {
    throw new Error('WOODSHED_CLOUD_GITHUB_APP_ID needs WOODSHED_CLOUD_GITHUB_APP_INSTALLATION_ID, and WOODSHED_CLOUD_GITHUB_APP_KEY_FILE without a secret store (AWS, or WOODSHED_LOCAL_SECRETS_DIR)');
  }
  return { appId, installationId, keyFile, keyFromSecret };
}

// Hosted mode's GitHub access, borrowed from the host's broker (githubBroker.mjs): both settings or neither. The token
// file is only checked for being there; its value is read at each call, and never kept in the config.
function githubBroker(env) {
  const names = ['WOODSHED_CLOUD_GITHUB_BROKER_URL', 'WOODSHED_CLOUD_GITHUB_BROKER_TOKEN_FILE'];
  const set = names.filter((name) => env[name]);
  if (!set.length) return null;
  if (set.length === 1) throw new Error(`${set[0]} needs ${names.find((n) => !env[n])} too`);
  let url;
  try {
    url = new URL(env.WOODSHED_CLOUD_GITHUB_BROKER_URL);
  } catch {
    throw new Error('WOODSHED_CLOUD_GITHUB_BROKER_URL is not a URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('WOODSHED_CLOUD_GITHUB_BROKER_URL must be http(s)');
  return { url: url.href, tokenFile: env.WOODSHED_CLOUD_GITHUB_BROKER_TOKEN_FILE };
}

// Hosted mode's sign-in (trustedIdentity.mjs). Short enough to guess is no secret.
const MIN_IDENTITY_SECRET_CHARS = 32;
function trustedIdentitySecret(env) {
  const secret = env.WOODSHED_CLOUD_TRUSTED_IDENTITY_SECRET;
  if (!secret) return null;
  if (secret.length < MIN_IDENTITY_SECRET_CHARS) throw new Error(`WOODSHED_CLOUD_TRUSTED_IDENTITY_SECRET must be at least ${MIN_IDENTITY_SECRET_CHARS} characters`);
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
  if (!env.WOODSHED_CLOUD_TLS_ASK_PORT) return null;
  const port = Number(env.WOODSHED_CLOUD_TLS_ASK_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`WOODSHED_CLOUD_TLS_ASK_PORT is not a port: ${env.WOODSHED_CLOUD_TLS_ASK_PORT}`);
  return port;
}

function localLogin(env) {
  const login = (env.WOODSHED_CLOUD_LOCAL_LOGIN || 'local').trim();
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) throw new Error('WOODSHED_CLOUD_LOCAL_LOGIN must be a handle: letters, digits and hyphens');
  return login;
}

/**
 * `WOODSHED_CLOUD_ENV_FILES`: the secrets that hold the repo's env files, as `secret=path` pairs, the project file's
 * `envFiles` (docs/reference.md, "The project file"): `api-env=api/.env,web-env=web/.env.local`.
 * @returns {{secret: string, path: string}[]}
 */
export function envFiles(env) {
  return (env.WOODSHED_CLOUD_ENV_FILES || '').split(',').map((p) => p.trim()).filter(Boolean).map((pair) => {
    const [secret, ...rest] = pair.split('=');
    const file = rest.join('=').trim();
    if (!/^[a-z0-9-]+$/.test(secret.trim()) || !file) throw new Error(`WOODSHED_CLOUD_ENV_FILES wants secret=path pairs, as api-env=api/.env: ${pair}`);
    return { secret: secret.trim(), path: file };
  });
}

// The variables Woodshed itself gives a session (session/entrypoint.sh, its Environment), besides every WOODSHED_ one:
// an install secret cannot arrive in one of them. providers/aws/terraform/variables.tf, install_secrets, repeats it.
export const SESSION_VARIABLES = Object.freeze([
  'SESSION_ID', 'SESSION_TOKEN', 'TERMINAL_TOKEN', 'SESSION_URL', 'SESSION_KIND', 'SESSION_MODE', 'STARTED_BY', 'ISSUE', 'PR',
  'BRANCH', 'PROMPT', 'ASKED_BY', 'AGENT', 'MODEL', 'EFFORT', 'PERMISSION_MODE', 'RESUME_SESSION', 'ATTACHMENTS', 'REVIEW_ONLY',
  'REPO_DIR', 'GH_TOKEN', 'ANTHROPIC_API_KEY', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSSLMODE',
  'PGSSLROOTCERT', 'PG_URL', 'MONGODB_URI', 'HOME', 'PATH',
]);

/**
 * `WOODSHED_CLOUD_INSTALL_SECRETS`: the secrets the repo's dependency installs read, as `secret=VARIABLE` pairs, each
 * the variable a session gets it in (`registry-token=REGISTRY_TOKEN`). Terraform sets it from `install_secrets`.
 * @param {NodeJS.ProcessEnv} env
 * @param {{secret: string}[]} files  envFiles(env), whose secrets and variables an install secret cannot share
 * @returns {{secret: string, variable: string}[]}
 */
export function installSecrets(env, files = envFiles(env)) {
  const taken = new Set(files.flatMap(({ secret }) => [secret, secretEnvName(secret)]));
  const pairs = (env.WOODSHED_CLOUD_INSTALL_SECRETS || '').split(',').map((p) => p.trim()).filter(Boolean).map((pair) => {
    const [secret, variable = ''] = pair.split('=').map((part) => part.trim());
    if (!/^[a-z0-9-]+$/.test(secret) || !/^[A-Z_][A-Z0-9_]*$/.test(variable)) {
      throw new Error(`WOODSHED_CLOUD_INSTALL_SECRETS wants secret=VARIABLE pairs, as registry-token=REGISTRY_TOKEN: ${pair}`);
    }
    if (variable.startsWith('WOODSHED_') || SESSION_VARIABLES.includes(variable)) {
      throw new Error(`WOODSHED_CLOUD_INSTALL_SECRETS: ${variable} is one of Woodshed's own session variables`);
    }
    if (taken.has(secret) || taken.has(variable)) throw new Error(`WOODSHED_CLOUD_INSTALL_SECRETS: ${pair} is an env file's, or named twice`);
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
      throw new Error(`WOODSHED_CLOUD_ACTIONS_WORKFLOWS: "${pair}" is not label=file.yml`);
    }
    return { label, file };
  });
}

function webhookQueue(env) {
  const value = env.WOODSHED_CLOUD_WEBHOOK_QUEUE;
  if (value === '0') return '';
  if (value) return value;
  return env.WOODSHED_CLOUD_LAUNCHER === 'ecs' ? 'woodshed-cloud-webhooks' : '';
}

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|\[::1\]|localhost)$/i;

/**
 * Without sign-in every gate lets a request through and the first visitor is an admin, which is safe only on a console
 * nothing but this machine reaches. Bound to anything but loopback, sign-in must be required from the first request.
 * A reverse proxy in front of a loopback console is the operator's to fence (providers/local/README.md).
 */
export function requireClosedWhenReachable(config) {
  if (LOOPBACK.test(config.host) || config.requireSignIn) return;
  throw new Error(`WOODSHED_CLOUD_HOST is ${config.host}, which other machines reach, and sign-in is not required: set WOODSHED_CLOUD_REQUIRE_SIGN_IN=1 (with the GitHub App) or WOODSHED_CLOUD_TRUSTED_IDENTITY_SECRET, or bind 127.0.0.1 behind a proxy`);
}

/** Nothing in Woodshed Cloud names a repo of its own: an installation says which ones it works on. */
export function requireRepo(config) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(defaultProject(config).repo)) throw new Error('WOODSHED_CLOUD_REPO (or WOODSHED_CLOUD_PROJECTS) must name the repo this installation works on, as owner/name');
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {{readGhToken?: boolean}} [opts]  false leaves `gh auth token` unasked: a tenant of a multi-tenant console
 *   (tenantConfig) borrows its GitHub access, and the defaults are all it wants from here
 */
export function loadConfig(env = process.env, { readGhToken = true } = {}) {
  const port = number(env.WOODSHED_CLOUD_PORT, 7690);
  const app = githubApp(env);
  const broker = githubBroker(env);
  const identitySecret = trustedIdentitySecret(env);
  return {
    host: env.WOODSHED_CLOUD_HOST || '127.0.0.1',
    port,
    publicUrl: (env.WOODSHED_CLOUD_PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    extraHosts: (env.WOODSHED_CLOUD_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean),
    // Session apps answer at `<id>.<appDomain>`; empty turns them off.
    appDomain: (env.WOODSHED_CLOUD_APP_DOMAIN || '').trim().toLowerCase(),
    // Where a reverse proxy asks before getting a certificate on demand (tlsAsk.mjs), on 127.0.0.1; none turns it off.
    tlsAskPort: tlsAskPort(env),
    // On a console the internet reaches, sign-in never goes optional: not before the client secret is set,
    // nor while a new one is unproven.
    // A trusted proxy's identity header is sign-in, and always required (trustedIdentity.mjs).
    requireSignIn: env.WOODSHED_CLOUD_REQUIRE_SIGN_IN === '1' || Boolean(identitySecret),
    trustedIdentitySecret: identitySecret,
    stateDir: env.WOODSHED_CLOUD_STATE_DIR || '/var/lib/woodshed-cloud',
    // The repos this installation works on (projects.mjs). providers/console.mjs refuses to start without one.
    projects: loadProjects(env),
    // A folder of `<owner>/<name>.yaml` project files, each for a repo with no .woodshed/project.yaml of its own
    // (shared/project.mjs, installationProjectFile). The local provider hands a session its repo's.
    projectFilesDir: env.WOODSHED_CLOUD_PROJECT_FILES_DIR || null,
    actionsWorkflows: actionsWorkflows(env.WOODSHED_CLOUD_ACTIONS_WORKFLOWS),
    label: env.WOODSHED_CLOUD_LABEL || 'woodshed',
    // The secrets holding the repo's env files, which the Secrets page and My settings show. None when it has none.
    envFiles: envFiles(env),
    // The ones of those the databases' commands read: their `envFiles` in the project file, which the db-admin run is given.
    dbEnvSecrets: (env.WOODSHED_CLOUD_DB_ENV_SECRETS || '').split(',').map((s) => s.trim()).filter(Boolean),
    // The secrets the repo's installs read, each with the variable a session gets it in. None when it has none.
    installSecrets: installSecrets(env),
    pollGitHub: env.WOODSHED_CLOUD_POLL_GITHUB !== '0',
    pollMs: number(env.WOODSHED_CLOUD_POLL_SECONDS, 30) * 1000,
    tickMs: 10_000,
    // A starting session's statusd alone, so its page opens claude's terminal within a couple of seconds.
    startingCheckMs: 2_000,
    // Shared sessions at once, until the Console settings page says otherwise, as it does for the limits below.
    maxRunning: number(env.WOODSHED_CLOUD_MAX_SESSIONS, 5),
    limits: {
      idleMs: number(env.WOODSHED_CLOUD_IDLE_HOURS, 1) * HOUR_MS,
      lifetimeMs: number(env.WOODSHED_CLOUD_LIFETIME_HOURS, 8) * HOUR_MS,
      startTimeoutMs: 15 * 60_000,
    },
    launcher: {
      kind: env.WOODSHED_CLOUD_LAUNCHER || 'docker',
      image: env.WOODSHED_CLOUD_IMAGE || 'woodshed-session',
      memory: env.WOODSHED_CLOUD_SESSION_MEMORY || '6g',
      cpus: env.WOODSHED_CLOUD_SESSION_CPUS || '2',
      ecs: {
        cluster: env.WOODSHED_CLOUD_ECS_CLUSTER,
        taskDefinition: env.WOODSHED_CLOUD_ECS_TASK_DEFINITION,
        // Makes, resets and drops each person's own databases (databases.mjs); without it there are none.
        dbAdminTaskDefinition: env.WOODSHED_CLOUD_ECS_DB_ADMIN_TASK_DEFINITION || null,
        // Which databases that task makes: Terraform's `databases` (providers/aws/index.mjs checks the two agree).
        databases: env.WOODSHED_CLOUD_DATABASES === undefined ? null : databaseList(env.WOODSHED_CLOUD_DATABASES, 'WOODSHED_CLOUD_DATABASES'),
        subnets: (env.WOODSHED_CLOUD_ECS_SUBNETS || '').split(',').filter(Boolean),
        securityGroup: env.WOODSHED_CLOUD_ECS_SECURITY_GROUP,
        logGroup: env.WOODSHED_CLOUD_ECS_LOG_GROUP,
      },
    },
    // In AWS the queue Terraform makes, found by name; `0` turns it off. Elsewhere none, so a dev box only polls.
    webhookQueue: webhookQueue(env),
    fallbackPollMs: number(env.WOODSHED_CLOUD_FALLBACK_POLL_SECONDS, 300) * 1000,
    sessionEnv: readSessionEnv(env.WOODSHED_CLOUD_SESSION_ENV_FILE),
    // Where woodshed-db.mjs's connections go (dbTunnel.mjs), as `host:port`; without both, no tunnel.
    tunnelTargets: { pg: env.WOODSHED_CLOUD_TUNNEL_POSTGRES || null, mongo: env.WOODSHED_CLOUD_TUNNEL_MONGO || null },
    // Where each person's Claude home is kept between their private sessions (the aws provider's homeStore.mjs); none turns that off.
    homesBucket: env.WOODSHED_CLOUD_HOMES_BUCKET || null,
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
    secrets: env.WOODSHED_CLOUD_LAUNCHER === 'ecs' ? { prefix: env.WOODSHED_CLOUD_SECRET_PREFIX || 'woodshed-cloud/' } : null,
    // On the local provider, a folder only the console's user can open; none leaves it without a Secrets page.
    localSecretsDir: env.WOODSHED_LOCAL_SECRETS_DIR || null,
    // The key that folder's files are sealed with, in a file of its own outside it (providers/local/secretKey.mjs).
    localSecretsKeyFile: env.WOODSHED_LOCAL_SECRETS_KEY_FILE || null,
    webhookFunction: env.WOODSHED_CLOUD_WEBHOOK_FUNCTION || (env.WOODSHED_CLOUD_LAUNCHER === 'ecs' ? 'woodshed-cloud-webhooks' : ''),
    ghToken: app || broker || !readGhToken ? null : ghToken(env),
    // Where sessions fetch GitHub tokens; only with an App, and only on an address sessions can reach.
    sessionApi: { host: env.WOODSHED_CLOUD_SESSION_API_HOST || null, port: number(env.WOODSHED_CLOUD_SESSION_API_PORT, 7691) },
  };
}

// What a tenant of a multi-tenant console (hosted.mjs) may set, in loadConfig's own keys and shapes. Everything else is
// the process's (host, port, publicUrl, appDomain, the session API) or Woodshed's own default.
const TENANT_NUMBERS = ['maxRunning', 'maxPrivatePerPerson', 'maxAsks', 'pollMs', 'fallbackPollMs'];
const TENANT_LIMITS = ['idleMs', 'lifetimeMs', 'startTimeoutMs', 'askIdleMs', 'askLifetimeMs'];
const TENANT_RETENTION = ['afterCloseMs', 'withoutPrMs', 'openPrMs', 'slackGiveUpMs', 'qaWaitMs', 'removeAfterDeleteMs'];
const TENANT_KEYS = new Set([
  'projects', 'sessionApiUrl', 'sessionEnv', 'label', 'limits', 'retention', 'envFiles', 'installSecrets', 'dbEnvSecrets',
  'actionsWorkflows', 'pollGitHub', 'launcher', 'tunnelTargets', ...TENANT_NUMBERS,
]);

function positiveNumbers(value, keys, where) {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${where} must be an object`);
  const out = {};
  for (const [key, n] of Object.entries(value)) {
    if (!keys.includes(key)) throw new Error(`${where}.${key} is not a setting (${keys.join(', ')})`);
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw new Error(`${where}.${key} must be a number of ms`);
    out[key] = n;
  }
  return out;
}

function stringMap(value, where) {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${where} must be an object of strings`);
  for (const [key, text] of Object.entries(value)) {
    if (typeof text !== 'string') throw new Error(`${where}.${key} must be a string`);
  }
  return { ...value };
}

// The pairs config.mjs parses from the environment, given as the lists it parses them into.
function pairsSetting(list, where, [a, b]) {
  if (list === undefined) return '';
  if (!Array.isArray(list)) throw new Error(`${where} must be a list of { ${a}, ${b} }`);
  return list.map((entry) => {
    if (typeof entry?.[a] !== 'string' || typeof entry?.[b] !== 'string' || /,/.test(entry[a] + entry[b])) {
      throw new Error(`${where}: each entry is { ${a}, ${b} }, strings with no comma`);
    }
    return `${entry[a]}=${entry[b]}`;
  }).join(',');
}

function sessionApiUrlOf(value) {
  if (value === undefined || value === null) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('settings.sessionApiUrl is not a URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('settings.sessionApiUrl must be http(s)');
  return url.href.replace(/\/+$/, '');
}

/**
 * One tenant's installation config in a multi-tenant console: loadConfig's defaults, the process's own settings, and
 * what the host gives for the tenant (`tenant.settings`), checked as the environment's values are. A setting the
 * console does not know stops the tenant, naming it, rather than being ignored.
 * @param {{process: {host: string, port: number, publicUrl: string, appDomain?: string, sessionApi?: object,
 *          tlsAskPort?: number|null}, tenant: {id: string, settings?: object}, stateDir: string,
 *          projectFilesDir?: string|null, githubSource: object, launcherKind?: string}} args
 * @returns {object}  a config in loadConfig's shape
 */
export function tenantConfig({ process: given, tenant, stateDir, projectFilesDir = null, githubSource, launcherKind = 'docker' }) {
  const settings = tenant.settings ?? {};
  if (typeof settings !== 'object' || Array.isArray(settings)) throw new Error('settings must be an object');
  const unknown = Object.keys(settings).filter((key) => !TENANT_KEYS.has(key));
  if (unknown.length) throw new Error(`settings: ${unknown.join(', ')} ${unknown.length > 1 ? 'are not settings' : 'is not a setting'} a tenant has`);
  const env = {
    WOODSHED_CLOUD_ENV_FILES: pairsSetting(settings.envFiles, 'settings.envFiles', ['secret', 'path']),
    WOODSHED_CLOUD_INSTALL_SECRETS: pairsSetting(settings.installSecrets, 'settings.installSecrets', ['secret', 'variable']),
    WOODSHED_CLOUD_ACTIONS_WORKFLOWS: pairsSetting(settings.actionsWorkflows, 'settings.actionsWorkflows', ['label', 'file']),
  };
  const base = loadConfig(env, { readGhToken: false });
  const projects = settings.projects === undefined ? [] : projectsFrom(
    // As WOODSHED_CLOUD_PROJECTS, but the first is the default when none says it is.
    Array.isArray(settings.projects) && settings.projects.length > 1 && !settings.projects.some((p) => p?.default === true)
      ? settings.projects.map((p, i) => ({ ...p, default: i === 0 }))
      : settings.projects,
    'settings.projects',
  );
  for (const key of TENANT_NUMBERS) {
    if (settings[key] !== undefined && (typeof settings[key] !== 'number' || !(settings[key] > 0))) throw new Error(`settings.${key} must be a positive number`);
  }
  if (settings.label !== undefined && (typeof settings.label !== 'string' || !/^[\w .:-]{1,50}$/.test(settings.label))) throw new Error('settings.label must be a GitHub label');
  if (settings.dbEnvSecrets !== undefined && (!Array.isArray(settings.dbEnvSecrets) || !settings.dbEnvSecrets.every((n) => typeof n === 'string' && /^[a-z0-9-]+$/.test(n)))) {
    throw new Error('settings.dbEnvSecrets must be a list of secret names');
  }
  const sessionApiUrl = sessionApiUrlOf(settings.sessionApiUrl);
  const sessionEnv = stringMap(settings.sessionEnv, 'settings.sessionEnv');
  const launcher = stringMap(settings.launcher, 'settings.launcher');
  const tunnelTargets = stringMap(settings.tunnelTargets, 'settings.tunnelTargets');
  return {
    ...base,
    ...Object.fromEntries(TENANT_NUMBERS.filter((key) => settings[key] !== undefined).map((key) => [key, settings[key]])),
    host: given.host,
    port: given.port,
    publicUrl: String(given.publicUrl).replace(/\/+$/, ''),
    extraHosts: [],
    appDomain: String(given.appDomain ?? '').trim().toLowerCase(),
    tlsAskPort: null,
    // The host signs people in (tenancy.identify), always: nobody is the person at the keyboard (server.mjs, soloLoginOf).
    requireSignIn: true,
    localLogin: null,
    trustedIdentitySecret: null,
    stateDir,
    projects,
    projectFilesDir,
    label: settings.label ?? base.label,
    dbEnvSecrets: settings.dbEnvSecrets ?? [],
    pollGitHub: settings.pollGitHub ?? true,
    limits: { ...base.limits, ...positiveNumbers(settings.limits, TENANT_LIMITS, 'settings.limits') },
    ...(settings.retention !== undefined ? { retention: positiveNumbers(settings.retention, TENANT_RETENTION, 'settings.retention') } : {}),
    launcher: { ...base.launcher, ...launcher, kind: launcherKind },
    // Where this tenant's sessions reach the one session API: the entrypoint, statusd and gh read it from here.
    sessionEnv: { ...sessionEnv, ...(sessionApiUrl ? { WOODSHED_CONSOLE_URL: sessionApiUrl } : {}) },
    sessionApiUrl,
    sessionApi: { host: given.sessionApi?.host ?? null, port: given.sessionApi?.port ?? 7691 },
    tunnelTargets: { pg: tunnelTargets.pg ?? null, mongo: tunnelTargets.mongo ?? null },
    githubApp: null,
    githubBroker: { source: githubSource },
    ghToken: null,
    // Nothing of the local provider's or AWS's: the host hands each tenant its services instead.
    secrets: null, localSecretsDir: null, localSecretsKeyFile: null, localHomesDir: null, homesBucket: null,
    localDatabases: null, localWebhooks: null, localDockerNetwork: null, webhookQueue: '', webhookFunction: '',
    // Session links name the tenant, so whoever opens one lands in its org (hosted.mjs).
    org: tenant.id,
  };
}
