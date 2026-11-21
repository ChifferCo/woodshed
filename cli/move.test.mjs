import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { claudeProjectDir } from './moveAgents.mjs';
import { parseMoveArgs } from './move.mjs';
import { EXIT, main } from './woodshed.mjs';
import { fakeHerdr, repoFor } from './moveFixtures.mjs';

const TOKEN = `wsc_${'ab'.repeat(32)}`;
const ORIGIN = 'http://localhost:7799';
const CONVERSATION = '11111111-2222-4333-8444-555555555555';
const SESSION_SETTINGS = fs.readFileSync(new URL('../session/claudeHooks.json', import.meta.url), 'utf8');
const FLAGS = ' --settings /opt/woodshed/session/claudeHooks.json --append-system-prompt-file /tmp/woodshed-rules.md --permission-mode auto';

/**
 * Mia's laptop: a checkout of acme/app with work in it, a Herdr space `api` with Claude in one pane and `npm run dev`
 * beside it, Claude's conversation for that folder, and a console that starts sessions on acme/app. The session's
 * machine answers hc as the session image does: its home, checkout and claude's flags, and a `claude` terminal once
 * connected, its agent having started with nothing to do.
 */
function laptop(t, { window = true, sessions = [], conversation = true, agentState = 'idle', machine = {}, consoleSays = {} } = {}) {
  const repo = repoFor(t);
  fs.writeFileSync(path.join(repo.root, 'services', 'api', 'login.js'), 'export const fixed = true;\n');
  fs.writeFileSync(path.join(repo.root, '.env'), 'SECRET=stays-here\n');
  const home = path.join(repo.dir, 'home');
  const claudeDir = path.join(home, '.claude');
  const cwd = fs.realpathSync(path.join(repo.root, 'services', 'api'));
  if (conversation) {
    const dir = path.join(claudeDir, 'projects', claudeProjectDir(cwd));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${CONVERSATION}.jsonl`), `${[
      { type: 'user', cwd, sessionId: CONVERSATION, message: { role: 'user', content: 'fix the login' } },
      { type: 'assistant', cwd, sessionId: CONVERSATION, message: { role: 'assistant', content: 'Fixed in login.js' } },
    ].map((r) => JSON.stringify(r)).join('\n')}\n`);
  }
  const execs = [];
  const machines = {};
  const h = fakeHerdr({
    window, machines,
    // The session image's agent: a terminal named claude in its checkout, claude open and idle with no prompt.
    onMachineAdd: (name) => { if (!h.terminals.has(`${name}/t1`)) h.add({ machine: name, argv: ['claude'], cwd: '/home/node/work/app', name: 'claude' }); },
  });
  const sessionMachine = (name) => {
    machines[name] = {
      exec: (argv) => {
        execs.push({ machine: name, argv });
        if (machine.unreachable) return { code: 255, stderr: 'the session is not running' };
        const script = argv[2] ?? '';
        if (script.includes('woodshed-claude-flags')) {
          return { code: 0, stdout: `/home/node\n/home/node/work/app\n/opt/woodshed/session\n/home/node/.claude\n/home/node/.codex\nyes\n${Buffer.from(FLAGS).toString('base64')}\n\n` };
        }
        if (script.includes('worktree add') && machine.worktreeFails) return { code: 128, stderr: 'fatal: could not fetch' };
        // What is already in the session: the files written, and those it had before.
        if (argv[0] === 'test' && argv[1] === '-e') return { code: h.files.has(`${name}:${argv[2]}`) || (machine.has ?? []).includes(argv[2]) ? 0 : 1 };
        if (argv[0] === 'cat' && argv[1] === '/opt/woodshed/session/claudeHooks.json') return { code: 0, stdout: SESSION_SETTINGS };
        return { code: 0, stdout: '' };
      },
    };
  };
  for (const id of ['dddd0004', 'bbbb0002', 'aaaa0001', 'c0dec0de']) sessionMachine(`woodshed-${id}`);
  const claude = h.add({ argv: ['/bin/zsh', '-l'], cwd, foreground: { name: 'claude', argv: ['claude'], cwd, pid: 7 }, status: { state: agentState, app: 'claude-code' }, statusMs: 5 });
  const dev = h.add({ argv: ['/bin/zsh', '-l'], cwd, foreground: { name: 'npm', argv: ['npm', 'run', 'dev'], cwd, pid: 8 } });
  h.space('api', [['main', { row: [claude, dev] }]]);

  // The console: Mia's sessions, and the repos she can start on.
  const calls = [];
  const list = [
    { id: 'aaaa0001', owner: 'mia-dev', repo: 'acme/app', project: 'app', status: 'running', state: 'working', title: 'Running one', options: { agent: 'claude' } },
    { id: 'eeee0005', owner: 'mia-dev', repo: 'acme/tools', project: 'tools', status: 'running', state: 'working', title: 'Tools', options: { agent: 'claude' } },
    ...sessions,
  ];
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchFn = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push([init.method ?? 'GET', pathname, body]);
    assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
    if (pathname === '/api/sessions') return json(200, { login: 'mia-dev', sessions: list });
    if (pathname === '/api/my/projects') return json(200, { projects: [{ name: 'app', repo: 'acme/app' }, { name: 'tools', repo: 'acme/tools' }], defaultProject: 'app' });
    if (pathname === '/api/my/sessions' && init.method === 'POST') {
      const s = { id: 'dddd0004', owner: 'mia-dev', repo: 'acme/app', project: body.project, status: 'running', state: 'done', title: body.name, branch: body.workOn, options: { agent: body.agent } };
      list.push(s);
      return json(200, s);
    }
    const resume = /^\/api\/my\/sessions\/(\w+)\/resume$/.exec(pathname);
    if (resume) {
      const s = list.find((x) => x.id === resume[1]);
      Object.assign(s, consoleSays.resumeAs ?? { status: 'running', state: 'done' });
      return json(200, s);
    }
    const remove = /^\/api\/my\/sessions\/(\w+)\/remove$/.exec(pathname);
    if (remove) {
      list.splice(list.findIndex((x) => x.id === remove[1]), 1);
      return json(200, { ok: true });
    }
    return json(404, { error: 'not found' });
  };

  const config = path.join(repo.dir, 'config');
  fs.mkdirSync(path.join(config, 'woodshed'), { recursive: true });
  fs.writeFileSync(path.join(config, 'woodshed', 'cli.json'), JSON.stringify({ current: ORIGIN, consoles: { [ORIGIN]: { login: 'mia-dev', store: 'file' } } }));
  let clock = Date.parse('2026-11-20T10:00:00Z');
  const run = async (args, { confirm = null, onAsk = () => {}, env = {} } = {}) => {
    let out = '';
    let err = '';
    const code = await main(args, {
      env: { ...process.env, XDG_CONFIG_HOME: config, HOME: home, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: path.join(home, '.codex'), ...env },
      stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } },
      credentials: { storeFor: () => ({ kind: 'file', label: 'a file', read: () => TOKEN, remove() {} }), save() {} },
      fetch: fetchFn, sleep: async (ms) => { clock += ms; }, now: () => clock, platform: 'test', hostname: 'mia-laptop',
      hc: h.hc, app: h.app, git: repo.git, moveId: 'c0ffee42', confirm: async (q) => { onAsk(q); return confirm; },
      self: { node: '/usr/local/bin/node', script: '/home/mia/woodshed/cli/woodshed.mjs' },
    });
    return { code, out, err, events: out.trim().split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)) };
  };
  const onGithub = (branch) => {
    try {
      return repo.sh(['--git-dir', repo.bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo.root);
    } catch {
      return null;
    }
  };
  return { h, repo, run, calls, list, execs, claude, dev, cwd, onGithub, local: () => repo.sh(['status', '--porcelain'], repo.root) };
}

const sends = (h, address) => h.calls.filter((c) => c.args?.[0] === 'send' && c.args.includes(address)).map((c) => c.args.at(-1));

test('move options: one way of choosing, a target, and a restart policy', () => {
  const fail = (m) => new Error(m);
  assert.deepEqual(parseMoveArgs(['--space', 'api', '--to', 'new'], fail), { terminal: [], space: 'api', to: 'new', dryRun: false, restart: 'ask' });
  assert.deepEqual(parseMoveArgs(['--terminal', 't1', '--terminal=t2', '--to', 'aaaa0001', '--restart', 'auto', '--dry-run'], fail).terminal, ['t1', 't2']);
  assert.throws(() => parseMoveArgs(['--space', 'api', '--tab', 'main', '--to', 'new'], fail), /one of --terminal, --tab or --space/);
  assert.throws(() => parseMoveArgs(['--space', 'api'], fail), /needs --to/);
  assert.throws(() => parseMoveArgs(['--space', 'api', '--to', 'yesterday'], fail), /not a session id/);
  assert.throws(() => parseMoveArgs(['--space', 'api', '--to', 'new', '--restart', 'maybe'], fail), /--restart must be/);
});

test('a space moves to a new session: code pushed, the conversation carried and resumed as the session\'s agent, the dev server restarted, the layout made again, and the local agent ended last', async (t) => {
  const l = laptop(t);
  const before = l.local();
  const out = await l.run(['move', '--space', 'api', '--to', 'new', '--restart', 'auto', '--console', ORIGIN]);
  assert.equal(out.code, EXIT.done, out.err + out.out);

  // The code: one commit on its own branch, untracked work in, the ignored .env not, and nothing here changed.
  const commit = l.onGithub('woodshed/move-c0ffee42');
  assert.ok(commit, 'the branch is on GitHub');
  const files = l.repo.sh(['--git-dir', l.repo.bare, 'ls-tree', '-r', '--name-only', commit], l.repo.root).split('\n');
  assert.ok(files.includes('services/api/login.js'));
  assert.ok(!files.includes('.env'));
  assert.equal(l.local(), before, 'the checkout, index and branch are as they were');

  // The session: new, on the branch, with nothing to do but the moved conversation.
  const started = l.calls.find(([m, p]) => m === 'POST' && p === '/api/my/sessions');
  assert.deepEqual(started[2], { project: 'app', workOn: 'woodshed/move-c0ffee42', agent: 'claude', model: '', name: 'Moved from mia-laptop: api', prompt: '' });

  // The conversation, where the session's claude reads it, its folders the session's.
  const written = l.h.files.get(`woodshed-dddd0004:/home/node/.claude/projects/${claudeProjectDir('/home/node/work/app/services/api')}/${CONVERSATION}.jsonl`);
  assert.ok(written, [...l.h.files.keys()].join(', '));
  const records = written.toString().trim().split('\n').map((x) => JSON.parse(x));
  assert.deepEqual(records.map((r) => r.cwd), ['/home/node/work/app/services/api', '/home/node/work/app/services/api']);
  assert.equal(records[1].message.content, 'Fixed in login.js');
  assert.deepEqual([...l.h.files.keys()].length, 1, 'nothing else from home');

  // The session's own agent: its empty first claude ended, the moved conversation opened in it, with its flags and hooks.
  assert.deepEqual(sends(l.h, 'woodshed-dddd0004/t1'), ['/exit', `cd /home/node/work/app/services/api && /opt/woodshed/session/bin/claude${FLAGS} --resume ${CONVERSATION}`]);

  // The layout: space api, tab main, the agent and the dev server side by side.
  const space = l.h.spaces.find((s) => s.machine === 'woodshed-dddd0004');
  assert.deepEqual(l.h.shape(space.id), { name: 'api', tabs: [{ name: 'main', tree: { row: ['woodshed-dddd0004/t1:claude', 'woodshed-dddd0004/t3:npm'] } }] });
  const dev = l.h.calls.find((c) => c.app?.[1] === 'pane.split');
  assert.deepEqual(JSON.parse(dev.app[2]).argv, ['/bin/bash', '-lc', 'cd /home/node/work/app/services/api && exec npm run dev']);

  // The hand-over: the local claude ended only after the moved one said what it was doing, and says where it went.
  const order = l.h.calls.map((c, i) => [c, i]);
  const lastRemoteRead = order.filter(([c]) => c.args?.[0] === 'get' && c.args.at(-1) === 'woodshed-dddd0004/t1').at(-1)[1];
  const localExit = order.find(([c]) => c.args?.[0] === 'send' && c.args.includes(l.claude))[1];
  assert.ok(localExit > lastRemoteRead, 'the local agent ends after the moved one is live');
  assert.equal(l.h.terminals.get(l.claude).state, 'finished');
  assert.equal(l.h.terminals.get(l.claude).labels['woodshed.moved'], 'woodshed-dddd0004/t1');
  assert.equal(l.h.terminals.get(l.dev).state, 'live', 'the local dev server keeps running');
  assert.equal(sends(l.h, l.dev).length, 0);

  assert.match(out.out, /t1 -> woodshed-dddd0004\/t1 {2}claude conversation 11111111-2222-4333-8444-555555555555, idle there; ended here/);
  assert.match(out.out, /t2 -> woodshed-dddd0004\/t3 {2}npm run dev started again there/);
  assert.match(out.out, /Programs restart rather than move/);
  assert.match(out.out, /Databases stay: the session has its own/);
  assert.match(out.out, /Stayed here, as git ignores them: \.env\. woodshed settings push --own-files/);
});

test('--dry-run prints the move bundle and does nothing: no push, no session, nothing sent', async (t) => {
  const l = laptop(t);
  const out = await l.run(['move', '--space', 'api', '--to', 'new', '--dry-run', '--json', '--console', ORIGIN]);
  assert.equal(out.code, EXIT.done, out.err + out.out);
  const { bundle } = out.events.find((e) => e.event === 'bundle');
  assert.equal(bundle.version, 1);
  assert.equal(bundle.from, 'local');
  assert.equal(bundle.to, 'new');
  assert.deepEqual(bundle.terminals.map((x) => [x.address, x.kind, x.layout, x.repo.branch, x.repo.subdir]), [
    ['t1', 'agent', { space: 'api', tab: 'main', split: null, ratio: null }, 'woodshed/move-c0ffee42', 'services/api'],
    ['t2', 'process', { space: 'api', tab: 'main', split: 'right', ratio: null }, 'woodshed/move-c0ffee42', 'services/api'],
  ]);
  assert.deepEqual(bundle.terminals[0].agent, { kind: 'claude', sessionRef: CONVERSATION, transcript: `claude/${CONVERSATION}.jsonl`, from: 'newest' });
  assert.deepEqual(bundle.terminals[1].process, { command: 'npm run dev', restart: 'ask' });
  assert.equal(bundle.terminals[0].repo.remote, 'github.com/acme/app');
  assert.equal(l.onGithub('woodshed/move-c0ffee42'), null);
  assert.ok(!l.calls.some(([m]) => m === 'POST'));
  assert.ok(!l.h.calls.some((c) => ['send', 'file', 'exec', 'label', 'run'].includes(c.args?.[0]) || c.app?.[0] === 'do'));
});

test('a refused push stops the move with nothing made and nothing here changed', async (t) => {
  const l = laptop(t);
  fs.writeFileSync(path.join(l.repo.bare, 'hooks', 'pre-receive'), '#!/bin/sh\necho "protected" >&2\nexit 1\n', { mode: 0o755 });
  const out = await l.run(['move', '--space', 'api', '--to', 'new', '--restart', 'auto', '--json', '--console', ORIGIN]);
  assert.equal(out.code, EXIT.failed);
  const error = out.events.find((e) => e.event === 'error');
  assert.equal(error.status, 'push-refused');
  assert.match(error.error, /git push of woodshed\/move-c0ffee42 to origin was refused/);
  assert.ok(!l.calls.some(([m]) => m === 'POST'), 'no session was started');
  assert.equal(l.h.terminals.get(l.claude).state, 'live');
  assert.ok(!l.h.calls.some((c) => c.args?.[0] === 'send' || c.args?.[0] === 'label'));
});

test('a paused session that does not come back undoes the move: the branch deleted, nothing here touched', async (t) => {
  const paused = { id: 'bbbb0002', owner: 'mia-dev', repo: 'acme/app', project: 'app', status: 'stopped', stopReason: 'idle for 2 h', title: 'Paused one', options: { agent: 'claude' } };
  const l = laptop(t, { sessions: [paused], consoleSays: { resumeAs: { status: 'failed', error: 'the machine could not start' } } });
  const out = await l.run(['move', '--terminal', 't1', '--to', 'bbbb0002', '--console', ORIGIN]);
  assert.equal(out.code, EXIT.failed, out.out);
  assert.match(out.err, /Session bbbb0002 could not be connected: the machine could not start/);
  assert.ok(l.calls.some(([m, p]) => m === 'POST' && p === '/api/my/sessions/bbbb0002/resume'), 'connect resumed it first');
  assert.equal(l.onGithub('woodshed/move-c0ffee42'), null, 'the pushed branch was deleted');
  assert.match(out.out, /Undoing what was made in the session and on GitHub; nothing here was changed/);
  assert.ok(!l.calls.some(([, p]) => /remove$/.test(p)), 'a session that was not the move\'s is never removed');
  assert.equal(l.h.terminals.get(l.claude).state, 'live');
});

test('a missing conversation stops the move before anything is pushed', async (t) => {
  const l = laptop(t, { conversation: false });
  const out = await l.run(['move', '--space', 'api', '--to', 'new', '--json', '--console', ORIGIN]);
  assert.equal(out.code, EXIT.failed);
  const error = out.events.find((e) => e.event === 'error');
  assert.equal(error.status, 'no-conversation');
  assert.match(error.error, /The conversation of t1: no claude conversation for .* Nothing was moved/);
  assert.equal(l.onGithub('woodshed/move-c0ffee42'), null);
});

test('a moved agent that never says what it is doing undoes everything, the new session included, and the local one keeps going', async (t) => {
  const l = laptop(t);
  // The session's claude never comes back after the /exit: what was typed does not start it.
  const real = l.h.hc;
  const stuck = async (args, opts) => (args[0] === 'send' && args.at(-1).includes('--resume') ? { code: 0, stdout: '{}\n', stderr: '' } : real(args, opts));
  const out = await laptopRunWith(l, stuck, ['move', '--space', 'api', '--to', 'new', '--restart', 'never', '--console', ORIGIN]);
  assert.equal(out.code, EXIT.failed, out.out);
  assert.match(out.err, /The moved claude in woodshed-dddd0004\/t1 said nothing in 120 s/);
  assert.ok(l.calls.some(([m, p]) => m === 'POST' && p === '/api/my/sessions/dddd0004/remove'), 'the new session is removed');
  assert.equal(l.onGithub('woodshed/move-c0ffee42'), null);
  assert.ok(l.h.calls.some((c) => c.app?.[1] === 'space.close'), 'the space made there is closed');
  assert.equal(l.h.terminals.get(l.claude).state, 'live');
  assert.ok(!sends(l.h, l.claude).length);
});

// The laptop's run, with hc answered by another function.
async function laptopRunWith(l, hc, args) {
  const saved = l.h.hc;
  const { run } = l;
  // run() takes hc from the fake as it starts.
  l.h.hc = hc;
  try {
    return await run(args);
  } finally {
    l.h.hc = saved;
  }
}

test('what refuses a move: a secret in the work, an agent mid-turn, a session on another repo', async (t) => {
  const l = laptop(t);
  fs.writeFileSync(path.join(l.repo.root, 'deploy.pem'), 'key\n');
  const secret = await l.run(['move', '--space', 'api', '--to', 'new', '--console', ORIGIN]);
  assert.equal(secret.code, EXIT.refused);
  assert.match(secret.err, /These look like secrets, and the move would push them to GitHub:\n {2}.*deploy\.pem {2}a key file\n/);
  fs.rmSync(path.join(l.repo.root, 'deploy.pem'));

  const other = await l.run(['move', '--terminal', 't2', '--to', 'eeee0005', '--console', ORIGIN]);
  assert.equal(other.code, EXIT.refused);
  assert.match(other.err, /Session eeee0005 works on acme\/tools, and these terminals are in acme\/app/);

  const busy = laptop(t, { agentState: 'working' });
  const mid = await busy.run(['move', '--space', 'api', '--to', 'new', '--console', ORIGIN]);
  assert.equal(mid.code, EXIT.refused);
  assert.match(mid.err, /t1 \(claude, working\) is mid-turn: a conversation moves between turns/);
  assert.equal(busy.onGithub('woodshed/move-c0ffee42'), null);
});

test('into a running session of yours, the agent gets a worktree and a branch of its own, and the session\'s agent is left alone', async (t) => {
  const l = laptop(t, { window: false });
  const out = await l.run(['move', '--space', 'api', '--to', 'aaaa0001', '--restart', 'never', '--console', ORIGIN]);
  assert.equal(out.code, EXIT.done, out.err + out.out);
  assert.ok(l.onGithub('woodshed/move-c0ffee42'));
  const worktree = l.execs.find((e) => e.argv[2]?.includes('worktree add'));
  assert.deepEqual(worktree.argv.slice(4), ['/home/node/work/app', '/home/node/woodshed-move-c0ffee42', 'woodshed/move-c0ffee42']);
  assert.ok(l.execs.some((e) => e.argv[2]?.includes('hasTrustDialogAccepted') && e.argv[4] === '/home/node/woodshed-move-c0ffee42'), 'the worktree is trusted ahead');
  assert.ok(l.h.files.has(`woodshed-aaaa0001:/home/node/.claude/projects/${claudeProjectDir('/home/node/woodshed-move-c0ffee42/services/api')}/${CONVERSATION}.jsonl`));
  assert.deepEqual(sends(l.h, 'woodshed-aaaa0001/t1'), [], 'the session\'s own agent is not touched');
  // No window: started with the app's labels, in the worktree, without the session agent's hooks.
  const started = l.h.calls.filter((c) => c.args?.[0] === 'run').map((c) => c.args);
  assert.equal(started.length, 2);
  assert.ok(started[0].includes('herdr.space=move-c0ffee42-s1'));
  assert.equal(started[0].at(-1), `cd /home/node/woodshed-move-c0ffee42/services/api && exec /opt/woodshed/session/bin/claude --settings /tmp/woodshed-move-c0ffee42-claude-settings.json --append-system-prompt-file /tmp/woodshed-rules.md --permission-mode auto --resume ${CONVERSATION}`);
  // Its settings: the session's permissions and ready gate, without the hooks that speak for the session's own agent.
  const second = JSON.parse(l.h.files.get('woodshed-aaaa0001:/tmp/woodshed-move-c0ffee42-claude-settings.json').toString());
  assert.ok(second.permissions.ask.includes('Bash(gh pr merge:*)'));
  assert.ok(JSON.stringify(second.hooks).includes('readyGate.mjs'));
  assert.ok(!JSON.stringify(second).includes('hookState'));
  assert.equal(started[1].at(-1), 'cd /home/node/woodshed-move-c0ffee42/services/api && exec bash -l', 'the dev server not restarted: a shell where it ran');
  assert.match(out.out, /t2 -> woodshed-aaaa0001\/t3 {2}a shell there: npm run dev was not started again/);
  assert.match(out.out, /Agents in worktrees \(\/home\/node\/woodshed-move-c0ffee42\) push their own branches/);
  assert.ok(!l.calls.some(([m]) => m === 'POST'), 'nothing started or resumed: it was running');
});

test('a conversation that holds a secret, or one already moved into the session, is not carried', async (t) => {
  const l = laptop(t);
  const file = fs.readdirSync(path.join(l.repo.dir, 'home', '.claude', 'projects')).map((d) => path.join(l.repo.dir, 'home', '.claude', 'projects', d, `${CONVERSATION}.jsonl`))[0];
  const clean = fs.readFileSync(file, 'utf8');
  fs.appendFileSync(file, `${JSON.stringify({ type: 'user', message: { content: `my key is AKIA${'R'.repeat(16)}` } })}\n`);
  const held = await l.run(['move', '--space', 'api', '--to', 'new', '--restart', 'never', '--console', ORIGIN]);
  assert.equal(held.code, EXIT.refused);
  assert.match(held.err, /These conversations hold what looks like a secret.*\n {2}t1's conversation 11111111-2222-4333-8444-555555555555, line 3: an AWS access key\n/s);
  assert.ok(!held.err.includes('AKIA'), 'never the value');
  assert.equal(l.onGithub('woodshed/move-c0ffee42'), null);

  fs.writeFileSync(file, clean);
  const again = laptop(t, { machine: { has: [`/home/node/.claude/projects/${claudeProjectDir('/home/node/work/app/services/api')}/${CONVERSATION}.jsonl`] } });
  const out = await again.run(['move', '--space', 'api', '--to', 'new', '--restart', 'never', '--console', ORIGIN]);
  assert.equal(out.code, EXIT.refused, out.out);
  assert.match(out.err, /is already in woodshed-dddd0004: this conversation was moved there before/);
  assert.equal(again.onGithub('woodshed/move-c0ffee42'), null, 'undone');
  assert.equal(again.h.terminals.get(again.claude).state, 'live');
});

test('a program with a credential on its command line is never started again in the session, nor printed', async (t) => {
  const l = laptop(t);
  Object.assign(l.h.terminals.get(l.dev).foreground, { name: 'node', argv: ['node', 'server.js', '--api-key', 'abc123secret'] });
  const dry = await l.run(['move', '--space', 'api', '--to', 'new', '--dry-run', '--json', '--console', ORIGIN]);
  assert.ok(!dry.out.includes('abc123secret'));
  assert.equal(dry.events.find((e) => e.event === 'bundle').bundle.terminals[1].process.command, 'node server.js --api-key …');
  let asked = null;
  const out = await l.run(['move', '--space', 'api', '--to', 'new', '--restart', 'auto', '--console', ORIGIN], { confirm: true, onAsk: (q) => { asked = q; } });
  assert.equal(out.code, EXIT.done, out.err);
  assert.ok(!out.out.includes('abc123secret') && !out.err.includes('abc123secret'));
  assert.equal(asked, null, 'not even asked');
  const split = JSON.parse(l.h.calls.find((c) => c.app?.[1] === 'pane.split').app[2]);
  assert.equal(split.argv[2], 'cd /home/node/work/app/services/api && exec bash -l', 'a shell where it ran, even with --restart auto');
  assert.ok(!JSON.stringify(l.h.calls).includes('abc123secret'), 'nothing sent to the session holds it');
  assert.match(out.out, /a shell there: node server\.js --api-key … was not started again, as its command line holds what may be a credential/);
  // A known token's shape is a credential whatever flag it follows.
  Object.assign(l.h.terminals.get(l.dev).foreground, { argv: ['curl', '-u', 'me:hunter2', `--header=x-k: sk_live_${'z'.repeat(24)}`] });
  const curl = await l.run(['move', '--space', 'api', '--to', 'new', '--dry-run', '--json', '--console', ORIGIN]);
  assert.equal(curl.events.find((e) => e.event === 'bundle').bundle.terminals.find((x) => x.process).process.command, 'curl -u … …');
});

test('a Codex terminal moves with its rollout and is ended here with /quit though it never says it is idle', async (t) => {
  const l = laptop(t, { conversation: false, sessions: [{ id: 'c0dec0de', owner: 'mia-dev', repo: 'acme/app', project: 'app', status: 'running', state: 'done', title: 'Codex one', options: { agent: 'codex' } }] });
  const codexDir = path.join(l.repo.dir, 'home', '.codex');
  const day = path.join(codexDir, 'sessions', '2026', '11', '20');
  fs.mkdirSync(day, { recursive: true });
  const id = '22222222-3333-4444-8555-666666666666';
  fs.writeFileSync(path.join(day, `rollout-2026-11-20T09-00-00-${id}.jsonl`), `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: l.cwd } })}\n`);
  Object.assign(l.h.terminals.get(l.claude), { foreground: { name: 'codex', argv: ['codex'], cwd: l.cwd, pid: 9 }, status: null, status_ms: null });
  const out = await l.run(['move', '--space', 'api', '--to', 'c0dec0de', '--restart', 'never', '--json', '--console', ORIGIN], { env: { CODEX_HOME: codexDir } });
  assert.equal(out.code, EXIT.done, out.err + out.out);
  assert.ok(l.h.files.has(`woodshed-c0dec0de:/home/node/.codex/sessions/2026/11/20/rollout-2026-11-20T09-00-00-${id}.jsonl`));
  const run = l.h.calls.find((c) => c.app?.[1] === 'space.new' || c.app?.[1] === 'pane.split');
  assert.match(JSON.parse(run.app[2]).argv[2], new RegExp(`exec /opt/woodshed/session/bin/codex resume ${id}$`));
  assert.deepEqual(sends(l.h, l.claude), ['/quit']);
  assert.ok(!l.h.calls.some((c) => c.args?.[0] === 'send' && c.args.includes('--if') && c.args.includes(l.claude)), 'no idle check codex could never pass');
  assert.equal(l.h.terminals.get(l.claude).labels['woodshed.moved'], 'woodshed-c0dec0de/t2');
  assert.equal(out.events.at(-1).terminals[0].localEnded, true);
});

test('an agent of the other kind than the session\'s is not moved into it: it would run without that kind\'s guards', async (t) => {
  const l = laptop(t, { sessions: [{ id: 'c0dec0de', owner: 'mia-dev', repo: 'acme/app', project: 'app', status: 'running', state: 'done', title: 'Codex one', options: { agent: 'codex' } }] });
  const out = await l.run(['move', '--terminal', 't1', '--to', 'c0dec0de', '--console', ORIGIN]);
  assert.equal(out.code, EXIT.refused);
  assert.match(out.err, /t1 runs claude, and session c0dec0de runs codex: a session runs one kind of agent/);
  assert.equal(l.onGithub('woodshed/move-c0ffee42'), null, 'refused before anything was pushed');
});
