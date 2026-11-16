// A person's own files: whole files they keep on My settings (an `app/.env.production`, a tool's config) that
// every one of their My Woodshed sessions writes into its checkout at start. The console checks a path when it is saved
// (console/userSettings.mjs) and the session again before it writes one (session/ownFiles.mjs), so a path from an older
// console, or one written straight into the secret store, is held to the same rules.

export const MAX_OWN_FILES = 20;
export const MAX_OWN_FILE_PATH = 200;
// Every file in one secret, as JSON. What a store with no declared `maxValueBytes` holds: Secrets Manager's limit on one value.
export const DEFAULT_MAX_VALUE_BYTES = 65_536;
// A save's JSON-escaped body can be bigger than the files in it; the page's body limit is never below this.
const MIN_BODY_BYTES = 160 * 1024;
const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** @returns {number}  the most bytes a save's request body may have, for a store holding `maxValueBytes` in one value */
export function ownFilesBodyLimit(maxValueBytes) {
  const limit = Number.isFinite(maxValueBytes) && maxValueBytes > 0 ? maxValueBytes : DEFAULT_MAX_VALUE_BYTES;
  return Math.min(MAX_BODY_BYTES, Math.max(MIN_BODY_BYTES, Math.ceil(limit * 2.5)));
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
