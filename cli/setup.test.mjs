import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupCommand } from './setup.mjs';
import { EXIT } from './woodshed.mjs';

const origin = 'https://console.example';
const ready = { signedIn: true, login: 'mia-dev', sessionSignIns: { claude: true, codex: true }, hc: { ok: true } };
const repo = 'acme/app';
const globals = ['--console', origin, '--json'];
const noBrowser = [...globals, '--no-browser'];
const help = (commands) => ({ code: 0, stdout: commands.map((command) => `  ${command}     help`).join('\n') });
// The last entry before setup's closing `finished` one, which every run that ends with 0 has.
const lastEntry = (events) => events.findLast((event) => event.step !== 'finished');
const result = (code, ...events) => ({ code, stdout: events.map((event) => JSON.stringify(event)).join('\n') });

// A home with no agent's sign-in file: never this machine's own, whose ~/.grok and OpenCode files no test reads.
const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-setup-home-'));
process.once('exit', () => fs.rmSync(emptyHome, { recursive: true, force: true }));

function fake({
  commands = [], answers = {}, here = null, checkouts = {}, browser = false, json = true, tty = false, input = [], platform = 'test',
  clock = null, env = {}, home = emptyHome,
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
    if (answers[command]) return typeof answers[command] === 'function' ? answers[command]() : answers[command];
    if (command === 'status') return result(0, ready);
    if (command === 'config get') return result(0, { key: 'terminal', value: 'tmux' });
    // Review is on by default (console/defaultReview.mjs), for the tests that are about a later step.
    if (command === 'review status') return result(0, { on: true, review: { runner: 'woodshed', rerun: '[woodshed-review]', from: 'default' }, missing: [] });
    return { code: 99, stdout: '' };
  };
  const invoke = async (...args) => {
    const code = await setupCommand({ origin, args, rest: null, json, browser }, {
      EXIT, emit: (event) => events.push(event), say: (line) => lines.push(line), fail: (message) => new Error(message),
      stderr: { write: (line) => lines.push(line) },
      cwd, run, open: (url) => opened.push(url), tty, platform, env, home,
      // After the calls already answered (setImmediate), as a real timer would be, and not at all once aborted.
      ...(clock ? { now: () => clock.t, sleep: (ms, { signal } = {}) => new Promise((resolve, reject) => setImmediate(() => {
        if (signal?.aborted) return reject(new Error('aborted'));
        clock.slept.push(ms);
        clock.t += ms;
        return resolve();
      })) } : {}),
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
  assert.deepEqual(lastEntry(after.events).repos, [{ repo, added: true }, { repo: 'acme/lib', added: false }]);
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
  assert.equal(lastEntry(after.events).url, url);
  assert.ok(lastEntry(after.events).message.includes(`--repo ${repo} --repo acme/lib`));
});

test('setup does not treat a repo refusal as a browser handoff', async () => {
  const { invoke } = fake({ commands: ['repo'], answers: {
    'repo list': result(0, { projects: [], available: [] }),
    'repo add': result(3, { event: 'error', error: 'Only an admin can add repos.' }),
  } });
  const after = await invoke('--yes', '--repo', repo);
  assert.equal(after.code, 3);
  assert.equal(lastEntry(after.events).message, 'Only an admin can add repos.');
});

test('setup opens My settings for a missing session sign-in and respects --no-browser', async () => {
  for (const browser of [true, false]) {
    const { invoke } = fake({ browser, answers: { status: result(0, { ...ready, sessionSignIns: { claude: false, codex: false } }) } });
    const after = await invoke('--yes');
    assert.equal(after.code, 2);
    assert.deepEqual(after.opened, browser ? [`${origin}/settings#claude`] : [], 'opens My settings at the first row to fill');
    assert.equal(lastEntry(after.events).url, `${origin}/settings#claude`);
    assert.equal(lastEntry(after.events).step, 'agent');
  }
});

test('the agent sign-in handoff keeps interactive repo choices in order', async () => {
  const { invoke } = fake({ commands: ['repo'], tty: true, input: ['acme/lib, acme/app'], answers: {
    status: result(0, { ...ready, sessionSignIns: { claude: false, codex: false } }),
    'repo list': result(0, { projects: [{ repo }, { repo: 'acme/lib' }], available: [] }),
  } });
  const after = await invoke();
  assert.equal(after.code, EXIT.waiting);
  assert.match(lastEntry(after.events).message, /rerun setup with --repo acme\/lib --repo acme\/app/);
});

test('setup checks each repo\'s review with no checkout or pull request, and tells the person the tag', async () => {
  const { invoke } = fake({ commands: ['review'], answers: {
    'review status': result(0, { repo, on: true, review: { runner: 'woodshed', rerun: '[woodshed-review]', from: 'default' }, missing: [] }),
  } });
  const after = await invoke('--yes', '--repo', 'acme/lib', '--repo', repo, '--no-session');
  assert.equal(after.code, 0);
  assert.deepEqual(after.calls.slice(-2), [['review', 'status', '--repo', 'acme/lib'], ['review', 'status', '--repo', repo]]);
  const reviews = after.events.filter((entry) => entry.step === 'repo-review');
  assert.deepEqual(reviews.map((entry) => [entry.status, entry.repo, entry.tag]), [['done', 'acme/lib', '[woodshed-review]'], ['done', repo, '[woodshed-review]']]);
  assert.match(reviews[0].message, /^Review is on for acme\/lib: put \[woodshed-review\] in a commit’s message on a pull request, and Woodshed reviews it at that commit \(your sessions add it for you\)\./);
  await assert.rejects(invoke('--yes', '--repo-dir', 'x'), /Unknown setup option --repo-dir/, 'no checkout is needed any more');
});

test('setup goes on past a repo whose project file reviews in GitHub Actions, even with no reviewer App', async () => {
  const actions = fake({ commands: ['review'], answers: {
    'review status': result(2, { repo, on: false, review: { runner: 'actions', rerun: null, from: 'project file' }, missing: [{ key: 'reviewer-app', step: 'An admin makes the reviewer App.' }] }),
  } });
  const after = await actions.invoke('--yes', '--repo', repo, '--no-session');
  assert.equal(after.code, 0);
  const step = after.events.find((entry) => entry.step === 'repo-review');
  assert.equal(step.status, 'done');
  assert.match(step.message, /acme\/app’s project file reviews its pull requests in GitHub Actions/);
});

test('setup goes on past a repo whose runsOn names another console', async () => {
  const elsewhere = fake({ commands: ['review'], answers: {
    'review status': result(2, { repo, on: false, review: { runner: 'woodshed', rerun: null, from: 'project file' }, missing: [{ key: 'runs-on', step: 'The default branch\'s pullRequests.runsOn names other[bot].' }] }),
  } });
  const after = await elsewhere.invoke('--yes', '--repo', repo, '--no-session');
  assert.equal(after.code, 0);
  assert.match(after.events.find((entry) => entry.step === 'repo-review').message, /acme\/app’s reviews run on another console/);
});

test('setup says the tag when no repo was chosen', async () => {
  const { invoke } = fake({ commands: ['review'] });
  const after = await invoke('--yes', '--no-session');
  assert.equal(after.code, 0);
  const skipped = after.events.find((entry) => entry.step === 'repo-review');
  assert.equal(skipped.status, 'skipped');
  assert.match(skipped.message, /\[woodshed-review\]: woodshed review status --repo owner\/name --console "https:\/\/console.example"/);
  assert.deepEqual(after.calls, [['status'], ['--help']]);
});

test('setup passes through reviewer App readiness and its install link', async () => {
  const url = 'https://github.com/apps/acme-reviewer/installations/new';
  const { invoke } = fake({ commands: ['review'], answers: {
    'review status': result(2, { repo, on: false, review: { runner: 'woodshed', rerun: '[woodshed-review]', from: 'default' }, missing: [{ key: 'reviewer-installed', step: 'An owner installs the reviewer App.' }],
      console: { reviewerApp: { installed: false, installUrl: url } } }),
  } });
  const after = await invoke('--yes', '--repo', repo);
  assert.equal(after.code, 2);
  assert.equal(lastEntry(after.events).url, url);
  assert.match(lastEntry(after.events).message, /An owner installs the reviewer App/);
});

test('setup skips already enabled reviews, applies a changed personal choice and starts the session with hc', async () => {
  const url = `${origin}/s/12345678`;
  const { invoke } = fake({ commands: ['repo', 'review', 'config'], answers: {
    'repo list': result(0, { projects: [{ repo }, { repo: 'acme/lib' }], available: [] }),
    'review status': result(0, { on: true, review: { runner: 'woodshed', rerun: '[woodshed-review]', from: 'default' }, missing: [] }),
    'config get': result(0, { key: 'terminal', value: 'herdr' }),
    'config list': result(0, { config: { reviews: 'default' } }),
    'config set': result(0, { event: 'set', key: 'reviews', value: 'both' }),
    'session list': result(0, { sessions: [] }),
    'session watch': result(0, { event: 'herdr', action: 'started', terminal: 'woodshed-watch', add: true }),
    'session new': result(0, { event: 'connected', session: { id: '12345678', url } }),
  } });
  const after = await invoke('--yes', '--repo', repo, '--repo', 'acme/lib', '--reviews', 'both', '--prompt=-v is broken');
  assert.equal(after.code, 0);
  assert.deepEqual(after.calls.slice(3), [
    ['review', 'status', '--repo', repo], ['review', 'status', '--repo', 'acme/lib'],
    ['config', 'list'], ['config', 'set', 'reviews', 'both'], ['config', 'get', 'terminal'], ['session', 'watch', '--herdr', '--add'], ['session', 'list'],
    ['session', 'new', '--herdr', '--repo', repo, '--agent', 'claude', '--', '-v is broken'],
  ]);
  assert.equal(lastEntry(after.events).url, url);
});

test('setup takes a combined reviewer choice from --reviews, and reads a saved one back without refusing it', async () => {
  // A saved grok+opencode, changed to claude+grok from the flag: sent on as given.
  const { invoke } = fake({ commands: ['config'], answers: {
    'config list': result(0, { config: { reviews: 'grok+opencode' } }),
    'config set': result(0, { event: 'set', key: 'reviews', value: 'claude+grok' }),
  } });
  const changed = await invoke('--yes', '--reviews', 'claude+grok', '--no-session');
  assert.equal(changed.code, 0);
  assert.deepEqual(changed.calls.filter((call) => call[0] === 'config' && call[1] !== 'get'), [['config', 'list'], ['config', 'set', 'reviews', 'claude+grok']]);
  const saved = changed.events.find((event) => event.step === 'review-choice');
  assert.deepEqual([saved.status, saved.choice], ['done', 'claude+grok']);

  // The same saved choice, kept: nothing is set, and it is not taken for an unreadable one.
  const kept = await fake({ commands: ['config'], answers: { 'config list': result(0, { config: { reviews: 'grok+opencode' } }) } })
    .invoke('--yes', '--reviews', 'grok+opencode', '--no-session');
  assert.equal(kept.code, 0);
  assert.ok(!kept.calls.some((call) => call[1] === 'set'), 'an unchanged choice is not saved again');
  const step = kept.events.find((event) => event.step === 'review-choice');
  assert.equal(step.status, 'done');
  assert.equal(step.choice, 'grok+opencode');

  // On a terminal, Enter keeps the saved combination, and the question names + choices.
  const asked = await fake({ commands: ['config'], tty: true, input: [''], answers: { 'config list': result(0, { config: { reviews: 'claude+opencode' } }) } })
    .invoke('--no-session');
  const question = asked.questions.find((q) => /Who should review/.test(q));
  assert.match(question, /joined with \+ \(claude\+grok\)\)\? Enter keeps claude\+opencode\./);
  assert.equal(asked.events.find((event) => event.step === 'review-choice').choice, 'claude+opencode');
});

test('setup refuses a combined reviewer choice that names a reviewer twice or one that does not review', async () => {
  for (const bad of ['claude+claude', 'grok+nope', 'claude+', '+grok', 'both+grok']) {
    await assert.rejects(fake().invoke('--yes', '--reviews', bad), /--reviews must be one of none, claude, codex, both, default, or reviewers joined with \+ \(claude\+grok\)\./, bad);
  }
  // A saved choice it cannot read is setup's own failure, never taken as the new one.
  const { invoke } = fake({ commands: ['config'], answers: { 'config list': result(0, { config: { reviews: 'grok+grok' } }) } });
  const after = await invoke('--yes', '--reviews', 'claude+grok', '--no-session');
  assert.notEqual(after.code, 0);
  assert.ok(!after.calls.some((call) => call[1] === 'set'));
  assert.match(after.events.find((event) => event.step === 'review-choice').message, /Could not read your reviewer choice/);
});

test('setup skips subcommands absent from this build and launches normally without hc using the saved agent', async () => {
  const { invoke } = fake({ answers: {
    status: result(0, { ...ready, hc: { ok: false }, sessionSignIns: { codex: true, claude: false } }),
    'session list': result(0, { sessions: [] }),
    'session new': result(2, { event: 'needs-you', session: { url: `${origin}/s/12345678` } }),
  } });
  const after = await invoke('--yes', '--repo', repo, '--agent', 'codex', '--prompt', 'Fix it.');
  assert.equal(after.code, 2);
  assert.deepEqual(after.events.filter((event) => event.status === 'skipped').map((event) => event.step), ['repos', 'own-agents', 'repo-review', 'review-choice', 'pr-reviews', 'terminal']);
  assert.deepEqual(after.calls.at(-1), ['session', 'new', '--repo', repo, '--agent', 'codex', '--', 'Fix it.']);
  assert.equal(lastEntry(after.events).url, `${origin}/s/12345678`);
});

test('setup does not start another environment on rerun', async () => {
  const { invoke } = fake({ commands: ['config'], answers: {
    'config list': result(0, { config: { reviews: 'codex' } }),
    'session list': result(0, { sessions: [{ mine: true, repo, state: 'paused', url: `${origin}/s/12345678` }] }),
  } });
  const after = await invoke('--yes', '--repo', repo, '--prompt', 'Fix it.', '--reviews', 'codex');
  assert.equal(after.code, 0);
  assert.deepEqual(after.calls.slice(-3), [['config', 'list'], ['config', 'get', 'terminal'], ['session', 'list']]);
  assert.match(lastEntry(after.events).message, /already have a session/);
  assert.match(lastEntry(after.events).message, /woodshed session new/);
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
  assert.match(lastEntry(after.events).message, /--repo owner\/name/);
  assert.equal(lastEntry(after.events).url, undefined);
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
  const last = lastEntry(after.events);
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
  assert.equal(lastEntry(after.events).step, 'review-choice');
  assert.match(lastEntry(after.events).message, /Current choice: default/);
});

test('setup asks on a terminal and can keep personal choices and skip starting a session', async () => {
  const { invoke } = fake({ json: false, tty: true, input: [repo, '', '', ''], commands: ['repo', 'config'], answers: {
    'repo list': result(0, { projects: [{ repo }], available: null }),
    'config list': result(0, { config: { reviews: 'default' } }),
    'session list': result(0, { sessions: [] }),
  } });
  const after = await invoke();
  assert.equal(after.code, 0);
  assert.ok(after.lines.some((line) => /^Repos on https:\/\/console\.example: acme\/app \(added\)/.test(line)));
  assert.match(after.lines.at(-3), /^\[skipped\] You chose to finish without starting a session/);
  assert.equal(after.lines.at(-1), '[done] Setup is finished. Run woodshed setup again any time to change a choice.');
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
    'session watch': result(0, { event: 'herdr', action: 'started', terminal: 'woodshed-watch', add: true }),
    'session new': result(0, { event: 'connected', session }),
  } });
  const after = await invoke('--skip-reviews', '--repo', repo, '--prompt', 'Fix the redirect.');
  assert.equal(after.code, EXIT.done);
  assert.deepEqual(after.calls.slice(-5), [
    ['config', 'get', 'terminal'], ['config', 'set', 'terminal', 'herdr'], ['session', 'watch', '--herdr', '--add'], ['session', 'list'],
    ['session', 'new', '--herdr', '--repo', repo, '--agent', 'claude', '--', 'Fix the redirect.'],
  ]);
});

test('setup --terminal herdr starts the watch that adds each session to Herdr, and says so; --no-herdr-add starts it without', async () => {
  const watched = result(0, { event: 'herdr', action: 'started', terminal: 'woodshed-watch', address: 't3', add: true });
  const { invoke } = fake({ commands: ['config'], answers: {
    'config get': result(0, { key: 'terminal', value: 'herdr' }),
    'session watch': watched,
  } });
  const after = await invoke('--yes', '--terminal', 'herdr', '--skip-reviews', '--no-session');
  assert.equal(after.code, EXIT.done);
  assert.deepEqual(after.calls.slice(-2), [['config', 'get', 'terminal'], ['session', 'watch', '--herdr', '--add']]);
  const step = after.events.find((event) => event.step === 'herdr-watch');
  assert.equal(step.status, 'done');
  assert.equal(step.add, true);
  assert.match(step.message, /Each of your private sessions is added to Herdr's sidebar as it starts or resumes, wherever it was started/);
  assert.match(step.message, /hc terminal woodshed-watch runs woodshed session watch --herdr --add --console "https:\/\/console\.example"/);
  assert.match(step.message, /hc kill woodshed-watch, or rerun setup with --no-herdr-add/);

  const off = await invoke('--yes', '--terminal', 'herdr', '--no-herdr-add', '--skip-reviews', '--no-session');
  assert.equal(off.code, EXIT.done);
  assert.deepEqual(off.calls.at(-1), ['session', 'watch', '--herdr']);
  assert.equal(off.events.findLast((event) => event.step === 'herdr-watch').add, false);

  // One already running is kept as it was started, and setup says how to have it add sessions.
  const { invoke: again } = fake({ commands: ['config'], answers: {
    'config get': result(0, { key: 'terminal', value: 'herdr' }),
    'session watch': result(0, { event: 'herdr', action: 'kept', terminal: 'woodshed-watch', add: true }),
  } });
  const kept = await again('--yes', '--terminal', 'herdr', '--skip-reviews', '--no-session');
  assert.match(kept.events.find((event) => event.step === 'herdr-watch').message, /already runs.*started without --add, run hc kill woodshed-watch/);

  // tmux: no watch.
  const { invoke: onTmux } = fake({ commands: ['config'], answers: { 'config set': result(0, { event: 'set', key: 'terminal', value: 'tmux' }) } });
  const tmux = await onTmux('--yes', '--terminal', 'tmux', '--skip-reviews', '--no-session');
  assert.equal(tmux.code, EXIT.done);
  assert.ok(!tmux.calls.some(([group, sub]) => group === 'session' && sub === 'watch'));
});

test('setup inside a Woodshed session adds nothing to Herdr: no watch and no --herdr, and says to run the watch on the computer', async () => {
  const { invoke } = fake({ commands: ['config'], env: { SESSION_ID: 'abcd1234', WOODSHED_TERMINAL: 'herdr', HC_TERMINAL_ID: 't1' }, answers: {
    'config get': result(0, { key: 'terminal', value: 'herdr' }),
    'session list': result(0, { sessions: [] }),
    'session new': result(0, { event: 'running', session: { id: '12345678', url: `${origin}/s/12345678` } }),
  } });
  const after = await invoke('--yes', '--terminal', 'herdr', '--skip-reviews', '--repo', repo, '--prompt', 'Fix the redirect.');
  assert.equal(after.code, EXIT.done);
  assert.ok(!after.calls.some(([group, sub]) => group === 'session' && sub === 'watch'));
  assert.deepEqual(after.calls.at(-1), ['session', 'new', '--repo', repo, '--agent', 'claude', '--', 'Fix the redirect.']);
  const step = after.events.find((event) => event.step === 'herdr-watch');
  assert.equal(step.status, 'skipped');
  assert.match(step.message, /inside Woodshed session abcd1234.*On your computer, run woodshed session watch --herdr --add/);
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
  assert.match(lastEntry(explicit.events).message, /Choose herdr on My settings.*without --terminal/);
});

test('a first coding session is optional: with no prompt setup finishes and says how to start one', async () => {
  const { invoke } = fake({ answers: { 'session list': result(0, { sessions: [] }) } });
  const after = await invoke('--yes', '--skip-reviews');
  assert.equal(after.code, EXIT.done);
  assert.equal(lastEntry(after.events).status, 'skipped');
  assert.match(lastEntry(after.events).message, /optional.*session new --herdr.*--prompt/);
  assert.ok(!after.calls.some(([group]) => group === 'session'), 'no session list read for a session nobody asked for');
});

test('setup asks for both Claude Code and Codex, and names how to get each sign-in', async () => {
  const { invoke } = fake({ answers: { status: result(0, { ...ready, sessionSignIns: { claude: false, codex: false } }) } });
  const after = await invoke('--yes', '--repo', repo);
  assert.equal(after.code, EXIT.waiting);
  const last = lastEntry(after.events);
  assert.equal(last.step, 'agent');
  assert.deepEqual(last.missing, ['claude', 'codex']);
  assert.match(last.message, /Connect Claude Code and Codex on My settings: with both connected, your pull requests get reviews from both/);
  assert.match(last.message, /Claude Code:\n {2}1\. In another terminal, run: claude setup-token\n {2}2\. .*sk-ant-oat01-.*\n {2}3\. On My settings \(https:\/\/console\.example\/settings#claude\), paste it in the Claude row's box and press Save\./);
  assert.match(last.message, /Codex:\n {2}1\. In another terminal, run: codex login.*\n {2}2\. In that terminal, .*cat ~\/\.codex\/auth\.json\n {2}3\. On My settings \(https:\/\/console\.example\/settings#codex\)/);
  assert.match(last.message, /--agent claude or --agent codex/);
  assert.equal(last.url, `${origin}/settings#claude`);
  assert.deepEqual(Object.keys(last.steps), ['claude', 'codex']);
  assert.equal(last.steps.claude[0], 'In another terminal, run: claude setup-token');
  assert.doesNotMatch(JSON.stringify(after.calls), /token/, 'setup never handles a token');
});

test('setup asks for the one agent missing, and not for the other when the person uses only one', async () => {
  const claudeOnly = { status: result(0, { ...ready, sessionSignIns: { claude: true, codex: false } }) };
  const both = await fake({ answers: claudeOnly }).invoke('--yes', '--repo', repo, '--no-session', '--skip-reviews');
  assert.equal(both.code, EXIT.waiting);
  assert.deepEqual(lastEntry(both.events).missing, ['codex']);
  assert.doesNotMatch(lastEntry(both.events).message, /claude setup-token/);
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
  assert.match(only.lines.find((line) => line.startsWith('Connect ')), /with both connected, your pull requests get reviews from both\. Claude Code is connected/);
  const claudeMissing = { status: result(0, { ...ready, sessionSignIns: { claude: false, codex: true } }) };
  const missing = await fake({ tty: true, input: ['claude'], answers: claudeMissing }).invoke('--repo', repo);
  assert.equal(missing.code, EXIT.waiting);
  assert.match(lastEntry(missing.events).message, /Connect Claude Code on My settings\.\nClaude Code:\n {2}1\. In another terminal, run: claude setup-token[^]*rerun setup with --repo acme\/app --agent claude/);
  assert.doesNotMatch(lastEntry(missing.events).message, /Codex/);
});

test('on a terminal, setup walks through connecting each agent and goes on once the console has it', async () => {
  const seen = [{ claude: false, codex: false }, { claude: false, codex: false }, { claude: true, codex: false }, { claude: true, codex: true }];
  const { invoke } = fake({ tty: true, browser: true, platform: 'darwin', input: ['', '', '', ''], answers: {
    status: () => result(0, { ...ready, sessionSignIns: seen.length > 1 ? seen.shift() : seen[0] }),
  } });
  const after = await invoke('--repo', repo, '--skip-reviews', '--no-session');
  assert.equal(after.code, EXIT.done);
  assert.deepEqual(after.opened, [`${origin}/settings#claude`, `${origin}/settings#codex`]);
  const text = after.lines.join('\n');
  assert.match(text, /Connect Claude Code \(1 of 2\):\n {2}1\. In another terminal, run: claude setup-token/);
  assert.match(text, /The console does not have Claude Code's sign-in yet/, 'the first Enter came before Save');
  assert.match(text, /Claude Code is connected\.[^]*Connect Codex \(2 of 2\):[^]*pbcopy < ~\/\.codex\/auth\.json[^]*Codex is connected\./);
  assert.equal(after.events.find((event) => event.step === 'agent').status, 'done');
});

test('on a terminal, a status call that fails says so, rather than that the sign-in is not saved', async () => {
  const seen = [result(0, { ...ready, sessionSignIns: { claude: false, codex: true } }), result(1, { event: 'error', error: 'console not reached' }), result(0, { ...ready, sessionSignIns: { claude: true, codex: true } })];
  // Enter for both agents, then an Enter whose status call fails, then one that finds Claude Code saved.
  const { invoke } = fake({ tty: true, input: ['', '', ''], answers: { status: () => (seen.length > 1 ? seen.shift() : seen[0]) } });
  const after = await invoke('--repo', repo, '--skip-reviews', '--no-session');
  assert.equal(after.code, EXIT.done);
  const text = after.lines.join('\n');
  assert.match(text, /Could not ask the console whether it is saved/);
  assert.doesNotMatch(text, /does not have Claude Code's sign-in yet/);
});

test('on a terminal, skip stops setup at the agent with every step still to do', async () => {
  const { invoke } = fake({ tty: true, input: ['', 'skip'], answers: { status: result(0, { ...ready, sessionSignIns: { claude: false, codex: false } }) } });
  const after = await invoke('--repo', repo);
  assert.equal(after.code, EXIT.waiting);
  assert.deepEqual(lastEntry(after.events).missing, ['claude', 'codex']);
  assert.match(lastEntry(after.events).message, /Claude Code:\n[^]*Codex:\n/);
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
  assert.match(step.message, /a review starts on your next one when its last commit's subject ends with \[woodshed-review\] \(a Woodshed session adds it itself/);
  const last = lastEntry(after.events);
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
  assert.equal(lastEntry(after.events).step, 'pr-reviews');
  assert.match(lastEntry(after.events).message, /--review-prs all, none, or their numbers\. Yours: #9 Change 9/);
  const all = await fake({ commands: ['review pulls|start'], answers: { 'review pulls': pullsOn([pull(9), pull(8, { draft: true })]), 'review start': startedFor([9]) } })
    .invoke('--repo', repo, '--no-session', '--review-prs', 'all');
  assert.equal(all.code, EXIT.done);
  assert.deepEqual(all.calls.find(([group, sub]) => group === 'review' && sub === 'start'), ['review', 'start', '9', '--repo', repo], 'a draft is left for when it is ready');
  const none = await fake({ commands: ['review pulls|start'] }).invoke('--repo', repo, '--no-session', '--review-prs', 'none');
  assert.equal(none.code, EXIT.done);
  assert.ok(!none.calls.some(([group, sub]) => group === 'review' && sub === 'pulls'));
});

test('with no open pull requests, setup says a review starts on the next one with the tag; only another runner starts none', async () => {
  const byDefault = { on: true, from: 'default', rerun: '[woodshed-review]', known: true, why: null };
  const empty = await fake({ commands: ['review pulls|start'], answers: { 'review pulls': pullsOn([], byDefault) } })
    .invoke('--yes', '--repo', repo, '--no-session');
  assert.equal(empty.code, EXIT.done);
  assert.match(empty.events.find((event) => event.step === 'pr-reviews').message,
    /no open pull requests on acme\/app: a review starts on your next one when its last commit's subject ends with \[woodshed-review\] \(a Woodshed session adds it itself; on your own computer, add it to the subject\)\.$/);
  const why = 'acme/app\'s project file runs its review in GitHub Actions, not in this console';
  const off = await fake({ commands: ['review pulls|start'], answers: { 'review pulls': pullsOn([pull(9)], { on: false, from: 'project file', rerun: null, known: true, why }) } })
    .invoke('--yes', '--repo', repo, '--no-session');
  assert.equal(off.code, EXIT.done);
  const step = off.events.find((event) => event.step === 'pr-reviews');
  assert.equal(step.status, 'skipped');
  assert.equal(step.message, `No review starts here: ${why}.`);
  assert.ok(!off.calls.some(([group, sub]) => group === 'review' && sub === 'start'));
  const unknown = await fake({ commands: ['review pulls|start'], answers: { 'review pulls': pullsOn([pull(9)], { on: false, from: null, rerun: null, known: false, why: null }), 'review start': startedFor([9]) } })
    .invoke('--yes', '--repo', repo, '--no-session');
  assert.equal(unknown.code, EXIT.done, 'a review the console could not describe is still asked for: the console decides');
});

test('a review the console refuses is named, and none started stops setup with the reason', async () => {
  const refused = result(3, { event: 'review', repo, number: 9, outcome: 'refused', pullUrl: `https://github.com/${repo}/pull/9`, error: '#9 is a draft: mark it ready for review first' });
  const after = await fake({ commands: ['review pulls|start'], answers: { 'review pulls': pullsOn([pull(9)]), 'review start': refused } })
    .invoke('--yes', '--repo', repo, '--no-session');
  assert.equal(after.code, EXIT.refused);
  assert.match(lastEntry(after.events).message, /No review started on acme\/app\. Not started: #9: #9 is a draft/);
});

test('--review-prs is checked before anything runs', async () => {
  await assert.rejects(fake().invoke('--review-prs', 'some'), /--review-prs must be all, none, or pull request numbers/);
  await assert.rejects(fake().invoke('--review-prs', 'all', '--skip-reviews'), /Choose either --review-prs or --skip-reviews/);
});

test('closing the input at the review prompt starts no review', async () => {
  const { invoke } = fake({ tty: true, input: [], commands: ['review pulls|start'], answers: { 'review pulls': pullsOn([pull(9), pull(7)]) } });
  const after = await invoke('--repo', repo, '--no-session');
  assert.equal(after.code, EXIT.done);
  assert.match(after.questions.at(-1), /Review which now\?/);
  assert.ok(!after.calls.some(([group, sub]) => group === 'review' && sub === 'start'), 'Ctrl-D is not Enter');
  assert.match(after.events.find((event) => event.step === 'pr-reviews').message, /^No answer, so no review started on acme\/app/);
});

test('with several repos, each pull request names its repo, and reaches that repo alone', async () => {
  const lib = 'acme/lib';
  const pullsBy = { [repo]: [pull(9), pull(7)], [lib]: [pull(9, { url: `https://github.com/${lib}/pull/9` }), pull(4)] };
  const run = async (which) => {
    const calls = [];
    const events = [];
    // Answered per repo: fake()'s answers are keyed by the command alone.
    const code = await setupCommand({ origin, args: ['--repo', repo, '--repo', lib, '--no-session', '--review-prs', which], rest: null, json: true, browser: false }, {
      EXIT, emit: (e) => events.push(e), say: () => {}, fail: (m) => new Error(m), stderr: { write() {} }, cwd: path.resolve('fake-checkout'),
      open() {}, tty: false, platform: 'test', ask: async () => null, repoOf: () => null,
      run: async (args) => {
        const words = args.slice(noBrowser.length);
        calls.push(words);
        if (words[0] === '--help') return help(['review pulls|start']);
        if (words[0] === 'status') return result(0, ready);
        const at = words[words.indexOf('--repo') + 1];
        if (words[1] === 'status') return result(0, { on: true, review: { runner: 'woodshed', rerun: '[woodshed-review]', from: 'default' }, missing: [] });
        if (words[1] === 'pulls') return result(0, { event: 'pulls', repo: at, review: { on: true, rerun: null, known: true }, pulls: pullsBy[at] });
        if (words[1] === 'start') return startedFor(words.slice(2, words.indexOf('--repo')).map(Number));
        return { code: 99, stdout: '' };
      },
    });
    return { code, events, starts: calls.filter(([g, sub]) => g === 'review' && sub === 'start') };
  };
  const bare = await run('7,4');
  assert.equal(bare.code, EXIT.waiting);
  assert.deepEqual(bare.starts, [], 'a bare number could be yours on both repos: none starts');
  assert.match(lastEntry(bare.events).message, /With several repos, name each pull request's repo in --review-prs, as acme\/app#7/);
  const both = await run(`${repo}#7,${lib}#4`);
  assert.equal(both.code, EXIT.done);
  assert.deepEqual(both.starts, [['review', 'start', '7', '--repo', repo], ['review', 'start', '4', '--repo', lib]]);
  const named = await run(`${lib}#9`);
  assert.equal(named.code, EXIT.done);
  assert.deepEqual(named.starts, [['review', 'start', '9', '--repo', lib]], 'not acme/app\'s #9');
  assert.match(named.events.find((e) => e.step === 'pr-reviews' && e.repo === repo).message, /None of the pull requests you chose is one of your open ones on acme\/app/);
});

test('setup starts no review when the reviewer choice is none, nor asks under --yes when every pull request is a draft', async () => {
  const none = await fake({ commands: ['config', 'review pulls|start'], answers: {
    'config list': result(0, { config: { reviews: 'default' } }),
    'config set': result(0, { event: 'set', key: 'reviews', value: 'none' }),
  } }).invoke('--yes', '--repo', repo, '--reviews', 'none', '--no-session');
  assert.equal(none.code, EXIT.done);
  assert.match(none.events.find((e) => e.step === 'pr-reviews').message, /reviewer choice is none/);
  assert.ok(!none.calls.some(([group, sub]) => group === 'review' && sub === 'pulls'));
  const drafts = await fake({ commands: ['review pulls|start'], answers: { 'review pulls': pullsOn([pull(8, { draft: true })]) } })
    .invoke('--yes', '--repo', repo, '--no-session');
  assert.equal(drafts.code, EXIT.done);
  assert.match(drafts.events.find((e) => e.step === 'pr-reviews').message, /are drafts: each is reviewed once it is ready/);
});

test('with several repos, setup asks for repo-qualified numbers, and says when the list may be out of date', async () => {
  const { invoke } = fake({ commands: ['review pulls|start'], answers: { 'review pulls': result(0, { event: 'pulls', repo, review: { on: true, rerun: null, known: true }, pulls: [pull(9)], stale: true }) } });
  const after = await invoke('--repo', repo, '--repo', 'acme/lib', '--no-session');
  assert.equal(after.code, EXIT.waiting);
  assert.match(lastEntry(after.events).message, /or acme\/app#<number> for this repo alone/);
  const none = await fake({ commands: ['review pulls|start'], answers: { 'review pulls': result(0, { event: 'pulls', repo, review: { on: true, rerun: null, known: true }, pulls: [], stale: true }) } })
    .invoke('--yes', '--repo', repo, '--no-session');
  assert.match(none.events.find((e) => e.step === 'pr-reviews').message, /may be out of date: run setup again/);
});

test('the first session runs Claude Code when both are connected, and answering codex for a missing Codex asks only for it', async () => {
  const { invoke } = fake({ tty: true, input: ['codex', ''], answers: {
    status: result(0, { ...ready, sessionSignIns: { claude: true, codex: true } }),
    'session list': result(0, { sessions: [] }),
    'session new': result(0, { event: 'running', session: { id: '12345678', url: `${origin}/s/12345678` } }),
  } });
  const after = await invoke('--repo', repo, '--skip-reviews', '--prompt', 'Fix it.');
  assert.equal(after.code, EXIT.done);
  assert.deepEqual(after.calls.at(-1).slice(-4), ['--agent', 'claude', '--', 'Fix it.'], 'both connected: nothing to ask, so the default stays');
  const only = await fake({ tty: true, input: ['codex'], answers: {
    status: result(0, { ...ready, sessionSignIns: { claude: true, codex: false } }),
  } }).invoke('--repo', repo, '--skip-reviews', '--prompt', 'Fix it.');
  assert.equal(only.code, EXIT.waiting, 'Codex is still to connect');
  assert.match(lastEntry(only.events).message, /--agent codex/);
});

// A clock for --wait that moves only when setup pauses, so a 15-minute wait runs at once.
const fakeClock = () => ({ t: 1_000_000, slept: [] });
const signedIn = (sessionSignIns) => result(0, { ...ready, sessionSignIns });

test('with --wait, setup prints the steps, waits for each agent to connect, then goes on', async () => {
  const seen = [{ claude: false, codex: false }, { claude: false, codex: false }, { claude: false, codex: false }, { claude: true, codex: false }, { claude: true, codex: true }];
  const clock = fakeClock();
  const { invoke } = fake({ clock, answers: { status: () => signedIn(seen.length > 1 ? seen.shift() : seen[0]) } });
  const after = await invoke('--yes', '--repo', repo, '--wait', '--no-session', '--skip-reviews');
  assert.equal(after.code, EXIT.done);
  const agent = after.events.filter((event) => event.step === 'agent');
  assert.deepEqual(agent.map(({ status, agent: name }) => [status, name]), [['waiting', undefined], ['connected', 'claude'], ['connected', 'codex'], ['done', 'claude']]);
  const [waiting] = agent;
  assert.equal(waiting.url, `${origin}/settings#claude`);
  assert.deepEqual(waiting.wanted, ['claude', 'codex']);
  assert.deepEqual(waiting.missing, ['claude', 'codex']);
  assert.deepEqual(Object.keys(waiting.steps), ['claude', 'codex']);
  assert.equal(waiting.waitMinutes, 15);
  assert.match(waiting.message, /Claude Code:\n {2}1\. In another terminal, run: claude setup-token[^]*Codex:\n {2}1\. In another terminal, run: codex login[^]*Setup is waiting up to 15 minutes/);
  assert.deepEqual(agent[1].missing, ['codex']);
  assert.ok(clock.slept.every((ms) => ms === 5000), 'asks every 5 seconds');
  assert.equal(clock.slept.length, 4, 'four status calls after the first');
  assert.ok(after.events.some((event) => event.step === 'session' && event.status === 'skipped'), 'goes on with the rest of setup');
  assert.equal(after.questions.length, 0);
  assert.doesNotMatch(JSON.stringify(after.calls), /token/, 'setup never handles a token');
});

test('with --wait on a terminal, setup waits instead of asking for Enter, and prints the steps as text', async () => {
  const seen = [{ claude: false, codex: true }, { claude: true, codex: true }];
  const { invoke } = fake({ clock: fakeClock(), tty: true, json: false, answers: { status: () => signedIn(seen.length > 1 ? seen.shift() : seen[0]) } });
  const after = await invoke('--repo', repo, '--wait=2m', '--no-session', '--skip-reviews');
  assert.equal(after.code, EXIT.done);
  assert.equal(after.questions.length, 0, 'neither "use both?" nor Enter');
  const text = after.lines.join('\n');
  assert.match(text, /\[waiting\] Connect Claude Code on My settings: with both connected, your pull requests get reviews from both\.\nClaude Code:\n {2}1\. In another terminal, run: claude setup-token[^]*Setup is waiting up to 2 minutes for it/);
  assert.match(text, /\[connected\] Claude Code is connected\./);
  assert.match(text, /\[done\] Claude Code and Codex are connected/);
});

test('when --wait runs out, setup exits 2 with the steps and the message it gives without --wait', async () => {
  const missing = { status: signedIn({ claude: false, codex: false }) };
  const before = await fake({ answers: missing }).invoke('--yes', '--repo', repo);
  const clock = fakeClock();
  const after = await fake({ clock, answers: missing }).invoke('--yes', '--repo', repo, '--wait=1m');
  assert.equal(after.code, EXIT.waiting);
  const waited = clock.slept.reduce((sum, ms) => sum + ms, 0);
  assert.ok(waited >= 59_000 && waited <= 60_000, `waited the minute, and no longer (${waited} ms)`);
  assert.equal(after.calls.filter(([word]) => word === 'status').length, 1 + 12, 'asked every 5 seconds');
  const { status, ...last } = lastEntry(after.events);
  const { status: was, ...without } = lastEntry(before.events);
  assert.equal(status, 'needs-you');
  assert.equal(was, 'needs-you');
  assert.deepEqual(last, without);
  assert.match(last.message, /Then rerun setup with --repo acme\/app\.$/);
});

test('with --wait, a status call that fails is said once, and the wait goes on', async () => {
  const seen = [signedIn({ claude: true, codex: false }), result(1, { event: 'error', error: 'console not reached' }), result(1, { event: 'error', error: 'console not reached' }), signedIn({ claude: true, codex: true })];
  const { invoke } = fake({ clock: fakeClock(), answers: { status: () => (seen.length > 1 ? seen.shift() : seen[0]) } });
  const after = await invoke('--yes', '--repo', repo, '--wait', '--no-session', '--skip-reviews');
  assert.equal(after.code, EXIT.done);
  const said = after.events.filter((event) => /Could not ask the console/.test(event.message ?? ''));
  assert.equal(said.length, 1);
  assert.equal(said[0].status, 'waiting');
  assert.match(said[0].message, /console not reached\)\. Still asking\./);
  assert.deepEqual(after.events.filter((event) => event.step === 'agent').map((event) => event.status), ['waiting', 'waiting', 'connected', 'done']);
});

test('--wait takes only --wait or --wait=<N>m from 1 to 60, and never the next argument', async () => {
  for (const bad of ['--wait=', '--wait=0m', '--wait=61m', '--wait=10', '--wait=5s', '--wait=1.5m', '--wait=-1m', '--wait=05m']) {
    await assert.rejects(fake().invoke('--yes', bad), /--wait takes no value \(15 minutes\), or minutes as --wait=<N>m, from 1m to 60m\./, bad);
  }
  await assert.rejects(fake().invoke('--yes', '--wait', '10m'), /Unknown setup option 10m/, 'a bare --wait leaves the next argument alone');
  const at = await fake({ clock: fakeClock() }).invoke('--yes', '--wait=60m', '--no-session', '--skip-reviews');
  assert.equal(at.code, EXIT.done);
});

test('with --wait and both agents already connected, setup runs as it does without it', async () => {
  const clock = fakeClock();
  const waited = await fake({ clock }).invoke('--yes', '--repo', repo, '--wait', '--no-session', '--skip-reviews');
  const plain = await fake().invoke('--yes', '--repo', repo, '--no-session', '--skip-reviews');
  assert.equal(waited.code, EXIT.done);
  assert.deepEqual(waited.events, plain.events);
  assert.deepEqual(waited.calls, plain.calls);
  assert.deepEqual(clock.slept, []);
});

test('with --wait, a status call slower than the time left is cut off, and setup exits 2 by the deadline', async () => {
  const clock = fakeClock();
  const start = clock.t;
  let calls = 0;
  // The first answer says Codex is missing; every later call never answers, as a console that hangs.
  const { invoke } = fake({ clock, answers: { status: () => (calls++ ? new Promise(() => {}) : signedIn({ claude: true, codex: false })) } });
  const after = await invoke('--yes', '--repo', repo, '--wait=1m');
  assert.equal(after.code, EXIT.waiting);
  assert.ok(clock.t - start <= 60_000, `exit 2 by the deadline (${clock.t - start} ms)`);
  assert.equal(calls, 2, 'one hung call, cut off when the time ran out, and none after it');
  assert.deepEqual(after.events.filter((event) => event.step === 'agent').map((event) => event.status), ['waiting', 'waiting', 'needs-you']);
  assert.match(after.events[3].message, /did not answer before the wait ran out/);
  assert.deepEqual(lastEntry(after.events).missing, ['codex']);
});

test('with --wait, a sign-in removed mid-wait is reported missing again', async () => {
  // Claude Code connects while Codex is still missing, then its sign-in is removed.
  const both = [{ claude: false, codex: false }, { claude: true, codex: false }, { claude: false, codex: false }];
  const { invoke } = fake({ clock: fakeClock(), answers: { status: () => signedIn(both.length > 1 ? both.shift() : both[0]) } });
  const after = await invoke('--yes', '--repo', repo, '--wait=1m');
  assert.equal(after.code, EXIT.waiting);
  const agent = after.events.filter((event) => event.step === 'agent');
  assert.deepEqual(agent.map(({ status, agent: name }) => [status, name]), [['waiting', undefined], ['connected', 'claude'], ['waiting', 'claude'], ['needs-you', undefined]]);
  assert.deepEqual(agent[1].missing, ['codex']);
  assert.match(agent[2].message, /^Claude Code's sign-in is no longer saved on My settings/);
  assert.deepEqual(agent[2].missing, ['claude', 'codex']);
  assert.deepEqual(agent.at(-1).missing, ['claude', 'codex'], 'the timeout names both again');
});

// A login that waits for its code: `login --no-wait` answers the code until the person approves, then signs in.
function pendingLogin(clock, { approvedAfter = 2, userCode = 'BCDF-GHJK', then = result(0, { event: 'signed-in' }) } = {}) {
  let polls = 0;
  const code = (c = userCode) => result(2, { event: 'code', userCode: c, verificationUrlComplete: `${origin}/cli?code=${c}`, expiresAt: new Date(clock.t + 600_000).toISOString() });
  const first = code();
  return {
    login: () => (polls++ === 0 ? first : polls > approvedAfter ? (typeof then === 'function' ? then() : then) : code()),
    status: () => (polls > approvedAfter ? result(0, ready) : result(2, { signedIn: false })),
  };
}

test('on a terminal, setup waits for the browser approval of its sign-in and goes on in the same run', async () => {
  const clock = fakeClock();
  const { invoke } = fake({ clock, tty: true, json: false, input: [''], answers: pendingLogin(clock) });
  const after = await invoke('--repo', repo, '--skip-reviews', '--no-session');
  assert.equal(after.code, EXIT.done);
  assert.deepEqual(after.calls.slice(0, 4), [['status'], ['login', '--no-wait'], ['login', '--no-wait'], ['login', '--no-wait']]);
  assert.ok(clock.slept.every((ms) => ms === 5000), 'asks every 5 seconds');
  const text = after.lines.join('\n');
  assert.match(text, /^Setup has 8 steps: 1\. Sign in, 2\. Repos, 3\. Claude Code and Codex, 4\. Grok Build and OpenCode \(optional\), 5\. Review on your repos, 6\. Reviews of your open pull requests, 7\. Agent terminal \(optional\), 8\. A first coding session \(optional\)\./);
  assert.match(text, /Step 1 of 8: Sign in\n\[waiting\] Your code is BCDF-GHJK\. On the sign-in page, check it shows the same code, then press Sign in the CLI\. Setup waits here and goes on once you have \(Ctrl-C stops it\)\. https:\/\/console\.example\/cli\?code=BCDF-GHJK\n\[done\] Signed in as @mia-dev/);
  assert.match(text, /Step 2 of 8: Repos[^]*Step 3 of 8: Claude Code and Codex[^]*Step 4 of 8: Grok Build and OpenCode \(optional\)[^]*Step 5 of 8[^]*Step 6 of 8[^]*Step 7 of 8[^]*Step 8 of 8[^]*\[done\] Setup is finished\./);
  assert.doesNotMatch(text, /not finished/);
});

test('with --wait, setup waits for the sign-in approval too, and says so in its entries', async () => {
  const clock = fakeClock();
  const { invoke } = fake({ clock, answers: pendingLogin(clock, { approvedAfter: 1 }) });
  const after = await invoke('--yes', '--repo', repo, '--wait', '--skip-reviews', '--no-session');
  assert.equal(after.code, EXIT.done);
  const login = after.events.filter((event) => event.step === 'login');
  assert.deepEqual(login.map(({ status, userCode }) => [status, userCode]), [['waiting', 'BCDF-GHJK'], ['done', undefined]]);
  assert.deepEqual(lastEntry(after.events).step, 'session');
  assert.deepEqual(after.events.at(-1), { event: 'setup', step: 'finished', status: 'done', message: 'Setup is finished. Run woodshed setup again any time to change a choice.', finished: true });
});

test('a sign-in not approved before its code expires stops setup, saying it is not finished and what is left', async () => {
  const clock = fakeClock();
  const { invoke } = fake({ clock, tty: true, json: false, answers: pendingLogin(clock, { approvedAfter: Infinity }) });
  const after = await invoke('--repo', repo);
  assert.equal(after.code, EXIT.waiting);
  assert.ok(clock.t - 1_000_000 <= 600_000, 'never polls past the code\'s expiry, which would start a new code');
  const text = after.lines.join('\n');
  assert.match(text, /\[needs you\] The code BCDF-GHJK was not approved in time\. Run setup again for a new one\./);
  assert.match(text, /Setup is not finished: it stopped at step 1 of 8, Sign in\. Still to do after it: 2\. Repos, 3\. Claude Code and Codex, 4\. Grok Build and OpenCode \(optional\), 5\. Review on your repos, 6\. Reviews of your open pull requests, 7\. Agent terminal \(optional\), 8\. A first coding session \(optional\)\. Run woodshed setup again/);
});

test('a sign-in denied in the browser while setup waits stops it as refused', async () => {
  const clock = fakeClock();
  const denied = result(3, { event: 'error', error: 'The sign-in was denied in the browser.', status: 'denied' });
  const { invoke } = fake({ clock, answers: pendingLogin(clock, { approvedAfter: 1, then: denied }) });
  const after = await invoke('--yes', '--repo', repo, '--wait');
  assert.equal(after.code, EXIT.refused);
  const last = after.events.at(-1);
  assert.equal(last.message, 'The sign-in was denied in the browser.');
  assert.deepEqual([last.finished, last.stepNumber, last.stepTotal, last.left], [false, 1, 8, ['repos', 'agent', 'own-agents', 'repo-review', 'pr-reviews', 'terminal', 'session']]);
});

test('a sign-in poll that fails is said once, and the wait goes on', async () => {
  const clock = fakeClock();
  const unreachable = result(1, { event: 'error', error: 'could not reach https://console.example: fetch failed' });
  let failures = 2;
  const answers = pendingLogin(clock, { approvedAfter: 3 });
  const login = answers.login;
  const { invoke } = fake({ clock, answers: { ...answers, login: () => { const out = login(); return out.code === 2 && failures-- > 0 && clock.slept.length ? unreachable : out; } } });
  const after = await invoke('--yes', '--repo', repo, '--wait', '--skip-reviews', '--no-session');
  assert.equal(after.code, EXIT.done);
  const waiting = after.events.filter((event) => event.step === 'login' && event.status === 'waiting');
  assert.equal(waiting.length, 2);
  assert.match(waiting[1].message, /Could not ask the console whether it is approved \(could not reach https:\/\/console\.example: fetch failed\)\. Still asking\./);
});

test('at the repo question, Enter takes the repos added already, which the question names, and setup goes on', async () => {
  const { invoke } = fake({ commands: ['repo'], tty: true, json: false, input: ['', 'none'], answers: {
    'repo list': result(0, { projects: [{ repo }, { repo: 'acme/lib' }], available: [{ repo: 'acme/erp' }] }),
  } });
  const after = await invoke('--skip-reviews', '--no-session');
  assert.equal(after.code, EXIT.done);
  assert.equal(after.questions[0], 'Which repos should Woodshed use? Press Enter for the 2 added already (acme/app, acme/lib), or enter owner/name, separated by commas. ');
  assert.ok(!after.calls.some(([group, sub]) => group === 'repo' && sub === 'add'), 'adds none again');
  assert.ok(after.lines.includes('[done] Woodshed uses acme/app, acme/lib.'));
  assert.equal(after.lines.at(-1), '[done] Setup is finished. Run woodshed setup again any time to change a choice.');
});

test('at the repo question with none added, Enter stops setup and says which can be added', async () => {
  const { invoke } = fake({ commands: ['repo'], tty: true, json: false, input: [''], answers: {
    'repo list': result(0, { projects: [], available: [{ repo: 'acme/erp' }] }),
  } });
  const after = await invoke();
  assert.equal(after.code, EXIT.waiting);
  assert.equal(after.questions[0], 'Which repos should Woodshed use? Enter owner/name, separated by commas. ');
  const text = after.lines.join('\n');
  assert.match(text, /\[needs you\] Choose the repos setup uses with --repo owner\/name, once for each\. None added yet\. Not added yet, and added when you choose it: acme\/erp\./);
  assert.match(text, /Setup is not finished: it stopped at step 2 of 8, Repos\./);
});

test('a repo typed in at the question is added, and the step says so', async () => {
  const { invoke } = fake({ commands: ['repo'], tty: true, json: false, input: ['acme/erp'], answers: {
    'repo list': result(0, { projects: [{ repo }], available: [{ repo: 'acme/erp' }] }),
    'repo add': result(0, { event: 'added', repo: 'acme/erp' }),
  } });
  const after = await invoke('--skip-reviews', '--no-session');
  assert.equal(after.code, EXIT.done);
  assert.ok(after.calls.some((words) => words.join(' ') === 'repo add acme/erp'));
  assert.ok(after.lines.includes('[done] Woodshed uses acme/erp. Added just now: acme/erp.'));
});

// Grok Build and OpenCode: made-up sign-in files in a home of the test's own, each holding a marker no output may show.
const GROK_MARKER = 'GROKSECRETMARKER0123456789';
const OPENCODE_MARKER = 'OPENCODESECRETMARKER0123456789';
function ownSignInHome(t, { grok = 'good', opencode = 'good', xdg = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-setup-own-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const files = {
    grok: { good: JSON.stringify({ default: { key: GROK_MARKER, refresh: `${GROK_MARKER}-refresh` } }), bad: `{"default": "${GROK_MARKER}"}` },
    opencode: { good: JSON.stringify({ anthropic: { type: 'api', key: OPENCODE_MARKER } }), bad: `not json ${OPENCODE_MARKER}` },
  };
  const env = xdg ? { XDG_DATA_HOME: path.join(home, 'xdg'), GROK_HOME: path.join(home, 'grokhome') } : {};
  const grokFile = path.join(env.GROK_HOME ?? path.join(home, '.grok'), 'auth.json');
  const opencodeFile = path.join(env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'opencode', 'auth.json');
  for (const [file, kind, id] of [[grokFile, grok, 'grok'], [opencodeFile, opencode, 'opencode']]) {
    if (!kind) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, files[id][kind], { mode: 0o600 });
  }
  return { home, env, grokFile, opencodeFile };
}
const own = (saved = {}) => ({ status: result(0, { ...ready, sessionSignIns: { claude: true, codex: true, grok: false, opencode: false, ...saved } }) });
const pushed = (id) => result(0, { event: 'sign-in', agent: id, saved: true });
const ownEntries = (events) => events.filter((event) => event.step === 'own-agents');
const pushes = (calls) => calls.filter(([a, b]) => a === 'sign-in' && b === 'push');
// As setup shows them: with path.join, so backslashes on Windows. `G` and `O` are the same, escaped for a RegExp.
const grokShown = path.join('~', '.grok', 'auth.json');
const opencodeShown = path.join('~', '.local', 'share', 'opencode', 'auth.json');
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const G = escaped(grokShown);
const O = escaped(opencodeShown);
function assertNoContent(after) {
  const all = JSON.stringify([after.events, after.lines, after.questions, after.calls]);
  assert.doesNotMatch(all, new RegExp(`${GROK_MARKER}|${OPENCODE_MARKER}`), 'never prints a sign-in file\'s content');
}

test('on a terminal, setup offers each sign-in file it finds, naming the file and the console, and sends it after a yes', async (t) => {
  const { home } = ownSignInHome(t);
  const { invoke } = fake({ home, tty: true, json: false, input: ['y', 'yes'], answers: { ...own(), 'sign-in push': () => pushed('x') } });
  const after = await invoke('--repo', repo, '--skip-reviews', '--no-session');
  assert.equal(after.code, EXIT.done);
  assert.deepEqual(after.questions.slice(0, 2), [
    `Send ${grokShown} to ${origin} as your Grok Build sign-in? It is sent over this command line's sign-in and never printed. [y/N] `,
    `Send ${opencodeShown} to ${origin} as your OpenCode sign-in? It is sent over this command line's sign-in and never printed. [y/N] `,
  ]);
  assert.deepEqual(pushes(after.calls), [['sign-in', 'push', 'grok'], ['sign-in', 'push', 'opencode']]);
  assert.match(after.lines.join('\n'), new RegExp(`Step 4 of 8: Grok Build and OpenCode \\(optional\\)\\n\\[done\\] Saved your Grok Build sign-in on https://console\\.example, from ${G}\\.`));
  assertNoContent(after);
});

test('a no sends nothing, and keeps a sign-in saved already', async (t) => {
  const { home } = ownSignInHome(t);
  const { invoke } = fake({ home, tty: true, input: ['n', ''], answers: own({ opencode: true }) });
  const after = await invoke('--repo', repo, '--skip-reviews', '--no-session');
  assert.equal(after.code, EXIT.done);
  assert.deepEqual(pushes(after.calls), []);
  assert.match(after.questions[1], new RegExp(`has an OpenCode sign-in of yours saved already\\. Replace it with ${O} from this computer\\?`));
  assert.deepEqual(ownEntries(after.events).map(({ status, message }) => [status, message]), [
    ['skipped', `Grok Build: ${grokShown} was not sent.`],
    ['skipped', `OpenCode: ${opencodeShown} was not sent, and the saved sign-in is kept.`],
  ]);
  assertNoContent(after);
});

test('a yes to replacing a saved sign-in sends it with --replace', async (t) => {
  const { home } = ownSignInHome(t, { opencode: null });
  const { invoke } = fake({ home, tty: true, input: ['y'], answers: { ...own({ grok: true }), 'sign-in push': pushed('grok') } });
  const after = await invoke('--repo', repo, '--skip-reviews', '--no-session');
  assert.match(after.questions[0], new RegExp(`^https://console\\.example has a Grok Build sign-in of yours saved already\\. Replace it with ${G}`));
  assert.deepEqual(pushes(after.calls), [['sign-in', 'push', 'grok', '--replace']]);
  assert.match(ownEntries(after.events)[0].message, /^Replaced your Grok Build sign-in/);
  // No OpenCode file: optional, said with the registry's step, and never asked.
  assert.equal(after.questions.filter((q) => /OpenCode/.test(q)).length, 0);
  assert.match(ownEntries(after.events)[1].message, new RegExp(`^Optional, for OpenCode: this computer has no ${O}\\. To use it, run opencode auth login, then setup again\\.$`));
});

test('with no Grok Build file, setup says to run grok login or paste an xAI key on My settings', async () => {
  const after = await fake({ answers: own() }).invoke('--yes', '--repo', repo, '--skip-reviews', '--no-session');
  assert.equal(after.code, EXIT.done);
  assert.match(ownEntries(after.events)[0].message, new RegExp(`^Optional, for Grok Build: this computer has no ${G}\\. To use it, run grok login, then setup again\\. Or paste an xAI API key \\(xai-…\\) from console\\.x\\.ai on My settings\\.$`));
  assert.equal(ownEntries(after.events)[0].url, `${origin}/settings#grok`);
});

test('a malformed sign-in file is refused here: nothing asked, nothing sent, its content never shown', async (t) => {
  const { home } = ownSignInHome(t, { grok: 'bad', opencode: 'bad' });
  const { invoke } = fake({ home, tty: true, answers: own() });
  const after = await invoke('--repo', repo, '--skip-reviews', '--no-session');
  assert.equal(after.code, EXIT.done, 'optional: setup goes on');
  assert.deepEqual(pushes(after.calls), []);
  assert.equal(after.questions.filter((q) => /sign-in/.test(q)).length, 0);
  const [grok, opencode] = ownEntries(after.events);
  assert.match(grok.message, new RegExp(`^${G} is not a Grok Build sign-in \\(that is not a Grok Build auth\\.json: .*\\), so it was not sent\\.`));
  assert.match(opencode.message, /is not an OpenCode sign-in \(paste the contents of .*\), so it was not sent\./);
  assertNoContent(after);

  // Named with its flag, a broken file stops setup as refused.
  const flagged = await fake({ home, answers: own() }).invoke('--yes', '--repo', repo, '--skip-reviews', '--no-session', '--grok-sign-in');
  assert.equal(flagged.code, EXIT.refused);
  assert.deepEqual(pushes(flagged.calls), []);
  assertNoContent(flagged);
});

test('without a terminal setup sends a sign-in only with its flag, and replaces one only with =replace', async (t) => {
  const { home } = ownSignInHome(t);
  const run = (saved, ...flags) => fake({ home, answers: { ...own(saved), 'sign-in push': pushed('x') } }).invoke('--yes', '--repo', repo, '--skip-reviews', '--no-session', ...flags);

  const none = await run({});
  assert.equal(none.code, EXIT.done);
  assert.deepEqual(pushes(none.calls), []);
  assert.match(ownEntries(none.events)[0].message, new RegExp(`^Optional, for Grok Build: this computer has ${G}\\. To save it as your Grok Build sign-in on https://console\\.example, rerun setup with --grok-sign-in, or run woodshed sign-in push grok --console`));
  assertNoContent(none);

  const flagged = await run({}, '--grok-sign-in');
  assert.deepEqual(pushes(flagged.calls), [['sign-in', 'push', 'grok']]);

  const savedAlready = await run({ grok: true, opencode: true }, '--grok-sign-in', '--opencode-sign-in');
  assert.deepEqual(pushes(savedAlready.calls), [], 'a flag alone never replaces a saved one');
  assert.match(ownEntries(savedAlready.events)[0].message, new RegExp(`To replace it with ${G} from this computer, rerun setup with --grok-sign-in=replace\\.`));

  const replaced = await run({ grok: true }, '--grok-sign-in=replace');
  assert.deepEqual(pushes(replaced.calls), [['sign-in', 'push', 'grok', '--replace']]);
  // =replace reaches the push even when none was saved at the status read: one saved since is replaced as asked.
  const replacedUnsaved = await run({}, '--grok-sign-in=replace');
  assert.deepEqual(pushes(replacedUnsaved.calls), [['sign-in', 'push', 'grok', '--replace']]);
  await assert.rejects(run({}, '--grok-sign-in=yes'), /--grok-sign-in takes no value, or =replace/);
});

test('setup finds the files where the agents do: GROK_HOME and XDG_DATA_HOME', async (t) => {
  const { home, env, grokFile, opencodeFile } = ownSignInHome(t, { xdg: true });
  const after = await fake({ home, env, answers: own() }).invoke('--yes', '--repo', repo, '--skip-reviews', '--no-session');
  assert.deepEqual(ownEntries(after.events).map((event) => event.file), [grokFile, opencodeFile]);
  assert.ok(ownEntries(after.events).every((event) => /this computer has ~/.test(event.message)));
});

test('a failed push after a yes on the terminal says why and goes on to the next step', async (t) => {
  const { home } = ownSignInHome(t, { opencode: null });
  const refused = result(3, { event: 'error', status: 'refused', error: 'https://console.example refused it (409): this console has no secret store, so My settings cannot be saved.' });
  const after = await fake({ home, tty: true, input: ['y'], answers: { ...own(), 'sign-in push': refused } }).invoke('--repo', repo, '--skip-reviews', '--no-session');
  assert.equal(after.code, EXIT.done, 'optional, asked with no flag: setup goes on');
  const [grok] = ownEntries(after.events);
  assert.equal(grok.status, 'skipped');
  assert.equal(grok.saveFailed, true);
  assert.match(grok.message, /^Could not save your Grok Build sign-in: https:\/\/console\.example refused it \(409\): this console has no secret store, so My settings cannot be saved\. Setup goes on: save it later with woodshed sign-in push grok --console "https:\/\/console\.example", or on My settings\.$/);
  assert.ok(after.events.some((event) => event.step === 'pr-reviews'), 'the steps after it ran');
  assert.ok(after.events.some((event) => event.step === 'finished' && event.finished === true), 'setup finished');
  assertNoContent(after);
});

test('a failed push stops setup with the console\'s reason, never the file', async (t) => {
  const { home } = ownSignInHome(t, { opencode: null });
  const refused = result(3, { event: 'error', status: 'refused', error: 'https://console.example refused it: that is not a Grok Build auth.json.' });
  const after = await fake({ home, answers: { ...own(), 'sign-in push': refused } }).invoke('--yes', '--repo', repo, '--skip-reviews', '--no-session', '--grok-sign-in');
  assert.equal(after.code, EXIT.refused);
  assert.equal(lastEntry(after.events).step, 'own-agents');
  assert.match(lastEntry(after.events).message, /refused it/);
  assertNoContent(after);
});
