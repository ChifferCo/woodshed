// Whether the console may merge a pull request by itself, from the signals the decision brief already reads. A pure
// function, so the rules are tested without a `gh` in sight; the merge itself (console/fleet.mjs) acts only on a yes.
//
// The console reaches this only once the review has approved the head and every suite is green (console/prAnnouncer.mjs,
// gatesPassed). This adds the auto-merge owner's rules on top: the feature is off unless turned on, QA must have passed
// when QA is configured, the trusted merge-risk tier must be one the rules allow, and every changed file must be within
// the allowed paths when any are set. Anything it cannot confirm is a no.

/**
 * Does a changed file fall under one of the allowed path rules? A rule ending in `/` is a directory (everything under
 * it); a rule ending in `*` matches any suffix from there; anything else is an exact path.
 */
function underPaths(file, paths) {
  return paths.some((rule) => {
    if (rule.endsWith('/')) return file === rule.slice(0, -1) || file.startsWith(rule);
    if (rule.endsWith('/**')) return file.startsWith(rule.slice(0, -2));
    if (rule.endsWith('*')) return file.startsWith(rule.slice(0, -1));
    return file === rule;
  });
}

/**
 * @param {{autoMerge: {enabled: boolean, tiers: string[], paths: string[]}|null|undefined,
 *   tier: 'Low'|'Medium'|'High'|null, qaConfigured: boolean, qaConclusion: string|null|undefined,
 *   changedFiles: string[]|null}} signals
 *   `tier` is the trusted merge-risk tier after QA (decisionBrief's `tier`); `qaConclusion` the trusted QA check's;
 *   `changedFiles` the pull request's files, or null when there were too many to read.
 * @returns {{merge: boolean, reason: string}}  `reason` is a fixed, log-safe phrase
 */
export function autoMergeDecision({ autoMerge, tier, qaConfigured, qaConclusion, changedFiles }) {
  if (!autoMerge?.enabled) return { merge: false, reason: 'auto-merge is off' };
  if (qaConfigured && qaConclusion !== 'success') return { merge: false, reason: 'QA has not passed' };
  if (!tier) return { merge: false, reason: 'no trusted merge-risk tier' };
  if (!autoMerge.tiers.includes(tier)) return { merge: false, reason: `${tier} merge risk is not in the auto-merge tiers` };
  if (autoMerge.paths.length) {
    if (changedFiles === null) return { merge: false, reason: 'too many files to check against the allowed paths' };
    const outside = changedFiles.find((f) => !underPaths(f, autoMerge.paths));
    if (outside) return { merge: false, reason: 'a changed file is outside the allowed paths' };
  }
  return { merge: true, reason: `${tier} merge risk, within the auto-merge rules` };
}
