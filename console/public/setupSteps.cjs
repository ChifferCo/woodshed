// What is left before My Woodshed's New session works, for the setup card. One file for the pages (a script that sets
// `WoodshedSetup`, before common.js) and the tests (required), as logins.cjs is, so the rules have a test.
(function (root, factory) {
  const setup = factory();
  if (typeof module === 'object' && module.exports) module.exports = setup;
  else root.WoodshedSetup = setup;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';

  /**
   * What is left before New session works: a Claude token or a Codex sign-in, which is the person's to do, and the
   * databases, which the console makes by itself once either is saved. They are progress while they copy, and `todo` when the copy failed
   * or never started, which is when the card gives them a button.
   * @returns {{key: string, label: string, hint: string, done: boolean, todo?: boolean}[]}
   */
  function setupSteps(me) {
    const db = me.databases;
    // A Codex sign-in does as well: a person who only uses Codex has no Claude plan to save.
    const tokenSet = Boolean(me.claudeToken?.set || me.codexAuth?.set);
    const dbHint = {
      ready: 'Ready', working: 'Copying the template: about a minute', failed: 'The copy failed: try again on My settings',
      none: 'Not started: start them on My settings',
    };
    // Before the token there is nothing to show: the copy starts when it is saved. After it, a copy that never started is
    // something to do, so it is listed.
    const showDb = db?.available && dbHint[db.status] && (db.status !== 'none' || tokenSet);
    return [
      ...(me.githubSetupNeeded ? [{ key: 'github', label: 'Connect a GitHub App', hint: 'Sessions push, open pull requests and sign people in through it', done: false }] : []),
      { key: 'token', label: 'Choose your agent', hint: 'Save a Claude token or a Codex sign-in: either one is enough', done: tokenSet },
      ...(showDb ? [{ key: 'databases', label: 'Your databases', hint: dbHint[db.status], done: db.status === 'ready', todo: db.status === 'failed' || db.status === 'none' }] : []),
    ];
  }

  /** @returns {boolean}  nothing is left: a Claude token or a Codex sign-in is saved and the databases are ready (or this console has none) */
  function setupDone(me) {
    return !me.githubSetupNeeded && Boolean(me.claudeToken?.set || me.codexAuth?.set) && (!me.databases?.available || me.databases.status === 'ready');
  }

  return { setupSteps, setupDone };
});
