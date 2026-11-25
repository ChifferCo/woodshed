import { isolatedEnv } from '../test/isolatedEnv.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { argvOf, commandName, COMMANDS, refusedValue, sessionOptions } from './commands.mjs';
import { main } from './woodshed.mjs';

// What a command prints for --help, and the command line's own.
async function help(...words) {
  let text = '';
  await main([...words, '--help'], { stdout: { write: (s) => { text += s; } }, stderr: { write: () => {} }, env: isolatedEnv() });
  return text;
}

test('every command the help lists is in the catalogue, and every entry is in its help', async () => {
  const top = await help();
  const listed = [...top.split('Options:')[0].matchAll(/^ {2}([a-z][a-z-]*)\b/gm)].map((m) => m[1]);
  const names = new Set(COMMANDS.map(commandName));
  const firsts = new Set(COMMANDS.map((e) => e.path[0]));
  for (const word of listed) assert.ok(firsts.has(word), `woodshed ${word} is in the help but not in commands.mjs`);
  for (const sub of [...(await help('session')).matchAll(/^ {2}([a-z]+)\b/gm)].map((m) => m[1])) {
    assert.ok([...names].some((n) => n.startsWith(`session ${sub}`)), `woodshed session ${sub} is in its help but not in commands.mjs`);
  }
  for (const group of ['review', 'config', 'repo']) {
    const text = await help(group);
    for (const entry of COMMANDS.filter((e) => e.path[0] === group && e.path[1] && !e.path[1].startsWith('<'))) {
      assert.match(text, new RegExp(`\\b${entry.path[1]}\\b`), `${commandName(entry)} is not in woodshed ${group} --help`);
    }
  }
  for (const entry of COMMANDS) assert.ok(firsts.has(entry.path[0]) && listed.includes(entry.path[0]), `${commandName(entry)} is not in woodshed --help`);
});

test('each option the catalogue names is in its command\'s help', async () => {
  const top = await help();
  for (const entry of COMMANDS) {
    const own = ['session', 'review', 'config', 'repo', 'move', 'setup', 'sign-in'].includes(entry.path[0]) ? await help(entry.path[0]) : '';
    for (const o of entry.options ?? []) {
      assert.ok(`${own}\n${top}`.includes(`--${o.name}`), `--${o.name} of ${commandName(entry)} is not in its help`);
    }
  }
});

test('the session parser takes the catalogue\'s options, and nothing else', () => {
  assert.deepEqual(sessionOptions('new'), {
    values: ['repo', 'branch', 'agent', 'model'], flags: ['no-wait', 'connect', 'herdr', 'no-notify', 'end-with-parent'], optional: ['parent'],
  });
  assert.deepEqual(sessionOptions('app').values, ['app', 'members', 'hours', 'path', 'revoke']);
  assert.deepEqual(sessionOptions('app').flags, ['no-wait', 'link']);
});

// A value for each argument and option, as a person would give it.
const SAMPLE = {
  id: 'aaaa0001', repo: 'acme/app', line: 'true', prompt: 'fix it', message: 'look', key: 'terminal', value: 'tmux', target: 'aaaa0001', pulls: ['12'],
  branch: 'main', model: 'opus', effort: 'high', mode: 'auto', name: 'app2', app: 'web', path: '/a', revoke: 'aaaa0002', 'idle-hours': '2',
  'lifetime-hours': '3', kind: 'review,qa', every: '15', terminal: 't3', tab: 'main', space: 'api', to: 'new', rerun: '[qa]', dir: '.', only: ['skills'],
  'own-files': '.', wait: '5m', reviews: 'both', 'review-prs': 'none', from: 'herdr', note: '-what is left', agent: 'claude',
};
// A value that is the command's own form, where the one above is not.
const SAMPLE_FOR = { 'session connect': { agent: 'agent-2' } };
// What a command needs besides the option under test, for its parser to take it.
const BASE = { move: { from: 'herdr', to: 'new', space: 'api' }, 'session agent stop': {}, 'sign-in push': { agent: 'grok' }, 'session agent': { agent: undefined } };
// What the parsers say when they do not take the words: never what a test of the catalogue's own sees.
const PARSE_FAILED = /unknown option|Unknown setup option|unexpected |needs a value|takes no value|goes with|is for |takes one of|takes a session id|takes one session id|Usage:|too many words/;

test('every parser takes each of its command\'s options, as argvOf writes them', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'commands-'));
  try {
    for (const entry of COMMANDS) {
      const name = commandName(entry);
      const required = Object.fromEntries((entry.args ?? []).filter((a) => !a.optional).map((a) => [a.name, SAMPLE[a.name]]));
      if (name === 'session agent stop') required.agent = 'agent-2';
      if (name === 'sign-in push') required.agent = 'grok';
      const runs = [{}, ...(entry.options ?? []).map((o) => ({ [o.name]: o.values ? o.values[0] : !o.value || o.optional ? true : SAMPLE_FOR[name]?.[o.name] ?? SAMPLE[o.name] }))];
      for (const extra of runs) {
        const [option] = Object.keys(extra);
        const spec = entry.options?.find((o) => o.name === option);
        const base = { ...(BASE[name] ?? {}) };
        if (name === 'move' && (option === 'terminal' || option === 'tab')) delete base.space;
        // What it goes with, and what that goes with.
        const withs = [...(spec?.with ?? [])];
        while (withs.length) {
          const next = withs.shift();
          const other = entry.options.find((o) => o.name === next);
          base[other.name] = other.values ? other.values[0] : other.value && !other.optional ? SAMPLE[other.name] : true;
          withs.push(...(other.with ?? []));
        }
        if (option === 'replace' && name === 'settings plan') base.pull = true;
        for (const o of entry.options ?? []) if (o.required && base[o.name] === undefined) base[o.name] = o.values ? o.values[0] : SAMPLE[o.name] ?? 'claude';
        const args = Object.fromEntries(Object.entries({ ...base, ...required, ...extra }).filter(([, v]) => v !== undefined));
        const argv = argvOf(entry, args, ['--console', 'http://127.0.0.1:9', '--json']);
        let out = '';
        let err = '';
        await main(argv, {
          env: isolatedEnv({ HOME: home, XDG_CONFIG_HOME: home }), home, token: 'wsc_test', isTerminal: false, cwd: home,
          stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, stdin: { isTTY: false, on() {}, resume() {}, pause() {}, destroy() {} },
          fetch: async () => new Response('{"error":"no"}', { status: 401, headers: { 'content-type': 'application/json' } }),
          sleep: async () => {}, openBrowser: () => {}, hc: async () => ({ code: null, stdout: '', stderr: '', missing: true }),
          confirm: async () => false, interactive: false,
        });
        assert.doesNotMatch(`${out}\n${err}`, PARSE_FAILED, `woodshed ${argv.join(' ')}`);
      }
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('argvOf checks each value, keeps free text after --, and never writes an option from a value', () => {
  const byName = (n) => COMMANDS.find((e) => commandName(e) === n);
  assert.deepEqual(argvOf(byName('session new'), { prompt: '--help me', repo: 'acme/app', 'no-wait': true }, ['--json']),
    ['session', 'new', '--repo=acme/app', '--no-wait', '--json', '--', '--help me']);
  assert.deepEqual(argvOf(byName('session agent'), { id: 'aaaa0001', message: 'go' }), ['session', 'agent', '--', 'aaaa0001', 'go']);
  assert.deepEqual(argvOf(byName('session agent stop'), { id: 'aaaa0001', agent: 'agent-3' }), ['session', 'agent', 'aaaa0001', 'stop', 'agent-3']);
  assert.deepEqual(argvOf(byName('repo add'), { repo: 'acme/app', name: 'app2' }), ['repo', 'add', 'acme/app', '--name', 'app2']);
  assert.deepEqual(argvOf(byName('config set'), { key: 'github-name', value: '-mia-' }), ['config', 'set', 'github-name', '--', '-mia-']);
  assert.deepEqual(argvOf(byName('review start'), { pulls: ['12', '#15'], repo: 'acme/app' }), ['review', 'start', '12', '#15', '--repo=acme/app']);
  assert.deepEqual(argvOf(byName('setup'), { repo: ['a/b', 'c/d'], 'grok-sign-in': 'replace', prompt: '--x' }), ['setup', '--repo=a/b', '--repo=c/d', '--grok-sign-in=replace', '--prompt=--x']);
  assert.throws(() => argvOf(byName('session get'), { id: '--yes' }), /id must be a value that is not an option/);
  assert.throws(() => argvOf(byName('session get'), { id: 'nope' }), /id is not in the form it takes/);
  assert.throws(() => argvOf(byName('session new'), { branch: '--connect' }), /branch must be a value that is not an option/);
  assert.throws(() => argvOf(byName('session new'), { shell: true }), /session new takes no shell/);
  assert.throws(() => argvOf(byName('session handoff'), { id: 'aaaa0001' }), /session handoff needs --agent/);
  assert.deepEqual(argvOf(byName('session handoff'), { id: 'aaaa0001', agent: 'codex', note: '-fix the rest' }), ['session', 'handoff', 'aaaa0001', '--agent=codex', '--note=-fix the rest']);
  assert.throws(() => argvOf(byName('session new'), { 'no-notify': true }), /--no-notify goes with --parent/);
  assert.throws(() => argvOf(byName('session agent'), { id: 'aaaa0001', message: 'stop' }), /message is not one it takes/);
  assert.equal(refusedValue({ name: 'line', text: true }, 'a\u0000b'), 'line must be text');
});

test('what the catalogue says of where each command runs and what it changes', () => {
  for (const entry of COMMANDS) {
    assert.ok(['read', 'change', 'destructive'].includes(entry.effect), commandName(entry));
    assert.ok([undefined, null, 'computer', 'terminal'].includes(entry.needs), commandName(entry));
    if (entry.needs) assert.ok(entry.why, `${commandName(entry)} says why it needs the person's ${entry.needs}`);
    for (const a of entry.args ?? []) if (entry.path.includes(`<${a.name}>`)) assert.ok(!a.text && !a.optional, `${commandName(entry)}'s ${a.name}`);
  }
  // Ending, removing or handing something to others is the person's to say.
  for (const name of ['session stop', 'session remove', 'session app share', 'move', 'logout', 'repo remove', 'session agent stop']) {
    assert.equal(COMMANDS.find((e) => commandName(e) === name).effect, 'destructive', name);
  }
});
