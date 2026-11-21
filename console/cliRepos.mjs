// The command line's Repos card. The same project store and changes as on Console settings, including a hosting
// program's repos hook. Only admins can see which other repositories the console's GitHub credential reaches.
import { validRepo } from './projects.mjs';

export const CLI_REPOS_PATH = '/api/cli/repos';

// The hosted repos hook returns an ordinary page link in its refusal. Only GitHub App management pages mark it
// as needing App access: a link to the host's computer or repository settings is a different refusal.
function githubAppLink(href) {
  if (typeof href !== 'string') return null;
  const url = URL.parse(href);
  if (url?.origin !== 'https://github.com' || url.username || url.password) return null;
  const path = /^\/(?:apps\/[\w-]+\/installations\/new|(?:organizations\/[\w-]+\/)?settings\/installations\/\d+)\/?$/;
  return path.test(url.pathname) ? url : null;
}

function repoList(projects, choices, canChange) {
  const connected = new Set(projects.map((p) => p.repo.toLowerCase()));
  const reachable = new Set(choices?.repos.map((p) => p.repo.toLowerCase()));
  const githubApp = choices?.via === 'app' || (choices?.via === 'host' && Boolean(choices.complete || choices.install || choices.grant.length));
  const complete = choices?.via === 'app' ? !choices.incomplete : choices?.complete === true;
  return {
    canChange,
    projects: projects.map(({ name, repo, removable, sessions }) => ({
      name, repo, removable: canChange && Boolean(removable) && !sessions,
      githubAppAccess: githubApp && reachable.has(repo.toLowerCase()) ? true : githubApp && complete ? false : null,
    })),
    available: choices?.repos.filter((p) => !connected.has(p.repo.toLowerCase()))
      .map(({ repo }) => ({ repo, githubAppAccess: githubApp ? true : null })) ?? null,
    ...(choices?.incomplete && { choicesIncomplete: true }),
  };
}

export async function handleCliRepos({ req, res, url, cli, reply, readJson, addedProjects, canManageRepos, projectsView, removeRepo }) {
  const remove = url.pathname === `${CLI_REPOS_PATH}/remove`;
  const { method } = req;
  if (req.headers.origin !== undefined) return reply(res, 403, { error: 'a command line token is for the woodshed command line, not a page' });
  if (method !== 'POST' && (method !== 'GET' || remove)) return reply(res, 405, { error: 'method not allowed' });
  const { signedIn, error } = await cli.authenticate(req.headers);
  if (!signedIn) return reply(res, 401, { error });
  const { login, id } = signedIn;
  let repo;
  try {
    const canChange = await canManageRepos(login);
    if (method === 'GET') {
      if (!canChange) return reply(res, 200, repoList((await projectsView(login)).projects, null, false));
      if (!addedProjects) return reply(res, 404, { error: 'this console keeps no list of repos' });
      let choicesError;
      const choices = await addedProjects.choices({ includeConnected: true }).catch((err) => {
        if (!err.shown) throw err;
        choicesError = err.message;
        return null;
      });
      return reply(res, 200, { ...repoList(addedProjects.view(), choices, true), ...(choicesError && { choicesError }) });
    }
    if (!canChange) {
      const reason = canChange === null ? 'This hosted console does not give the command line admin roles. Use Console settings.' : "only an admin can change the console's repos";
      return reply(res, 403, { error: reason });
    }
    if (!addedProjects) return reply(res, 404, { error: 'this console keeps no list of repos' });
    const body = await readJson(req).catch(() => null);
    if (!validRepo(body?.repo) || (body.name !== undefined && (remove || typeof body.name !== 'string'))) {
      return reply(res, 400, { error: 'give the repo as owner/name, such as acme/api' });
    }
    repo = body.repo;
    const by = login ?? 'console';
    console.log('cliRepos: change requested', { login, token: id, repo, remove });
    if (remove) {
      const project = addedProjects.view().find((p) => p.repo.toLowerCase() === repo.toLowerCase());
      if (!project) return reply(res, 409, { error: `${repo} is not one of this console's repos` });
      await removeRepo(project.name, by);
      return reply(res, 200, { repo: project.repo, name: project.name });
    }
    const project = await addedProjects.add({ repo, name: body.name, by });
    return reply(res, 200, { repo: project.repo, name: project.name });
  } catch (err) {
    if (err.shown) {
      const link = method === 'POST' && !remove ? githubAppLink(err.link?.href) : null;
      const account = link?.pathname.match(/^\/organizations\/([\w-]+)\//)?.[1];
      const owner = repo?.split('/')[0];
      if (account && owner && account.toLowerCase() !== owner.toLowerCase()) {
        return reply(res, 409, { error: `This workspace uses the GitHub App on ${account}. Use the workspace for ${owner} to add its repo.` });
      }
      const needsGitHubApp = method === 'POST' && !remove && (link || err.needsGitHubApp);
      return reply(res, needsGitHubApp ? 409 : err.status ?? (method === 'GET' ? 502 : 409), {
        error: err.message, ...(needsGitHubApp && { status: 'needs-github-app', url: link?.href ?? null }),
      });
    }
    console.error('cliRepos: request failed', { method, remove, login, message: String(err?.message ?? err).split('\n')[0] });
    return reply(res, 502, { error: 'The repo request failed. The console log says why.' });
  }
}
