// Every command the command line runs, written once: what it takes, its help line and each option's, the checks a
// value passes, where it can run and what it changes. Its parsers read it (sessions.mjs, parseSessionArgs takes its
// options from here), commands.test.mjs holds the rest of the parsers and each command's --help to it, and a program
// that runs commands for someone else (api.mjs, and an MCP server built on it) builds its arguments, its descriptions
// and its own checks from it: a command added here is one such a program offers, with no second copy of it.
//
// An entry:
//   path      the command's words; `<name>` is filled from the argument of that name (`session app <id> start`)
//   about     what it does, in the help's words
//   args      positional arguments, in order: {name, about, check?, text?, list?, optional?}. `text` is free text, put after
//             `--` so no word of it is read as an option; `list` is one or more words
//   options   {name, about, value?, check?, values?, optional?, required?, with?, needs?, twoWords?}: `value` names what it
//             takes (a flag takes none), `values` the only ones it takes, `required` one the command needs,
//             `optional` a value it may go without (`--parent`),
//             `with` the options it goes with, and `twoWords` an option whose parser takes its value as the next word
//   needs     null: it runs wherever the command line's sign-in is. 'computer': it reads or changes the person's own
//             computer (its files, its Herdr, its browser). 'terminal': a person types into it
//   effect    'read', 'change', or 'destructive' (ends or removes something of the person's, or hands it to others):
//             a program asks the person before it runs one
//   waits     how it may last: 'start' (until a session runs), 'watch' (until stopped), 'line' (a tunnel's line),
//             'turn' (until a session's agent is done with its turn)
//   why       for one that needs the computer or a terminal, why it cannot run anywhere else
//
// An option or argument may need the computer or a terminal while its command does not (`session new --herdr`): a
// program that runs commands elsewhere leaves those out.

/** A session's id, as `session list` shows it. */
export const SESSION_ID = /^[0-9a-f]{8}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const PULL = /^(#?[0-9]{1,9}|https:\/\/[^\s\u0000-\u001f]{1,400})$/;
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HOURS = /^(default|[0-9]{1,4}(\.[0-9]{1,2})?)$/;
const KINDS = /^(private|shared|review|qa|ask)(,(private|shared|review|qa|ask))*$/;
const REVIEWERS = /^[a-z]+(\+[a-z]+)*$/;

const id = (about = 'the session, as woodshed session list shows it') => ({ name: 'id', about, check: SESSION_ID });
const repoOption = (about) => ({ name: 'repo', value: 'owner/name', about, check: REPO });
const PARENT = [
  { name: 'parent', value: 't', optional: true, with: ['herdr'], needs: 'computer', about: 'make its agent\'s terminal a child of a Herdr terminal here: this one (HC_TERMINAL_ID), or <t>' },
  { name: 'no-notify', with: ['parent'], needs: 'computer', about: 'with --parent: Herdr types no notes about the agent into its parent' },
  { name: 'end-with-parent', with: ['parent'], needs: 'computer', about: 'with --parent: the agent ends when its parent\'s program does' },
];
const HERDR_WHY = 'it works on Herdr\'s hc on the person\'s own computer';

export const COMMANDS = [
  {
    path: ['setup'], effect: 'change', needs: 'computer',
    about: 'get signed in, connect Claude Code and Codex, and have your open pull requests reviewed',
    why: 'it signs this computer in, reads its agents\' own sign-in files, and starts Herdr and a watch here; its console steps are commands of their own',
    options: [
      { name: 'yes', about: 'use the supplied options without asking questions' },
      { name: 'repo', value: 'owner/name', check: REPO, list: true, about: 'choose a repository (repeatable, first is used for the session)' },
      { name: 'agent', value: 'name', values: ['claude', 'codex'], about: 'claude or codex, when you use only one' },
      { name: 'reviews', value: 'choice', check: REVIEWERS, about: 'personal reviewer choice: none, claude, codex, both, default, or reviewers joined with +' },
      { name: 'review-prs', value: 'which', about: 'the open pull requests of yours to review now: all, none, or numbers separated by commas' },
      { name: 'grok-sign-in', optional: true, value: 'replace', values: ['replace'], about: 'save this computer\'s Grok Build sign-in as yours on My settings; =replace also replaces a saved one' },
      { name: 'opencode-sign-in', optional: true, value: 'replace', values: ['replace'], about: 'the same for OpenCode\'s' },
      { name: 'skip-reviews', about: 'skip the review check, your reviewer choice and reviews of your pull requests' },
      { name: 'terminal', value: 'name', values: ['herdr', 'tmux'], about: 'agent terminal for new private sessions' },
      { name: 'no-herdr-add', with: ['terminal'], about: 'with herdr: start the watch without --add' },
      { name: 'prompt', value: 'text', text: true, about: 'start a first coding session on this' },
      { name: 'no-session', about: 'finish without starting a session' },
      { name: 'wait', optional: true, value: 'Nm', check: /^[1-9][0-9]?m$/, about: 'wait for the sign-in\'s approval and for Claude Code or Codex to be connected' },
      { name: 'no-browser', needs: 'computer', about: 'print the address to open instead of opening it' },
    ],
  },
  {
    path: ['login'], effect: 'change', needs: 'computer', why: 'it keeps a token on this computer, in its keychain or the command line\'s own file',
    about: 'sign in to a Woodshed console: approve the code it shows in your browser; --no-wait returns before approval',
    options: [{ name: 'no-wait', about: 'return with the code, and collect the approval when run again' }, { name: 'no-browser', about: 'print the address to open instead of opening it' }],
  },
  { path: ['logout'], effect: 'destructive', needs: 'computer', why: 'it ends the token this computer keeps', about: 'sign out of the console, here and at the console' },
  { path: ['status'], effect: 'read', about: 'the console, its org, who is signed in, and the hc found here (Herdr\'s, for session herdr)' },
  { path: ['repo', 'list'], effect: 'read', about: 'the console\'s repos and which repos you can add' },
  {
    path: ['repo', 'add', '<repo>'], effect: 'change', about: 'add a repo, optionally with a different project name',
    args: [{ name: 'repo', about: 'the repo, owner/name', check: REPO }],
    options: [{ name: 'name', value: 'N', twoWords: true, check: NAME, about: 'a project name of its own, on consoles that let you choose one' }, { name: 'no-browser', needs: 'computer', about: 'print the link to grant GitHub App access instead of opening it' }],
  },
  { path: ['repo', 'remove', '<repo>'], effect: 'destructive', about: 'remove a repo from the console', args: [{ name: 'repo', about: 'the repo, owner/name', check: REPO }] },
  {
    path: ['tunnel', '<id>'], effect: 'destructive', waits: 'line',
    about: 'run <line> in your running session, with this command\'s stdin, stdout and stderr; exits with its exit code, or 255 when the pipe could not open or broke',
    args: [id(), { name: 'line', about: 'the shell line, run with sh -c in the session\'s checkout, at most 8 KB', text: true }],
  },
  {
    path: ['session', 'new'], effect: 'change', waits: 'start', about: 'start a private session, and wait until it runs, fails or needs you',
    args: [{ name: 'prompt', about: 'what the session\'s agent is asked to do', text: true, optional: true }],
    options: [
      // owner/name, or the project's name on a console that names projects (repo add --name).
      { name: 'repo', value: 'owner/name', about: 'the repo to work on (default: the one New session opens on for you)', check: /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9._-]+)?$/ },
      { name: 'branch', value: 'branch', about: 'work on this branch, or a pull request or issue: 123, pr 123, or its URL' },
      { name: 'agent', value: 'agent', check: /^[a-z][a-z0-9-]{0,31}$/, about: 'the agent it runs: claude, codex, grok, opencode (default claude)' },
      { name: 'model', value: 'model', about: 'the agent\'s model (default the agent\'s own)' },
      { name: 'no-wait', about: 'print the session and return once the console has it' },
      { name: 'connect', needs: 'terminal', about: 'once it runs, put this terminal on its agent\'s, as connect does' },
      { name: 'herdr', needs: 'computer', about: 'once it runs, add it to Herdr as herdr does' },
      ...PARENT,
    ],
  },
  {
    path: ['session', 'connect', '<id>'], effect: 'read', needs: 'terminal', why: 'it makes a terminal the session\'s agent\'s or shell, for a person to type into: a command in a session is a tunnel',
    about: 'put this terminal on one of your sessions\' agent (the console\'s TUI tab), or with --shell its shell (the Terminal tab)',
    args: [id()],
    options: [{ name: 'shell', about: 'its shell, the Terminal tab' }, { name: 'agent', value: 'agent-N', check: /^agent-[2-9]$/, about: 'the terminal of an agent started beside its own' }],
  },
  { path: ['session', 'agents', '<id>'], effect: 'read', about: 'the agents started beside one of your running sessions\' own, with their state', args: [id()] },
  {
    path: ['session', 'agent'], effect: 'change', about: 'start another agent in one of your running sessions, beside its own, in the same checkout, as the page\'s + Another agent does',
    // The id goes after `--` with the message, as the parser takes words there.
    args: [{ ...id(), text: true }, { name: 'message', about: 'the first message it is given', text: true, optional: true, check: /^(?!stop$)/s }],
    options: [
      { name: 'agent', value: 'agent', values: ['claude', 'codex'], about: 'which (default claude)' },
      { name: 'model', value: 'name', check: NAME, about: 'its model, as session new takes it' },
      { name: 'effort', value: 'level', check: NAME, about: 'its effort' },
      { name: 'mode', value: 'permissions', about: 'its permission mode (auto by default)' },
    ],
  },
  {
    path: ['session', 'send'], effect: 'change', waits: 'turn',
    about: 'type a message in at one of your running sessions\' agent, as the Chat tab\'s Send does; held while it works',
    // The id goes after `--` with the message, as the parser takes words there.
    args: [{ ...id(), text: true }, { name: 'message', about: 'what to say', text: true }],
    options: [{ name: 'wait', about: 'then wait until it has worked on it, and print what it said' }],
  },
  {
    path: ['session', 'rename'], effect: 'change',
    about: 'rename one of your sessions, as its title on the page does: the name every page shows',
    args: [{ ...id(), text: true }, { name: 'name', about: 'its new name', text: true }],
  },
  { path: ['session', 'wait', '<id>'], effect: 'read', waits: 'turn', about: 'until one of your sessions is done with its turn, needs you, or stops', args: [id()] },
  {
    path: ['session', 'read', '<id>'], effect: 'read',
    about: 'what one of your running sessions was asked and said, newest last; never one that has seen production data',
    args: [id()],
    options: [{ name: 'last', value: 'n', check: /^(100|[1-9][0-9]?)$/, about: 'how many of its latest messages, up to 100 (default 10)' }],
  },
  {
    path: ['session', 'agent', '<id>', 'stop', '<agent>'], effect: 'destructive', about: 'end one of them',
    args: [id(), { name: 'agent', about: 'the agent\'s id, agent-2 to agent-9, as session agents lists them', check: /^agent-[2-9]$/ }],
  },
  {
    path: ['session', 'herdr', '<id>'], effect: 'change', needs: 'computer', waits: 'start', why: HERDR_WHY,
    about: 'make one of your sessions a machine in Herdr, woodshed-<id>, reached through woodshed tunnel; a paused one is resumed first',
    args: [id()],
    options: PARENT.map((o) => ({ ...o, with: o.name === 'parent' ? [] : o.with })),
  },
  {
    path: ['session', 'list'], effect: 'read', about: 'your sessions and the shared ones you can see, with their state, kind and when each pauses or stops by itself',
    options: [{ name: 'all', about: 'also those that ended' }],
  },
  { path: ['session', 'get', '<id>'], effect: 'read', about: 'one session: its state, kind, branch, pull request, its app, and when it pauses or stops', args: [id()] },
  { path: ['session', 'app', '<id>'], effect: 'read', about: 'whether a running session\'s app is up, and its link to open in a browser', args: [id()] },
  {
    path: ['session', 'app', '<id>', 'start'], effect: 'change', about: 'start a running session\'s app (one to three minutes) and wait until it is up',
    args: [id()],
    options: [{ name: 'app', value: 'name', check: /^[a-z0-9][a-z0-9-]{0,31}$/, about: 'start this one of the project\'s apps, where it has several' }, { name: 'no-wait', about: 'return once the session has been asked to start it' }],
  },
  { path: ['session', 'app', '<id>', 'stop'], effect: 'destructive', about: 'stop a running session\'s app', args: [id()] },
  {
    path: ['session', 'app', '<id>', 'share'], effect: 'destructive',
    about: 'who besides you can open your session\'s app: the members switch and the live links (never a link\'s secret); one option at a time changes it',
    args: [id()],
    options: [
      { name: 'members', value: 'on|off', values: ['on', 'off'], about: 'every member signed in to the console may open it, or no longer' },
      { name: 'link', about: 'make a link anyone can open, printed once: a secret until it expires, is revoked, or the session pauses or stops' },
      { name: 'hours', value: '1|24|168', values: ['1', '24', '168'], with: ['link'], about: 'with --link: how long it lasts (default 24)' },
      { name: 'path', value: '/page', check: /^\/[^\s\u0000-\u001f]{0,499}$/, with: ['link'], about: 'with --link: the app\'s page it lands on' },
      { name: 'revoke', value: 'link id', check: SESSION_ID, about: 'end one link at once' },
    ],
  },
  { path: ['session', 'stop', '<id>'], effect: 'destructive', about: 'stop a session; a running one\'s work is pushed as it stops', args: [id()] },
  {
    path: ['session', 'resume', '<id>'], effect: 'change', waits: 'start', about: 'start one of your stopped sessions again, its conversation and all, and wait for it',
    args: [id()],
    options: [{ name: 'no-wait', about: 'return once the console has it' }, { name: 'herdr', needs: 'computer', about: 'once it runs, add it to Herdr again as herdr does' }],
  },
  {
    path: ['session', 'handoff', '<id>'], effect: 'destructive', waits: 'start',
    about: 'hand one of your running sessions\' work to another agent: it stops, pushing its work, and a new session starts on its branch with that agent, its conversation attached as a file; then wait for the new one as new does',
    args: [id()],
    options: [
      { name: 'agent', value: 'agent', required: true, check: /^[a-z][a-z0-9-]{0,31}$/, about: 'the agent the new session runs (required): claude, codex, grok or opencode' },
      { name: 'model', value: 'model', about: 'its model (default the agent\'s own)' },
      { name: 'note', value: 'text', text: true, about: 'what to tell the new agent first, such as what is left to do' },
      { name: 'no-conversation', about: 'leave the conversation behind: the new session starts from the branch and the note' },
      { name: 'no-wait', about: 'print the new session and return once the console has it' },
    ],
  },
  {
    path: ['session', 'remove', '<id>'], effect: 'destructive', about: 'take one of your sessions off the list, with its saved conversation (stopped first)',
    args: [id()],
    // The person's yes: a program asks them before it runs a destructive command, and passes it then.
    options: [{ name: 'yes', about: 'the person confirmed it' }],
  },
  { path: ['session', 'prune'], effect: 'destructive', needs: 'computer', why: HERDR_WHY, about: 'forget the woodshed-<id> machines in Herdr whose session is no longer on this console' },
  { path: ['session', 'extend', '<id>'], effect: 'change', about: 'put its pause or stop off by an hour; the console allows it in the last 15 minutes', args: [id()] },
  {
    path: ['session', 'limits', '<id>'], effect: 'change', about: 'its own idle pause and lifetime, in place of yours or the console\'s',
    args: [id()],
    options: [
      { name: 'idle-hours', value: 'n', check: HOURS, about: 'pause after this many hours with nothing to do; default goes back to yours' },
      { name: 'lifetime-hours', value: 'n', check: HOURS, about: 'stop this many hours after it started; default goes back to yours' },
    ],
  },
  {
    path: ['session', 'watch'], effect: 'read', waits: 'watch',
    about: 'follow the console and print one event per session that starts, runs, is done with its turn, needs you, pauses, stops, finishes or fails',
    options: [
      { name: 'kind', value: 'kinds', check: KINDS, about: 'only these, separated by commas: private, shared, review, qa, ask' },
      { name: 'everyone', about: 'every session you can see, not only Mine' },
      { name: 'every', value: 'seconds', check: /^[0-9]{1,3}$/, about: 'how often it asks the console (default 15, at least 5)' },
      { name: 'herdr', needs: 'computer', about: 'run it in Herdr instead, in hc terminal woodshed-watch, and return' },
      { name: 'add', needs: 'computer', about: 'also add each of your own private sessions to Herdr as it starts running or resumes' },
    ],
  },
  {
    path: ['move'], effect: 'destructive', needs: 'computer', why: 'it moves terminals, conversations and uncommitted work from the person\'s own Herdr and checkouts',
    about: 'move work into a session from a supported source',
    options: [
      { name: 'from', value: 'source', values: ['herdr'], about: 'move terminals from Herdr on this computer' },
      { name: 'terminal', value: 't', list: true, about: 'a terminal by address or name (hc ls); repeat it for more' },
      { name: 'tab', value: 'tab', about: 'every terminal of a tab, by id or name' },
      { name: 'space', value: 'space', about: 'every terminal of a space, by id or name' },
      { name: 'to', value: 'id|new', check: /^([0-9a-f]{8}|new)$/, about: 'one of your sessions on the same repo, or a new session for each repo' },
      { name: 'restart', value: 'when', values: ['ask', 'auto', 'never'], about: 'programs (a dev server): ask, auto, or never' },
      { name: 'dry-run', about: 'print what would move, and do nothing' },
    ],
  },
  {
    path: ['review', '<target>'], effect: 'change',
    about: 'review one of your sessions\' change: the analysis, the Q&A and the diff; with --json, or with no terminal, it prints the analysis and the diff\'s summary',
    args: [{ name: 'target', about: 'a session id, or a pull request (123, #123 or its URL) one of your sessions opened', check: new RegExp(`${SESSION_ID.source}|${PULL.source}`) }],
  },
  {
    path: ['review', 'status'], effect: 'read', about: 'whether review is on and what it runs by, and what the console still needs, such as its reviewer App',
    options: [repoOption('the repo; it needs no checkout'), { name: 'dir', value: 'path', needs: 'computer', about: 'a checkout here (default: the one this is run in)' }],
  },
  {
    path: ['review', 'enable'], effect: 'change', needs: 'computer', why: 'it writes .woodshed/project.yaml in a checkout on the person\'s computer',
    about: 'in a checkout: write pullRequests.review with runner: woodshed into .woodshed/project.yaml, check it, and ask the console what is missing',
    options: [
      { name: 'qa', about: 'QA too, in a Woodshed session, when the woodshed-qa label goes on a pull request' },
      { name: 'rerun', value: 'tag', about: 'review a commit whose message has this tag' },
      { name: 'every-commit', about: 'review each new commit, with no tag' },
      { name: 'dry-run', about: 'say what would change, and write nothing' },
      { name: 'dir', value: 'path', about: 'the checkout (default: the one this is run in)' },
    ],
  },
  {
    path: ['review', 'pulls'], effect: 'read', about: 'your own open pull requests on a repo, and how the repo is reviewed',
    options: [repoOption('the repo (default: this checkout\'s origin)'), { name: 'dir', value: 'path', needs: 'computer', about: 'a checkout here' }],
  },
  {
    path: ['review', 'start'], effect: 'change', about: 'have the console review each of your open pull requests now, and print its link',
    args: [{ name: 'pulls', about: 'pull requests: 12, #12 or a URL', check: PULL, list: true }],
    options: [repoOption('the repo (default: this checkout\'s origin)'), { name: 'dir', value: 'path', needs: 'computer', about: 'a checkout here' }],
  },
  { path: ['config', 'list'], effect: 'read', about: 'every choice on your My settings and its value, never a secret' },
  { path: ['config', 'get', '<key>'], effect: 'read', about: 'one choice\'s value', args: [{ name: 'key', about: 'the key, as config list names it', check: /^[a-z][a-z-]{0,63}$/ }] },
  {
    path: ['config', 'set', '<key>'], effect: 'change', about: 'change one choice on your My settings',
    args: [{ name: 'key', about: 'the key, as config list names it', check: /^[a-z][a-z-]{0,63}$/ }, { name: 'value', about: 'its new value', text: true }],
  },
  ...['plan', 'push', 'pull'].map((sub) => ({
    path: ['settings', sub], effect: sub === 'plan' ? 'read' : sub === 'push' ? 'change' : 'destructive', needs: 'computer',
    why: 'it reads and writes the person\'s own Claude and Codex settings, dotfiles and checkouts on their computer',
    about: { plan: 'list what push (or with --pull, pull) would do with each item, and send nothing', push: 'upload your Claude and Codex settings, plugins, dotfiles and ignored checkout files to your private sessions', pull: 'write the shared copy to this computer' }[sub],
    options: [
      { name: 'only', value: 'what', list: true, about: 'a kind of item, or a name as the list shows it' },
      ...(sub === 'pull' ? [] : [{ name: 'own-files', value: 'checkout', about: 'also the checkout\'s ignored files' }]),
      ...(sub === 'plan' ? [{ name: 'pull', about: 'what pull would write instead' }] : []),
      ...(sub === 'push' ? [] : [{ name: 'replace', with: sub === 'plan' ? ['pull'] : [], about: 'also what differs' }]),
    ],
  })),
  {
    path: ['sign-in', 'push', '<agent>'], effect: 'change', needs: 'computer', why: 'it sends the sign-in file the agent\'s own login saved on the person\'s computer',
    about: 'save the Grok Build or OpenCode sign-in this computer\'s grok login or opencode auth login made as yours on My settings',
    args: [{ name: 'agent', about: 'grok or opencode', check: /^(grok|opencode)$/ }],
    options: [{ name: 'replace', about: 'replace one the console has already' }],
  },
];

/** @returns {string}  a command's name, its words without the arguments: `session app start` */
export function commandName(entry) {
  return entry.path.filter((w) => !w.startsWith('<')).join(' ');
}

/** The options of `session <sub>`, as its parser takes them (sessions.mjs, parseSessionArgs). */
export function sessionOptions(sub) {
  const options = new Map();
  for (const entry of COMMANDS.filter((e) => e.path[0] === 'session' && e.path[1] === sub)) for (const o of entry.options ?? []) options.set(o.name, o);
  const all = [...options.values()];
  return {
    values: all.filter((o) => o.value && !o.optional).map((o) => o.name),
    flags: all.filter((o) => !o.value).map((o) => o.name),
    optional: all.filter((o) => o.optional).map((o) => o.name),
  };
}

// Never an option, and nothing a terminal would act on: what a value the parsers read as an option's may be.
// eslint-disable-next-line no-control-regex
const PLAIN = /^(?!-)[^\u0000-\u001f\u007f]{1,500}$/;

/** Why `value` cannot be what `spec` takes, or null. */
export function refusedValue(spec, value) {
  const name = spec.name;
  if (spec.text) {
    if (typeof value !== 'string' || value.includes('\u0000')) return `${name} must be text`;
    if (spec.check && !spec.check.test(value)) return `${name} is not one it takes`;
    return null;
  }
  if (typeof value !== 'string' || !PLAIN.test(value)) return `${name} must be a value that is not an option`;
  if (spec.values && !spec.values.includes(value)) return `${name} must be one of ${spec.values.join(', ')}`;
  if (spec.check && !spec.check.test(value)) return `${name} is not in the form it takes`;
  return null;
}

/**
 * The command line's words for an entry and its arguments, by name (an option by its own name: `no-wait`), each value
 * checked first: a value never reads as an option, and free text goes after `--`.
 * @param {object} entry  one of COMMANDS
 * @param {Record<string, string|boolean|string[]>} args
 * @param {string[]} [global]  the command line's own options (--console, --json), put before any `--`
 * @returns {string[]}  what follows `woodshed`
 */
export function argvOf(entry, args = {}, global = []) {
  const known = new Set([...(entry.args ?? []).map((a) => a.name), ...(entry.options ?? []).map((o) => o.name)]);
  for (const key of Object.keys(args)) if (!known.has(key)) throw new Error(`${commandName(entry)} takes no ${key}`);
  const check = (spec, value) => {
    const why = refusedValue(spec, value);
    if (why) throw new Error(why);
    return value;
  };
  // A list only where the catalogue takes one, and never an empty one: either would write a word other than was meant.
  const listOf = (spec, value) => {
    if (Array.isArray(value) && (!spec.list || !value.length)) throw new Error(`${spec.name} ${spec.list ? 'needs at least one' : 'takes one value, not a list'}`);
    return (Array.isArray(value) ? value : [value]).map((v) => check(spec, v));
  };
  const words = entry.path.map((w) => {
    if (!w.startsWith('<')) return w;
    const spec = entry.args.find((a) => a.name === w.slice(1, -1));
    if (args[spec.name] === undefined) throw new Error(`${commandName(entry)} needs ${spec.name}`);
    return check(spec, args[spec.name]);
  });
  const rest = [];
  for (const spec of entry.args ?? []) {
    if (entry.path.includes(`<${spec.name}>`)) continue;
    const value = args[spec.name];
    if (value === undefined || value === '') {
      if (!spec.optional) throw new Error(`${commandName(entry)} needs ${spec.name}`);
      continue;
    }
    if (spec.text) rest.push(check(spec, value));
    else words.push(...listOf(spec, value));
  }
  for (const o of entry.options ?? []) {
    const value = args[o.name];
    if (o.required && (value === undefined || value === false)) throw new Error(`${commandName(entry)} needs --${o.name}`);
    if (value === undefined || value === false) continue;
    for (const other of o.with ?? []) if (args[other] === undefined || args[other] === false) throw new Error(`--${o.name} goes with --${other}`);
    if (!o.value || (o.optional && value === true)) {
      if (value !== true) throw new Error(`--${o.name} takes no value`);
      words.push(`--${o.name}`);
    } else if (o.twoWords) words.push(`--${o.name}`, check(o, value));
    else for (const v of listOf(o, value)) words.push(`--${o.name}=${v}`);
  }
  return [...words, ...global, ...(rest.length ? ['--', ...rest] : [])];
}
