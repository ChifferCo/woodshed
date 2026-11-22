// The guided path uses the installed CLI's commands, so each step follows the same checks as running it directly.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { CONFIG_KEYS, CONFIG_UNAVAILABLE } from './config.mjs';
import { ORIGIN_RE } from './credentials.mjs';
import { repoOf } from '../shared/repoOf.mjs';

// With --yes, setup reviews this many of the person's open pull requests, the ones updated last: enough to see reviews
// work on their own code, without spending their plan on a long tail of old branches.
export const REVIEW_PRS_DEFAULT = 5;

export const SETUP_USAGE = `Usage: woodshed setup [--console <url>] [--json] [--no-browser] [options]

  --yes                  use the supplied options without asking questions
  --repo <owner/name>    choose a repository (repeatable, first is used for the session)
  --repo-dir <path>      local checkout for review enable (repeatable, keyed by GitHub origin)
  --agent <name>         claude or codex, when you use only one: else setup asks for both, and your pull requests
                         get reviews from both
  --reviews <choice>     personal reviewer choice: none, claude, codex, both, default
  --review-prs <which>   the open pull requests of yours to review now: all, none, or numbers separated by commas,
                         each only on the repos that list it (owner/name#12 for one repo of several)
                         (with --yes and no --review-prs: the ${REVIEW_PRS_DEFAULT} updated last)
  --skip-reviews         skip the project file, your reviewer choice and reviews of your pull requests
  --terminal <name>      optional: agent terminal for new private sessions, herdr or tmux
  --prompt <text>        optional: start a first coding session on this
  --no-session           finish without starting a session

When you need to do something, setup prints what is needed and exits 2. Run it again with the same options after that.`;

const REPO = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/(?!\.{1,2}$)[\w.-]+$/i;
const REVIEW_CHOICES = ['none', 'claude', 'codex', 'both', 'default'];
const TERMINAL_CHOICES = CONFIG_KEYS.terminal.values;
const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex' };
// What My settings takes for each (console/public/mySettings.js): setup never handles a token itself.
const AGENT_HOW = {
  claude: 'For Claude Code, run claude setup-token and paste the token it prints under Claude',
  codex: 'For Codex, run codex login, then paste all of ~/.codex/auth.json (or an OpenAI API key, sk-…) under Codex',
};
// A pull request in --review-prs or the terminal's answer: 12, #12, or owner/name#12 for one repo of several.
const PICK = '(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?/[\\w.-]+)?#?[1-9][0-9]{0,8}';
const REVIEW_PRS_RE = new RegExp(`^(?:all|none|${PICK}(?:\\s*,\\s*${PICK})*)$`, 'i');

/**
 * The pull requests a choice picks on `repo`, of the person's open ones there: `all` the ready ones, else each number
 * listed there, bare or named for this repo. A number named for another repo, or not on this one's list, is left out,
 * so one choice for several repos never reaches a pull request it did not mean.
 * @returns {{numbers: number[], drafts: number[]}}  `drafts`: picked, but reviewed only once ready
 */
function picksFor(which, repo, pulls) {
  if (which === 'none') return { numbers: [], drafts: [] };
  const ready = pulls.filter((p) => p.draft !== true).map((p) => p.number);
  if (which === 'all') return { numbers: ready, drafts: [] };
  const listed = new Map(pulls.map((p) => [p.number, p]));
  const picked = new Set(which.split(',').map((w) => w.trim()).flatMap((w) => {
    const [, named, n] = /^(?:(.+)#)?#?(\d+)$/.exec(w) ?? [];
    return named && named.toLowerCase() !== repo.toLowerCase() ? [] : [Number(n)];
  }).filter((n) => listed.has(n)));
  return { numbers: [...picked].filter((n) => listed.get(n).draft !== true), drafts: [...picked].filter((n) => listed.get(n).draft === true) };
}
const key = (repo) => repo.toLowerCase();

function options(args, fail) {
  const out = { repos: [], dirs: [] };
  for (let i = 0; i < args.length; i++) {
    const [name, inline] = args[i].split(/=(.*)/s);
    if (['--yes', '--skip-reviews', '--no-session'].includes(name) && inline === undefined) {
      out[name] = true;
      continue;
    }
    if (!['--repo', '--repo-dir', '--reviews', '--review-prs', '--agent', '--terminal', '--prompt'].includes(name)) throw fail(`Unknown setup option ${name}. Run woodshed setup --help.`);
    const value = inline ?? args[++i];
    if (!value?.trim() || (inline === undefined && value.startsWith('--'))) throw fail(`${name} needs a value.`);
    if (name === '--repo') {
      if (!REPO.test(value)) throw fail('--repo needs a GitHub repo as owner/name.');
      out.repos.push(value);
    } else if (name === '--repo-dir') out.dirs.push(value);
    else out[name] = value;
  }
  if (out['--reviews'] && !REVIEW_CHOICES.includes(out['--reviews'])) throw fail(`--reviews must be one of ${REVIEW_CHOICES.join(', ')}.`);
  if (out['--agent'] && !['claude', 'codex'].includes(out['--agent'])) throw fail('--agent must be claude or codex.');
  if (out['--terminal'] && !TERMINAL_CHOICES.includes(out['--terminal'])) throw fail('--terminal must be herdr or tmux.');
  if (out['--skip-reviews'] && out['--reviews']) throw fail('Choose either --reviews or --skip-reviews.');
  if (out['--review-prs'] && !REVIEW_PRS_RE.test(out['--review-prs'].trim())) throw fail('--review-prs must be all, none, or pull request numbers separated by commas (owner/name#12 for one repo of several).');
  if (out['--skip-reviews'] && out['--review-prs']) throw fail('Choose either --review-prs or --skip-reviews.');
  if (out['--no-session'] && out['--prompt']) throw fail('Choose either --prompt or --no-session.');
  return out;
}

// Resolve paths explicitly before invoking a child in a checkout. A relative XDG_CONFIG_HOME or PATH would otherwise
// be searched from the checkout, so run each command here and pass the review command its own --dir.
export function runCli({ node, script }, args, env) {
  return new Promise((resolve, reject) => {
    execFile(node, [script, ...args], { env, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err && typeof err.code !== 'number') return reject(new Error('Could not run a Woodshed subcommand.'));
      resolve({ code: err?.code ?? 0, stdout });
    });
  });
}

async function askTerminal(question, stderr) {
  const rl = createInterface({ input: process.stdin, output: stderr });
  const controller = new AbortController();
  rl.once('close', () => controller.abort());
  try {
    return (await rl.question(question, { signal: controller.signal })).trim();
  } catch (err) {
    if (err.name === 'AbortError') return null;
    throw err;
  } finally {
    rl.close();
  }
}

function printable(value) {
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 600) : '';
}

function linkTo(value, origin, github = false) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value, origin);
    if (url.username || url.password) return null;
    if (url.origin === origin || (github && url.origin === 'https://github.com')) return url.href;
  } catch {
    // A subcommand may have no link for this step.
  }
  return null;
}

export async function setupCommand(args, ctx) {
  const { origin } = args;
  const { EXIT, emit, say, fail, open, env } = ctx;
  if (args.rest !== null) throw fail('Use --prompt to give setup a session prompt.');
  const opts = options(args.args, fail);
  const cwd = ctx.cwd ?? process.cwd();
  const dirs = new Map();
  for (const dir of opts.dirs) {
    const full = path.resolve(cwd, dir);
    const repo = (ctx.repoOf ?? repoOf)(full);
    if (!repo) throw fail(`No GitHub origin found in ${printable(dir)}. Give --repo-dir a checkout of the repo.`);
    if (!dirs.has(key(repo))) dirs.set(key(repo), full);
  }
  const here = (ctx.repoOf ?? repoOf)(cwd);
  if (here && !dirs.has(key(here))) dirs.set(key(here), cwd);
  const choose = !opts['--yes'] && (ctx.tty ?? process.stdin.isTTY)
    ? (ctx.ask ?? ((question) => askTerminal(question, ctx.stderr)))
    : null;
  const run = ctx.run ?? ((words) => runCli(ctx.self, words, env));
  function report(step, status, message, fields = {}) {
    if (args.json) emit({ event: 'setup', step, status, message, ...fields });
    else say(`[${status.replace('-', ' ')}] ${message}${fields.url ? ` ${fields.url}` : ''}`);
  }
  function stop(step, code, message, fields) {
    const status = code === EXIT.waiting ? 'needs-you' : code === EXIT.refused ? 'refused' : 'failed';
    report(step, status, message, fields);
    return [EXIT.waiting, EXIT.refused].includes(code) ? code : EXIT.failed;
  }
  const globals = ['--console', origin, '--json', ...(!args.browser ? ['--no-browser'] : [])];
  async function call(step, ...words) {
    try {
      const result = await run([...globals, ...words]);
      const events = result.stdout.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
      if (events.some((event) => !event || typeof event !== 'object' || Array.isArray(event))) throw new Error('not a JSON event');
      return { code: result.code, events, last: events.at(-1), error: events.findLast((event) => event.event === 'error') };
    } catch {
      return { code: EXIT.failed, events: [], error: { error: `Could not read woodshed ${step} output. Run woodshed ${step} directly for details.` } };
    }
  }
  function childError(step, result, message, fields) {
    return stop(step, result.code || EXIT.failed, printable(result.error?.error) || message, fields);
  }
  // Credential-store origins have no shell metacharacters inside double quotes, including in cmd.exe.
  const consoleArg = ORIGIN_RE.test(origin) ? `"${origin}"` : '"YOUR_CONSOLE_URL"';
  const command = (...words) => `woodshed ${words.join(' ')} --console ${consoleArg}`;

  const status = await call('status', 'status');
  if (status.code === EXIT.waiting && status.last?.signedIn === false) {
    const login = await call('login', 'login', '--no-wait');
    const code = login.events.find((event) => event.event === 'code');
    const url = linkTo(code?.verificationUrlComplete, origin);
    if (login.code === EXIT.waiting && url && /^[A-Z]{4}-[A-Z]{4}$/.test(code.userCode)) {
      return stop('login', EXIT.waiting, `Match the code ${code.userCode} in your browser and approve the CLI sign-in, then run setup again.`, { url, userCode: code.userCode });
    }
    if (login.code !== EXIT.done) return childError('login', login, 'Sign in with woodshed login, then run setup again.');
  } else if (status.code !== EXIT.done || status.last?.signedIn !== true) {
    return childError('login', status, 'Could not check whether you are signed in.');
  }
  // Login just collected an approval, so check the account's sign-ins again.
  const me = status.code === EXIT.done ? status.last : (await call('status', 'status')).last;
  if (me?.signedIn !== true) return stop('login', EXIT.failed, 'Could not verify the new CLI sign-in. Run woodshed status.');
  report('login', 'done', `Signed in${me.login ? ` as @${printable(me.login)}` : ''} to ${origin}.`);

  const help = await run([...globals, '--help']).catch(() => null);
  if (help?.code !== EXIT.done) return stop('repos', EXIT.failed, 'Could not read woodshed --help.');
  const has = (name) => new RegExp(`^ {2}${name}\\b`, 'm').test(help.stdout);

  let selected = opts.repos;
  const resume = (...more) => {
    const flags = [...selected.map((name) => `--repo ${name}`), ...more].join(' ');
    return flags ? `rerun setup with ${flags}` : 'run setup again';
  };
  if (!has('repo')) {
    report('repos', 'skipped', 'This CLI has no repo command yet. Choose repos in the console or use a CLI with repo list and repo add.', { url: `${origin}/console-settings` });
  } else {
    const listed = await call('repo list', 'repo', 'list');
    if (listed.code !== EXIT.done) return childError('repos', listed, 'Could not list repos.');
    const { projects, available } = listed.last ?? {};
    if (!Array.isArray(projects) || !(available === null || Array.isArray(available))) return stop('repos', EXIT.failed, 'Could not read the repo list.');
    const valid = (entry) => typeof entry?.repo === 'string' && REPO.test(entry.repo);
    const connected = projects.filter(valid);
    const added = new Set(connected.map(({ repo }) => key(repo)));
    const named = [...connected, ...(available ?? []).filter(valid)].map(({ repo }) => ({ repo, added: added.has(key(repo)) }));
    const show = named.map((entry) => `${entry.repo}${entry.added === true ? ' (added)' : ''}`).join(', ') || 'none listed';
    // In agent mode the list accompanies the instruction when a choice has yet to be made.
    if (choose && !selected.length) {
      if (args.json) ctx.stderr.write(`Repos on ${origin}: ${show}.\n`);
      else say(`Repos on ${origin}: ${show}.`);
    }
    if (!selected.length && choose) selected = (await choose('Which repos should Woodshed use? Enter owner/name, separated by commas. ') ?? '').split(/[\s,]+/).filter(Boolean);
    if (!selected.length || selected.some((repo) => !REPO.test(repo))) {
      return stop('repos', EXIT.waiting, `Choose a repo with --repo owner/name. Repos: ${show}.`, { repos: named.map(({ repo, added }) => ({ repo, added: added === true })) });
    }
    selected = [...new Map(selected.map((repo) => [key(repo), repo])).values()];
    for (const repo of selected) {
      if (added.has(key(repo))) continue;
      const addedRepo = await call('repo add', 'repo', 'add', repo);
      if (addedRepo.code !== EXIT.done) {
        const event = addedRepo.events.find((e) => e.status === 'needs-github-app' || e.event === 'needs-github-app');
        const url = linkTo(event?.installUrl ?? event?.url, origin, true);
        if (addedRepo.code === EXIT.waiting && event) {
          return stop('repos', EXIT.waiting, `Install the GitHub App for ${repo}, then ${resume()}.${url ? '' : ' Ask a console admin for its install link.'}`, { repo, selected, ...(url ? { url } : {}) });
        }
        return childError('repos', addedRepo, `Could not add ${repo}.`, { repo });
      }
    }
    report('repos', 'done', `Selected ${selected.join(', ')}. Repos: ${show}.`, { selected });
  }

  // Reviews from Claude Code and Codex are what setup gives first: on a console with no team keys they run on the pull
  // request's author's own Claude token and Codex sign-in (console/reviewAgents.mjs), so setup asks for both, unless the
  // person says they use only one.
  const signIns = me.sessionSignIns;
  let wanted = opts['--agent'] ? [opts['--agent']] : ['claude', 'codex'];
  if (!signIns) {
    report('agent', 'skipped', 'This console does not report agent sign-ins. Connect Claude Code and Codex on My settings.', { url: `${origin}/settings` });
  } else {
    let missing = wanted.filter((name) => signIns[name] !== true);
    if (missing.length && !opts['--agent'] && choose) {
      const have = wanted.filter((name) => signIns[name] === true).map((name) => AGENT_NAMES[name]);
      const intro = `Connect Claude Code and Codex: with both connected, your pull requests get reviews from both.${have.length ? ` ${have[0]} is connected.` : ''}`;
      if (args.json) ctx.stderr.write(`${intro}\n`);
      else say(intro);
      const answer = (await choose('Use both? Press Enter for both, or type claude or codex if you use only one. ') ?? '').toLowerCase();
      if (answer === 'claude' || answer === 'codex') wanted = [answer];
      else if (answer && answer !== 'both') return stop('agent', EXIT.waiting, 'Answer both, claude or codex, or rerun setup with --agent claude or --agent codex.');
      missing = wanted.filter((name) => signIns[name] !== true);
    }
    if (missing.length) {
      const url = `${origin}/settings`;
      if (args.browser) open(url);
      const both = wanted.length === 2;
      const why = both ? ': with both connected, your pull requests get reviews from both' : '';
      const onlyOne = both ? ' Use only one? Rerun setup with --agent claude or --agent codex.' : '';
      const again = resume(...(!both && !opts['--agent'] ? [`--agent ${wanted[0]}`] : []));
      return stop('agent', EXIT.waiting, `Connect ${missing.map((name) => AGENT_NAMES[name]).join(' and ')} on My settings${why}. ${missing.map((name) => AGENT_HOW[name]).join('. ')}.${onlyOne} Then ${again}.`, { url, wanted, missing });
    }
    const names = wanted.map((name) => AGENT_NAMES[name]).join(' and ');
    report('agent', 'done', `${names} ${wanted.length === 2 ? 'are' : 'is'} connected: your pull requests get reviews from ${wanted.length === 2 ? 'both' : names}.`, { agent: wanted[0], wanted });
  }
  const agent = opts['--agent'] ?? (signIns?.codex && !signIns?.claude ? 'codex' : 'claude');

  const canConfig = has('config');

  // The reviewer choice saved by the step below, when it ran: `none` means no review of their pull requests starts.
  let reviewChoice = null;
  if (opts['--skip-reviews']) {
    report('reviews', 'skipped', 'You chose to skip review setup.');
  } else {
    const levels = 'A repo’s .woodshed/project.yaml enables reviews through a pull request. Your reviewer choice controls who reviews your pull requests.';
    const canReview = has('review');
    if (!canReview) report('repo-review', 'skipped', `${levels} This CLI has no review command yet. In a checkout, use: ${command('review', 'enable')}.`);
    else if (!selected.length) report('repo-review', 'skipped', `${levels} Run in the repo’s checkout: ${command('review', 'enable')}.`);
    else {
      for (const repo of selected) {
        const dir = dirs.get(key(repo));
        if (!dir) {
          report('repo-review', 'skipped', `${levels} No checkout supplied for ${repo}. Run in its checkout: ${command('review', 'enable')}.`, { repo });
          continue;
        }
        const state = await call('review status', 'review', 'status', '--dir', dir);
        if (state.code === EXIT.done && state.last?.on === true) {
          report('repo-review', 'done', `${levels} Review is enabled for ${repo}.`, { repo });
          continue;
        }
        if (state.code !== EXIT.waiting) return childError('repo-review', state, printable(state.last?.checkout?.error) || 'Could not check whether review is enabled.', { repo });
        const review = await call('review enable', 'review', 'enable', '--dir', dir);
        const info = review.events.find((event) => event.event === 'enable');
        if (review.code === EXIT.waiting && Array.isArray(info?.missing) && info.missing.length) {
          const url = linkTo(info.console?.reviewerApp?.installUrl, origin, true);
          const steps = info.missing.map((item) => printable(item?.step)).filter(Boolean);
          return stop('repo-review', EXIT.waiting, `${levels} ${steps.join(' ')} Then run setup again.`, { repo, ...(url ? { url } : {}) });
        }
        if (review.code !== EXIT.done || !info) {
          const reason = Array.isArray(info?.problems) ? info.problems.map(printable).join(' ') : printable(info?.unasked);
          return childError('repo-review', review, reason || `Could not enable review for ${repo}.`, { repo });
        }
        const defaultError = printable(info.console?.defaultBranch?.error);
        if (defaultError) return stop('repo-review', EXIT.failed, `Could not check the default branch of ${repo}. ${defaultError}`, { repo });
        if (info.written || info.console?.defaultBranch?.review?.runner !== 'woodshed') {
          const url = `https://github.com/${repo}/pulls`;
          report('repo-review', 'done', `${levels} Prepared the checkout for ${repo}. Open a pull request for .woodshed/project.yaml.`, { repo, url });
          continue;
        }
        report('repo-review', 'done', `${levels} Review is enabled for ${repo}.`, { repo });
      }
    }
    if (!canConfig) {
      report('review-choice', 'skipped', `This CLI has no config command yet. Set your reviewer choice on My settings, or use: ${command('config', 'set', 'reviews', opts['--reviews'] ?? '<choice>')}.`, { url: `${origin}/settings` });
    } else {
      const current = await call('config list', 'config', 'list');
      if (current.code !== EXIT.done || !REVIEW_CHOICES.includes(current.last?.config?.reviews)) return childError('review-choice', current, 'Could not read your reviewer choice.');
      const prior = current.last.config.reviews;
      let value = opts['--reviews'];
      if (!value && choose) {
        const answer = await choose(`Who should review your pull requests (${REVIEW_CHOICES.join(', ')})? Enter keeps ${prior}. `);
        if (answer !== null) value = answer || prior;
      }
      if (!REVIEW_CHOICES.includes(value)) return stop('review-choice', EXIT.waiting, `Choose who reviews your pull requests with --reviews ${REVIEW_CHOICES.join('|')}, or use --skip-reviews. Current choice: ${prior}.`);
      if (value !== prior) {
        const set = await call('config set reviews', 'config', 'set', 'reviews', value);
        if (set.code !== EXIT.done) return childError('review-choice', set, 'Could not save your reviewer choice.');
      }
      reviewChoice = value;
      report('review-choice', 'done', `Your reviewer choice is ${value}.`, { choice: value });
    }
  }

  // The console's review of the person's open pull requests on each repo, now: what setup is for. The terminal and a
  // first coding session after it are optional.
  const reviewLinks = [];
  if (opts['--skip-reviews'] || opts['--review-prs']?.trim().toLowerCase() === 'none') {
    report('pr-reviews', 'skipped', opts['--skip-reviews'] ? 'You chose to skip reviews.' : 'You chose to review none of your pull requests now.');
  } else if (reviewChoice === 'none') {
    report('pr-reviews', 'skipped', 'Your reviewer choice is none, so no review of your pull requests starts. Choose another with --reviews to have them reviewed.');
  } else if (!/\bpulls\|start\b/.test(help.stdout)) {
    report('pr-reviews', 'skipped', 'This CLI cannot start reviews yet: update it, then run woodshed review start <pull request>.');
  } else if (!selected.length) {
    report('pr-reviews', 'skipped', `No repo chosen. To review a pull request of yours: ${command('review', 'start', '<number>', '--repo', 'owner/name')}.`);
  } else {
    for (const repo of selected) {
      const listed = await call('review pulls', 'review', 'pulls', '--repo', repo);
      const found = listed.events.find((event) => event.event === 'pulls');
      if (listed.code !== EXIT.done || !Array.isArray(found?.pulls)) return childError('pr-reviews', listed, `Could not list your open pull requests on ${repo}.`, { repo });
      const pulls = found.pulls.filter((p) => Number.isSafeInteger(p?.number));
      const rerun = printable(found.review?.rerun);
      const staleText = found.stale === true ? ' GitHub did not answer just now, so this list may be out of date: run setup again to check.' : '';
      if (found.review?.on !== true) {
        report('pr-reviews', 'skipped', `Review is not on for ${repo} yet, so no review can start on your pull requests. Once it is: ${command('review', 'start', '<number>', '--repo', repo)}.`, { repo });
        continue;
      }
      const next = `a review will start on your next one${rerun ? ` whose commit message has ${rerun}` : ''}`;
      if (!pulls.length) {
        report('pr-reviews', 'done', `You have no open pull requests on ${repo}: ${next}.${staleText}`, { repo, reviews: [] });
        continue;
      }
      const ready = pulls.filter((p) => p.draft !== true);
      const shown = pulls.map((p) => `#${p.number}${p.draft ? ' (draft)' : ''} ${printable(p.title)}`).join('; ');
      let which = opts['--review-prs']?.trim().toLowerCase();
      let why = '';
      if (!which && choose) {
        const lines = [`Your open pull requests on ${repo}:`, ...pulls.map((p) => `  #${p.number}${p.draft ? ' (draft: reviewed once it is ready)' : ''}  ${printable(p.title)}`)];
        if (args.json) ctx.stderr.write(`${lines.join('\n')}\n`);
        else lines.forEach((line) => say(line));
        const answer = await choose('Review which now? Press Enter for all of them, or give numbers separated by commas, or none. ');
        // Closing the input (Ctrl-D) starts nothing: reviews spend the person's plan and post on GitHub.
        if (answer === null) {
          report('pr-reviews', 'skipped', `No answer, so no review started on ${repo}. To review one: ${command('review', 'start', '<number>', '--repo', repo)}.`, { repo });
          continue;
        }
        which = answer === '' ? 'all' : answer.trim().toLowerCase();
        if (!REVIEW_PRS_RE.test(which)) return stop('pr-reviews', EXIT.waiting, `Answer all, none, or pull request numbers, or rerun setup with --review-prs. Yours: ${shown}.`, { repo });
      }
      if (!which && opts['--yes']) {
        which = ready.length ? ready.slice(0, REVIEW_PRS_DEFAULT).map((p) => p.number).join(',') : 'all';
        if (ready.length > REVIEW_PRS_DEFAULT) why = ` The ${REVIEW_PRS_DEFAULT} updated last; --review-prs all reviews every one.`;
      }
      if (!which) {
        const form = selected.length > 1 ? `, or ${repo}#<number> for this repo alone` : '';
        return stop('pr-reviews', EXIT.waiting, `Choose which of your open pull requests on ${repo} to review now with --review-prs all, none, or their numbers${form}. Yours: ${shown}.`, { repo, pulls });
      }
      const { numbers, drafts } = picksFor(which, repo, pulls);
      const draftText = drafts.length ? ` ${drafts.map((n) => `#${n}`).join(', ')} ${drafts.length === 1 ? 'is a draft' : 'are drafts'}: reviewed once ready for review.` : '';
      if (!numbers.length) {
        const why = which === 'none' ? `You chose to review none of your pull requests on ${repo} now.`
          : which === 'all' ? `Your open pull requests on ${repo} are drafts: each is reviewed once it is ready for review.`
            : `None of the pull requests you chose is one of your open ones on ${repo}.${draftText} Yours: ${shown}.`;
        report('pr-reviews', 'skipped', why, { repo });
        continue;
      }
      const started = await call('review start', 'review', 'start', ...numbers.map(String), '--repo', repo);
      const reviews = started.events.filter((event) => event.event === 'review' && Number.isSafeInteger(event.number));
      if (!reviews.length) return childError('pr-reviews', started, `Could not start reviews on ${repo}.`, { repo });
      const links = reviews.filter((r) => r.outcome !== 'refused').map((r) => ({ number: r.number, outcome: r.outcome, url: linkTo(r.session?.url, origin), pullUrl: linkTo(r.pullUrl, origin, true) }));
      const refused = reviews.filter((r) => r.outcome === 'refused').map((r) => `#${r.number}: ${printable(r.error)}`);
      reviewLinks.push(...links.map((link) => ({ repo, ...link })));
      const already = { running: ' (being reviewed already)', reviewed: ' (its head commit was reviewed already)' };
      const linkText = links.map((link) => `#${link.number} ${link.url ?? link.pullUrl}${already[link.outcome] ?? ''}`).join(', ');
      const refusedText = refused.length ? ` Not started: ${refused.join('; ')}.` : '';
      if (!links.length) return stop('pr-reviews', started.code || EXIT.failed, `No review started on ${repo}.${refusedText}`, { repo });
      report('pr-reviews', 'done', `Reviews on ${repo}: ${linkText}. Each posts its verdict on the pull request; after that, ${next}.${why}${draftText}${refusedText}${staleText}`, { repo, reviews: links });
    }
  }

  const canAttach = me.hc?.ok === true && ctx.platform !== 'win32';
  let terminal = opts['--terminal'];
  const checkTerminal = canConfig && (choose || terminal || (canAttach && !opts['--no-session']));
  const currentTerminal = checkTerminal ? await call('config get terminal', 'config', 'get', 'terminal') : null;
  if (!canConfig || currentTerminal?.error?.status === CONFIG_UNAVAILABLE) {
    const reason = canConfig ? 'This console has no CLI settings endpoint.' : 'This CLI has no config command.';
    const fields = { url: `${origin}/settings` };
    if (terminal) return stop('terminal', EXIT.waiting, `${reason} Choose ${terminal} on My settings, then rerun setup without --terminal.`, fields);
    report('terminal', 'skipped', `${reason} Set your agent terminal on My settings.`, fields);
  } else if (currentTerminal) {
    const prior = currentTerminal.last?.value;
    if (currentTerminal.code !== EXIT.done || !TERMINAL_CHOICES.includes(prior)) return childError('terminal', currentTerminal, 'Could not read your agent terminal preference.');
    if (!terminal && choose) {
      const answer = await choose(`Use Herdr or tmux for agents in new private sessions? Enter keeps ${prior}. `);
      terminal = answer === '' || answer === null ? prior : answer.toLowerCase();
      if (!TERMINAL_CHOICES.includes(terminal)) return stop('terminal', EXIT.waiting, `Choose --terminal herdr or --terminal tmux. Current choice is ${prior}.`);
    }
    terminal ??= prior;
    if (terminal !== prior) {
      const set = await call('config set terminal', 'config', 'set', 'terminal', terminal);
      if (set.code !== EXIT.done) return childError('terminal', set, 'Could not save your agent terminal preference.');
    }
    report('terminal', 'done', `New private sessions will run their agents in ${terminal === 'herdr' ? 'Herdr' : 'tmux'}.`, { terminal });
  }

  const code = await firstSession();
  // Setup ends with the reviews it started, the main thing it set up, when a session's lines came after them.
  if (code === EXIT.done && reviewLinks.length) {
    report('reviews', 'done', `Your reviews: ${reviewLinks.map((link) => `${link.repo}#${link.number} ${link.url ?? link.pullUrl}`).join(', ')}.`, { reviews: reviewLinks });
  }
  return code;

  // Optional: a first coding session, only when asked for (--prompt, or a prompt typed in).
  async function firstSession() {
    if (opts['--no-session']) {
      report('session', 'skipped', 'You chose to finish without starting a session.');
      return EXIT.done;
    }
    const useHc = canAttach && (terminal === 'herdr' || !canConfig);
    const newSession = ['session', 'new', ...(useHc ? ['--herdr'] : [])];
    if (!opts['--prompt'] && !choose) {
      report('session', 'skipped', `A first coding session is optional. Start one with ${command(...newSession, '--', '"<what to work on>"')}, or rerun setup with --prompt.`);
      return EXIT.done;
    }
    const repo = selected[0];
    const list = await call('session list', 'session', 'list');
    if (list.code !== EXIT.done || !Array.isArray(list.last?.sessions)) return childError('session', list, 'Could not list sessions.');
    // Setup is for a first environment. A retained or starting private session on this repo already fills that role.
    // An explicitly failed or deleted one doesn't.
    const existing = list.last.sessions.find((session) => session.mine === true && !['failed', 'deleted'].includes(session.stateWord) && session.state !== 'failed'
      && (!repo || (typeof session.repo === 'string' && key(repo) === key(session.repo))));
    if (existing) {
      // A saved default is the console's project name. The session list identifies repos by GitHub owner/name.
      if (!repo) return stop('session', EXIT.waiting, 'Rerun setup with --repo owner/name to check for an existing session on the repo you want.');
      const url = linkTo(existing.url, origin);
      if (existing.state === 'needs-you') return stop('session', EXIT.waiting, 'Your session needs your attention.', { url });
      const more = opts['--prompt'] ? ' To start another session with your prompt, use woodshed session new.' : '';
      report('session', 'done', `You already have a session on ${repo}.${more}`, { url });
      return EXIT.done;
    }

    let prompt = opts['--prompt'];
    if (!prompt && choose) {
      prompt = await choose(`Optional: start a coding session with ${newSession.join(' ')}? Enter a prompt, or press Enter to skip. `);
      if (!prompt) {
        report('session', 'skipped', 'You chose to finish without starting a session.');
        return EXIT.done;
      }
    }
    const started = await call('session new', ...newSession, ...(repo ? ['--repo', repo] : []), '--agent', agent, '--', prompt);
    const session = started.events.findLast((event) => event.session)?.session;
    const url = linkTo(session?.url, origin);
    const placementError = printable(started.events.findLast((event) => event.event === 'connected')?.agent?.placementError);
    if (placementError) report('herdr', 'skipped', `The machine connected, but its agent could not be placed in a Herdr space. ${placementError}`, { url });
    if (useHc && started.error && /^[a-f0-9]{8}$/.test(session?.id)
        && started.events.some((event) => ['running', 'needs-you'].includes(event.event))) {
      const retry = command('session', 'herdr', session.id);
      return stop('session', started.code, `Session ${session.id} started. ${printable(started.error.error)} Reconnect with ${retry}.`, { url, retry });
    }
    if (started.code === EXIT.waiting && url) return stop('session', EXIT.waiting, 'Your session needs your attention.', { url });
    if (started.code !== EXIT.done || !session) return childError('session', started, printable(session?.error) || 'Could not start a session.', { url });
    report('session', 'done', 'Your first session is running.', { url });
    return EXIT.done;
  }
}
