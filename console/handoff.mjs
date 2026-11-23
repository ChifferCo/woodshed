// Hand off: one My Woodshed session's work carried into a new session run by another agent (Claude Code to Codex, Codex
// to Claude Code, or a fresh one of the same kind), on the same branch. Each agent keeps its conversation in a format of
// its own, which no other agent reads, so what goes across is agent-neutral: the branch, pushed by the old session's
// stop, and the conversation as statusd's `GET /transcript` shapes it for the Chat tab (session/sessionTranscript.mjs),
// written out here as a Markdown file the new session gets as an attachment. An agent added to AGENTS (sessions.mjs)
// can be handed off to and from with nothing more here than its name in AGENT_NAMES.
//
// What goes across depends on why: the person picks whether the conversation goes (a fresh start on the branch alone
// is often what a stuck agent needs), and may add a note of their own, which leads the new session's prompt.

// The products' names, for the prompt and the file. One not listed is called by its id.
export const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex' };
// The file the new session gets, under /tmp/uploads (attachments.mjs names it `1-handoff.md`).
export const HANDOFF_FILE = 'handoff.md';
// The note the person adds, at most; the conversation file, at most, its oldest entries left out first.
export const MAX_NOTE_CHARS = 4000;
export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

/** @returns {string} */
export function agentName(agent) {
  return AGENT_NAMES[agent] ?? String(agent || 'claude');
}

/**
 * The person's note, as it goes into the prompt: trimmed, and refused when over the limit rather than cut, since a cut
 * note can say something else.
 * @param {unknown} note
 * @returns {string}
 * @throws {Error}  shown, for a note that is not text or is too long
 */
export function handoffNote(note) {
  if (note === undefined || note === null) return '';
  if (typeof note !== 'string') throw Object.assign(new Error('the note must be text'), { shown: true });
  const text = note.trim();
  if (text.length > MAX_NOTE_CHARS) throw Object.assign(new Error(`the note is over ${MAX_NOTE_CHARS} characters`), { shown: true });
  return text;
}

// A fence longer than any run of backticks in the text, so a tool line or a pasted code block never closes it early.
function fenced(text) {
  const longest = Math.max(2, ...[...String(text).matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

function entryBlock(entry) {
  const when = entry.at ? ` (${entry.at})` : '';
  if (entry.role === 'user') return `### The person${when}\n\n${entry.text}`;
  if (entry.role === 'assistant') return `### The agent${when}\n\n${entry.text}`;
  const files = (entry.diffs ?? []).map((d) => d?.path).filter(Boolean);
  const marks = [entry.error && 'failed', entry.denied && `approval refused: ${entry.denied}`].filter(Boolean);
  return [
    `- Ran \`${String(entry.tool || 'tool').replace(/`/g, '')}\`${marks.length ? ` (${marks.join('; ')})` : ''}${when}`,
    entry.text ? fenced(entry.text) : null,
    files.length ? `  Changed: ${files.map((f) => `\`${String(f).replace(/`/g, '')}\``).join(', ')}` : null,
  ].filter(Boolean).join('\n');
}

/**
 * The hand-off file: who handed off what, then the conversation so far, oldest first. Kept under MAX_DOCUMENT_BYTES by
 * leaving out its oldest entries, and says how many it left out.
 * @param {{from: {id: string, title: string, agent: string, branch: string|null}, to: {agent: string}, entries: object[],
 *   at: string}} args  entries: sessionTranscript.mjs's Entry
 * @returns {string}
 */
export function handoffDocument({ from, to, entries, at }) {
  const head = [
    `# Hand-off from ${agentName(from.agent)}`,
    '',
    `Session ${from.id}, "${from.title}", ran ${agentName(from.agent)} on branch \`${from.branch}\` until ${at}, when its`,
    `person handed the work to ${agentName(to.agent)}. Its work up to then is committed and pushed on that branch.`,
    '',
    'Below is its conversation, as its own record kept it: what the person asked, what the agent said, and each tool it',
    'ran. Tool output is left out, and long messages are cut. Read it for the why; the branch has the what.',
    '',
    '## The conversation',
    '',
    '',
  ].join('\n');
  const blocks = (entries ?? []).map(entryBlock);
  let kept = blocks;
  const size = (list) => Buffer.byteLength(head) + list.reduce((n, b) => n + Buffer.byteLength(b) + 2, 0) + 200;
  while (kept.length && size(kept) > MAX_DOCUMENT_BYTES) kept = kept.slice(1);
  const left = blocks.length - kept.length;
  const lead = left ? [`_${left} earlier ${left === 1 ? 'entry was' : 'entries were'} left out, to keep this file small._`] : [];
  const body = kept.length ? kept : ['_The agent had no conversation to read._'];
  return `${head}${[...lead, ...body].join('\n\n')}\n`;
}

/**
 * The new session's prompt. The attachments' paths are listed under it by the entrypoint.
 * @param {{from: {id: string, title: string, agent: string, branch: string|null}, to: {agent: string}, note: string,
 *   conversation: boolean}} args
 * @returns {string}
 */
export function handoffPrompt({ from, note, conversation }) {
  return [
    note ? `${note}\n` : null,
    `You are taking over work from a ${agentName(from.agent)} session (${from.id}, "${from.title}") on this branch,`,
    `\`${from.branch}\`. Its work is committed and pushed here: start with \`git log\` and \`git status\` to see where it got to.`,
    conversation
      ? `Its conversation is in the attached ${HANDOFF_FILE}: read it for what was asked and decided, then carry on from where it left off.`
      : 'Its conversation was not handed over: work from the branch, and from the note above when there is one.',
    'If what is left to do is unclear, say what you found and ask before changing anything.',
  ].filter((line) => line !== null).join('\n');
}
