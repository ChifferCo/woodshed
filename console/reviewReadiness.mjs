// Whether a repo's pull requests can be reviewed in a Woodshed session (pullRequests.review.runner: woodshed), as far
// as the console's side goes: the repo is one of its projects, the reviewer App is made, and it is installed on the
// repo (README.md, "The reviewer App"). What the project file says on the default branch comes with it. Read-only: it
// changes nothing, and names each missing step with who takes it. `woodshed review enable` and `status` ask it, after
// writing the review into the checkout's project file; the console's own page can too.
//
//   GET /api/review-readiness?repo=<owner/name>
//     ->  {repo, project, consoleApp: {login}, reviewerApp: {made, login, installed, installUrl},
//          defaultBranch: {review, qa, runsOn, error}, missing: [{key, step, by}]}
//
// It answers about a repo the asker may start sessions on, and about no other: for any other repo it says only that
// the console does not have it for them, and asks GitHub nothing more. The command line's token (wsc_, cliSignIn.mjs)
// may call it, as its person, through the one gate its routes share (cliSessions.mjs): a call that carries an Origin
// with that token is a page's, and is refused. Every call, a cookie's or a token's, is held to write access on the
// repo, asked of GitHub each time (a command asks once, never in a loop): a person who lost it reads nothing more of
// the repo from that moment, though still on People and still holding a cookie auth.mjs has not rechecked yet.
//
// Ready means: the repo is the asker's to start on, the reviewer App is made and known to be installed on it, and the
// default branch's runsOn, when it names one, names this console as the fleet reads it (fleet.mjs, runsElsewhere).

import { allProjects } from './projects.mjs';

export const REVIEW_READINESS_PATH = '/api/review-readiness';
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const firstLine = (err) => String(err?.message ?? err).split('\n')[0].slice(0, 300);

/** @returns {boolean}  whether a `runsOn` names this console: its App's login, and after a slash its name, if any */
export function runsOnHere(runsOn, { login, name = null }) {
  if (!runsOn) return true;
  const [app, wanted = null] = String(runsOn).split('/');
  return app === login && (wanted === null || wanted === name);
}

/**
 * @param {{publicUrl: string, reviewer: {configured: () => boolean, login: () => string|null,
 *            installedOn?: (repo: string) => Promise<boolean>, view?: () => Promise<{installUrl: string|null}>}|null,
 *          ownReviewer: boolean, appLogin: () => Promise<string|null>, runsOnName?: string|null,
 *          pullRequestsOf: (projectName: string) => Promise<object|null>,
 *          canWrite?: ((login: string|null, project: object) => Promise<boolean>)|null}} deps
 *   `reviewer` is the console's reviewer App, its own or a host's, null where it can have none; `ownReviewer` says
 *   whether it is the console's own, which an admin makes on /setup/github; `pullRequestsOf` the project file's gates on
 *   the default branch, with the Apps' logins filled in (reviewLogins.mjs); `runsOnName` this console's name among its
 *   App's (config.runsOnName); `canWrite` asks GitHub whether a person may write to a project's repo, null where
 *   sign-in asks nothing (no sign-in, or a hosting proxy that says who is in)
 */
export function createReviewReadiness({ publicUrl, reviewer, ownReviewer, appLogin, pullRequestsOf, runsOnName = null, canWrite = null }) {
  // Check the matched repo directly. The session picker's cached access list can lag behind a grant or revocation.
  async function stillWrites(login, project) {
    if (!canWrite) return true;
    const ok = Boolean(await canWrite(login, project));
    if (!ok) console.log('reviewReadiness: refused, no write access to the repo', { login, repo: project.repo });
    return ok;
  }

  /**
   * @param {string} repo  owner/name
   * @param {{projects: {name: string, repo: string}[], login?: string|null}} who  the console's projects and who asks:
   *   GitHub is asked whether the person writes to the matched repo
   */
  async function check(repo, { projects, login = null }) {
    let project = projects.find((p) => String(p.repo).toLowerCase() === repo.toLowerCase()) ?? null;
    if (project && !(await stillWrites(login, project))) project = null;
    const missing = [];
    if (!project) {
      missing.push({ key: 'repo', by: 'admin', step: `An admin of the console adds ${repo} on Console settings, Repos (${publicUrl}/settings), and you need write access to it.` });
      return { repo, project: null, consoleApp: null, reviewerApp: null, defaultBranch: null, missing };
    }
    const consoleLogin = await appLogin().catch(() => null);
    const made = Boolean(reviewer?.configured());
    let installed = null;
    let installUrl = null;
    if (made) {
      try {
        installed = typeof reviewer.installedOn === 'function' ? (await reviewer.installedOn(project.repo)) ?? null : null;
      } catch (err) {
        console.warn('reviewReadiness: reviewer App installation not read', { repo: project.repo, message: firstLine(err) });
      }
      installUrl = (await reviewer.view?.().catch(() => null))?.installUrl ?? null;
    }
    if (!reviewer) {
      missing.push({ key: 'reviewer-app', by: 'admin', step: 'This console has no reviewer App, and cannot make one: whoever runs it gives it one. Until then a review session\'s verdict does not count.' });
    } else if (!made) {
      missing.push({
        key: 'reviewer-app', by: 'admin',
        step: ownReviewer
          ? `An admin of the console makes the reviewer App: ${publicUrl}/setup/github, Create the reviewer App on GitHub.`
          : 'The console\'s host has not made its reviewer App yet: ask whoever runs it.',
      });
    } else if (installed === false) {
      missing.push({
        key: 'reviewer-installed', by: 'admin',
        step: `An owner of ${project.repo}'s account installs the reviewer App (${reviewer.login() ?? 'the reviewer App'}) on ${project.repo}${installUrl ? `: ${installUrl}` : ''}.`,
      });
    } else if (installed === null) {
      missing.push({
        key: 'reviewer-installed-unknown', by: 'admin',
        step: `The console could not tell whether its reviewer App (${reviewer.login() ?? 'the reviewer App'}) is installed on ${project.repo}: an admin checks it${installUrl ? ` at ${installUrl}` : ''}, and the console's log.`,
      });
    }
    let defaultBranch;
    try {
      const gates = await pullRequestsOf(project.name);
      const review = gates?.review ?? null;
      const qa = gates?.qa ?? null;
      defaultBranch = {
        review: review ? { runner: review.runner, rerun: review.rerun ?? null, heading: review.heading, author: review.author ?? null, commentAuthor: review.commentAuthor ?? null } : null,
        qa: qa ? { runner: qa.runner, label: qa.label, check: qa.check, autoLabel: Boolean(qa.autoLabel) } : null,
        runsOn: gates?.runsOn ?? null,
        runsHere: runsOnHere(gates?.runsOn ?? null, { login: consoleLogin, name: runsOnName }),
        error: null,
      };
      if (!defaultBranch.runsHere) {
        missing.push({
          key: 'runs-on', by: 'repo',
          step: `The default branch's pullRequests.runsOn names ${gates.runsOn}, so this console (${consoleLogin ?? 'its App'}${runsOnName ? `/${runsOnName}` : ''}) runs none of its reviews: change runsOn, or leave it out, in a pull request.`,
        });
      }
    } catch (err) {
      defaultBranch = { review: null, qa: null, runsOn: null, runsHere: null, error: firstLine(err) };
    }
    return {
      repo: project.repo, project: project.name,
      consoleApp: { login: consoleLogin, name: runsOnName },
      reviewerApp: { made, login: made ? reviewer.login() : null, installed, installUrl },
      defaultBranch, missing,
    };
  }

  return { check };
}

/**
 * GET /api/review-readiness?repo=<owner/name>, for someone signed in, by a cookie or the command line's token.
 * @param {{req, res, url: URL, login: string|null, readiness: ReturnType<typeof createReviewReadiness>|null,
 *          config: object,
 *          reply: (res, status: number, body: object) => void}} args
 */
export async function reviewReadinessReply({ req, res, url, login, readiness, config, reply }) {
  if (req.method !== 'GET') return reply(res, 405, { error: 'method not allowed' });
  if (!readiness) return reply(res, 404, { error: 'this console cannot review pull requests in a session: it has no GitHub App' });
  const repo = String(url.searchParams.get('repo') ?? '').trim();
  if (!REPO_RE.test(repo)) return reply(res, 400, { error: 'repo must be owner/name' });
  try {
    return reply(res, 200, await readiness.check(repo, { projects: allProjects(config), login }));
  } catch (err) {
    console.error('reviewReadiness: not read', { repo, login, message: firstLine(err) });
    return reply(res, 502, { error: `the console could not tell: ${firstLine(err)}` });
  }
}
