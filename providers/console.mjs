// Starts the console on a provider: `node woodshed/providers/console.mjs`, which the console image runs. The one place
// a provider is picked; the console itself is handed it (console/server.mjs, startConsole).
//
// WOODSHED_PROVIDER is `aws` or `local`. Without it, WOODSHED_CLOUD_LAUNCHER says, as it always has: `ecs` is AWS, and
// `docker` (its default) is local.
import { loadConfig, requireClosedWhenReachable, requireRepo } from '../console/config.mjs';
import { startConsole } from '../console/server.mjs';
import { isMain } from '../shared/isMain.mjs';
import { awsProvider } from './aws/index.mjs';
import { localProvider } from './local/index.mjs';

const PROVIDERS = { aws: awsProvider, local: localProvider };

/** @returns {'aws'|'local'} */
export function providerName(env = process.env) {
  const name = env.WOODSHED_PROVIDER || (env.WOODSHED_CLOUD_LAUNCHER === 'ecs' ? 'aws' : 'local');
  if (!(name in PROVIDERS)) throw new Error(`unknown WOODSHED_PROVIDER "${name}" (expected ${Object.keys(PROVIDERS).join(' or ')})`);
  const launcher = env.WOODSHED_CLOUD_LAUNCHER || 'docker';
  if ((name === 'aws') !== (launcher === 'ecs')) {
    throw new Error(`WOODSHED_PROVIDER=${name} needs WOODSHED_CLOUD_LAUNCHER=${name === 'aws' ? 'ecs' : 'docker'} (it is ${launcher})`);
  }
  return name;
}

// What only one provider serves: a setting that asks for it on another stops the start, naming it, rather than
// being ignored, or failing later on the first call that needs it.
const NEEDS = {
  aws: [
    ['homesBucket', 'WOODSHED_CLOUD_HOMES_BUCKET'],
    ['webhookQueue', 'WOODSHED_CLOUD_WEBHOOK_QUEUE'],
    ['webhookFunction', 'WOODSHED_CLOUD_WEBHOOK_FUNCTION'],
  ],
  local: [
    ['localSecretsDir', 'WOODSHED_LOCAL_SECRETS_DIR'],
    ['localSecretsKeyFile', 'WOODSHED_LOCAL_SECRETS_KEY_FILE'],
    ['localHomesDir', 'WOODSHED_LOCAL_HOMES_DIR'],
    ['localDatabases', 'WOODSHED_LOCAL_DB_*'],
    ['localWebhooks', 'WOODSHED_LOCAL_WEBHOOK_PORT'],
    ['localDockerNetwork', 'WOODSHED_LOCAL_DOCKER_NETWORK'],
    // The console would read the installation's project files while AWS's tasks, which are not given them, read none.
    ['projectFilesDir', 'WOODSHED_CLOUD_PROJECT_FILES_DIR'],
  ],
};

export function createProvider(config, env = process.env) {
  const name = providerName(env);
  for (const [owner, settings] of Object.entries(NEEDS)) {
    if (owner === name) continue;
    const asked = settings.filter(([key]) => config[key]).map(([, setting]) => setting);
    if (asked.length) throw new Error(`${asked.join(', ')} ${asked.length > 1 ? 'need' : 'needs'} the ${owner} provider; this console runs on the ${name} provider`);
  }
  return PROVIDERS[name](config);
}

function cannotStart(err) {
  console.error('console: could not start', { message: err?.message });
  process.exit(1);
}

if (isMain(import.meta.url)) {
  let config;
  let provider;
  // A setting that is wrong, such as a secrets folder without its key, is said in one line, not a stack trace.
  try {
    config = loadConfig();
    requireRepo(config);
    requireClosedWhenReachable(config);
    provider = createProvider(config);
  } catch (err) {
    cannotStart(err);
  }
  // Woodshed's Update starts the code it pulled this far before restarting onto it (console/woodshedUpdate.mjs): every
  // module loaded, the settings read and the provider made, nothing listening or written.
  if (process.env.WOODSHED_CLOUD_START_CHECK === '1') {
    console.log('console: start check passed', { provider: provider.name });
    process.exit(0);
  }
  console.log('console: provider', { name: provider.name });
  startConsole({ provider, config }).catch(cannotStart);
}
