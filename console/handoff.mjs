// Handing a session's work to another session: its branch, a written note of where things stand and what is next, and
// files, so the receiving agent picks up without anyone explaining it again (fleet.mjs, handoff).
//
// Who may hand what to whom:
// - The receiver is always a My Woodshed session of the person handing off: a new one, or one of theirs on the same
//   repo. A shared session never receives one: anyone who may type into it could read the note, and its own branch and
//   databases are its issue's.
// - The sender is a My Woodshed session of that person, or a shared session they have (its assignee). A question from
//   Slack, a review and a QA run hand nothing off: they change no branch.
// - The agent hands off only from a private session, as its owner: a shared session's agent takes anyone's typing, so
//   it never starts or types into its assignee's private sessions.
// - Nothing leaves a session that has seen production data, nor reaches one (CLAUDE.md, "Production data reaches a
//   session only through a production MCP server"): its note could carry what it saw, and a tainted receiver pushes to
//   nothing but its owner's private repos.
//
// The note goes to the receiver as a file (handoff.md, the first of its attachments), and in its message too while it is
// short: the message is typed into its agent, or is a new session's prompt, both of which have limits of their own.

import { isAsk, isQa, isReview } from './sessions.mjs';

export const MAX_NOTE_CHARS = 20_000;
// What of the note the receiver's message carries itself; the rest is in its file. A new session's prompt is an ECS
// override (providers/aws/ecsLauncher.mjs keeps it under 6000 characters), and a message to a running agent at most
// statusd's 8000.
export const NOTE_IN_MESSAGE_CHARS = 3000;
export const NOTE_FILE_NAME = 'handoff.md';
const TITLE_CHARS = 80;

function shown(message, status = 409) {
  return Object.assign(new Error(message), { shown: true, status });
}

const sameLogin = (a, b) => Boolean(a && b) && String(a).toLowerCase() === String(b).toLowerCase();

/** @returns {boolean}  whether the session's kind can hand its work off at all: one that works on a branch */
export function handsOff(session) {
  return Boolean(session) && !isAsk(session) && !isQa(session) && !isReview(session);
}

/**
 * Why `login` may not hand `sender`'s work off, or null.
 * @param {{sender: object, login: string|null, via: 'person'|'agent', locked?: boolean}} args  `locked`: its lockdown is
 *   under way (fleet.isLocked), which counts as tainted
 * @returns {Error|null}  a shown error, its status the HTTP answer's
 */
export function senderRefusal({ sender, login, via, locked = false }) {
  if (!login) return shown('handing off needs GitHub sign-in: the receiver is one of your My Woodshed sessions', 409);
  if (!handsOff(sender)) return shown('a question, a review or a QA run hands nothing off: it works on no branch of its own');
  if (sender.taintedAt || locked) return shown('this session has seen production data: nothing it holds is handed to another session');
  if (sender.owner) {
    if (!sameLogin(sender.owner, login)) return shown('only its owner hands off a My Woodshed session', 403);
  } else {
    if (via === 'agent') return shown('a shared session\'s agent cannot hand off: whoever has it hands off from the console', 403);
    if (!sameLogin(sender.assignee, login)) return shown('only whoever has a shared session hands it off: take it first', 403);
  }
  if (sender.status === 'stopping' || sender.status === 'starting' || sender.status === 'queued') {
    return shown(`it is ${sender.status}: hand it off once it runs or has stopped`);
  }
  if (!sender.branch) return shown('it has no branch to hand off yet');
  return null;
}

/**
 * Why `receiver` cannot take `sender`'s work, or null.
 * @returns {Error|null}
 */
export function receiverRefusal({ sender, receiver, login }) {
  if (!receiver || !receiver.owner || !sameLogin(receiver.owner, login)) return shown('no session of yours with that id: the receiver is one of your My Woodshed sessions', 404);
  if (receiver.id === sender.id) return shown('a session cannot hand off to itself');
  if ((receiver.project ?? null) !== (sender.project ?? null)) return shown(`it works on ${receiver.repo ?? receiver.project}, not ${sender.repo ?? sender.project}: the branch would not be there`);
  if (receiver.taintedAt) return shown('that session has seen production data: hand off to a new session, or another of yours');
  if (receiver.status === 'starting' || receiver.status === 'stopping') return shown(`that session is ${receiver.status}: try again once it runs or has stopped`);
  return null;
}

/**
 * The sessions `login` could hand `sender`'s work to, for the page's and the agent's lists.
 * @returns {object[]}
 */
export function handoffTargets(sessions, sender, login) {
  return sessions.filter((s) => !receiverRefusal({ sender, receiver: s, login }));
}

/** @returns {string}  the note as it is kept and handed over: trimmed, at most MAX_NOTE_CHARS */
export function noteText(raw) {
  const text = String(raw ?? '').replace(/\r\n?/g, '\n').trim();
  if (text.length > MAX_NOTE_CHARS) throw shown(`the note is ${text.length} characters: at most ${MAX_NOTE_CHARS}`, 400);
  return text;
}

/** @returns {string}  a new receiver's name, from its sender's */
export function receiverTitle(sender, given = '') {
  const named = String(given ?? '').trim();
  if (named) return named.slice(0, TITLE_CHARS);
  return `${sender.title || sender.branch} (continued)`.slice(0, TITLE_CHARS);
}

function whoText(via, by) {
  return via === 'agent' ? 'its agent' : `@${by}`;
}

/** The file the receiver gets: the note, under what it came from. */
export function noteFile({ sender, by, via, note, at, prUrl = null }) {
  return [
    `# Handed off from "${sender.title || sender.id}"`,
    '',
    `From Woodshed session ${sender.id}, by ${whoText(via, by)}, at ${at}.`,
    `Branch: \`${sender.branch}\`${prUrl ? `. Pull request: ${prUrl}` : ''}`,
    '',
    '## Where things stand and what is next',
    '',
    note,
    '',
  ].join('\n');
}

/**
 * What the receiving agent is told: a new session's prompt, or a message typed into a running one (held until it is at
 * its prompt). The note is in it while short, and always in its file.
 * @param {{sender: object, by: string, via: 'person'|'agent', note: string, notePath: string|null, files: string[],
 *          existing: boolean, prUrl?: string|null}} args  `files`: paths in the receiver of the other attachments, for an
 *   existing session (a new one's entrypoint lists its attachments under the prompt itself)
 */
export function handoffMessage({ sender, by, via, note, notePath, files = [], existing, prUrl = null }) {
  const lines = [
    `This work was handed off to you from the Woodshed session "${sender.title || sender.id}" (${sender.id}), by ${whoText(via, by)}. Pick it up from here: what it did and what is next are below, so do not ask for them again.`,
    '',
    `Its branch is \`${sender.branch}\`, pushed${prUrl ? `, with its pull request ${prUrl}` : ''}.`,
  ];
  if (existing) {
    lines.push(`Go on on that branch: commit or push what you have on yours first, then \`git fetch origin ${sender.branch}\` and \`git switch ${sender.branch}\`. Keep your own branch's work unless the note says otherwise.`);
  } else lines.push('You are on it already.');
  lines.push('');
  if (note.length <= NOTE_IN_MESSAGE_CHARS) {
    lines.push('Where things stand and what is next:', '', note);
    if (notePath) lines.push('', `The same note is in ${notePath}.`);
  } else if (notePath) {
    lines.push(`Where things stand and what is next is in ${notePath}: read all of it before you start.`);
  } else {
    lines.push('Where things stand and what is next (cut short here: it was longer):', '', `${note.slice(0, NOTE_IN_MESSAGE_CHARS)}…`);
  }
  if (files.length) lines.push('', 'Files handed over with it:', ...files.map((f) => `- ${f}`));
  return lines.join('\n');
}

/**
 * What the console types into a running sender's agent when the person asks it to write the note: it writes it and
 * hands off itself, with woodshed-handoff (session/bin).
 */
export function writeNoteRequest({ to, stop, receiverTitle: title = null }) {
  const target = to === 'new' ? 'a new session' : `your session "${title ?? to}" (${to})`;
  const flags = [`--to ${to}`, ...(stop ? [] : ['--keep-running'])].join(' ');
  return [
    `Hand this session's work off to ${target}, so its agent can pick up from here without anyone explaining it again.`,
    'Write a note for it in Markdown: what the task is, what is done, what is left and in what order, what you tried that did not work, decisions made and why, and how to check the work (commands, pages, tests). Name the files that matter. Do not ask me anything first.',
    `Then run \`woodshed-handoff ${flags}\` with the note on its stdin (a heredoc), and add \`--file <path>\` for each file it needs that is not in the branch. It commits and pushes the branch itself.`,
    stop ? 'This session stops once the work is handed off: end your turn after the command answers.' : 'This session keeps running after it.',
  ].join('\n');
}
