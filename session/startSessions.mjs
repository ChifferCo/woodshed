// `woodshed-session` (session/bin/woodshed-session): Claude in a My Woodshed session hands a piece of work to a new
// session of the same person's, and follows how the ones it started are doing, through the console's session API
// (console/sessionStarts.mjs). It reads the session's start token from the file the entrypoint wrote (keepStartToken),
// which nothing's environment holds.
//
//   woodshed-session new [--separate] [--branch B] [--repo R] [--name N] [--agent claude|codex] [--model M] [--effort E]
//                        (--prompt-file F | "prompt" | - for stdin)
//   woodshed-session list [--all] [--json]
//   woodshed-session get <id> [--json]
//   woodshed-session send <id> ("message" | --prompt-file F | -) [--wait]
//   woodshed-session reply ("message" | --prompt-file F | -) [--wait]
//   woodshed-session wait <id> [--reply]
//   woodshed-session read <id> [--last N] [--since <time>]
//   woodshed-session stop <id> | resume <id>
//   woodshed-session rename [<id>] "<name>"

import fs from 'node:fs';

import { isMain } from '../shared/isMain.mjs';

export const START_TOKEN_FILE = '/tmp/woodshed-start-token';
const REQUEST_MS = 30_000;
// The console answers a wait within 4 minutes (sessionStarts.mjs, WAIT_MS): a little past that.
const WAIT_REQUEST_MS = 5 * 60_000;
const ID_RE = /^[0-9a-f]{8}$/;

export const USAGE = `Usage: woodshed-session <command>

Hand a piece of work to a new session of your person's, with its own branch, and follow the ones this session started.

Commands:
  new [options] (--prompt-file <file> | "<prompt>" | -)
                         start it. The prompt is all the new session knows: say what to do, the context and the files
                         it needs, and what done looks like. - reads it from stdin
      --branch <branch>  work on this branch, or a pull request or issue: 123, pr 123 (default: a new branch)
      --repo <project>   another of the console's repos, by its project name (default: this session's)
      --name <name>      its name on the console (default: named from the prompt)
      --separate         work of its own, not a piece of this session's: at the top of the rail, and not in list
      --agent claude|codex, --model <model>, --effort <effort>
  list                   the sessions this session started, with their state, branch, pull request and link
      --all              every private session of your person's, whoever started it
  get <id>               one of them
  send <id> ("<message>" | --prompt-file <file> | -)
                         type a message into another private session of your person's, at its prompt: held while it
                         works, waits in line or is paused. It sees who sent it and how to answer
      --wait             then wait for it to work on it, and print what it said
  reply ("<message>" | --prompt-file <file> | -) [--wait]
                         the same, to the session that started this one
  wait <id> [--reply]    until it is done, needs its person, or stopped (--reply: until it has worked on what was sent)
  read <id> [--last <n>] [--since <time>]
                         what it was asked and said, newest last (default the last 10)
  stop <id>, resume <id> as Stop and Resume on the console
  rename [<id>] "<name>" rename this session on the console, or another of your person's
  --json                 print the console's answer as JSON`;

class Refused extends Error {}

/** @returns {{command: string|null, args: string[], flags: object}} */
export function parseArgs(argv) {
  const [command = null, ...words] = argv;
  const flags = { json: false };
  const args = [];
  const takes = new Set(['--branch', '--repo', '--name', '--agent', '--model', '--effort', '--prompt-file', '--last', '--since']);
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === '--') {
      args.push(...words.slice(i + 1));
      break;
    }
    if (word === '--json') flags.json = true;
    else if (word === '--wait') flags.wait = true;
    else if (word === '--reply') flags.reply = true;
    else if (word === '--all') flags.all = true;
    else if (word === '--separate') flags.separate = true;
    else if (takes.has(word)) {
      if (i + 1 >= words.length) throw new Refused(`${word} needs a value`);
      flags[word.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = words[++i];
    } else if (word.startsWith('--')) throw new Refused(`unknown option ${word}`);
    else args.push(word);
  }
  return { command, args, flags };
}

/** @returns {string[]}  the lines `list` and `get` print for one session */
export function describe(s) {
  const state = s.status === 'running' && s.state ? `${s.status}, ${s.state}` : s.status;
  const lines = [`${s.id}  ${state}  ${s.title ?? ''}`.trimEnd(), `  ${s.url}`];
  const facts = [s.branch ? `branch ${s.branch}` : null, s.prUrl ? `PR ${s.prUrl}` : null, s.agent === 'codex' ? 'codex' : null].filter(Boolean);
  if (facts.length) lines.push(`  ${facts.join(', ')}`);
  if (s.error || s.stopReason) lines.push(`  ${s.error ? 'failed' : 'stopped'}: ${s.error ?? s.stopReason}`);
  if (s.lastMessage) lines.push(`  last: ${s.lastMessage.split('\n')[0].slice(0, 200)}`);
  if (s.tainted) lines.push('  has seen production data: what it says stays on the console');
  return lines;
}

/**
 * @param {{argv: string[], env: object, fetch?: typeof fetch, readFile?: (path: string) => string, stdin?: () => Promise<string>,
 *          stdout: {write: (t: string) => void}, stderr: {write: (t: string) => void}, tokenFile?: string}} io
 * @returns {Promise<number>}  the exit code: 0 done, 1 failed or refused, 2 usage
 */
export async function run({ argv, env, fetch: fetchFn = fetch, readFile = (p) => fs.readFileSync(p, 'utf8'), stdin = readStdin, stdout, stderr, tokenFile = env.WOODSHED_START_TOKEN_FILE || START_TOKEN_FILE }) {
  const say = (text) => stdout.write(`${text}\n`);
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    stderr.write(`woodshed-session: ${err.message}\n\n${USAGE}\n`);
    return 2;
  }
  const { command, args, flags } = parsed;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    say(USAGE);
    return command ? 0 : 2;
  }
  if (!['new', 'list', 'get', 'send', 'reply', 'wait', 'read', 'stop', 'resume', 'rename'].includes(command)) {
    stderr.write(`woodshed-session: unknown command ${command}\n\n${USAGE}\n`);
    return 2;
  }
  let token;
  try {
    token = readFile(tokenFile).trim();
  } catch {
    token = '';
  }
  if (!token) {
    stderr.write('woodshed-session: this session cannot start sessions: only a My Woodshed session can, and not one that has seen production data (or its image is from before woodshed-session)\n');
    return 1;
  }
  const origin = String(env.WOODSHED_CONSOLE_URL ?? '').replace(/\/+$/, '');
  if (!origin) {
    stderr.write('woodshed-session: WOODSHED_CONSOLE_URL is not set\n');
    return 1;
  }

  async function call(method, pathname, body, { timeoutMs = REQUEST_MS } = {}) {
    let res;
    try {
      res = await fetchFn(`${origin}${pathname}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new Refused(`could not reach the console: ${err.cause?.message ?? err.message}`);
    }
    let answer = null;
    try {
      answer = await res.json();
    } catch {
      // Said by the status below.
    }
    if (res.status === 404 && !answer?.error) throw new Refused('the console answered 404: a console from before sessions could start sessions');
    if (res.status >= 400) throw new Refused(answer?.error ? String(answer.error) : `the console answered ${res.status}`);
    return answer ?? {};
  }

  async function words2text(words, missing) {
    let said;
    if (flags.promptFile) {
      if (words.length) throw new Refused('give it as --prompt-file or as words, not both');
      try {
        said = readFile(flags.promptFile);
      } catch (err) {
        throw new Refused(`could not read ${flags.promptFile}: ${err.code ?? err.message}`);
      }
    } else if (words.length === 1 && words[0] === '-') said = await stdin();
    else said = words.join(' ');
    if (!said.trim()) throw new Refused(missing);
    return said;
  }

  // The console answers a wait at least every few minutes: ask again until it is over.
  async function waitFor(id, mode) {
    for (;;) {
      const answer = await call('GET', `/sessions/${id}/wait?for=${mode}`, null, { timeoutMs: WAIT_REQUEST_MS });
      if (!answer.waiting) return answer;
    }
  }

  async function waitAndRead(id, sentAt) {
    const { session, noReply, deliveredAt } = await waitFor(id, 'reply');
    // From when it went in: a message held behind a turn is answered after that turn, which is not its answer.
    const from = deliveredAt && deliveredAt > sentAt ? deliveredAt : sentAt;
    let entries = [];
    if (session.status === 'running' && !noReply) {
      try {
        ({ entries } = await call('GET', `/sessions/${id}/transcript?limit=50&since=${encodeURIComponent(from)}`));
      } catch (err) {
        if (!(err instanceof Refused)) throw err;
        say(`(its conversation was not read: ${err.message})`);
      }
    }
    const said = entries.filter((e) => e.role === 'assistant');
    if (flags.json) return say(JSON.stringify({ session, noReply: Boolean(noReply), said })), 0;
    say([...describe(session), ...waited(session, noReply)].join('\n'));
    if (said.length) say(said.map(entryLines).join('\n'));
    return 0;
  }

  try {
    if (command === 'list') {
      const { sessions = [] } = await call('GET', flags.all ? '/sessions?all=1' : '/sessions');
      if (flags.json) return say(JSON.stringify({ sessions })), 0;
      if (!sessions.length) say(flags.all ? 'Your person has no other private session.' : 'This session has started no sessions. list --all shows every session of your person\'s.');
      for (const s of sessions) say(describe(s).join('\n'));
      return 0;
    }
    if (command === 'get') {
      const [id] = args;
      if (!ID_RE.test(id ?? '') || args.length > 1) throw new Refused('give the id of one session: woodshed-session get <id>');
      const { session } = await call('GET', `/sessions/${id}`);
      say(flags.json ? JSON.stringify({ session }) : describe(session).join('\n'));
      return 0;
    }
    if (command === 'send' || command === 'reply') {
      let to;
      let words = args;
      if (command === 'send') {
        [to, ...words] = args;
        if (!ID_RE.test(to ?? '')) throw new Refused('give the id of a session of your person\'s: woodshed-session send <id> "<message>" (list --all shows them)');
      } else {
        const { startedFrom } = await call('GET', '/sessions');
        if (!startedFrom) throw new Refused('no session started this one: reply answers the session that started it');
        to = startedFrom.id;
      }
      const said = await words2text(words, 'give the message: in quotes, --prompt-file <file>, or - to read it from stdin');
      const sent = await call('POST', `/sessions/${to}/messages`, { text: said });
      if (flags.json && !flags.wait) return say(JSON.stringify(sent)), 0;
      say(sent.held ? `Held for session ${to}: it gets it once it is at its prompt (${sent.session?.status}${sent.session?.state ? `, ${sent.session.state}` : ''})`
        : `Sent to session ${to}${sent.unknown ? ' (the console did not hear back in time: it may have gone in)' : ''}`);
      if (!flags.wait) return say(`Wait for it with: woodshed-session wait ${to} --reply`), 0;
      return await waitAndRead(to, sent.sentAt);
    }
    if (command === 'wait') {
      const [id] = args;
      if (!ID_RE.test(id ?? '') || args.length > 1) throw new Refused('give the id of one session: woodshed-session wait <id>');
      const { session, noReply } = await waitFor(id, flags.reply ? 'reply' : 'settled');
      say(flags.json ? JSON.stringify({ session, noReply: Boolean(noReply) }) : [...describe(session), ...waited(session, noReply)].join('\n'));
      return 0;
    }
    if (command === 'read') {
      const [id] = args;
      if (!ID_RE.test(id ?? '') || args.length > 1) throw new Refused('give the id of one session: woodshed-session read <id>');
      const last = flags.last === undefined ? 10 : Number.parseInt(flags.last, 10);
      if (!(last > 0)) throw new Refused('--last is a number of entries');
      const since = flags.since ? new Date(flags.since) : null;
      if (since && Number.isNaN(since.getTime())) throw new Refused('--since is a time, as 2026-11-24T12:00:00Z');
      const { entries } = await call('GET', `/sessions/${id}/transcript?limit=${Math.max(last, 50)}${since ? `&since=${encodeURIComponent(since.toISOString())}` : ''}`);
      const shown = entries.slice(-last);
      if (flags.json) return say(JSON.stringify({ entries: shown })), 0;
      say(shown.length ? shown.map(entryLines).join('\n') : 'Nothing said yet.');
      return 0;
    }
    if (command === 'rename') {
      const [first, ...rest] = args;
      const other = ID_RE.test(first ?? '') && rest.length ? first : null;
      const name = (other ? rest : args).join(' ').trim();
      if (!name) throw new Refused('give the name: woodshed-session rename "<name>", or rename <id> "<name>" for another session');
      const { session } = await call('POST', other ? `/sessions/${other}/rename` : '/rename', { name });
      say(flags.json ? JSON.stringify({ session }) : `Renamed ${session.id}: ${session.title}`);
      return 0;
    }
    if (command === 'stop' || command === 'resume') {
      const [id] = args;
      if (!ID_RE.test(id ?? '') || args.length > 1) throw new Refused(`give the id of one session: woodshed-session ${command} <id>`);
      const { session } = await call('POST', `/sessions/${id}/${command}`, {});
      say(flags.json ? JSON.stringify({ session }) : describe(session).join('\n'));
      return 0;
    }
    const prompt = await words2text(args, 'give the new session its first prompt: --prompt-file <file>, the prompt in quotes, or - to read it from stdin');
    if (flags.agent && !['claude', 'codex'].includes(flags.agent)) throw new Refused('--agent is claude or codex');
    const { session } = await call('POST', '/sessions', {
      prompt, ...(flags.branch ? { branch: flags.branch } : {}), ...(flags.repo ? { project: flags.repo } : {}), ...(flags.name ? { name: flags.name } : {}),
      ...(flags.agent ? { agent: flags.agent } : {}), ...(flags.model ? { model: flags.model } : {}), ...(flags.effort ? { effort: flags.effort } : {}),
      ...(flags.separate ? { separate: true } : {}),
    });
    if (flags.json) return say(JSON.stringify({ session })), 0;
    say(`Started session ${session.id}${session.title ? `: ${session.title}` : ''}, ${session.separate ? 'on its own' : 'as part of this session\'s work'}`);
    say(`  ${session.url}`);
    say(`  branch ${session.branch ?? 'not named yet'}, ${session.status === 'queued' ? 'waiting in line (the person has as many running as the console allows)' : session.status}`);
    say(`Follow it with: woodshed-session get ${session.id}`);
    return 0;
  } catch (err) {
    if (!(err instanceof Refused)) throw err;
    stderr.write(`woodshed-session: ${err.message}\n`);
    return 1;
  }
}

/** @returns {string[]}  what a wait's end says beyond the session's own lines */
function waited(session, noReply) {
  if (noReply) return ['  it did not take up what was sent: nothing held for it, and it did not start working'];
  if (session.state === 'needs-you') return ['  it needs its person: a question or an approval on its screen'];
  return [];
}

/** @returns {string}  one entry of a conversation, as `read` prints it */
function entryLines(e) {
  const who = e.role === 'assistant' ? 'said' : 'asked';
  const at = e.at ? ` ${String(e.at).slice(11, 16)}` : '';
  return `[${who}${at}] ${e.text.trim()}`;
}

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

if (isMain(import.meta.url)) {
  // `woodshed-session list | head`: a reader that stops early is no failure of this command.
  process.stdout.on('error', (err) => {
    if (err.code === 'EPIPE') process.exit(process.exitCode ?? 0);
    throw err;
  });
  process.exitCode = await run({ argv: process.argv.slice(2), env: process.env, stdout: process.stdout, stderr: process.stderr });
}
