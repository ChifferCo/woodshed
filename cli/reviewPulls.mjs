// `woodshed review pulls` and `woodshed review start`: the console's automated review (pullRequests.review.runner:
// woodshed) of your own open pull requests on a repo, by hand. `pulls` lists them, with whether the repo's review is on;
// `start` asks the console to review each now (POST /api/my/pulls/<number>/review, fleet.mjs reviewOnDemand), as a
// commit with the review's tag would. The review runs as the console's review session, on your own Claude token and
// Codex sign-in where the console has no team keys, and as you chose on My settings' Reviews card.
//
//   woodshed review pulls [--repo <owner/name>] [--dir <path>]
//   woodshed review start <pull request>... [--repo <owner/name>] [--dir <path>]
//
// The repo is --repo, else the GitHub origin of the checkout at --dir or here. Exit codes: 0 done, 2 waiting on a person
// (a sign-in), 3 refused (a pull request that is not yours or a draft, a repo you cannot start on, or one whose project
// file runs its review elsewhere), 1 anything else.

import path from 'node:path';

import { repoOf } from '../shared/repoOf.mjs';

const REPO_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/(?!\.{1,2}$)[\w.-]+$/i;
const PULL_RE = /^(?:#?([1-9][0-9]{0,8})|https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/([1-9][0-9]{0,8})\/?)$/;

// eslint-disable-next-line no-control-regex
const UNPRINTABLE_RE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
function printable(text, most = 400) {
  if (text === null || text === undefined) return null;
  return String(text).replace(UNPRINTABLE_RE, ' ').slice(0, most);
}

/**
 * The review the console runs on `repo`'s pull requests, as its readiness says (console/reviewReadiness.mjs): `review`,
 * the project file's or every repo's default where the file names none (`from`), and the default branch's runsOn. Off
 * only when the file chooses another runner, or its runsOn another console. A console from before the default sends no
 * `review`, and its default branch's file says it alone.
 * @returns {{on: boolean, from: string|null, rerun: string|null, known: boolean, why: string|null}}
 */
export function reviewOf(readiness, repo) {
  const remote = readiness?.defaultBranch ?? null;
  if (!remote || remote.error) return { on: false, from: null, rerun: null, known: false, why: null };
  const review = readiness.review !== undefined ? readiness.review : remote.review ? { ...remote.review, from: 'project file' } : null;
  const runner = printable(review?.runner, 20);
  let why = null;
  if (!review) why = `${repo}'s project file names no review, and this console runs no default one`;
  else if (runner !== 'woodshed') why = `${repo}'s project file runs its review in ${runner === 'actions' ? 'GitHub Actions' : runner}, not in this console`;
  else if (remote.runsHere === false) why = `${repo}'s pullRequests.runsOn names another console${remote.runsOn ? ` (${printable(remote.runsOn, 100)})` : ''}, which runs its reviews`;
  return { on: !why, from: printable(review?.from, 40), rerun: printable(review?.rerun, 100) ?? null, known: true, why };
}

/**
 * @param {{origin: string, sub: 'pulls'|'start', words: string[]}} args
 * @param {object} deps  from review.mjs: `call`, `token`, `say`, `emit`, `json`, `EXIT`, `fail`, `cwd`, `repoOf`
 * @returns {Promise<number>}  the exit code
 */
export async function reviewPullsCommand({ origin, sub, words }, deps) {
  const { call, token, say, emit, json, EXIT, fail } = deps;
  const opts = { pulls: [] };
  for (let i = 0; i < words.length; i++) {
    const [name, inline] = words[i].startsWith('--') ? words[i].split(/=(.*)/s) : [words[i], undefined];
    if (name === '--repo' || name === '--dir') {
      const value = inline ?? words[++i];
      if (!value || (inline === undefined && value.startsWith('-'))) throw fail(`${name} needs a value`);
      opts[name] = value;
    } else if (sub === 'start' && PULL_RE.test(name)) opts.pulls.push(name);
    else throw fail(`${name.startsWith('-') ? 'unknown option' : 'unexpected'} ${name} for review ${sub}: woodshed review --help`);
  }
  if (sub === 'start' && !opts.pulls.length) throw fail('review start needs a pull request: its number, #number or URL. woodshed review pulls lists yours.');
  if (opts['--repo'] && !REPO_RE.test(opts['--repo'])) throw fail('--repo needs a GitHub repo as owner/name');
  let repo = opts['--repo'] ?? null;
  if (!repo) {
    const dir = path.resolve(deps.cwd ?? process.cwd(), opts['--dir'] ?? '.');
    repo = (deps.repoOf ?? repoOf)(dir);
    if (!repo) throw fail(`${opts['--dir'] ?? 'this folder'} has no GitHub origin: give --repo owner/name`);
  }
  if (!token) throw fail(`Not signed in to ${origin}. Run: woodshed login --console ${origin}`, { code: EXIT.waiting, status: 'signed-out' });

  async function ask(pathname, { method = 'GET', body } = {}) {
    const out = await call(origin, pathname, { method, body, token });
    if (out.status === 401) throw fail(`The sign-in to ${origin} ended: ${printable(out.body?.error) ?? 'it was revoked, or it expired'}. Run: woodshed login --console ${origin}`, { code: EXIT.waiting, status: 'signed-out' });
    return out;
  }

  // The console's name for the repo: a project the person may start sessions on, which needs write access to it.
  const projects = await ask('/api/my/projects');
  if (projects.status !== 200 || !Array.isArray(projects.body?.projects)) throw fail(`${origin} answered ${projects.status} for your repos`);
  const project = projects.body.projects.find((p) => String(p?.repo ?? '').toLowerCase() === repo.toLowerCase());
  if (!project) {
    const yours = projects.body.projects.map((p) => printable(p?.repo, 100)).filter(Boolean).join(', ') || 'none';
    throw fail(`${repo} is not one of ${origin}'s repos you can start sessions on. Yours: ${yours}`, { code: EXIT.refused, status: 'refused' });
  }
  repo = project.repo;
  const pullUrl = (number) => `https://github.com/${repo}/pull/${number}`;

  if (sub === 'pulls') {
    const [pulls, readiness] = await Promise.all([ask('/api/my/pulls'), ask(`/api/review-readiness?repo=${encodeURIComponent(repo)}`)]);
    if (pulls.status !== 200 || !Array.isArray(pulls.body?.pulls)) throw fail(`${origin} answered ${pulls.status} for your pull requests${pulls.body?.error ? `: ${printable(pulls.body.error, 200)}` : ''}`);
    const mine = pulls.body.pulls
      .filter((p) => p?.why === 'yours' && Number.isSafeInteger(p.number) && String(p.repo ?? '').toLowerCase() === repo.toLowerCase())
      .map((p) => ({ number: p.number, title: printable(p.title, 200) ?? '', draft: p.draft === true, updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : null, url: pullUrl(p.number) }));
    const review = reviewOf(readiness.status === 200 ? readiness.body : null, repo);
    // The console keeps a repo's last list when GitHub did not answer, and says so: the list may be out of date.
    const stale = pulls.body.stale === true;
    if (json) emit({ event: 'pulls', repo, project: project.name, review, pulls: mine, ...(stale ? { stale } : {}) });
    const how = review.on ? `on${review.from === 'default' ? ' by default' : ''}${review.rerun ? `, on commits whose subject ends with ${review.rerun}` : ', on each commit'}` : `off: ${review.why}`;
    say(`Review on ${repo}: ${!review.known ? 'not known' : how}.`);
    if (stale) say('GitHub did not answer just now: this list may be out of date.');
    if (!mine.length) say(`You have no open pull requests on ${repo}.`);
    for (const p of mine) say(`  #${p.number}${p.draft ? ' (draft)' : ''}  ${p.title}  ${p.url}`);
    if (mine.some((p) => !p.draft) && review.on) say(`Review them now: woodshed review start ${mine.filter((p) => !p.draft).map((p) => p.number).join(' ')} --repo ${repo}`);
    return EXIT.done;
  }

  // start: each in turn, so one refused does not keep the others from starting.
  let code = EXIT.done;
  // Every URL's repo is checked before any review starts: a mistake in the list starts none of it.
  const numbers = opts.pulls.map((word) => {
    const m = PULL_RE.exec(word);
    if (m[2] && m[2].toLowerCase() !== repo.toLowerCase()) throw fail(`${word} is on ${m[2]}, not ${repo}: give --repo ${m[2]}`);
    return Number(m[1] ?? m[3]);
  });
  for (const number of numbers) {
    const out = await ask(`/api/my/pulls/${number}/review`, { method: 'POST', body: { project: project.name } });
    const id = /^[0-9a-f]{8}$/.test(out.body?.sessionId ?? '') ? out.body.sessionId : null;
    if ((out.status === 200 || out.status === 201) && id) {
      const outcome = ['started', 'running', 'reviewed'].includes(out.body.outcome) ? out.body.outcome : 'started';
      const url = `${origin}/s/${id}`;
      if (json) emit({ event: 'review', repo, number, outcome, pullUrl: pullUrl(number), session: { id, url } });
      const words = { started: 'review started', running: 'its head commit is being reviewed already', reviewed: 'its head commit was reviewed already' };
      say(`#${number}: ${words[outcome]}: ${url} (${pullUrl(number)})`);
      continue;
    }
    const error = printable(out.body?.error, 300) ?? `${origin} answered ${out.status}`;
    const refusal = out.status === 404 && !out.body?.error ? `${origin} answered 404: a console from before woodshed review start` : error;
    const failCode = out.status === 403 || out.status === 409 ? EXIT.refused : EXIT.failed;
    if (json) emit({ event: 'review', repo, number, outcome: 'refused', pullUrl: pullUrl(number), error: refusal });
    say(`#${number}: not started: ${refusal}`);
    if (code === EXIT.done) code = failCode;
  }
  return code;
}
