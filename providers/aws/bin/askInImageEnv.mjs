// The environment askInImage.mjs gives the session image: what the ECS task definition gives an AWS session
// (../terraform/ecs.tf), so a start can be tried before it ships.
import { secretEnvName } from '../../../shared/project.mjs';

/**
 * @param {{project: {envFiles: {secret: string|null}[]}, installSecrets?: {variable: string}[]}} opts  the repo's
 *   project file, as loadProject reads it, and the installation's install secrets (config.mjs's installSecrets)
 * @returns {string[]}  the task definition's secrets, by the variable each arrives in: one per env file the project
 *   lists (ecs.tf's session_secrets, from the same names), then each install secret's
 */
export function taskDefinitionSecrets({ project, installSecrets = [] }) {
  return [
    ...project.envFiles.filter((file) => file.secret).map((file) => secretEnvName(file.secret)),
    ...installSecrets.map(({ variable }) => variable),
  ];
}

/**
 * @param {{project: object, installSecrets?: {variable: string}[], port: number}} opts
 * @returns {Record<string, string>}  the session API on the host, each secret with a value the entrypoint must unset
 *   for an ask, and WOODSHED_INSTALL_SECRETS when there are install secrets. No database or shared service: an ask
 *   reads none (runAsk in session/entrypoint.sh)
 */
export function taskDefinitionEnv({ project, installSecrets = [], port }) {
  const installVariables = installSecrets.map(({ variable }) => variable).sort().join(' ');
  return {
    WOODSHED_CONSOLE_URL: `http://host.docker.internal:${port}`,
    ...(installVariables ? { WOODSHED_INSTALL_SECRETS: installVariables } : {}),
    ...Object.fromEntries(taskDefinitionSecrets({ project, installSecrets }).map((name) => [name, 'ASK_IN_IMAGE=must-be-unset'])),
  };
}

/**
 * @param {{project: {envFiles: {secret: string|null}[]}, installSecrets?: {variable: string}[]}} opts
 * @returns {string}  an extended regex matching a line of `tmux show-environment` that still holds one of the secrets
 */
export function leakPattern(opts) {
  return `^(${[...taskDefinitionSecrets(opts), 'GH_TOKEN'].join('|')})=`;
}
