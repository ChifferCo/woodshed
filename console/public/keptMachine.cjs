// What a stopped private session's page offers for the machine its launcher keeps (`GET /api/my/sessions/<id>/machine`):
// nothing for one that is not outdated, and for one made from an older image than a new session gets, a second way to
// resume, on the latest image. A session that failed may well have failed on that older image (one whose entrypoint
// cannot read the branch's newer project file fails at every Resume), so its page leads with the latest image, says so
// beside the failure, and plain Resume steps back; a session that merely stopped keeps the quiet note under Resume.
// One file for session.js (a script that sets `WoodshedKeptMachine`) and its test.
(function (root, factory) {
  const kept = factory();
  if (typeof module === 'object' && module.exports) module.exports = kept;
  else root.WoodshedKeptMachine = kept;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';

  /**
   * @param {{status?: string}} session
   * @param {{outdated?: boolean} | null | undefined} machine  the route's answer, null when it was not read
   * @returns {null | {lead: 'latest' | 'resume', head?: string, note: string}}  `lead` is the page's primary action, `head`
   *   the note's bold first sentence
   */
  function offer(session, machine) {
    if (!machine?.outdated) return null;
    if (session?.status === 'failed') {
      return {
        lead: 'latest',
        head: 'It may have failed on its machine’s older image.',
        note: 'That machine was made from an older image of its repo, and Resume starts it again. Resume on the latest image starts the session on a new machine instead.',
      };
    }
    return {
      lead: 'resume',
      note: 'Its machine was made from an older image of its repo, which Resume starts again. If that no longer starts the branch, resume it on the latest image.',
    };
  }

  return { offer };
});
