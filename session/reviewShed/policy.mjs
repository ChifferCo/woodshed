// Which of the shed's review calls a session may answer. The shed's page writes to GitHub with `gh`, which acts as
// whoever the session's token belongs to: the owner in a My Woodshed session they connected GitHub for, the GitHub App
// otherwise. A review comment or a merge from the App would carry the wrong name, so those sessions are read-only:
// the pull request is hidden from the page (it draws no write control without one) and the writes are refused here
// too, for a caller that skips the page.

// [method, the path after /reviews/claude-<id>]
const WRITES = [
  ['POST', 'comments'], ['DELETE', 'comments'], ['POST', 'submit'], ['PATCH', 'title'], ['POST', 'viewed'], ['POST', 'merge'],
];

/** @returns {string} the part after /reviews/claude-<id>/, '' for the status call */
export function sectionOf(pathname) {
  return /^\/reviews\/claude-[0-9a-f]{8}\/?([a-z]*)/.exec(pathname)?.[1] ?? '';
}

export function isGithubWrite({ method, pathname }) {
  const section = sectionOf(pathname);
  return WRITES.some(([m, s]) => m === method && s === section);
}

/** @param {{sessionKind: string|undefined, account: string|null}} args  `account`: who gh is signed in as, if a person */
export function writesAllowed({ sessionKind, account }) {
  return sessionKind === 'private' && Boolean(account);
}

/** The status call's answer without the pull request, so the page draws no comment, verdict or merge control. */
export function withoutPullRequest(body) {
  if (!body || typeof body !== 'object' || !('livePr' in body)) return body;
  return { ...body, livePr: null, ghAccount: null };
}
