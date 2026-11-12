// The local provider: everything on the console's own machine. Session containers in docker (dockerLauncher.mjs);
// when WOODSHED_LOCAL_SECRETS_DIR names a folder, the console's secrets in it (secretStore.mjs); when
// WOODSHED_LOCAL_HOMES_DIR does, saved Claude homes in it (homeStore.mjs); with WOODSHED_LOCAL_DB_*, each session's
// own copy of each database they give an address for, made by db-admin containers (dbAdminRunner.mjs); and with WOODSHED_LOCAL_WEBHOOK_PORT, GitHub's
// webhooks and Slack's events, received directly (webhookReceiver.mjs). Without that, the console polls GitHub.
import path from 'node:path';

import { checkoutDir, secretEnvName } from '../../shared/project.mjs';
import { defaultProject } from '../../console/projects.mjs';
import { secretSpecs } from '../../console/secrets.mjs';
import { createDbAdminRunner } from './dbAdminRunner.mjs';
import { createDockerLauncher } from './dockerLauncher.mjs';
import { createHomeStore } from './homeStore.mjs';
import { readKey } from './secretKey.mjs';
import { createSecretSlot } from './secretSlot.mjs';
import { createSecretStore } from './secretStore.mjs';
import { createWebhookReceiver } from './webhookReceiver.mjs';

// What a session gets from the store, by the variable its entrypoint reads: the same ones ECS hands an AWS session
// (../aws/terraform/ecs.tf, session_secrets). Each install secret arrives in the variable the installation names.
/**
 * @param {{envFiles: {secret: string}[], installSecrets?: {secret: string, variable: string}[]}} opts  loadConfig()'s
 * @returns {Record<string, string>}  each secret a session is handed, by the variable it arrives in
 */
export function sessionSecrets({ envFiles, installSecrets = [] }) {
  return {
    ...Object.fromEntries(envFiles.map(({ secret }) => [secretEnvName(secret), secret])),
    ...Object.fromEntries(installSecrets.map(({ secret, variable }) => [variable, secret])),
  };
}

/**
 * The launcher, with each session's secrets read from the store as it starts, so a value the Secrets page replaced
 * reaches the next session. One the console's own settings already set (WOODSHED_SESSION_ENV_FILE) stays. With
 * install secrets, WOODSHED_INSTALL_SECRETS lists their variables, as the task definition does on AWS.
 * @param {{launcher: object, secrets: {read: (name: string) => Promise<string|null>}, envFiles: {secret: string}[],
 *          installSecrets?: {secret: string, variable: string}[]}} opts
 */
export function withSessionSecrets({ launcher, secrets, envFiles, installSecrets = [] }) {
  const wanted = sessionSecrets({ envFiles, installSecrets });
  const installVariables = installSecrets.map(({ variable }) => variable).sort().join(' ');
  return {
    ...launcher,
    async start(sessionId, env) {
      const added = [];
      const full = installVariables ? { WOODSHED_INSTALL_SECRETS: installVariables, ...env } : { ...env };
      for (const [key, name] of Object.entries(wanted)) {
        if (key in full) continue;
        const value = await secrets.read(name);
        if (value !== null) {
          full[key] = value;
          added.push(name);
        }
      }
      console.log('local: session secrets from the store', { sessionId, added });
      return launcher.start(sessionId, full);
    },
  };
}

// Sealed with a key from its own file: a folder of plain secrets is not an option (secretKey.mjs).
function secretStore(config) {
  if (!config.localSecretsDir) return null;
  if (!config.localSecretsKeyFile) throw new Error('WOODSHED_LOCAL_SECRETS_DIR needs WOODSHED_LOCAL_SECRETS_KEY_FILE, the key its files are sealed with');
  const store = createSecretStore({ dir: config.localSecretsDir, specs: secretSpecs({ envFiles: config.envFiles, installSecrets: config.installSecrets }), key: readKey({ file: config.localSecretsKeyFile, secretsDir: config.localSecretsDir }) });
  store.sealPlainFiles().catch((err) => console.error('secrets: plain files not sealed', { message: err.message }));
  return store;
}

/** @returns {('postgres'|'mongo')[]}  the databases the WOODSHED_LOCAL_DB_* settings give an address for */
export function localDatabaseNames(localDatabases) {
  if (!localDatabases) return [];
  return [localDatabases.postgresHost && 'postgres', localDatabases.mongoHost && 'mongo'].filter(Boolean);
}

function dbAdmin(config, secrets) {
  if (!config.localDatabases) return null;
  // The root passwords and each database's own are secrets: there is nowhere else to keep them.
  if (!secrets) throw new Error('WOODSHED_LOCAL_DB_* needs WOODSHED_LOCAL_SECRETS_DIR, where the database passwords are kept');
  return createDbAdminRunner({
    image: config.launcher.image, repoDir: checkoutDir(defaultProject(config).repo), seedSecrets: config.dbEnvSecrets, seedProject: defaultProject(config).name, secrets, sessionEnv: config.sessionEnv,
    runsDir: path.join(config.stateDir, 'db-admin-runs'), ...config.localDatabases,
    projectFilesDir: config.projectFilesDir, repo: defaultProject(config).repo,
  });
}

function webhooks(config, secrets) {
  if (!config.localWebhooks) return { webhooks: null, webhookUrl: null };
  // Every delivery is checked against a signing secret, and those are kept in the store.
  if (!secrets) throw new Error('WOODSHED_LOCAL_WEBHOOK_PORT needs WOODSHED_LOCAL_SECRETS_DIR, where the webhook signing secrets are kept');
  const { host, port, url } = config.localWebhooks;
  return {
    webhooks: createWebhookReceiver({ host, port, secrets }),
    webhookUrl: url ? async () => `${url}/github` : null,
  };
}

const DATABASE_NAMES = { postgres: 'Postgres', mongo: 'Mongo' };

// Docker's size, as `--memory` takes it: `6g` reads 6 GB.
function readableSize(size) {
  return String(size).replace(/^(\d+(?:\.\d+)?)([kmg])b?$/i, (_, n, unit) => `${n} ${unit.toUpperCase()}B`);
}

/**
 * What the console's pages say about where a session runs (console/providerWords.mjs lists each). `docker run` pulls
 * the image when it is missing and starts the container in one call, so there is no wait for a pull of its own. A
 * start is never refused for room (console/fleet.mjs's NO_ROOM_RE matches only ECS): sessions wait only for the
 * Console settings limits, which the page words itself.
 * @param {{memory: string, cpus: string, databases?: string[]}} launcher  each container's limits, and the databases
 *   the console makes copies of
 */
export function localWords({ memory, cpus, databases = ['postgres', 'mongo'] }) {
  return {
    startSteps: {
      machine: ['Starting a container', 'starting a container'],
      pullStarted: null,
      container: ['Booting the container', 'booting'],
    },
    capacityNote: `Sessions are containers on the console's own machine, each held to ${readableSize(memory)} of memory and ${cpus} ${Number(cpus) === 1 ? 'CPU' : 'CPUs'}. Docker refuses none of them for room, so keep the limits to what the machine can hold.`,
    homesPlace: 'the homes folder',
    databasesPlace: databases.map((d) => DATABASE_NAMES[d]).join(' and ') || null,
    webhookReceiver: 'the console\'s webhook receiver',
    webhookUrlFix: 'set WOODSHED_LOCAL_WEBHOOK_URL to where GitHub reaches it, restart the console, then open this again',
    webhookLog: 'the console\'s log, its webhooks: lines',
  };
}

/**
 * @param {{launcher: {image: string, memory: string, cpus: string}, localSecretsDir: string|null, localHomesDir: string|null,
 *          localDatabases: object|null, localWebhooks: object|null, sessionEnv: Record<string, string>}} config  loadConfig()'s
 */
export function localProvider(config) {
  const { image, memory, cpus } = config.launcher;
  const docker = createDockerLauncher({
    image, memory, cpus, network: config.localDockerNetwork, projectFilesDir: config.projectFilesDir, repo: defaultProject(config).repo,
  });
  // The folder the settings name stays what it was. Without one, the dashboard's Secrets page picks the store.
  const fixed = secretStore(config);
  const secrets = fixed ?? createSecretSlot({ stateDir: config.stateDir, specs: secretSpecs({ envFiles: config.envFiles, installSecrets: config.installSecrets }) });
  const databases = localDatabaseNames(config.localDatabases);
  return {
    name: 'local',
    words: localWords({ memory, cpus, databases }),
    databases,
    launcher: withSessionSecrets({ launcher: docker, secrets, envFiles: config.envFiles, installSecrets: config.installSecrets }),
    secrets,
    homes: config.localHomesDir ? createHomeStore({ dir: config.localHomesDir }) : null,
    dbAdmin: dbAdmin(config, fixed),
    ...webhooks(config, fixed),
  };
}
