// The repos an installation works on, each a project. Until the rest of the console takes a project, everything
// runs on the default one, so a console with one project does what it did when it had only WOODSHED_CLOUD_REPO.

const REPO = /^[\w.-]+\/[\w.-]+$/;
// A project's name goes into AWS and database names later, so it stays short and plain: ECR refuses a name that
// ends in a dash or has two in a row.
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const NAME_MAX = 32;
const INSTALLATION_ID = /^\d+$/;

/** The name a project gets when the installation names only its repo: the repo's own name, made plain. */
export function projectNameOf(repo) {
  return repo.split('/').pop().toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, NAME_MAX).replace(/^-+|-+$/g, '') || 'default';
}

/** @returns {boolean}  whether `name` can name a project: lowercase words of letters and digits, joined by single dashes */
export const validProjectName = (name) => typeof name === 'string' && NAME.test(name) && name.length <= NAME_MAX;

/** @returns {boolean}  whether `repo` is GitHub's `owner/name` */
export const validRepo = (repo) => typeof repo === 'string' && REPO.test(repo) && repo.split('/').every((part) => !/^\.+$/.test(part));

function fromJson(value) {
  let list;
  try {
    list = JSON.parse(value);
  } catch (err) {
    throw new Error(`WOODSHED_CLOUD_PROJECTS is not JSON (${err.message})`);
  }
  return projectsFrom(list);
}

/**
 * A list of projects, each `{ name, repo, default, installationId }`, checked as WOODSHED_CLOUD_PROJECTS is, for a
 * caller that has the list already parsed.
 * @param {unknown} list
 * @param {string} [setting]  what to name in an error
 * @returns {{name: string, repo: string, default: boolean, installationId?: string}[]}
 */
export function projectsFrom(list, setting = 'WOODSHED_CLOUD_PROJECTS') {
  if (!Array.isArray(list) || !list.length) throw new Error(`${setting} must be a list of projects, each { "name", "repo" }`);
  const projects = list.map((entry, i) => {
    const { name, repo, installationId } = entry ?? {};
    if (typeof name !== 'string' || !NAME.test(name) || name.length > NAME_MAX) {
      throw new Error(`${setting}[${i}]: name must be lowercase letters and digits, in words joined by single dashes, at most ${NAME_MAX} long`);
    }
    if (typeof repo !== 'string' || !REPO.test(repo)) throw new Error(`${setting}[${i}] (${name}): repo must be owner/name`);
    const project = { name, repo, default: entry.default === true };
    if (installationId !== undefined) {
      if (!INSTALLATION_ID.test(String(installationId))) throw new Error(`${setting}[${i}] (${name}): installationId must be the GitHub App installation's number`);
      project.installationId = String(installationId);
    }
    return project;
  });
  for (const key of ['name', 'repo']) {
    const seen = new Set();
    for (const project of projects) {
      const value = key === 'repo' ? project.repo.toLowerCase() : project.name;
      if (seen.has(value)) throw new Error(`${setting}: two projects have the ${key} ${project[key]}`);
      seen.add(value);
    }
  }
  const defaults = projects.filter((p) => p.default);
  if (projects.length === 1) projects[0].default = true;
  else if (defaults.length !== 1) throw new Error(`${setting}: exactly one project must have "default": true`);
  return projects;
}

/**
 * The installation's projects, from `WOODSHED_CLOUD_PROJECTS` (a JSON list of `{ name, repo, default, installationId }`), or else
 * one project made from `WOODSHED_CLOUD_REPO`. None when neither is set, which providers/console.mjs refuses.
 * @param {NodeJS.ProcessEnv} env
 */
export function loadProjects(env) {
  const repo = (env.WOODSHED_CLOUD_REPO || '').trim();
  const json = (env.WOODSHED_CLOUD_PROJECTS || '').trim();
  if (!json) return repo ? [{ name: projectNameOf(repo), repo, default: true }] : [];
  const projects = fromJson(json);
  const main = projects.find((p) => p.default);
  if (repo && repo.toLowerCase() !== main.repo.toLowerCase()) throw new Error(`WOODSHED_CLOUD_REPO is ${repo} but the default project's repo is ${main.repo}: set one of them`);
  return projects;
}

/**
 * The project sessions run on unless they say otherwise. A config made by hand, as tests and askInImage.mjs make
 * them, may name only a `repo`.
 */
export function defaultProject(config) {
  const found = config.projects?.find((p) => p.default);
  if (found) return found;
  return { name: projectNameOf(config.repo || ''), repo: config.repo || '', default: true };
}

/**
 * The project a session runs on. A record from before sessions named their project, or one naming a project the
 * installation no longer has, is on the project with its repo, and otherwise on the default one.
 */
export function projectFor(config, session) {
  const projects = config.projects ?? [];
  const repo = (session?.repo || '').toLowerCase();
  return projects.find((p) => p.name === session?.project)
    ?? (repo ? projects.find((p) => p.repo.toLowerCase() === repo) : undefined)
    ?? defaultProject(config);
}

/** The GitHub App installation a project's tokens come from: its own, or the installation's. */
export function installationIdFor(config, project) {
  return project.installationId ?? config.githubApp?.installationId ?? null;
}

/** Every project of the installation, the default first: a config made by hand has its one. */
export function allProjects(config) {
  const projects = config.projects?.length ? config.projects : [defaultProject(config)];
  return [...projects].sort((a, b) => Number(b.default) - Number(a.default));
}

/** @returns {object|null}  the project with that name, or null when the installation has none by it */
export function projectNamed(config, name) {
  return allProjects(config).find((p) => p.name === name) ?? null;
}

/** @returns {object|null}  the project whose repo is `fullName` (GitHub's `owner/name`, any case), or null for none */
export function projectForRepo(config, fullName) {
  if (typeof fullName !== 'string' || !fullName) return null;
  const wanted = fullName.toLowerCase();
  return allProjects(config).find((p) => p.repo.toLowerCase() === wanted) ?? null;
}

/** @returns {object[]}  the projects an admin added on the Console settings page (addedProjects.mjs), kept in state.json */
export function addedProjectsOf(store) {
  return Array.isArray(store.state.addedProjects) ? store.state.addedProjects : [];
}
