// A person's open pull requests on every repo they may start sessions on, for the rail's Pull requests group: theirs,
// then those waiting on their review, newest first in each. Each repo is asked on its own project's token, since an
// added repo may be on another installation of the App, and a repo that does not answer keeps the rows it had.

const firstLine = (err) => String(err?.message ?? err).split('\n')[0];
const updated = (p) => Date.parse(p.updatedAt ?? '') || 0;

/**
 * @param {{login: string, projects: {name: string, repo: string, default?: boolean}[],
 *          githubFor: (project: object) => ({openPullsFor: (login: string) => Promise<object[]>}|null),
 *          kept?: object[]}} args
 *   `kept` is the last list read for this person, whose rows stand in for a repo that fails this time
 * @returns {Promise<{pulls: object[], stale: boolean}>}  each row with its `project` and `repo`; `stale` when a repo
 *   failed
 */
export async function readMyPulls({ login, projects, githubFor, kept = [] }) {
  let stale = false;
  const perProject = await Promise.all(projects.map(async (project) => {
    const github = githubFor(project);
    if (!github?.openPullsFor) return [];
    try {
      const rows = await github.openPullsFor(login);
      return rows.map((row) => ({ ...row, project: project.name, repo: project.repo }));
    } catch (err) {
      stale = true;
      console.warn('console: pull requests not readable', { login, project: project.name, message: firstLine(err) });
      return kept.filter((row) => row.project === project.name);
    }
  }));
  const all = perProject.flat();
  const order = (why) => all.filter((p) => p.why === why).sort((a, b) => updated(b) - updated(a));
  return { pulls: [...order('yours'), ...order('review')], stale };
}
