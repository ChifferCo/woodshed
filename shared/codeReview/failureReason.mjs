// A short reason a reviewer ended without a verdict, from what the reviewer itself reported as a failure and its exit
// code. Never a quote of the log: only one of these fixed sentences, so a token or key in the log cannot reach a comment
// or the console's log. The console accepts a reason only if `isKnownReason` knows it (console/reviewSessions.mjs).
const LIMIT = 'its plan or API usage limit looks used up (check the plan or billing behind its sign-in)';
const SIGN_IN = 'its sign-in was refused, expired or turned off (save it again on My settings)';
const NETWORK = 'the console could not pass its calls on, or it could not reach the console';
const TIMEOUT = 'it ran past its time limit and was stopped';
const TURNS = 'it ran out of turns before it wrote a verdict';
const NOTHING = 'it printed nothing';
const ENDED = 'it ended without writing a verdict';
const REASONS = [
  [/usage limit|quota|insufficient[_ ]quota|exceeded your current|credit balance|out of credits|rate[_ ]limit|\b429\b|too many requests|plan limit/i, LIMIT],
  [/sign-in|login|log in|unauthori[sz]ed|invalid[_ ]api[_ ]key|authentication|\b401\b|\b403\b|expired|forbidden/i, SIGN_IN],
  [/refused by|upstream not reached|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed/i, NETWORK],
  [/error_max_turns|max[_ -]turns/i, TURNS],
];
const EXIT_SENTENCE = /^it (?:printed nothing and )?exited with \d{1,3}(?: without writing a verdict)?$/;
const KNOWN = new Set([LIMIT, SIGN_IN, NETWORK, TIMEOUT, TURNS, NOTHING, ENDED]);

/** True for a sentence this module can return, so a report's reason can be checked at the console. */
export function isKnownReason(text) {
  return KNOWN.has(text) || EXIT_SENTENCE.test(text);
}

/**
 * What a log holds that the agent itself reported as a failure: a final `result` line that is an error, an event whose
 * type names an error or a failure, an `error` field, and lines that are not JSON (stderr). The rest of a transcript,
 * the diff and the files it read among it, says nothing of why it ended.
 */
export function errorText(log) {
  const found = [];
  for (const line of String(log).slice(-200000).split('\n')) {
    const text = line.trim();
    if (!text) continue;
    let event;
    try { event = JSON.parse(text); } catch { found.push(text.slice(0, 500)); continue; }
    if (!event || typeof event !== 'object') continue;
    const type = String(event.type ?? '');
    if (type === 'result' && (event.is_error || /^error/.test(String(event.subtype ?? '')))) found.push(`${event.subtype ?? ''} ${typeof event.result === 'string' ? event.result : ''}`.slice(0, 500));
    else if (/error|fail/i.test(type) && type !== 'result') found.push(JSON.stringify(event.error ?? event.message ?? event).slice(0, 500));
    else if (event.error) found.push(JSON.stringify(event.error).slice(0, 500));
  }
  return found.slice(-20).join('\n');
}

/**
 * @param {{log?: string, exit?: number|null}} input  the reviewer's log text and exit code
 * @returns {string} one sentence, with no text from the log
 */
export function failureReason({ log = '', exit = null } = {}) {
  if (exit === 124 || exit === 137) return TIMEOUT;
  const failure = errorText(log);
  for (const [pattern, reason] of REASONS) if (pattern.test(failure)) return reason;
  const code = Number.isInteger(exit) && exit >= 0 && exit <= 255 ? exit : null;
  if (!String(log).trim()) return code ? `it printed nothing and exited with ${code}` : NOTHING;
  return code ? `it exited with ${code} without writing a verdict` : ENDED;
}
