// A person's own files: whole files they keep on My settings (an `app/.env.production`, a tool's config) that
// every one of their My Woodshed sessions writes into its checkout at start. The console checks a path when it is saved
// (console/userSettings.mjs) and the session again before it writes one (session/ownFiles.mjs), so a path from an older
// console, or one written straight into the secret store, is held to the same rules.
//
// Each file is a secret of its own, `users/<login>/own-files/<key>` (ownFileKey), its text gzipped behind GZIP_MARKER
// when that is smaller (packOwnFile). The console checks what is stored against its store's own limit on one value
// (storeValueLimit), and the session unpacks it (unpackOwnFile) before it writes the file.

import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const MAX_OWN_FILES = 20;
export const MAX_OWN_FILE_PATH = 200;
// A file's own size, before it is packed: a sanity cap on what the page sends and a session unpacks.
export const MAX_OWN_FILE_BYTES = 4 * 1024 * 1024;
// What a secret store holds in one value when it does not say (`maxValueBytes`): Secrets Manager's 64 KB.
export const DEFAULT_MAX_VALUE_BYTES = 65_536;
export const GZIP_MARKER = 'woodshed-gzip:v1:';
// A key past this is cut, with a hash of the whole path after it: a file name is 255 bytes at most on most disks.
const MAX_KEY_CHARS = 120;
const ESCAPES = { _: '_u', '/': '_s', '@': '_a', '+': '_p', '-': '_m' };

/** @returns {number}  the most a store keeps in one value: its own `maxValueBytes`, or Secrets Manager's */
export function storeValueLimit(secrets) {
  const limit = secrets?.maxValueBytes;
  return Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_MAX_VALUE_BYTES;
}

/**
 * The secret's last name segment for a path. Letters, digits and `.` stay, the rest are escapes of `_`, so two paths
 * never share a key, and every store's names take it: no `/`, no leading `.`, no `-` (Secrets Manager reads a name
 * ending in `-` and six characters as part of an ARN). A long one keeps its start and adds a hash of the path.
 * @param {string} file  a path ownFilePathProblem accepts
 * @returns {string}
 */
export function ownFileKey(file) {
  const escaped = file.replace(/[_/@+-]/g, (c) => ESCAPES[c]);
  const key = escaped.startsWith('.') ? `_d${escaped.slice(1)}` : escaped;
  if (key.length <= MAX_KEY_CHARS) return key;
  const hash = crypto.createHash('sha256').update(file).digest('hex').slice(0, 20);
  return `${key.slice(0, 100).replace(/_$/, '')}_h${hash}`;
}

/** @returns {string}  what is stored for a file's text: gzipped behind the marker when that is smaller, else the text */
export function packOwnFile(text) {
  const packed = GZIP_MARKER + zlib.gzipSync(Buffer.from(text), { level: 9 }).toString('base64');
  // Text that starts with the marker itself is always packed, so it is never read as packed when it is not.
  return Buffer.byteLength(packed) < Buffer.byteLength(text) || text.startsWith(GZIP_MARKER) ? packed : text;
}

/**
 * @returns {string}  a stored value's text; one without the marker is the text itself, as values were before packing
 * @throws {Error}  for a packed value that does not unpack, or unpacks past MAX_OWN_FILE_BYTES
 */
export function unpackOwnFile(value) {
  if (!value.startsWith(GZIP_MARKER)) return value;
  return zlib.gunzipSync(Buffer.from(value.slice(GZIP_MARKER.length), 'base64'), { maxOutputLength: MAX_OWN_FILE_BYTES }).toString();
}

/** @returns {string}  a size in words, rounded up, so one just past a limit never reads as the limit: `64 KB`, `1.1 MB` */
export function sizeWords(bytes) {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${Math.ceil(bytes / 1024 / 1024 * 10) / 10} MB`;
}

/**
 * @param {unknown} value  a path in the repo, as the person typed it
 * @returns {string|null}  why it cannot be one of their files, or null when it can
 */
export function ownFilePathProblem(value) {
  if (typeof value !== 'string' || !value.trim()) return 'name the file by its path in the repo, as app/.env.production';
  const file = value.trim();
  if (file.length > MAX_OWN_FILE_PATH) return `a path can be ${MAX_OWN_FILE_PATH} characters at most`;
  if (file.startsWith('/') || file.startsWith('~')) return 'the path is in the repo: leave out the leading / or ~';
  if (!/^[A-Za-z0-9._@+-]+(\/[A-Za-z0-9._@+-]+)*$/.test(file)) return 'a path is letters, digits, . _ - @ + and / between its folders';
  const parts = file.split('/');
  if (parts.some((part) => part === '.' || part === '..')) return 'a path cannot have . or .. in it';
  if (parts[0] === '.git') return 'a file under .git is git\'s own';
  return null;
}

/** @returns {string}  the path as it is kept: trimmed */
export function ownFilePath(value) {
  return String(value).trim();
}
