// How the console tells whether two GitHub handles are one person: handles are not case-sensitive, so `octocat`
// and `Octocat` are the same login. One file for the server (imported) and the pages (a script that sets
// `WoodshedLogins`), so both sides answer the same way.
(function (root, factory) {
  const logins = factory();
  if (typeof module === 'object' && module.exports) module.exports = logins;
  else root.WoodshedLogins = logins;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';

  /** @returns {string}  the form to key a record by, or to compare in */
  function loginKey(login) {
    return String(login ?? '').toLowerCase();
  }

  /** @returns {boolean}  false when either is empty */
  function sameLogin(a, b) {
    return Boolean(a && b) && loginKey(a) === loginKey(b);
  }

  /** @returns {string|null}  the spelling `logins` has for this login, if it has it at all */
  function findLogin(logins, login) {
    return login ? logins.find((l) => sameLogin(l, login)) ?? null : null;
  }

  /** @returns {string[]}  each person once, in the first spelling given; empty entries dropped */
  function uniqueLogins(logins) {
    const seen = new Map();
    for (const l of logins) if (l && !seen.has(loginKey(l))) seen.set(loginKey(l), l);
    return [...seen.values()];
  }

  return { loginKey, sameLogin, findLogin, uniqueLogins };
});
