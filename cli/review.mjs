// `woodshed review`: Woodshed's review of a repo's pull requests, in a Woodshed session (pullRequests.review.runner:
// woodshed): the console starts a review session on a pull request and posts the verdict as its reviewer App. Every repo
// is reviewed by default, on a commit whose message has [woodshed-review] (console/defaultReview.mjs), with nothing to
// turn on: `status` says whether it is on and what is missing. `enable` writes it into the repo's project file instead,
// for QA too, every commit, or another tag. It edits the checkout's .woodshed/project.yaml (projectReview.mjs), checks it as `project.mjs
// check` does, and asks the console what is still missing on its side (console/reviewReadiness.mjs). It never writes a
// GitHub workflow, sets an Actions secret or handles an Anthropic key: a repo with no Woodshed console uses
// scripts/enable-review.sh instead.
//
//   woodshed review enable [--qa] [--rerun <tag>|--every-commit] [--dry-run] [--dir <path>]
//   woodshed review status [--repo <owner/name>] [--dir <path>]
//
//   woodshed review pulls|start ...             your own open pull requests, reviewed by the console now (reviewPulls.mjs)
//
// Exit codes, as every command's: 0 done (enable: the file says it and the console is ready, so commit it; status: on),
// 2 waiting on a person (something only an admin can do, a sign-in, or the change not yet on the default branch),
// 3 refused, 1 anything else (a project file that does not read, or a check that fails).

import { runGit } from '../shared/git.mjs';
import fs from 'node:fs';
import path from 'node:path';

import { PROJECT_FILE, parseProject, readRepoFile, repoOf } from '../shared/project.mjs';
import { checkSummary, checkoutEntry } from '../shared/projectCheck.mjs';
import { parseYaml } from '../shared/yamlLite.mjs';
import { enableReview } from './projectReview.mjs';
import { reviewOpenCommand } from './reviewOpen.mjs';
import { reviewPullsCommand } from './reviewPulls.mjs';

export const REVIEW_USAGE = `Usage: woodshed review <session id | pull request> [--console <url>] [--json]
       woodshed review <command> [--console <url>] [--json]

  <session id>           review one of your My Woodshed sessions' change on this terminal, as the console's Review tab
  <pull request>         shows it: the analysis, the Q&A, the conversation with the session's agent, the diff file by
                         file with its comments, Re-review, and comment, verdict, rename and merge. A pull request (123,
                         #123 or its URL) opens the session of yours that opened it; a paused one is resumed first.
                         With --json, or with no terminal, it prints the analysis and the diff's summary instead.

Every repo the console has is reviewed by default: put [woodshed-review] in a commit's message, and the console reviews
the pull request at that commit, with nothing to turn on or commit.

Commands:
  status [--repo <owner/name>] [--dir <path>]
                         whether review is on and what it runs by (the repo's project file, or the default), and what
                         the console still needs, such as its reviewer App. --repo needs no checkout
  enable [options]       in a checkout: write pullRequests.review with runner: woodshed into .woodshed/project.yaml, for
                         QA too, every commit or another tag, check it, and ask the console what is missing
      --qa               QA too, in a Woodshed session, when the woodshed-qa label goes on a pull request
      --rerun <tag>      review a commit whose message has this tag (default: the file's own, else [woodshed-review])
      --every-commit     review each new commit, with no tag
      --dry-run          say what would change, and write nothing
      --dir <path>       the checkout (default: the one this is run in)

Commands on your own open pull requests, for the repo given by --repo owner/name, else this checkout's origin:
  pulls                  list them, and how the repo is reviewed: on by default, with the tag that starts a review
  start <pull request>...
                         review each now (its number, #number or URL): the console starts the same review session a
                         tagged commit would, on your own Claude token and Codex sign-in where it has no team keys, and
                         prints its link. A head commit reviewed already answers with that review

Nothing here writes a GitHub workflow or an Actions secret: the review runs in the console's sessions, which need neither.

Exit codes: 0 done (or quit), 2 waiting on a person (an admin's step, a sign-in, or the change to merge), 3 refused (a
session or pull request that is not your own, a repo whose project file runs its review elsewhere, or a session that
has seen production data), 1 anything else.`;

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
// eslint-disable-next-line no-control-regex
const UNPRINTABLE_RE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
function printable(text, most = 400) {
  if (text === null || text === undefined) return null;
  return String(text).replace(UNPRINTABLE_RE, ' ').slice(0, most);
}

/** @returns {string|null}  the top of the git checkout `dir` is in */
function checkoutOf(dir) {
  try {
    return runGit(dir, ['rev-parse', '--show-toplevel']).trim() || null;
  } catch {
    return null;
  }
}

// The checkout's project file, else its default branch's when git can tell which that is, else none.
function projectFileOf(dir) {
  if (fs.existsSync(path.join(dir, PROJECT_FILE))) return { text: fs.readFileSync(path.join(dir, PROJECT_FILE), 'utf8'), from: 'checkout' };
  try {
    return readRepoFile(dir, PROJECT_FILE);
  } catch {
    return null;
  }
}

// Whether a `runsOn` names the console the readiness came from, as its fleet reads it: its App's login, and after a
// slash its name among that App's consoles (console/reviewReadiness.mjs, runsOnHere).
function runsOnHere(runsOn, consoleApp) {
  if (!runsOn) return true;
  const [app, name = null] = String(runsOn).split('/');
  return app === consoleApp?.login && (name === null || name === (consoleApp?.name ?? null));
}

/**
 * What the console said, made printable, with the warnings the checkout's file gives against it.
 * @returns {{missing: {key: string, step: string, by: string}[], warnings: string[], readiness: object}}
 */
export function readinessFindings(readiness, gates) {
  const missing = (Array.isArray(readiness?.missing) ? readiness.missing : []).map((m) => ({ key: printable(m?.key, 40), step: printable(m?.step), by: printable(m?.by, 20) }));
  const warnings = [];
  const consoleLogin = printable(readiness?.consoleApp?.login, 100);
  const reviewerLogin = printable(readiness?.reviewerApp?.login, 100);
  const runsOn = gates?.runsOn ?? null;
  if (runsOn && consoleLogin && !runsOnHere(runsOn, readiness.consoleApp)) {
    const here = `${consoleLogin}${readiness.consoleApp?.name ? `/${readiness.consoleApp.name}` : ''}`;
    warnings.push(`pullRequests.runsOn names ${runsOn}, and this console is ${here}: the console runsOn names reviews, not this one.`);
  }
  const review = gates?.review;
  if (review?.author && reviewerLogin && review.author !== reviewerLogin) {
    warnings.push(`pullRequests.review.author is ${review.author}, and the console's reviewer App is ${reviewerLogin}: its verdicts would not count. Take the line out, and the console fills in its own.`);
  }
  if (review?.commentAuthor && consoleLogin && review.commentAuthor !== consoleLogin) {
    warnings.push(`pullRequests.review.commentAuthor is ${review.commentAuthor}, and the console's App is ${consoleLogin}: take the line out, and the console fills in its own.`);
  }
  return { missing, warnings };
}

/**
 * @param {{origin: string, rest: string[]}} args  `rest`: what follows `review` on the command line
 * @param {object} deps  from woodshed.mjs: `call`, `token`, `say`, `emit`, `json`, `EXIT`, `fail`, `stdout`, `cwd`
 * @returns {Promise<number>}  the exit code
 */
export async function reviewCommand({ origin, rest }, deps) {
  const { EXIT, stdout } = deps;
  const [sub, ...words] = rest;
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    stdout.write(`${REVIEW_USAGE}\n`);
    return sub ? EXIT.done : EXIT.failed;
  }
  const { call, token, say, emit, json, fail } = deps;
  if (sub === 'pulls' || sub === 'start') return reviewPullsCommand({ origin, sub, words }, deps);
  if (sub !== 'enable' && sub !== 'status') return reviewOpenCommand({ origin, words: rest }, deps);

  function options(allowed) {
    const out = {};
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const eq = word.startsWith('--') ? word.indexOf('=') : -1;
      const [name, inline] = eq > 0 ? [word.slice(0, eq), word.slice(eq + 1)] : [word, null];
      if (!allowed[name]) throw fail(`${word.startsWith('-') ? 'unknown option' : 'unexpected'} ${word} for review ${sub}\n\n${REVIEW_USAGE}`);
      if (allowed[name] === 'flag') out[name] = true;
      else {
        const value = inline ?? words[++i];
        if (!value || (inline === null && value.startsWith('-'))) {
          throw fail(`${name} needs a value. For a value that starts with a dash, use ${name}=VALUE.`);
        }
        out[name] = value;
      }
    }
    return out;
  }

  function checkout(dirOption) {
    const dir = checkoutOf(path.resolve(deps.cwd ?? process.cwd(), dirOption ?? '.'));
    if (!dir) throw fail(`${dirOption ?? 'this folder'} is not in a git checkout: run woodshed review in a checkout of the repo, or give --dir`);
    if (checkoutEntry(dir, PROJECT_FILE) === 'symlink') throw fail(`Review needs a regular ${PROJECT_FILE} in the checkout. Its path contains a symlink.`);
    return { dir, repo: repoOf(dir) };
  }

  // The console's side, or why it was not asked: null readiness then, with `unasked` saying why.
  async function askConsole(repo) {
    if (!repo) return { readiness: null, unasked: 'this checkout\'s origin is not on GitHub, so the console was not asked about it' };
    if (!token) return { readiness: null, unasked: `not signed in to ${origin}: run woodshed login${origin ? ` --console ${origin}` : ''}, then woodshed review status`, signIn: true };
    let got;
    try {
      got = await call(origin, `/api/review-readiness?repo=${encodeURIComponent(repo)}`, { token });
    } catch (err) {
      return { readiness: null, unasked: printable(err.message, 300), unreachable: true };
    }
    if (got.status === 200 && got.body && typeof got.body === 'object') return { readiness: got.body, unasked: null };
    if (got.status === 401) {
      const me = await call(origin, '/api/cli/me', { token }).catch(() => null);
      if (me?.status === 200) return { readiness: null, unasked: `${origin} is from before woodshed review, so it was not asked what is missing` };
      return { readiness: null, unasked: `the sign-in to ${origin} ended: run woodshed login --console ${origin}`, signIn: true };
    }
    const said = printable(got.body?.error, 200);
    return { readiness: null, unasked: `${origin} answered ${got.status}${said ? `: ${said}` : ''}`, failed: true };
  }

  function sayConsole(readiness, unasked, { missing, warnings }) {
    if (unasked) {
      say(`Console: not asked: ${unasked}.`);
      return;
    }
    const reviewer = readiness.reviewerApp;
    if (readiness.project) {
      say(`Console: ${origin} has ${printable(readiness.repo, 140)} as project ${printable(readiness.project, 60)}.`);
      if (reviewer?.made) say(`  Reviewer App: ${printable(reviewer.login, 100) ?? 'made'}, ${reviewer.installed === true ? 'installed on the repo' : reviewer.installed === false ? 'not installed on the repo' : 'whether it is installed on the repo was not read'}.`);
    }
    if (missing.length) {
      say('Still to do:');
      for (const m of missing) say(`  - ${m.step}${m.by === 'admin' ? ' (an admin)' : ''}`);
    }
    for (const w of warnings) say(`Warning: ${w}`);
  }

  if (sub === 'enable') {
    const opts = options({ '--qa': 'flag', '--rerun': 'value', '--every-commit': 'flag', '--dry-run': 'flag', '--dir': 'value' });
    if (opts['--rerun'] && opts['--every-commit']) throw fail('--rerun and --every-commit are each other\'s opposite: give one');
    const { dir, repo } = checkout(opts['--dir']);
    const file = path.join(dir, PROJECT_FILE);
    const found = projectFileOf(dir);
    if (found?.from === 'default branch') {
      throw fail(`this checkout has no ${PROJECT_FILE}, but its default branch does: check out a branch from the default branch first, so the change is to that file`);
    }
    let edit;
    try {
      edit = enableReview(found?.text ?? null, { qa: Boolean(opts['--qa']), rerun: opts['--rerun'] ?? null, everyCommit: Boolean(opts['--every-commit']) });
    } catch (err) {
      throw fail(err.message);
    }
    const project = { ...parseProject(parseYaml(edit.text)), from: 'checkout' };
    // As `node shared/project.mjs check` reads it, against this checkout, before anything is written.
    let problems = null;
    try {
      checkSummary(project, dir);
    } catch (err) {
      problems = String(err.message).split('\n').map((l) => printable(l));
    }
    const dryRun = Boolean(opts['--dry-run']);
    const written = !dryRun && edit.changes.length > 0 && !problems;
    if (written) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, edit.text);
    }
    const gates = project.pullRequests;
    const { readiness, unasked, signIn } = problems ? { readiness: null, unasked: 'the project file has problems to fix first' } : await askConsole(repo);
    const findings = readiness ? readinessFindings(readiness, gates) : { missing: [], warnings: [] };
    const qaWithoutApp = Boolean(opts['--qa']) && !project.app && !(project.apps?.length);
    if (qaWithoutApp) findings.warnings.push('QA in a session starts the app the project file names, and this one names none: add `app` (the write-project-file skill, or project.reference.yaml).');
    const defaultOn = readiness?.defaultBranch?.review?.runner === 'woodshed';
    const result = {
      event: 'enable', repo, file: PROJECT_FILE, changes: edit.changes, written, dryRun, problems,
      review: { runner: gates.review.runner, rerun: gates.review.rerun ?? null, heading: gates.review.heading },
      qa: gates.qa ? { runner: gates.qa.runner, label: gates.qa.label } : null,
      console: readiness ? { project: readiness.project ?? null, reviewerApp: readiness.reviewerApp ?? null, defaultBranch: readiness.defaultBranch ?? null } : null,
      unasked, missing: findings.missing, warnings: findings.warnings,
    };
    if (json) emit(result);
    if (edit.changes.length) {
      say(`${dryRun ? 'Would change' : problems ? 'Not written' : 'Changed'} ${PROJECT_FILE}:`);
      for (const c of edit.changes) say(`  - ${printable(c)}`);
    } else say(`${PROJECT_FILE} already has the review in a Woodshed session${opts['--qa'] ? ', and QA' : ''}.`);
    if (problems) {
      say(`project check found problems${edit.changes.length ? ', so nothing was written' : ''}:`);
      for (const p of problems) say(`  ${p}`);
      return EXIT.failed;
    }
    sayConsole(readiness, unasked, findings);
    if (signIn || findings.missing.length) return EXIT.waiting;
    // The file is written, but the console could not say it can run the review (nor read the default branch's file,
    // whose runsOn decides which console does): not done.
    const unread = readiness?.defaultBranch?.error ? printable(readiness.defaultBranch.error, 300) : null;
    if (!readiness || unread) {
      if (unread) say(`Console: the default branch's ${PROJECT_FILE} was not read: ${unread}.`);
      say(`${PROJECT_FILE} is ${dryRun ? 'unchanged' : 'written'}, but the console did not say it can run the review: fix that, then woodshed review status.`);
      return EXIT.failed;
    }
    const tag = gates.review.rerun;
    if (dryRun) {
      say('Nothing written (--dry-run).');
    } else if (edit.changes.length || !defaultOn) {
      say(`Next: commit ${PROJECT_FILE} and open a pull request. Once it is merged, the console reviews each pull request ${tag ? `whose head commit's message has ${tag}` : 'on each new commit'}${gates.qa?.runner === 'woodshed' ? `, and QA runs when a pull request gets the ${gates.qa.label} label` : ''}.`);
    } else {
      say(`Review is on: the default branch says so too. The console reviews each pull request ${tag ? `whose head commit's message has ${tag}` : 'on each new commit'}.`);
    }
    return EXIT.done;
  }

  if (sub === 'status') {
    const opts = options({ '--dir': 'value', '--repo': 'value' });
    let repo;
    let dir = null;
    if (opts['--repo']) {
      repo = String(opts['--repo']).trim();
      if (!REPO_RE.test(repo)) throw fail('--repo must be a GitHub repo as owner/name');
    } else ({ dir, repo } = checkout(opts['--dir']));
    // The checkout's file, when there is one: what a pull request would change.
    const found = dir ? projectFileOf(dir) : null;
    let gates = null;
    let fileError = null;
    try {
      gates = found ? parseProject(parseYaml(found.text)).pullRequests : null;
    } catch (err) {
      fileError = printable(err.message);
    }
    const local = gates?.review ?? null;
    const { readiness, unasked, signIn, unreachable, failed } = await askConsole(repo);
    const findings = readiness ? readinessFindings(readiness, readiness.defaultBranch ?? gates) : { missing: [], warnings: [] };
    const remote = readiness?.defaultBranch ?? null;
    // What the console runs the review by: the file's, else the default. A console from before the default says only the file's.
    const review = readiness ? (readiness.review !== undefined ? readiness.review
      : remote?.review ? { runner: remote.review.runner, rerun: remote.review.rerun ?? null, from: 'default branch' } : null) : null;
    // On: it runs in a session, the console runs its reviews (runsOn), and its reviewer App is known installed.
    const on = review?.runner === 'woodshed' && !findings.missing.length && readiness?.reviewerApp?.installed === true
      && runsOnHere(remote?.runsOn ?? null, readiness.consoleApp);
    if (json) {
      emit({
        repo, on, review,
        checkout: dir ? { from: found?.from ?? null, error: fileError, review: local ? { runner: local.runner, rerun: local.rerun ?? null } : null, qa: gates?.qa ? { runner: gates.qa.runner, label: gates.qa.label } : null } : null,
        console: readiness ? { project: readiness.project ?? null, reviewerApp: readiness.reviewerApp ?? null, defaultBranch: remote } : null,
        unasked, missing: findings.missing, warnings: findings.warnings,
      });
    }
    const words = (r) => (!r ? 'off' : r.runner === 'woodshed' ? `in a Woodshed session${r.rerun ? `, on commits tagged ${printable(r.rerun, 100)}` : ', on each commit'}` : `in ${r.runner === 'actions' ? 'GitHub Actions' : printable(r.runner, 20)}`);
    const fromWords = (from) => (from === 'default' ? 'default, for every repo' : 'the repo\'s project file');
    say(`Repo:            ${repo ? printable(repo, 140) : 'not on GitHub'}`);
    if (dir) say(`This checkout:   ${fileError ? `${PROJECT_FILE} does not read: ${fileError}` : `review ${words(local)}${gates?.qa ? `; QA ${gates.qa.runner === 'woodshed' ? 'in a Woodshed session' : 'in GitHub Actions'}` : ''}`}`);
    if (remote) say(`Project file:    ${remote.error ? `not read: ${printable(remote.error, 200)}` : remote.review ? `review ${words(remote.review)}` : 'names no review'}`);
    if (review) say(`Runs:            review ${words(review)}, ${fromWords(review.from)}`);
    sayConsole(readiness, unasked, findings);
    if (fileError || unreachable || failed || remote?.error) return EXIT.failed;
    if (on) {
      say(review.rerun
        ? `Review is on: put ${printable(review.rerun, 100)} in a commit's message, and the console reviews the pull request at that commit.`
        : 'Review is on: the console reviews each new commit of a pull request.');
      return EXIT.done;
    }
    if (!signIn && readiness && !findings.missing.length) {
      say(review && review.runner !== 'woodshed'
        ? `Review runs ${words(review)}, by the repo's project file: woodshed review enable, in a pull request, moves it to a Woodshed session.`
        : local?.runner === 'woodshed' ? 'Next: merge the change to the project file.' : 'Next: woodshed review enable, then commit it and open a pull request.');
    }
    return EXIT.waiting;
  }

  throw fail(`unknown command review ${sub}\n\n${REVIEW_USAGE}`);
}
