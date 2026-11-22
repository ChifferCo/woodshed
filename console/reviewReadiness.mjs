// Whether a repo's pull requests can be reviewed in a Woodshed session (pullRequests.review.runner: woodshed), as far
// as the console's side goes: the repo is one of its projects, the reviewer App is made, and it is installed on the
// repo (README.md, "The reviewer App"). What the project file the console reads for the repo says comes with it (its
// default branch's, or the installation's for a repo with none), what the console keeps for the repo (keptReview.mjs),
// and which of the two the review runs by. The GET is read-only: it changes nothing, and names each missing step with
// who takes it. `woodshed review enable`, `disable` and `status` ask it; the console's own page can too.
//
//   GET  /api/review-readiness?repo=<owner/name>
//     ->  {repo, project, consoleApp: {login, name}, reviewerApp: {made, login, installed, installUrl},
//          defaultBranch: {review, qa, runsOn, runsHere, from, error}, kept: {rerun, by, at, error}|null,
//          review: {runner, rerun, from}|null, missing: [{key, step, by}]}
//   POST /api/kept-review {repo, on: true|false, rerun?: string|null}
//     ->  the same, with `changed`: turns the repo's review on (or off) in the console's keeping, with no commit to the
//         repo. `rerun` is the tag a commit's message carries to be reviewed, null for every commit; left out, the tag
//         already kept, else [woodshed-review]. The project file's own pullRequests.review, when it names one, still
//         wins. Behind a hosting proxy, where nobody's GitHub write access is asked, only someone the host says may (its
//         reviewKeeping.mayChange, else an owner on its People list) changes it: anyone else is answered 403.
//
// `review.from` says what the review runs by: `default branch` or `installation` (the project file's), `console` (the
// kept one), or null with neither. `defaultBranch.from` says which file the console read: `default branch`,
// `installation` or `none`.
//
// Both answer about a repo the asker may start sessions on, and about no other: for any other repo they say only that
// the console does not have it for them, change nothing, and ask GitHub nothing more. The command line's token (wsc_,
// cliSignIn.mjs) may call them, as its person, through the one gate its routes share (cliSessions.mjs): a call that
// carries an Origin with that token is a page's, and is refused. Every call, a cookie's or a token's, is held to write
// access on the repo, asked of GitHub each time (a command asks once, never in a loop): a person who lost it reads or
// changes nothing more of the repo from that moment, though still on People and still holding a cookie auth.mjs has not
// rechecked yet.
//
// Ready means: the repo is the asker's to start on, the reviewer App is made and known to be installed on it, and the
// default branch's runsOn, when it names one, names this console as the fleet reads it (fleet.mjs, runsElsewhere).

import { KEPT_RERUN, validRerun } from './keptReview.mjs';
import { allProjects } from './projects.mjs';

export const REVIEW_READINESS_PATH = '/api/review-readiness';
export const KEPT_REVIEW_PATH = '/api/kept-review';
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
 *          sourceOf?: (projectName: string) => Promise<string|null>,
 *          keptReviews?: ReturnType<typeof import('./keptReview.mjs').createKeptReviews>|null,
 *          mayChange?: ((login: string|null, project: object) => Promise<boolean>)|null,
 *          canWrite?: ((login: string|null, project: object) => Promise<boolean>)|null}} deps
 *   `reviewer` is the console's reviewer App, its own or a host's, null where it can have none; `ownReviewer` says
 *   whether it is the console's own, which an admin makes on /setup/github; `pullRequestsOf` the project file's gates on
 *   the project file the console reads, without the kept review, with the Apps' logins filled in (reviewLogins.mjs);
 *   `sourceOf` which file that is (projectFile.mjs, source); `keptReviews` the review the console keeps; `mayChange`
 *   who may change it beyond write access, for a console behind a hosting proxy, where GitHub is not asked; `runsOnName` this console's name among its
 *   App's (config.runsOnName); `canWrite` asks GitHub whether a person may write to a project's repo, null where
 *   sign-in asks nothing (no sign-in, or a hosting proxy that says who is in)
 */
export function createReviewReadiness({ publicUrl, reviewer, ownReviewer, appLogin, pullRequestsOf, sourceOf = async () => null, keptReviews = null, mayChange = null, runsOnName = null, canWrite = null }) {
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
  // The asker's project for the repo, null for one they may not start on, or no longer write to.
  async function projectFor(repo, { projects, login }) {
    const project = projects.find((p) => String(p.repo).toLowerCase() === repo.toLowerCase()) ?? null;
    return project && (await stillWrites(login, project)) ? project : null;
  }

  async function check(repo, { projects, login = null }) {
    return answerFor(repo, await projectFor(repo, { projects, login }));
  }

  /**
   * Turns the repo's review on or off in the console's keeping, then answers as check does.
   * @param {{projects: object[], login?: string|null, on: boolean, rerun?: string|null}} what
   * @returns {Promise<object>}  check's answer, with `changed`
   */
  async function keep(repo, { projects, login = null, on, rerun }) {
    const project = await projectFor(repo, { projects, login });
    let changed = false;
    if (project) {
      // Behind a hosting proxy nobody's GitHub write access is asked (canWrite is null there): the host says who may.
      if (mayChange && !(await mayChange(login, project))) {
        console.log('reviewReadiness: kept review refused, not someone who may change it', { login, repo: project.repo });
        throw Object.assign(new Error(`only an owner of this console may turn ${project.repo}'s review on or off here`), { refused: true });
      }
      const before = await keptReviews.of(project.repo).catch(() => undefined);
      // No tag asked for keeps the one already kept, so enabling again never undoes a team's choice.
      const tag = rerun !== undefined ? rerun : before ? before.review.rerun : KEPT_RERUN;
      const same = on ? before?.review.rerun === tag : before === null;
      if (!same) {
        await keptReviews.set(project.repo, { on, rerun: tag, by: login });
        changed = true;
      }
      console.log('reviewReadiness: kept review set', { login, repo: project.repo, on, ...(on ? { rerun: tag } : {}), changed });
    }
    return { ...(await answerFor(repo, project)), changed };
  }

  async function answerFor(repo, project) {
    const missing = [];
    if (!project) {
      missing.push({ key: 'repo', by: 'admin', step: `An admin of the console adds ${repo} on Console settings, Repos (${publicUrl}/settings), and you need write access to it.` });
      return { repo, project: null, consoleApp: null, reviewerApp: null, defaultBranch: null, kept: null, review: null, missing };
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
      const [gates, from] = await Promise.all([pullRequestsOf(project.name), sourceOf(project.name)]);
      const review = gates?.review ?? null;
      const qa = gates?.qa ?? null;
      defaultBranch = {
        review: review ? { runner: review.runner, rerun: review.rerun ?? null, heading: review.heading, author: review.author ?? null, commentAuthor: review.commentAuthor ?? null } : null,
        qa: qa ? { runner: qa.runner, label: qa.label, check: qa.check, autoLabel: Boolean(qa.autoLabel) } : null,
        runsOn: gates?.runsOn ?? null,
        runsHere: runsOnHere(gates?.runsOn ?? null, { login: consoleLogin, name: runsOnName }),
        from: from ?? null,
        error: null,
      };
      if (!defaultBranch.runsHere) {
        missing.push({
          key: 'runs-on', by: 'repo',
          step: `The default branch's pullRequests.runsOn names ${gates.runsOn}, so this console (${consoleLogin ?? 'its App'}${runsOnName ? `/${runsOnName}` : ''}) runs none of its reviews: change runsOn, or leave it out, in a pull request.`,
        });
      }
    } catch (err) {
      defaultBranch = { review: null, qa: null, runsOn: null, runsHere: null, from: null, error: firstLine(err) };
    }
    let kept = null;
    if (keptReviews) {
      try {
        const held = await keptReviews.of(project.repo);
        kept = held && { rerun: held.review.rerun, by: held.by, at: held.at, error: null };
      } catch (err) {
        kept = { rerun: null, by: null, at: null, error: firstLine(err) };
      }
    }
    // What the fleet runs the review by: the file's when it names one (withKeptReview), else the kept one. Unknown while
    // the file could not be read.
    const fileReview = defaultBranch.review;
    const review = defaultBranch.error ? null
      : fileReview ? { runner: fileReview.runner, rerun: fileReview.rerun, from: defaultBranch.from ?? 'default branch' }
        : kept && !kept.error ? { runner: 'woodshed', rerun: kept.rerun, from: 'console' } : null;
    return {
      repo: project.repo, project: project.name,
      consoleApp: { login: consoleLogin, name: runsOnName },
      reviewerApp: { made, login: made ? reviewer.login() : null, installed, installUrl },
      defaultBranch, kept, review, missing,
    };
  }

  return { check, keep: keptReviews ? keep : null };
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

/**
 * POST /api/kept-review {repo, on, rerun?}, for someone signed in, by a cookie (with the page's write checks) or the
 * command line's token.
 * @param {{req, res, login: string|null, readiness: ReturnType<typeof createReviewReadiness>|null, config: object,
 *          readJson: (req) => Promise<object>, reply: (res, status: number, body: object) => void}} args
 */
export async function keptReviewReply({ req, res, login, readiness, config, readJson, reply }) {
  if (req.method !== 'POST') return reply(res, 405, { error: 'method not allowed' });
  if (!readiness) return reply(res, 404, { error: 'this console cannot review pull requests in a session: it has no GitHub App' });
  if (!readiness.keep) return reply(res, 404, { error: 'this console keeps no review of its own' });
  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return reply(res, 400, { error: err.message });
  }
  const repo = String(body?.repo ?? '').trim();
  if (!REPO_RE.test(repo)) return reply(res, 400, { error: 'repo must be owner/name' });
  if (typeof body.on !== 'boolean') return reply(res, 400, { error: 'on must be true or false' });
  const rerun = body.rerun === undefined ? undefined : body.rerun;
  if (rerun !== undefined && !validRerun(rerun)) return reply(res, 400, { error: 'rerun must be one line of text, at most 100 characters, or null for every commit' });
  try {
    return reply(res, 200, await readiness.keep(repo, { projects: allProjects(config), login, on: body.on, ...(rerun !== undefined ? { rerun } : {}) }));
  } catch (err) {
    if (err.refused) return reply(res, 403, { error: err.message });
    console.error('reviewReadiness: kept review not set', { repo, login, on: body.on, message: firstLine(err) });
    return reply(res, 502, { error: `the console could not keep it: ${firstLine(err)}` });
  }
}
