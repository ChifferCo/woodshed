// Which projects a person may start a My Woodshed session on, and the one New session opens on for them. Signing in
// already proved write access to the default project's repo; every other project's is asked of GitHub, and kept a
// while, since New session and My settings ask on each load.

import { allProjects, projectNamed } from './projects.mjs';

const FRESH_MS = 10 * 60_000;

const firstLine = (err) => String(err?.message ?? err).split('\n')[0];

/**
 * @param {{config: object, githubFor: (project: object) => ({canWrite: (login: string) => Promise<boolean>}|null),
 *          viewPrefs?: {defaultProject: (login: string|null) => string|null, setDefaultProject: (login: string|null, name: string|null) => string|null}|null,
 *          signIn?: () => boolean, now?: () => number}} opts
 *   `githubFor` is the GitHub client of a project's repo, null where the console has no GitHub to ask; `signIn` says
 *   whether people sign in, without which the login is a stand-in GitHub knows nothing of
 */
export function createProjectAccess({ config, githubFor, viewPrefs = null, signIn = () => true, now = Date.now }) {
  const checked = new Map();
  let toldUnchecked = false;

  async function canStart(login, project) {
    if (project.default) return true;
    const github = githubFor(project);
    // A console with no sign-in, or no GitHub, cannot tell people apart or ask: whoever reaches it may use them all,
    // as they may its default project.
    if (!login || !signIn() || !github) {
      if (!toldUnchecked) console.log('projects: write access not checked, every project offered', { signIn: signIn(), github: Boolean(github) });
      toldUnchecked = true;
      return true;
    }
    const key = `${login}\n${project.name}`;
    const kept = checked.get(key);
    if (kept && now() - kept.at < FRESH_MS) return kept.ok;
    try {
      const ok = await github.canWrite(login);
      checked.set(key, { at: now(), ok });
      console.log('projects: write access checked', { login, project: project.name, ok });
      return ok;
    } catch (err) {
      console.warn('projects: write access not checked, project left out', { login, project: project.name, message: firstLine(err) });
      return false;
    }
  }

  /** @returns {Promise<object[]>}  the projects the person may start on, the installation's default first */
  async function startable(login) {
    const projects = allProjects(config);
    if (projects.length === 1) return projects;
    const allowed = await Promise.all(projects.map((project) => canStart(login, project)));
    return projects.filter((_, i) => allowed[i]);
  }

  /**
   * @returns {Promise<{projects: {name: string, repo: string}[], defaultProject: string, saved: boolean}>}
   *   `defaultProject` is the person's own choice while they may still start on it, else the installation's
   */
  async function view(login) {
    const projects = await startable(login);
    const saved = viewPrefs?.defaultProject(login) ?? null;
    const own = saved ? projects.find((p) => p.name === saved) : null;
    if (saved && !own) console.log('projects: saved default not offered, the installation\'s used', { login, saved });
    return { projects: projects.map(({ name, repo }) => ({ name, repo })), defaultProject: (own ?? projects[0]).name, saved: Boolean(own) };
  }

  /** @returns {Promise<object|null>}  the view after saving, or null when the person may not start on that project */
  async function setDefault(login, name) {
    const project = projectNamed(config, name);
    if (!project || !(await canStart(login, project))) return null;
    viewPrefs.setDefaultProject(login, project.default ? null : project.name);
    console.log('projects: default project saved', { login, project: project.name });
    return view(login);
  }

  /**
   * The project a new session starts on: the one asked for, or the installation's default when none is named (a page
   * from before projects).
   * @returns {Promise<object|null>}  null when the person may not start on it, or there is no such project
   */
  async function forStart(login, name) {
    if (!name) return allProjects(config)[0];
    const project = projectNamed(config, name);
    if (!project) return null;
    return (await canStart(login, project)) ? project : null;
  }

  return { view, setDefault, forStart, startable };
}
