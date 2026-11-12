// App commands saved in this installation, keyed by repository. Only a Set up app request from the page grants a
// session permission to save. The session cannot choose a different repository or change other project settings.
import { parseProject } from '../shared/project.mjs';
import { projectFor } from './projects.mjs';
import { isAsk, isQa } from './sessions.mjs';

export function createSavedApps({ store, config }) {
  function repoOf(session) {
    const repo = projectFor(config, session).repo;
    if (!repo || (session.repo && session.repo.toLowerCase() !== repo.toLowerCase())) throw new Error('the session no longer belongs to this project');
    return repo.toLowerCase();
  }
  function read(session) {
    const repo = repoOf(session);
    return { repo, app: store.state.savedApps?.[repo]?.app ?? null };
  }
  function save(session, app) {
    if (isAsk(session) || isQa(session) || session.appSetupDestination !== 'woodshed') {
      throw Object.assign(new Error('choose This Woodshed in Set up app before saving'), { status: 403 });
    }
    const checked = parseProject({ version: 1, app }).app;
    if (!checked) throw new Error('app is required');
    const repo = repoOf(session);
    const previous = store.state.savedApps?.[repo];
    if (previous && JSON.stringify(previous.app) !== JSON.stringify(checked)) {
      throw Object.assign(new Error('this repository already has a saved app; start a new session to use it'), { status: 409 });
    }
    store.state.savedApps ??= {};
    store.state.savedApps[repo] = { app: checked };
    store.save();
    console.log('savedApps: app saved', { sessionId: session.id, repo });
    return read(session);
  }
  return { read, save };
}
