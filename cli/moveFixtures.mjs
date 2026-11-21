// Stand-ins for `woodshed herdr move`'s tests (move*.test.mjs): a checkout with its GitHub, and Herdr's core and window.
// Not used by the command itself.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { gitRunner } from './moveCode.mjs';

export const GIT_ENV = { GIT_AUTHOR_NAME: 'Mia', GIT_AUTHOR_EMAIL: 'mia@example.com', GIT_COMMITTER_NAME: 'Mia', GIT_COMMITTER_EMAIL: 'mia@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

/**
 * A checkout of acme/app with a commit, and its "GitHub": a bare repo the remote's URL is rewritten to, as a person's
 * git config might. Returns the git runner the move uses.
 */
export function repoFor(t, { name = 'acme/app' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-move-code-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, ...GIT_ENV };
  const sh = (args, cwd) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  const bare = path.join(dir, 'github.git');
  sh(['init', '-q', '--bare', '-b', 'main', bare], dir);
  const root = path.join(dir, 'app');
  fs.mkdirSync(root);
  sh(['init', '-q', '-b', 'main'], root);
  sh(['remote', 'add', 'origin', `https://github.com/${name}.git`], root);
  sh(['config', `url.${bare}.insteadOf`, `https://github.com/${name}.git`], root);
  fs.writeFileSync(path.join(root, 'README.md'), '# app\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.env\nnode_modules/\n');
  fs.mkdirSync(path.join(root, 'services', 'api'), { recursive: true });
  fs.writeFileSync(path.join(root, 'services', 'api', 'index.js'), 'console.log(1);\n');
  sh(['add', '-A'], root);
  sh(['commit', '-q', '-m', 'first'], root);
  sh(['push', '-q', 'origin', 'main'], root);
  return { dir, root, bare, sh, git: gitRunner({ env }) };
}

/**
 * Herdr as `woodshed herdr move` drives it: hc's core (this computer's terminals, and each machine's), the app's window with
 * its spaces, tabs and splits per machine, and the files and commands sent to machines. Programs are made up: a
 * terminal's foreground is what its argv says, a claude says it is idle once it opens, `/exit` ends it.
 */
export function fakeHerdr({ window = true, machines = {}, onMachineAdd = () => {} } = {}) {
  let clock = 1_000;
  let seq = 0;
  const terminals = new Map();
  const spaces = [];
  const files = new Map();
  const calls = [];
  const ok = (answer) => ({ code: 0, stdout: `${JSON.stringify(answer)}\n`, stderr: '' });
  const err = (kind, message, code = 1) => ({ code, stdout: `${JSON.stringify({ error: { kind, message } })}\n`, stderr: '' });
  const machineOf = (address) => (address.includes('/') ? address.split('/')[0] : null);
  const program = (argv) => {
    const line = argv.join(' ');
    const exec = /exec (.*)$/.exec(line)?.[1] ?? line;
    if (/claude/.test(exec)) return { name: 'claude', argv: exec.split(' '), status: { state: 'idle', app: 'claude-code' } };
    if (/codex/.test(exec)) return { name: 'codex', argv: exec.split(' '), status: null };
    if (/^(\/bin\/)?(ba|z)?sh( -l)?$/.test(exec) || exec === '') return { name: 'bash', argv: ['bash', '-l'], status: null };
    return { name: exec.split(' ')[0].replace(/^'|'$/g, ''), argv: exec.split(' '), status: null };
  };
  /** A terminal on a machine (null: this computer), running argv in cwd. */
  const add = ({ machine = null, argv = ['bash', '-l'], cwd = '/', name = null, labels = {}, foreground = null, status = undefined, statusMs = null }) => {
    const n = [...terminals.keys()].filter((a) => machineOf(a) === machine).length + 1;
    const address = machine ? `${machine}/t${n}` : `t${n}`;
    const p = program(argv);
    terminals.set(address, {
      address, argv, cwd, name, labels: { ...labels }, state: 'live', keep: true,
      foreground: foreground ?? { name: p.name, argv: p.argv, cwd, pid: 100 + n },
      status: status === undefined ? p.status : status, status_ms: statusMs ?? (p.status ? ++clock : null),
    });
    return address;
  };
  const find = (address) => terminals.get(address) ?? [...terminals.values()].find((t) => t.name && (address === t.name || address.endsWith(`/${t.name}`) && machineOf(address) === machineOf(t.address)));
  const id = (prefix) => `${prefix}${(++seq).toString(16).padStart(4, '0')}`;
  const qualify = (machine, x) => (machine ? `${machine}/${x}` : x);
  const tabOf = (pane) => {
    for (const s of spaces) for (const t of s.tabs) if (t.panes.some((p) => p.pane === pane)) return { space: s, tab: t };
    return null;
  };
  const leafSwap = (node, a, b) => {
    if (node.pane) {
      if (node.pane === a) return { ...node, pane: b };
      if (node.pane === b) return { ...node, pane: a };
      return node;
    }
    return { ...node, children: node.children.map((c) => leafSwap(c, a, b)) };
  };
  const splitAt = (node, pane, direction, created) => {
    if (node.pane === pane) return { type: direction === 'down' ? 'column' : 'row', children: [node, { pane: created }] };
    if (node.pane) return node;
    const type = direction === 'down' ? 'column' : 'row';
    const at = node.children.findIndex((c) => c.pane === pane);
    if (at >= 0 && node.type === type) return { ...node, children: [...node.children.slice(0, at + 1), { pane: created }, ...node.children.slice(at + 1)] };
    return { ...node, children: node.children.map((c) => splitAt(c, pane, direction, created)) };
  };
  const without = (node, pane) => {
    if (node.pane) return node.pane === pane ? null : node;
    const children = node.children.map((c) => without(c, pane)).filter(Boolean);
    return children.length === 1 ? children[0] : { ...node, children };
  };
  const newPane = (machine, argv, cwd) => {
    const terminal = add({ machine, argv: argv ?? ['bash', '-l'], cwd: cwd ?? '/' });
    return { pane: id('p'), terminal };
  };

  const hc = async (args, { input = null } = {}) => {
    calls.push({ args, ...(input ? { input: Buffer.from(input) } : {}) });
    const [first, second] = args;
    if (first === '--version') return { code: 0, stdout: 'hc 0.1.21\n', stderr: '' };
    if (first === 'ls') return ok({ terminals: [...terminals.values()].map((t) => ({ address: t.address, state: t.state, cwd: t.cwd })) });
    if (first === 'get') {
      const t = find(args.at(-1));
      return t ? ok(t) : err('not_found', `no terminal "${args.at(-1)}"`, 3);
    }
    if (first === 'connect') {
      // The app's layout document of this computer.
      const block = (node, s) => (node.pane ? { type: 'block', id: node.pane, content: { terminal: s.tabs.flatMap((t) => t.panes).find((p) => p.pane === node.pane).terminal } }
        : { type: node.type, children: node.children.map((c) => block(c, s)) });
      const value = { spaces: spaces.filter((s) => !s.machine).map((s) => ({ id: s.id, name: s.name, folder: s.folder, tabs: s.tabs.map((t) => ({ id: t.id, name: t.name, root: block(t.tree, s) })) })) };
      return { code: 0, stdout: `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { value, version: 3 } })}\n`, stderr: '' };
    }
    if (first === 'label') {
      const t = find(args[2]);
      if (!t) return err('not_found', `no terminal "${args[2]}"`, 3);
      for (const kv of args.slice(3)) {
        const [k, v] = kv.split(/=(.*)/s);
        t.labels[k] = v;
      }
      // The app adopts a labelled terminal: into its space and tab, made when the id is new, the last of its row.
      const machine = machineOf(t.address);
      if (window && t.labels['herdr.space'] && t.labels['herdr.tab']) {
        const sid = qualify(machine, t.labels['herdr.space']);
        const tid = qualify(machine, t.labels['herdr.tab']);
        let s = spaces.find((x) => x.id === sid);
        if (!s) spaces.push(s = { id: sid, name: '', machine, folder: t.cwd, tabs: [] });
        let tab = s.tabs.find((x) => x.id === tid);
        const pane = id('p');
        if (!tab) s.tabs.push(tab = { id: tid, name: '', panes: [], tree: { pane } });
        else tab.tree = tab.tree.type === 'row' ? { ...tab.tree, children: [...tab.tree.children, { pane }] } : { type: 'row', children: [tab.tree, { pane }] };
        tab.panes.push({ pane, terminal: t.address });
      }
      return ok(t);
    }
    if (first === 'send') {
      const address = args.filter((a) => !a.startsWith('--') && a !== 'idle').at(-2);
      const text = args.at(-1);
      const t = find(address);
      if (!t) return err('not_found', `no terminal "${address}"`, 3);
      if (/^\/(exit|quit)$/.test(text)) {
        if (!machineOf(t.address)) Object.assign(t, { state: 'finished', foreground: null, status: null });
        else t.foreground = { name: 'bash', argv: ['bash', '-l'], cwd: t.cwd, pid: 1 };
      } else {
        const p = program(['bash', '-lc', `exec ${text}`]);
        t.foreground = { name: p.name, argv: p.argv, cwd: t.cwd, pid: 2 };
        if (p.status) Object.assign(t, { status: p.status, status_ms: ++clock });
      }
      return ok({ sent: true });
    }
    if (first === 'kill') {
      const t = find(args.at(-1));
      if (t) Object.assign(t, { state: 'finished', foreground: null });
      return ok(t ?? {});
    }
    if (first === 'exec') {
      const machine = args[args.indexOf('--on') + 1];
      const argv = args.slice(args.indexOf('--') + 1);
      const m = machines[machine];
      if (!m) return err('unreachable', `${machine} is not reachable`);
      const out = m.exec?.(argv) ?? { code: 0, stdout: '' };
      return ok({ code: out.code, stdout: Buffer.from(out.stdout ?? '').toString('base64'), stderr: Buffer.from(out.stderr ?? '').toString('base64') });
    }
    if (first === 'file' && second === 'write') {
      const machine = args[args.indexOf('--on') + 1];
      if (!machines[machine]) return err('unreachable', `${machine} is not reachable`);
      files.set(`${machine}:${args.at(-1)}`, Buffer.from(input ?? ''));
      return ok({ bytes: Buffer.byteLength(input ?? ''), path: args.at(-1) });
    }
    if (first === 'run') {
      const machine = args[args.indexOf('--on') + 1];
      const labels = {};
      args.forEach((a, i) => { if (a === '--label') { const [k, v] = args[i + 1].split('='); labels[k] = v; } });
      const cwd = args.includes('--cwd') ? args[args.indexOf('--cwd') + 1] : '/';
      const address = add({ machine, argv: args.slice(args.indexOf('--') + 1), cwd, labels });
      return ok({ address });
    }
    if (first === 'machine' && second === 'ls') return ok({ machines: Object.keys(machines).filter((m) => machines[m].added).map((name) => ({ name, via: true, target: machines[name].via, state: 'connected' })) });
    if (first === 'machine' && second === 'add') {
      const name = args[args.indexOf('--name') + 1];
      machines[name] ??= {};
      Object.assign(machines[name], { added: true, via: args[args.indexOf('--via') + 1] });
      onMachineAdd(name);
      return ok({ name, state: 'connected' });
    }
    if (first === 'machine' && second === 'rm') {
      if (machines[args.at(-1)]) machines[args.at(-1)].added = false;
      return ok({ removed: args.at(-1) });
    }
    return err('usage', `unexpected hc ${args.join(' ')}`);
  };

  const app = async (args) => {
    calls.push({ app: args });
    if (!window) return { code: 2, stdout: '', stderr: 'herdr-app: no Herdr window at /x/herdr-app.sock\n' };
    if (args[0] === 'ls') {
      return ok({ spaces: spaces.map((s) => ({ id: s.id, name: s.name, machine: s.machine, tabs: s.tabs.map((t) => ({ id: t.id, name: t.name, terminals: t.panes.map((p) => ({ terminal: p.terminal, pane: p.pane })) })) })) });
    }
    const [, command, body] = args;
    const a = JSON.parse(body);
    if (command === 'space.new') {
      const machine = a.machine || null;
      const s = { id: qualify(machine, id('sp')), name: a.name ?? '', machine, folder: a.folder ?? null, tabs: [] };
      const p = newPane(machine, a.argv, a.folder);
      const tab = { id: qualify(machine, id('tb')), name: a.tab ?? '', panes: [p], tree: { pane: p.pane } };
      s.tabs.push(tab);
      spaces.push(s);
      return ok({ space: s.id, tab: tab.id, terminal: p.terminal });
    }
    if (command === 'tab.new') {
      const s = spaces.find((x) => x.id === a.space);
      const p = newPane(s.machine, a.argv, a.folder);
      const tab = { id: qualify(s.machine, id('tb')), name: a.name ?? '', panes: [p], tree: { pane: p.pane } };
      s.tabs.push(tab);
      return ok({ space: s.id, tab: tab.id, terminal: p.terminal });
    }
    if (command === 'pane.split') {
      const at = tabOf(a.pane);
      const p = newPane(at.space.machine, a.argv, null);
      at.tab.panes.push(p);
      at.tab.tree = splitAt(at.tab.tree, a.pane, a.direction, p.pane);
      return ok({ pane: p.pane, terminal: p.terminal });
    }
    if (command === 'pane.swap') {
      const at = tabOf(a.pane);
      at.tab.tree = leafSwap(at.tab.tree, a.pane, a.target);
      return ok({ ok: true });
    }
    if (command === 'pane.close') {
      const at = tabOf(a.pane);
      const t = terminals.get(at.tab.panes.find((p) => p.pane === a.pane).terminal);
      Object.assign(t, { state: 'finished', foreground: null });
      at.tab.panes = at.tab.panes.filter((p) => p.pane !== a.pane);
      at.tab.tree = without(at.tab.tree, a.pane);
      return ok({ ok: true });
    }
    if (command === 'space.close') {
      const at = spaces.findIndex((s) => s.id === a.id);
      if (at < 0) return { code: 1, stdout: '{"error":"no such space"}', stderr: '' };
      for (const t of spaces[at].tabs.flatMap((x) => x.panes)) Object.assign(terminals.get(t.terminal), { state: 'finished', foreground: null });
      spaces.splice(at, 1);
      return ok({ ok: true });
    }
    return { code: 1, stdout: `{"error":"unknown command ${command}"}`, stderr: '' };
  };

  // A machine's tab as the move left it: its tree, each leaf the terminal's address and what it runs.
  const shape = (spaceId) => {
    const s = spaces.find((x) => x.id === spaceId);
    const draw = (node, tab) => {
      if (node.pane) {
        const t = terminals.get(tab.panes.find((p) => p.pane === node.pane).terminal);
        return `${t.address}:${t.foreground?.name ?? 'ended'}`;
      }
      return { [node.type]: node.children.map((c) => draw(c, tab)) };
    };
    return { name: s.name, tabs: s.tabs.map((t) => ({ name: t.name, tree: draw(t.tree, t) })) };
  };

  return {
    hc, app, calls, terminals, spaces, files, add, shape,
    /** A space here, as the app makes one: its tabs, each a row or a column of terminals or of nested splits. */
    space(name, tabs) {
      const s = { id: id('sp'), name, machine: null, folder: null, tabs: [] };
      const build = (node, tab) => {
        if (typeof node === 'string') {
          const pane = id('p');
          tab.panes.push({ pane, terminal: node });
          terminals.get(node).labels['herdr.space'] = s.id;
          terminals.get(node).labels['herdr.tab'] = tab.id;
          return { pane };
        }
        const [type, children] = Object.entries(node)[0];
        return { type, children: children.map((c) => build(c, tab)) };
      };
      for (const [tabName, tree] of tabs) {
        const tab = { id: id('tb'), name: tabName, panes: [] };
        tab.tree = build(tree, tab);
        s.tabs.push(tab);
      }
      spaces.push(s);
      return s;
    },
  };
}

