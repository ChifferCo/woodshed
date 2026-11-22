import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setupCommand } from './setup.mjs';
import { EXIT } from './woodshed.mjs';

const origin = 'https://console.example';
const ready = { signedIn: true, login: 'mia-dev', sessionSignIns: { claude: true, codex: true }, hc: { ok: true } };
const repo = 'acme/app';
const globals = ['--console', origin, '--json'];
const noBrowser = [...globals, '--no-browser'];
const help = (commands) => ({ code: 0, stdout: commands.map((command) => `  ${command}     help`).join('\n') });
const result = (code, ...events) => ({ code, stdout: events.map((event) => JSON.stringify(event)).join('\n') });

function fake({
  commands = [], answers = {}, here = null, checkouts = {}, browser = false, json = true, tty = false, input = [],
} = {}) {
  const events = [];
  const lines = [];
  const calls = [];
  const opened = [];
  const questions = [];
  const cwd = path.resolve('fake-checkout');
  const run = async (args) => {
    const prefix = browser ? globals : noBrowser;
    assert.deepEqual(args.slice(0, prefix.length), prefix);
    const words = args.slice(prefix.length);
    calls.push(words);
    if (words[0] === '--help') return help(commands);
    const command = words[0] === 'login' || words[0] === 'status' ? words[0] : words.slice(0, 2).join(' ');
    if (answers[command]) return answers[command];
    if (command === 'status') return result(0, ready);
    if (command === 'config get') return result(0, { key: 'terminal', value: 'tmux' });
    return { code: 99, stdout: '' };
  };
  const invoke = async (...args) => {
    const code = await setupCommand({ origin, args, rest: null, json, browser }, {
      EXIT, emit: (event) => events.push(event), say: (line) => lines.push(line), fail: (message) => new Error(message),
      stderr: { write: (line) => lines.push(line) },
      cwd, run, open: (url) => opened.push(url), tty, platform: 'test',
      ask: async (question) => {
        questions.push(question);
        return input.shift() ?? null;
      },
      repoOf: (dir) => checkouts[dir] ?? (dir === cwd ? here : null),
    });
    return { code, events, lines, calls, opened, questions };
  };
  return { invoke };
}

test('setup hands off browser approval with the code and does no more work', async () => {
  const url = `${origin}/cli?code=BCDF-GHJK`;
  const { invoke } = fake({ answers: {
    status: result(2, { signedIn: false }),
    login: result(2, { event: 'code', userCode: 'BCDF-GHJK', verificationUrlComplete: url }),
  } });
  const after = await invoke('--yes', '--repo', repo);
  assert.equal(after.code, 2);
  assert.deepEqual(after.calls, [['status'], ['login', '--no-wait']]);
  assert.deepEqual(after.events.map(({ step, status, userCode, url }) => ({
    step, status, userCode, url,
  })), [{ step: 'login', status: 'needs-you', userCode: 'BCDF-GHJK', url }]);
});

test('setup shows repo choices without asking when --yes is set even on a terminal', async () => {
  const { invoke } = fake({ commands: ['repo'], tty: true, answers: {
    'repo list': result(0, { projects: [{ repo }], available: [{ repo: 'acme/lib' }] }),
  } });
  const after = await invoke('--yes');
  assert.equal(after.code, 2);
  assert.equal(after.questions.length, 0);
  assert.deepEqual(after.events.at(-1).repos, [{ repo, added: true }, { repo: 'acme/lib', added: false }]);
  assert.deepEqual(after.calls.at(-1), ['repo', 'list']);
});

test('setup skips repos already added and stops at the GitHub App install link', async () => {
  const url = 'https://github.com/apps/acme-woodshed/installations/new';
  const { invoke } = fake({ commands: ['repo', 'review'], answers: {
    'repo list': result(0, { projects: [{ repo: 'Acme/App' }], available: [{ repo: 'acme/lib' }] }),
    'repo add': result(2, { event: 'error', status: 'needs-github-app', url }),
  } });
  const after = await invoke('--yes', '--repo', repo, '--repo', 'acme/lib');
  assert.equal(after.code, 2);
  assert.deepEqual(after.calls.slice(2), [['repo', 'list'], ['repo', 'add', 'acme/lib']]);
  assert.equal(after.events.at(-1).url, url);
  assert.ok(after.events.at(-1).message.includes(`--repo ${repo} --repo acme/lib`));
});

test('setup does not treat a repo refusal as a browser handoff', async () => {
  const { invoke } = fake({ commands: ['repo'], answers: {
    'repo list': result(0, { projects: [], available: [] }),
    'repo add': result(3, { event: 'error', error: 'Only an admin can add repos.' }),
  } });
  const after = await invoke('--yes', '--repo', repo);
  assert.equal(after.code, 3);
  assert.equal(after.events.at(-1).message, 'Only an admin can add repos.');
});

test('setup opens My settings for a missing session sign-in and respects --no-browser', async () => {
  for (const browser of [true, false]) {
    const { invoke } = fake({ browser, answers: { status: result(0, { ...ready, sessionSignIns: { claude: false, codex: false } }) } });
    const after = await invoke('--yes');
    assert.equal(after.code, 2);
    assert.deepEqual(after.opened, browser ? [`${origin}/settings`] : []);
    assert.equal(after.events.at(-1).url, `${origin}/settings`);
    assert.equal(after.events.at(-1).step, 'agent');
  }
});

test('the agent sign-in handoff keeps interactive repo choices in order', async () => {
  const { invoke } = fake({ commands: ['repo'], tty: true, input: ['acme/lib, acme/app'], answers: {
    status: result(0, { ...ready, sessionSignIns: { claude: false, codex: false } }),
    'repo list': result(0, { projects: [{ repo }, { repo: 'acme/lib' }], available: [] }),
  } });
  const after = await invoke();
  assert.equal(after.code, EXIT.waiting);
  assert.match(after.events.at(-1).message, /rerun setup with --repo acme\/lib --repo acme\/app/);
});

test('setup checks review in each checkout and tells the person where to open the project file PR', async () => {
  const lib = path.resolve('some checkout');
  const { invoke } = fake({ commands: ['review'], here: repo, checkouts: { [lib]: 'Acme/Lib' }, answers: {
    'review status': result(2, { on: false }),
    'review enable': result(0, { event: 'enable', written: true, console: { defaultBranch: { review: null } }, missing: [] }),
  } });
  const after = await invoke('--yes', '--repo', 'acme/lib', '--repo', repo, '--repo-dir', lib, '--no-session');
  assert.equal(after.code, 0);
  const checkouts = [lib, path.resolve('fake-checkout')];
  assert.deepEqual(after.calls.slice(-4), checkouts.flatMap((dir) => [['review', 'status', '--dir', dir], ['review', 'enable', '--dir', dir]]));
  const reviews = after.events.filter((entry) => entry.step === 'repo-review');
  assert.deepEqual(reviews.map((entry) => entry.url), ['https://github.com/acme/lib/pulls', `https://github.com/${repo}/pulls`]);
  assert.match(reviews[0].message, /Open a pull request for \.woodshed\/project.yaml/);
});

test('setup prints the review command for a repo with no checkout', async () => {
  const { invoke } = fake({ commands: ['review'] });
  const after = await invoke('--yes', '--repo', repo, '--no-session');
  assert.equal(after.code, 0);
  const skipped = after.events.find((entry) => entry.step === 'repo-review');
  assert.equal(skipped.status, 'skipped');
  assert.match(skipped.message, /woodshed review enable --console "https:\/\/console.example"/);
  assert.deepEqual(after.calls, [['status'], ['--help']]);
});

test('setup passes through reviewer App readiness and its install link', async () => {
  const url = 'https://github.com/apps/acme-reviewer/installations/new';
  const { invoke } = fake({ commands: ['review'], here: repo, answers: {
    'review status': result(2, { on: false }),
    'review enable': result(2, { event: 'enable', missing: [{ key: 'reviewer-installed', step: 'An owner installs the reviewer App.' }],
      console: { reviewerApp: { installed: false, installUrl: url } } }),
  } });
  const after = await invoke('--yes', '--repo', repo);
  assert.equal(after.code, 2);
  assert.equal(after.events.at(-1).url, url);
  assert.match(after.events.at(-1).message, /An owner installs the reviewer App/);
});

test('setup skips already enabled reviews, applies a changed personal choice and starts the session with hc', async () => {
  const url = `${origin}/s/12345678`;
  const lib = path.resolve('other-checkout');
  const { invoke } = fake({ commands: ['repo', 'review', 'config'], here: repo, checkouts: { [lib]: 'acme/lib' }, answers: {
    'repo list': result(0, { projects: [{ repo }, { repo: 'acme/lib' }], available: [] }),
    'review status': result(0, { on: true }),
    'config get': result(0, { key: 'terminal', value: 'herdr' }),
    'config list': result(0, { config: { reviews: 'default' } }),
    'config set': result(0, { event: 'set', key: 'reviews', value: 'both' }),
    'session list': result(0, { sessions: [] }),
    'session new': result(0, { event: 'connected', session: { id: '12345678', url } }),
  } });
  const after = await invoke('--yes', '--repo', repo, '--repo', 'acme/lib', '--repo-dir', lib, '--reviews', 'both', '--prompt=-v is broken');
  assert.equal(after.code, 0);
  assert.deepEqual(after.calls.slice(3), [
    ['review', 'status', '--dir', path.resolve('fake-checkout')], ['review', 'status', '--dir', lib],
    ['config', 'list'], ['config', 'set', 'reviews', 'both'], ['config', 'get', 'terminal'], ['session', 'list'],
    ['session', 'new', '--herdr', '--repo', repo, '--agent', 'claude', '--', '-v is broken'],
  ]);
  assert.equal(after.events.at(-1).url, url);
});

test('setup skips subcommands absent from this build and launches normally without hc using the saved agent', async () => {
  const { invoke } = fake({ answers: {
    status: result(0, { ...ready, hc: { ok: false }, sessionSignIns: { codex: true, claude: false } }),
    'session list': result(0, { sessions: [] }),
    'session new': result(2, { event: 'needs-you', session: { url: `${origin}/s/12345678` } }),
  } });
  const after = await invoke('--yes', '--repo', repo, '--agent', 'codex', '--prompt', 'Fix it.');
  assert.equal(after.code, 2);
  assert.deepEqual(after.events.filter((event) => event.status === 'skipped').map((event) => event.step), ['repos', 'repo-review', 'review-choice', 'pr-reviews', 'terminal']);
  assert.deepEqual(after.calls.at(-1), ['session', 'new', '--repo', repo, '--agent', 'codex', '--', 'Fix it.']);
  assert.equal(after.events.at(-1).url, `${origin}/s/12345678`);
});

test('setup does not start another environment on rerun', async () => {
  const { invoke } = fake({ commands: ['config'], answers: {
    'config list': result(0, { config: { reviews: 'codex' } }),
    'session list': result(0, { sessions: [{ mine: true, repo, state: 'paused', url: `${origin}/s/12345678` }] }),
  } });
  const after = await invoke('--yes', '--repo', repo, '--prompt', 'Fix it.', '--reviews', 'codex');
  assert.equal(after.code, 0);
  assert.deepEqual(after.calls.slice(-3), [['config', 'list'], ['config', 'get', 'terminal'], ['session', 'list']]);
  assert.match(after.events.at(-1).message, /already have a session/);
  assert.match(after.events.at(-1).message, /woodshed session new/);
});

test('without repo selection, setup asks before reusing a session from a previous default repo', async () => {
  const oldUrl = `${origin}/s/abcdef01`;
  const { invoke } = fake({ commands: ['config'], answers: {
    'config list': result(0, { config: { reviews: 'codex', 'default-repo': 'new' } }),
    'session list': result(0, { sessions: [{ mine: true, repo: 'acme/old', state: 'paused', url: oldUrl }] }),
    'session new': result(0, { event: 'running', session: { id: '12345678', url: `${origin}/s/12345678` } }),
  } });
  const after = await invoke('--yes', '--reviews', 'codex', '--prompt', 'Fix the new repo.');
  assert.equal(after.code, EXIT.waiting);
  assert.match(after.events.at(-1).message, /--repo owner\/name/);
  assert.equal(after.events.at(-1).url, undefined);
  assert.deepEqual(after.calls.at(-1), ['session', 'list']);
  const next = await invoke('--yes', '--repo', 'acme/new', '--reviews', 'codex', '--prompt', 'Fix the new repo.');
  assert.equal(next.code, EXIT.done);
  assert.deepEqual(next.calls.at(-1), ['session', 'new', '--repo', 'acme/new', '--agent', 'claude', '--', 'Fix the new repo.']);
});

test('a connection failure after launch gives the command to reconnect to that session', async () => {
  const session = { id: '12345678', url: `${origin}/s/12345678` };
  const { invoke } = fake({ answers: {
    'session list': result(0, { sessions: [] }),
    'session new': result(1, { event: 'running', session }, { event: 'error', error: 'Could not connect.' }),
  } });
  const after = await invoke('--yes', '--skip-reviews', '--repo', repo, '--prompt', 'Fix the redirect.');
  assert.equal(after.code, 1);
  const last = after.events.at(-1);
  assert.match(last.message, /Could not connect/);
  assert.equal(last.url, session.url);
  assert.equal(last.retry, `woodshed session herdr 12345678 --console "${origin}"`);
});

test('setup in agent mode asks for the reviewer choice when config is available', async () => {
  const { invoke } = fake({ commands: ['config'], tty: true, answers: {
    'config list': result(0, { config: { reviews: 'default' } }),
  } });
  const after = await invoke('--yes', '--no-session');
  assert.equal(after.code, 2);
  assert.equal(after.questions.length, 0);
  assert.equal(after.events.at(-1).step, 'review-choice');
  assert.match(after.events.at(-1).message, /Current choice: default/);
});

test('setup asks on a terminal and can keep personal choices and skip starting a session', async () => {
  const { invoke } = fake({ json: false, tty: true, input: [repo, '', '', ''], commands: ['repo', 'config'], answers: {
    'repo list': result(0, { projects: [{ repo }], available: null }),
    'config list': result(0, { config: { reviews: 'default' } }),
    'session list': result(0, { sessions: [] }),
  } });
  const after = await invoke();
  assert.equal(after.code, 0);
  assert.match(after.lines[1], /Repos on https:\/\/console\.example: acme\/app \(added\)/);
  assert.match(after.lines.at(-1), /^\[skipped\]/);
  assert.equal(after.questions.length, 4);
  assert.match(after.questions[1], /Who should review your pull requests/);
  assert.match(after.questions[2], /Herdr or tmux.*Enter keeps tmux/);
  assert.match(after.questions[3], /^Optional: start a coding session/);
  assert.ok(!after.calls.some(([group, sub]) => group === 'config' && sub === 'set'));
  assert.deepEqual(after.calls.slice(-3), [['config', 'list'], ['config', 'get', 'terminal'], ['session', 'list']]);
});

test('setup saves the interactive Herdr choice before starting and attaching the first session', async () => {
  const session = { id: '12345678', url: `${origin}/s/12345678` };
  const { invoke } = fake({ tty: true, input: ['Herdr'], commands: ['config'], answers: {
    'config set': result(0, { event: 'set', key: 'terminal', value: 'herdr' }),
    'session list': result(0, { sessions: [] }),
    'session new': result(0, { event: 'connected', session }),
  } });
  const after = await invoke('--skip-reviews', '--repo', repo, '--prompt', 'Fix the redirect.');
  assert.equal(after.code, EXIT.done);
  assert.deepEqual(after.calls.slice(-4), [
    ['config', 'get', 'terminal'], ['config', 'set', 'terminal', 'herdr'], ['session', 'list'],
    ['session', 'new', '--herdr', '--repo', repo, '--agent', 'claude', '--', 'Fix the redirect.'],
  ]);
});

test('setup accepts a terminal choice in agent mode even without a first session', async () => {
  const { invoke } = fake({ tty: true, commands: ['config'], answers: {
    'config get': result(0, { key: 'terminal', value: 'herdr' }),
    'config set': result(0, { event: 'set', key: 'terminal', value: 'tmux' }),
  } });
  const after = await invoke('--yes', '--terminal', 'tmux', '--skip-reviews', '--no-session');
  assert.equal(after.code, EXIT.done);
  assert.deepEqual(after.calls.slice(-2), [['config', 'get', 'terminal'], ['config', 'set', 'terminal', 'tmux']]);
  assert.deepEqual(after.questions, []);
});

test('setup can start a regular session when an older console has no config endpoint', async () => {
  const { invoke } = fake({ commands: ['config'], answers: {
    'config get': result(1, { event: 'error', status: 'config-unavailable' }),
    'session list': result(0, { sessions: [] }),
    'session new': result(0, { event: 'running', session: { id: '12345678', url: `${origin}/s/12345678` } }),
  } });
  const after = await invoke('--yes', '--skip-reviews', '--repo', repo, '--prompt', 'Fix the redirect.');
  assert.equal(after.code, EXIT.done);
  assert.equal(after.events.find((event) => event.step === 'terminal').status, 'skipped');
  assert.deepEqual(after.calls.at(-1), ['session', 'new', '--repo', repo, '--agent', 'claude', '--', 'Fix the redirect.']);
  const explicit = await invoke('--yes', '--terminal', 'herdr', '--skip-reviews', '--no-session');
  assert.equal(explicit.code, EXIT.waiting);
  assert.match(explicit.events.at(-1).message, /Choose herdr on My settings.*without --terminal/);
});

test('a first coding session is optional: with no prompt setup finishes and says how to start one', async () => {
  const { invoke } = fake({ answers: { 'session list': result(0, { sessions: [] }) } });
  const after = await invoke('--yes', '--skip-reviews');
  assert.equal(after.code, EXIT.done);
  assert.equal(after.events.at(-1).status, 'skipped');
  assert.match(after.events.at(-1).message, /optional.*session new --herdr.*--prompt/);
  assert.ok(!after.calls.some(([group]) => group === 'session'), 'no session list read for a session nobody asked for');
});

test('setup asks for both Claude Code and Codex, and names how to get each sign-in', async () => {
  const { invoke } = fake({ answers: { status: result(0, { ...ready, sessionSignIns: { claude: false, codex: false } }) } });
  const after = await invoke('--yes', '--repo', repo);
  assert.equal(after.code, EXIT.waiting);
  const last = after.events.at(-1);
  assert.equal(last.step, 'agent');
  assert.deepEqual(last.missing, ['claude', 'codex']);
  assert.match(last.message, /Connect Claude Code and Codex on My settings: with both connected, your pull requests get reviews from both/);
  assert.match(last.message, /claude setup-token/);
  assert.match(last.message, /codex login.*~\/\.codex\/auth\.json/);
  assert.match(last.message, /--agent claude or --agent codex/);
  assert.equal(last.url, `${origin}/settings`);
  assert.doesNotMatch(JSON.stringify(after.calls), /token/, 'setup never handles a token');
});

test('setup asks for the one agent missing, and not for the other when the person uses only one', async () => {
  const claudeOnly = { status: result(0, { ...ready, sessionSignIns: { claude: true, codex: false } }) };
  const both = await fake({ answers: claudeOnly }).invoke('--yes', '--repo', repo, '--no-session', '--skip-reviews');
  assert.equal(both.code, EXIT.waiting);
  assert.deepEqual(both.events.at(-1).missing, ['codex']);
  assert.doesNotMatch(both.events.at(-1).message, /claude setup-token/);
  const one = await fake({ answers: claudeOnly }).invoke('--yes', '--repo', repo, '--agent', 'claude', '--no-session', '--skip-reviews');
  assert.equal(one.code, EXIT.done);
  const agent = one.events.find((event) => event.step === 'agent');
  assert.equal(agent.status, 'done');
  assert.match(agent.message, /Claude Code is connected: your pull requests get reviews from Claude Code/);
});

test('on a terminal, setup lets the person answer that they use only one agent', async () => {
  const codexMissing = { status: result(0, { ...ready, sessionSignIns: { claude: true, codex: false } }) };
  const only = await fake({ tty: true, input: ['claude'], answers: codexMissing }).invoke('--repo', repo, '--skip-reviews', '--no-session');
  assert.equal(only.code, EXIT.done);
  assert.match(only.questions[0], /Press Enter for both, or type claude or codex/);
  assert.match(only.lines[0], /with both connected, your pull requests get reviews from both\. Claude Code is connected/);
  const claudeMissing = { status: result(0, { ...ready, sessionSignIns: { claude: false, codex: true } }) };
  const missing = await fake({ tty: true, input: ['claude'], answers: claudeMissing }).invoke('--repo', repo);
  assert.equal(missing.code, EXIT.waiting);
  assert.match(missing.events.at(-1).message, /Connect Claude Code on My settings\. For Claude Code, run claude setup-token.*rerun setup with --repo acme\/app --agent claude/);
  assert.doesNotMatch(missing.events.at(-1).message, /Codex/);
});

const pull = (number, more = {}) => ({ number, title: `Change ${number}`, draft: false, url: `https://github.com/${repo}/pull/${number}`, ...more });
const pullsOn = (pulls, review = { on: true, rerun: '[woodshed-review]', known: true }) => result(0, { event: 'pulls', repo, review, pulls });
const startedFor = (numbers) => result(0, ...numbers.map((number, i) => ({
  event: 'review', repo, number, outcome: 'started', pullUrl: `https://github.com/${repo}/pull/${number}`, session: { id: `0000000${i}`, url: `${origin}/s/0000000${i}` },
})));

test('with --yes, setup reviews the open pull requests updated last, and ends with their links', async () => {
  const pulls = [pull(9), pull(8, { draft: true }), pull(7), pull(6), pull(5), pull(4), pull(3)];
  const { invoke } = fake({ commands: ['review pulls|start'], answers: {
    'review pulls': pullsOn(pulls),
    'review start': startedFor([9, 7, 6, 5, 4]),
  } });
  const after = await invoke('--yes', '--repo', repo, '--no-session');
  assert.equal(after.code, EXIT.done);
  assert.deepEqual(after.calls.find(([group, sub]) => group === 'review' && sub === 'start'), ['review', 'start', '9', '7', '6', '5', '4', '--repo', repo]);
  const step = after.events.find((event) => event.step === 'pr-reviews');
  assert.equal(step.status, 'done');
  assert.equal(step.reviews.length, 5);
  assert.match(step.message, new RegExp(`^Reviews on acme/app: #9 ${origin}/s/00000000, #7`));
  assert.match(step.message, /The 5 updated last; --review-prs all reviews every one/);
  assert.match(step.message, /a review will start on your next one whose commit message has \[woodshed-review\]/);
  const last = after.events.at(-1);
  assert.equal(last.step, 'reviews');
  assert.match(last.message, /^Your reviews: acme\/app#9 https:\/\/console\.example\/s\/00000000/);
});

test('setup asks on a terminal which pull requests to review, and takes numbers', async () => {
  const { invoke } = fake({ tty: true, input: ['7'], commands: ['review pulls|start'], answers: {
    'review pulls': pullsOn([pull(9), pull(7)]),
    'review start': startedFor([7]),
  } });
  const after = await invoke('--repo', repo, '--no-session');
  assert.equal(after.code, EXIT.done);
  assert.match(after.questions.at(-1), /Review which now\? Press Enter for all of them/);
  assert.deepEqual(after.calls.find(([group, sub]) => group === 'review' && sub === 'start'), ['review', 'start', '7', '--repo', repo]);
});

test('in agent mode setup lists the pull requests and asks for --review-prs', async () => {
  const { invoke } = fake({ commands: ['review pulls|start'], answers: { 'review pulls': pullsOn([pull(9)]) } });
  const after = await invoke('--repo', repo, '--no-session');
  assert.equal(after.code, EXIT.waiting);
  assert.equal(after.events.at(-1).step, 'pr-reviews');
  assert.match(after.events.at(-1).message, /--review-prs all, none, or their numbers\. Yours: #9 Change 9/);
  const all = await fake({ commands: ['review pulls|start'], answers: { 'review pulls': pullsOn([pull(9), pull(8, { draft: true })]), 'review start': startedFor([9]) } })
    .invoke('--repo', repo, '--no-session', '--review-prs', 'all');
  assert.equal(all.code, EXIT.done);
  assert.deepEqual(all.calls.find(([group, sub]) => group === 'review' && sub === 'start'), ['review', 'start', '9', '--repo', repo], 'a draft is left for when it is ready');
  const none = await fake({ commands: ['review pulls|start'] }).invoke('--repo', repo, '--no-session', '--review-prs', 'none');
  assert.equal(none.code, EXIT.done);
  assert.ok(!none.calls.some(([group, sub]) => group === 'review' && sub === 'pulls'));
});

test('with no open pull requests, setup says a review starts on the next one; with review off, it starts none', async () => {
  const empty = await fake({ commands: ['review pulls|start'], answers: { 'review pulls': pullsOn([], { on: true, rerun: null, known: true }) } })
    .invoke('--yes', '--repo', repo, '--no-session');
  assert.equal(empty.code, EXIT.done);
  assert.match(empty.events.find((event) => event.step === 'pr-reviews').message, /no open pull requests on acme\/app: a review will start on your next one\.$/);
  const off = await fake({ commands: ['review pulls|start'], answers: { 'review pulls': pullsOn([pull(9)], { on: false, rerun: null, known: true }) } })
    .invoke('--yes', '--repo', repo, '--no-session');
  assert.equal(off.code, EXIT.done);
  const step = off.events.find((event) => event.step === 'pr-reviews');
  assert.equal(step.status, 'skipped');
  assert.match(step.message, /Review is not on for acme\/app yet/);
  assert.ok(!off.calls.some(([group, sub]) => group === 'review' && sub === 'start'));
});

test('a review the console refuses is named, and none started stops setup with the reason', async () => {
  const refused = result(3, { event: 'review', repo, number: 9, outcome: 'refused', pullUrl: `https://github.com/${repo}/pull/9`, error: '#9 is a draft: mark it ready for review first' });
  const after = await fake({ commands: ['review pulls|start'], answers: { 'review pulls': pullsOn([pull(9)]), 'review start': refused } })
    .invoke('--yes', '--repo', repo, '--no-session');
  assert.equal(after.code, EXIT.refused);
  assert.match(after.events.at(-1).message, /No review started on acme\/app\. Not started: #9: #9 is a draft/);
});

test('--review-prs is checked before anything runs', async () => {
  await assert.rejects(fake().invoke('--review-prs', 'some'), /--review-prs must be all, none, or pull request numbers/);
  await assert.rejects(fake().invoke('--review-prs', 'all', '--skip-reviews'), /Choose either --review-prs or --skip-reviews/);
});
