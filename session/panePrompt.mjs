// What the agent asks in its pane, read from the screen, and the keys that answer it: the Chat tab answers claude's
// AskUserQuestion and an approval prompt (claude's permission dialog, codex's approval) without the TUI tab. statusd
// types the keys (POST /answer); this file never types blind. It reads the pane (`tmux capture-pane -p`), checks the
// picker on screen is the one being answered (the question's text and its options' labels, or an approval's key: the
// hash of all it asks, as drawn), works out the moves from the row the picker has highlighted, and reads the pane again
// after each step, refusing as soon as the screen is not what the step should have left.
//
// The shapes are claude's and codex's own, captured from their panes (shared/__fixtures__/pane-ask-*.txt and
// pane-permission-*.txt, Claude Code 2.1.247 and 2.1.328). claude's question picker:
//
//   ←  ☐ Colour  ☐ Size  ✔ Submit  →          the tabs: one per question (☒ once answered), Submit with several
//
//   Which colour do you prefer?                 the question (a multi-select one is drawn after `│ `)
//
//   ❯ 1. Red                                    its options, the highlighted one after ❯, a chosen one ending ✔;
//        Warm, high-energy                      under each, its description
//     2. Blue
//     3. Type something.                        then the picker's own rows, which no answer here picks
//   ──────
//     4. Chat about this
//   Enter to select · Tab/Arrow keys to navigate · Esc to cancel
//
// With several questions, the last answer opens a review (`Review your answers`, each `● question` over `→ answer`,
// then `1. Submit answers`, `2. Cancel`). An approval is a title (`Do you want to proceed?`, codex's `Would you like to
// run the following command?`) over numbered options from `Yes` to `No`, with what it asks to run above it (claude) or
// between (codex).

import crypto from 'node:crypto';

const RULE = /^\s*─{10,}\s*$/;
const DASHED = /^\s*╌{10,}\s*$/;
const ROW = /^\s*([❯›>])?\s*(\d{1,2})\.\s+(.*?)\s*$/;
const TABS = /[☐☒]/;
const PICKER_FOOT = /Enter to select\b.*Esc to cancel/;
const REVIEW_HEAD = /^\s*Review your answers\s*$/;
const CLAUDE_TITLE = /^\s*Do you want to .+\?\s*$/;
const CODEX_TITLE = /^\s*Would you like to .+\?\s*$/;
const CLAUDE_APPROVAL_FOOT = /^\s*Esc to cancel\b/;
const CODEX_APPROVAL_FOOT = /Press enter to confirm/i;
// Grok Build's approval (its source, xai-grok-pager's permissions.rs and prompter.rs at 1.0.45, and the 1.0.92 binary's
// strings; not captured from a pane): `Allow \`git\`?`, `Allow Edit to src/a.ts?`, `Allow Execute?`, over numbered options,
// `Yes, and don't ask again for anything (always-approve mode)`, `Yes, proceed`, `Always allow: …`, `No, and tell Grok
// what to do differently` (or `No, reject (type to add feedback)`). A digit picks its row (`1`–`9`).
const GROK_TITLE = /^\s*Allow .+\?\s*$/;
// OpenCode's (its source, tui/src/routes/session/permission.tsx at v1.19.6; not captured): `△ Permission required` over
// what it asks, then its choices on one line, `Allow once  Allow always  Reject`, the picked one shown by its colour
// alone. Enter takes the picked one (Allow once at first), Esc rejects, and Left walks back to Allow once.
const OPENCODE_TITLE = /^\s*[△▲]?\s*Permission required\s*$/;
const OPENCODE_CHOICES = /^\s*Allow once\s{2,}Allow always\s{2,}Reject\b/;
// What a row that is the picker's own says: no answer from the page picks these.
const OWN_ROW = /^(\[.\]\s*)?(Type something\.?|Chat about this|Next)$/;
const CHECKBOX = /^\[(.)\]\s+/;
const CHOSEN = /\s+✔$/;
const SHORTCUT = /\s+\((?:[a-z]|esc|enter)\)$/i;
// The most a field read from the screen keeps.
const MAX_LINE = 300;
const MAX_DETAIL = 6;

/**
 * What an approval asks, exactly: the lines it draws from its head down to its first option, each as on screen (its
 * spaces kept, only the padding at the end dropped), hashed. The page sends it back with its decision, and statusd
 * types only while the pane shows that same text: a command that differs by one space, or in a part the page never
 * showed, is another approval.
 */
export function approvalKey(agent, lines) {
  return crypto.createHash('sha256').update(`${agent}\n${lines.map((l) => l.trimEnd()).join('\n')}`).digest('hex');
}

export const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

function linesOf(pane) {
  return typeof pane === 'string' ? pane.replace(/\r/g, '').split('\n') : [];
}

function lastIndex(lines, re, before = lines.length) {
  for (let i = Math.min(before, lines.length) - 1; i >= 0; i--) if (re.test(lines[i])) return i;
  return -1;
}

// The numbered rows from `from` to `to`, each with the lines under it (a description, or the rest of a wrapped label).
function rowsOf(lines, from, to) {
  const rows = [];
  for (let i = from; i < to; i++) {
    const m = ROW.exec(lines[i]);
    if (m) {
      rows.push({ n: Number(m[2]), text: m[3], highlighted: Boolean(m[1]), line: i, under: [] });
    } else if (rows.length && lines[i].trim() && !RULE.test(lines[i]) && !DASHED.test(lines[i])) {
      rows[rows.length - 1].under.push(lines[i].trim());
    }
  }
  return rows;
}

/** The tabs of claude's picker: `←  ☒ Colour  ☐ Size  ✔ Submit  →`, or ` ☐ Colour` for one question. */
export function readTabs(line) {
  const tabs = [];
  for (const m of String(line).matchAll(/([☐☒✔])\s+(.+?)(?=\s{2,}|\s*[☐☒✔→]|\s*$)/g)) {
    tabs.push({ mark: m[1], name: m[2].trim() });
  }
  return {
    questions: tabs.filter((t) => t.mark !== '✔' || t.name !== 'Submit').map((t) => ({ name: t.name, answered: t.mark === '☒' })),
    submit: tabs.some((t) => t.mark === '✔' && t.name === 'Submit'),
  };
}

/**
 * claude's AskUserQuestion picker, as the pane shows it now.
 * @param {string} pane  raw `tmux capture-pane -p` output
 * @returns {null|{step: 'question', question: string, multiSelect: boolean, tabs: object,
 *   options: {n: number, label: string, highlighted: boolean, chosen: boolean}[], highlighted: number|null}
 *   |{step: 'review', answers: {question: string, answer: string}[], options: object[], highlighted: number|null}}
 *   options are the answers only (not Type something, nor Chat about this); highlighted is the option's index there,
 *   or null when the highlight is on one of the picker's own rows
 */
export function readQuestionPicker(pane) {
  const lines = linesOf(pane);
  const review = lastIndex(lines, REVIEW_HEAD);
  const foot = lastIndex(lines, PICKER_FOOT);
  if (review !== -1 && review > foot) return readReview(lines, review);
  if (foot === -1) return null;
  const tabLine = lastIndex(lines, TABS, foot);
  // The picker sits under the rule that ends the conversation above it.
  if (tabLine === -1 || lastIndex(lines, RULE, tabLine) === -1) return null;
  const rows = rowsOf(lines, tabLine + 1, foot);
  if (!rows.length) return null;
  const question = squash(lines.slice(tabLine + 1, rows[0].line).map((l) => l.replace(/^\s*│\s?/, '')).join(' '));
  if (!question) return null;
  const answers = [];
  let multiSelect = false;
  for (const row of rows) {
    let label = row.text;
    if (CHECKBOX.test(label)) {
      multiSelect = true;
      label = label.replace(CHECKBOX, '');
    }
    if (OWN_ROW.test(label)) break;
    const chosen = CHOSEN.test(label);
    // The lines under it: the rest of a label claude wrapped (at a word, anywhere short of the edge), then its
    // description, indented alike; which is which is known only against the label given (sameLabel).
    answers.push({ n: row.n, label: label.replace(CHOSEN, '').slice(0, MAX_LINE), highlighted: row.highlighted, chosen, under: row.under.slice(0, MAX_DETAIL) });
  }
  const at = answers.findIndex((o) => o.highlighted);
  return { step: 'question', question: question.slice(0, 1000), multiSelect, tabs: readTabs(lines[tabLine]), options: answers, highlighted: at === -1 ? null : at };
}

function readReview(lines, head) {
  const rows = rowsOf(lines, head + 1, lines.length);
  const firstRow = rows[0]?.line ?? lines.length;
  const answers = [];
  for (let i = head + 1; i < firstRow; i++) {
    const text = lines[i].trim();
    if (text.startsWith('● ')) answers.push({ question: text.slice(2), answer: null });
    else if (text.startsWith('→ ') && answers.length) answers[answers.length - 1].answer = text.slice(2);
    else if (text && answers.length) {
      const last = answers[answers.length - 1];
      if (last.answer === null) last.question += ` ${text}`;
      else last.answer += ` ${text}`;
    }
  }
  const options = rows.map((r) => ({ n: r.n, label: r.text, highlighted: r.highlighted, chosen: false }));
  if (!options.some((o) => o.label === 'Submit answers')) return null;
  const at = options.findIndex((o) => o.highlighted);
  return {
    step: 'review',
    answers: answers.map((a) => ({ question: squash(a.question), answer: squash(a.answer) })),
    options,
    highlighted: at === -1 ? null : at,
  };
}

// claude's `Tip: …` lines over its permission dialog, with the lines a narrow pane wrapped them onto (a 80-column pane
// puts the auto mode tip's last word, `below`, on a line of its own). A line is wrapped onto the next when the next's
// first word would not have fitted after it in the pane's width, which the rule over the dialog spans.
// A block as the agent drew it, for the page to show what it asks faithfully: each line's own indentation and the blank
// lines between kept, only the indentation all of them share taken off, and blank lines at either end dropped.
function asDrawn(raw) {
  const lines = raw.map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
  return lines.map((l) => (l.trim() ? l.slice(indent) : ''));
}

// claude's tip, and the lines it wraps onto, in the one place claude draws one: the line right under the dialog's head
// (`Bash command`). A line starting `Tip:` anywhere else, a command's own line among them, is what it asks, and stays:
// the person approves only what the page showed them.
function dropTips(raw, width) {
  const head = raw.findIndex((l) => l.trim());
  const at = head + 1;
  if (head === -1 || !/^\s*Tip:/.test(raw[at] ?? '')) return raw;
  let end = at;
  while (end + 1 < raw.length && raw[end + 1].trim() && !DASHED.test(raw[end + 1])
    && raw[end].trimEnd().length + 1 + raw[end + 1].trim().split(/\s/)[0].length > width) end++;
  return [...raw.slice(0, at), ...raw.slice(end + 1)];
}

/**
 * An approval the agent waits on: claude's permission dialog, codex's approval, or Grok Build's or OpenCode's.
 * @param {string} pane
 * @param {string} [agent]  the session's agent: only its own shape is read. Left out, every shape is tried
 * @returns {null|{agent: string, what: string|null, title: string, detail: string[],
 *   options: {n: number, label: string, highlighted: boolean}[], highlighted: number|null, approve: number, deny: number,
 *   keys?: {approve: string[], deny: string[]}, digits?: boolean}}
 *   approve and deny are indexes into options: the first that says Yes (and not `Yes, and …`), and the first that says No.
 *   keys: an approval answered with the same keys whatever is highlighted (OpenCode's, whose highlight is a colour).
 *   digits: one whose rows are picked by their number (Grok Build's)
 */
export function readApproval(pane, agent) {
  const lines = linesOf(pane);
  const shapes = [['claude', CLAUDE_TITLE, CLAUDE_APPROVAL_FOOT], ['codex', CODEX_TITLE, CODEX_APPROVAL_FOOT]];
  for (const [who, titleRe, footRe] of shapes) {
    if (agent && agent !== who) continue;
    const foot = lastIndex(lines, footRe);
    if (foot === -1) continue;
    const title = lastIndex(lines, titleRe, foot);
    if (title === -1) continue;
    const rows = rowsOf(lines, title + 1, foot);
    if (!rows.length) continue;
    let what = null;
    let detail;
    let from = title;
    if (who === 'claude') {
      const rule = lastIndex(lines, RULE, title);
      from = rule + 1;
      const head = lines.slice(rule + 1, title).map((l) => l.trim());
      // claude's question picker has its tabs here; it is not an approval, whatever its question says.
      if (rule === -1 || head.some((l) => TABS.test(l))) continue;
      const kept = asDrawn(dropTips(lines.slice(rule + 1, title), lines[rule].trimEnd().length)
        .filter((l) => !/^\s*╌+\s*$/.test(l) && l.trim() !== 'This command requires approval'));
      what = kept.shift()?.trim() ?? null;
      detail = asDrawn(kept);
    } else {
      // codex draws what it asks between the title and its options: the reason, the command.
      detail = asDrawn(lines.slice(title + 1, rows[0].line));
    }
    const read = numberedApproval(who, lines, title, from, rows, what, detail);
    if (read) return read;
  }
  if (!agent || agent === 'grok') {
    const read = grokApproval(lines);
    if (read) return read;
  }
  if (!agent || agent === 'opencode') return opencodeApproval(lines);
  return null;
}

// The options and the rest, once an agent's own reader found its title, what it asks and its numbered rows.
function numberedApproval(agent, lines, title, from, rows, what, detail, extra = {}) {
  const options = rows.map((r) => ({ n: r.n, label: r.text.replace(SHORTCUT, '').slice(0, MAX_LINE), highlighted: r.highlighted }));
  // Just this once: never a `Yes, and …` row, which allows it for good or switches the mode. With none, no approval.
  const approve = options.findIndex((o) => /^Yes\b/.test(o.label) && !/^Yes,? and\b/i.test(o.label));
  const deny = options.findIndex((o) => /^No\b/.test(o.label));
  if (approve === -1 || deny === -1) return null;
  const at = options.findIndex((o) => o.highlighted);
  // The page shows the whole of what it asks, or nothing to answer it with: a clipped command could hide its end.
  const complete = detail.length <= MAX_DETAIL && detail.every((l) => l.length <= MAX_LINE) && (!what || what.length <= MAX_LINE)
    && squash(lines[title]).length <= MAX_LINE;
  return {
    agent,
    key: approvalKey(agent, lines.slice(from, rows[0].line)),
    complete,
    what: what ? what.slice(0, MAX_LINE) : null,
    title: squash(lines[title]).slice(0, MAX_LINE),
    detail: detail.slice(0, MAX_DETAIL).map((l) => l.slice(0, MAX_LINE)),
    options,
    highlighted: at === -1 ? null : at,
    approve,
    deny,
    ...extra,
  };
}

// Grok Build's: a title, what it asks under it, then numbered options down to a blank line or the end of the screen,
// with no key hint of its own known under them. The last such title on screen is the live one.
function grokApproval(lines) {
  const title = lastIndex(lines, GROK_TITLE);
  if (title === -1) return null;
  const first = lines.findIndex((l, i) => i > title && ROW.test(l));
  if (first === -1) return null;
  let end = first + 1;
  while (end < lines.length && lines[end].trim() && !RULE.test(lines[end])) end++;
  const rows = rowsOf(lines, first, end);
  // Options numbered from 1, each once: anything else is a list the agent printed, not a prompt.
  if (!rows.length || rows.some((r, i) => r.n !== i + 1)) return null;
  return numberedApproval('grok', lines, title, title, rows, null, asDrawn(lines.slice(title + 1, first)), { digits: true });
}

// OpenCode's: its title, what it asks, and its choices on one line. Answered with keys alone, since the pick shows only
// as a colour: Left to Allow once (the leftmost, where it starts) then Enter, or Esc, which rejects.
function opencodeApproval(raw) {
  // Its panel is drawn inside a left border (`┃`), as its input box is.
  const lines = raw.map((l) => l.replace(/^\s*┃ ?/, ''));
  const choices = lastIndex(lines, OPENCODE_CHOICES);
  if (choices === -1) return null;
  const title = lastIndex(lines, OPENCODE_TITLE, choices);
  if (title === -1) return null;
  const body = asDrawn(lines.slice(title + 1, choices));
  const what = body.shift()?.trim() ?? null;
  const detail = asDrawn(body);
  const complete = detail.length <= MAX_DETAIL && detail.every((l) => l.length <= MAX_LINE) && (!what || what.length <= MAX_LINE);
  return {
    agent: 'opencode',
    key: approvalKey('opencode', lines.slice(title, choices)),
    complete,
    what: what ? what.slice(0, MAX_LINE) : null,
    title: 'Permission required',
    detail: detail.slice(0, MAX_DETAIL).map((l) => l.slice(0, MAX_LINE)),
    options: [{ n: 1, label: 'Allow once', highlighted: false }, { n: 2, label: 'Allow always', highlighted: false }, { n: 3, label: 'Reject', highlighted: false }],
    highlighted: null,
    approve: 0,
    deny: 2,
    keys: { approve: ['Left', 'Left', 'Left', 'Enter'], deny: ['Escape'] },
  };
}

/**
 * What the pane asks now, for the Chat tab: a question picker or an approval, or null.
 * @param {string} pane
 */
export function readPrompt(pane, agent) {
  // Only claude asks questions in a picker.
  const picker = !agent || agent === 'claude' ? readQuestionPicker(pane) : null;
  if (picker) return { kind: 'question', ...picker };
  const approval = readApproval(pane, agent);
  return approval ? { kind: 'approval', ...approval } : null;
}

// An option on screen against the label claude was given: its first line, alone or with the lines it wrapped onto under
// it, must be that label, all of it. A shorter option, or another whose first line is the same, is never it. With the
// option's description given too, what follows the label on screen must be that description (or nothing), which tells
// a wrapped label from a description under it: a label that is only the first line of a longer one does not pass.
function sameLabel(option, given, description) {
  const want = squash(given);
  const under = option.under ?? [];
  const rest = (k) => squash(under.slice(k).join(' '));
  // With no description given, nothing tells the label's wrapped lines from a description under it: the label must take
  // every line there is, or the answer goes to the TUI tab.
  const describedHere = (k) => !rest(k) || (description !== undefined && !!squash(description) && rest(k).startsWith(squash(description).slice(0, 40)));
  let text = option.label;
  for (let k = 0; k <= under.length; k++) {
    if (k > 0) text += ` ${under[k - 1]}`;
    if (squash(text) === want && describedHere(k)) return true;
  }
  return false;
}

/**
 * @param {ReturnType<typeof readQuestionPicker>} screen
 * @param {{question: string, options: string[], descriptions?: string[]}} want  as the transcript holds it
 * @returns {{ok: true}|{ok: false, why: string}}  why is a code: no-picker, other-question, multi-select, other-options
 */
export function matchQuestion(screen, want) {
  if (!screen) return { ok: false, why: 'no-picker' };
  if (screen.step !== 'question' || squash(screen.question) !== squash(want.question)) return { ok: false, why: 'other-question' };
  if (screen.multiSelect) return { ok: false, why: 'multi-select' };
  if (screen.options.length !== want.options.length || !screen.options.every((o, i) => sameLabel(o, want.options[i], want.descriptions?.[i]))) {
    return { ok: false, why: 'other-options' };
  }
  return { ok: true };
}

/**
 * @param {ReturnType<typeof readQuestionPicker>} screen  the review step
 * @param {{question: string, options: string[], pick: number}[]} wants
 */
export function matchReview(screen, wants) {
  if (!screen || screen.step !== 'review') return { ok: false, why: 'no-review' };
  if (screen.answers.length !== wants.length) return { ok: false, why: 'other-answers' };
  const same = wants.every((w, i) => squash(screen.answers[i].question) === squash(w.question) && squash(screen.answers[i].answer) === squash(w.options[w.pick]));
  return same ? { ok: true } : { ok: false, why: 'other-answers' };
}

/**
 * @param {ReturnType<typeof readApproval>} screen
 * @param {{key: string}} want  the key of the approval the page showed, from GET /prompt
 */
export function matchApproval(screen, want) {
  if (!screen) return { ok: false, why: 'no-approval' };
  if (screen.key !== want.key) return { ok: false, why: 'other-approval' };
  if (!screen.complete) return { ok: false, why: 'incomplete' };
  return { ok: true };
}

/**
 * The arrow keys that move the picker's highlight to the option at `index`, from the row it has highlighted now.
 * Enter then picks it, once the pane shows the highlight there.
 * @param {{options: object[], highlighted: number|null}} screen
 * @param {number} index
 * @returns {string[]|null}  tmux key names; null when the highlight is on none of the options, so no count is safe
 */
export function planMoves(screen, index) {
  if (screen?.highlighted === null || screen?.highlighted === undefined || !screen.options[index]) return null;
  const steps = index - screen.highlighted;
  return Array.from({ length: Math.abs(steps) }, () => (steps > 0 ? 'Down' : 'Up'));
}

// What the page is told when the pane is not what it should be. No text from the pane or the answer.
const REFUSALS = {
  'no-picker': 'the agent\'s terminal shows no question now',
  'other-question': 'the agent\'s terminal shows another question',
  'multi-select': 'this question takes several options, which only the TUI tab can pick',
  'other-options': 'the options on screen are not the ones shown here',
  'no-review': 'the agent\'s terminal did not show its review of the answers',
  'other-answers': 'the agent\'s terminal shows other answers than the ones sent',
  'no-approval': 'the agent\'s terminal shows no approval now',
  'other-approval': 'the agent\'s terminal asks something else now',
  'incomplete': 'what the agent asks is too long to show here in full',
  'no-highlight': 'the agent\'s terminal shows no highlighted option',
  'not-moved': 'the highlight did not move where it should',
  'still-there': 'the agent\'s terminal still shows the prompt',
};

export class Refusal extends Error {
  /** @param {string} why  a code of REFUSALS @param {number} typed  how many answers were already typed */
  constructor(why, typed = 0) {
    super(`${REFUSALS[why] ?? why}${typed ? ` (${typed} answered in the terminal before it stopped)` : ''}`);
    this.why = why;
    this.typed = typed;
  }
}

/**
 * @typedef {{capture: () => Promise<string>, keys: (...keys: string[]) => Promise<void>, sleep?: (ms: number) => Promise<void>,
 *   waitMs?: number, everyMs?: number, agent?: string, literal?: (text: string) => Promise<void>}} PaneIo
 *   agent: the session's agent, whose approval alone is read. literal: text typed as it is (Grok Build's digits)
 */

// The pane read again until `ok` says yes or the wait is over. Returns the last read and whether it passed.
async function settle(io, read, ok) {
  const sleep = io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const until = Date.now() + (io.waitMs ?? 3000);
  for (;;) {
    const screen = read(await io.capture());
    if (ok(screen)) return { screen, ok: true };
    if (Date.now() >= until) return { screen, ok: false };
    await sleep(io.everyMs ?? 120);
  }
}

// Moves the highlight to `index`, checks the pane shows it there and is still the same picker, then presses Enter.
async function pickRow(io, read, screen, index, still, typed) {
  const moves = planMoves(screen, index);
  if (!moves) throw new Refusal('no-highlight', typed);
  if (moves.length) {
    await io.keys(...moves);
    const moved = await settle(io, read, (s) => s && still(s) && s.highlighted === index);
    if (!moved.ok) throw new Refusal(moved.screen && still(moved.screen) ? 'not-moved' : 'other-question', typed);
  }
  await io.keys('Enter');
  return moves.length;
}

/**
 * Answers claude's AskUserQuestion in its pane: each question's option, then Submit answers on the review.
 * @param {PaneIo} io
 * @param {{question: string, options: string[], pick: number}[]} wants  every question the picker asks, in order
 * @returns {Promise<{moves: number}>}  how many arrow keys it took
 * @throws {Refusal}
 */
export async function answerQuestions(io, wants) {
  let screen = readQuestionPicker(await io.capture());
  // The picker must be on the first question: one the person moved on in the TUI tab is theirs to finish there.
  const first = matchQuestion(screen, wants[0]);
  if (!first.ok) throw new Refusal(first.why);
  if (screen.tabs.questions.length !== wants.length) throw new Refusal('other-question');
  let moves = 0;
  for (let i = 0; i < wants.length; i++) {
    if (i > 0) {
      const next = await settle(io, readQuestionPicker, (s) => matchQuestion(s, wants[i]).ok);
      if (!next.ok) throw new Refusal(matchQuestion(next.screen, wants[i]).why, i);
      screen = next.screen;
    }
    moves += await pickRow(io, readQuestionPicker, screen, wants[i].pick, (s) => matchQuestion(s, wants[i]).ok, i);
  }
  if (screen.tabs.submit) {
    const review = await settle(io, readQuestionPicker, (s) => matchReview(s, wants).ok);
    if (!review.ok) throw new Refusal(matchReview(review.screen, wants).why, wants.length);
    const submit = review.screen.options.findIndex((o) => o.label === 'Submit answers');
    moves += await pickRow(io, readQuestionPicker, review.screen, submit, (s) => matchReview(s, wants).ok, wants.length);
  }
  const gone = await settle(io, readQuestionPicker, (s) => !s);
  if (!gone.ok) throw new Refusal('still-there', wants.length);
  return { moves };
}

/**
 * Approves or denies the approval the pane shows, once it is the one the page showed.
 * @param {PaneIo} io
 * @param {{decision: 'approve'|'deny', key: string}} want
 * @returns {Promise<{moves: number, agent: string}>}
 * @throws {Refusal}
 */
export async function answerApproval(io, want) {
  const read = (pane) => readApproval(pane, io.agent);
  const screen = read(await io.capture());
  const same = matchApproval(screen, want);
  if (!same.ok) throw new Refusal(same.why);
  const index = want.decision === 'approve' ? screen.approve : screen.deny;
  let moves = 0;
  if (screen.keys) {
    // OpenCode's: the same keys whatever is picked, which its screen does not show.
    await io.keys(...screen.keys[want.decision === 'approve' ? 'approve' : 'deny']);
  } else if (screen.digits && io.literal) {
    // Grok Build's: a row's number picks it, wherever the highlight is. Herdr types no text without an Enter, so there
    // it moves the highlight as for any other.
    await io.literal(String(screen.options[index].n));
  } else {
    moves = await pickRow(io, read, screen, index, (s) => matchApproval(s, want).ok, 0);
  }
  const gone = await settle(io, read, (s) => !matchApproval(s, want).ok);
  if (!gone.ok) throw new Refusal('still-there');
  return { moves, agent: screen.agent };
}

/**
 * Types a message into the agent's pane and sends it, unless a prompt is on screen: the Enter after a message answers
 * a prompt (its highlighted option, often Yes). The pane is read before the text and again after it, just before the
 * Enter, so a prompt that came up while the text went in gets no Enter either. A read that fails stops it the same way.
 * @param {{capture: () => Promise<string>, type: (text: string) => Promise<void>, enter: () => Promise<void>}} io
 * @param {string} text
 * @returns {Promise<{sent: true}|{sent: false, kind: 'question'|'approval'|'menu'|'box'|null, typed: boolean}>}  kind box: the
 *   box held more than the text once it went in (someone typing in the TUI tab)  typed: the text is in
 *   the agent's box, unsent; kind null: the pane could not be read after it went in
 */
// A menu on screen that readPrompt does not know (claude's folder-trust prompt, codex's, a picker of a new version):
// a highlighted numbered row near the bottom with a key hint under it ("Enter to confirm · Esc to exit", "Press enter
// to continue"). An Enter there picks the highlighted row, so no message goes in. The agent's own input box and the
// messages it echoes start with the same marks (`❯ 1. …`), with no such hint under them, and the line that holds the
// text just typed is never one.
const HIGHLIGHTED_ROW = /^\s*[❯›]\s*\d{1,2}\.\s+\S/;
const MENU_HINT = /\b(enter|esc)\b.*\b(confirm|continue|select|cancel|exit|navigate|choose)\b/i;

function menuOn(pane, text) {
  const lines = linesOf(pane).slice(-25);
  const typed = text ? squash(text).slice(0, 20) : '';
  return lines.some((line, i) => HIGHLIGHTED_ROW.test(line) && !(typed && squash(line).includes(typed))
    && lines.slice(i + 1, i + 10).some((l) => MENU_HINT.test(l)));
}

/**
 * What the pane asks of a person now, if anything: a known prompt's kind (`question`, `approval`), or `menu` for any
 * highlighted numbered menu. Nothing is typed while it asks.
 * @returns {string|null}
 */
export function asking(pane, text, agent) {
  const known = readPrompt(pane, agent);
  if (known) return known.kind;
  return menuOn(pane, text) ? 'menu' : null;
}

// The box shows nothing yet, or the start of the text: the agent has not drawn all of it.
function stillDrawing(box, text) {
  if (typeof box !== 'string') return false;
  const bare = (s) => s.replace(/[\s\u00a0]+/g, '');
  return bare(text).startsWith(bare(box));
}

/**
 * Whether the box holds the text just typed and nothing else, as it shows it (wrapped, so whitespace aside). statusd
 * types so that no agent folds it into a `[Pasted …]` placeholder (statusd.mjs, typingSteps), since a placeholder says
 * nothing of whose paste it is: one in the box is never this text, and gets no Enter.
 */
export function holdsOnly(box, text) {
  if (typeof box !== 'string') return false;
  const bare = (s) => s.replace(/[\s\u00a0]+/g, '');
  return bare(box) === bare(text);
}

export async function typeMessage(io, text) {
  const before = asking(await io.capture());
  if (before) return { sent: false, kind: before, typed: false };
  await io.type(text);
  // The text is in now: a pane that cannot be read again gets no Enter, and says so, since sending it again would
  // type it twice.
  let pane;
  try {
    pane = await io.capture();
  } catch {
    return { sent: false, kind: null, typed: true };
  }
  const after = asking(pane, text);
  if (after) return { sent: false, kind: after, typed: true };
  // The box holds what was typed, and nothing else: someone typing in the TUI tab between the look before and the
  // text would have their draft sent with it. A paste the agent folds into a placeholder counts as itself.
  // The agent draws what was typed a moment after the keys (claude, measured): read again while the box shows nothing
  // yet or the start of the text, and stop at once when it shows anything else.
  if (io.box) {
    const sleep = io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const until = Date.now() + (io.settleMs ?? 2000);
    for (;;) {
      let box;
      try {
        box = await io.box(text);
      } catch {
        return { sent: false, kind: null, typed: true };
      }
      if (holdsOnly(box, text)) break;
      if (!stillDrawing(box, text) || Date.now() >= until) return { sent: false, kind: 'box', typed: true };
      await sleep(io.everyMs ?? 100);
    }
  }
  // An Enter that failed leaves the text in, unsent, as above.
  try {
    await io.enter();
  } catch {
    return { sent: false, kind: null, typed: true };
  }
  return { sent: true };
}

// The agent's input box, read from a capture with its colours (`tmux capture-pane -e -p`). claude draws it as `❯ ` between
// two rules, codex as `› ` over its footer. An empty one shows a suggestion or a placeholder in dim (SGR 2), never in
// the plain colours a typed draft has (claude 2.1.328 and codex 0.167, captured): so the box is empty when nothing but
// dim text follows its mark.
const SGR = /\x1b\[([0-9;]*)m/g;
const SGR_ANY = /\x1b\[[0-9;]*m/;

/** The text of a line as drawn, leaving out what it draws dim. */
export function undimmed(line) {
  let dim = false;
  let out = '';
  let at = 0;
  for (const m of line.matchAll(SGR)) {
    if (!dim) out += line.slice(at, m.index);
    const codes = m[1] === '' ? [0] : m[1].split(';').map(Number);
    for (const c of codes) {
      if (c === 2) dim = true;
      else if (c === 0 || c === 22) dim = false;
    }
    at = m.index + m[0].length;
  }
  if (!dim) out += line.slice(at);
  return out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

// Whether a line's first visible character, its mark, is drawn bold (SGR 1), as codex draws its box's `›`.
function markInBold(line) {
  let bold = false;
  let at = 0;
  for (const m of line.matchAll(SGR)) {
    if (line.slice(at, m.index).trim()) return bold;
    for (const c of (m[1] === '' ? [0] : m[1].split(';').map(Number))) {
      if (c === 1) bold = true;
      else if (c === 0 || c === 22) bold = false;
    }
    at = m.index + m[0].length;
  }
  return line.slice(at).trim() ? bold : false;
}

// A rule over or under claude's box: a run of `─` from the line's start, with the session's title in it or not
// (`─────── Fix the retry ─`). In a capture with colours it must be drawn in a set foreground, as claude draws its rules
// (38;5;244): a row of dashes typed into a draft has the plain one. A capture with no colours at all (a text fixture)
// is read by its text.
function ruleLine(line, styled) {
  if (!/^\s*─{10,}/.test(PLAIN(line))) return false;
  if (!styled) return true;
  let fg = false;
  let at = 0;
  for (const m of line.matchAll(SGR)) {
    if (line.slice(at, m.index).trim()) return fg;
    const codes = m[1] === '' ? [0] : m[1].split(';').map(Number);
    for (let k = 0; k < codes.length; k++) {
      const c = codes[k];
      if (c === 38) { fg = true; k += codes[k + 1] === 5 ? 2 : 4; }
      else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) fg = true;
      else if (c === 39 || c === 0) fg = false;
    }
    at = m.index + m[0].length;
  }
  return line.slice(at).trim() ? fg : false;
}

const PLAIN = (line) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
// Each agent's own mark: claude's `❯` sits right under a rule; codex's `›`. A line of another's (the session's status
// line starts `›` under claude's box) is not the box.
const BOX_MARKS = { claude: /^\s*❯\s?/, codex: /^\s*›\s?/ };

/**
 * Whether the agent's input box is empty, from a capture with colours.
 * @param {string} colored  `tmux capture-pane -e -p`
 * @param {'claude'|'codex'} agent
 * @returns {boolean|null}  null when no input box is on screen (a menu, a screen of another program)
 */
export function composerEmpty(colored, agent) {
  const text = composerText(colored, agent);
  return text === null ? null : !text;
}

/**
 * The text in the agent's input box, leaving out what it draws dim (its hint), whitespace collapsed.
 * @returns {string|null}  '' for an empty box; null when no input box is on screen
 */
export function composerText(colored, agent) {
  const mark = BOX_MARKS[agent];
  const lines = linesOf(colored);
  const plain = lines.map(PLAIN);
  const styled = SGR_ANY.test(colored);
  // codex's box runs down to its footer, the last line on screen with anything on it.
  let footer = plain.length - 1;
  while (footer > 0 && !plain[footer].trim()) footer--;
  // Where the box starts, by how the agent draws its mark, never by what a line says: claude's `❯` right under a rule,
  // codex's `›` in bold. A draft's own line that starts with either mark is plain text. A capture with scrollback (a
  // long draft runs off the top of the screen) can hold the agent's earlier frames above: the box is the lowest start.
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    if (!mark.test(plain[i])) continue;
    if (agent === 'claude' ? !(i > 0 && ruleLine(lines[i - 1], styled)) : !markInBold(lines[i])) continue;
    // A menu's highlighted row, with its key hint under it, is not the box. A draft that starts `1. ` is.
    if (HIGHLIGHTED_ROW.test(plain[i]) && plain.slice(i + 1, i + 10).some((l) => MENU_HINT.test(l))) continue;
    starts.push(i);
  }
  if (!starts.length) return null;
  const i = starts[starts.length - 1];
  // The whole draft, blank lines in it too: to the rule under it (claude), or to the footer (codex).
  let text = undimmed(lines[i]).replace(mark, '');
  for (let j = i + 1; j < lines.length; j++) {
    if (agent === 'claude' ? ruleLine(lines[j], styled) : j >= footer) break;
    text += undimmed(lines[j]);
  }
  return text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}
