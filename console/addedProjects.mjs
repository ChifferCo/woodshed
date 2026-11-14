// The repos an admin adds on the Console settings page, kept in state.json under `addedProjects` beside the ones the
// installation's environment names (WOODSHED_PROJECTS, console/projects.mjs). The two lists make one:
// `liveConfig` appends the added ones to `config.projects`, so an add or a removal applies at once, with no restart.
// The installation's own can only be changed where they are set, and the default project is always one of them.
//
// A program that embeds the console and keeps the repo list itself (README.md, "Embedding the console") passes `host`:
// then every project of the installation is the program's, Add a repo offers the program's list and hands the add to
// it, and Remove takes any of them but the default off through it. Nothing is written to `addedProjects`; the change
// applies to this installation at once (`hostProjects`, read by liveConfig) until the program builds it again from its
// own list.

import { addedProjectsOf, allProjects, projectNameOf, validProjectName, validRepo } from './projects.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createGitHub, explainGhError } from './github.mjs';
import { ACTIVE_STATUSES } from './sessions.mjs';

// `link`, when given, is {href, text}: where the page can send the admin to fix what the message says.
const shown = (message, link = null) => Object.assign(new Error(message), { shown: true }, link && { link });
const httpsLink = (href) => typeof href === 'string' && /^https:\/\/[^\s"'<>]+$/.test(href);

/**
 * What an embedding program's repos hook changed in this installation since it was built: the projects it added and
 * the names it removed. liveConfig reads `changes` (null until something changed); each change replaces it whole.
 * @returns {{changes: {added: object[], removed: string[]}|null}}
 */
export function createHostProjects() {
  return { changes: null };
}

/**
 * @param {{store: {state: object, save: () => void}, config: object, check: (repo: string) => Promise<{installationId: string|null}>,
 *          list?: (() => Promise<object>)|null, host?: object|null, hostProjects?: {changes: object|null}|null,
 *          now?: () => number}} deps
 *   `config` is the live one, whose `projects` already hold the added repos. `check` asks GitHub whether the console
 *   can work on a repo, and which App installation it is on (null where the console has no App, and uses `gh`); it
 *   throws an error with `shown` for a reason the page can say.
 *   `host` is an embedding program's repos hook, `{list?, add, remove, names?}` (installation.mjs, `repos`), and
 *   `hostProjects` what createHostProjects made for this installation's liveConfig: with them, `check` and `list` are
 *   not used.
 */
export function createAddedProjects({ store, config, check, list = null, host = null, hostProjects = null, now = Date.now }) {
  const everyProject = () => allProjects(config);
  // Whether the page asks for a name: an embedding program may name each repo itself.
  const names = host?.names !== false;

  /** Applies an add or a removal through the host to this installation's live list (liveConfig reads it). */
  function applyHost({ add = null, remove = null }) {
    if (!hostProjects) return;
    const prev = hostProjects.changes ?? { added: [], removed: [] };
    const gone = (p) => (remove && p.name === remove) || (add && (p.name === add.name || p.repo.toLowerCase() === add.repo.toLowerCase()));
    hostProjects.changes = {
      added: [...prev.added.filter((p) => !gone(p)), ...(add ? [add] : [])],
      removed: [...prev.removed.filter((n) => n !== add?.name), ...(remove ? [remove] : [])],
    };
  }

  /** The host's list, as the page takes it: valid repos only, and only https links, since the page opens them. */
  async function hostChoices() {
    let found;
    try {
      found = await host.list();
    } catch (err) {
      if (err?.shown) throw err;
      console.warn('projects: repos not listed', { via: 'host', message: firstLine(err) });
      throw shown('The repos could not be listed. Type the repo instead, or try again; the console log says why.');
    }
    return {
      repos: (Array.isArray(found?.repos) ? found.repos : [])
        .map((r) => (typeof r === 'string' ? { repo: r, private: false } : { repo: String(r?.repo ?? ''), private: Boolean(r?.private) }))
        .filter((r) => validRepo(r.repo)),
      grant: (Array.isArray(found?.grant) ? found.grant : []).filter((g) => httpsLink(g?.href)).map((g) => ({ account: String(g.account ?? ''), href: g.href })),
      install: httpsLink(found?.install) ? found.install : null,
      via: 'host',
    };
  }

  /**
   * What Add a repo offers: the repos the App may reach that are not projects yet, and where on GitHub to give it more.
   * @returns {Promise<{repos: {repo: string, private: boolean}[], grant: {account: string, href: string}[], install: string|null}|null>}
   *   null where the console has no App to ask (the page then takes owner/name typed in)
   * @throws {Error}  with `shown`, when GitHub did not answer
   */
  async function choices() {
    const source = host ? (host.list ? hostChoices : null) : list;
    if (!source) return null;
    const found = await source();
    const taken = new Set(everyProject().map((p) => p.repo.toLowerCase()));
    return { ...found, repos: found.repos.filter((r) => !taken.has(r.repo.toLowerCase())) };
  }

  /**
   * Each project, with where it is kept (`source`): `added` on this page, `installation` in the environment, or `host`,
   * the embedding program's list, any of which but the default can be removed here.
   */
  function view() {
    const added = new Set(addedProjectsOf(store).map((p) => p.name));
    return everyProject().map((p) => {
      const source = added.has(p.name) ? 'added' : host ? 'host' : 'installation';
      return {
        name: p.name, repo: p.repo, default: Boolean(p.default), source, removable: source === 'added' || (source === 'host' && !p.default),
        addedBy: p.addedBy ?? null, addedAt: p.addedAt ?? null, sessions: liveSessions(p),
      };
    });
  }

  function liveSessions(p) {
    const live = (store.state.sessions ?? []).filter((s) => ACTIVE_STATUSES.has(s.status) || s.kept || s.owner);
    return live.filter((s) => s.project === p.name || (!s.project && s.repo?.toLowerCase() === p.repo.toLowerCase())).length;
  }

  const stillLive = (live, repo) => shown(`${live} ${live === 1 ? 'session is' : 'sessions are'} still running, or listed to resume, on ${repo}: stop or delete ${live === 1 ? 'it' : 'them'} first.`);

  /**
   * @param {{repo: string, name?: string, by: string}} args
   * @returns {Promise<object>}  the project saved
   * @throws {Error}  with `shown`, for a repo or name the page should refuse with its reason
   */
  async function add({ repo, name, by }) {
    const wanted = String(repo ?? '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '').replace(/\.git$/, '');
    if (!validRepo(wanted)) throw shown('Give the repo as owner/name, such as acme/api.');
    if (host) return addThroughHost({ wanted, name, by });
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
   * The embedding program's add: it checks the repo (and says where to give access when it cannot reach it), keeps it,
   * and names it. The name typed here is passed on only where the program takes one.
   */
  async function addThroughHost({ wanted, name, by }) {
    const typedName = String(name ?? '').trim();
    if (typedName && !names) throw shown('This console names each repo after itself: leave the name empty.');
    if (typedName && !validProjectName(typedName)) throw shown('The name is lowercase letters and digits, in words joined by single dashes, at most 32 long.');
    const taken = everyProject().find((p) => p.repo.toLowerCase() === wanted.toLowerCase());
    if (taken) throw shown(`${taken.repo} is already a project, named ${taken.name}.`);
    const named = typedName && everyProject().find((p) => p.name === typedName);
    if (named) throw shown(`The name ${typedName} is used by ${named.repo}: choose another.`);
    const given = await host.add({ repo: wanted, ...(typedName ? { name: typedName } : {}), by });
    const repo = validRepo(given?.repo) ? given.repo : wanted;
    const project = { name: validProjectName(given?.name) ? given.name : typedName || projectNameOf(repo), repo, default: false };
    applyHost({ add: project });
    console.log('projects: repo added', { project: project.name, repo, via: 'host', by });
    return project;
  }

  /**
   * Takes a repo off the list. A session still running on it, or kept to resume, would fall back to the default
   * project's repo and token, so none may be. Sessions that ended for good keep their record. With `host`, any of the
   * program's but the default is taken off through it; one added on this page before it kept the list is still this
   * page's.
   * @throws {Error}  with `shown`, for the installation's own project, an unknown name, or a repo with live or resumable sessions
   */
  async function remove({ name, by }) {
    const found = addedProjectsOf(store).find((p) => p.name === name);
    if (!found) {
      const project = everyProject().find((p) => p.name === name);
      if (!project) throw shown(`There is no project called ${name}.`);
      if (!host) throw shown(`${name} is set in the installation's configuration: remove it there.`);
      if (project.default) throw shown(`${project.repo} is the default project: it stays.`);
      const live = liveSessions(project);
      if (live) throw stillLive(live, project.repo);
      await host.remove({ name, repo: project.repo, by });
      applyHost({ remove: name });
      console.log('projects: repo removed', { project: name, repo: project.repo, via: 'host', by });
      return;
    }
    const live = liveSessions(found);
    if (live) throw stillLive(live, found.repo);
    store.state.addedProjects = addedProjectsOf(store).filter((p) => p.name !== name);
    store.save();
    console.log('projects: repo removed', { project: name, repo: found.repo, by });
  }

  return { view, add, remove, choices, names };
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
      // One installation GitHub refuses (suspended, or its token denied) leaves out its repos alone.
      lists = await Promise.all(installations.map((i) => appApi.installationRepos(i.id).catch((err) => {
        console.warn('projects: an installation\'s repos not listed', { account: i.account, message: firstLine(err) });
        return null;
      })));
      if (installations.length && lists.every((l) => l === null)) throw new Error('no installation\'s repos could be read');
    } catch (err) {
      console.warn('projects: repos not listed', { message: firstLine(err) });
      throw shown('GitHub did not list the App\'s repos. Type the repo instead, or try again; the console log says why.');
    }
    const slug = await appSlug().catch(() => null);
    const repos = lists.filter(Boolean).flat().sort((a, b) => a.repo.localeCompare(b.repo, undefined, { sensitivity: 'base' }));
    console.log('projects: repos listed', { installations: installations.length, repos: repos.length });
    return {
      repos,
      grant: installations.filter((i) => i.settingsUrl).map((i) => ({ account: i.account, href: i.settingsUrl })),
      install: slug ? installUrl(slug) : null,
      via: 'app',
    };
  };
}

/**
 * What `list` is in a console with no App that runs on its `gh` login (one person's own machine): every repo that
 * login can push to, since a session pushes its branch with it. Nothing to grant: GitHub's own access is the list.
 * @param {{run?: Function}} [deps]  `run` stands in for execFile in tests
 */
export function ghRepoLister({ run = promisify(execFile) } = {}) {
  return async () => {
    let stdout;
    try {
      ({ stdout } = await run('gh', ['api', '--paginate', 'user/repos?per_page=100&sort=full_name',
        '--jq', '.[] | select(.permissions.push) | [.full_name, .private] | @tsv'], { maxBuffer: 16 * 1024 * 1024 }));
    } catch (err) {
      console.warn('projects: repos not listed', { via: 'gh', message: firstLine(explainGhError(err)) });
      throw shown('gh did not list your repos. Type the repo instead, or try again; the console log says why.');
    }
    const repos = stdout.split('\n').filter(Boolean).map((line) => {
      const [repo, priv] = line.split('\t');
      return { repo, private: priv === 'true' };
    }).filter((r) => validRepo(r.repo)).sort((a, b) => a.repo.localeCompare(b.repo, undefined, { sensitivity: 'base' }));
    console.log('projects: repos listed', { via: 'gh', repos: repos.length });
    return { repos, grant: [], install: null, via: 'gh' };
  };
}
