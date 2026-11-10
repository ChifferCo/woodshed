// The AWS provider's secret store: the console's secrets (console/secrets.mjs, secretSpecs) in Secrets Manager, through the
// AWS CLI. Each save is a new version, so AWSPREVIOUS keeps the one before it; a value goes to the CLI in a file only
// the console can read, deleted straight after, never on a command line.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function isNotFound(err) {
  return /ResourceNotFoundException/.test(String(err?.stderr ?? err?.message ?? ''));
}

/**
 * @param {{prefix: string, aws: (args: string[]) => Promise<any>, specs: object[]}} opts  `prefix` turns a name into its secret id (`woodshed-cloud/`);
 *   `specs` is secretSpecs()'s
 */
export function createSecretStore({ prefix, aws, specs }) {
  const idOf = (name) => `${prefix}${name}`;

  /**
   * @returns {Promise<{name: string, group: string, kind: string, readable: boolean, exists: boolean,
   *                    set: boolean, description: string, changedAt: string|null}[]>}
   */
  // One CLI call for all of them: a describe-secret each was six CLI processes at once, enough to
  // put the console's container over its memory limit.
  async function list() {
    const out = await aws(['secretsmanager', 'list-secrets', '--filters', `Key=name,Values=${prefix}`]);
    const found = new Map((out?.SecretList ?? []).map((s) => [s.Name, s]));
    return specs.map((spec) => {
      const secret = found.get(idOf(spec.name));
      if (!secret) return { ...spec, exists: false, set: false, description: '', changedAt: null };
      const stages = Object.values(secret.SecretVersionsToStages ?? {}).flat();
      return {
        ...spec, exists: true, set: stages.includes('AWSCURRENT'), description: secret.Description ?? '',
        // The CLI prints dates as ISO strings or epoch seconds, by its config.
        changedAt: secret.LastChangedDate ? new Date(typeof secret.LastChangedDate === 'number' ? secret.LastChangedDate * 1000 : secret.LastChangedDate).toISOString() : null,
      };
    });
  }

  /** @returns {Promise<string|null>}  the current value, or null while it has none */
  async function read(name) {
    try {
      const out = await aws(['secretsmanager', 'get-secret-value', '--secret-id', idOf(name)]);
      return out?.SecretString ?? null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  // The value goes through a file only this user can read, since anyone on the host can read a command line.
  // Not /dev/stdin: Node gives a child a socket for stdin, which opening /dev/stdin refuses (ENXIO).
  async function withValueFile(value, fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'woodshed-secret-'));
    const file = path.join(dir, 'value');
    try {
      await fs.writeFile(file, value, { mode: 0o600 });
      return await fn(`file://${file}`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  async function write(name, value) {
    await withValueFile(value, (file) => aws(['secretsmanager', 'put-secret-value', '--secret-id', idOf(name), '--secret-string', file]));
    console.log('secrets: new version saved', { name, bytes: Buffer.byteLength(value) });
  }

  /**
   * For secrets Terraform does not make, such as each person's own under `users/`: a new version, or the
   * secret itself the first time.
   * @param {string} name
   * @param {string} value
   * @param {string} description
   */
  async function save(name, value, description) {
    try {
      await write(name, value);
      return;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    await withValueFile(value, (file) => aws([
      'secretsmanager', 'create-secret', '--name', idOf(name), '--description', description,
      '--secret-string', file, '--tags', 'Key=project,Value=woodshed-cloud',
    ]));
    console.log('secrets: created', { name, bytes: Buffer.byteLength(value) });
  }

  /** Deletes a secret at once, with no recovery window; one that is already gone is not an error. */
  async function remove(name) {
    try {
      await aws(['secretsmanager', 'delete-secret', '--secret-id', idOf(name), '--force-delete-without-recovery']);
      console.log('secrets: deleted', { name });
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  return { list, read, write, save, remove };
}
