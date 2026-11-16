// What each person sets on My settings, kept apart by GitHub login. Values live in Secrets Manager under
// `users/<login>/`, write-only on the page; state.json keeps only when each was saved, so a page load never
// calls AWS. Only a private session of the same login is ever handed one (sessionApi.mjs), and the Claude token not
// even that: the console's Anthropic proxy adds it to the session's calls (anthropicProxy.mjs).
//
//   users/<login>/claude-token   from `claude setup-token`: the person's own Claude plan
//   users/<login>/codex-auth     the person's own Codex sign-in: an OpenAI API key, or the ~/.codex/auth.json of `codex login`.
//                                Handed to their private Codex sessions, which write a refreshed login back (sessionApi.mjs)
//   users/<login>/<env secret>   their own lines for each of the repo's env files (a secret's name, as api-env) and
//   users/<login>/tmux-conf      ~/.tmux.conf, which their sessions write after the console's shared file, so a change to
//                                that still reaches them. Readable by them, since their sessions hold the same text anyway
//   users/<login>/own-files/<key>  each of their own whole files (an app/.env.production), a secret for each, named from
//                                its path (ownFileKey in shared/ownFiles.mjs) and gzipped where that is smaller, which their
//                                sessions write into the checkout where git ignores them (session/ownFiles.mjs). Readable
//                                by them. `users/<login>/own-files` itself held all of them as one JSON before: it is split
//                                into a secret for each on a save or at the console's start (splitOldOwnFiles)
//   users/<login>/github         their GitHub user token, from Connect GitHub (githubUser.mjs), as JSON
//   users/<login>/database       the password of their own databases' user (databases.mjs)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import logins from './public/logins.cjs';
import { SETTINGS, settingProblem } from './consoleSettings.mjs';
import {
  MAX_OWN_FILES, MAX_OWN_FILE_BYTES, ownFileKey, ownFilePath, ownFilePathProblem, packOwnFile, sizeWords, storeValueLimit, unpackOwnFile,
} from '../shared/ownFiles.mjs';
const { loginKey } = logins;

const CLAUDE_TOKEN = 'claude-token';
const CODEX_AUTH = 'codex-auth';
const GITHUB = 'github';
// Every own file as one JSON, as they were kept before each had a secret of its own under OWN_FILES_DIR.
const OLD_OWN_FILES = 'own-files';
const OWN_FILES_DIR = 'own-files';
// How many of a person's own files are read at once.
const READS_AT_ONCE = 4;
const MAX_IDENTITY_CHARS = 200;
const MAX_TOKEN_CHARS = 1000;
const MAX_CODEX_AUTH_CHARS = 20_000;
// Secrets Manager's limit on one value.
const MAX_FILE_BYTES = 65_536;
const HOUR_MS = 3_600_000;
// How often a page load asks the secret store whether a person's Claude token or Codex sign-in is there (refresh): My
// Woodshed polls every few seconds, and on AWS each read is an `aws` CLI call. A start or resume asks every time.
const FRESH_MS = 60_000;
// The console settings a person may override for their own My Woodshed sessions, with the same ranges.
const OWN_LIMIT_KEYS = ['idleHours', 'lifetimeHours'];
const OWN_LIMITS = SETTINGS.filter((setting) => OWN_LIMIT_KEYS.includes(setting.key));
const TMUX_DEFAULT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'session', 'tmux.conf');

const TMUX_FILE = { label: '~/.tmux.conf' };

/**
 * The files a person may add their own lines to: the repo's env files, each the console's shared secret for it (set on
 * the Secrets & webhooks page) with the file's path for its label, and tmux's, which is the session image's own
 * tmux.conf (the console image carries it too). An embedding program whose store keeps an env file's secret under
 * another name than the project file's gives that as `name`, and `repo` for a file of one repo only, so two repos'
 * `api-env` are two files here, each labelled with its repo (console/README.md, "Embedding the console").
 * @param {{secret: string, path: string, name?: string, repo?: string}[]} envFiles  config.mjs's
 * @returns {Record<string, {label: string, secret?: string, name?: string, repo?: string}>}
 */
export function filesOf(envFiles) {
  return {
    ...Object.fromEntries(envFiles.map(({ secret, path: file, name, repo }) => [secret, {
      label: repo ? `${file} (${repo})` : file, secret, name: name ?? secret, ...(repo && { repo }),
    }])),
    'tmux-conf': TMUX_FILE,
  };
}

/**
 * @param {unknown} text
 * @returns {string}  the lines to store, with Windows line endings made Unix ones; empty when there are none
 * @throws {Error}  with a message the page can show
 */
export function checkFile(text) {
  if (typeof text !== 'string') throw Object.assign(new Error('the file must be text'), { shown: true });
  const file = text.replace(/\r\n/g, '\n');
  if (!file.trim()) return '';
  if (Buffer.byteLength(file) > MAX_FILE_BYTES) throw Object.assign(new Error('the file is over the 64 KB a secret can hold'), { shown: true });
  return file;
}

/**
 * @returns {Record<string, {savedAt: string, bytes?: number}>}  each own file's record, by path: when it was saved and its
 *   text's size. One saved before the sizes is its time alone
 */
function ownFileRecords(record) {
  // No prototype: a path is any name, `__proto__` among them.
  const kept = Object.create(null);
  for (const [file, value] of Object.entries(record?.ownFiles ?? {})) kept[file] = typeof value === 'string' ? { savedAt: value } : { ...value };
  return kept;
}

/** @returns {string}  the secret's name under the console's prefix */
export function userSecretName(login, key) {
  return `users/${loginKey(login)}/${key}`;
}

/**
 * @param {unknown} value
 * @returns {string}  the token to store
 * @throws {Error}  with a message the page can show, never containing the value
 */
export function checkClaudeToken(value) {
  if (typeof value !== 'string') throw Object.assign(new Error('the token must be text'), { shown: true });
  // `claude setup-token` wraps the token across the terminal's lines, so a copy of it often holds line breaks and
  // spaces. A token has none of its own.
  const token = value.replace(/\s+/g, '');
  if (!token) throw Object.assign(new Error('paste the token first'), { shown: true });
  if (token.length > MAX_TOKEN_CHARS || !token.startsWith('sk-ant-')) {
    throw Object.assign(new Error('this is not a token from claude setup-token: those start with sk-ant-'), { shown: true });
  }
  return token;
}

/**
 * @param {unknown} value  an OpenAI API key, or the text of ~/.codex/auth.json
 * @returns {string}  what to store: the key alone, or the auth file as one line of JSON
 * @throws {Error}  with a message the page can show, never containing the value
 */
export function checkCodexAuth(value) {
  if (typeof value !== 'string') throw Object.assign(new Error('the sign-in must be text'), { shown: true });
  const text = value.trim();
  if (!text) throw Object.assign(new Error('paste your Codex sign-in first'), { shown: true });
  if (text.length > MAX_CODEX_AUTH_CHARS) throw Object.assign(new Error('that is too long for a Codex sign-in'), { shown: true });
  if (/^sk-[^\s]+$/.test(text)) return text;
  let auth;
  try {
    // zsh ends output with no final newline in a `%`, which a copy of `cat ~/.codex/auth.json` takes along.
    auth = JSON.parse(text.replace(/\}\s*%$/, '}'));
  } catch {
    throw Object.assign(new Error('paste an OpenAI API key (sk-…) or the contents of ~/.codex/auth.json'), { shown: true });
  }
  if (typeof auth !== 'object' || auth === null || Array.isArray(auth) || !(auth.tokens?.refresh_token || auth.OPENAI_API_KEY)) {
    throw Object.assign(new Error('that is not a Codex auth.json: run codex login, then paste ~/.codex/auth.json'), { shown: true });
  }
  return JSON.stringify(auth);
}

/**
 * @param {unknown} values  `{idleHours, lifetimeHours}`; a key left out or null goes back to the console's number
 * @returns {Record<string, number>}  the overrides to keep
 * @throws {Error}  with a message the page can show
 */
export function checkLimits(values) {
  if (typeof values !== 'object' || values === null || Array.isArray(values)) throw Object.assign(new Error('the limits must be an object'), { shown: true });
  const out = {};
  for (const setting of OWN_LIMITS) {
    const value = values[setting.key];
    if (value === undefined || value === null || value === '') continue;
    const problem = settingProblem(setting, value);
    if (problem) throw Object.assign(new Error(problem), { shown: true });
    out[setting.key] = Number(value);
  }
  return out;
}

/**
 * @param {{name: unknown, email: unknown}} identity  what a person's commits say, from My settings
 * @returns {{name: string, email: string}}
 * @throws {Error}  with a message the page can show
 */
export function checkIdentity({ name, email }) {
  const n = String(name ?? '').trim();
  const e = String(email ?? '').trim();
  if (!n || n.length > MAX_IDENTITY_CHARS || /[<>\n]/.test(n)) throw Object.assign(new Error('the name must be one line, without < or >'), { shown: true });
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(e) || e.length > MAX_IDENTITY_CHARS) throw Object.assign(new Error('that is not an email address'), { shown: true });
  return { name: n, email: e };
}

/**
 * @param {{store: {state: object, save: () => void}, secrets: {read: Function, save: Function, remove: Function}|null,
 *          envFiles?: {secret: string, path: string, name?: string, repo?: string}[],
 *          appendedFor?: (secret: string, repo?: string) => Promise<string[]>,
 *          now?: () => number}} deps  `secrets` is null where the console has no Secrets Manager: nothing can be saved.
 *   `appendedFor` names the variables the entrypoint always writes after an env file (writeEnvFiles in session/entrypoint.sh),
 *   shown on the page so nobody spends time setting them: they would lose
 */
export function createUserSettings({ store, secrets, envFiles = [], appendedFor = async () => [], now = Date.now }) {
  const FILES = filesOf(envFiles);
  function people() {
    store.state.people ??= {};
    return store.state.people;
  }

  function recordFor(login) {
    return people()[loginKey(login)] ?? null;
  }

  function touch(login, fields) {
    const key = loginKey(login);
    people()[key] = { ...people()[key], ...fields };
    store.save();
  }

  // When each person's store was last asked about their sign-ins (refresh), by login key.
  const askedAt = new Map();

  /**
   * A Claude token or Codex sign-in that is in the secret store counts as saved, whoever put it there: a token written
   * straight into the store as `users/<login>/claude-token`, beside the console, counts as one saved on My settings. The
   * record here, which the pages read without calling the store, follows what is there. A store that fails to answer
   * changes nothing, and is not asked again until the minute is up.
   * @param {string} login
   * @param {{force?: boolean}} [opts]  true asks now, for a start or resume that needs the answer
   */
  async function refresh(login, { force = false } = {}) {
    if (!login || !secrets || secrets.configured?.() === false) return;
    const key = loginKey(login);
    const record = recordFor(login);
    if (!force && now() - (askedAt.get(key) ?? -Infinity) < FRESH_MS) return;
    askedAt.set(key, now());
    let token;
    let codex;
    try {
      [token, codex] = await Promise.all([secrets.read(userSecretName(login, CLAUDE_TOKEN)), secrets.read(userSecretName(login, CODEX_AUTH))]);
    } catch (err) {
      console.warn('userSettings: stored sign-ins not read', { login, message: String(err?.message ?? err).split('\n')[0] });
      return;
    }
    const at = new Date(now()).toISOString();
    const changes = {};
    if (Boolean(token) !== Boolean(record?.claudeTokenAt)) changes.claudeTokenAt = token ? at : null;
    if (Boolean(codex) !== Boolean(record?.codexAuthAt)) changes.codexAuthAt = codex ? at : null;
    if (!Object.keys(changes).length) return;
    touch(login, changes);
    console.log('userSettings: sign-ins follow the secret store', { login, claudeToken: Boolean(token), codexAuth: Boolean(codex) });
  }

  function requireSecrets() {
    if (!secrets) throw Object.assign(new Error('this console has no secret store, so My settings cannot be saved'), { shown: true });
  }

  /**
   * @returns {{claudeToken: {set: boolean, savedAt: string|null}, codexAuth: {set: boolean, savedAt: string|null}, files: Record<string, {custom: boolean, savedAt: string|null}>,
   *            setUp: boolean, available: boolean}}
   */
  function view(login) {
    const record = recordFor(login);
    const files = Object.fromEntries(Object.keys(FILES).map((key) => {
      const savedAt = record?.files?.[key] ?? null;
      return [key, { custom: Boolean(savedAt), savedAt, label: FILES[key].label }];
    }));
    const github = record?.github;
    return {
      claudeToken: { set: Boolean(record?.claudeTokenAt), savedAt: record?.claudeTokenAt ?? null },
      codexAuth: { set: Boolean(record?.codexAuthAt), savedAt: record?.codexAuthAt ?? null },
      ownTokenForShared: record?.ownTokenForShared !== false,
      limits: { ...record?.limits },
      github: { connected: Boolean(github?.connectedAt), connectedAt: github?.connectedAt ?? null, name: github?.name ?? null, email: github?.email ?? null },
      home: { saved: Boolean(record?.home?.savedAt), savedAt: record?.home?.savedAt ?? null, bytes: record?.home?.bytes ?? 0 },
      files,
      ownFiles: Object.entries(ownFileRecords(record)).map(([file, kept]) => ({ path: file, ...kept })).sort((a, b) => a.path.localeCompare(b.path)),
      ownFileLimit: storeValueLimit(secrets),
      setUp: Boolean(record),
      available: Boolean(secrets) && secrets.configured?.() !== false,
    };
  }

  function requireFile(key) {
    if (!FILES[key]) throw Object.assign(new Error(`no file called ${key}`), { shown: true });
  }

  /** @returns {Promise<string>}  the console's shared file: what every session starts from */
  async function sharedFile(key) {
    requireFile(key);
    if (!FILES[key].secret) return fs.readFileSync(TMUX_DEFAULT, 'utf8');
    return (secrets ? await secrets.read(FILES[key].secret) : null) ?? '';
  }

  /** @returns {Promise<string|null>}  the person's own lines, or null while they have none */
  async function ownFile(login, key) {
    requireFile(key);
    if (!secrets || !recordFor(login)?.files?.[key]) return null;
    return secrets.read(userSecretName(login, key));
  }

  /**
   * @returns {Promise<{key: string, label: string, text: string, custom: boolean, sharedText: string, editable: boolean,
   *                    appended: string[]}>}  `editable` when the shared file is one of the console's secrets
   */
  async function file(login, key) {
    const [own, sharedText] = await Promise.all([ownFile(login, key), sharedFile(key)]);
    return {
      key, label: FILES[key].label, text: own ?? '', custom: own !== null, sharedText, editable: Boolean(FILES[key].secret),
      appended: FILES[key].secret ? await appendedFor(FILES[key].name, FILES[key].repo) : [],
    };
  }

  async function saveFile(login, key, text) {
    requireSecrets();
    requireFile(key);
    const value = checkFile(text);
    if (!value) return resetFile(login, key);
    await secrets.save(userSecretName(login, key), value, `Woodshed: @${login}'s ${FILES[key].label}, for their My Woodshed sessions only`);
    const record = recordFor(login);
    touch(login, { files: { ...record?.files, [key]: new Date(now()).toISOString() } });
    console.log('userSettings: file saved', { login, key, bytes: Buffer.byteLength(value) });
  }

  async function resetFile(login, key) {
    requireSecrets();
    requireFile(key);
    await secrets.remove(userSecretName(login, key));
    const record = recordFor(login);
    touch(login, { files: { ...record?.files, [key]: null } });
    console.log('userSettings: own lines cleared', { login, key });
  }

  const ownFileName = (login, file) => userSecretName(login, `${OWN_FILES_DIR}/${ownFileKey(file)}`);
  const ownFileDescription = (login, file) => `Woodshed: @${login}'s ${file}, one of their own files, for their My Woodshed sessions only`;

  /**
   * @returns {Promise<{files: Record<string, string>, readable: boolean}|null>}  the old single secret's files by path, as
   *   plain text; null when there is none, and `readable: false` for one that is not JSON, which is left for a person
   */
  async function oldOwnFiles(login) {
    const value = await secrets.read(userSecretName(login, OLD_OWN_FILES));
    if (!value) return null;
    let files;
    try {
      files = JSON.parse(value);
    } catch {
      files = null;
    }
    if (!files || typeof files !== 'object' || Array.isArray(files)) {
      console.warn('userSettings: the old own files secret is not JSON, left as it is', { login });
      return { files: {}, readable: false };
    }
    return { files: Object.fromEntries(Object.entries(files).filter(([file, text]) => typeof text === 'string' && !ownFilePathProblem(file))), readable: true };
  }

  /**
   * The person's files as stored, by path: each one's own secret, or, until the old single secret is split, its text for
   * a file with no secret of its own yet.
   * @returns {Promise<Record<string, string>>}  each packed or plain, as packOwnFile left it
   */
  async function storedOwnFiles(login) {
    const record = recordFor(login);
    const paths = Object.keys(ownFileRecords(record));
    if (!secrets || !paths.length) return {};
    const values = [];
    // A few at a time: on AWS each read is a CLI process of its own.
    for (let i = 0; i < paths.length; i += READS_AT_ONCE) {
      values.push(...await Promise.all(paths.slice(i, i + READS_AT_ONCE).map((file) => secrets.read(ownFileName(login, file)))));
    }
    const missing = paths.filter((_, i) => values[i] === null);
    const old = missing.length && !record.ownFilesPerSecret ? (await oldOwnFiles(login))?.files ?? {} : {};
    const files = {};
    paths.forEach((file, i) => {
      if (values[i] !== null) files[file] = values[i];
      else if (Object.hasOwn(old, file)) files[file] = packOwnFile(old[file]);
    });
    const fromOld = missing.filter((file) => Object.hasOwn(old, file));
    if (fromOld.length) console.log('userSettings: own files read from the old single secret', { login, paths: fromOld });
    const lost = missing.filter((file) => !Object.hasOwn(old, file));
    if (lost.length) console.warn('userSettings: own files with no secret', { login, paths: lost });
    return files;
  }

  /** @returns {Promise<Record<string, string>>}  the person's own whole files, by path, as text; {} while they have none */
  async function ownWholeFiles(login) {
    const files = {};
    for (const [file, value] of Object.entries(await storedOwnFiles(login))) {
      try {
        files[file] = unpackOwnFile(value);
      } catch (err) {
        console.warn('userSettings: own file does not unpack', { login, path: file, message: String(err?.message ?? err).split('\n')[0] });
      }
    }
    return files;
  }

  // One split at a time for each person: the start's and a save's must not both copy a file.
  const splitting = new Map();

  /**
   * Splits the old single secret of a person's files into a secret for each, never over one already there (a newer
   * save), and deletes it once every file has its own. Until then, reads fall back to it.
   * @returns {Promise<boolean>}  true when every file of theirs is in a secret of its own
   */
  function splitOldOwnFiles(login) {
    const key = loginKey(login);
    if (!splitting.has(key)) splitting.set(key, splitNow(login).finally(() => splitting.delete(key)));
    return splitting.get(key);
  }

  async function splitNow(login) {
    if (!secrets) return false;
    const record = recordFor(login);
    if (record?.ownFilesPerSecret) return true;
    const old = await oldOwnFiles(login);
    if (!old) {
      if (record) touch(login, { ownFilesPerSecret: true });
      return true;
    }
    if (!old.readable) return false;
    const limit = storeValueLimit(secrets);
    const kept = ownFileRecords(record);
    const at = new Date(now()).toISOString();
    let copied = 0;
    let there = 0;
    const tooBig = [];
    // A file the old secret holds but the record does not was removed, or never listed on the page.
    const files = Object.entries(old.files).filter(([file]) => Object.hasOwn(kept, file));
    for (const [file, text] of files) {
      const name = ownFileName(login, file);
      if (await secrets.read(name) !== null) {
        there++;
      } else {
        const value = packOwnFile(text);
        if (Buffer.byteLength(value) > limit) {
          tooBig.push(file);
          continue;
        }
        await secrets.save(name, value, ownFileDescription(login, file));
        copied++;
      }
      kept[file] = { savedAt: kept[file]?.savedAt ?? at, bytes: kept[file]?.bytes ?? Buffer.byteLength(text) };
    }
    touch(login, { ownFiles: Object.keys(kept).length ? kept : null });
    if (tooBig.length) {
      console.warn('userSettings: old own files secret kept, some files are over the store\'s limit', { login, copied, alreadyThere: there, paths: tooBig, limit });
      return false;
    }
    await secrets.remove(userSecretName(login, OLD_OWN_FILES));
    touch(login, { ownFilesPerSecret: true });
    console.log('userSettings: old own files secret split, a secret for each file', { login, copied, alreadyThere: there, dropped: Object.keys(old.files).length - files.length });
    return true;
  }

  /** At the console's start: everyone whose files may still be in the old single secret. */
  async function splitEveryonesOldOwnFiles() {
    if (!secrets || secrets.configured?.() === false) return;
    const logins = Object.keys(people()).filter((key) => Object.keys(people()[key]?.ownFiles ?? {}).length && !people()[key].ownFilesPerSecret);
    let split = 0;
    let left = 0;
    for (const login of logins) {
      try {
        if (await splitOldOwnFiles(login)) split++;
        else left++;
      } catch (err) {
        left++;
        console.warn('userSettings: old own files not split', { login, message: String(err?.message ?? err).split('\n')[0] });
      }
    }
    if (logins.length) console.log('userSettings: old own files secrets checked at start', { people: logins.length, split, left });
  }

  /**
   * Adds, replaces or (with empty text) removes one of the person's own files, each a secret of its own.
   * @throws {Error}  with a message the page can show
   */
  async function saveOwnFile(login, file, text) {
    requireSecrets();
    const problem = ownFilePathProblem(file);
    if (problem) throw Object.assign(new Error(problem), { shown: true });
    const key = ownFilePath(file);
    const envFile = envFiles.find((f) => f.path === key);
    if (envFile) throw Object.assign(new Error(`${key} is one of the repo's env files: add your lines to it under Env files and tmux`), { shown: true });
    if (text !== undefined && typeof text !== 'string') throw Object.assign(new Error('the file must be text'), { shown: true });
    const value = String(text ?? '').replace(/\r\n/g, '\n');
    const bytes = Buffer.byteLength(value);
    if (bytes > MAX_OWN_FILE_BYTES) throw Object.assign(new Error(`a file can be ${sizeWords(MAX_OWN_FILE_BYTES)} at most`), { shown: true });
    const split = await splitOldOwnFiles(login);
    const kept = ownFileRecords(recordFor(login));
    const name = ownFileName(login, key);
    if (!value.trim()) {
      await secrets.remove(name);
      delete kept[key];
      touch(login, { ownFiles: Object.keys(kept).length ? kept : null });
      console.log('userSettings: own file removed', { login, path: key, files: Object.keys(kept).length });
      // The file the old secret could not be split for may be this one.
      if (!split) await splitOldOwnFiles(login);
      return;
    }
    if (!Object.hasOwn(kept, key) && Object.keys(kept).length >= MAX_OWN_FILES) throw Object.assign(new Error(`you can keep ${MAX_OWN_FILES} files at most`), { shown: true });
    const stored = packOwnFile(value);
    const storedBytes = Buffer.byteLength(stored);
    const limit = storeValueLimit(secrets);
    if (storedBytes > limit) {
      console.log('userSettings: own file refused, over the store\'s limit', { login, path: key, bytes, storedBytes, limit });
      throw Object.assign(new Error(`${key} is ${sizeWords(storedBytes)} even compressed, over the ${sizeWords(limit)} this console's secret store holds for one file`), { shown: true });
    }
    await secrets.save(name, stored, ownFileDescription(login, key));
    kept[key] = { savedAt: new Date(now()).toISOString(), bytes };
    touch(login, { ownFiles: kept });
    console.log('userSettings: own file saved', { login, path: key, bytes, storedBytes, compressed: stored !== value, files: Object.keys(kept).length });
  }

  /** Every own file's secret, and the old single one, for Remove My Woodshed. */
  async function removeOwnFiles(login) {
    const paths = new Set(Object.keys(ownFileRecords(recordFor(login))));
    for (const file of Object.keys((await oldOwnFiles(login))?.files ?? {})) paths.add(file);
    for (const file of paths) {
      if (!ownFilePathProblem(file)) await secrets.remove(ownFileName(login, file));
    }
    await secrets.remove(userSecretName(login, OLD_OWN_FILES));
    console.log('userSettings: own files removed', { login, files: paths.size });
  }

  /** @returns {Promise<object|null>}  what githubUser.mjs kept from Connect GitHub, or null when not connected */
  async function githubCredentials(login) {
    if (!secrets || !recordFor(login)?.github?.connectedAt) return null;
    const value = await secrets.read(userSecretName(login, GITHUB));
    return value ? JSON.parse(value) : null;
  }

  /** @param {{name: string, email: string}} [identity]  only on connecting; a refresh keeps what they had */
  async function saveGitHub(login, credentials, identity) {
    requireSecrets();
    await secrets.save(userSecretName(login, GITHUB), JSON.stringify(credentials), `Woodshed: @${login}'s GitHub user token, for their My Woodshed sessions only`);
    const github = recordFor(login)?.github;
    touch(login, { github: { ...github, connectedAt: github?.connectedAt ?? new Date(now()).toISOString(), ...identity } });
  }

  async function forgetGitHub(login) {
    if (secrets) await secrets.remove(userSecretName(login, GITHUB));
    touch(login, { github: null });
  }

  async function setGitIdentity(login, identity) {
    const github = recordFor(login)?.github;
    if (!github?.connectedAt) throw Object.assign(new Error('connect GitHub first: until then your sessions commit as woodshed-bot'), { shown: true });
    touch(login, { github: { ...github, ...checkIdentity(identity) } });
    console.log('userSettings: git identity changed', { login });
  }

  /** @returns {{name: string, email: string}|null}  what a private session's commits say, once GitHub is connected */
  function gitIdentity(login) {
    const github = recordFor(login)?.github;
    return github?.connectedAt && github.name && github.email ? { name: github.name, email: github.email } : null;
  }

  /** The saved Claude home itself is in the provider's home store; this notes when, and how big, for My settings. */
  function noteHome(login, bytes) {
    if (!recordFor(login)) return;
    touch(login, { home: bytes ? { savedAt: new Date(now()).toISOString(), bytes } : null });
  }

  /**
   * Each file's own lines for a private session on `repo`, by the name its project file gives the file, which is what
   * the session looks them up by (writeEnvFiles in shared/project.mjs); null is none. A file of another repo is left
   * out, and one of this repo wins over one for every repo of the same name.
   * @param {string} login
   * @param {{repo?: string}} [opts]  the session's repo, owner/name
   * @returns {Promise<Record<string, string|null>>}
   */
  async function ownFiles(login, { repo } = {}) {
    const sameRepo = (key) => FILES[key].repo?.toLowerCase() === String(repo ?? '').toLowerCase();
    const keys = Object.keys(FILES).filter((key) => !FILES[key].repo || sameRepo(key));
    const values = await Promise.all(keys.map((key) => ownFile(login, key)));
    const files = {};
    keys.forEach((key, i) => {
      const name = FILES[key].name ?? key;
      if (!(name in files) || FILES[key].repo) files[name] = values[i];
    });
    return files;
  }

  async function setClaudeToken(login, value) {
    requireSecrets();
    const token = checkClaudeToken(value);
    await secrets.save(userSecretName(login, CLAUDE_TOKEN), token, `Woodshed: @${login}'s Claude token, for their My Woodshed sessions only`);
    touch(login, { claudeTokenAt: new Date(now()).toISOString() });
    console.log('userSettings: Claude token saved', { login });
  }

  async function removeClaudeToken(login) {
    requireSecrets();
    await secrets.remove(userSecretName(login, CLAUDE_TOKEN));
    touch(login, { claudeTokenAt: null });
    console.log('userSettings: Claude token removed', { login });
  }

  async function setCodexAuth(login, value) {
    requireSecrets();
    const auth = checkCodexAuth(value);
    await secrets.save(userSecretName(login, CODEX_AUTH), auth, `Woodshed: @${login}'s Codex sign-in, for their My Woodshed Codex sessions only`);
    touch(login, { codexAuthAt: new Date(now()).toISOString() });
    console.log('userSettings: Codex sign-in saved', { login, apiKey: !auth.startsWith('{') });
  }

  async function removeCodexAuth(login) {
    requireSecrets();
    await secrets.remove(userSecretName(login, CODEX_AUTH));
    touch(login, { codexAuthAt: null });
    console.log('userSettings: Codex sign-in removed', { login });
  }

  /** @returns {Promise<string|null>}  the person's Codex sign-in for their own session; null when none is saved */
  async function codexAuth(login) {
    await refresh(login);
    if (!secrets || !recordFor(login)?.codexAuthAt) return null;
    return secrets.read(userSecretName(login, CODEX_AUTH));
  }

  /**
   * The switch under the token: whether the shared sessions this person starts from GitHub run on their own plan.
   * On unless they turned it off: a record from before it defaulted on has no field, so it reads as on too.
   * @throws {Error}  shown on the page, when it is turned on with no token saved
   */
  function setOwnTokenForShared(login, on) {
    if (on && !recordFor(login)?.claudeTokenAt) throw Object.assign(new Error('save your Claude token first'), { shown: true });
    touch(login, { ownTokenForShared: Boolean(on) });
    console.log('userSettings: own token for shared sessions', { login, on: Boolean(on) });
  }

  /** @returns {boolean}  the switch is on and a token is saved: a token removed later turns it off in effect */
  function usesOwnTokenForShared(login) {
    const record = recordFor(login);
    return Boolean(record?.ownTokenForShared !== false && record?.claudeTokenAt);
  }

  /** Replaces the person's own idle and lifetime hours; an empty object goes back to the console's numbers. */
  function setLimits(login, values) {
    const limits = checkLimits(values);
    touch(login, { limits: Object.keys(limits).length ? limits : null });
    console.log('userSettings: own session limits changed', { login, ...limits });
  }

  /** @returns {{idleMs?: number, lifetimeMs?: number}}  what the person set for their own sessions; keys they did not are absent */
  function limitsFor(login) {
    const limits = recordFor(login)?.limits;
    return {
      ...(limits?.idleHours && { idleMs: limits.idleHours * HOUR_MS }),
      ...(limits?.lifetimeHours && { lifetimeMs: limits.lifetimeHours * HOUR_MS }),
    };
  }

  /** @returns {Promise<string|null>}  the person's token: their private session's, or a shared one's they started; null when none is saved */
  async function claudeToken(login) {
    await refresh(login);
    if (!secrets || !recordFor(login)?.claudeTokenAt) return null;
    return secrets.read(userSecretName(login, CLAUDE_TOKEN));
  }

  /** Deletes everything this person saved, the secrets first, so a failure leaves the record to try again from. */
  async function removeAll(login) {
    if (secrets) {
      await removeOwnFiles(login);
      for (const key of [CLAUDE_TOKEN, CODEX_AUTH, GITHUB, 'database', ...Object.keys(FILES)]) await secrets.remove(userSecretName(login, key));
    }
    delete people()[loginKey(login)];
    store.save();
    console.log('userSettings: everything removed', { login });
  }

  return {
    view, refresh, askedAbout: (login) => askedAt.has(loginKey(login)), setClaudeToken, removeClaudeToken, claudeToken, setCodexAuth, removeCodexAuth, codexAuth, setOwnTokenForShared, usesOwnTokenForShared, setLimits, limitsFor, file, saveFile, resetFile, ownFiles, ownWholeFiles, ownFilesForSession: storedOwnFiles, saveOwnFile, splitEveryonesOldOwnFiles,
    githubCredentials, saveGitHub, forgetGitHub, setGitIdentity, gitIdentity, noteHome, removeAll,
  };
}
