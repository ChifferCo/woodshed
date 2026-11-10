// Secrets as files, one `<dir>/<name>.json` each, `{ value, description, changedAt }`: what a local db-admin run reads
// (session/dbAdmin.mjs) from the folder its runner fills (providers/local/dbAdminRunner.mjs). The local provider's own
// store keeps the same names, each record sealed with its key (providers/local/secretStore.mjs).
import fs from 'node:fs/promises';
import path from 'node:path';

// `users/<login>/database` and the like: path segments of plain characters, never `..` or an absolute path.
const NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;

/** @returns {string}  where a secret's file is, or throws for a name that would leave `dir` */
export function secretFile(dir, name) {
  if (typeof name !== 'string' || !NAME.test(name) || name.split('/').includes('..')) throw new Error(`not a secret name: ${name}`);
  return path.join(path.resolve(dir), `${name}.json`);
}

/** @returns {Promise<{value?: string, description?: string, changedAt?: string}|null>}  null when there is no file */
export async function readSecretFile(dir, name) {
  try {
    return JSON.parse(await fs.readFile(secretFile(dir, name), 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/** The read side alone, shaped like session/awsSecrets.mjs's client: `get` is a value, or null for none. */
export function fileSecretsClient({ dir }) {
  return {
    async get(name) {
      const value = (await readSecretFile(dir, name))?.value;
      return typeof value === 'string' ? value : null;
    },
  };
}
