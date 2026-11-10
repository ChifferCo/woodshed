// The local secret store's key, and how a record is sealed with it: AES-256-GCM, a fresh IV each time, and the
// secret's name as associated data, so a file copied or renamed to stand in for another secret does not open.
//
// The key is 32 random bytes, base64, in a file of its own (WOODSHED_LOCAL_SECRETS_KEY_FILE) that only its owner
// can read, outside the secrets folder: a copy of the folder alone, such as a backup, then gives nothing away. It
// does not protect against someone who can act as the console's user, who can read the key too.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
export const SEALED_VERSION = 1;

function within(dir, file) {
  const rel = path.relative(dir, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * @param {{file: string, secretsDir: string}} opts
 * @returns {Buffer}  the key, or throws saying what is wrong with its file
 */
export function readKey({ file, secretsDir }) {
  const resolved = path.resolve(file);
  if (within(path.resolve(secretsDir), resolved)) throw new Error(`the secrets key ${file} is inside the secrets folder: keep it apart, or a copy of the folder carries its key`);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`no secrets key at ${file}: make one with \`secret.mjs new-key ${file}\``);
    throw err;
  }
  if (stat.mode & 0o077) throw new Error(`the secrets key ${file} can be read by others (mode ${(stat.mode & 0o777).toString(8)}): chmod 600 it`);
  const key = Buffer.from(fs.readFileSync(resolved, 'utf8').trim(), 'base64');
  if (key.length !== KEY_BYTES) throw new Error(`the secrets key ${file} is not ${KEY_BYTES} bytes of base64`);
  return key;
}

/** Writes a new key, readable by its owner only; never over one that is there, whose secrets would be lost. */
export function writeNewKey(file) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${crypto.randomBytes(KEY_BYTES).toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
}

/** @returns {{v: number, iv: string, tag: string, data: string}} */
export function seal(key, name, record) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(name, 'utf8'));
  const data = Buffer.concat([cipher.update(JSON.stringify(record), 'utf8'), cipher.final()]);
  return { v: SEALED_VERSION, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function unopenable(message) {
  return Object.assign(new Error(message), { unopenable: true });
}

/**
 * @returns {object}  the record, or throws (`unopenable`) when the key, the name or the file is not the one it was
 *   sealed with, a damaged IV or tag included
 */
export function open(key, name, sealed) {
  if (sealed?.v !== SEALED_VERSION) throw unopenable(`secret ${name}: not a sealed record this store reads`);
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(String(sealed.iv), 'base64'));
    decipher.setAAD(Buffer.from(name, 'utf8'));
    decipher.setAuthTag(Buffer.from(String(sealed.tag), 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8'));
  } catch {
    throw unopenable(`secret ${name} does not open: another key, or a file changed or moved from another secret's name`);
  }
}

/** @returns {boolean}  whether a file's JSON is a sealed record, not a plain `{ value, … }` one */
export function isSealed(parsed) {
  return Boolean(parsed && typeof parsed === 'object' && 'v' in parsed && 'data' in parsed);
}
