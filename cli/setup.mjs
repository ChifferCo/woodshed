// The guided path uses the installed CLI's commands, so each step follows the same checks as running it directly.

import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { CONFIG_KEYS, CONFIG_UNAVAILABLE } from './config.mjs';
import { ORIGIN_RE } from './credentials.mjs';

// With --yes, setup reviews this many of the person's open pull requests, the ones updated last: enough to see reviews
// work on their own code, without spending their plan on a long tail of old branches.
export const REVIEW_PRS_DEFAULT = 5;

export const SETUP_USAGE = `Usage: woodshed setup [--console <url>] [--json] [--no-browser] [options]

  --yes                  use the supplied options without asking questions
  --repo <owner/name>    choose a repository (repeatable, first is used for the session)
  --agent <name>         claude or codex, when you use only one: else setup asks for both, and your pull requests
                         get reviews from both
  --reviews <choice>     personal reviewer choice: none, claude, codex, both, default
  --review-prs <which>   the open pull requests of yours to review now: all, none, or numbers separated by commas
                         (with several repos, each as owner/name#12)
                         (with --yes and no --review-prs: the ${REVIEW_PRS_DEFAULT} updated last)
  --skip-reviews         skip the review check, your reviewer choice and reviews of your pull requests
  --terminal <name>      optional: agent terminal for new private sessions, herdr or tmux
  --prompt <text>        optional: start a first coding session on this
  --no-session           finish without starting a session

When you need to do something, setup prints what is needed and exits 2. Run it again with the same options after that.`;

const REPO = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/(?!\.{1,2}$)[\w.-]+$/i;
const REVIEW_CHOICES = ['none', 'claude', 'codex', 'both', 'default'];
const TERMINAL_CHOICES = CONFIG_KEYS.terminal.values;
const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex' };
// How to connect each, as My settings' own rows say it (console/public/mySettings.js): what to run in a terminal of the
// person's own, then where to paste. Setup never runs these or handles a token itself, so none passes through this
// process, a coding agent running setup, or its captured output. `/settings#claude` and `#codex` open that row with
// the caret in its box.
export function agentSteps(name, url, platform) {
  if (name === 'claude') {
    return [
      'In another terminal, run: claude setup-token',
      'It signs you in to Claude in your browser, then prints a token that starts with sk-ant-oat01-. Copy it.',
      `On My settings (${url}), paste it in the Claude row's box and press Save.`,
    ];
  }
  return [
    'In another terminal, run: codex login (skip it if Codex is already signed in on this computer)',
    platform === 'darwin'
      ? 'In that terminal, copy the sign-in it saved, without printing it: pbcopy < ~/.codex/auth.json'
      : 'In that terminal, print the sign-in it saved and copy all of it: cat ~/.codex/auth.json',
    `On My settings (${url}), paste it in the Codex row's box and press Save. An OpenAI API key (sk-…) works there too.`,
  ];
}
const numbered = (steps) => steps.map((step, i) => `  ${i + 1}. ${step}`).join('\n');
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
  const out = { repos: [] };
  for (let i = 0; i < args.length; i++) {
    const [name, inline] = args[i].split(/=(.*)/s);
    if (['--yes', '--skip-reviews', '--no-session'].includes(name) && inline === undefined) {
      out[name] = true;
      continue;
    }
    if (!['--repo', '--reviews', '--review-prs', '--agent', '--terminal', '--prompt'].includes(name)) throw fail(`Unknown setup option ${name}. Run woodshed setup --help.`);
    const value = inline ?? args[++i];
    if (!value?.trim() || (inline === undefined && value.startsWith('--'))) throw fail(`${name} needs a value.`);
    if (name === '--repo') {
      if (!REPO.test(value)) throw fail('--repo needs a GitHub repo as owner/name.');
      out.repos.push(value);
    } else out[name] = value;
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

// Each step runs the installed CLI here, with this process's environment.
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
    const both = wanted.length === 2;
    const rowUrl = (name) => `${origin}/settings#${name}`;
    const stepsOf = (name) => agentSteps(name, rowUrl(name), ctx.platform);
    // On a terminal, setup walks through each one and waits while the person does it, then checks with the console.
    const tell = (line) => (args.json ? ctx.stderr.write(`${line}\n`) : say(line));
    let walked = false;
    if (missing.length && choose) {
      walked = true;
      const todo = [...missing];
      for (const [i, name] of todo.entries()) {
        tell(`\nConnect ${AGENT_NAMES[name]}${todo.length > 1 ? ` (${i + 1} of ${todo.length})` : ''}:\n${numbered(stepsOf(name))}`);
        if (args.browser) {
          open(rowUrl(name));
          tell(`My settings is open in your browser at the ${name === 'claude' ? 'Claude' : 'Codex'} row.`);
        }
        for (;;) {
          const answer = (await choose('Press Enter once it is saved, or type skip to finish setup later. '))?.toLowerCase();
          if (answer === undefined || answer === 'skip') break;
          const checked = await call('status', 'status');
          const now = checked.code === EXIT.done ? checked.last?.sessionSignIns : null;
          if (!now) {
            tell('Could not ask the console whether it is saved. Press Enter to ask again.');
            continue;
          }
          if (now[name] === true) {
            missing = missing.filter((other) => other !== name);
            tell(`${AGENT_NAMES[name]} is connected.`);
            break;
          }
          tell(`The console does not have ${AGENT_NAMES[name]}'s sign-in yet: check that Save on My settings said Saved.`);
        }
        if (missing.includes(name)) break;
      }
    }
    if (missing.length) {
      if (args.browser && !walked) open(rowUrl(missing[0]));
      const why = both ? ': with both connected, your pull requests get reviews from both' : '';
      const onlyOne = both ? ' Use only one? Rerun setup with --agent claude or --agent codex.' : '';
      const again = resume(...(!both && !opts['--agent'] ? [`--agent ${wanted[0]}`] : []));
      const how = missing.map((name) => `${AGENT_NAMES[name]}:\n${numbered(stepsOf(name))}`).join('\n');
      return stop('agent', EXIT.waiting, `Connect ${missing.map((name) => AGENT_NAMES[name]).join(' and ')} on My settings${why}.\n${how}\n${onlyOne.trim() ? `${onlyOne.trim()} ` : ''}Then ${again}.`, {
        url: rowUrl(missing[0]), wanted, missing, steps: Object.fromEntries(missing.map((name) => [name, stepsOf(name)])),
      });
    }
    const names = wanted.map((name) => AGENT_NAMES[name]).join(' and ');
    report('agent', 'done', `${names} ${wanted.length === 2 ? 'are' : 'is'} connected: your pull requests get reviews from ${wanted.length === 2 ? 'both' : names}.`, { agent: wanted[0], wanted });
  }
  // The session's agent: the one they use when they said only one, else Claude Code unless only Codex is connected.
  const agent = wanted.length === 1 ? wanted[0] : (signIns?.codex && !signIns?.claude ? 'codex' : 'claude');

  const canConfig = has('config');

  // The reviewer choice saved by the step below, when it ran: `none` means no review of their pull requests starts.
  let reviewChoice = null;
  if (opts['--skip-reviews']) {
    report('reviews', 'skipped', 'You chose to skip review setup.');
  } else {
    // Every repo is reviewed by default, on a tag in a commit's message (console/defaultReview.mjs): this checks the
    // console can run it, and says the tag. No checkout and no pull request.
    const levels = 'Your reviewer choice controls who reviews your pull requests.';
    const canReview = has('review');
    if (!canReview) report('repo-review', 'skipped', `This CLI has no review command yet. ${levels}`);
    else if (!selected.length) report('repo-review', 'skipped', `Woodshed reviews a pull request at a commit whose message has [woodshed-review]: ${command('review', 'status', '--repo', 'owner/name')} says whether it can for a repo. ${levels}`);
    else {
      for (const repo of selected) {
        const state = await call('review status', 'review', 'status', '--repo', repo);
        const info = state.last;
        const review = info?.review ?? null;
        if (state.code === EXIT.done && info?.on === true) {
          const how = review?.rerun
            ? `put ${printable(review.rerun)} in a commit’s message on a pull request, and Woodshed reviews it at that commit (your sessions add it for you)`
            : 'Woodshed reviews each new commit of a pull request';
          report('repo-review', 'done', `Review is on for ${repo}: ${how}. ${levels}`, { repo, ...(review?.rerun ? { tag: review.rerun } : {}) });
          continue;
        }
        // The repo's own project file reviews in GitHub Actions: on already, as the repo chose.
        if (review?.runner && review.runner !== 'woodshed' && state.code === EXIT.waiting) {
          report('repo-review', 'done', `${repo}’s project file reviews its pull requests in GitHub Actions. ${levels}`, { repo });
          continue;
        }
        // A repo whose runsOn names another console: that console runs its reviews, so nothing here is missing for it.
        const missing = Array.isArray(info?.missing) ? info.missing : [];
        if (state.code === EXIT.waiting && missing.length && missing.every((item) => item?.key === 'runs-on')) {
          report('repo-review', 'done', `${repo}’s reviews run on another console, as its project file’s runsOn says. ${levels}`, { repo });
          continue;
        }
        if (state.code === EXIT.waiting && missing.length) {
          const url = linkTo(info.console?.reviewerApp?.installUrl, origin, true);
          const steps = info.missing.map((item) => printable(item?.step)).filter(Boolean);
          return stop('repo-review', EXIT.waiting, `For Woodshed to review ${repo}’s pull requests: ${steps.join(' ')} Then run setup again.`, { repo, ...(url ? { url } : {}) });
        }
        const reason = printable(info?.console?.defaultBranch?.error) || printable(info?.unasked);
        return childError('repo-review', state, reason || `Could not check review for ${repo}.`, { repo });
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
    // With several repos, a bare number could be a pull request of yours on more than one: each must name its repo.
    const bare = (opts['--review-prs'] ?? '').split(',').map((w) => w.trim()).filter((w) => /^#?\d+$/.test(w));
    if (selected.length > 1 && bare.length) {
      return stop('pr-reviews', EXIT.waiting, `With several repos, name each pull request's repo in --review-prs, as ${selected[0]}#${bare[0].replace(/^#/, '')}: ${bare.join(', ')} could be yours on more than one of ${selected.join(', ')}.`);
    }
    for (const repo of selected) {
      const listed = await call('review pulls', 'review', 'pulls', '--repo', repo);
      const found = listed.events.find((event) => event.event === 'pulls');
      if (listed.code !== EXIT.done || !Array.isArray(found?.pulls)) return childError('pr-reviews', listed, `Could not list your open pull requests on ${repo}.`, { repo });
      const pulls = found.pulls.filter((p) => Number.isSafeInteger(p?.number));
      const rerun = printable(found.review?.rerun);
      const staleText = found.stale === true ? ' GitHub did not answer just now, so this list may be out of date: run setup again to check.' : '';
      // Every repo is reviewed, by its project file's review or the console's default: none starts only where the file
      // names another runner, or its runsOn another console.
      const offWhy = printable(found.review?.why);
      if (found.review?.on === false && offWhy) {
        report('pr-reviews', 'skipped', `No review starts here: ${offWhy}.`, { repo });
        continue;
      }
      const next = rerun
        ? `a review starts on your next one when its last commit's subject ends with ${rerun} (a Woodshed session adds it itself; on your own computer, add it to the subject)`
        : 'a review starts on its every new commit';
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
