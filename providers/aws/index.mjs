// The AWS provider, through the AWS CLI: session containers and db-admin runs as Fargate tasks (ecsLauncher.mjs,
// dbAdminRunner.mjs), secrets in Secrets Manager (secretStore.mjs), Claude homes in S3 (homeStore.mjs), and webhooks
// through the Lambda's URL into an SQS queue (webhookUrl.mjs, webhookQueue.mjs). Its infrastructure is ./terraform.
import { createDbAdminRunner } from './dbAdminRunner.mjs';
import { awsCli, ecsLauncher } from './ecsLauncher.mjs';
import { createHomeStore } from './homeStore.mjs';
import { secretSpecs } from '../../console/secrets.mjs';
import { createSecretStore } from './secretStore.mjs';
import { serviceUrlReader, sessionServiceEnv } from './services.mjs';
import { createWebhookQueue } from './webhookQueue.mjs';
import { createWebhookUrl } from './webhookUrl.mjs';

// What the console's pages say about where a session runs (console/providerWords.mjs lists each).
export const AWS_WORDS = {
  startSteps: {
    machine: ['Getting a machine from AWS', 'getting a machine'],
    pullStarted: ['Waiting for AWS to start it', 'waiting for AWS'],
    container: ['Pulling the session image', 'pulling the image'],
  },
  // ECS refusing a task for the account's Fargate quota or the region's capacity (NO_ROOM_RE in console/fleet.mjs).
  noRoom: {
    title: 'Waiting for AWS',
    line: 'Waiting for AWS to have room.',
    detail: 'AWS has no room for another session right now. The console tries again every minute.',
  },
  capacityNote: 'AWS has a ceiling of its own: the account\'s Fargate vCPU quota, at 2 vCPU a session. A start AWS has no room for waits in the queue, says why, and is tried again a minute later.',
  homesPlace: 'S3',
  databasesPlace: 'RDS and Mongo',
  webhookReceiver: 'the webhook function',
  webhookUrlFix: 'run terraform apply, then open this again',
  // awsProvider names the installation's own function here.
  webhookLog: 'aws logs tail /aws/lambda/<name_prefix>-webhooks',
};

const PLACES = { postgres: 'RDS', mongo: 'Mongo' };

/**
 * The databases the db-admin task makes, which Terraform's `databases` names twice: in WOODSHED_DATABASES, and
 * by setting the task's family only when there is one. A console told one and not the other stops at start.
 * @param {{dbAdminTaskDefinition?: string|null, databases?: string[]|null}} ecs
 * @returns {string[]}
 */
export function awsDatabases({ dbAdminTaskDefinition = null, databases = null }) {
  if (databases === null) {
    throw new Error('WOODSHED_DATABASES is not set: the base box\'s stack sets it from Terraform\'s databases, so run terraform apply');
  }
  if (Boolean(dbAdminTaskDefinition) !== databases.length > 0) {
    throw new Error(dbAdminTaskDefinition
      ? 'WOODSHED_ECS_DB_ADMIN_TASK_DEFINITION is set, and WOODSHED_DATABASES names no database for it to make'
      : `WOODSHED_DATABASES names ${databases.join(', ')}, and there is no WOODSHED_ECS_DB_ADMIN_TASK_DEFINITION to make them`);
  }
  return databases;
}

/**
 * @param {{launcher: {ecs: {dbAdminTaskDefinition?: string|null, databases?: string[]|null}}, secrets: {prefix: string}|null, stateDir: string,
 *          homesBucket: string|null, webhookQueue: string, webhookFunction: string, envFiles: {secret: string}[]}} config
 *   loadConfig()'s
 */
/**
 * The launcher, with each session on the default project given the base box's services (services.mjs). A file the box
 * left that cannot be read stops the start: a session without its services would fail later, and less plainly.
 * @param {ReturnType<typeof ecsLauncher>} launcher
 * @param {ReturnType<typeof serviceUrlReader>} services
 */
export function withServices(launcher, services) {
  return { ...launcher, start: (sessionId, env) => launcher.start(sessionId, { ...env, ...sessionServiceEnv(services(), env) }) };
}

export function awsProvider(config) {
  const { ecs } = config.launcher;
  const databases = awsDatabases(ecs);
  const services = serviceUrlReader(config.stateDir);
  return {
    name: 'aws',
    words: {
      ...AWS_WORDS,
      databasesPlace: databases.map((d) => PLACES[d]).join(' and ') || null,
      ...(config.webhookFunction && { webhookLog: `aws logs tail /aws/lambda/${config.webhookFunction}` }),
    },
    databases,
    launcher: withServices(ecsLauncher(ecs), services),
    secrets: config.secrets ? createSecretStore({ prefix: config.secrets.prefix, aws: awsCli, specs: secretSpecs({ envFiles: config.envFiles, installSecrets: config.installSecrets }) }) : null,
    homes: config.homesBucket ? createHomeStore({ bucket: config.homesBucket, aws: awsCli }) : null,
    dbAdmin: ecs.dbAdminTaskDefinition ? createDbAdminRunner({ ecs, aws: awsCli, services }) : null,
    webhooks: config.webhookQueue ? createWebhookQueue({ queue: config.webhookQueue, aws: awsCli }) : null,
    webhookUrl: config.webhookFunction ? createWebhookUrl({ functionName: config.webhookFunction, aws: awsCli }) : null,
  };
}
