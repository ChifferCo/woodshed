// `woodshed config`: your choices on the console's My settings page, read and set from the command line, through the
// page's own routes and their own checks (console/cliConfig.mjs lists the routes it reaches). Never a secret: the
// Claude token, the Codex sign-in, env values and your own files stay on My settings.
//
//   woodshed config list
//   woodshed config get <key>
//   woodshed config set <key> <value>

import { printable } from './sessions.mjs';

// Each key, the route that sets it, what it sends, and what it says after a change that does not reach a running
// session. `values` is what the command line offers; the console checks what it is sent, as it does the page's.
export const CONFIG_KEYS = Object.freeze({
  terminal: {
    values: ['tmux', 'herdr'],
    about: 'what your private sessions run their agent in',
    path: '/api/my/terminal',
    body: (value) => ({ terminal: value }),
    after: 'Your next private session starts in it; running ones keep theirs.',
  },
  reviews: {
    values: ['none', 'claude', 'codex', 'both', 'default'],
    about: 'who reviews your pull requests; default is the most this console can run',
    path: '/api/my/reviews',
    body: (value) => ({ choice: value === 'default' ? null : value }),
    after: 'It applies to the next review.',
  },
  'codex-reviews': {
    values: ['on', 'off'],
    about: 'reviews of your pull requests run Codex on your own sign-in (saved on My settings)',
    path: '/api/my/codex-auth/reviews',
    body: (value) => ({ on: value === 'on' }),
    after: 'It applies to the next review.',
  },
  'claude-token-shared': {
    values: ['on', 'off'],
    about: 'shared sessions you start from GitHub run on your own Claude token (saved on My settings)',
    path: '/api/my/claude-token/shared',
    body: (value) => ({ on: value === 'on' }),
    after: 'It applies to each shared session you start or resume from now on; running ones keep theirs.',
  },
  'default-repo': {
    values: null,
    hint: 'a repo you can start sessions on, as owner/name or its name on the console',
    about: 'the repo New session and woodshed session new open on',
    path: '/api/my/projects/default',
    body: (value) => ({ project: value }),
    after: null,
  },
  'github-name': {
    values: null,
    hint: 'one line, without < or >',
    about: 'the name your sessions\' commits say, once GitHub is connected on My settings',
    path: '/api/my/github/identity',
    body: (value, current) => ({ name: value, email: current['github-email'] }),
    after: 'Your next session commits with it.',
  },
  'github-email': {
    values: null,
    hint: 'an email address',
    about: 'the email your sessions\' commits say, once GitHub is connected on My settings',
    path: '/api/my/github/identity',
    body: (value, current) => ({ name: current['github-name'], email: value }),
    after: 'Your next session commits with it.',
  },
});

// What people may reach for that is, or holds, a secret: refused with a pointer to My settings, never sent.
const SECRET_KEYS = new Set([
  'claude-token', 'token', 'anthropic-api-key', 'codex-auth', 'codex-sign-in', 'codex', 'openai-api-key',
  'tmux-conf', 'tmux', 'env', 'env-files', 'files', 'own-files', 'instructions', 'repo-settings', 'tunnel-token',
]);

export const CONFIG_USAGE = `Usage: woodshed config <command> [--console <url>] [--json]

Your choices on the console's My settings page. Secrets (your Claude token, Codex sign-in, env values, files) are
never read or set here: save them on My settings.

Commands:
  list                    every choice and its value
  get <key>               one choice's value
  set <key> <value>       change it

Keys:
${Object.entries(CONFIG_KEYS).map(([key, k]) => `  ${key.padEnd(21)}${k.values ? k.values.join(' | ') : k.hint}\n  ${''.padEnd(21)}${k.about}`).join('\n')}

Exit codes: 0 done, 2 not signed in, 3 refused (an unknown key, a value that is not one, a secret, or a change My
settings needs first), 1 anything else.`;

// No message repeats what was typed and refused, key or value: a token or key typed in the wrong place must never land
// in a terminal's scrollback or an agent's captured output. The keys and valid values are listed instead.

/**
 * @param {{origin: string|null, rest: string[]}} args
 * @param {{call: Function, token: string|null, stdout: {write: Function}, say: (text: string) => void,
 *          emit: (o: object) => void, json: boolean, fail: (message: string, opts?: object) => Error, EXIT: object}} ctx
 * @returns {Promise<number>}  the exit code
 */
export async function configCommand({ origin, rest }, ctx) {
  const { call, say, emit, json, fail, EXIT } = ctx;
  const [sub, ...words] = rest;
  if (!sub || sub === 'help') {
    ctx.stdout.write(`${CONFIG_USAGE}\n`);
    return sub ? EXIT.done : EXIT.failed;
  }
  const refused = (message) => fail(message, { code: EXIT.refused, status: 'refused' });
  const settingsPage = () => `${origin}/settings`;
  const arity = { list: 0, get: 1, set: 2 };
  if (!Object.hasOwn(arity, sub)) throw fail(`not a config command: use list, get or set\n\n${CONFIG_USAGE}`);
  const shape = arity[sub];
  const [key, value] = words;
  // A secret's key first, before anything that could print what follows it: `config set env A=<key> B=<key>`.
  if (shape > 0 && key !== undefined && SECRET_KEYS.has(key.toLowerCase())) {
    throw refused(`${key.toLowerCase()} is a secret, or holds one: woodshed config never reads or sets one. Save it on My settings: ${settingsPage()}`);
  }
  if (words.length < shape) throw fail(`usage: woodshed config ${sub}${shape > 0 ? ' <key>' : ''}${shape > 1 ? ' <value>' : ''}`);
  if (words.length > shape) throw fail(`too many words for config ${sub}: put a value with spaces in quotes`);
  if (key !== undefined && !Object.hasOwn(CONFIG_KEYS, key)) throw refused(`not a config key. Keys: ${Object.keys(CONFIG_KEYS).join(', ')}`);
  const spec = key ? CONFIG_KEYS[key] : null;
  // A switch's on or off is turned into true or false here, so it is checked here; every other value the console checks,
  // as it does the page's.
  if (sub === 'set' && spec.values?.includes('on') && !spec.values.includes(value)) {
    throw refused(`not a value ${key} takes. Valid: ${spec.values.join(', ')}`);
  }
  if (!ctx.token) {
    if (json) emit({ event: 'error', status: 'signed-out', error: `not signed in to ${origin}` });
    say(`Not signed in to ${origin}. Run: woodshed login --console ${origin}`);
    return EXIT.waiting;
  }

  async function ask(pathname, { method = 'GET', body } = {}) {
    const out = await call(origin, pathname, { method, body, token: ctx.token });
    const why = printable(out.body?.error);
    if (out.status === 401) {
      throw fail(`The sign-in to ${origin} ended: ${why ?? 'it was revoked, or it expired'}. Run: woodshed login --console ${origin}`, { code: EXIT.waiting, status: 'signed-out' });
    }
    if (out.status === 404 && (method === 'GET' || !why)) throw fail(`${origin} answered 404: a console from before woodshed config`);
    if (out.status === 403 && /does not reach this/.test(why ?? '')) throw fail(`${origin} does not let the command line change ${key ?? 'settings'}: a console from before woodshed config`);
    if (out.status >= 400) return { refusal: { status: out.status, error: why ?? `${origin} answered ${out.status}` } };
    if (!out.body || typeof out.body !== 'object') throw fail(`${origin} answered ${out.status} with no JSON: not a Woodshed console`);
    return { body: out.body };
  }

  // What the console says, made printable: a key it does not know is left out, so a console never adds lines here.
  const view = (body) => Object.fromEntries(Object.keys(CONFIG_KEYS).map((k) => [k, printable(body[k]) ?? null]));

  const read = await ask('/api/cli/config');
  if (read.refusal) throw fail(read.refusal.error);
  const current = view(read.body);
  // What is sent back (the other half of the git identity) is the console's own text, never the printable copy: that
  // would save a mark printable() took out as a space.
  const stored = Object.fromEntries(Object.keys(CONFIG_KEYS).map((k) => [k, typeof read.body[k] === 'string' ? read.body[k] : null]));

  if (sub === 'list') {
    if (json) {
      emit({ console: origin, config: current });
      return EXIT.done;
    }
    for (const k of Object.keys(CONFIG_KEYS)) say(`${k.padEnd(21)}${current[k] ?? '(none)'}`);
    return EXIT.done;
  }
  if (sub === 'get') {
    if (json) emit({ key, value: current[key] });
    else say(current[key] ?? '');
    return EXIT.done;
  }

  let sent = value;
  if (key === 'default-repo') sent = await projectName(value);
  const out = await ask(spec.path, { method: 'POST', body: spec.body(sent, stored) });
  if (out.refusal) throw await refusalOf(out.refusal);
  const after = view(out.body);
  const changed = (out.body[key] ?? null) !== stored[key];
  const note = changed ? spec.after : null;
  if (json) emit({ event: 'set', key, value: after[key], changed, ...(note ? { note } : {}), config: after });
  else say(`${key} is ${after[key] ?? '(none)'}.${note ? ` ${note}` : ''}`);
  return EXIT.done;

  // default-repo takes owner/name, as session new's --repo does, or the console's name for it.
  async function projectName(typed) {
    const projects = await ask('/api/my/projects');
    if (projects.refusal) throw fail(projects.refusal.error);
    const list = Array.isArray(projects.body.projects) ? projects.body.projects : [];
    const wanted = typed.toLowerCase();
    const found = list.find((p) => String(p.repo ?? '').toLowerCase() === wanted) ?? list.find((p) => String(p.name ?? '').toLowerCase() === wanted);
    if (found?.name) return found.name;
    const yours = list.map((p) => printable(p.repo ?? p.name, 100)).join(', ') || 'none';
    throw refused(`You cannot start sessions on that repo on ${origin}: it is not one of its repos, or you have no write access to it. Valid: ${yours}`);
  }

  // The console's refusal, with what is valid: a value it does not take (400), or a step My settings needs first (409:
  // a token or sign-in to save, GitHub to connect).
  async function refusalOf({ status, error }) {
    if (status === 400) {
      const valid = spec.values ? spec.values.join(', ') : spec.hint;
      // The git identity is saved whole: a half with no value yet is what was refused, not what was typed.
      const other = { 'github-name': 'github-email', 'github-email': 'github-name' }[key];
      if (other && stored[other] === null) return refused(`${other} has no value yet, and the name and email are saved together: set both on My settings: ${settingsPage()}`);
      return refused(`not a value ${key} takes: ${error}. Valid: ${valid}`);
    }
    if (status === 409) return refused(`${error}. On My settings: ${settingsPage()}`);
    if (status === 403) return refused(error);
    return fail(error);
  }
}
