// `woodshed-session` (session/bin/woodshed-session): Claude in a My Woodshed session hands a piece of work to a new
// session of the same person's, and follows how the ones it started are doing, through the console's session API
// (console/sessionStarts.mjs). It reads the session's start token from the file the entrypoint wrote (keepStartToken),
// which nothing's environment holds.
//
//   woodshed-session new [--branch B] [--repo R] [--name N] [--agent claude|codex] [--model M] [--effort E]
//                        (--prompt-file F | "prompt" | - for stdin)
//   woodshed-session list [--json]
//   woodshed-session get <id> [--json]

import fs from 'node:fs';

import { isMain } from '../shared/isMain.mjs';

export const START_TOKEN_FILE = '/tmp/woodshed-start-token';
const REQUEST_MS = 30_000;
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
      --agent claude|codex, --model <model>, --effort <effort>
  list                   the sessions this session started, with their state, branch, pull request and link
  get <id>               one of them
  --json                 print the console's answer as JSON`;

class Refused extends Error {}

/** @returns {{command: string|null, args: string[], flags: object}} */
export function parseArgs(argv) {
  const [command = null, ...words] = argv;
  const flags = { json: false };
  const args = [];
  const takes = new Set(['--branch', '--repo', '--name', '--agent', '--model', '--effort', '--prompt-file']);
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === '--') {
      args.push(...words.slice(i + 1));
      break;
    }
    if (word === '--json') flags.json = true;
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
  if (!['new', 'list', 'get'].includes(command)) {
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

  async function call(method, pathname, body) {
    let res;
    try {
      res = await fetchFn(`${origin}${pathname}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_MS),
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

  try {
    if (command === 'list') {
      const { sessions = [] } = await call('GET', '/sessions');
      if (flags.json) return say(JSON.stringify({ sessions })), 0;
      if (!sessions.length) say('This session has started no sessions.');
      for (const s of sessions) say(describe(s).join('\n'));
      return 0;
    }
    if (command === 'get') {
      const [id] = args;
      if (!ID_RE.test(id ?? '') || args.length > 1) throw new Refused('give the id of one session this session started: woodshed-session get <id>');
      const { session } = await call('GET', `/sessions/${id}`);
      say(flags.json ? JSON.stringify({ session }) : describe(session).join('\n'));
      return 0;
    }
    let prompt;
    if (flags.promptFile) {
      if (args.length) throw new Refused('give the prompt as --prompt-file or as words, not both');
      try {
        prompt = readFile(flags.promptFile);
      } catch (err) {
        throw new Refused(`could not read ${flags.promptFile}: ${err.code ?? err.message}`);
      }
    } else if (args.length === 1 && args[0] === '-') prompt = await stdin();
    else prompt = args.join(' ');
    if (!prompt.trim()) throw new Refused('give the new session its first prompt: --prompt-file <file>, the prompt in quotes, or - to read it from stdin');
    if (flags.agent && !['claude', 'codex'].includes(flags.agent)) throw new Refused('--agent is claude or codex');
    const { session } = await call('POST', '/sessions', {
      prompt, ...(flags.branch ? { branch: flags.branch } : {}), ...(flags.repo ? { project: flags.repo } : {}), ...(flags.name ? { name: flags.name } : {}),
      ...(flags.agent ? { agent: flags.agent } : {}), ...(flags.model ? { model: flags.model } : {}), ...(flags.effort ? { effort: flags.effort } : {}),
    });
    if (flags.json) return say(JSON.stringify({ session })), 0;
    say(`Started session ${session.id}${session.title ? `: ${session.title}` : ''}`);
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
