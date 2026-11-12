// Woodshed's settings were named WOODSHED_CLOUD_<NAME> before the project was called Woodshed. Each is read as
// WOODSHED_<NAME> first and under its old name after, which logs once that it is deprecated. Only names are ever
// logged, never a value: several of these settings are secrets. install.sh has the same reader for its stack.env.

export const OLD_PREFIX = 'WOODSHED_CLOUD_';

// Every setting renamed, without its prefix. The deploy workflow's own repository variables (WOODSHED_CLOUD_AWS_ROLE_ARN
// and the rest) are an installation's GitHub settings, not Woodshed's, and keep their names for now.
export const SETTINGS = Object.freeze([
  'ACTIONS_WORKFLOWS', 'APP_DOMAIN', 'APP_PORTS', 'CONSOLE_NAME', 'CONSOLE_URL', 'DATABASES', 'DB_ENV_SECRETS', 'ECS_CLUSTER',
  'ECS_DB_ADMIN_TASK_DEFINITION', 'ECS_LOG_GROUP', 'ECS_SECURITY_GROUP', 'ECS_SUBNETS', 'ECS_TASK_DEFINITION',
  'ENV_FILES', 'FALLBACK_POLL_SECONDS', 'GITHUB_APP_ID', 'GITHUB_APP_INSTALLATION_ID', 'GITHUB_APP_KEY_FILE',
  'GITHUB_BROKER_TOKEN_FILE', 'GITHUB_BROKER_URL', 'HOMES_BUCKET', 'HOST', 'HOSTS', 'IDLE_HOURS', 'IMAGE',
  'INSTALL_SECRETS', 'LABEL', 'LAUNCHER', 'LIFETIME_HOURS', 'LOCAL_LOGIN', 'MAX_SESSIONS', 'POLL_GITHUB',
  'POLL_SECONDS', 'PORT', 'PROJECTS', 'PROJECT_FILES_DIR', 'PUBLIC_URL', 'REPO', 'REQUIRE_SIGN_IN', 'SECRET_PREFIX',
  'SESSION_API_HOST', 'SESSION_API_PORT', 'SESSION_CPUS', 'SESSION_ENV_FILE', 'SESSION_MEMORY', 'STATE_DIR',
  'SUPERVISED', 'TLS_ASK_PORT', 'TRUSTED_IDENTITY_SECRET', 'TUNNEL_MONGO', 'TUNNEL_POSTGRES', 'WEBHOOK_FUNCTION',
  'WEBHOOK_QUEUE',
]);

// Two plain renames would land on a name a session already has with another meaning: WOODSHED_INSTALL_SECRETS lists
// the install secrets' variables, and WOODSHED_CONSOLE_URL is the session API's address.
const RENAMES = Object.freeze({
  INSTALL_SECRETS: 'WOODSHED_INSTALL_SECRET_PAIRS',
  CONSOLE_URL: 'WOODSHED_CONSOLE_WEB_URL',
});

const warned = new Set();

/** @param {string} name  the setting without its prefix, as `CONSOLE_NAME` @returns {string} its current name */
export function currentName(name) {
  return RENAMES[name] ?? `WOODSHED_${name}`;
}

/** @param {string} name  the setting without its prefix @returns {string} the name it had before */
export function oldName(name) {
  return OLD_PREFIX + name;
}

/**
 * @param {Record<string, string|undefined>} env
 * @param {string} name  the setting without its prefix, as `CONSOLE_NAME`
 * @returns {string|undefined}  its current name's value when that is set, even empty, or else its old name's
 */
export function envValue(env, name) {
  if (!SETTINGS.includes(name)) throw new Error(`envValue: ${name} is not one of Woodshed's settings`);
  const value = env[currentName(name)];
  if (value !== undefined) return value;
  const old = env[oldName(name)];
  if (old !== undefined && !warned.has(name)) {
    warned.add(name);
    console.warn(`config: deprecated variable, use ${currentName(name)}`, { name: oldName(name) });
  }
  return old;
}

/**
 * The value under both names, for what a console hands a session while an older session image, which reads only the
 * old name, may still be running.
 * @param {string} name  the setting without its prefix
 * @param {string} value
 * @returns {Record<string, string>}
 */
export function bothNames(name, value) {
  return { [currentName(name)]: value, [oldName(name)]: value };
}

/** @param {string} key @returns {boolean}  whether this variable is one of the settings, under either name */
export function isSettingName(key) {
  return key.startsWith(OLD_PREFIX) || SETTINGS.some((name) => key === currentName(name));
}
