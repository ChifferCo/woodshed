// New session's Work on list: the picked project's open pull requests (GET /api/pulls), narrowed by what is typed in
// the field. One file for the page (a script that sets `WoodshedOpenPulls`) and the tests (required), as inviteLink.cjs is.
(function (root, factory) {
  const openPulls = factory();
  if (typeof module === 'object' && module.exports) module.exports = openPulls;
  else root.WoodshedOpenPulls = openPulls;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';

  /**
   * The pull requests that match what is typed: a number (`123`, `#123`, `PR #12`) by its start, anything else by a
   * part of the title, the branch or the author, any case. Nothing typed matches them all, in their order.
   * @param {{number: number, title: string, branch: string, author: string|null}[]} pulls
   * @param {string} typed  the Work on field
   * @returns {object[]}
   */
  function matchPulls(pulls, typed) {
    const text = String(typed ?? '').trim().toLowerCase();
    if (!text) return pulls;
    const number = /^(?:pr\s*)?#?\s*(\d+)$/.exec(text)?.[1];
    if (number) return pulls.filter((p) => String(p.number).startsWith(number));
    const words = text.split(/\s+/);
    return pulls.filter((p) => {
      const hay = `${p.title ?? ''} ${p.branch ?? ''} ${p.author ?? ''}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }

  /** @returns {string} what Work on takes for a pull request: the form's `PR #123` */
  function workOnFor(pull) {
    return `PR #${pull.number}`;
  }

  /** @returns {string} the line under the rows: how many show of how many are open, and whether the list is old */
  function pullsNote({ shown, listed, total, stale }) {
    const parts = [];
    if (!listed) parts.push(stale ? 'GitHub did not answer, so no open pull requests to show' : 'No open pull requests');
    else if (!shown) parts.push('No open pull request matches. Start takes what is typed, a branch too');
    if (listed && total > listed) parts.push(`the ${listed} updated last of ${total} open; Start takes any number typed`);
    if (listed && stale) parts.push('GitHub did not answer, so this is the list from before');
    const text = parts.join(': ');
    return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : '';
  }

  return { matchPulls, workOnFor, pullsNote };
});
