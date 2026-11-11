// The GitHub App tokens of each project: the console's own, a coding session's and an ask session's. Each reaches its
// project's repo alone, from the project's installation of the App. The default project's keep the labels they had
// before there were projects, so a console with one project logs what it did.
//
// A console that borrows its GitHub access (githubBroker.mjs) asks the host's broker for the same three, each narrowed
// the same way, and uses none the broker says can do more.

import { createGitHubBroker } from './githubBroker.mjs';
import { createTokenSource } from './githubApp.mjs';
import { defaultProject, installationIdFor, projectFor } from './projects.mjs';

// Sessions get less than the console: they push, open PRs, read CI's results and re-run its jobs, and never touch workflows.
// An owner's token scoped to another project's repo (githubUser.mjs) gets the same.
export const SESSION_PERMISSIONS = {
  contents: 'write', pull_requests: 'write', issues: 'write', metadata: 'read', checks: 'read', actions: 'write', statuses: 'read',
};
// An ask session (asks.mjs) reads the code, its history and its pull requests, and writes nothing.
const ASK_PERMISSIONS = { contents: 'read', pull_requests: 'read', issues: 'read', metadata: 'read' };

function sourcesFor({ config, privateKey, fetchImpl, now, project, broker }) {
  const suffix = project.default ? '' : `:${project.name}`;
  if (broker) {
    return {
      console: broker.tokenSource({ repo: project.repo, label: `console${suffix}` }),
      sessions: broker.tokenSource({ repo: project.repo, permissions: SESSION_PERMISSIONS, label: `sessions${suffix}` }),
      asks: broker.tokenSource({ repo: project.repo, permissions: ASK_PERMISSIONS, label: `asks${suffix}` }),
    };
  }
  const app = { appId: config.githubApp.appId, installationId: installationIdFor(config, project), repo: project.repo, privateKey, fetchImpl, now };
  return {
    console: createTokenSource({ ...app, label: `console${suffix}` }),
    sessions: createTokenSource({ ...app, permissions: SESSION_PERMISSIONS, label: `sessions${suffix}` }),
    asks: createTokenSource({ ...app, permissions: ASK_PERMISSIONS, label: `asks${suffix}` }),
  };
}

/**
 * @param {{config: object, privateKey: string|(() => string|null), fetchImpl?: typeof fetch, now?: () => number}} opts
 * @returns {null|{console: object, sessions: object, asks: object,
 *   forSession: (session: object) => {project: string, default: boolean, repo: string, permissions: object,
 *     console: object, sessions: object, asks: object}}}
 *   the default project's sources, and `forSession` for the project a session runs on; null without a GitHub App or
 *   a broker. With a broker, `borrowFor(repo)` asks it for a read-only token to any repo, which is how the Console
 *   settings page checks a repo it is asked to add (addedProjects.mjs) where there is no App to ask.
 */
export function createProjectTokens({ config, privateKey, fetchImpl, now }) {
  if (!config.githubApp && !config.githubBroker) return null;
  const broker = config.githubBroker ? createGitHubBroker({ ...config.githubBroker, fetchImpl, now }) : null;
  const main = defaultProject(config);
  // A project an admin removed and added again may be on another installation, so a source is kept per repo and installation.
  const keyOf = (project) => `${project.name}\n${project.repo}\n${broker ? '' : installationIdFor(config, project)}`;
  const byName = new Map([[keyOf(main), sourcesFor({ config, privateKey, fetchImpl, now, project: main, broker })]]);
  return {
    ...byName.get(keyOf(main)),
    borrowFor: broker ? (repo) => broker.tokenSource({ repo, permissions: { contents: 'read', metadata: 'read' }, label: 'repo check' }).token() : null,
    forSession(session) {
      const project = projectFor(config, session);
      const key = keyOf(project);
      if (!byName.has(key)) byName.set(key, sourcesFor({ config, privateKey, fetchImpl, now, project, broker }));
      return {
        project: project.name, default: project.name === main.name, repo: project.repo, permissions: SESSION_PERMISSIONS,
        ...byName.get(key),
      };
    },
  };
}
