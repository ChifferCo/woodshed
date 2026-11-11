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
//   users/<login>/own-files    their own whole files (an app/.env.production), as JSON {"<path>": "<text>"}, which their
//                                sessions write into the checkout where git ignores them (session/ownFiles.mjs). Readable by them
//   users/<login>/github         their GitHub user token, from Connect GitHub (githubUser.mjs), as JSON
//   users/<login>/database       the password of their own databases' user (databases.mjs)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import logins from './public/logins.cjs';
import { SETTINGS, settingProblem } from './consoleSettings.mjs';
import { MAX_OWN_FILES, MAX_OWN_FILES_BYTES, ownFilePath, ownFilePathProblem } from '../shared/ownFiles.mjs';
const { loginKey } = logins;

const CLAUDE_TOKEN = 'claude-token';
const CODEX_AUTH = 'codex-auth';
const GITHUB = 'github';
const OWN_FILES = 'own-files';
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
 * tmux.conf (the console image carries it too).
 * @param {{secret: string, path: string}[]} envFiles  config.mjs's
 * @returns {Record<string, {label: string, secret?: string}>}
 */
export function filesOf(envFiles) {
  return { ...Object.fromEntries(envFiles.map(({ secret, path: file }) => [secret, { label: file, secret }])), 'tmux-conf': TMUX_FILE };
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
    auth = JSON.parse(text);
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
 *          envFiles?: {secret: string, path: string}[], appendedFor?: (secret: string) => Promise<string[]>,
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
      ownFiles: Object.entries(record?.ownFiles ?? {}).map(([file, savedAt]) => ({ path: file, savedAt })).sort((a, b) => a.path.localeCompare(b.path)),
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
      appended: FILES[key].secret ? await appendedFor(FILES[key].secret) : [],
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

  /** @returns {Promise<Record<string, string>>}  the person's own whole files, by path; {} while they have none */
  async function ownWholeFiles(login) {
    if (!secrets || !Object.keys(recordFor(login)?.ownFiles ?? {}).length) return {};
    const value = await secrets.read(userSecretName(login, OWN_FILES));
    if (!value) return {};
    try {
      const files = JSON.parse(value);
      return files && typeof files === 'object' && !Array.isArray(files) ? files : {};
    } catch {
      console.warn('userSettings: own files not read, the secret is not JSON', { login });
      return {};
    }
  }

  /**
   * Adds, replaces or (with empty text) removes one of the person's own files. All of them are one secret, so a save
   * writes them all.
   * @returns {Promise<Record<string, string>>}  their files after the change
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
    const files = await ownWholeFiles(login);
    if (value.trim()) files[key] = value;
    else delete files[key];
    if (Object.keys(files).length > MAX_OWN_FILES) throw Object.assign(new Error(`you can keep ${MAX_OWN_FILES} files at most`), { shown: true });
    const json = JSON.stringify(files);
    if (Buffer.byteLength(json) > MAX_OWN_FILES_BYTES) throw Object.assign(new Error('your files together are over the 64 KB a secret can hold'), { shown: true });
    if (Object.keys(files).length) await secrets.save(userSecretName(login, OWN_FILES), json, `Woodshed: @${login}'s own files, for their My Woodshed sessions only`);
    else await secrets.remove(userSecretName(login, OWN_FILES));
    const record = recordFor(login);
    const at = new Date(now()).toISOString();
    const kept = Object.fromEntries(Object.keys(files).map((f) => [f, f === key ? at : record?.ownFiles?.[f] ?? at]));
    touch(login, { ownFiles: Object.keys(kept).length ? kept : null });
    console.log(value.trim() ? 'userSettings: own file saved' : 'userSettings: own file removed', { login, path: key, files: Object.keys(files).length, ...(value.trim() && { bytes: Buffer.byteLength(value) }) });
    return files;
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

  /** @returns {Promise<Record<string, string|null>>}  each file's own lines for a private session; null is none */
  async function ownFiles(login) {
    const keys = Object.keys(FILES);
    const values = await Promise.all(keys.map((key) => ownFile(login, key)));
    return Object.fromEntries(keys.map((key, i) => [key, values[i]]));
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
      for (const key of [CLAUDE_TOKEN, CODEX_AUTH, GITHUB, OWN_FILES, 'database', ...Object.keys(FILES)]) await secrets.remove(userSecretName(login, key));
    }
    delete people()[loginKey(login)];
    store.save();
    console.log('userSettings: everything removed', { login });
  }

  return {
    view, refresh, askedAbout: (login) => askedAt.has(loginKey(login)), setClaudeToken, removeClaudeToken, claudeToken, setCodexAuth, removeCodexAuth, codexAuth, setOwnTokenForShared, usesOwnTokenForShared, setLimits, limitsFor, file, saveFile, resetFile, ownFiles, ownWholeFiles, saveOwnFile,
    githubCredentials, saveGitHub, forgetGitHub, setGitIdentity, gitIdentity, noteHome, removeAll,
  };
}
