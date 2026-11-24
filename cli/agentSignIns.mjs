// `woodshed sign-in push <grok|opencode> [--replace]`: this computer's own sign-in for Grok Build or OpenCode, from the
// file the agent's own login saved, sent to the console as My settings' Save would (POST /api/my/agent-auth/<agent>,
// console/cliSessions.mjs). `woodshed setup` offers it, and asks first (setup.mjs).
//
// The file's content is read, checked with the registry's checkSignIn (shared/agents.cjs) and sent over the command
// line's sign-in, and nothing else: it is never printed, logged or put in an error, here or in --json. A file that is
// not a sign-in is refused before anything is sent. One already saved on the console is replaced only with --replace.
//
// Where each agent keeps it, as the agent itself finds it:
//   Grok Build  $GROK_AUTH_PATH when set, else $GROK_HOME/auth.json, else <home>/.grok/auth.json, the home being HOME on
//               Unix and USERPROFILE on Windows (xai-org/grok-build: xai-dirs, and xai-grok-login's storage.rs)
//   OpenCode    $XDG_DATA_HOME/opencode/auth.json, else <home>/.local/share/opencode/auth.json, on macOS and Windows
//               too (anomalyco/opencode: packages/util/src/global-roots.ts)

import fs from 'node:fs';
import path from 'node:path';

import agents from '../shared/agents.cjs';

export const SIGN_IN_USAGE = `Usage: woodshed sign-in push <${agents.OWN_SIGN_IN_AGENTS.join('|')}> [--replace] [--console <url>] [--json]

Sends this computer's own sign-in for ${agents.OWN_SIGN_IN_AGENTS.map((id) => agents.agent(id).product).join(' or ')} to the console, as
your sign-in for that agent's private sessions, from the file its own login saved:
${agents.OWN_SIGN_IN_AGENTS.map((id) => `  ${id.padEnd(9)}${agents.agent(id).signIn.steps[0].command} saves it in ${defaultFileText(id)}`).join('\n')}
It is checked here first, and never printed. --replace replaces one the console has already.`;

function defaultFileText(id) {
  return id === 'grok' ? '~/.grok/auth.json (or $GROK_HOME/auth.json)' : '~/.local/share/opencode/auth.json (or $XDG_DATA_HOME/opencode/auth.json)';
}

/** "a Grok Build", "an OpenCode". */
export const aOr = (word) => `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`;

const nonEmpty = (value) => (typeof value === 'string' && value ? value : null);

/**
 * The file an agent's own login saves its sign-in in, on this computer.
 * @param {string} id  grok or opencode
 * @param {{env: object, home: string}} where  `home`: HOME on Unix, USERPROFILE on Windows (os.homedir())
 * @returns {string}
 */
export function signInFile(id, { env = {}, home }) {
  if (id === 'grok') {
    if (nonEmpty(env.GROK_AUTH_PATH)) return path.resolve(env.GROK_AUTH_PATH);
    return path.join(nonEmpty(env.GROK_HOME) ? path.resolve(env.GROK_HOME) : path.join(home, '.grok'), 'auth.json');
  }
  if (id === 'opencode') return path.join(nonEmpty(env.XDG_DATA_HOME) ?? path.join(home, '.local', 'share'), 'opencode', 'auth.json');
  throw new Error(`${id} has no sign-in file`);
}

/** The file as the person reads it: ~ for their home. */
export function shownFile(file, home) {
  const rel = path.relative(home, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? path.join('~', rel) : file;
}

/**
 * Reads and checks the sign-in file, never saying what is in it.
 * @returns {{file: string, found: false} | {file: string, found: true, value: string} | {file: string, found: true, problem: string}}
 *   `value`: as checkSignIn makes it, for the console alone. `problem`: why it is not one, in words of the registry's own
 */
export function readSignInFile(id, { env = {}, home }) {
  const file = signInFile(id, { env, home });
  const product = agents.agent(id).product;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { file, found: false };
    return { file, found: true, problem: `it could not be read (${err.code ?? 'error'})` };
  }
  if (!stat.isFile()) return { file, found: true, problem: 'it is not a file' };
  // Characters are at most 4 bytes each: anything larger is over the agent's limit whatever it holds.
  if (stat.size > agents.agent(id).signIn.maxChars * 4) return { file, found: true, problem: `that is too long for ${aOr(product)} sign-in` };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { file, found: true, problem: `it could not be read (${err.code ?? 'error'})` };
  }
  try {
    return { file, found: true, value: agents.checkSignIn(id, text) };
  } catch (err) {
    // checkSignIn's messages are its own fixed words, never the value: anything else is said by its kind alone.
    return { file, found: true, problem: err?.shown ? err.message : `it is not ${aOr(product)} sign-in` };
  }
}

/**
 * @param {{rest: string[], origin: string, token: string|null, env: object, home: string, json: boolean,
 *          call: Function, say: Function, emit: Function, EXIT: object, fail: Function}} ctx
 * @returns {Promise<number>}
 */
export async function signInCommand(ctx) {
  const { rest, origin, token, env, home, json, call, say, emit, EXIT, fail } = ctx;
  const words = rest.filter((word) => word !== '--replace');
  const replace = rest.includes('--replace');
  const [sub, id, ...extra] = words;
  if (sub === 'help' || !sub) {
    say(SIGN_IN_USAGE);
    return sub ? EXIT.done : EXIT.failed;
  }
  if (sub !== 'push' || !agents.OWN_SIGN_IN_AGENTS.includes(id) || extra.length || words.some((w) => w.startsWith('-'))) {
    throw fail(`usage: woodshed sign-in push <${agents.OWN_SIGN_IN_AGENTS.join('|')}> [--replace]`);
  }
  const { product } = agents.agent(id);
  const read = readSignInFile(id, { env, home });
  const shown = shownFile(read.file, home);
  if (!read.found) {
    throw fail(`No ${product} sign-in on this computer: ${shown} is not there. Run ${agents.agent(id).signIn.steps[0].command} first.`, { code: EXIT.waiting, status: 'no-file' });
  }
  if (read.problem) {
    throw fail(`${shown} is not ${aOr(product)} sign-in: ${read.problem}. Nothing was sent.`, { code: EXIT.refused, status: 'refused' });
  }
  if (!token) throw fail(`Not signed in to ${origin}. Run: woodshed login --console ${origin}`, { code: EXIT.waiting, status: 'signed-out' });

  // Whether the console runs the agent, and has one saved already: replaced only when asked.
  const me = await call(origin, '/api/cli/me', { token });
  if (me.status === 401) throw fail(`The sign-in to ${origin} ended. Run: woodshed login --console ${origin}`, { code: EXIT.waiting, status: 'signed-out' });
  if (me.status !== 200 || !me.body) throw fail(`${origin} answered ${me.status} for who is signed in. Nothing was sent.`);
  const saved = me.body.sessionSignIns?.[id];
  if (typeof saved !== 'boolean') throw fail(`${origin} does not run ${product} sessions. Nothing was sent.`, { code: EXIT.refused, status: 'refused' });
  if (saved && !replace) {
    throw fail(`${origin} has ${aOr(product)} sign-in of yours saved already. Nothing was sent: add --replace to replace it with ${shown}.`, { code: EXIT.refused, status: 'saved-already' });
  }

  const sent = await call(origin, `/api/my/agent-auth/${id}`, { method: 'POST', token, body: { value: read.value } });
  // Each status gets words of this command's own, and nothing of the console's answer: a gateway, or a console other than
  // Woodshed's, could echo the sign-in back in its error, and no check of the echo catches a short key for certain. The
  // console's own log says why it refused.
  if (sent.status === 401) throw fail(`The sign-in to ${origin} ended. Run: woodshed login --console ${origin}`, { code: EXIT.waiting, status: 'signed-out' });
  if (sent.status === 403 || sent.status === 404) {
    throw fail(`${origin} did not take it (${sent.status}): a console from before the command line could save a sign-in. Save it on My settings.`, { code: EXIT.refused, status: 'refused' });
  }
  if (sent.status === 413) throw fail(`${origin} refused it (413): it is larger than the console takes. Save it on My settings.`, { code: EXIT.refused, status: 'refused' });
  if (sent.status === 429) throw fail(`${origin} refused it (429): too many calls just now. Try again in a minute.`, { code: EXIT.refused, status: 'refused' });
  if (sent.status >= 400 && sent.status < 500) throw fail(`${origin} refused it (${sent.status}). Its log says why; or save it on My settings.`, { code: EXIT.refused, status: 'refused' });
  if (sent.status !== 200 || sent.body?.set !== true) throw fail(`${origin} answered ${sent.status}. Try again, or save it on My settings.`);
  // A timestamp, or nothing: never other text from the answer.
  const savedAt = typeof sent.body.savedAt === 'string' && ISO_TIME.test(sent.body.savedAt) ? sent.body.savedAt : null;
  if (json) emit({ event: 'sign-in', agent: id, file: read.file, console: origin, saved: true, replaced: saved, savedAt });
  say(`${saved ? 'Replaced' : 'Saved'} your ${product} sign-in on ${origin}, from ${shown}. Your next ${product} session uses it.`);
  return EXIT.done;
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
