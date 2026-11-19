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
    answers.push({ n: row.n, label: label.replace(CHOSEN, '').slice(0, MAX_LINE), highlighted: row.highlighted, chosen });
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
function dropTips(raw, width) {
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    if (!/^\s*Tip:/.test(raw[i])) {
      out.push(raw[i]);
      continue;
    }
    while (i + 1 < raw.length && raw[i + 1].trim() && !DASHED.test(raw[i + 1])
      && raw[i].trimEnd().length + 1 + raw[i + 1].trim().split(/\s/)[0].length > width) i++;
  }
  return out;
}

/**
 * An approval the agent waits on: claude's permission dialog, or codex's approval.
 * @param {string} pane
 * @returns {null|{agent: 'claude'|'codex', what: string|null, title: string, detail: string[],
 *   options: {n: number, label: string, highlighted: boolean}[], highlighted: number|null, approve: number, deny: number}}
 *   approve and deny are indexes into options: the first that says Yes (and not `Yes, and …`), and the first that says No
 */
export function readApproval(pane) {
  const lines = linesOf(pane);
  for (const [agent, titleRe, footRe] of [['claude', CLAUDE_TITLE, CLAUDE_APPROVAL_FOOT], ['codex', CODEX_TITLE, CODEX_APPROVAL_FOOT]]) {
    const foot = lastIndex(lines, footRe);
    if (foot === -1) continue;
    const title = lastIndex(lines, titleRe, foot);
    if (title === -1) continue;
    const rows = rowsOf(lines, title + 1, foot);
    if (!rows.length) continue;
    let what = null;
    let detail;
    let from = title;
    if (agent === 'claude') {
      const rule = lastIndex(lines, RULE, title);
      from = rule + 1;
      const head = lines.slice(rule + 1, title).map((l) => l.trim());
      // claude's question picker has its tabs here; it is not an approval, whatever its question says.
      if (rule === -1 || head.some((l) => TABS.test(l))) continue;
      const kept = dropTips(lines.slice(rule + 1, title), lines[rule].trimEnd().length)
        .map((l) => l.trim())
        .filter((l) => l && !/^╌+$/.test(l) && l !== 'This command requires approval');
      what = kept.shift() ?? null;
      detail = kept;
    } else {
      // codex draws what it asks between the title and its options: the reason, the command.
      detail = lines.slice(title + 1, rows[0].line).map((l) => l.trim()).filter(Boolean);
    }
    const options = rows.map((r) => ({ n: r.n, label: r.text.replace(SHORTCUT, '').slice(0, MAX_LINE), highlighted: r.highlighted }));
    // Just this once: never a `Yes, and …` row, which allows it for good or switches the mode. With none, no approval.
    const approve = options.findIndex((o) => /^Yes\b/.test(o.label) && !/^Yes,? and\b/i.test(o.label));
    const deny = options.findIndex((o) => /^No\b/.test(o.label));
    if (approve === -1 || deny === -1) continue;
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
    };
  }
  return null;
}

/**
 * What the pane asks now, for the Chat tab: a question picker or an approval, or null.
 * @param {string} pane
 */
export function readPrompt(pane) {
  const picker = readQuestionPicker(pane);
  if (picker) return { kind: 'question', ...picker };
  const approval = readApproval(pane);
  return approval ? { kind: 'approval', ...approval } : null;
}

// A label read from the screen against the one claude was given: the screen cuts a long one where it wraps.
function sameLabel(screen, given) {
  const a = squash(screen);
  const b = squash(given);
  return a === b || (a.length >= 8 && b.startsWith(a));
}

/**
 * @param {ReturnType<typeof readQuestionPicker>} screen
 * @param {{question: string, options: string[]}} want  as the transcript holds it
 * @returns {{ok: true}|{ok: false, why: string}}  why is a code: no-picker, other-question, multi-select, other-options
 */
export function matchQuestion(screen, want) {
  if (!screen) return { ok: false, why: 'no-picker' };
  if (screen.step !== 'question' || squash(screen.question) !== squash(want.question)) return { ok: false, why: 'other-question' };
  if (screen.multiSelect) return { ok: false, why: 'multi-select' };
  if (screen.options.length !== want.options.length || !screen.options.every((o, i) => sameLabel(o.label, want.options[i]))) {
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
  const same = wants.every((w, i) => squash(screen.answers[i].question) === squash(w.question) && sameLabel(screen.answers[i].answer, w.options[w.pick]));
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
 *   waitMs?: number, everyMs?: number}} PaneIo
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
  const screen = readApproval(await io.capture());
  const same = matchApproval(screen, want);
  if (!same.ok) throw new Refusal(same.why);
  const index = want.decision === 'approve' ? screen.approve : screen.deny;
  const moves = await pickRow(io, readApproval, screen, index, (s) => matchApproval(s, want).ok, 0);
  const gone = await settle(io, readApproval, (s) => !matchApproval(s, want).ok);
  if (!gone.ok) throw new Refusal('still-there');
  return { moves, agent: screen.agent };
}

/**
 * Types a message into the agent's pane and sends it, unless a prompt is on screen: the Enter after a message answers
 * a prompt (its highlighted option, often Yes). The pane is read before the text and again after it, just before the
 * Enter, so a prompt that came up while the text went in gets no Enter either. A read that fails stops it the same way.
 * @param {{capture: () => Promise<string>, type: (text: string) => Promise<void>, enter: () => Promise<void>}} io
 * @param {string} text
 * @returns {Promise<{sent: true}|{sent: false, kind: 'question'|'approval'|'menu'|null, typed: boolean}>}  typed: the text is in
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

function asking(pane, text) {
  const known = readPrompt(pane);
  if (known) return known.kind;
  return menuOn(pane, text) ? 'menu' : null;
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

const PLAIN = (line) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
// Each agent's own mark: claude's `❯` sits right under a rule; codex's `›`. A line of another's (the session's status
// line starts `›` under claude's box) is not the box.
const BOX_MARKS = { claude: /^\s*❯\s?/, codex: /^\s*›\s?/ };
const BOX_RULE = /^\s*─{10,}\s*$/;

/**
 * Whether the agent's input box is empty, from a capture with colours.
 * @param {string} colored  `tmux capture-pane -e -p`
 * @param {'claude'|'codex'} agent
 * @returns {boolean|null}  null when no input box is on screen (a menu, a screen of another program)
 */
export function composerEmpty(colored, agent) {
  const mark = BOX_MARKS[agent];
  const lines = linesOf(colored);
  for (let i = lines.length - 1; i >= 0; i--) {
    const plain = PLAIN(lines[i]);
    if (!mark.test(plain) || HIGHLIGHTED_ROW.test(plain)) continue;
    if (agent === 'claude' && !(i > 0 && BOX_RULE.test(PLAIN(lines[i - 1])))) continue;
    // Its draft, to the rule under it (claude) or the first blank line (codex): every line with no dim text left.
    let text = undimmed(lines[i]).replace(mark, '');
    for (let j = i + 1; j < lines.length; j++) {
      const next = PLAIN(lines[j]);
      if (BOX_RULE.test(next) || !next.trim()) break;
      text += undimmed(lines[j]);
    }
    return !text.replace(/\u00a0/g, ' ').trim();
  }
  return null;
}
