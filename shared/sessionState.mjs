// What a session is doing right now, and what order the list should be in.
//
// Every session used to show the same green dot, which meant "this session
// exists" and nothing else. So a session that finished ten minutes ago, one
// grinding through a build, and one frozen on a permission prompt waiting for a
// single keystroke all looked identical. The last case is the expensive one:
// nothing on screen said it was stalled, so it sat there until somebody thought
// to open its terminal.
//
// The signal is the tmux pane, not the transcript. That is not a preference —
// it was measured. While a permission dialog is blocking, the transcript's last
// real record is the USER'S PROMPT: claude does not write its tool_use record
// until the prompt is answered. Read the transcript alone and a blocked session
// is indistinguishable from one that is working, which is exactly the state
// this file exists to surface. The transcript is kept as the fallback for
// telling "done" from "working" when the pane cannot be read at all.
//
// The state says what a session is doing; it deliberately does not say where
// the session sits. The list is ordered by launch time, above which a session
// can be pinned by hand — see compareSessions for why the two were separated
// and why a hand-placed pin is not the ranking that was removed.
//
// Everything here is pure so it can be tested against real captured panes —
// see __fixtures__/. server.mjs owns the tmux and fs calls; this file owns
// every regex in the feature, deliberately: the browser client lives inside a
// template literal where a `\.` silently collapses to `.` (README.md has the
// full hazard note), so no marker pattern should ever be written there.

// The footer hint claude prints while a turn is running. Matched in full, never
// as a prefix: the CLI also prints "esc to cancel", "esc to edit", "esc to
// rewind", "esc to keep", "esc to close", "esc to clear" and "esc to quit". One
// of those — "esc to rewind" — was observed live in a real session's output, so
// a prefix match is not a hypothetical failure.
const INTERRUPT_HINT = 'esc to interrupt';

// The two halves of a blocking dialog: a cancel hint and a numbered choice.
// Both are required. Neither is sufficient alone — a "done" pane routinely
// contains numbered lines, because claude writes numbered lists in ordinary
// prose, and the cancel hint can appear in printed output the same way.
//
// Note the capital E. `Esc to cancel` (dialog) and `esc to interrupt` (working)
// differ in case as well as wording, so the two can never be confused.
const CANCEL_HINT = 'Esc to cancel';
const OPTION_LINE_RE = /^[^\S\n]*❯?[^\S\n]*\d+\.[^\S\n]/m;

// The composer box: a line holding just the chevron. The character after it is
// U+00A0, NOT a space — verified with `cat -A`, which renders the line as
// `M-bM-^]M-/M-BM- $`. A literal '❯ ' written with an ASCII space matches
// nothing at all and fails silently. `\s` covers U+00A0, so this stays safe.
const COMPOSER_RE = /^\s*❯\s*$/m;

// A horizontal rule, which is how the TUI closes the composer box and how the
// footer is found. Two shapes occur: a plain run, and a run carrying a title
// (`────── Chat action dock ─`). Both start and end with U+2500.
//
// Markdown tables rendered in claude's own output are NOT rules even though
// they are full of U+2500 — they carry corner and junction characters, so
// anything holding one is rejected outright. Without that, a table printed in a
// session's output would move the footer boundary and take the whole
// classification with it.
const RULE_JUNCTIONS = /[┌┐└┘├┤┬┴┼│]/;
const RULE_RE = /^─[\s\S]*─$/;
const RULE_RUN = /─{8}/;

/** @type {Record<string, string>} */
export const STATUS_LABEL = {
  'needs-you': 'Needs you',
  working: 'Working',
  done: 'Done',
  idle: 'Idle',
};

/** @type {Record<string, string>} */
export const STATUS_TIP = {
  'needs-you': 'Blocked on a prompt — it needs an answer before it can carry on',
  working: 'Claude is running right now',
  done: 'Claude finished its turn — your move',
  idle: 'Launched but never spoken to',
};

/**
 * Whether one captured line is a rule, and therefore a footer boundary.
 * @param {string} line
 * @returns {boolean}
 */
function isRuleLine(line) {
  const trimmed = line.trim();
  if (trimmed.length < 8) return false;
  if (RULE_JUNCTIONS.test(trimmed)) return false;  // a table border, not a rule
  return RULE_RE.test(trimmed) && RULE_RUN.test(trimmed);
}

/**
 * What the pane says this session is doing.
 *
 * Markers are read ONLY from the footer — the segment after the last rule —
 * never from the whole screen. Claude's own printed output persists on screen
 * and can contain every marker verbatim; the session that implemented this
 * feature had `esc to interrupt` on screen three times in its own diff. Scan
 * the whole capture and that session reads "working" until the text scrolls
 * off, which is the invisible stall this file exists to kill, inverted.
 *
 * Anchoring on the LAST rule also keeps the case that motivated scanning
 * widely: a background-task block is printed after the footer, and it is still
 * inside the segment.
 *
 * @param {string} paneText  raw `tmux capture-pane -p` output
 * @returns {'working'|'needs-you'|'done'|null}  null when the shape is not a
 *   claude TUI at all (a bare shell, a dead pane, an unreadable capture), which
 *   is the caller's signal to fall back to the transcript.
 */
export function classifyPane(paneText) {
  if (typeof paneText !== 'string' || !paneText.trim()) return null;

  const lines = paneText.split('\n');
  let lastRule = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isRuleLine(lines[i])) { lastRule = i; break; }
  }
  if (lastRule === -1) return null;  // no composer box: not a claude session

  const footer = lines.slice(lastRule + 1).join('\n');

  // Blocked is checked first, and deliberately outranks working rather than
  // requiring the interrupt hint to be absent. Every captured dialog lacks the
  // hint, but a background agent running while the main thread blocks is not
  // something we can rule out, and the costs are lopsided: a false "working"
  // hides the exact stall this is for, while a false "needs-you" costs a glance.
  if (footer.includes(CANCEL_HINT) && OPTION_LINE_RE.test(footer)) return 'needs-you';
  if (footer.includes(INTERRUPT_HINT)) return 'working';

  // Neither marker. A composer box anywhere on screen means claude is sitting
  // at its prompt; without one this is some other program and the transcript
  // should answer instead.
  return COMPOSER_RE.test(paneText) ? 'done' : null;
}

/** How much of a message the card preview keeps. Matches the previous value. */
const LAST_MESSAGE_MAX = 600;

/**
 * The readable text of one transcript record. Content is either a plain string
 * or an array of blocks, only some of which are text — tool calls and thinking
 * blocks are not what "the last message" means to a reader.
 * @param {any} rec
 * @returns {string}
 */
function textFromRecord(rec) {
  const content = rec?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * Read the tail of a transcript for both things the list needs: the last thing
 * said, and whose turn it is.
 *
 * These are two different walks over the same lines, and conflating them would
 * be wrong. The message skips records with no text, because a tool-only turn is
 * not something to show a reader. The turn must NOT skip them — a tool call is
 * precisely the evidence that claude is mid-turn.
 *
 * @param {string} tailText  the tail of a transcript, sliced at a byte offset
 * @param {{partial?: boolean}} [opts]  `partial` false when the caller read the
 *   whole file rather than a tail, so line one is a complete record and
 *   dropping it would lose the only record a young transcript has.
 * @returns {{message: {role: 'you'|'claude', text: string, at: string|null}|null,
 *            turn: 'end_turn'|'tool_use'|'user'|null}}
 */
export function parseTranscriptTail(tailText, { partial = true } = {}) {
  if (typeof tailText !== 'string') return { message: null, turn: null };

  // The first line is almost certainly a fragment — the caller sliced at a byte
  // offset, not a line boundary. Almost: a transcript smaller than the tail
  // window is read from byte zero, and there line one is whole.
  const all = tailText.split('\n');
  const lines = (partial ? all.slice(1) : all).filter(Boolean);

  let message = null;
  let turn = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    // Records of other types — attachment, mode, permission-mode,
    // bridge-session, last-prompt — are written AFTER the last real message, so
    // a tail walk that did not filter would read metadata as conversation.
    const role = rec?.message?.role || rec?.type;
    if (role !== 'assistant' && role !== 'user') continue;

    if (turn === null) {
      // Only a clean end_turn means the turn is over. Anything else on an
      // assistant record — tool_use, a truncation, a null mid-stream — means it
      // stopped without finishing.
      turn = role === 'user'
        ? 'user'
        : (rec?.message?.stop_reason === 'end_turn' ? 'end_turn' : 'tool_use');
    }

    if (message === null) {
      const text = textFromRecord(rec);
      if (text) {
        message = {
          role: role === 'user' ? 'you' : 'claude',
          text: text.length > LAST_MESSAGE_MAX ? text.slice(0, LAST_MESSAGE_MAX) + '…' : text,
          at: rec.timestamp || null,
        };
      }
    }

    if (turn !== null && message !== null) break;
  }

  return { message, turn };
}

/**
 * The session's state, from the pane where possible and the transcript where not.
 *
 * @param {{pane: 'working'|'needs-you'|'done'|null,
 *          turn: 'end_turn'|'tool_use'|'user'|null,
 *          hasTranscript: boolean}} args
 * @returns {'working'|'needs-you'|'done'|'idle'}
 */
export function classifyStatus({ pane, turn, hasTranscript }) {
  // Checked before the transcript gate on purpose: the folder-trust dialog
  // blocks a session that has written no transcript at all, and calling that
  // one "idle" would hide a session that cannot start until someone answers it.
  if (pane === 'needs-you') return 'needs-you';
  if (pane === 'working') return 'working';
  if (pane === 'done') return hasTranscript ? 'done' : 'idle';

  // The pane was unreadable. `end_turn` is the only marker that means finished;
  // a user record means they just spoke and claude is about to reply.
  if (turn === 'end_turn') return 'done';
  if (turn === 'tool_use' || turn === 'user') return 'working';
  return hasTranscript ? 'done' : 'idle';
}

/**
 * Order for the running list: pinned sessions first, then newest first.
 *
 * The second key used to be the only key, and the history is the reason the
 * first one is allowed to exist. This used to rank by state — needs you, then
 * done, then working, then idle — so whatever wanted an answer floated to the
 * top. It reads well in a screenshot and badly in use: a session's state
 * changes on its own, several times a minute, so the rail reordered itself
 * while you were looking at it. The row you were reaching for moved because
 * some *other* session finished a tool call. A list you cannot hold a map of in
 * your head costs more than the ranking ever saved, and the dot already says
 * what each session is doing without needing to move it to say it.
 *
 * A pin is not that, and the difference is the whole argument for it. State
 * ranking moved rows the reader never touched, on a clock they did not control.
 * A pin moves exactly one row, at the moment they click it, and then never
 * again for the life of the session — it is stuck to the session in a tmux
 * user option, so it is the same in every tab and survives a shed restart.
 * The rule that survived the state-ranking removal was never "creation time
 * alone"; it was NOTHING MOVES A ROW EXCEPT THE PERSON READING IT. Anything
 * derived from what a session is *doing* still belongs in the dot, never here.
 *
 * Below the pin the key is creation time, which never changes. A session lands
 * at the top of its group when you launch it and holds that slot for its whole
 * life. The only movement is a new row arriving above, a killed row leaving, or
 * a star being clicked.
 *
 * `createdAt` is a `Date.prototype.toISOString()` string — fixed width, always
 * UTC — so comparing them as text is comparing them as time. A missing value
 * sorts last instead of throwing the rest of the order out, and a missing
 * `favorite` reads as unpinned for the same reason: this is also handed objects
 * that predate the field.
 *
 * The name tiebreak is not decoration. tmux reports `session_created` in whole
 * seconds, so two sessions launched together really do share a timestamp;
 * without a total order they can swap on successive polls, which the page's
 * repaint guard reads as a change and redraws — the flicker it exists to stop.
 * It is still the last key, so two pinned sessions are ordered as firmly as two
 * unpinned ones.
 *
 * @param {{createdAt?: string|null, favorite?: boolean, name: string}} a
 * @param {{createdAt?: string|null, favorite?: boolean, name: string}} b
 * @returns {number}
 */
export function compareSessions(a, b) {
  // Truthiness, not `=== true`: this comparator is handed plain objects that
  // have never heard of the field, and a missing pin must read as "not pinned"
  // rather than throwing the rest of the order out.
  const pinA = a.favorite ? 1 : 0;
  const pinB = b.favorite ? 1 : 0;
  if (pinA !== pinB) return pinB - pinA;
  const madeA = a.createdAt || '';
  const madeB = b.createdAt || '';
  if (madeA !== madeB) return madeA < madeB ? 1 : -1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
