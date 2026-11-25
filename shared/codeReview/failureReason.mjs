// A short reason a reviewer ended without a verdict, from the end of its own log and its exit code. Never a quote of
// the log: only one of these fixed sentences, so a token or key in the log cannot reach a comment or the console.
const REASONS = [
  [/usage limit|quota|insufficient[_ ]quota|exceeded your current|credit balance|out of credits|billing|rate[_ ]limit|\b429\b|too many requests|plan limit/i,
    'its plan or API usage limit looks used up (check the plan or billing behind its sign-in)'],
  [/sign-in|login|log in|unauthori[sz]ed|invalid[_ ]api[_ ]key|authentication|\b401\b|\b403\b|expired|forbidden/i,
    'its sign-in was refused, expired or turned off (save it again on My settings)'],
  [/refused by|refused:|upstream not reached|could not reach|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|network/i,
    'the console could not pass its calls on, or it could not reach the console'],
];

/**
 * @param {{log?: string, exit?: number|null}} input  the reviewer's log text (only its tail is read) and exit code
 * @returns {string} one sentence, with no text from the log
 */
export function failureReason({ log = '', exit = null } = {}) {
  if (exit === 124 || exit === 137) return 'it ran past its time limit and was stopped';
  const tail = String(log).slice(-6000);
  for (const [pattern, reason] of REASONS) if (pattern.test(tail)) return reason;
  if (!tail.trim()) return exit ? `it printed nothing and exited with ${exit}` : 'it printed nothing';
  return exit ? `it exited with ${exit} without writing a verdict` : 'it ended without writing a verdict';
}
