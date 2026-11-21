import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setupCommand } from './setup.mjs';
import { EXIT } from './woodshed.mjs';

const origin = 'https://console.example';
const ready = { signedIn: true, login: 'mia-dev', sessionSignIns: { claude: true, codex: false }, hc: { ok: true } };
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
    ['config', 'get', 'terminal'],
    ['review', 'status', '--dir', path.resolve('fake-checkout')], ['review', 'status', '--dir', lib],
    ['config', 'list'], ['config', 'set', 'reviews', 'both'], ['session', 'list'],
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
  const after = await invoke('--yes', '--repo', repo, '--prompt', 'Fix it.');
  assert.equal(after.code, 2);
  assert.deepEqual(after.events.filter((event) => event.status === 'skipped').map((event) => event.step), ['repos', 'terminal', 'repo-review', 'review-choice']);
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
  assert.deepEqual(after.calls.slice(-2), [['config', 'list'], ['session', 'list']]);
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
  assert.match(after.questions[1], /Herdr or tmux.*Enter keeps tmux/);
  assert.ok(!after.calls.some(([group, sub]) => group === 'config' && sub === 'set'));
  assert.deepEqual(after.calls.slice(-2), [['config', 'list'], ['session', 'list']]);
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

test('setup asks for a prompt or --no-session when an agent has no environment yet', async () => {
  const { invoke } = fake({ answers: { 'session list': result(0, { sessions: [] }) } });
  const after = await invoke('--yes', '--skip-reviews');
  assert.equal(after.code, 2);
  assert.match(after.events.at(-1).message, /--prompt.*session new --herdr.*--no-session/);
});
