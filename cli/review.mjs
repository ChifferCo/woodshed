// `woodshed review`: turn on Woodshed's review for a repo, in a Woodshed session (pullRequests.review.runner: woodshed):
// the console starts a review session on each pull request and posts the verdict as its reviewer App.
//
// By default `enable` asks the console to keep it turned on for the repo (POST /api/kept-review,
// console/keptReview.mjs), with no commit and no checkout needed: reviews start from then on, with no pull request to
// merge. `disable` turns that off. A review the repo's own project file names still wins. `enable --commit` instead
// edits the checkout's .woodshed/project.yaml (projectReview.mjs), checks it as `project.mjs check` does, and leaves it
// to commit; the review then starts once that is merged. Each asks the console what is still missing on its side
// (console/reviewReadiness.mjs). It never writes a GitHub workflow, sets an Actions secret or handles an Anthropic key:
// a repo with no Woodshed console uses scripts/enable-review.sh instead.
//
//   woodshed review enable [--repo <owner/name>] [--rerun <tag>|--every-commit] [--dry-run] [--dir <path>]
//   woodshed review enable --commit [--qa] [--rerun <tag>|--every-commit] [--dry-run] [--dir <path>]
//   woodshed review disable [--repo <owner/name>] [--dir <path>]
//   woodshed review status [--repo <owner/name>] [--dir <path>]
//
// Exit codes, as every command's: 0 done (enable: on, or with --commit the file says it and the console is ready, so
// commit it; disable: the console keeps it off; status: on), 2 waiting on a person (something only an admin can do, a
// sign-in, or a change not yet on the default branch), 3 refused, 1 anything else (a project file that does not read, a
// check that fails, or a console that could not be asked).

import { runGit } from '../shared/git.mjs';
import fs from 'node:fs';
import path from 'node:path';

import { PROJECT_FILE, parseProject, readRepoFile, repoOf } from '../shared/project.mjs';
import { DEFAULT_RERUN } from './projectReview.mjs';
import { checkSummary, checkoutEntry } from '../shared/projectCheck.mjs';
import { parseYaml } from '../shared/yamlLite.mjs';
import { enableReview } from './projectReview.mjs';
import { reviewOpenCommand } from './reviewOpen.mjs';

export const REVIEW_USAGE = `Usage: woodshed review <session id | pull request> [--console <url>] [--json]
       woodshed review <command> [--console <url>] [--json]

  <session id>           review one of your My Woodshed sessions' change on this terminal, as the console's Review tab
  <pull request>         shows it: the analysis, the Q&A, the conversation with the session's agent, the diff file by
                         file with its comments, Re-review, and comment, verdict, rename and merge. A pull request (123,
                         #123 or its URL) opens the session of yours that opened it; a paused one is resumed first.
                         With --json, or with no terminal, it prints the analysis and the diff's summary instead.

Commands:
  enable [options]       review the repo's pull requests in Woodshed sessions from now on: the console keeps it on for
                         the repo, with no commit and no checkout, and says what is still missing on its side
      --repo <owner/name>  the repo (default: the origin of the checkout this is run in)
      --rerun <tag>      review a commit whose message has this tag (default: [woodshed-review])
      --every-commit     review each new commit, with no tag
      --dry-run          say what would change, and change nothing
      --commit           write pullRequests.review with runner: woodshed into the checkout's .woodshed/project.yaml
                         instead, and check it: the review starts once that is committed and merged
      --qa               with --commit: QA too, in a Woodshed session, when the woodshed-qa label goes on a pull request
      --dir <path>       the checkout (default: the one this is run in)
  disable [--repo <owner/name>] [--dir <path>]
                         turn off the review the console keeps for the repo. A review in its project file stays on
  status [--repo <owner/name>] [--dir <path>]
                         whether review is on and where from: the repo's project file or the console's keeping, and the
                         console's reviewer App

A review the repo's own project file names (pullRequests.review) wins over the one the console keeps. Nothing here
writes a GitHub workflow or an Actions secret: the review runs in the console's sessions, which need neither.

Exit codes: 0 done (or quit), 2 waiting on a person (an admin's step, a sign-in, or the change to merge), 3 refused (a
session that is not your own, or one that has seen production data), 1 anything else.`;

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
  if (!['enable', 'disable', 'status'].includes(sub)) return reviewOpenCommand({ origin, words: rest }, deps);

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

  // The console's side, or why it was not asked: null readiness then, with `unasked` saying why. With `keep`, the kept
  // review is set first (POST /api/kept-review), and the answer is the same readiness, with `changed`; `unsupported`
  // says the console is from before it.
  async function askConsole(repo, keep = null) {
    if (!repo) return { readiness: null, unasked: 'this checkout\'s origin is not on GitHub, so the console was not asked about it' };
    if (!token) return { readiness: null, unasked: `not signed in to ${origin}: run woodshed login${origin ? ` --console ${origin}` : ''}, then woodshed review ${sub}`, signIn: true };
    let got;
    try {
      got = keep
        ? await call(origin, '/api/kept-review', { method: 'POST', token, body: { repo, ...keep } })
        : await call(origin, `/api/review-readiness?repo=${encodeURIComponent(repo)}`, { token });
    } catch (err) {
      return { readiness: null, unasked: printable(err.message, 300), unreachable: true };
    }
    if (got.status === 200 && got.body && typeof got.body === 'object') return { readiness: got.body, unasked: null };
    // A console from before the kept review: its CLI gate refuses the route (403), or its page answers 404.
    if (keep && (got.status === 404 || (got.status === 403 && /does not reach this/.test(String(got.body?.error ?? ''))))) {
      return { readiness: null, unasked: `${origin} is from before the console could keep a repo's review on: run woodshed review enable --commit in a checkout instead`, failed: true, unsupported: true };
    }
    if (got.status === 401) {
      const me = await call(origin, '/api/cli/me', { token }).catch(() => null);
      if (me?.status === 200) return { readiness: null, unasked: `${origin} is from before woodshed review, so it was not asked what is missing`, failed: true, unsupported: Boolean(keep) };
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

  // The repo a command is about: --repo, else the checkout's origin. No checkout is needed with --repo.
  function repoFrom(opts) {
    if (opts['--repo']) {
      const named = String(opts['--repo']).trim();
      if (!REPO_RE.test(named)) throw fail('--repo must be a GitHub repo as owner/name');
      return { repo: named, dir: null };
    }
    const dir = checkoutOf(path.resolve(deps.cwd ?? process.cwd(), opts['--dir'] ?? '.'));
    const repo = dir ? repoOf(dir) : null;
    if (!repo) throw fail(`${dir ? 'this checkout\'s origin is not on GitHub' : `${opts['--dir'] ?? 'this folder'} is not in a git checkout`}: give the repo with --repo owner/name`);
    return { repo, dir };
  }

  // How the review that runs is described, from the console's answer (reviewReadiness.mjs, `review`).
  const reviewWords = (r) => (!r ? 'off' : r.runner === 'woodshed' ? `in a Woodshed session${r.rerun ? `, on commits tagged ${printable(r.rerun, 100)}` : ', on each commit'}` : `in ${r.runner === 'actions' ? 'GitHub Actions' : printable(r.runner, 20)}`);
  const fromWords = (from) => (from === 'console' ? 'kept on by the console, with no commit' : from === 'installation' ? 'from the installation\'s project file for the repo' : `from the default branch's ${PROJECT_FILE}`);
  const keptWords = (kept) => (kept?.error ? `not read: ${printable(kept.error, 200)}`
    : kept ? `on${kept.by ? `, by @${printable(kept.by, 40)}` : ''}${kept.at ? ` (${printable(kept.at, 30)})` : ''}, ${reviewWords({ runner: 'woodshed', rerun: kept.rerun })}` : 'off');
  // What the console answered, as the JSON event carries it.
  const consoleView = (readiness) => (readiness ? {
    project: readiness.project ?? null, reviewerApp: readiness.reviewerApp ?? null, defaultBranch: readiness.defaultBranch ?? null,
    kept: readiness.kept ?? null, review: readiness.review ?? null,
  } : null);

  // `enable` and `disable` with no --commit: the console keeps it, with no commit and no checkout.
  async function keptCommand(on, opts) {
    const { repo } = repoFrom(opts);
    const rerun = opts['--every-commit'] ? null : opts['--rerun'] ?? undefined;
    const dryRun = Boolean(opts['--dry-run']);
    const asked = await askConsole(repo, dryRun ? null : { on, ...(rerun !== undefined ? { rerun } : {}) });
    const { readiness, unasked, signIn } = asked;
    const findings = readiness ? readinessFindings(readiness, readiness.defaultBranch) : { missing: [], warnings: [] };
    const review = readiness?.review ?? null;
    const fileReview = readiness?.defaultBranch?.review ?? null;
    // The project file's review wins over the kept one (console/keptReview.mjs).
    if (on && fileReview && readiness?.project) {
      findings.warnings.push(fileReview.runner === 'woodshed'
        ? `the repo's project file names its own review (${reviewWords(fileReview)}), which wins over the one the console keeps.`
        : `the repo's project file reviews ${reviewWords(fileReview)}, which wins over the one the console keeps: set its pullRequests.review.runner to woodshed (woodshed review enable --commit, in a pull request), or take the review out of it.`);
    }
    if (!on && fileReview && readiness?.project) findings.warnings.push(`the repo's project file still names a review (${reviewWords(fileReview)}): take it out of ${PROJECT_FILE} in a pull request to turn that off.`);
    const wanted = rerun === undefined ? DEFAULT_RERUN : rerun;
    const changed = dryRun ? Boolean(readiness?.project) && (on ? !(readiness.kept && !readiness.kept.error && readiness.kept.rerun === wanted) : Boolean(readiness.kept)) : Boolean(readiness?.changed);
    if (json) {
      emit({
        event: sub, repo, where: 'console', on, changed, dryRun, ...(on ? { rerun: wanted } : {}),
        console: consoleView(readiness), unasked, missing: findings.missing, warnings: findings.warnings,
        ...(asked.unsupported ? { unsupported: true } : {}),
      });
    }
    say(`Repo:            ${printable(repo, 140)}`);
    if (readiness?.project) {
      const verb = on ? 'on' : 'off';
      if (dryRun) say(changed ? `Would turn the review the console keeps ${verb}${on ? `, ${reviewWords({ runner: 'woodshed', rerun: wanted })}` : ''}. Nothing changed (--dry-run).` : `The review the console keeps is already ${verb}${on ? `, ${reviewWords({ runner: 'woodshed', rerun: wanted })}` : ''}.`);
      else say(changed ? `Turned ${verb} the review the console keeps for ${printable(readiness.repo, 140)}${on ? `, ${reviewWords({ runner: 'woodshed', rerun: wanted })}` : ''}: no commit needed.` : `The review the console keeps was already ${verb}.`);
    }
    sayConsole(readiness, unasked, findings);
    if (signIn || findings.missing.length) return EXIT.waiting;
    if (!readiness) return EXIT.failed;
    const unread = readiness.defaultBranch?.error ? printable(readiness.defaultBranch.error, 300) : null;
    if (unread) {
      say(`Console: the default branch's ${PROJECT_FILE} was not read: ${unread}. Until it is, the console holds the repo's reviews.`);
      return EXIT.failed;
    }
    if (!on) {
      say(review ? `Review is still on, ${fromWords(review.from)}: ${reviewWords(review)}.` : 'Review is off.');
      return EXIT.done;
    }
    if (dryRun) return EXIT.done;
    if (review?.runner !== 'woodshed') return EXIT.waiting;
    say(`Review is on, ${fromWords(review.from)}: the console reviews each pull request ${review.rerun ? `whose head commit's message has ${printable(review.rerun, 100)}` : 'on each new commit'}.`);
    return EXIT.done;
  }

  if (sub === 'disable') {
    const opts = options({ '--repo': 'value', '--dir': 'value', '--dry-run': 'flag' });
    return keptCommand(false, opts);
  }

  if (sub === 'enable') {
    const opts = options({ '--qa': 'flag', '--rerun': 'value', '--every-commit': 'flag', '--dry-run': 'flag', '--dir': 'value', '--repo': 'value', '--commit': 'flag' });
    if (opts['--rerun'] && opts['--every-commit']) throw fail('--rerun and --every-commit are each other\'s opposite: give one');
    if (!opts['--commit']) {
      if (opts['--qa']) throw fail(`--qa needs the repo's ${PROJECT_FILE}, whose app a QA session starts: add --commit, in a checkout`);
      return keptCommand(true, opts);
    }
    if (opts['--repo']) throw fail(`--commit writes the checkout's ${PROJECT_FILE}: run it in a checkout of the repo, without --repo`);
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
    const { repo, dir } = opts['--repo'] ? repoFrom(opts) : { ...checkout(opts['--dir']) };
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
    // What the console runs the review by: the project file's, else the kept one (an older console says only the file's).
    const review = readiness ? (readiness.review !== undefined ? readiness.review
      : remote?.review ? { runner: remote.review.runner, rerun: remote.review.rerun ?? null, from: 'default branch' } : null) : null;
    // On: it runs in a session, the console runs its reviews (runsOn), and its reviewer App is known installed.
    const on = review?.runner === 'woodshed' && !findings.missing.length && readiness?.reviewerApp?.installed === true
      && runsOnHere(remote?.runsOn ?? null, readiness.consoleApp);
    if (json) {
      emit({
        repo, on, from: review?.from ?? null,
        checkout: dir ? { from: found?.from ?? null, error: fileError, review: local ? { runner: local.runner, rerun: local.rerun ?? null } : null, qa: gates?.qa ? { runner: gates.qa.runner, label: gates.qa.label } : null } : null,
        console: consoleView(readiness),
        unasked, missing: findings.missing, warnings: findings.warnings,
      });
    }
    say(`Repo:            ${repo ? printable(repo, 140) : 'not on GitHub'}`);
    if (dir) say(`This checkout:   ${fileError ? `${PROJECT_FILE} does not read: ${fileError}` : `review ${reviewWords(local)}${gates?.qa ? `; QA ${gates.qa.runner === 'woodshed' ? 'in a Woodshed session' : 'in GitHub Actions'}` : ''}`}`);
    if (remote) {
      const which = remote.from === 'installation' ? 'Installation:   ' : 'Default branch: ';
      say(`${which} ${remote.error ? `not read: ${printable(remote.error, 200)}` : remote.from === 'none' ? `no ${PROJECT_FILE}` : `review ${reviewWords(remote.review)}`}`);
    }
    if (readiness?.project && readiness.kept !== undefined) say(`Console keeps:   review ${keptWords(readiness.kept)}`);
    if (readiness?.project && !remote?.error) say(`Runs:            ${review ? `review ${reviewWords(review)}, ${fromWords(review.from)}` : 'no review'}`);
    sayConsole(readiness, unasked, findings);
    if (fileError || unreachable || failed || remote?.error) return EXIT.failed;
    if (on) {
      say('Review is on.');
      return EXIT.done;
    }
    if (!signIn && readiness && !findings.missing.length) {
      say(review && review.runner !== 'woodshed'
        ? `Next: the project file's review runs ${reviewWords(review)}, and wins: set its runner to woodshed (woodshed review enable --commit) in a pull request.`
        : local?.runner === 'woodshed' ? `Next: woodshed review enable${opts['--repo'] ? ` --repo ${repo}` : ''}, or merge the change to the project file.`
          : `Next: woodshed review enable${opts['--repo'] ? ` --repo ${repo}` : ''}.`);
    }
    return EXIT.waiting;
  }

  throw fail(`unknown command review ${sub}\n\n${REVIEW_USAGE}`);
}
