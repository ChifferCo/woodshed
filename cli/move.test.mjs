import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { claudeProjectDir } from './moveAgents.mjs';
import { parseMoveArgs } from './move.mjs';
import { EXIT, main } from './woodshed.mjs';
import { fakeHerdr, repoFor } from './moveFixtures.mjs';

const TOKEN = `wsc_${'ab'.repeat(32)}`;
const ORIGIN = 'http://localhost:7799';
const CONVERSATION = '11111111-2222-4333-8444-555555555555';
const SESSION_SETTINGS = fs.readFileSync(new URL('../session/claudeHooks.json', import.meta.url), 'utf8');
const FLAGS = ' --settings /opt/woodshed/session/claudeHooks.json --append-system-prompt-file /tmp/woodshed-rules.md --permission-mode auto';
const CODEX_FLAGS = ' --sandbox read-only --ask-for-approval on-request';

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
          const codexFlags = list.find((s) => `woodshed-${s.id}` === name)?.options?.agent === 'codex' && !machine.noCodexFlags ? CODEX_FLAGS : '';
          return { code: 0, stdout: `/home/node\n/home/node/work/app\n/opt/woodshed/session\n/home/node/.claude\n/home/node/.codex\nyes\n${Buffer.from(FLAGS).toString('base64')}\n${Buffer.from(codexFlags).toString('base64')}\n` };
        }
        if (script.includes('worktree add') && machine.worktreeFails) return { code: 128, stderr: 'fatal: could not fetch' };
        if (argv[0] === 'cat' && argv[1] === '/opt/woodshed/session/claudeHooks.json') return { code: 0, stdout: SESSION_SETTINGS };
        if (script.includes('mktemp -d')) return { code: 0, stdout: `${argv[4]}/.woodshed-move.staged\n` };
        // A large conversation put together from its gzipped parts, as the session's sh does.
        if (script.includes('cat -- "$@" | gunzip')) {
          const [, , , , out, ...parts] = argv;
          h.files.set(`${name}:${out}`, zlib.gunzipSync(Buffer.concat(parts.map((p) => h.files.get(`${name}:${p}`)))));
          return { code: 0 };
        }
        if (script.includes('ln -T --')) {
          const [, , , , from, to] = argv;
          const dest = `${name}:${to}`;
          // Simulate another import publishing this conversation as our upload finishes.
          if (machine.collides) h.files.set(dest, Buffer.from('the other import'));
          if (h.files.has(dest)) return { code: 3 };
          h.files.set(dest, h.files.get(`${name}:${from}`));
          return { code: 0 };
        }
        const removeDir = (dir) => {
          for (const file of h.files.keys()) if (file.startsWith(`${name}:${dir}/`)) h.files.delete(file);
        };
        if (script.includes(' -ef ')) {
          const [, , , , from, to, dir] = argv;
          const staged = h.files.get(`${name}:${from}`);
          if (staged && staged === h.files.get(`${name}:${to}`)) h.files.delete(`${name}:${to}`);
          removeDir(dir);
        }
        if (argv[0] === 'rm' && argv[1] === '-rf') removeDir(argv.at(-1));
        if (argv[0] === 'rm' && argv[1] === '-f') h.files.delete(`${name}:${argv.at(-1)}`);
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
  const out = await l.run(['herdr', 'move', '--space', 'api', '--to', 'new', '--restart', 'auto', '--console', ORIGIN]);
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
  const out = await l.run(['herdr', 'move', '--space', 'api', '--to', 'new', '--dry-run', '--json', '--console', ORIGIN]);
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
  const out = await l.run(['herdr', 'move', '--space', 'api', '--to', 'new', '--restart', 'auto', '--json', '--console', ORIGIN]);
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
  const out = await l.run(['herdr', 'move', '--terminal', 't1', '--to', 'bbbb0002', '--console', ORIGIN]);
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
  const out = await l.run(['herdr', 'move', '--space', 'api', '--to', 'new', '--json', '--console', ORIGIN]);
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
  const out = await laptopRunWith(l, stuck, ['herdr', 'move', '--space', 'api', '--to', 'new', '--restart', 'never', '--console', ORIGIN]);
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
  const secret = await l.run(['herdr', 'move', '--space', 'api', '--to', 'new', '--console', ORIGIN]);
  assert.equal(secret.code, EXIT.refused);
  assert.match(secret.err, /These look like secrets, and the move would push them to GitHub:\n {2}.*deploy\.pem {2}a key file\n/);
  fs.rmSync(path.join(l.repo.root, 'deploy.pem'));

  const other = await l.run(['herdr', 'move', '--terminal', 't2', '--to', 'eeee0005', '--console', ORIGIN]);
  assert.equal(other.code, EXIT.refused);
  assert.match(other.err, /Session eeee0005 works on acme\/tools, and these terminals are in acme\/app/);

  const busy = laptop(t, { agentState: 'working' });
  const mid = await busy.run(['herdr', 'move', '--space', 'api', '--to', 'new', '--console', ORIGIN]);
  assert.equal(mid.code, EXIT.refused);
  assert.match(mid.err, /t1 \(claude, working\) is mid-turn: a conversation moves between turns/);
  assert.equal(busy.onGithub('woodshed/move-c0ffee42'), null);
});

test('into a running session of yours, the agent gets a worktree and a branch of its own, and the session\'s agent is left alone', async (t) => {
  const l = laptop(t, { window: false });
  const out = await l.run(['herdr', 'move', '--space', 'api', '--to', 'aaaa0001', '--restart', 'never', '--console', ORIGIN]);
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

test('a conversation that holds a secret is refused before the push', async (t) => {
  const l = laptop(t);
  const file = fs.readdirSync(path.join(l.repo.dir, 'home', '.claude', 'projects')).map((d) => path.join(l.repo.dir, 'home', '.claude', 'projects', d, `${CONVERSATION}.jsonl`))[0];
  fs.appendFileSync(file, `${JSON.stringify({ type: 'user', message: { content: `my key is AKIA${'R'.repeat(16)}` } })}\n`);
  const held = await l.run(['herdr', 'move', '--space', 'api', '--to', 'new', '--restart', 'never', '--console', ORIGIN]);
  assert.equal(held.code, EXIT.refused);
  assert.match(held.err, /These conversations hold what looks like a secret.*\n {2}t1's conversation 11111111-2222-4333-8444-555555555555, line 3: an AWS access key\n/s);
  assert.ok(!held.err.includes('AKIA'), 'never the value');
  assert.equal(l.onGithub('woodshed/move-c0ffee42'), null);
});

test('a password-bearing URL in a transcript refuses the move before push or upload', async (t) => {
  const l = laptop(t);
  const password = 'inert-fixture-password';
  const url = `postgresql://fixture:${password}@db.example.invalid/app`;
  fs.writeFileSync(path.join(l.repo.root, '.env'), `DATABASE_URL=${url}\n`);
  const file = path.join(l.repo.dir, 'home', '.claude', 'projects', claudeProjectDir(l.cwd), `${CONVERSATION}.jsonl`);
  fs.appendFileSync(file, `${JSON.stringify({ type: 'assistant', message: { content: `DATABASE_URL=${url}` } })}\n`);
  fs.writeFileSync(path.join(l.repo.bare, 'hooks', 'pre-receive'), '#!/bin/sh\ntouch push-started\n', { mode: 0o755 });

  const out = await l.run(['herdr', 'move', '--space', 'api', '--to', 'new', '--restart', 'never', '--console', ORIGIN, '--json']);
  assert.equal(out.code, EXIT.refused);
  assert.deepEqual(out.events.find((event) => event.event === 'secrets')?.conversations, [{ address: 't1', line: 3, kind: 'a password in a URL' }]);
  assert.ok(!(out.out + out.err).includes(password));
  assert.ok(!l.calls.some(([method]) => method === 'POST'));
  assert.ok(!l.h.calls.some((call) => call.args?.[0] === 'file'));
  assert.ok(!fs.existsSync(path.join(l.repo.bare, 'push-started')));
});

test('decoded transcript credential headers refuse a move before push or upload', async (t) => {
  const l = laptop(t);
  const value = 'inert-fixture-bearer-value';
  const file = path.join(l.repo.dir, 'home', '.claude', 'projects', claudeProjectDir(l.cwd), `${CONVERSATION}.jsonl`);
  const raw = JSON.stringify({ type: 'assistant', message: { content: `GET /fixture\nAuthorization: Bearer ${value}` } });
  const escaped = JSON.stringify({ type: 'tool_result', headers: { Authorization: `Bearer ${value}` } })
    .replace('Authorization', '\\u0041uthorization');
  const listValue = JSON.stringify({ type: 'tool_result', headers: { Authorization: [`Bearer ${value}`] } });
  const pair = JSON.stringify({ type: 'tool_result', headers: [['Authorization', `Bearer ${value}`]] });
  const requestLog = JSON.stringify({ type: 'tool_result', headers: [{ name: 'Authorization', value: `Bearer ${value}` }] });
  const output = JSON.stringify({ type: 'tool_result', content: JSON.stringify({ headers: { Authorization: `Bearer ${value}` } }, null, 2) });
  const wrapped = JSON.stringify({ type: 'tool_result', content: JSON.stringify({ stdout: output }) });
  fs.appendFileSync(file, `${[raw, escaped, listValue, pair, requestLog, output, wrapped].join('\n')}\n`);
  fs.writeFileSync(path.join(l.repo.bare, 'hooks', 'pre-receive'), '#!/bin/sh\ntouch push-started\n', { mode: 0o755 });

  const out = await l.run(['herdr', 'move', '--space', 'api', '--to', 'new', '--restart', 'never', '--console', ORIGIN, '--json']);
  assert.equal(out.code, EXIT.refused);
  assert.deepEqual(out.events.find((event) => event.event === 'secrets')?.conversations, [
    { address: 't1', line: 3, kind: 'a credential header' },
    { address: 't1', line: 4, kind: 'a credential header' },
    { address: 't1', line: 5, kind: 'a credential header' },
    { address: 't1', line: 6, kind: 'a credential header' },
    { address: 't1', line: 7, kind: 'a credential header' },
    { address: 't1', line: 8, kind: 'a credential header' },
    { address: 't1', line: 9, kind: 'a credential header' },
  ]);
  assert.ok(!(out.out + out.err).includes(value));
  assert.ok(!l.calls.some(([method]) => method === 'POST'));
  assert.ok(!l.h.calls.some((call) => call.args?.[0] === 'file'));
  assert.ok(!fs.existsSync(path.join(l.repo.bare, 'push-started')));
});

test('credential headers in an untracked request log refuse the move before push', async (t) => {
  const l = laptop(t);
  const value = 'inert-fixture-bearer-value';
  const record = { headers: { Authorization: `Bearer ${value}` } };
  fs.writeFileSync(path.join(l.repo.bare, 'hooks', 'pre-receive'), '#!/bin/sh\ntouch push-started\n', { mode: 0o755 });

  const logs = [
    ['request.log', `GET /fixture\nAuthorization: Bearer ${value}\n${JSON.stringify(record)}\n`, [2, 3]],
    ['request.json', `${JSON.stringify(record, null, 2)}\n`, [null]],
    ['tool-output.json', `${JSON.stringify({ stdout: JSON.stringify(record) }, null, 2)}\n`, [null]],
  ];
  for (const [file, content, lines] of logs) {
    const trace = path.join(l.repo.root, file);
    fs.writeFileSync(trace, content);
    const out = await l.run(['herdr', 'move', '--terminal', 't2', '--to', 'new', '--restart', 'never', '--console', ORIGIN, '--json']);
    assert.equal(out.code, EXIT.refused, file);
    assert.deepEqual(out.events.find((event) => event.event === 'secrets')?.files, lines.map((line) => ({
      root: fs.realpathSync(l.repo.root), path: file, line, kind: 'a credential header',
    })));
    assert.ok(!(out.out + out.err).includes(value));
    assert.ok(!fs.existsSync(path.join(l.repo.bare, 'push-started')));
    assert.equal(l.onGithub('woodshed/move-c0ffee42'), null);
    assert.ok(!l.calls.some(([method]) => method === 'POST'));
    fs.unlinkSync(trace);
  }
});

test('filename-only and binary credentials stop the move without printing their values', async (t) => {
  const l = laptop(t);
  const synthetic = `ghp_${'f4'.repeat(18)}`;
  const renamed = path.join(l.repo.root, `export_${synthetic}.md`);
  fs.copyFileSync(path.join(l.repo.root, 'README.md'), renamed);
  const args = ['herdr', 'move', '--space', 'api', '--to', 'new', '--console', ORIGIN];
  for (const extra of [[], ['--json']]) {
    const out = await l.run([...args, '--dry-run', ...extra]);
    assert.equal(out.code, EXIT.refused);
    assert.match(out.out + out.err, /a name in Git tree [0-9a-f]{12}.*a GitHub token/);
    assert.ok(!(out.out + out.err).includes(synthetic));
  }
  fs.unlinkSync(renamed);

  const cache = path.join(l.repo.root, 'cache.sqlite');
  fs.writeFileSync(cache, Buffer.from(`SQLite format 3\0\x01key\0${synthetic}\0`));
  const out = await l.run([...args, '--json']);
  assert.equal(out.code, EXIT.refused);
  assert.equal(out.events.find((event) => event.event === 'secrets').files[0].path, 'cache.sqlite');
  assert.ok(!(out.out + out.err).includes(synthetic));
  assert.equal(l.onGithub('woodshed/move-c0ffee42'), null);
  assert.ok(!l.calls.some(([method]) => method === 'POST'));

  // An ordinary binary file still moves, and an ignored path never discloses a credential in the plan.
  fs.writeFileSync(cache, Buffer.from('SQLite format 3\0fixture bytes'));
  const ignored = path.join(l.repo.root, `ignored-${synthetic}`);
  fs.mkdirSync(ignored);
  fs.writeFileSync(path.join(ignored, '.env'), 'FIXTURE=local\n');
  const dry = await l.run([...args, '--dry-run', '--json']);
  assert.equal(dry.code, EXIT.done, dry.err);
  assert.ok(!dry.out.includes(synthetic));
  assert.ok(dry.events.find((event) => event.event === 'bundle').bundle.repos[0].ignoredEnv.includes('ignored-…/.env'));
  const moved = await l.run([...args, '--restart', 'never', '--json']);
  assert.equal(moved.code, EXIT.done, moved.err);
  assert.ok(!moved.out.includes(synthetic));
  assert.equal(l.repo.sh(['cat-file', '-s', `${l.onGithub('woodshed/move-c0ffee42')}:cache.sqlite`], l.repo.root), String(fs.statSync(cache).size));
});

test('local Git replacement refs cannot hide a credential in the history a move would publish', async (t) => {
  const l = laptop(t);
  const { root, sh } = l.repo;
  const base = sh(['rev-parse', 'HEAD'], root);
  const file = 'fixture.txt';
  fs.writeFileSync(path.join(root, file), `ghp_${'9b'.repeat(18)}`);
  sh(['add', file], root);
  sh(['commit', '-qm', 'unpublished fixture'], root);
  const original = sh(['rev-parse', 'HEAD'], root);
  fs.unlinkSync(path.join(root, file));
  const clean = sh(['commit-tree', `${base}^{tree}`, '-p', base, '-m', 'clean local replacement'], root);
  sh(['replace', original, clean], root);
  assert.equal(sh(['log', '-1', '--format=%s'], root), 'clean local replacement');

  const out = await l.run(['herdr', 'move', '--space', 'api', '--to', 'new', '--restart', 'never', '--console', ORIGIN]);
  assert.equal(out.code, EXIT.refused);
  assert.match(out.err, /fixture\.txt:1  a GitHub token/);
  assert.ok(!out.err.includes('ghp_'));
  assert.equal(l.onGithub('woodshed/move-c0ffee42'), null);
  assert.ok(!l.calls.some(([method]) => method === 'POST'));
});

test('the move refuses a new Git LFS pointer before the upload hook runs', async (t) => {
  const l = laptop(t);
  const { root, dir, sh } = l.repo;
  const filter = path.join(dir, 'lfs-clean.cjs');
  // Stand in for Git LFS using Git's real clean-filter and pre-push hook paths, with no LFS service or network.
  fs.writeFileSync(filter, `const bytes = require('node:fs').readFileSync(0);
const hash = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
process.stdout.write('version https://git-lfs.github.com/spec/v1\\noid sha256:' + hash + '\\nsize ' + bytes.length + '\\n');\n`);
  sh(['config', 'filter.lfs.clean', `node ${JSON.stringify(filter)}`], root);
  sh(['config', 'filter.lfs.required', 'true'], root);
  fs.writeFileSync(path.join(root, '.gitattributes'), '*.asset filter=lfs\n');
  fs.writeFileSync(path.join(root, 'fixture.asset'), `ghp_${'7e'.repeat(18)}`);
  const hook = path.join(root, '.git', 'hooks', 'pre-push');
  fs.writeFileSync(hook, '#!/bin/sh\nprintf "%s\\n" "$GIT_LFS_SKIP_PUSH" > .git/pre-push-ran\nif [ "$GIT_LFS_SKIP_PUSH" != 1 ]; then touch .git/lfs-upload-started; fi\n', { mode: 0o755 });

  const args = ['herdr', 'move', '--space', 'api', '--to', 'new', '--restart', 'never', '--console', ORIGIN];
  const refused = await l.run(args);
  assert.equal(refused.code, EXIT.refused);
  assert.match(refused.err, /fixture\.asset  a Git LFS pointer whose payload cannot be screened/);
  assert.ok(!refused.err.includes('ghp_'));
  assert.ok(!fs.existsSync(path.join(root, '.git', 'pre-push-ran')));
  assert.equal(l.onGithub('woodshed/move-c0ffee42'), null);

  fs.unlinkSync(path.join(root, 'fixture.asset'));
  const allowed = await l.run(args);
  assert.equal(allowed.code, EXIT.done, allowed.err);
  assert.equal(fs.readFileSync(path.join(root, '.git', 'pre-push-ran'), 'utf8'), '1\n');
  assert.ok(!fs.existsSync(path.join(root, '.git', 'lfs-upload-started')));
});

test('recursive push config cannot publish an unverified submodule commit', async (t) => {
  const l = laptop(t);
  const child = repoFor(t, { name: 'acme/child' });
  const { root, sh } = l.repo;
  const submodule = 'vendor/fixture';
  const cwd = path.join(root, submodule);
  sh(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child.bare, submodule], root);
  sh(['commit', '-qm', 'add fixture submodule'], root);
  sh(['push', '-q', '--no-recurse-submodules', 'origin', 'main'], root);
  const parentBase = sh(['rev-parse', 'HEAD'], root);
  const refs = () => sh(['--git-dir', child.bare, 'for-each-ref', '--format=%(refname):%(objectname)'], child.root);
  const before = refs();
  fs.writeFileSync(path.join(child.bare, 'hooks', 'pre-receive'), '#!/bin/sh\ntouch upload-started\n', { mode: 0o755 });
  sh(['config', 'push.recurseSubmodules', 'on-demand'], root);
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), `ghp_${'8a'.repeat(18)}`);
  sh(['add', 'fixture.txt'], cwd);
  sh(['commit', '-qm', 'unpublished child work'], cwd);
  const unpublished = sh(['rev-parse', 'HEAD'], cwd);

  const args = ['herdr', 'move', '--space', 'api', '--to', 'new', '--restart', 'never', '--console', ORIGIN];
  const assertRefused = (out) => {
    assert.equal(out.code, EXIT.refused, out.err);
    assert.match(out.err, /could not verify these submodule commits on a remote-tracking branch:\n {2}.*vendor\/fixture/);
    assert.ok(!out.err.includes('ghp_'));
    assert.equal(l.onGithub('woodshed/move-c0ffee42'), null);
    assert.equal(refs(), before);
    assert.throws(() => sh(['--git-dir', child.bare, 'cat-file', '-e', unpublished], child.root));
    assert.ok(!fs.existsSync(path.join(child.bare, 'upload-started')));
  };
  // The link is new in the working tree. Git config would publish the child before sending the parent.
  assertRefused(await l.run(args));

  // The same link in unpublished history must be rejected when Git itself has no local child to inspect.
  sh(['add', submodule], root);
  sh(['commit', '-qm', 'record unpublished child'], root);
  sh(['submodule', 'deinit', '-f', '--', submodule], root);
  fs.rmSync(path.join(root, '.git', 'modules', submodule), { recursive: true });
  assertRefused(await l.run(args));
  assert.ok(!l.calls.some(([method]) => method === 'POST'));

  // An unchanged uninitialized submodule is fine. The move pushes only the checked parent.
  sh(['reset', '--hard', parentBase], root);
  assert.equal((await l.run(args)).code, EXIT.done);
  assert.equal(refs(), before);
});

test('a concurrent transcript import is preserved and only the failed upload is cleaned up', async (t) => {
  const l = laptop(t, { machine: { collides: true } });
  const out = await l.run(['herdr', 'move', '--space', 'api', '--to', 'aaaa0001', '--restart', 'never', '--console', ORIGIN]);
  assert.equal(out.code, EXIT.refused, out.out);
  assert.match(out.err, /is already in woodshed-aaaa0001: this conversation was moved there before/);
  const dest = `woodshed-aaaa0001:/home/node/.claude/projects/${claudeProjectDir('/home/node/woodshed-move-c0ffee42/services/api')}/${CONVERSATION}.jsonl`;
  assert.deepEqual([...l.h.files], [[dest, Buffer.from('the other import')]]);
  assert.equal(l.onGithub('woodshed/move-c0ffee42'), null, 'undone');
  assert.equal(l.h.terminals.get(l.claude).state, 'live');
});

test('a changed local transcript stays local and only the screened copy reaches the session', async (t) => {
  const l = laptop(t);
  const file = path.join(l.repo.dir, 'home', '.claude', 'projects', claudeProjectDir(l.cwd), `${CONVERSATION}.jsonl`);
  const before = fs.readFileSync(file, 'utf8');
  const out = await l.run(['herdr', 'move', '--space', 'api', '--to', 'aaaa0001', '--console', ORIGIN], {
    confirm: true,
    onAsk: () => fs.appendFileSync(file, `${JSON.stringify({ type: 'user', message: { content: `AKIA${'T'.repeat(16)}` } })}\n`),
  });
  assert.equal(out.code, EXIT.refused, out.err);
  assert.match(out.err, /conversation changed during the move/);
  assert.notEqual(fs.readFileSync(file, 'utf8'), before);
  const upload = l.h.calls.find((c) => c.args?.[0] === 'file' && c.args.at(-1).endsWith('/conversation'));
  assert.equal(upload.input.toString('utf8'), before.split(l.cwd).join('/home/node/woodshed-move-c0ffee42/services/api'));
  assert.deepEqual(sends(l.h, l.claude), []);
  assert.equal(l.h.files.size, 0, 'the uploaded copy was rolled back');
});

test('a program with a credential on its command line is never started again in the session, nor printed', async (t) => {
  const l = laptop(t);
  Object.assign(l.h.terminals.get(l.dev).foreground, { name: 'node', argv: ['node', 'server.js', '--api-key', 'abc123secret'] });
  const dry = await l.run(['herdr', 'move', '--space', 'api', '--to', 'new', '--dry-run', '--json', '--console', ORIGIN]);
  assert.ok(!dry.out.includes('abc123secret'));
  assert.equal(dry.events.find((e) => e.event === 'bundle').bundle.terminals[1].process.command, 'node server.js --api-key …');
  let asked = null;
  const out = await l.run(['herdr', 'move', '--space', 'api', '--to', 'new', '--restart', 'auto', '--console', ORIGIN], { confirm: true, onAsk: (q) => { asked = q; } });
  assert.equal(out.code, EXIT.done, out.err);
  assert.ok(!out.out.includes('abc123secret') && !out.err.includes('abc123secret'));
  assert.equal(asked, null, 'not even asked');
  const split = JSON.parse(l.h.calls.find((c) => c.app?.[1] === 'pane.split').app[2]);
  assert.equal(split.argv[2], 'cd /home/node/work/app/services/api && exec bash -l', 'a shell where it ran, even with --restart auto');
  assert.ok(!JSON.stringify(l.h.calls).includes('abc123secret'), 'nothing sent to the session holds it');
  assert.match(out.out, /a shell there: node server\.js --api-key … was not started again, as its command line holds what may be a credential/);
  // A known token's shape is a credential whatever flag it follows.
  Object.assign(l.h.terminals.get(l.dev).foreground, { argv: ['curl', '-u', 'me:hunter2', `--header=x-k: sk_live_${'z'.repeat(24)}`] });
  const curl = await l.run(['herdr', 'move', '--space', 'api', '--to', 'new', '--dry-run', '--json', '--console', ORIGIN]);
  assert.equal(curl.events.find((e) => e.event === 'bundle').bundle.terminals.find((x) => x.process).process.command, 'curl -u … …');
});

test('a switch immediately before a password flag cannot disclose the password in the plan or result', async (t) => {
  const l = laptop(t);
  const password = 'inert-argument-password';
  Object.assign(l.h.terminals.get(l.dev).foreground, { name: 'db', argv: ['db', '--no-keyring', '--password', password] });
  const args = ['herdr', 'move', '--space', 'api', '--to', 'new', '--restart', 'auto', '--console', ORIGIN];
  const dry = await l.run([...args, '--dry-run', '--json']);
  assert.equal(dry.code, EXIT.done, dry.err);
  assert.ok(!dry.out.includes(password));
  const preview = dry.events.find((event) => event.event === 'bundle').bundle.terminals.find((terminal) => terminal.process).process;
  assert.deepEqual(preview, { command: 'db --no-keyring … …', restart: 'never' });

  const out = await l.run(args);
  assert.equal(out.code, EXIT.done, out.err);
  assert.ok(!(out.out + out.err).includes(password));
  assert.match(out.out, /a shell there: db --no-keyring … … was not started again/);
  assert.ok(!JSON.stringify(l.h.calls).includes(password));
});

test('a Codex terminal moves with its rollout and is ended here with /quit though it never says it is idle', async (t) => {
  const machine = { noCodexFlags: true };
  const l = laptop(t, { machine, conversation: false, sessions: [{ id: 'c0dec0de', owner: 'mia-dev', repo: 'acme/app', project: 'app', status: 'running', state: 'done', title: 'Codex one', options: { agent: 'codex' } }] });
  const codexDir = path.join(l.repo.dir, 'home', '.codex');
  const day = path.join(codexDir, 'sessions', '2026', '11', '20');
  fs.mkdirSync(day, { recursive: true });
  const id = '22222222-3333-4444-8555-666666666666';
  fs.writeFileSync(path.join(day, `rollout-2026-11-20T09-00-00-${id}.jsonl`), `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: l.cwd } })}\n`);
  Object.assign(l.h.terminals.get(l.claude), { foreground: { name: 'codex', argv: ['codex'], cwd: l.cwd, pid: 9 }, status: null, status_ms: null });
  const refused = await l.run(['herdr', 'move', '--space', 'api', '--to', 'c0dec0de', '--restart', 'never', '--console', ORIGIN], { env: { CODEX_HOME: codexDir } });
  assert.equal(refused.code, EXIT.refused, refused.err);
  assert.match(refused.err, /did not provide its Codex flags/);
  assert.equal(l.h.files.size, 0);
  assert.deepEqual(sends(l.h, l.claude), []);
  machine.noCodexFlags = false;
  const out = await l.run(['herdr', 'move', '--space', 'api', '--to', 'c0dec0de', '--restart', 'never', '--json', '--console', ORIGIN], { env: { CODEX_HOME: codexDir } });
  assert.equal(out.code, EXIT.done, out.err + out.out);
  assert.ok(l.h.files.has(`woodshed-c0dec0de:/home/node/.codex/sessions/2026/11/20/rollout-2026-11-20T09-00-00-${id}.jsonl`));
  const run = l.h.calls.find((c) => c.app?.[1] === 'space.new' || c.app?.[1] === 'pane.split');
  assert.match(JSON.parse(run.app[2]).argv[2], new RegExp(`exec /opt/woodshed/session/bin/codex resume${CODEX_FLAGS} ${id}$`));
  assert.deepEqual(sends(l.h, l.claude), ['/quit']);
  assert.ok(!l.h.calls.some((c) => c.args?.[0] === 'send' && c.args.includes('--if') && c.args.includes(l.claude)), 'no idle check codex could never pass');
  assert.equal(l.h.terminals.get(l.claude).labels['woodshed.moved'], 'woodshed-c0dec0de/t2');
  assert.equal(out.events.at(-1).terminals[0].localEnded, true);
});

test('an agent of the other kind than the session\'s is not moved into it: it would run without that kind\'s guards', async (t) => {
  const l = laptop(t, { sessions: [{ id: 'c0dec0de', owner: 'mia-dev', repo: 'acme/app', project: 'app', status: 'running', state: 'done', title: 'Codex one', options: { agent: 'codex' } }] });
  const out = await l.run(['herdr', 'move', '--terminal', 't1', '--to', 'c0dec0de', '--console', ORIGIN]);
  assert.equal(out.code, EXIT.refused);
  assert.match(out.err, /t1 runs claude, and session c0dec0de runs codex: a session runs one kind of agent, with/);
  assert.equal(l.onGithub('woodshed/move-c0ffee42'), null, 'refused before anything was pushed');
});

test('a new session runs the kind of the repo\'s agents, whichever checkout of it they are in', async (t) => {
  const l = laptop(t, { conversation: false });
  // A second checkout of the same repo, with Codex in it; the first checkout has only a shell in this space.
  const wt = path.join(l.repo.dir, 'app-other');
  l.repo.sh(['worktree', 'add', '-q', '-b', 'other', wt], l.repo.root);
  const wtReal = fs.realpathSync(wt);
  const id = '33333333-4444-4555-8666-777777777777';
  const day = path.join(l.repo.dir, 'home', '.codex', 'sessions', '2026', '11', '20');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, `rollout-2026-11-20T09-00-00-${id}.jsonl`), `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: wtReal } })}\n`);
  Object.assign(l.h.terminals.get(l.claude), { foreground: { name: 'zsh', argv: ['-zsh'], cwd: l.cwd, pid: 9 }, status: null, status_ms: null });
  const codex = l.h.add({ argv: ['/bin/zsh', '-l'], cwd: wtReal, foreground: { name: 'codex', argv: ['codex'], cwd: wtReal, pid: 10 }, status: null });
  l.h.space('pair', [['main', { row: [l.claude, codex] }]]);
  const out = await l.run(['herdr', 'move', '--space', 'pair', '--to', 'new', '--console', ORIGIN]);
  assert.equal(out.code, EXIT.done, out.err + out.out);
  const started = l.calls.find(([m, p]) => m === 'POST' && p === '/api/my/sessions');
  assert.equal(started[2].agent, 'codex');
  assert.ok(l.onGithub('woodshed/move-c0ffee42') && l.onGithub('woodshed/move-c0ffee42-2'), 'a branch for each checkout');
});

test('a conversation over hc\'s 8 MB goes in gzipped parts, and is put together there byte for byte', async (t) => {
  const l = laptop(t);
  const file = fs.readdirSync(path.join(l.repo.dir, 'home', '.claude', 'projects')).map((d) => path.join(l.repo.dir, 'home', '.claude', 'projects', d, `${CONVERSATION}.jsonl`))[0];
  // Twelve MiB of turns that still span several parts after compression.
  const lines = [];
  for (let i = 0, size = 0; size < 12 * 1024 * 1024; i++) {
    // Base64 has no hyphens or underscores. Drop A so the fixture cannot make a Google or AWS key by chance.
    const content = crypto.createHash('shake256', { outputLength: 600 }).update(String(i)).digest('base64').replaceAll('A', '0');
    lines.push(JSON.stringify({ type: 'assistant', cwd: l.cwd, message: { content: `${i} ${content}` } }));
    size += lines.at(-1).length + 1;
  }
  fs.appendFileSync(file, `${lines.join('\n')}\n`);
  assert.ok(fs.statSync(file).size > 8 * 1024 * 1024);
  const out = await l.run(['herdr', 'move', '--space', 'api', '--to', 'new', '--restart', 'never', '--console', ORIGIN]);
  assert.equal(out.code, EXIT.done, out.err + out.out);
  const parts = l.h.calls.filter((c) => c.args?.[0] === 'file' && c.args.at(-1).includes('.woodshed-part-'));
  assert.ok(parts.length >= 2 && parts.every((c) => c.input.length <= 6 * 1024 * 1024), `several parts, each within what hc takes (${parts.length})`);
  const dest = `woodshed-dddd0004:/home/node/.claude/projects/${claudeProjectDir('/home/node/work/app/services/api')}/${CONVERSATION}.jsonl`;
  const expected = fs.readFileSync(file, 'utf8').split(l.cwd).join('/home/node/work/app/services/api');
  assert.equal(l.h.files.get(dest).toString('utf8'), expected);
  assert.ok(![...l.h.files.keys()].some((k) => k.includes('.woodshed-part-')), 'the parts are gone');
});
