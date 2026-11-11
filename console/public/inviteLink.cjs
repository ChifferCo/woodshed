// The link My Woodshed's "Invite an engineer" copies: it opens the New session form with Work on already set to this
// session's pull request, or to its pushed branch while it has none. One file for the page (a script that sets
// `WoodshedInvite`) and the tests (required), as logins.cjs is.
(function (root, factory) {
  const invite = factory();
  if (typeof module === 'object' && module.exports) module.exports = invite;
  else root.WoodshedInvite = invite;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';

  /**
   * What the link would say, from what the session itself shows. The branch counts only once GitHub has it: a link to a
   * branch that is not there starts a session that fails.
   * @param {{prUrl?: string|null, branch?: string|null}} s
   * @param {{pushed: boolean|null}} check  whether GitHub has the branch; null while that is being read
   * @returns {{state: 'pr'|'branch'|'unpushed'|'checking', on?: string}}
   */
  function inviteTarget(s, { pushed }) {
    const number = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)\/?$/.exec(s.prUrl || '')?.[1];
    if (number) return { state: 'pr', on: `PR #${number}` };
    if (!s.branch) return { state: 'unpushed' };
    if (pushed === null || pushed === undefined) return { state: 'checking' };
    return pushed ? { state: 'branch', on: s.branch } : { state: 'unpushed' };
  }

  /**
   * Only the PR number or the branch name is in it: nothing of the session, so it opens nothing of it.
   * @param {string} origin  the console's address
   * @param {string} on  what the New session form's Work on takes
   * @param {string|null} [linkQuery]  config.linkQuery as a query string (the page's woodshed-link-query), carried too
   * @returns {string}
   */
  function inviteUrl(origin, on, linkQuery = null) {
    return `${origin}/?new=1&on=${encodeURIComponent(on)}${linkQuery ? `&${linkQuery}` : ''}`;
  }

  /** @returns {string} the button's words for a target */
  function inviteLabel({ state }) {
    return state === 'unpushed' ? 'Invite an engineer: push the branch first' : 'Invite an engineer';
  }

  return { inviteTarget, inviteUrl, inviteLabel };
});
