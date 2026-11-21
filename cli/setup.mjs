// The guided path uses the installed CLI's commands, so each step follows the same checks as running it directly.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { repoOf } from '../shared/repoOf.mjs';

export const SETUP_USAGE = `Usage: woodshed setup [--console <url>] [--json] [--no-browser] [options]

  --yes                  use the supplied options without asking questions
  --repo <owner/name>    choose a repository (repeatable, first is used for the session)
  --repo-dir <path>      local checkout for review enable (repeatable, keyed by GitHub origin)
  --reviews <choice>     personal reviewer choice: none, claude, codex, both, default
  --skip-reviews         skip both the project file and your reviewer choice
  --agent <name>         claude or codex (defaults to one already signed in)
  --prompt <text>        what the first session should work on
  --no-session           finish without starting a session

When you need to do something, setup prints what is needed and exits 2. Run it again with the same options after that.`;

const REPO = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/(?!\.{1,2}$)[\w.-]+$/i;
const REVIEW_CHOICES = ['none', 'claude', 'codex', 'both', 'default'];
const key = (repo) => repo.toLowerCase();

function options(args, fail) {
  const out = { repos: [], dirs: [] };
  for (let i = 0; i < args.length; i++) {
    const [name, inline] = args[i].split(/=(.*)/s);
    if (['--yes', '--skip-reviews', '--no-session'].includes(name) && inline === undefined) {
      out[name] = true;
      continue;
    }
    if (!['--repo', '--repo-dir', '--reviews', '--agent', '--prompt'].includes(name)) throw fail(`Unknown setup option ${name}. Run woodshed setup --help.`);
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
  if (out['--skip-reviews'] && out['--reviews']) throw fail('Choose either --reviews or --skip-reviews.');
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
  const command = (...words) => `woodshed ${words.join(' ')} --console '${origin}'`;

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
          const choices = selected.map((name) => `--repo ${name}`).join(' ');
          return stop('repos', EXIT.waiting, `Install the GitHub App for ${repo}, then rerun setup with ${choices}.${url ? '' : ' Ask a console admin for its install link.'}`, { repo, selected, ...(url ? { url } : {}) });
        }
        return childError('repos', addedRepo, `Could not add ${repo}.`, { repo });
      }
    }
    report('repos', 'done', `Selected ${selected.join(', ')}. Repos: ${show}.`, { selected });
  }

  const signIns = me.sessionSignIns;
  const agent = opts['--agent'] ?? (signIns?.codex && !signIns?.claude ? 'codex' : 'claude');
  if (!signIns) {
    report('agent', 'skipped', 'This console does not report agent sign-ins. You can check on My settings.', { url: `${origin}/settings` });
  } else if (signIns[agent] !== true) {
    const url = `${origin}/settings`;
    if (args.browser) open(url);
    return stop('agent', EXIT.waiting, `Connect ${opts['--agent'] ?? 'Claude or Codex'} on My settings, then run setup again.`, { url });
  } else {
    report('agent', 'done', `${agent === 'claude' ? 'Claude' : 'Codex'} is connected for sessions.`, { agent });
  }

  if (opts['--skip-reviews']) {
    report('reviews', 'skipped', 'You chose to skip review setup.');
  } else {
    const levels = 'A repo’s .woodshed/project.yaml enables reviews through a pull request. Your reviewer choice controls who reviews your pull requests.';
    const canReview = has('review');
    const canConfig = has('config');
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
      report('review-choice', 'done', `Your reviewer choice is ${value}.`, { choice: value });
    }
  }

  if (opts['--no-session']) {
    report('session', 'skipped', 'You chose to finish without starting a session.');
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
    const url = linkTo(existing.url, origin);
    if (existing.state === 'needs-you') return stop('session', EXIT.waiting, 'Your session needs your attention.', { url });
    const more = opts['--prompt'] ? ' To start another session with your prompt, use woodshed session new.' : '';
    report('session', 'done', `You already have a session${repo ? ` on ${repo}` : ''}.${more}`, { url });
    return EXIT.done;
  }

  const useHc = me.hc?.ok === true && ctx.platform !== 'win32';
  const newSession = ['session', 'new', ...(useHc ? ['--herdr'] : [])];
  let prompt = opts['--prompt'];
  if (!prompt && choose) {
    prompt = await choose(`Start a session with ${newSession.join(' ')}? Enter a prompt, or press Enter to skip. `);
    if (prompt === '') {
      report('session', 'skipped', 'You chose to finish without starting a session.');
      return EXIT.done;
    }
  }
  if (!prompt) {
    return stop('session', EXIT.waiting, `Give --prompt to start your first environment with ${command(...newSession)}, or use --no-session.`);
  }
  const started = await call('session new', ...newSession, ...(repo ? ['--repo', repo] : []), '--agent', agent, '--', prompt);
  const session = started.events.findLast((event) => event.session)?.session;
  const url = linkTo(session?.url, origin);
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
