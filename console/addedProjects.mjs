// The repos an admin adds on the Console settings page, kept in state.json under `addedProjects` beside the ones the
// installation's environment names (WOODSHED_CLOUD_PROJECTS, console/projects.mjs). The two lists make one:
// `liveConfig` appends the added ones to `config.projects`, so an add or a removal applies at once, with no restart.
// The installation's own can only be changed where they are set, and the default project is always one of them.

import { addedProjectsOf, allProjects, projectNameOf, validProjectName, validRepo } from './projects.mjs';
import { createGitHub } from './github.mjs';
import { ACTIVE_STATUSES } from './sessions.mjs';

// `link`, when given, is {href, text}: where the page can send the admin to fix what the message says.
const shown = (message, link = null) => Object.assign(new Error(message), { shown: true }, link && { link });

/**
 * @param {{store: {state: object, save: () => void}, config: object, check: (repo: string) => Promise<{installationId: string|null}>,
 *          now?: () => number}} deps
 *   `config` is the live one, whose `projects` already hold the added repos. `check` asks GitHub whether the console
 *   can work on a repo, and which App installation it is on (null where the console has no App, and uses `gh`); it
 *   throws an error with `shown` for a reason the page can say.
 */
export function createAddedProjects({ store, config, check, list = null, now = Date.now }) {
  const everyProject = () => allProjects(config);

  /**
   * What Add a repo offers: the repos the App may reach that are not projects yet, and where on GitHub to give it more.
   * @returns {Promise<{repos: {repo: string, private: boolean}[], grant: {account: string, href: string}[], install: string|null}|null>}
   *   null where the console has no App to ask (the page then takes owner/name typed in)
   * @throws {Error}  with `shown`, when GitHub did not answer
   */
  async function choices() {
    if (!list) return null;
    const found = await list();
    const taken = new Set(everyProject().map((p) => p.repo.toLowerCase()));
    return { ...found, repos: found.repos.filter((r) => !taken.has(r.repo.toLowerCase())) };
  }

  function view() {
    const added = new Set(addedProjectsOf(store).map((p) => p.name));
    const live = (store.state.sessions ?? []).filter((s) => ACTIVE_STATUSES.has(s.status) || s.kept || s.owner);
    return everyProject().map((p) => ({
      name: p.name, repo: p.repo, default: Boolean(p.default), removable: added.has(p.name),
      addedBy: p.addedBy ?? null, addedAt: p.addedAt ?? null,
      sessions: live.filter((s) => s.project === p.name || (!s.project && s.repo?.toLowerCase() === p.repo.toLowerCase())).length,
    }));
  }

  /**
   * @param {{repo: string, name?: string, by: string}} args
   * @returns {Promise<object>}  the project saved
   * @throws {Error}  with `shown`, for a repo or name the page should refuse with its reason
   */
  async function add({ repo, name, by }) {
    const wanted = String(repo ?? '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '').replace(/\.git$/, '');
    if (!validRepo(wanted)) throw shown('Give the repo as owner/name, such as acme/api.');
    const chosen = String(name ?? '').trim() || projectNameOf(wanted);
    if (!validProjectName(chosen)) throw shown('The name is lowercase letters and digits, in words joined by single dashes, at most 32 long.');
    const taken = everyProject().find((p) => p.repo.toLowerCase() === wanted.toLowerCase());
    if (taken) throw shown(`${taken.repo} is already a project, named ${taken.name}.`);
    const named = everyProject().find((p) => p.name === chosen);
    if (named) throw shown(`The name ${chosen} is used by ${named.repo}: choose another.`);
    const { installationId } = await check(wanted);
    // Another add may have finished while GitHub was asked.
    if (everyProject().some((p) => p.name === chosen || p.repo.toLowerCase() === wanted.toLowerCase())) throw shown(`${wanted} was just added: reload the page.`);
    const project = { name: chosen, repo: wanted, default: false, addedBy: by, addedAt: new Date(now()).toISOString() };
    if (installationId && String(installationId) !== String(config.githubApp?.installationId ?? '')) project.installationId = String(installationId);
    store.state.addedProjects = [...addedProjectsOf(store), project];
    store.save();
    console.log('projects: repo added', { project: chosen, repo: wanted, own: Boolean(project.installationId), by });
    return project;
  }

  /**
   * Takes an added repo off the list. A session still running on it, or kept to resume, would fall back to the
   * default project's repo and token, so none may be. Sessions that ended for good keep their record.
   * @throws {Error}  with `shown`, for the installation's own project, an unknown name, or a repo with live or resumable sessions
   */
  function remove({ name, by }) {
    const found = addedProjectsOf(store).find((p) => p.name === name);
    if (!found) {
      throw shown(everyProject().some((p) => p.name === name)
        ? `${name} is set in the installation's configuration: remove it there.`
        : `There is no project called ${name}.`);
    }
    const live = view().find((p) => p.name === name)?.sessions ?? 0;
    if (live) throw shown(`${live} ${live === 1 ? 'session is' : 'sessions are'} still running, or listed to resume, on ${found.repo}: stop or delete ${live === 1 ? 'it' : 'them'} first.`);
    store.state.addedProjects = addedProjectsOf(store).filter((p) => p.name !== name);
    store.save();
    console.log('projects: repo removed', { project: name, repo: found.repo, by });
  }

  return { view, add, remove, choices };
}

/**
 * What `check` is in the console: with the GitHub App, the repo must have it installed, and its installation is kept
 * when it differs from the console's own; without one (the local provider, on `gh`), the repo must be readable.
 * A repo on an account the App is installed on, but not given access to, is refused with a link to that installation's
 * settings on GitHub, where its repos are picked; a repo on an account without the App, with one to the App's install
 * page, when the App's slug can be read.
 * @param {{appApi: {installationOf: (repo: string) => Promise<string|null>,
 *                   installations?: () => Promise<{id: string, account: string, settingsUrl: string}[]>}|null,
 *          read?: (repo: string) => Promise<unknown>, appSlug?: () => Promise<string|null>}} deps
 */
export function repoChecker({ appApi, read = (repo) => createGitHub({ repo }).defaultBranch(), appSlug = async () => null }) {
  return async (repo) => {
    if (appApi) {
      let installationId;
      try {
        installationId = await appApi.installationOf(repo);
      } catch (err) {
        console.warn('projects: installation not read', { repo, message: firstLine(err) });
        throw shown('GitHub did not answer about that repo. Try again; the console log says why.');
      }
      if (!installationId) {
        const owner = repo.split('/')[0].toLowerCase();
        const [slug, installations] = await Promise.all([
          appSlug().catch(() => null),
          (appApi.installations?.() ?? Promise.resolve([])).catch((err) => {
            console.warn('projects: installations not read', { message: firstLine(err) });
            return [];
          }),
        ]);
        const app = slug ?? 'the GitHub App';
        const on = installations.find((i) => i.account.toLowerCase() === owner && i.settingsUrl);
        if (on) {
          throw shown(`${slug ?? 'The GitHub App'} is installed on ${on.account}, but may not reach ${repo}, or the repo does not exist. Give it access to the repo on GitHub (Repository access), then add it again.`,
            { href: on.settingsUrl, text: `Give ${app} access to ${repo} on GitHub` });
        }
        if (!slug) throw shown(`The GitHub App is not installed on ${repo}, or it does not exist. Install the App on it (GitHub, the App's Install page), then add it again.`);
        // GitHub's page lists the accounts the App can go on.
        throw shown(`The GitHub App is not installed on ${repo.split('/')[0]}, or ${repo} does not exist. Install the App on it, then add it again.`,
          { href: installUrl(slug), text: `Install ${slug} on GitHub` });
      }
      return { installationId };
    }
    try {
      await read(repo);
    } catch {
      throw shown(`The console cannot read ${repo}: check the name, and that its GitHub login can see it.`);
    }
    return { installationId: null };
  };
}

const firstLine = (err) => String(err?.message ?? err).split('\n')[0];
const installUrl = (slug) => `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;

/**
 * What `list` is in the console with the GitHub App: every repo each of its installations may reach, each account's
 * installation settings (where more repos are given to it), and its install page for another account.
 * @param {{appApi: {installations: Function, installationRepos: Function}, appSlug?: () => Promise<string|null>}} deps
 */
export function repoLister({ appApi, appSlug = async () => null }) {
  return async () => {
    let installations;
    let lists;
    try {
      installations = await appApi.installations();
      lists = await Promise.all(installations.map((i) => appApi.installationRepos(i.id)));
    } catch (err) {
      console.warn('projects: repos not listed', { message: firstLine(err) });
      throw shown('GitHub did not list the App\'s repos. Type the repo instead, or try again; the console log says why.');
    }
    const slug = await appSlug().catch(() => null);
    const repos = lists.flat().sort((a, b) => a.repo.localeCompare(b.repo, undefined, { sensitivity: 'base' }));
    console.log('projects: repos listed', { installations: installations.length, repos: repos.length });
    return {
      repos,
      grant: installations.filter((i) => i.settingsUrl).map((i) => ({ account: i.account, href: i.settingsUrl })),
      install: slug ? installUrl(slug) : null,
    };
  };
}
