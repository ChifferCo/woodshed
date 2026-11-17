// Repo settings: each repo's env file values and instructions that the installation's admins set (layer 2) and that
// each person sets for themselves (layer 3), kept in the console's secret store under per-repo names
// (shared/repoSettings.mjs says how the layers make a session's files and prompt):
//
//   repos/<project>/env/<key>                    the installation's lines for one of the repo's env files
//   repos/<project>/instructions                 the installation's instructions for the repo
//   users/<login>/repos/<project>/env/<key>      one person's own lines for that env file
//   users/<login>/repos/<project>/instructions   one person's own instructions for the repo
//   users/<login>/repos/<project>/files          one person's own whole files for the repo (an app/.env.production), as
//                                                JSON {"<path>": "<text>"}, written where git ignores them (session/ownFiles.mjs)
//
// `<key>` is the env file's key in the project file (`secret`, or one made from its path). state.json keeps, under
// `repoSettings.<project>` and `people.<login>.repos.<project>`, when each was saved, by whom, its size and the names of
// the keys it sets (for whole files, each path and when it was saved), never a value, so the pages need no secret read. The store is the truth: a record whose secret is
// gone reads as none and is dropped. Nobody reads another person's layer, admins included. A session is handed its own
// project's values alone, and a person's only in their own private sessions (sessionApi.mjs, `POST /repo-settings`).
// Values are never logged: keys, sizes and who.

import logins from './public/logins.cjs';
import { projectFor, projectNamed, defaultProject } from './projects.mjs';
import { isAsk, isQa } from './sessions.mjs';
import { checkFile } from './userSettings.mjs';
import { envKeyTable, envKeys, instructionsProblem, sessionWiring } from '../shared/repoSettings.mjs';
import { DEFAULT_MAX_VALUE_BYTES, MAX_OWN_FILES, ownFilePath, ownFilePathProblem, ownFilesBodyLimit } from '../shared/ownFiles.mjs';
const { loginKey } = logins;

// An env file's key: the project file's `secret` syntax, or a key made from its path (shared/project.mjs, envFileKey).
const KEY = /^[a-z0-9][a-z0-9-]{0,99}$/;
const PROJECT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
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

/** @returns {string}  one person's own whole files for a project, all in one value */
export function personalFilesName(login, project) {
  return `users/${loginKey(login)}/repos/${project}/files`;
}

// Where own whole files were kept before they were per repo: one value a person, for every repo. moveOwnFiles() moves it
// into the default project's.
const legacyOwnFilesName = (login) => `users/${loginKey(login)}/own-files`;

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
 *   `config` is the live one (its `projects`); `readerOf` reads a project's file from
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

  // One path of a key: its own defaults and wiring, and which layer wins each key in it.
  function pathView({ file, layer, inst, own, login }) {
    const wiring = sessionWiring({ overrides: file.overrides, env: layer?.env ?? {} });
    const layers = { repo: file.defaults.join('\n'), installation: keyText(inst?.keys), ...(login && { personal: keyText(own?.keys) }), session: file.overrides.join('\n') };
    return {
      path: file.path, defaults: file.defaults,
      // A line `{{NAME?}}` writes only in a session that has NAME: there it is wiring, elsewhere the layers' value stays.
      wiring: { overrides: wiring.overrides, optional: envKeys(file.overrides.filter((l) => /\{\{[A-Za-z_][A-Za-z0-9_]*\?\}\}/.test(l)).join('\n')), env: wiring.env },
      table: envKeyTable({ layers, wiring }),
    };
  }

  // A key's rows: one for all its paths where they agree, else one a path that sets it, naming the path.
  function sharedTable(paths) {
    if (paths.length === 1) return paths[0].table;
    const sign = (p, row) => row && JSON.stringify([row.setBy, row.wins, ...['overrides', 'optional', 'env'].map((w) => p.wiring[w].includes(row.key))]);
    const keys = [...new Set(paths.flatMap((p) => p.table.map((row) => row.key)))];
    return keys.flatMap((key) => {
      const rows = paths.map((p) => p.table.find((row) => row.key === key) ?? null);
      if (rows.every((row, i) => sign(paths[i], row) === sign(paths[0], rows[0]))) return [rows[0]];
      return rows.flatMap((row, i) => (row ? [{ ...row, path: paths[i].path }] : []));
    });
  }

  // One key and every env file that names it: files that name one secret share its values, each with its own
  // defaults and overrides. `path`, `defaults` and `wiring` are the first file's, `files` each one's.
  function envFileView({ project, files, layer, login }) {
    const [first] = files;
    const inst = recordOf({ project: project.name, key: first.key });
    const own = login ? recordOf({ login, project: project.name, key: first.key }) : null;
    const paths = files.map((file) => pathView({ file, layer, inst, own, login }));
    return {
      key: first.key, path: first.path, paths: files.map((f) => f.path), secret: first.secret, defaults: first.defaults, wiring: paths[0].wiring,
      files: paths.map(({ table, ...rest }) => rest),
      installation: inst, ...(login && { personal: own }),
      table: sharedTable(paths),
    };
  }

  // The project file's env files by key, in the order each key first appears.
  function byKey(files) {
    const groups = new Map();
    for (const file of files) groups.set(file.key, [...(groups.get(file.key) ?? []), file]);
    return [...groups.values()];
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
    const files = layer ? named : saved.map((key) => ({ key, path: null, secret: null, defaults: [], overrides: [] }));
    return {
      project: project.name, repo: project.repo, default: Boolean(project.default),
      projectFile: { read: Boolean(layer), error, rules: layer?.rules ?? null, setup: layer?.setup ?? null },
      envFiles: byKey(files).map((group) => envFileView({ project, files: group, layer, login })),
      // Saved for a key the project file no longer names: kept until someone deletes it.
      unnamed: layer ? saved.map((key) => ({ key, installation: instEnv[key] ?? null, ...(login && { personal: ownEnv[key] ?? null }) })) : [],
      instructions: { installation: recordOf({ project: project.name }), ...(login && { personal: recordOf({ login, project: project.name }) }) },
      ...(login && {
        files: Object.entries(filesRecordOf(login, project.name) ?? {}).map(([file, savedAt]) => ({ path: file, savedAt })).sort((a, b) => a.path.localeCompare(b.path)),
        filesMaxBytes: maxFilesBytes(), filesMax: MAX_OWN_FILES,
      }),
      available: available(),
    };
  }

  /** @returns {{project: string, repo: string, envFiles: string[], instructions: boolean, files: number}}  a person's own records for a project */
  function summary(login, project) {
    const own = rootFor(login)?.[project.name];
    return { project: project.name, repo: project.repo, envFiles: Object.keys(own?.env ?? {}), instructions: Boolean(own?.instructions), files: Object.keys(own?.files ?? {}).length };
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
    if (key) await requireEnvFile(project, key);
    await saveValue({ login, project: project.name, key, text, by: login });
  }

  /** @returns {number}  the most bytes the secret store holds in one value; a store that declares none holds 64 KB */
  function maxFilesBytes() {
    return secrets?.maxValueBytes ?? DEFAULT_MAX_VALUE_BYTES;
  }

  // A person's own whole files for a project, by path, and when each was saved: state.json's record of them.
  const filesRecordOf = (login, project) => rootFor(login)?.[project]?.files ?? null;

  function writeFilesRecord(login, project, files) {
    if (!files && !filesRecordOf(login, project)) return;
    const root = rootFor(login, true);
    const repo = { ...root[project] };
    if (files) repo.files = files;
    else delete repo.files;
    if (Object.keys(repo).length) root[project] = repo;
    else delete root[project];
    if (!Object.keys(root).length) delete store.state.people[loginKey(login)].repos;
    store.save();
  }

  // The value of a person's whole files: {} while they keep none, or its secret is gone, or it is not JSON.
  async function readFiles(login, project) {
    if (!available() || !Object.keys(filesRecordOf(login, project) ?? {}).length) return {};
    const value = await secrets.read(personalFilesName(login, project));
    if (value === null) {
      writeFilesRecord(login, project, null);
      console.log('repoSettings: record dropped, its secret is gone', { layer: 'personal', project, files: true, login });
      return {};
    }
    try {
      const files = JSON.parse(value);
      return files && typeof files === 'object' && !Array.isArray(files) ? files : {};
    } catch {
      console.warn('repoSettings: own files not read, the value is not JSON', { project, login });
      return {};
    }
  }

  /** @returns {Promise<Record<string, string>>}  a person's own whole files for a project they can write to, by path */
  async function ownFiles({ login, project: name }) {
    return readFiles(login, requireProject(name).name);
  }

  /**
   * Adds, replaces or (with empty text) removes one of a person's own whole files for a project. All of a project's
   * are one value, so a save writes them all. A path one of the project file's env files writes is refused: the
   * person's values for it are its env file's, which the session would write over.
   * @returns {Promise<Record<string, string>>}  their files for the project after the change
   * @throws {Error}  with a message the page can show, never the text
   */
  async function saveOwnFile({ login, project: name, path: file, text }) {
    requireSecrets();
    const project = requireProject(name);
    const problem = ownFilePathProblem(file);
    if (problem) throw shown(problem);
    const key = ownFilePath(file);
    if (text !== undefined && typeof text !== 'string') throw shown('the file must be text');
    const value = String(text ?? '').replace(/\r\n/g, '\n');
    if (value.trim()) {
      let layer;
      try {
        layer = await repoLayer(project);
      } catch (err) {
        console.warn('repoSettings: project file not read, own file refused', { project: project.name, login, message: firstLine(err) });
        throw shown(`${project.repo}'s project file could not be read, so ${key} cannot be checked against its env files: try again in a moment`, 409);
      }
      if (layer.envFiles.some((f) => f.path === key)) throw shown(`${key} is one of ${project.repo}'s env files: set your values for it above`);
    }
    const files = await readFiles(login, project.name);
    if (value.trim()) files[key] = value;
    else delete files[key];
    if (Object.keys(files).length > MAX_OWN_FILES) throw shown(`you can keep ${MAX_OWN_FILES} files a repo at most`);
    const json = JSON.stringify(files);
    const limit = maxFilesBytes();
    if (Buffer.byteLength(json) > limit) {
      console.warn('repoSettings: own files refused, over the secret store\'s limit', { project: project.name, login, bytes: Buffer.byteLength(json), limit });
      throw shown(`your files for ${project.repo} together are over the ${Math.floor(limit / 1024)} KB this console's secret store holds`);
    }
    if (Object.keys(files).length) await secrets.save(personalFilesName(login, project.name), json, `Woodshed: @${login}'s own files for ${project.name}, for their private sessions only`);
    else await secrets.remove(personalFilesName(login, project.name));
    const before = filesRecordOf(login, project.name);
    const at = new Date(now()).toISOString();
    const kept = Object.fromEntries(Object.keys(files).map((f) => [f, f === key ? at : before?.[f] ?? at]));
    writeFilesRecord(login, project.name, Object.keys(kept).length ? kept : null);
    console.log(value.trim() ? 'repoSettings: own file saved' : 'repoSettings: own file removed', {
      project: project.name, login, path: key, files: Object.keys(files).length, ...(value.trim() && { bytes: Buffer.byteLength(value) }),
    });
    return files;
  }

  /**
   * The owner's whole files for the session's own project, written into its checkout: a private session's alone, as
   * the personal layer is (forSession). Another repo's never reach it.
   * @returns {Promise<Record<string, string>>}
   */
  async function filesForSession(session) {
    if (!session.owner || isAsk(session) || isQa(session)) return {};
    return readFiles(session.owner, projectFor(config, session).name);
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

  // One person's old files into the default project's. Where they keep some there already (saved on the page before
  // the move ran), the old paths those lack are added and theirs win; when the two together would not fit, theirs are
  // kept alone and the log names the old paths left out.
  async function moveOne(login, person, main) {
    const value = await secrets.read(legacyOwnFilesName(login));
    let old = {};
    if (value) {
      old = JSON.parse(value);
      if (!old || typeof old !== 'object' || Array.isArray(old)) throw new Error('the old own files are not a JSON object');
    }
    const current = await readFiles(login, main.name);
    const added = Object.keys(old).filter((file) => !(file in current));
    const merged = { ...current, ...Object.fromEntries(added.map((file) => [file, old[file]])) };
    const fits = Object.keys(merged).length <= MAX_OWN_FILES && Buffer.byteLength(JSON.stringify(merged)) <= maxFilesBytes();
    const moving = added.length && fits;
    if (moving) {
      await secrets.save(personalFilesName(login, main.name), JSON.stringify(merged), `Woodshed: @${login}'s own files for ${main.name}, for their private sessions only`);
      const at = new Date(now()).toISOString();
      writeFilesRecord(login, main.name, { ...filesRecordOf(login, main.name), ...Object.fromEntries(added.map((file) => [file, person.ownFiles[file] ?? at])) });
    }
    if (value) await secrets.remove(legacyOwnFilesName(login));
    delete person.ownFiles;
    store.save();
    console.log('repoSettings: own files moved to the default project', {
      login, project: main.name, added: moving ? added : [], kept: Object.keys(current), ...(added.length && !fits && { leftOut: added, why: 'over the limit together' }),
    });
    return moving ? 'moved' : 'kept';
  }

  /**
   * At each start: each person's own whole files from before they were per repo (`users/<login>/own-files`, with
   * `people.<login>.ownFiles` in state.json) into the default project's, where My settings shows them now, beside any
   * they keep there already (moveOne), then the old value is deleted, so a second run finds nothing to move. One that
   * fails stays, to be moved at the next start; until then no session gets it.
   * @returns {Promise<{moved: number, kept: number, failed: number}>}  `kept`: nothing of the old was added
   */
  async function moveOwnFiles() {
    const counts = { moved: 0, kept: 0, failed: 0 };
    const people = Object.entries(store.state.people ?? {}).filter(([, person]) => Object.keys(person?.ownFiles ?? {}).length);
    if (!people.length) return counts;
    const main = defaultProject(config);
    if (!main.repo || !available()) {
      console.log('repoSettings: own files not moved', { why: main.repo ? 'no secret store' : 'no default repo', people: people.length });
      return counts;
    }
    for (const [login, person] of people) {
      try {
        const result = await moveOne(login, person, main);
        counts[result] += 1;
      } catch (err) {
        counts.failed += 1;
        console.warn('repoSettings: own files not moved, tried again at the next start', { login, project: main.name, message: firstLine(err) });
      }
    }
    return counts;
  }

  // Each record of a project in one layer, deleted secret first: one that fails is kept, to be deleted again.
  async function forgetLayer(login, project) {
    const repo = rootFor(login)?.[project];
    if (!repo) return { deleted: 0, failed: 0 };
    let deleted = 0;
    let failed = 0;
    const targets = [...Object.keys(repo.env ?? {}).map((key) => ({ login, project, key })), ...(repo.instructions ? [{ login, project, key: null }] : [])];
    if (login && repo.files) targets.push({ login, project, files: true });
    for (const target of targets) {
      try {
        if (target.files) {
          if (secrets) await secrets.remove(personalFilesName(login, project));
          writeFilesRecord(login, project, null);
        } else {
          if (secrets) await secrets.remove(nameOf(target));
          writeRecord({ ...target, record: null });
        }
        deleted += 1;
      } catch (err) {
        failed += 1;
        console.warn('repoSettings: value not deleted', { project, ...(target.files ? { files: true } : { key: target.key }), ...(login && { login }), message: firstLine(err) });
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
    view, summary, installationText, saveInstallation, removeUnnamed, ownText, saveOwn, ownFiles, saveOwnFile, filesForSession,
    maxFilesBytes, forSession, moveOwnFiles, forget, forgetPerson, available,
  };
}

const ADMIN_RE = /^\/api\/console-settings\/repos\/([^/]+)(?:\/env\/([^/]+)(\/remove)?|\/(instructions))?$/;
const MY_RE = /^\/api\/my\/repos(?:\/([^/]+)(?:\/env\/([^/]+)|\/(instructions)|\/(files))?)?$/;
// Own whole files' route from before they were per repo: the default project's now.
const OLD_OWN_FILES_PATH = '/api/my/own-files';

/**
 * @returns {{scope: 'admin'|'my', project: string|null, key: string|null, instructions: boolean, remove: boolean,
 *   files?: boolean, oldFiles?: boolean}|null}  the repo settings route a path names, or null for none
 */
export function repoSettingsRoute(pathname) {
  const admin = ADMIN_RE.exec(pathname);
  if (admin) return { scope: 'admin', project: admin[1], key: admin[2] ?? null, remove: Boolean(admin[3]), instructions: Boolean(admin[4]) };
  const my = MY_RE.exec(pathname);
  if (my) return { scope: 'my', project: my[1] ?? null, key: my[2] ?? null, remove: false, instructions: Boolean(my[3]), files: Boolean(my[4]) };
  if (pathname === OLD_OWN_FILES_PATH) return { scope: 'my', project: null, key: null, remove: false, instructions: false, files: true, oldFiles: true };
  return null;
}

function reply(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readText(req) {
  return (await readBody(req)).text;
}

/** @returns {Promise<object>}  the request's JSON object, refused past `limit` bytes */
async function readBody(req, limit = MAX_BODY_BYTES) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw shown(limit > MAX_BODY_BYTES ? 'the file is over what this console\'s secret store holds' : 'the text is over the 64 KB a value can hold', 413);
  }
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    throw shown('body must be JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw shown('body must be a JSON object');
  return body;
}

/**
 * The JSON API behind the Repo settings pages. The server has already checked the host, and for a write the origin and
 * `x-woodshed`, and that an admin calls `/api/console-settings/...`.
 *
 *   GET  /api/console-settings/repos/<project>                   the repo's env files and instructions, records only, and
 *                                                                its Slack channel (`slack`, null where the console has none)
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
 *   GET  /api/my/repos/<project>/files                           {"files": {"<path>": "<text>"}}: your own whole files for it
 *   POST /api/my/repos/<project>/files                           {"path", "text"}: adds or replaces one; "" removes it.
 *                                                                Answers {"files", "view"}
 *   GET  /api/my/own-files, POST /api/my/own-files               the old route of your own whole files, on the default
 *                                                                project's, for a page from before they were per repo
 *
 * Every /api/my/repos/<project> route is refused (403) to someone who cannot write to the repo: they cannot start
 * sessions on it, so they keep nothing for it and read nothing of it.
 * @param {{repoSettings: ReturnType<typeof createRepoSettings>, config: object,
 *          projectAccess?: {view: Function, forStart: (login: string, name: string) => Promise<object|null>}|null,
 *          slackOf?: ((project: string) => {channel: string, consoleChannel: string, canPost: boolean}|null)|null}} deps
 *   `slackOf` is the repo's own Slack channel and the console's, for the admin's page; it is saved through
 *   `POST /api/console-settings/projects/slack-channel`, as the Repos card saved it. `myView` is My settings' view of a
 *   person (userSettings.mjs), which the old own files route answers with. `triggersOf` is the repo's label and its
 *   switches (repoTriggers.mjs), saved through `POST /api/console-settings/projects/triggers`
 */
export function createRepoSettingsApi({ repoSettings, config, projectAccess = null, slackOf = null, triggersOf = null, myView = null }) {
  async function canWrite(login, name) {
    if (projectAccess) return Boolean(await projectAccess.forStart(login, name));
    return projectNamed(config, name)?.default === true;
  }

  async function writable(login) {
    if (projectAccess) return projectAccess.view(login);
    const main = defaultProject(config);
    return { projects: main.repo ? [main] : [], defaultProject: main.repo ? main.name : null };
  }

  async function adminView(project) {
    return { ...(await repoSettings.view(project)), slack: slackOf?.(project) ?? null, triggers: triggersOf?.(project) ?? null };
  }

  async function admin(req, res, { project, key, remove, instructions }, by) {
    if (req.method === 'GET' && !key && !instructions) return reply(res, 200, await adminView(project));
    if (req.method === 'GET') return reply(res, 200, { text: (await repoSettings.installationText({ project, key, by })) ?? '' });
    if (remove) await repoSettings.removeUnnamed({ project, key, by });
    else await repoSettings.saveInstallation({ project, key, text: await readText(req), by });
    return reply(res, 200, await adminView(project));
  }

  async function mine(req, res, { project: named, key, instructions, files, oldFiles }, login) {
    // The old route's files went to the console's default project (moveOwnFiles), whichever one the person starts on.
    const project = oldFiles ? defaultProject(config).name : named;
    if (!project) {
      const { projects, defaultProject: own } = await writable(login);
      return reply(res, 200, { repos: projects.map((p) => repoSettings.summary(login, projectNamed(config, p.name) ?? p)), defaultProject: own });
    }
    if (!(await refuseUnwritable(req, res, login, project))) return undefined;
    if (files) return ownFilesReply(req, res, project, login, oldFiles);
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

  // The old route answers with My settings' own view, as it did, for the page that sent it.
  async function ownFilesReply(req, res, project, login, old) {
    if (req.method === 'GET') return reply(res, 200, { files: await repoSettings.ownFiles({ login, project }) });
    const body = await readBody(req, ownFilesBodyLimit(repoSettings.maxFilesBytes()));
    const saved = await repoSettings.saveOwnFile({ login, project, path: body.path, text: body.text });
    if (old) console.log('repoSettings: old own files route, saved to the default project', { login, project });
    return reply(res, 200, { files: saved, view: old ? myView?.(login) ?? null : await repoSettings.view(project, { login }) });
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
    if (req.method === 'GET' && route.remove) return reply(res, 405, { error: 'method not allowed' });
    if (route.scope !== 'admin' && !login) return reply(res, 409, { error: 'My Woodshed needs GitHub sign-in, which this console does not have' });
    try {
      if (route.scope === 'admin') return await admin(req, res, route, login ?? 'console');
      return await mine(req, res, route, login);
    } catch (err) {
      if (err.shown) return reply(res, err.status ?? 400, { error: err.message });
      console.error('repoSettings: the secret store did not answer', { scope: route.scope, project: route.project, key: route.key, message: firstLine(err) });
      return reply(res, 502, { error: 'The secret store did not answer: try again in a moment' });
    }
  };
}
