// What the console reads from the repo's project file (.woodshed/project.yaml, docs/reference.md, "The project file"): the
// variables each env file always gets from the entrypoint, which My settings lists so nobody sets them, the gates a
// pull request waits for before it is posted (`pullRequests`, prAnnouncer.mjs), and the databases whose engines the
// installation must host before a session starts (`databases`), and where a database keeps its migrations, which Restore
// a dump counts a copy's against (`databases[].migrations`, with the table it records them in, what its dump commands
// leave out and its migrate command, dbRestore.mjs). Read from the repo's default branch, or the installation's file for a
// repo with none there (WOODSHED_CLOUD_PROJECT_FILES_DIR, shared/project.mjs), and kept for a while. A file that cannot
// be read leaves My settings without that list, never without the page, and holds the pull requests until it can be
// read: an unread file is not a file with no gates.
import { parseYaml } from '../shared/yamlLite.mjs';
import { parseProject } from '../shared/project.mjs';

const KEEP_MS = 10 * 60_000;
// A failed read is tried again sooner: the pull requests wait on it.
const RETRY_MS = 60_000;

function appendedFrom(project) {
  return new Map((project?.envFiles ?? []).filter((f) => f.secret).map((f) => [f.secret, f.lines.map((l) => l.split('=')[0].trim()).filter(Boolean)]));
}

/** @returns {Map<string, string[]>}  each env file's secret, with the variables its `lines` write */
export function appendedBySecret(text) {
  return appendedFrom(parseProject(parseYaml(text)));
}

/**
 * @param {{github: {projectFile: () => Promise<string|null>, fileNames: (folder: string) => Promise<string[]>},
 *          installationFile?: () => {text: string}|null, now?: () => number}} deps  `installationFile` is the
 *   installation's project file for the repo (installationProjectFile), read only when its default branch has none
 */
export function createProjectReader({ github, installationFile = () => null, now = Date.now }) {
  let pending = null;
  let readAt = -Infinity;
  let keepMs = KEEP_MS;

  // The repo's own file wins: the installation's is for a repo that has none.
  async function readText() {
    const text = await github.projectFile();
    if (text !== null) return { text, from: 'default branch' };
    const supplied = installationFile();
    return supplied ? { text: supplied.text, from: 'installation' } : { text: null, from: 'none' };
  }

  async function load() {
    try {
      const { text, from } = await readText();
      const project = text === null ? null : parseProject(parseYaml(text));
      console.log('projectFile: read', {
        found: text !== null, from, envFiles: project?.envFiles?.length ?? 0, pullRequests: Boolean(project?.pullRequests),
        databases: project?.databases?.map((d) => d.engine) ?? [],
      });
      return { project, error: null };
    } catch (err) {
      console.warn('projectFile: not readable', { message: String(err?.message ?? err).split('\n')[0] });
      return { project: null, error: err };
    }
  }

  // One read at a time, shared: My settings asks for each file at once, and a second caller must wait for the first's
  // answer, not see none.
  function read() {
    if (!pending || now() - readAt >= keepMs) {
      readAt = now();
      keepMs = KEEP_MS;
      pending = load().then((answer) => {
        if (answer.error) keepMs = RETRY_MS;
        return answer;
      });
    }
    return pending;
  }

  return {
    /** @returns {Promise<string[]>} */
    async appendedFor(secret) {
      return appendedFrom((await read()).project).get(secret) ?? [];
    },
    /**
     * @returns {Promise<object|null>}  the parsed `pullRequests`; null for a repo with none, or no project file
     * @throws {Error}  when the file could not be read or parsed
     */
    async pullRequests() {
      const { project, error } = await read();
      if (error) throw new Error(`the project file could not be read: ${String(error.message ?? error).split('\n')[0]}`);
      return project?.pullRequests ?? null;
    },
    /**
     * @returns {Promise<boolean|null>}  whether what is posted to the repo may name the console's address (`consoleLinks`,
     *   true with no project file); null when the file could not be read
     */
    async consoleLinks() {
      const { project, error } = await read();
      if (error) return null;
      return project?.consoleLinks ?? true;
    },
    /**
     * @returns {Promise<'full'|'repo'|null>}  how far a private session's GitHub token reaches (`githubAccess`, full with no
     *   project file); null when the file could not be read
     */
    async githubAccess() {
      const { project, error } = await read();
      if (error) return null;
      return project?.githubAccess ?? 'full';
    },
    /**
     * @returns {Promise<{engine: string, migrate: string|null, migrationsTable: object|null, dump: object}[]|null>}  the project's databases ([] with no project file); null when the file
     *   could not be read, which refuses nothing: the session checks its own copy at start
     */
    async databases() {
      const { project, error } = await read();
      if (error) return null;
      return project?.databases ?? [];
    },
    /**
     * @returns {Promise<string[]>}  the files in the engine's database's `migrations` folder on the default branch; []
     *   for a project with no such database, or one that keeps no migrations
     * @throws {Error}  when the file could not be read, or the folder not listed
     */
    async migrationFiles(engine) {
      const { project, error } = await read();
      if (error) throw new Error(`the project file could not be read: ${String(error.message ?? error).split('\n')[0]}`);
      const folder = project?.databases?.find((d) => d.engine === engine)?.migrations ?? null;
      if (!folder) {
        console.log('projectFile: no migrations folder', { engine });
        return [];
      }
      return github.fileNames(folder);
    },
  };
}
