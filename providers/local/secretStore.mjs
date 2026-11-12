// The local provider's secret store: the console's secrets (console/secrets.mjs, secretSpecs) as files in one folder on
// the console's machine, which only the console's user can open. The same calls as the AWS store
// (../aws/secretStore.mjs), so the Secrets page, sign-in and the GitHub App key work the same on either.
//
// Each secret is `<dir>/<name>.json`: its record, `{ value, description, changedAt }`, sealed with the store's key
// (secretKey.mjs), written to a temporary file and renamed over the old one, so a crash mid-write leaves the old
// value. There is no previous version, as AWSPREVIOUS keeps. A record still in plain JSON, as files were written
// before the key, is read and sealed in its place.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { readSecretFile, secretFile } from '../../shared/fileSecrets.mjs';
import { isSealed, open, seal } from './secretKey.mjs';

function isNotFound(err) {
  return err?.code === 'ENOENT';
}

/**
 * @param {{dir: string, key: Buffer, specs: object[], now?: () => number}} opts  `dir` is made, readable by its owner only, if it is not
 *   there; `key` is readKey()'s; `specs` is secretSpecs()'s
 */
export function createSecretStore({ dir, key, specs, now = Date.now }) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('the secret store needs its 32-byte key');
  const root = path.resolve(dir);

  const fileOf = (name) => secretFile(root, name);

  // One change to a secret's file at a time: a write, a removal, or sealing a plain one. The sealing pass reads a
  // plain file and writes it back sealed, so a value saved in between would otherwise be put back to the old one.
  const changing = new Map();
  function oneAtATime(name, fn) {
    const run = (changing.get(name) ?? Promise.resolve()).then(fn);
    const settled = run.catch(() => {});
    changing.set(name, settled);
    settled.then(() => {
      if (changing.get(name) === settled) changing.delete(name);
    });
    return run;
  }

  async function store(name, record) {
    const file = fileOf(name);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.chmod(root, 0o700);
    // A name of its own: two writes of one secret at once (the start's sealing pass and a first read) must not share it.
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(seal(key, name, record)), { mode: 0o600 });
    await fs.rename(tmp, file);
  }

  // Inside oneAtATime only: a plain file is read again there, so what is sealed is what is on disk now.
  async function loadForChange(name) {
    const parsed = await readSecretFile(root, name);
    if (!parsed) return null;
    if (isSealed(parsed)) return open(key, name, parsed);
    await store(name, parsed);
    console.warn('secrets: a plain file was sealed with the key', { name });
    return parsed;
  }

  async function load(name) {
    const parsed = await readSecretFile(root, name);
    if (!parsed) return null;
    if (isSealed(parsed)) return open(key, name, parsed);
    return oneAtATime(name, () => loadForChange(name));
  }

  /**
   * Seals every record still in plain JSON, the console's whole folder, as it starts: one no page reads, such as a
   * person's, would otherwise stay readable in a copy of the folder until it was next read.
   * @returns {Promise<number>}  how many were sealed
   */
  async function sealPlainFiles() {
    const files = await fs.readdir(root, { recursive: true }).catch((err) => {
      if (isNotFound(err)) return [];
      throw err;
    });
    let sealed = 0;
    let skipped = 0;
    for (const file of files.filter((f) => f.endsWith('.json'))) {
      const name = file.slice(0, -'.json'.length).split(path.sep).join('/');
      // One file it cannot read, such as one named outside the store's names, is left for a person; the rest go on.
      try {
        const wasPlain = await oneAtATime(name, async () => {
          const parsed = await readSecretFile(root, name);
          if (!parsed || isSealed(parsed)) return false;
          await store(name, parsed);
          return true;
        });
        if (wasPlain) sealed++;
      } catch (err) {
        skipped++;
        console.warn('secrets: a file was left as it is by the sealing pass', { file, message: err.message });
      }
    }
    console.log('secrets: plain files sealed at start', { sealed, skipped });
    return sealed;
  }

  // The record a new value replaces, for its description. One that does not open is replaced all the same: that is how
  // the Secrets page puts it right.
  async function previous(name) {
    try {
      return await loadForChange(name);
    } catch (err) {
      if (!err.unopenable) throw err;
      console.warn('secrets: replacing a secret that does not open', { name });
      return null;
    }
  }

  /**
   * One that does not open is listed as not set, with why, so the page still shows the rest and can replace it.
   * @returns {Promise<{name: string, group: string, kind: string, readable: boolean, exists: boolean,
   *                    set: boolean, description: string, changedAt: string|null, error?: string}[]>}
   */
  async function list() {
    return Promise.all(specs.map(async (spec) => {
      let record;
      try {
        record = await load(spec.name);
      } catch (err) {
        if (!err.unopenable) throw err;
        console.warn('secrets: a secret does not open', { name: spec.name });
        return { ...spec, exists: true, set: false, description: '', changedAt: null, error: err.message };
      }
      if (!record) return { ...spec, exists: false, set: false, description: '', changedAt: null };
      return { ...spec, exists: true, set: typeof record.value === 'string', description: record.description ?? '', changedAt: record.changedAt ?? null };
    }));
  }

  /** @returns {Promise<string|null>}  the current value, or null while it has none */
  async function read(name) {
    return (await load(name))?.value ?? null;
  }

  // Unlike Secrets Manager, where Terraform makes each of the specs empty first, a first write makes the file.
  async function write(name, value) {
    await oneAtATime(name, async () => {
      const record = await previous(name);
      await store(name, { value, description: record?.description ?? '', changedAt: new Date(now()).toISOString() });
      console.log('secrets: new version saved', { name, bytes: Buffer.byteLength(value), created: !record });
    });
  }

  /**
   * For secrets nothing makes ahead, such as each person's own under `users/`: a new value, or the secret itself
   * the first time, with its description.
   */
  async function save(name, value, description) {
    await oneAtATime(name, async () => {
      const record = await previous(name);
      await store(name, { value, description: record?.description || description, changedAt: new Date(now()).toISOString() });
      console.log(record ? 'secrets: new version saved' : 'secrets: created', { name, bytes: Buffer.byteLength(value) });
    });
  }

  /**
   * The names of the secrets in one folder of names, not below it: `repos/app/env` lists `repos/app/env/api-env`.
   * @returns {Promise<string[]>}  sorted; none for a folder that is not there
   */
  async function names(folder) {
    const dir = fileOf(folder).replace(/\.json$/, '');
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
    return entries.filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => `${folder}/${e.name.slice(0, -'.json'.length)}`).sort();
  }

  /** Deletes a secret at once; one that is already gone is not an error. */
  async function remove(name) {
    await oneAtATime(name, async () => {
      try {
        await fs.unlink(fileOf(name));
        console.log('secrets: deleted', { name });
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    });
  }

  return { list, read, write, save, remove, names, sealPlainFiles };
}
