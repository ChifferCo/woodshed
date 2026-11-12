// Repo settings: each repo's env file values and instructions that the installation's admins set (layer 2) and that
// each person sets for themselves (layer 3), kept in the console's secret store under per-repo names
// (shared/repoSettings.mjs says how the layers make a session's files and prompt):
//
//   repos/<project>/env/<key>                    the installation's lines for one of the repo's env files
//   repos/<project>/instructions                 the installation's instructions for the repo
//   users/<login>/repos/<project>/env/<key>      one person's own lines for that env file
//   users/<login>/repos/<project>/instructions   one person's own instructions for the repo
//
// `<key>` is the env file's key in the project file (`secret`, or one made from its path). state.json keeps, under
// `repoSettings.<project>` and `people.<login>.repos.<project>`, when each was saved, by whom, its size and the names of
// the keys it sets, never a value, so the pages need no secret read. The store is the truth: a record whose secret is
// gone reads as none and is dropped. Nobody reads another person's layer, admins included. A session is handed its own
// project's values alone, and a person's only in their own private sessions (sessionApi.mjs, `POST /repo-settings`).
// Values are never logged: keys, sizes and who.

import logins from './public/logins.cjs';
import { projectFor, projectNamed, defaultProject } from './projects.mjs';
import { isAsk, isQa } from './sessions.mjs';
import { checkFile } from './userSettings.mjs';
import { envKeyTable, envKeys, instructionsProblem, sessionWiring } from '../shared/repoSettings.mjs';
const { loginKey } = logins;

// An env file's key: the project file's `secret` syntax, or a key made from its path (shared/project.mjs, envFileKey).
const KEY = /^[a-z0-9][a-z0-9-]{0,99}$/;
const PROJECT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MIGRATED_FROM = 'terraform env_files';
// A whole .env file, JSON-escaped, under the store's 64 KB.
const MAX_BODY_BYTES = 160 * 1024;

const shown = (message, status = 400) => Object.assign(new Error(message), { shown: true, status });
const firstLine = (err) => String(err?.message ?? err).split('\n')[0];

/** @returns {string}  the installation's value for one env file of a project, under the console's prefix */
export function installationEnvName(project, key) {
  return `repos/${project}/env/${key}`;
}

export function installationInstructionsName(project) {
  return `repos/${project}/instructions`;
}

/** @returns {string}  one person's own value for one env file of a project */
export function personalEnvName(login, project, key) {
  return `users/${loginKey(login)}/repos/${project}/env/${key}`;
}

export function personalInstructionsName(login, project) {
  return `users/${loginKey(login)}/repos/${project}/instructions`;
}

function nameOf({ login, project, key }) {
  if (login) return key ? personalEnvName(login, project, key) : personalInstructionsName(login, project);
  return key ? installationEnvName(project, key) : installationInstructionsName(project);
}

function checkKey(key) {
  if (typeof key !== 'string' || !KEY.test(key)) throw shown('an env file\'s key is lowercase letters, digits and dashes');
}

/**
 * @param {unknown} text
 * @returns {string}  the instructions to store, Windows line endings made Unix ones; empty when there are none
 * @throws {Error}  with a message the page can show, never containing the text
 */
export function checkInstructions(text) {
  if (typeof text !== 'string') throw shown('the instructions must be text');
  const value = text.replace(/\r\n/g, '\n');
  if (!value.trim()) return '';
  const problem = instructionsProblem(value);
  if (problem) throw shown(problem);
  return value;
}

// Key names stand in for a layer's text where only the names are known, which is all the tables need.
const keyText = (keys) => (keys ?? []).map((k) => `${k}=`).join('\n');

/**
 * @param {{store: {state: object, save: () => void}, secrets: {read: Function, save: Function, remove: Function,
 *          configured?: () => boolean}|null, config: object,
 *          readerOf: (project: string) => {repoLayer: () => Promise<{envFiles: object[], env: Record<string, string>,
 *            rules: string|null, setup: string|null}>}, now?: () => number}} deps
 *   `config` is the live one (its `projects` and the legacy `envFiles` pairs); `readerOf` reads a project's file from
 *   its default branch (projectFile.mjs)
 */
export function createRepoSettings({ store, secrets, config, readerOf, now = Date.now }) {
  const available = () => Boolean(secrets) && secrets.configured?.() !== false;

  function requireSecrets() {
    if (!available()) throw shown('this console has no secret store, so repo settings cannot be saved', 409);
  }

  function requireProject(name) {
    const project = typeof name === 'string' && PROJECT.test(name) ? projectNamed(config, name) : null;
    if (!project) throw shown(`There is no project called ${String(name).slice(0, 40)}.`, 404);
    return project;
  }

  // The records of one layer, by project: the installation's, or one person's.
  function rootFor(login, create = false) {
    if (!login) {
      if (create) store.state.repoSettings ??= {};
      return store.state.repoSettings ?? null;
    }
    if (create) {
      store.state.people ??= {};
      store.state.people[loginKey(login)] ??= {};
      store.state.people[loginKey(login)].repos ??= {};
    }
    return store.state.people?.[loginKey(login)]?.repos ?? null;
  }

  function recordOf({ login, project, key }) {
    const repo = rootFor(login)?.[project];
    return (key ? repo?.env?.[key] : repo?.instructions) ?? null;
  }

  // `record` null removes it, and the project's entry with it once it holds nothing.
  function writeRecord({ login, project, key, record }) {
    if (!record && !recordOf({ login, project, key })) return;
    const root = rootFor(login, true);
    const repo = root[project] ?? {};
    if (key) {
      const env = { ...repo.env };
      if (record) env[key] = record;
      else delete env[key];
      repo.env = env;
      if (!Object.keys(env).length) delete repo.env;
    } else if (record) repo.instructions = record;
    else delete repo.instructions;
    if (Object.keys(repo).length) root[project] = repo;
    else delete root[project];
    if (login && !Object.keys(root).length) delete store.state.people[loginKey(login)].repos;
    store.save();
  }

  /** @returns {Promise<string|null>}  a layer's value; null while it has none, or its secret is gone */
  async function readValue({ login = null, project, key = null }) {
    if (!available() || !recordOf({ login, project, key })) return null;
    const value = await secrets.read(nameOf({ login, project, key }));
    if (value === null) {
      writeRecord({ login, project, key, record: null });
      console.log('repoSettings: record dropped, its secret is gone', { layer: login ? 'personal' : 'installation', project, key, ...(login && { login }) });
    }
    return value;
  }

  function description({ login, project, key }) {
    const what = key ? `the ${key} env file` : 'instructions';
    return login ? `Woodshed: @${login}'s own ${what} for ${project}, for their private sessions only` : `Woodshed: this installation's ${what} for ${project}`;
  }

  async function clearValue({ login = null, project, key = null, by }) {
    requireSecrets();
    await secrets.remove(nameOf({ login, project, key }));
    writeRecord({ login, project, key, record: null });
    if (!key) console.log('repoSettings: instructions cleared', { layer: login ? 'personal' : 'installation', project, by });
    else if (login) console.log('repoSettings: own values cleared', { project, key, login });
    else console.log('repoSettings: installation values cleared', { project, key, by });
  }

  // Saving nothing clears the layer.
  async function saveValue({ login = null, project, key = null, text, by }) {
    requireSecrets();
    const value = key ? checkFile(text) : checkInstructions(text);
    if (!value) return clearValue({ login, project, key, by });
    await secrets.save(nameOf({ login, project, key }), value, description({ login, project, key }));
    const bytes = Buffer.byteLength(value);
    const keys = key ? envKeys(value) : null;
    writeRecord({ login, project, key, record: { savedAt: new Date(now()).toISOString(), ...(!login && { by }), bytes, ...(keys && { keys }) } });
    if (!key) console.log('repoSettings: instructions saved', { layer: login ? 'personal' : 'installation', project, by, bytes });
    else if (login) console.log('repoSettings: own values saved', { project, key, login, bytes });
    else console.log('repoSettings: installation values saved', { project, key, by, bytes, keys });
  }

  /** @returns {Promise<{envFiles: object[], env: object, rules: string|null, setup: string|null}>} */
  async function repoLayer(project) {
    return readerOf(project.name).repoLayer();
  }

  // A value is kept only for an env file the project file names: anything else would never reach a session.
  async function requireEnvFile(project, key) {
    checkKey(key);
    let layer;
    try {
      layer = await repoLayer(project);
    } catch (err) {
      console.warn('repoSettings: project file not read, save refused', { project: project.name, key, message: firstLine(err) });
      throw shown(`${project.repo}'s project file could not be read, so ${key} cannot be checked: try again in a moment`, 409);
    }
    const file = layer.envFiles.find((f) => f.key === key);
    if (!file) throw shown(`${project.repo}'s project file has no env file with the key ${key}`, 404);
    return file;
  }

  // The Terraform secret an env file of the default project was read from before repo settings (WOODSHED_ENV_FILES).
  function legacyFor(project, file) {
    if (!project.default || !file.secret || !(config.envFiles ?? []).some((f) => f.secret === file.secret)) return null;
    return { secret: file.secret, copiedAt: store.state.repoSettingsMigration?.files?.[file.key] ?? null };
  }

  function envFileView({ project, file, layer, login }) {
    const inst = recordOf({ project: project.name, key: file.key });
    const own = login ? recordOf({ login, project: project.name, key: file.key }) : null;
    const wiring = sessionWiring({ lines: file.lines, env: layer?.env ?? {} });
    const layers = { repo: file.defaults.join('\n'), installation: keyText(inst?.keys), ...(login && { personal: keyText(own?.keys) }), session: file.lines.join('\n') };
    return {
      key: file.key, path: file.path, secret: file.secret, defaults: file.defaults,
      // A line `{{NAME?}}` writes only in a session that has NAME: there it is wiring, elsewhere the layers' value stays.
      wiring: { lines: wiring.lines, optional: envKeys(file.lines.filter((l) => /\{\{[A-Za-z_][A-Za-z0-9_]*\?\}\}/.test(l)).join('\n')), env: wiring.env },
      installation: inst, ...(login && { personal: own }), legacy: legacyFor(project, file),
      table: envKeyTable({ layers, wiring }),
    };
  }

  /**
   * What the Console settings page shows for a repo, and My settings with the person's own records: the project file's
   * env files with their defaults and wiring, each layer's records (never a value) and which layer wins each key.
   * @param {string} name  the project
   * @param {{login?: string|null}} [opts]  the person whose own records are added: My settings' view
   */
  async function view(name, { login = null } = {}) {
    const project = requireProject(name);
    let layer = null;
    let error = null;
    try {
      layer = await repoLayer(project);
    } catch (err) {
      error = firstLine(err);
      console.warn('repoSettings: project file not read, saved values shown alone', { project: project.name, message: error });
    }
    const instEnv = rootFor(null)?.[project.name]?.env ?? {};
    const ownEnv = login ? rootFor(login)?.[project.name]?.env ?? {} : {};
    const named = layer?.envFiles ?? [];
    const saved = [...new Set([...Object.keys(instEnv), ...Object.keys(ownEnv)])].filter((key) => !named.some((f) => f.key === key));
    // Unread, the saved keys stand for the files: what they are for is unknown until the file is read.
    const files = layer ? named : saved.map((key) => ({ key, path: null, secret: null, defaults: [], lines: [] }));
    return {
      project: project.name, repo: project.repo, default: Boolean(project.default),
      projectFile: { read: Boolean(layer), error, rules: layer?.rules ?? null, setup: layer?.setup ?? null },
      envFiles: files.map((file) => envFileView({ project, file, layer, login })),
      // Saved for a key the project file no longer names: kept until someone deletes it.
      unnamed: layer ? saved.map((key) => ({ key, installation: instEnv[key] ?? null, ...(login && { personal: ownEnv[key] ?? null }) })) : [],
      instructions: { installation: recordOf({ project: project.name }), ...(login && { personal: recordOf({ login, project: project.name }) }) },
      available: available(),
    };
  }

  /** @returns {{project: string, repo: string, envFiles: string[], instructions: boolean}}  a person's own records for a project */
  function summary(login, project) {
    const own = rootFor(login)?.[project.name];
    return { project: project.name, repo: project.repo, envFiles: Object.keys(own?.env ?? {}), instructions: Boolean(own?.instructions) };
  }

  async function installationText({ project: name, key = null, by, on = 'console settings' }) {
    const project = requireProject(name);
    if (key) checkKey(key);
    const text = await readValue({ project: project.name, key });
    if (text !== null) console.log('repoSettings: installation values shown', { project: project.name, ...(key ? { key } : { instructions: true }), by, on });
    return text;
  }

  async function saveInstallation({ project: name, key = null, text, by }) {
    const project = requireProject(name);
    if (key) await requireEnvFile(project, key);
    await saveValue({ project: project.name, key, text, by });
  }

  /** Deletes the installation's and every person's values for a key the project file no longer names. */
  async function removeUnnamed({ project: name, key, by }) {
    const project = requireProject(name);
    checkKey(key);
    requireSecrets();
    const layer = await repoLayer(project).catch(() => null);
    if (layer?.envFiles.some((f) => f.key === key)) throw shown(`${project.repo}'s project file still has ${key}: clear its values instead`, 409);
    await clearValue({ project: project.name, key, by });
    for (const login of Object.keys(store.state.people ?? {})) {
      if (recordOf({ login, project: project.name, key })) await clearValue({ login, project: project.name, key, by });
    }
  }

  async function ownText({ login, project: name, key = null }) {
    const project = requireProject(name);
    if (key) checkKey(key);
    return readValue({ login, project: project.name, key });
  }

  async function saveOwn({ login, project: name, key = null, text }) {
    const project = requireProject(name);
    const file = key ? await requireEnvFile(project, key) : null;
    await saveValue({ login, project: project.name, key, text, by: login });
    if (file) await dropLegacyOwn({ login, project, file, cleared: !String(text ?? '').trim() });
  }

  /**
   * A person's own lines for a legacy env file (`users/<login>/<secret>`, My settings' old Env files tabs) go once
   * they save or clear the file's repo settings: a session falls back to them whenever their repo settings value is
   * empty, and the next start would copy them back, so a Clear would not stay cleared.
   * @param {{cleared: boolean}} opts  a clear that cannot drop them fails, since the old lines would come back
   */
  async function dropLegacyOwn({ login, project, file, cleared }) {
    const person = store.state.people?.[loginKey(login)];
    if (!legacyFor(project, file) || !person?.files?.[file.secret]) return;
    try {
      await secrets.remove(`users/${loginKey(login)}/${file.secret}`);
    } catch (err) {
      console.warn('repoSettings: legacy own lines not removed', { login, key: file.key, cleared, message: firstLine(err) });
      if (cleared) throw err;
      return;
    }
    person.files = { ...person.files, [file.secret]: null };
    store.save();
    console.log('repoSettings: legacy own lines removed, repo settings hold them now', { login, key: file.key });
  }

  /**
   * Each Terraform env file secret (WOODSHED_ENV_FILES), as the Secrets page lists it: whose repo settings it was
   * copied into, when, and whether that value is there now. Once it is, sessions read it and not the secret.
   * @returns {{secret: string, path: string, project: string, repo: string, key: string, copiedAt: string|null,
   *   saved: boolean}|null}  null for a name that is not one
   */
  function legacyState(secret) {
    const pair = (config.envFiles ?? []).find((f) => f.secret === secret);
    const main = defaultProject(config);
    if (!pair || !main.repo) return null;
    return {
      secret, path: pair.path, project: main.name, repo: main.repo, key: secret,
      copiedAt: store.state.repoSettingsMigration?.files?.[secret] ?? null, saved: Boolean(recordOf({ project: main.name, key: secret })),
    };
  }

  /**
   * My settings' old route for one env file's own lines (`/api/my/files/<secret>`), kept while pages from before repo
   * settings are open: it reads and writes the default project's repo settings, so an edit made the old way reaches
   * sessions. Answered in the old shape.
   * @param {{login: string, key: string, change?: {text: unknown}|null}} args  `change` saves first; '' clears
   * @returns {Promise<{key: string, label: string, text: string, custom: boolean, sharedText: string, editable: true,
   *   appended: string[]}>}
   */
  async function legacyFile({ login, key, change = null }) {
    const state = legacyState(key);
    if (!state) throw shown(`no file called ${key}`, 404);
    if (change) {
      await saveOwn({ login, project: state.project, key, text: change.text });
      console.log('repoSettings: old own lines route, saved to repo settings', { login, project: state.project, key, cleared: !change.text?.trim?.() });
    }
    const [own, installation, layer] = await Promise.all([
      ownText({ login, project: state.project, key }),
      installationText({ project: state.project, key, by: login, on: 'my settings, old route' }),
      repoLayer(requireProject(state.project)).catch(() => null),
    ]);
    // What sessions read where the installation has no value yet: the Terraform secret.
    const sharedText = installation ?? (available() ? await secrets.read(key) : null) ?? '';
    const file = layer?.envFiles.find((f) => f.key === key);
    const wiring = file ? sessionWiring({ lines: file.lines, env: layer.env ?? {} }) : null;
    return {
      key, label: state.path, text: own ?? '', custom: own !== null, sharedText, editable: true,
      appended: wiring ? [...new Set([...wiring.lines, ...wiring.env])] : [],
    };
  }

  /**
   * What a session is handed at start: its own project's values, chosen by the session, never by what it asks for.
   * A person's only in their own private session: a shared or QA session, which anyone signed in can type into, gets
   * none. Every key the console holds for the project: the session uses those its checkout's project file names.
   * @returns {Promise<{project: string, envFiles: Record<string, {installation: string|null, personal: string|null}>,
   *   instructions: {installation: string|null, personal: string|null}, personalFor: string|null}|null>}  null for an ask session
   * @throws {Error}  when the store did not answer
   */
  async function forSession(session) {
    if (isAsk(session)) return null;
    const project = projectFor(config, session).name;
    const personalFor = session.owner && !isQa(session) ? session.owner : null;
    const keys = [...new Set([
      ...Object.keys(rootFor(null)?.[project]?.env ?? {}),
      ...(personalFor ? Object.keys(rootFor(personalFor)?.[project]?.env ?? {}) : []),
    ])];
    const read = (login, key) => readValue({ login, project, key });
    const [envValues, instructions] = await Promise.all([
      Promise.all(keys.map(async (key) => [key, { installation: await read(null, key), personal: personalFor ? await read(personalFor, key) : null }])),
      Promise.all([read(null, null), personalFor ? read(personalFor, null) : null]),
    ]);
    const envFiles = Object.fromEntries(envValues);
    const set = (layer) => Object.keys(envFiles).filter((k) => envFiles[k][layer] !== null);
    console.log('repoSettings: handed out', {
      sessionId: session.id, project, installation: set('installation'), personal: set('personal'),
      instructions: { installation: instructions[0] !== null, personal: instructions[1] !== null }, personalFor,
    });
    return { project, envFiles, instructions: { installation: instructions[0], personal: instructions[1] ?? null }, personalFor };
  }

  // One legacy value into its new name, unless that name has one already: the copy never overwrites.
  async function copyOne({ from, to, record }) {
    const existing = await secrets.read(nameOf(to));
    if (existing !== null) {
      if (!recordOf(to)) writeRecord({ ...to, record: { savedAt: new Date(now()).toISOString(), ...(!to.login && { by: 'unknown' }), bytes: Buffer.byteLength(existing), keys: envKeys(existing) } });
      return 'kept';
    }
    const value = await secrets.read(from);
    if (!value?.trim()) return 'none';
    await secrets.save(nameOf(to), value, description(to));
    writeRecord({ ...to, record: { ...record, bytes: Buffer.byteLength(value), keys: envKeys(value) } });
    return 'copied';
  }

  /**
   * At each start: the Terraform env file secrets (WOODSHED_ENV_FILES) and each person's own lines for them into the
   * default project's new names. A name that has a value already is left as it is, so a second run copies nothing.
   * @returns {Promise<{copied: number, ownCopied: number, kept: number, none: number, failed: number}>}
   */
  async function migrate() {
    const counts = { copied: 0, ownCopied: 0, kept: 0, none: 0, failed: 0 };
    const legacy = config.envFiles ?? [];
    const main = defaultProject(config);
    if (!legacy.length || !main.repo) return counts;
    if (!available()) {
      console.log('repoSettings: legacy copy skipped, no secret store');
      return counts;
    }
    const at = new Date(now()).toISOString();
    const files = {};
    const attempt = async (what, args, log) => {
      try {
        const result = await copyOne(args);
        if (result === 'copied') log();
        return result;
      } catch (err) {
        console.warn('repoSettings: legacy copy failed, tried again at the next start', { ...what, message: firstLine(err) });
        return 'failed';
      }
    };
    for (const { secret } of legacy) {
      const to = { project: main.name, key: secret };
      const result = await attempt({ project: main.name, key: secret }, { from: secret, to, record: { savedAt: at, by: MIGRATED_FROM } }, () => {
        console.log('repoSettings: legacy env file copied', { project: main.name, key: secret, bytes: recordOf(to).bytes });
      });
      if (result === 'copied') files[secret] = at;
      counts[result === 'copied' ? 'copied' : result] += 1;
    }
    for (const [login, person] of Object.entries(store.state.people ?? {})) {
      for (const { secret } of legacy) {
        if (!person?.files?.[secret]) continue;
        const to = { login, project: main.name, key: secret };
        const result = await attempt({ login, key: secret }, { from: `users/${login}/${secret}`, to, record: { savedAt: at } }, () => {
          console.log('repoSettings: legacy own lines copied', { login, key: secret });
        });
        counts[result === 'copied' ? 'ownCopied' : result] += 1;
      }
    }
    if (counts.copied || counts.ownCopied) {
      const before = store.state.repoSettingsMigration;
      store.state.repoSettingsMigration = { copiedAt: at, from: MIGRATED_FROM, files: { ...before?.files, ...files } };
      store.save();
    }
    console.log('repoSettings: legacy copy checked', { project: main.name, ...counts });
    return counts;
  }

  // Each record of a project in one layer, deleted secret first: one that fails is kept, to be deleted again.
  async function forgetLayer(login, project) {
    const repo = rootFor(login)?.[project];
    if (!repo) return { deleted: 0, failed: 0 };
    let deleted = 0;
    let failed = 0;
    const targets = [...Object.keys(repo.env ?? {}).map((key) => ({ login, project, key })), ...(repo.instructions ? [{ login, project, key: null }] : [])];
    for (const target of targets) {
      try {
        if (secrets) await secrets.remove(nameOf(target));
        writeRecord({ ...target, record: null });
        deleted += 1;
      } catch (err) {
        failed += 1;
        console.warn('repoSettings: value not deleted', { project, key: target.key, ...(login && { login }), message: firstLine(err) });
      }
    }
    return { deleted, failed };
  }

  /**
   * A repo taken off the console: its installation values and every person's own for it go (D9).
   * @throws {Error}  with `shown`, when some could not be deleted; their records stay, for the next try
   */
  async function forget(project) {
    const results = [await forgetLayer(null, project)];
    for (const login of Object.keys(store.state.people ?? {})) results.push(await forgetLayer(login, project));
    const deleted = results.reduce((n, r) => n + r.deleted, 0);
    const failed = results.reduce((n, r) => n + r.failed, 0);
    console.log('repoSettings: repo forgotten', { project, deleted, failed });
    if (failed) throw shown(`${failed} of ${project}'s repo settings could not be deleted: the console log says why`, 502);
  }

  /** Remove My Woodshed: everything the person kept for every repo. */
  async function forgetPerson(login) {
    for (const project of Object.keys(rootFor(login) ?? {})) await forgetLayer(login, project);
  }

  return {
    view, summary, installationText, saveInstallation, removeUnnamed, ownText, saveOwn, forSession, migrate, forget, forgetPerson,
    legacyState, legacyFile, available,
  };
}

const LEGACY_FILE_RE = /^\/api\/my\/files\/([a-z0-9-]+)(\/reset)?$/;

/**
 * My settings' old route for one env file's own lines, which writes repo settings now (`legacyFile`). tmux-conf, and
 * any name that is not one of the Terraform env files, stays userSettings.mjs's.
 * @returns {{scope: 'legacy', project: null, key: string, reset: boolean, instructions: false, remove: false}|null}
 */
export function legacyFileRoute(pathname, config) {
  const match = LEGACY_FILE_RE.exec(pathname);
  if (!match || !(config.envFiles ?? []).some((f) => f.secret === match[1])) return null;
  return { scope: 'legacy', project: null, key: match[1], reset: Boolean(match[2]), instructions: false, remove: false };
}

const ADMIN_RE = /^\/api\/console-settings\/repos\/([^/]+)(?:\/env\/([^/]+)(\/remove)?|\/(instructions))?$/;
const MY_RE = /^\/api\/my\/repos(?:\/([^/]+)(?:\/env\/([^/]+)|\/(instructions))?)?$/;

/**
 * @returns {{scope: 'admin'|'my', project: string|null, key: string|null, instructions: boolean, remove: boolean}|null}
 *   the repo settings route a path names, or null for none
 */
export function repoSettingsRoute(pathname) {
  const admin = ADMIN_RE.exec(pathname);
  if (admin) return { scope: 'admin', project: admin[1], key: admin[2] ?? null, remove: Boolean(admin[3]), instructions: Boolean(admin[4]) };
  const my = MY_RE.exec(pathname);
  if (my) return { scope: 'my', project: my[1] ?? null, key: my[2] ?? null, remove: false, instructions: Boolean(my[3]) };
  return null;
}

function reply(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readText(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY_BYTES) throw shown('the text is over the 64 KB a value can hold', 413);
  }
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    throw shown('body must be JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw shown('body must be a JSON object');
  return body.text;
}

/**
 * The JSON API behind the Repo settings pages. The server has already checked the host, and for a write the origin and
 * `x-woodshed`, and that an admin calls `/api/console-settings/...`.
 *
 *   GET  /api/console-settings/repos/<project>                   the repo's env files and instructions, records only
 *   GET  /api/console-settings/repos/<project>/env/<key>         {"text"}: the installation's values, logged as shown
 *   POST /api/console-settings/repos/<project>/env/<key>         {"text"}; "" clears
 *   POST /api/console-settings/repos/<project>/env/<key>/remove  a key the project file no longer names, everyone's
 *   GET  /api/console-settings/repos/<project>/instructions      {"text"}
 *   POST /api/console-settings/repos/<project>/instructions      {"text"}; "" clears
 *   GET  /api/my/repos                                           the repos you can write to, with what you keep for each,
 *                                                                and the one New session opens on for you (defaultProject)
 *   GET  /api/my/repos/<project>                                 as the admin's, with your own records
 *   GET  /api/my/repos/<project>/env/<key>                       {"text": yours, "installation": the installation's|null}
 *   POST /api/my/repos/<project>/env/<key>                       {"text"}; "" clears yours
 *   GET  /api/my/repos/<project>/instructions                    {"text": yours, "installation"}
 *   POST /api/my/repos/<project>/instructions                    {"text"}; "" clears yours
 *   GET  /api/my/files/<secret>                                  the old route of a Terraform env file's own lines, on the
 *   POST /api/my/files/<secret>[/reset]                          default project's repo settings (legacyFile), in its old shape
 *
 * Every /api/my/repos/<project> route, and the old one for the default project, is refused (403) to someone who cannot write to the repo: they cannot start
 * sessions on it, so they keep nothing for it and read nothing of it.
 * @param {{repoSettings: ReturnType<typeof createRepoSettings>, config: object,
 *          projectAccess?: {view: Function, forStart: (login: string, name: string) => Promise<object|null>}|null}} deps
 */
export function createRepoSettingsApi({ repoSettings, config, projectAccess = null }) {
  async function canWrite(login, name) {
    if (projectAccess) return Boolean(await projectAccess.forStart(login, name));
    return projectNamed(config, name)?.default === true;
  }

  async function writable(login) {
    if (projectAccess) return projectAccess.view(login);
    const main = defaultProject(config);
    return { projects: main.repo ? [main] : [], defaultProject: main.repo ? main.name : null };
  }

  async function admin(req, res, { project, key, remove, instructions }, by) {
    if (req.method === 'GET' && !key && !instructions) return reply(res, 200, await repoSettings.view(project));
    if (req.method === 'GET') return reply(res, 200, { text: (await repoSettings.installationText({ project, key, by })) ?? '' });
    if (remove) await repoSettings.removeUnnamed({ project, key, by });
    else await repoSettings.saveInstallation({ project, key, text: await readText(req), by });
    return reply(res, 200, await repoSettings.view(project));
  }

  async function mine(req, res, { project, key, instructions }, login) {
    if (!project) {
      const { projects, defaultProject: own } = await writable(login);
      return reply(res, 200, { repos: projects.map((p) => repoSettings.summary(login, projectNamed(config, p.name) ?? p)), defaultProject: own });
    }
    if (!(await refuseUnwritable(req, res, login, project))) return undefined;
    if (req.method === 'GET' && !key && !instructions) return reply(res, 200, await repoSettings.view(project, { login }));
    if (req.method === 'GET') {
      const [text, installation] = await Promise.all([
        repoSettings.ownText({ login, project, key }),
        repoSettings.installationText({ project, key, by: login, on: 'my settings' }),
      ]);
      return reply(res, 200, { text: text ?? '', installation });
    }
    await repoSettings.saveOwn({ login, project, key, text: await readText(req) });
    return reply(res, 200, await repoSettings.view(project, { login }));
  }

  // The old /api/my/files/<secret>, on the default project's repo settings, refused as /api/my/repos/<project> is.
  async function legacy(req, res, { key, reset }, login) {
    const main = defaultProject(config);
    if (!(await refuseUnwritable(req, res, login, main.name))) return undefined;
    if (req.method === 'GET') return reply(res, 200, await repoSettings.legacyFile({ login, key }));
    const text = await readText(req);
    return reply(res, 200, await repoSettings.legacyFile({ login, key, change: { text: reset ? '' : text } }));
  }

  /** @returns {Promise<boolean>}  true when the person may go on; else the 403 is sent */
  async function refuseUnwritable(req, res, login, project) {
    if (await canWrite(login, project)) return true;
    console.log('repoSettings: refused, cannot write to the repo', { login, project: String(project).slice(0, 40), method: req.method });
    req.resume();
    reply(res, 403, { error: `you cannot start sessions on a project named ${String(project).slice(0, 40)}, so you keep no settings for it` });
    return false;
  }

  /**
   * @param {import('node:http').IncomingMessage} req  GET or POST
   * @param {{route: NonNullable<ReturnType<typeof repoSettingsRoute>>, login: string|null}} who
   */
  return async function handle(req, res, { route, login }) {
    if (req.method !== 'GET' && req.method !== 'POST') return reply(res, 405, { error: 'method not allowed' });
    if (req.method === 'GET' && (route.remove || route.reset)) return reply(res, 405, { error: 'method not allowed' });
    if (route.scope !== 'admin' && !login) return reply(res, 409, { error: 'My Woodshed needs GitHub sign-in, which this console does not have' });
    try {
      if (route.scope === 'admin') return await admin(req, res, route, login ?? 'console');
      if (route.scope === 'legacy') return await legacy(req, res, route, login);
      return await mine(req, res, route, login);
    } catch (err) {
      if (err.shown) return reply(res, err.status ?? 400, { error: err.message });
      console.error('repoSettings: the secret store did not answer', { scope: route.scope, project: route.project, key: route.key, message: firstLine(err) });
      return reply(res, 502, { error: 'The secret store did not answer: try again in a moment' });
    }
  };
}
