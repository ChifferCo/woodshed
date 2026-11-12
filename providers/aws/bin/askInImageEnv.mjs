// The environment askInImage.mjs gives the session image: what the ECS task definition gives an AWS session
// (../terraform/ecs.tf), so a start can be tried before it ships.
/**
 * @param {{installSecrets?: {variable: string}[]}} opts  the installation's install secrets (config.mjs's installSecrets)
 * @returns {string[]}  the task definition's secrets, by the variable each arrives in (ecs.tf's session_secrets): the
 *   install secrets'. A repo's env files are not among them: a session gets those from the console (repo settings)
 */
export function taskDefinitionSecrets({ installSecrets = [] }) {
  return installSecrets.map(({ variable }) => variable);
}

/**
 * @param {{installSecrets?: {variable: string}[], port: number}} opts
 * @returns {Record<string, string>}  the session API on the host, each secret with a value the entrypoint must unset
 *   for an ask, and WOODSHED_INSTALL_SECRETS when there are install secrets. No database or shared service: an ask
 *   reads none (runAsk in session/entrypoint.sh)
 */
export function taskDefinitionEnv({ installSecrets = [], port }) {
  const installVariables = installSecrets.map(({ variable }) => variable).sort().join(' ');
  return {
    WOODSHED_CONSOLE_URL: `http://host.docker.internal:${port}`,
    ...(installVariables ? { WOODSHED_INSTALL_SECRETS: installVariables } : {}),
    ...Object.fromEntries(taskDefinitionSecrets({ installSecrets }).map((name) => [name, 'ASK_IN_IMAGE=must-be-unset'])),
  };
}

/**
 * @param {{installSecrets?: {variable: string}[]}} opts
 * @returns {string}  an extended regex matching a line of `tmux show-environment` that still holds one of the secrets
 */
export function leakPattern(opts) {
  return `^(${[...taskDefinitionSecrets(opts), 'GH_TOKEN'].join('|')})=`;
}
