// The GitHub App tokens of each project: the console's own, a coding session's and an ask session's. Each reaches its
// project's repo alone, from the project's installation of the App. The default project's keep the labels they had
// before there were projects, so a console with one project logs what it did.

import { createTokenSource } from './githubApp.mjs';
import { defaultProject, installationIdFor, projectFor } from './projects.mjs';

// Sessions get less than the console: they push, open PRs, read CI's results and re-run its jobs, and never touch workflows.
const SESSION_PERMISSIONS = {
  contents: 'write', pull_requests: 'write', issues: 'write', metadata: 'read', checks: 'read', actions: 'write', statuses: 'read',
};
// An ask session (asks.mjs) reads the code, its history and its pull requests, and writes nothing.
const ASK_PERMISSIONS = { contents: 'read', pull_requests: 'read', issues: 'read', metadata: 'read' };

function sourcesFor({ config, privateKey, fetchImpl, now, project }) {
  const app = { appId: config.githubApp.appId, installationId: installationIdFor(config, project), repo: project.repo, privateKey, fetchImpl, now };
  const suffix = project.default ? '' : `:${project.name}`;
  return {
    console: createTokenSource({ ...app, label: `console${suffix}` }),
    sessions: createTokenSource({ ...app, permissions: SESSION_PERMISSIONS, label: `sessions${suffix}` }),
    asks: createTokenSource({ ...app, permissions: ASK_PERMISSIONS, label: `asks${suffix}` }),
  };
}

/**
 * @param {{config: object, privateKey: string|(() => string|null), fetchImpl?: typeof fetch, now?: () => number}} opts
 * @returns {null|{console: object, sessions: object, asks: object,
 *   forSession: (session: object) => {project: string, default: boolean, console: object, sessions: object, asks: object}}}
 *   the default project's sources, and `forSession` for the project a session runs on; null without a GitHub App
 */
export function createProjectTokens({ config, privateKey, fetchImpl, now }) {
  if (!config.githubApp) return null;
  const main = defaultProject(config);
  // A project an admin removed and added again may be on another installation, so a source is kept per repo and installation.
  const keyOf = (project) => `${project.name}\n${project.repo}\n${installationIdFor(config, project)}`;
  const byName = new Map([[keyOf(main), sourcesFor({ config, privateKey, fetchImpl, now, project: main })]]);
  return {
    ...byName.get(keyOf(main)),
    forSession(session) {
      const project = projectFor(config, session);
      const key = keyOf(project);
      if (!byName.has(key)) byName.set(key, sourcesFor({ config, privateKey, fetchImpl, now, project }));
      return { project: project.name, default: project.name === main.name, ...byName.get(key) };
    },
  };
}
