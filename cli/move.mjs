// `woodshed move --from herdr`: terminals on this computer moved into a Woodshed session, as they are: an agent with its
// conversation, a shell in its folder, a program started again there, in the same spaces, tabs and splits of the Herdr
// app. Laptop to session only.
//
//   woodshed move --from herdr [--terminal T ...|--tab T|--space S] --to <session id>|new [--restart ask|auto|never] [--dry-run]
//
// In order, and nothing local is touched before the last step:
//   1. The chosen terminals, read from hc (moveLayout.mjs) and each classified (moveAgents.mjs).
//   2. Each checkout's work frozen into one commit and pushed to `woodshed/move-<id>` (moveCode.mjs). A secret-looking
//      file refuses the move; ignored files never go.
//   3. The session: `--to <id>` is one of yours on the same repo, `--to new` one new session per repo on the branch,
//      each added to Herdr as `woodshed session herdr` does.
//   4. Each agent's conversation written into the session with `hc file write --on`, nothing else from home.
//   5. The layout made again there (`herdr-app do`, or hc's labels with no window), each agent resumed, each shell in
//      its folder, each program started again once the person said so.
//   6. Each local agent ended only once its moved one reports a state, and its terminal labelled `woodshed.moved`.
// A failure before 6 removes what was made in the session and on GitHub, and leaves this computer as it was.
//
// Two agents never work on one branch: the first agent of a checkout takes the session's branch (in a new session it
// becomes the session's own agent, which the console follows), and each other one gets a branch and a git worktree of
// its own there. Programs restart rather than move, and databases stay: the session has its own.

import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';

import { HC_MINIMUM, hcVersion, machineName, shellQuote } from './hc.mjs';
import { checkoutOf, deleteBranch, freeze, pushBranch, redactCredentials, secretsIn, survey } from './moveCode.mjs';
import { classify, claudeProjectDir, findConversations, rewriteConversation, rootsOf, shownCommand, withoutStateHooks } from './moveAgents.mjs';
import { appSpaces, buildWithApp, buildWithLabels, choose, failureOf, leavesOf, localLayout, placesOf, readDoc } from './moveLayout.mjs';

const ID_RE = /^[0-9a-f]{8}$/;
// hc file write takes at most 8 MB; a larger conversation goes gzipped, in parts.
const FILE_PART = 6 * 1024 * 1024;
// How long a moved agent has to say what it is doing, and a local one to end.
const LIVE_MS = 120_000;
const END_MS = 20_000;
const POLL_MS = 1000;

export const MOVE_USAGE = `Usage: woodshed move --from herdr [--terminal <t> ...|--tab <tab>|--space <space>] --to <session id>|new [options]

Moves work into a Woodshed session. Herdr terminals carry their agents and conversations (Claude Code or Codex),
open shells in their folders, and can restart programs. Their spaces, tabs and splits are recreated in Herdr.

  --from herdr       move terminals from Herdr on this computer (required; Herdr is the supported source)
  --terminal <t>     a terminal by address or name (hc ls); repeat it for more
  --tab <tab>        every terminal of a tab, by id or name (herdr-app ls)
  --space <space>    every terminal of a space, by id or name
  --to <id>|new      one of your sessions on the same repo, or a new session for each repo
  --restart <when>   programs (a dev server): ask (the default; on no terminal, never), auto, or never
  --dry-run          print what would move, and do nothing

Each checkout's work is committed, untracked files included, to a branch of its own, woodshed/move-<id>, and pushed;
your branch, index and files stay as they are. Files git ignores (.env) stay here: woodshed settings push --own-files
gives a session yours. A file that looks like a secret refuses the move. Programs restart rather than move, and
databases stay: the session has its own. A local agent ends only once its moved one is running.

Exit codes: 0 moved, 2 waiting on a person (sign in, a moved agent that needs you), 3 refused, 1 anything else.`;

/**
 * @returns {{from: 'herdr', terminal: string[], tab?: string, space?: string, to: string, dryRun: boolean, restart: 'ask'|'auto'|'never'}}
 */
export function parseMoveArgs(words, fail) {
  const out = { terminal: [], dryRun: false, restart: 'ask' };
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const [name, inline] = word.startsWith('--') ? word.slice(2).split(/=(.*)/s) : [null, null];
    const value = () => {
      const v = inline ?? words[++i];
      if (v === undefined || v === '' || (name === 'from' && inline === undefined && v.startsWith('--'))) throw fail(`--${name} needs a value`);
      return v;
    };
    if (name === 'terminal') out.terminal.push(value());
    else if (name === 'from' || name === 'tab' || name === 'space' || name === 'to' || name === 'restart') {
      if (out[name] !== undefined && name !== 'restart') throw fail(`--${name} is given once`);
      out[name] = value();
    } else if (name === 'dry-run' && inline === undefined) out.dryRun = true;
    else throw fail(`${word.startsWith('-') ? `unknown option ${word}` : `unexpected ${word}`} for move\n\n${MOVE_USAGE}`);
  }
  if (!out.from) throw fail(`move needs --from herdr\n\n${MOVE_USAGE}`);
  if (out.from !== 'herdr') throw fail(`--from must be herdr\n\n${MOVE_USAGE}`);
  const kinds = [out.terminal.length ? 'terminal' : null, out.tab ? 'tab' : null, out.space ? 'space' : null].filter(Boolean);
  if (kinds.length !== 1) throw fail(`move takes one of --terminal, --tab or --space\n\n${MOVE_USAGE}`);
  if (!out.to) throw fail(`move needs --to <session id> or --to new\n\n${MOVE_USAGE}`);
  if (out.to !== 'new' && !ID_RE.test(out.to)) throw fail(`${out.to} is not a session id: eight letters and digits, as woodshed session list shows, or new`);
  if (!['ask', 'auto', 'never'].includes(out.restart)) throw fail('--restart must be ask, auto or never');
  return out;
}

function parsed(text) {
  try {
    return JSON.parse(String(text).trim());
  } catch {
    return null;
  }
}

// eslint-disable-next-line no-control-regex
const printable = (text, most = 200) => (text === null || text === undefined ? null : redactCredentials(String(text)).replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ').slice(0, most));

/**
 * @param {{origin: string, rest: string[]}} args
 * @param {object} ctx  as sessionCommand's, with `app` (herdr-app), `git`, `env`, `hostname` and `session` (sessionCommand)
 * @returns {Promise<number>}
 */
// Redact before JSON escaping so unusual characters in a path cannot hide a credential from the matcher.
function safeOutput(value) {
  return JSON.parse(JSON.stringify(value, (_key, field) => typeof field === 'string' ? redactCredentials(field) : field));
}

export async function moveCommand(args, ctx) {
  try {
    return await runMove(args, ctx);
  } catch (error) {
    if (typeof error?.message === 'string') error.message = redactCredentials(error.message);
    throw error;
  }
}

async function runMove({ origin, rest }, ctx) {
  const { call, json, sleep, now, stderr, fail, EXIT, hc, app, git } = ctx;
  const say = (line) => ctx.say(redactCredentials(line));
  const emit = (event) => ctx.emit(safeOutput(event));
  const env = ctx.env ?? process.env;
  if (rest[0] === 'help') {
    ctx.stdout.write(`${MOVE_USAGE}\n`);
    return EXIT.done;
  }
  const opts = parseMoveArgs(rest, fail);
  const token = ctx.getToken();
  if (!token) {
    if (json) emit({ event: 'error', status: 'signed-out', error: `not signed in to ${origin}` });
    say(`Not signed in to ${origin}. Run: woodshed login --console ${origin}`);
    return EXIT.waiting;
  }
  const refused = (message) => fail(message, { code: EXIT.refused, status: 'refused' });
  const step = (name, text, extra = {}) => {
    if (json) emit({ event: 'step', step: name, ...extra });
    else say(text);
  };

  if (ctx.platform === 'win32') throw refused('woodshed move --from herdr does not run on Windows yet');
  // A program's command line as it is printed: what may be a credential in it hidden. The real one is for its restart.
  const shown = (argv) => shownCommand(argv, (word) => secretsIn(word).length > 0);
  const version = await hcVersion(hc);
  if (!version.ok) throw fail(`Moving terminals needs Herdr's hc, ${HC_MINIMUM} or newer${version.installed ? `, and yours is ${version.version ?? 'a version it does not say'}: hc update` : ': install Herdr'}.`, { code: EXIT.refused, status: version.installed ? 'old-hc' : 'no-hc' });

  // A call to the console, its refusals said as exit codes, as `woodshed session` says them.
  async function ask(pathname, { method = 'GET', body } = {}) {
    const out = await call(origin, pathname, { method, body, token });
    if (out.status === 401) throw fail(`The sign-in to ${origin} ended. Run: woodshed login --console ${origin}`, { code: EXIT.waiting, status: 'signed-out' });
    if (out.status === 403) throw refused(printable(out.body?.error) ?? `${origin} refused that`);
    if (out.status >= 400 || !out.body || typeof out.body !== 'object') throw fail(printable(out.body?.error) ?? `${origin} answered ${out.status}`);
    return out.body;
  }

  // ---- 1. The terminals, where they are, and what each runs.
  const listed = parsed((await hc(['ls', '--json'])).stdout)?.terminals;
  if (!Array.isArray(listed)) throw fail('hc ls did not answer: is Herdr\'s core running here?');
  const here = [];
  for (const t of listed.filter((x) => typeof x?.address === 'string' && !x.address.includes('/') && x.state !== 'finished')) {
    const full = parsed((await hc(['get', '--json', t.address])).stdout);
    if (full?.address) here.push(full);
  }
  const layout = localLayout(await readDoc(hc, 'herdr-app'), here);
  const chosen = choose(layout, here, opts);
  if (chosen.error) throw fail(chosen.error);
  const addresses = chosen.spaces.flatMap((s) => s.tabs.flatMap((t) => leavesOf(t.tree)));
  const byAddress = new Map(here.map((t) => [t.address, t]));
  const kinds = new Map(addresses.map((a) => [a, classify(byAddress.get(a))]));
  const busy = addresses.filter((a) => kinds.get(a).kind === 'agent' && ['working', 'blocked'].includes(kinds.get(a).state));
  if (busy.length) throw refused(`${busy.map((a) => `${a} (${kinds.get(a).agent}, ${kinds.get(a).state})`).join(', ')} ${busy.length === 1 ? 'is' : 'are'} mid-turn: a conversation moves between turns. Wait for it, or stop it, then move again.`);

  // Each terminal's checkout. Work outside one has nowhere to go in a session.
  const checkouts = new Map();
  const checkoutFor = new Map();
  for (const a of addresses) {
    const found = await checkoutOf(git, kinds.get(a).cwd);
    if (found.error) throw refused(`${a}: ${found.error}. Only work in a checkout of one of your repos moves.`);
    if (!checkouts.has(found.root)) checkouts.set(found.root, found);
    checkoutFor.set(a, checkouts.get(found.root));
  }

  // Each agent's conversation, found before anything is made: one missing stops the move here.
  const agents = addresses.filter((a) => kinds.get(a).kind === 'agent');
  const conversations = findConversations(agents.map((a) => ({
    address: a, agent: kinds.get(a).agent, cwd: kinds.get(a).cwd, labels: byAddress.get(a).labels ?? {}, argv: kinds.get(a).argv, statusMs: byAddress.get(a).status_ms ?? null,
  })), {
    env, now: now(),
    // Every agent here, the ones staying too: which conversation is whose is not guessed from the moved ones alone.
    peers: here.filter((t) => classify(t).kind === 'agent').map((t) => ({ address: t.address, agent: classify(t).agent, cwd: classify(t).cwd })),
  });
  const lost = agents.filter((a) => conversations.get(a)?.error);
  if (lost.length) throw fail(`The conversation of ${lost.map((a) => `${a}: ${conversations.get(a).error}`).join('; ')}. Nothing was moved.`, { status: 'no-conversation' });
  // A conversation holds what its agent read and ran: a credential in it would reach the session. Said by line and kind.
  const transcripts = new Map(agents.map((a) => [a, fs.readFileSync(conversations.get(a).file, 'utf8')]));
  const heldSecrets = agents.flatMap((a) => secretsIn(transcripts.get(a), '', { credentialHeaders: true }).map((hit) => ({ address: a, ...hit })));
  if (heldSecrets.length) {
    if (json) emit({ event: 'secrets', conversations: heldSecrets });
    throw refused(`These conversations hold what looks like a secret, and the move would carry it into the session:\n${heldSecrets.map((h) => `  ${h.address}'s conversation ${conversations.get(h.address).id}${h.line ? `, line ${h.line}` : ''}: ${h.kind}`).join('\n')}\nRevoke the credential, then move a new conversation, or work on here. Nothing was moved.`);
  }

  // ---- The sessions, read before anything is made.
  const me = await ask('/api/sessions');
  const login = typeof me.login === 'string' ? me.login : null;
  const repos = [...new Set([...checkouts.values()].map((c) => c.repo.toLowerCase()))];
  const projects = new Map();
  let target = null;
  const target0 = () => (Array.isArray(me.sessions) ? me.sessions : []).find((s) => s?.id === opts.to) ?? null;
  // A session runs one kind of agent, and only that kind has its flags and guards there (the ask before a merge, the
  // ready gate): an agent of the other kind is not moved into it.
  const kindOf = new Map();
  for (const a of agents) {
    const repo = checkoutFor.get(a).repo.toLowerCase();
    const k = kinds.get(a).agent;
    const want = opts.to === 'new' ? (kindOf.get(repo) ?? k) : (target0()?.options?.agent === 'codex' ? 'codex' : 'claude');
    if (k !== want) throw refused(`${a} runs ${k}, and ${opts.to === 'new' ? `the session for ${repo} would run ${want}` : `session ${opts.to} runs ${want}`}: a session runs one kind of agent, with that kind's guards. Move ${k} and ${want} terminals apart.`);
    kindOf.set(repo, want);
  }
  if (opts.to === 'new') {
    const body = await ask('/api/my/projects');
    const list = Array.isArray(body.projects) ? body.projects : [];
    for (const repo of repos) {
      const project = list.find((p) => String(p.repo ?? '').toLowerCase() === repo);
      if (!project) throw refused(`You cannot start sessions on ${repo} on ${origin}: it is not one of its repos, or you have no write access to it.`);
      projects.set(repo, project.name);
    }
  } else {
    target = (Array.isArray(me.sessions) ? me.sessions : []).find((s) => s?.id === opts.to);
    if (!target) throw fail(`No session ${opts.to} that you can see on ${origin}. woodshed session list shows yours.`);
    if (!target.owner || target.owner !== login) throw refused(`${opts.to} is a shared session: work moves only into your own My Woodshed sessions.`);
    if (target.taintedAt) throw refused(`Session ${opts.to} has seen production data: nothing opens a pipe into it from this computer.`);
    if (repos.length > 1) throw refused(`These terminals are in ${repos.join(' and ')}: a session works on one repo. Move each repo's apart, or use --to new.`);
    if (String(target.repo ?? '').toLowerCase() !== repos[0]) throw refused(`Session ${opts.to} works on ${printable(target.repo) ?? 'another repo'}, and these terminals are in ${repos[0]}.`);
  }

  // ---- 2. The code: what each checkout would push, and what refuses it.
  const id = ctx.moveId ?? crypto.randomBytes(4).toString('hex');
  const surveys = new Map();
  try {
    for (const c of checkouts.values()) surveys.set(c.root, await survey(git, c, { tag: `move-${id}` }));
  } catch (err) {
    for (const s of surveys.values()) fs.rmSync(path.dirname(s.index), { recursive: true, force: true });
    throw fail(err.message);
  }
  const cleanSurveys = () => { for (const s of surveys.values()) fs.rmSync(path.dirname(s.index), { recursive: true, force: true }); };
  const secrets = [...checkouts.values()].flatMap((c) => surveys.get(c.root).secrets.map((s) => ({ ...s, root: c.root })));
  if (secrets.length) {
    cleanSurveys();
    if (json) emit({ event: 'secrets', files: secrets.map((s) => ({ root: s.root, path: s.path, line: s.line, kind: s.kind })) });
    const lines = secrets.map((s) => {
      const where = /^(the message of commit |a name in Git tree )/.test(s.path) ? `${s.path} in ${s.root}` : path.join(s.root, s.path);
      return `  ${where}${s.line ? `:${s.line}` : ''}  ${s.kind}`;
    });
    throw refused(`These look like secrets, and the move would push them to GitHub:\n${lines.join('\n')}\nTake them out of the work (or add them to .gitignore), then move again. Nothing was moved.`);
  }
  const missingSubmodules = [...surveys].flatMap(([root, survey]) => (survey.missingSubmodules ?? []).map((file) => path.join(root, file)));
  if (missingSubmodules.length) {
    cleanSurveys();
    if (json) emit({ event: 'unavailable-submodules', paths: missingSubmodules });
    throw refused(`The move could not verify these submodule commits on a remote-tracking branch:\n${missingSubmodules.map((file) => `  ${file}`).join('\n')}\nInitialize the submodules and use commits already on their remotes, then move again. Nothing was moved.`);
  }

  // Where each terminal goes in the session: places, one per branch. A checkout's first agent, and its shells and
  // programs, take its first place; each other agent gets a place of its own, from the same commit.
  const places = [];
  const placeOf = new Map();
  for (const repo of repos) {
    let n = 0;
    for (const c of [...checkouts.values()].filter((x) => x.repo.toLowerCase() === repo)) {
      const here2 = addresses.filter((a) => checkoutFor.get(a) === c);
      const mine = here2.filter((a) => kinds.get(a).kind === 'agent');
      const first = { repo, checkout: c, branch: `woodshed/move-${id}${n ? `-${n + 1}` : ''}`, main: n === 0 && opts.to === 'new', agent: mine[0] ?? null };
      n += 1;
      places.push(first);
      for (const a of here2) if (!mine.includes(a) || a === mine[0]) placeOf.set(a, first);
      for (const a of mine.slice(1)) {
        const own = { repo, checkout: c, branch: `woodshed/move-${id}-${n + 1}`, main: false, agent: a };
        n += 1;
        places.push(own);
        placeOf.set(a, own);
      }
    }
  }

  // Programs restart there only when the person says so.
  const processes = addresses.filter((a) => kinds.get(a).kind === 'process');
  const restart = new Map();
  // A program whose command line holds a credential (or what may be one) is never started again there: the session
  // would hold it, in its processes and its terminals' records. Said, never with the value.
  const holdsCredential = new Set(processes.filter((a) => shown(kinds.get(a).argv) !== kinds.get(a).argv.map(shellQuote).join(' ')));
  for (const a of processes) {
    const line = shown(kinds.get(a).argv);
    if (holdsCredential.has(a)) restart.set(a, false);
    else if (opts.restart === 'auto' || opts.restart === 'never') restart.set(a, opts.restart === 'auto');
    else if (opts.dryRun) restart.set(a, null);
    else {
      const answer = await ctx.confirm(redactCredentials(`Start "${printable(line, 120)}" again in the session (${a})? Its local copy keeps running here. [y/N] `));
      restart.set(a, answer === true);
    }
  }

  const places2 = placesOf(chosen.spaces);
  const bundle = (commits = new Map()) => ({
    version: 1,
    id,
    from: 'local',
    to: opts.to,
    repos: [...checkouts.values()].map((c) => ({
      repo: c.repo, root: c.root, remote: c.remote, from: c.branch, files: surveys.get(c.root).files.length, ignoredEnv: surveys.get(c.root).ignoredEnv,
    })),
    spaces: chosen.spaces,
    terminals: addresses.map((a) => {
      const k = kinds.get(a);
      const place = placeOf.get(a);
      const c = checkoutFor.get(a);
      const conversation = conversations.get(a);
      return {
        address: a,
        layout: places2.get(a),
        repo: { remote: `github.com/${c.repo}`, branch: place.branch, commit: commits.get(c.root) ?? null, subdir: path.relative(fs.realpathSync(c.root), safeReal(k.cwd)).split(path.sep).join('/') },
        kind: k.kind,
        cwd: k.cwd,
        ...(k.kind === 'agent' ? { agent: { kind: k.agent, sessionRef: conversation.id, transcript: `${k.agent}/${conversation.relative ?? `${conversation.id}.jsonl`}`, from: conversation.from } } : {}),
        ...(k.kind === 'process' ? { process: { command: shown(k.argv), restart: restart.get(a) === true ? 'auto' : restart.get(a) === false ? 'never' : 'ask' } } : {}),
      };
    }),
  });

  if (opts.dryRun) {
    cleanSurveys();
    const b = bundle();
    if (json) emit({ event: 'bundle', bundle: b });
    else {
      say(`Would move ${addresses.length} terminal${addresses.length === 1 ? '' : 's'} to ${opts.to === 'new' ? `${repos.length === 1 ? 'a new session' : `${repos.length} new sessions`}` : `session ${opts.to}`} (move ${id}):`);
      for (const r of b.repos) say(`  ${r.repo}: ${r.files} changed file${r.files === 1 ? '' : 's'} from ${r.root} to woodshed/move-${id}${r.ignoredEnv.length ? `; stays here: ${r.ignoredEnv.join(', ')}` : ''}`);
      for (const t of b.terminals) say(`  ${t.address}  ${t.layout.space || '-'} / ${t.layout.tab || '-'}  ${t.kind}${t.agent ? ` ${t.agent.kind} ${t.agent.sessionRef} (${t.agent.from})` : t.process ? ` ${t.process.command}` : ''}  in ${t.repo.subdir || '.'}`);
      say(JSON.stringify(safeOutput(b), null, 2));
    }
    return EXIT.done;
  }

  // ---- From here on, everything made is undone on a failure before the hand-over.
  const made = { branches: [], sessions: [], worktrees: [], files: [], uploads: [], spaces: [], terminals: [] };
  const machinesOf = new Map();
  const commits = new Map();
  // Each step of the undo that did not work is named, so it can be done by hand.
  async function undo() {
    const left = [];
    const execOk = async (machine, argv) => {
      const out = parsed((await hc(['exec', '--json', '--on', machine, '--', ...argv]).catch(() => ({ stdout: '' }))).stdout);
      return out?.code === 0;
    };
    for (const s of made.spaces) {
      const out = await app(['do', 'space.close', JSON.stringify({ id: s.id, confirmed: true })], { timeoutMs: 30_000 }).catch(() => ({ code: 1 }));
      if (out.code !== 0) left.push(`the space ${s.id} in Herdr`);
    }
    for (const t of made.terminals) if ((await hc(['kill', '--json', t]).catch(() => ({ code: 1 }))).code !== 0) left.push(`the terminal ${t}`);
    for (const w of made.worktrees) {
      if (!(await execOk(w.machine, ['sh', '-c', 'git -C "$1" worktree remove --force "$2" && git -C "$1" branch -D "$3"', 'sh', w.repoDir, w.path, w.branch]))) left.push(`the worktree ${w.path} on ${w.machine}`);
    }
    for (const f of made.files) if (!made.sessions.some((s) => machineName(s.id) === f.machine) && !(await execOk(f.machine, ['rm', '-f', f.path]))) left.push(`${f.path} on ${f.machine}`);
    for (const { machine, dir, staged, dest } of made.uploads) {
      if (made.sessions.some((s) => machineName(s.id) === machine)) continue;
      // A lost reply can leave a published link. Remove it only if it still names this upload's file.
      const clean = 'if [ "$1" -ef "$2" ]; then rm -f -- "$2" || exit 1; fi; rm -rf -- "$3"';
      if (!(await execOk(machine, ['sh', '-c', clean, 'sh', staged, dest, dir]))) left.push(`${dir} on ${machine}`);
    }
    for (const s of made.sessions) {
      const out = await call(origin, `/api/my/sessions/${s.id}/remove`, { method: 'POST', body: {}, token, deadlineMs: 180_000 }).catch(() => null);
      if (out?.status !== 200) left.push(`session ${s.id} (woodshed session remove ${s.id})`);
      await hc(['machine', 'rm', '--json', machineName(s.id)]).catch(() => null);
    }
    for (const b of made.branches) if (!(await deleteBranch(git, b.checkout, b.branch).catch(() => false))) left.push(`the branch ${b.branch} on ${b.checkout.remote} (git push ${b.checkout.remote} --delete ${b.branch})`);
    return left;
  }
  async function failed(error) {
    // Said as the command's own failure, never as a stack.
    const err = error?.code !== undefined && error?.status !== undefined ? error : fail(String(error?.message ?? error));
    if (!json) say('Undoing what was made in the session and on GitHub; nothing here was changed.');
    const left = await undo();
    if (left.length) {
      if (json) emit({ event: 'undo-incomplete', left });
      err.message = `${err.message}\nNot undone, so remove them yourself: ${left.join('; ')}.`;
    }
    throw err;
  }

  // Where each terminal went, and what each moved agent said it was doing.
  const remoteAt = new Map();
  const live = new Map();
  // Programs started again there that ended at once.
  const ended2 = new Set();
  try {
    // ---- 2. Frozen and pushed: one commit per checkout, a branch per place.
    for (const c of checkouts.values()) {
      // Nothing of this computer's in it, not even the branch's name (which could hold anything): it goes to GitHub.
      const message = `woodshed move ${id}: work in progress, moved into a session`;
      commits.set(c.root, await freeze(git, c, { tree: surveys.get(c.root).tree, message }));
    }
    cleanSurveys();
    for (const place of places) {
      const pushed = await pushBranch(git, place.checkout, { commit: commits.get(place.checkout.root), branch: place.branch });
      if (!pushed.ok) throw fail(`git push of ${place.branch} to ${place.checkout.remote} was refused: ${printable(pushed.error, 300)}`, { status: 'push-refused' });
      made.branches.push({ checkout: place.checkout, branch: place.branch });
      step('pushed', `Pushed ${place.checkout.repo} ${commits.get(place.checkout.root).slice(0, 12)} to ${place.branch}`, { repo: place.checkout.repo, branch: place.branch, commit: commits.get(place.checkout.root) });
    }

    // ---- 3. The sessions, connected.
    const sessionOf = new Map();
    if (opts.to === 'new') {
      for (const repo of repos) {
        const first = places.find((p) => p.repo === repo && p.main);
        // The kind of the repo's agents, whichever checkout they are in (checked above to be one kind).
        const agent = kindOf.get(repo) ?? 'claude';
        const spaceName = chosen.spaces[0]?.name || chosen.spaces[0]?.tabs[0]?.name || '';
        const name = `Moved from ${printable(ctx.hostname ?? os.hostname(), 40)}${spaceName ? `: ${printable(spaceName, 60)}` : ''}`;
        const s = await ask('/api/my/sessions', { method: 'POST', body: { project: projects.get(repo), workOn: first.branch, agent, model: '', name, prompt: '' } });
        if (!ID_RE.test(String(s.id))) throw fail(`${origin} answered with no session id`);
        made.sessions.push({ id: s.id });
        sessionOf.set(repo, s.id);
        step('session', `Started session ${s.id} on ${first.branch}: ${origin}/s/${s.id}`, { repo, id: s.id });
      }
    } else sessionOf.set(repos[0], target.id);
    for (const sid of new Set(sessionOf.values())) {
      const events = [];
      // The move places the agent in the copied layout once the machine is connected.
      const code = await ctx.session({ origin, rest: ['herdr', sid] }, { ...ctx, token, placeHerdrAgent: false, json: true, emit: (o) => events.push(o), say: () => {} });
      const connected = events.find((e) => e.event === 'connected');
      if ((code !== EXIT.done && code !== EXIT.waiting) || !connected) {
        const said = events.find((e) => e.event === 'failed' || e.event === 'stopped' || e.event === 'error');
        throw fail(`Session ${sid} could not be connected${said?.session?.error ? `: ${printable(said.session.error)}` : said?.error ? `: ${printable(said.error)}` : ''}.`, { status: 'not-connected' });
      }
      machinesOf.set(sid, { name: connected.machine.name, agent: connected.agent });
      step('connected', `Connected ${sid} as ${connected.machine.name}`, { id: sid, machine: connected.machine.name });
    }

    // What the session is: its home, checkout, and the flags its agent runs with.
    const facts = new Map();
    for (const [sid, m] of machinesOf) {
      const script = 'sd=${SESSION_DIR:-/opt/woodshed/session}; printf "%s\\n" "$HOME" "${REPO_DIR:-}" "$sd" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$( [ -x "$sd/bin/claude" ] && echo yes)"; printf "%s" "$(cat /tmp/woodshed-claude-flags 2>/dev/null)" | base64 | tr -d "\\n"; echo; printf "%s" "$(cat /tmp/woodshed-codex-flags 2>/dev/null)" | base64 | tr -d "\\n"; echo; echo "${WOODSHED_CODEX_AUTH:-}"';
      const out = parsed((await hc(['exec', '--json', '--on', m.name, '--', 'sh', '-c', script])).stdout);
      if (!out || out.code !== 0) throw fail(`${m.name} did not answer hc exec: ${printable(out ? Buffer.from(out.stderr ?? '', 'base64').toString() : 'no answer', 300)}`);
      const [home, repoDir, sessionDir, claudeDir, codexDir, wrapped, claudeFlags, codexFlags, codexAuth] = Buffer.from(out.stdout, 'base64').toString('utf8').split('\n');
      let checkout = repoDir;
      const agentAt = m.agent?.inHerdr ? parsed((await hc(['get', '--json', `${m.name}/claude`])).stdout) : null;
      if (agentAt?.cwd) checkout = agentAt.cwd;
      if (!checkout) throw fail(`${m.name} did not say where its checkout is`);
      const b64 = (x) => Buffer.from(x ?? '', 'base64').toString('utf8');
      facts.set(sid, {
        home, checkout, sessionDir, claudeDir, codexDir, wrapped: wrapped === 'yes', claudeFlags: b64(claudeFlags), codexFlags: b64(codexFlags), agent: agentAt,
        // session/bin/codex: the console's proxy, as provider "woodshed", on the team key; OpenAI on the owner's sign-in.
        codexProvider: codexAuth === 'key' ? 'woodshed' : 'openai',
      });
    }
    for (const a of agents) {
      const sid = sessionOf.get(placeOf.get(a).repo);
      if (kinds.get(a).agent === 'codex' && !facts.get(sid).codexFlags.trim()) {
        throw refused(`Session ${sid} did not provide its Codex flags. Restart it with a session image that supports woodshed move --from herdr, or move to a new session.`);
      }
    }

    // A place's folder there: the session's checkout for its main place, else a worktree of its own.
    const sessionFor = (place) => sessionOf.get(place.repo);
    const folderOf = new Map();
    for (const place of places) {
      const sid = sessionFor(place);
      const f = facts.get(sid);
      const machine = machinesOf.get(sid).name;
      if (place.main) {
        folderOf.set(place, f.checkout);
        continue;
      }
      const wt = path.posix.join(f.home, place.branch.replace(/^woodshed\//, 'woodshed-'));
      const script = [
        'set -e',
        'git -C "$1" fetch -q origin "+refs/heads/$3:refs/remotes/origin/$3"',
        'git -C "$1" worktree add -q -B "$3" "$2" "origin/$3"',
        'git -C "$2" branch -q --set-upstream-to="origin/$3"',
      ].join('\n');
      const out = parsed((await hc(['exec', '--json', '--timeout', '180', '--on', machine, '--', 'sh', '-c', script, 'sh', f.checkout, wt, place.branch], { timeoutMs: 200_000 })).stdout);
      if (!out || out.code !== 0) throw fail(`The worktree for ${place.branch} could not be made in ${machine}: ${printable(out ? Buffer.from(out.stderr ?? '', 'base64').toString().trim().split('\n').at(-1) : 'no answer', 300)}`);
      made.worktrees.push({ machine, repoDir: f.checkout, path: wt, branch: place.branch });
      folderOf.set(place, wt);
    }
    const remoteCwd = (a) => {
      const place = placeOf.get(a);
      const local = checkoutFor.get(a);
      const sub = path.relative(fs.realpathSync(local.root), safeReal(kinds.get(a).cwd)).split(path.sep).join('/');
      return sub ? path.posix.join(folderOf.get(place), sub) : folderOf.get(place);
    };

    // An agent moved into a new session's checkout becomes that session's own agent, so it needs the agent in Herdr.
    for (const place of places.filter((p) => p.main && p.agent)) {
      const sid = sessionFor(place);
      if (!facts.get(sid).agent) {
        throw refused(`Session ${sid}'s agent runs in tmux, not Herdr, so a moved conversation cannot take its place. Pick Herdr under Agent terminal on My settings, then move again.`);
      }
    }

    // ---- 4. The conversations, written where the session's agent reads them. Folders said as the session's.
    async function writeThere(machine, dest, data) {
      const exec = async (...argv) => parsed((await hc(['exec', '--json', '--on', machine, '--', ...argv])).stdout);
      const parent = path.posix.dirname(dest);
      const temp = await exec('sh', '-c', 'mkdir -p -- "$1" && mktemp -d -- "$1/.woodshed-move.XXXXXX"', 'sh', parent);
      const dir = Buffer.from(temp?.stdout ?? '', 'base64').toString().trimEnd();
      if (temp?.code !== 0 || path.posix.dirname(dir) !== parent || !/^\.woodshed-move\.[a-zA-Z0-9]{6}$/.test(path.posix.basename(dir))) {
        throw fail(`Could not stage the conversation for ${dest} on ${machine}`);
      }
      const staged = `${dir}/conversation`;
      const upload = { machine, dir, staged, dest };
      made.uploads.push(upload);
      const write = async (to, bytes) => {
        const out = await hc(['file', 'write', '--json', '--on', machine, to], { input: bytes, timeoutMs: 120_000 });
        if (out.code !== 0) throw fail(`hc file write ${to} on ${machine}: ${printable(failureOf(out), 300)}`);
      };
      if (data.length <= FILE_PART) {
        await write(staged, data);
      } else {
        const packed = zlib.gzipSync(data);
        const parts = [];
        for (let i = 0; i * FILE_PART < packed.length; i++) {
          const part = `${dir}/.woodshed-part-${String(i).padStart(3, '0')}`;
          await write(part, packed.subarray(i * FILE_PART, (i + 1) * FILE_PART));
          parts.push(part);
        }
        const out = await exec('bash', '-c', 'set -o pipefail; out=$1; shift; cat -- "$@" | gunzip > "$out"', 'bash', staged, ...parts);
        if (out?.code !== 0) throw fail(`${dest} could not be put together on ${machine}`);
      }
      // Publish atomically on the same filesystem. Another copy might have arrived during the upload.
      const out = await exec('sh', '-c', 'chmod 600 -- "$1" || exit 1; ln -T -- "$1" "$2" && exit 0; if [ -e "$2" ] || [ -L "$2" ]; then exit 3; fi; exit 1', 'sh', staged, dest);
      if (out?.code === 3) throw refused(`${dest} is already in ${machine}: this conversation was moved there before. Open it there, or move a new one.`);
      if (out?.code !== 0) throw fail(`Could not publish the conversation to ${dest} on ${machine}`);
      made.files.push({ machine, path: dest });
      if ((await exec('rm', '-rf', '--', dir))?.code !== 0) throw fail(`Could not clean up ${dir} on ${machine}`);
      made.uploads.splice(made.uploads.indexOf(upload), 1);
    }
    for (const a of agents) {
      const k = kinds.get(a);
      const conversation = conversations.get(a);
      const sid = sessionFor(placeOf.get(a));
      const f = facts.get(sid);
      const machine = machinesOf.get(sid).name;
      const cwd = remoteCwd(a);
      const local = checkoutFor.get(a);
      const text = rewriteConversation(transcripts.get(a), { from: rootsOf(local.root), to: folderOf.get(placeOf.get(a)), codexProvider: k.agent === 'codex' ? f.codexProvider : null });
      const dest = k.agent === 'claude'
        ? path.posix.join(f.claudeDir, 'projects', claudeProjectDir(cwd), `${conversation.id}.jsonl`)
        : path.posix.join(f.codexDir, 'sessions', conversation.relative);
      await writeThere(machine, dest, Buffer.from(text, 'utf8'));
      step('conversation', `Carried ${a}'s ${k.agent} conversation ${conversation.id} to ${machine}`, { address: a, agent: k.agent, id: conversation.id, machine });
    }
    // A worktree agent opens in a folder its agent has not been told to trust: said ahead, as the session does for its
    // checkout.
    for (const place of places.filter((p) => !p.main && p.agent)) {
      const sid = sessionFor(place);
      const f = facts.get(sid);
      const machine = machinesOf.get(sid).name;
      const kind = kinds.get(place.agent).agent;
      const script = kind === 'claude'
        ? 'node -e \'const fs=require("fs"),p=process.env.HOME+"/.claude.json";const c=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,"utf8")):{};c.projects=c.projects||{};c.projects[process.argv[1]]={...c.projects[process.argv[1]],hasTrustDialogAccepted:true};fs.writeFileSync(p+".woodshed-move",JSON.stringify(c,null,2));fs.renameSync(p+".woodshed-move",p)\' "$1"'
        : 'mkdir -p "$2" && printf \'\\n[projects."%s"]\\ntrust_level = "trusted"\\n\' "$1" >> "$2/config.toml"';
      await hc(['exec', '--json', '--on', machine, '--', 'sh', '-c', script, 'sh', folderOf.get(place), f.codexDir]);
    }

    // A second claude's settings: the session's own, without the hooks that report its agent's state.
    for (const sid of new Set(agents.filter((a) => kinds.get(a).agent === 'claude' && !(placeOf.get(a).main && placeOf.get(a).agent === a)).map((a) => sessionFor(placeOf.get(a))))) {
      const f = facts.get(sid);
      const machine = machinesOf.get(sid).name;
      const from = /--settings (\S+)/.exec(f.claudeFlags)?.[1];
      if (!from) continue;
      const read = parsed((await hc(['exec', '--json', '--on', machine, '--', 'cat', from])).stdout);
      let settings;
      try {
        settings = JSON.parse(Buffer.from(read?.stdout ?? '', 'base64').toString('utf8'));
      } catch {
        throw fail(`${from} on ${machine} could not be read, so a second claude there would run without the session's permissions.`);
      }
      const to = `/tmp/woodshed-move-${id}-claude-settings.json`;
      const out = await hc(['file', 'write', '--json', '--on', machine, to], { input: Buffer.from(`${JSON.stringify(withoutStateHooks(settings), null, 2)}\n`) });
      if (out.code !== 0) throw fail(`hc file write ${to} on ${machine}: ${printable(failureOf(out), 300)}`);
      made.files.push({ machine, path: to });
      f.secondSettings = to;
    }

    // ---- 5. The layout, made again on each session's machine, each terminal started as what it was.
    const resumeLine = (a, { own }) => {
      const k = kinds.get(a);
      const f = facts.get(sessionFor(placeOf.get(a)));
      const conversation = conversations.get(a).id;
      if (k.agent === 'codex') return `${f.wrapped ? `${f.sessionDir}/bin/codex` : 'codex'} resume${f.codexFlags} ${conversation}`;
      // Only the session's own agent reports its state to the session's hooks: a second claude there would speak for it.
      // It gets the same settings without those hooks, its permissions and ready gate kept.
      const flags = own || !f.secondSettings ? f.claudeFlags : f.claudeFlags.replace(/ --settings \S+/, ` --settings ${f.secondSettings}`);
      return `${f.wrapped ? `${f.sessionDir}/bin/claude` : 'claude'}${flags} --resume ${conversation}`;
    };
    const lineFor = (a) => {
      const k = kinds.get(a);
      if (k.kind === 'agent') return resumeLine(a, { own: false });
      if (k.kind === 'process' && restart.get(a)) return k.argv.map(shellQuote).join(' ');
      return 'bash -l';
    };
    const ownAgents = new Map();
    for (const sid of new Set(sessionOf.values())) {
      const machine = machinesOf.get(sid).name;
      const spaces = chosen.spaces.map((s) => ({
        ...s, tabs: s.tabs.map((t) => ({ ...t, tree: prune2(t.tree, (a) => sessionFor(placeOf.get(a)) === sid) })).filter((t) => t.tree),
      })).filter((s) => s.tabs.length);
      const start = (a) => {
        const place = placeOf.get(a);
        const cwd = remoteCwd(a);
        if (place.main && place.agent === a) {
          ownAgents.set(a, { sid, machine });
          return { adopt: facts.get(sid).agent.address.replace(/^[^/]+\//, ''), folder: cwd };
        }
        return { folder: cwd, argv: ['/bin/bash', '-lc', `cd ${shellQuote(cwd)} && exec ${lineFor(a)}`] };
      };
      const window = await appSpaces(app);
      // Each space or terminal is noted as it is made, so a failure part way undoes it.
      const built = window
        ? await buildWithApp({ app, hc, machine, spaces, start, sleep, onSpace: (s) => made.spaces.push({ id: s.id }) })
        : await buildWithLabels({ hc, machine, spaces, start, tag: `move-${id}`, onTerminal: (t) => made.terminals.push(t) });
      for (const [a, t] of built.terminals) remoteAt.set(a, t);
      step('layout', `Made ${spaces.length} space${spaces.length === 1 ? '' : 's'} on ${machine}${window ? '' : ' (Herdr\'s window was not open: they show when it opens, splits side by side)'}`, { machine, window: Boolean(window), spaces: built.spaces });
    }

    // The session's own agent: its empty first run ended, and the moved conversation opened in its place.
    for (const [a, { machine }] of ownAgents) {
      const terminal = remoteAt.get(a);
      const k = kinds.get(a);
      const before = parsed((await hc(['get', '--json', terminal])).stdout);
      await hc(['send', '--json', terminal, k.agent === 'codex' ? '/quit' : '/exit']);
      const shell = await until(async () => {
        const t = parsed((await hc(['get', '--json', terminal])).stdout);
        return t && !['claude', 'codex', 'node'].includes(path.basename(String(t.foreground?.name ?? ''))) ? t : null;
      }, { sleep, now, ms: END_MS });
      if (!shell) throw fail(`The session's first ${k.agent} in ${terminal} did not end, so the moved conversation could not take its place.`);
      const cwd = remoteCwd(a);
      const line = `${cwd === folderOf.get(placeOf.get(a)) ? '' : `cd ${shellQuote(cwd)} && `}${resumeLine(a, { own: true })}`;
      const sent = await hc(['send', '--json', terminal, line]);
      if (sent.code !== 0) throw fail(`hc send ${terminal}: ${printable(failureOf(sent), 300)}`);
      ownAgents.get(a).baseline = shell.status_ms ?? before?.status_ms ?? null;
      step('resumed', `Resumed ${a}'s conversation as ${machine}'s own agent`, { address: a, terminal });
    }

    // ---- 6. Each moved agent must say what it is doing before its local one ends.
    for (const a of agents) {
      const terminal = remoteAt.get(a);
      const k = kinds.get(a);
      const baseline = ownAgents.get(a)?.baseline ?? null;
      let seen = 0;
      const state = await until(async () => {
        const t = parsed((await hc(['get', '--json', terminal])).stdout);
        if (!t || t.state === 'finished') throw fail(`The moved ${k.agent} in ${terminal} ended at once${t?.exit_code !== undefined ? ` (exit ${t.exit_code})` : ''}: hc read ${terminal} shows why.`);
        const running = path.basename(String(t.foreground?.name ?? '')) !== 'bash';
        if (k.agent === 'claude' && t.status?.state && running && t.status_ms !== baseline) return t.status.state;
        // Codex says nothing of its state to hc: running for a few seconds is the most there is.
        if (k.agent === 'codex' && running && /codex|node/.test(String(t.foreground?.name ?? ''))) return ++seen >= 3 ? 'running' : null;
        return null;
      }, { sleep, now, ms: LIVE_MS });
      if (!state) throw fail(`The moved ${k.agent} in ${terminal} said nothing in ${LIVE_MS / 1000} s: hc read ${terminal} shows its screen.`);
      live.set(a, state);
      step('live', `${terminal} is ${state}`, { address: a, terminal, state });
    }
    // A local turn can arrive while the remote session starts. Keep the local agent if its copy has advanced.
    for (const a of agents) {
      if (fs.readFileSync(conversations.get(a).file, 'utf8') !== transcripts.get(a)) {
        throw refused(`${a}'s conversation changed during the move. Wait for the agent to finish, then move again.`);
      }
    }
    // A program started again that ended at once is said, not undone: the move itself worked, and its log is there.
    for (const a of processes.filter((x) => restart.get(x))) {
      const t = parsed((await hc(['get', '--json', remoteAt.get(a)])).stdout);
      if (t?.state === 'finished') ended2.add(a);
    }
  } catch (err) {
    cleanSurveys();
    return failed(err);
  }

  // ---- 7. The hand-over: each local agent ends, its terminal labelled with where it went.
  const ended = new Map();
  for (const a of agents) {
    const k = kinds.get(a);
    // Claude says it is idle, and is sent its /exit only then; Codex says nothing to hc, and was checked between turns.
    const sent = await hc(['send', '--json', ...(k.agent === 'claude' ? ['--if', 'idle'] : []), a, k.agent === 'codex' ? '/quit' : '/exit']);
    const gone = sent.code === 0 && await until(async () => {
      const t = parsed((await hc(['get', '--json', a])).stdout);
      if (!t || t.state === 'finished') return true;
      return classify(t).kind !== 'agent' ? true : null;
    }, { sleep, now, ms: END_MS });
    // Labelled as moved only once it ended: one still open here is the person's to end, and is said so.
    if (gone) await hc(['label', '--json', a, `woodshed.moved=${remoteAt.get(a)}`]);
    ended.set(a, Boolean(gone));
  }

  const result = {
    id,
    sessions: [...machinesOf].map(([sid, m]) => ({ id: sid, machine: m.name, url: `${origin}/s/${sid}`, created: made.sessions.some((s) => s.id === sid) })),
    branches: made.branches.map((b) => ({ repo: b.checkout.repo, branch: b.branch, commit: commits.get(b.checkout.root) })),
    terminals: addresses.map((a) => ({
      address: a, kind: kinds.get(a).kind, to: remoteAt.get(a) ?? null,
      ...(kinds.get(a).kind === 'agent' ? { agent: kinds.get(a).agent, conversation: conversations.get(a).id, state: live.get(a), localEnded: ended.get(a) } : {}),
      ...(kinds.get(a).kind === 'process' ? { restarted: restart.get(a) === true, command: shown(kinds.get(a).argv), ...(ended2.has(a) ? { endedAtOnce: true } : {}), ...(holdsCredential.has(a) ? { holdsCredential: true } : {}) } : {}),
    })),
    ignoredEnv: [...surveys.values()].flatMap((s) => s.ignoredEnv),
    bundle: bundle(commits),
  };
  const needsYou = [...live.values()].includes('blocked');
  if (json) emit({ event: 'moved', ...result });
  else {
    say(`Moved ${addresses.length} terminal${addresses.length === 1 ? '' : 's'} (move ${id}):`);
    for (const t of result.terminals) {
      const what = t.kind === 'agent' ? `${t.agent} conversation ${t.conversation}, ${t.state} there${t.localEnded ? '; ended here' : '; still open here: end it yourself'}`
        : t.kind === 'process' ? (t.endedAtOnce ? `${t.command} was started again there and ended at once: hc read ${t.to}`
          : t.restarted ? `${t.command} started again there`
            : t.holdsCredential ? `a shell there: ${t.command} was not started again, as its command line holds what may be a credential, which no session is given`
              : `a shell there: ${t.command} was not started again`) : 'a shell there';
      say(`  ${t.address} -> ${t.to}  ${what}`);
    }
    for (const s of result.sessions) say(`Session ${s.id}: ${s.url}`);
    for (const b of result.branches) say(`Branch ${b.branch} (${b.repo}) holds the work as it was here.`);
    if (processes.length) say('Programs restart rather than move: their local copies still run here, and what they held in memory stays here.');
    say('Databases stay: the session has its own, made from its template; your local data was not copied.');
    if (result.ignoredEnv.length) say(`Stayed here, as git ignores them: ${result.ignoredEnv.join(', ')}. woodshed settings push --own-files <checkout> gives your sessions your own.`);
    if (made.worktrees.length) say(`Agents in worktrees (${made.worktrees.map((w) => w.path).join(', ')}) push their own branches: a session's stop pushes only its own.`);
    if (needsYou) say('A moved agent needs you there: hc attach to it, or open the session.');
  }
  return needsYou ? EXIT.waiting : EXIT.done;
}

function safeReal(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

// A tree with only the terminals `keep` says yes to (moveLayout.prune, by a test rather than a set).
function prune2(tree, keep) {
  if (!tree) return null;
  if (tree.terminal) return keep(tree.terminal) ? tree : null;
  const children = tree.children.map((c) => prune2(c, keep)).filter(Boolean);
  if (!children.length) return null;
  if (children.length === 1) return { ...children[0], weight: tree.weight };
  return { ...tree, children };
}

// Asks again until the answer is something, or the time is up (null).
async function until(check, { sleep, now, ms }) {
  const end = now() + ms;
  for (;;) {
    const answer = await check();
    if (answer) return answer;
    if (now() >= end) return null;
    await sleep(POLL_MS);
  }
}
