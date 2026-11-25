// Where a URL the console's page goes to is opened: in the app, or in the person's own browser. Kept free of Electron
// so `node --test` checks it with the rest of Woodshed.

/**
 * The console's address as typed, made into an origin-rooted URL: `localhost:7690` and `woodshed.example.com/` both
 * work. A host with no scheme is https, except loopback, which a local install serves over http.
 * @param {string} typed
 * @returns {string} the URL, ending in `/`
 * @throws {Error} with what is wrong, for the setup page to show
 */
export function consoleUrlFrom(typed) {
  let text = String(typed ?? '').trim();
  if (!text) throw new Error('Type the address of your Woodshed console.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    text = `${isLoopbackHost(text.split(/[/:]/)[0]) ? 'http' : 'https'}://${text}`;
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${typed} is not an address.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The address must start with https:// or http://.');
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new Error('Only a console on this computer may use http://: sign-in cookies need https anywhere else.');
  }
  if (url.username || url.password) throw new Error('Leave the user name and password out of the address.');
  return `${url.origin}/`;
}

/** @returns {boolean} */
export function isLoopbackHost(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

// GitHub's pages a sign-in to the console passes through: the OAuth consent, the login form and two-factor. Anything
// else on GitHub (a pull request, an issue) belongs in the browser, where the person is signed in to GitHub already.
const GITHUB_SIGN_IN = /^\/(login(\/|$)|session(\/|$)|sessions\/)/;

/**
 * Where a URL goes.
 * - `console`: the console itself, kept in the app's windows.
 * - `signIn`: GitHub's sign-in pages, kept in the window that is signing in.
 * - `blank`: about:blank, which the page opens before it sets where the window goes.
 * - `external`: everything else, handed to the person's default browser. A session's app, its editor and its viewers
 *   on the app domain go there too: a hosted console's proxy signs the browser in on the apps' names, which the app's
 *   own sign-in (handed back to it from the browser) never does, so in a window of the app's they found no one.
 * @param {string} target
 * @param {{ consoleUrl: string }} where
 * @returns {'console' | 'signIn' | 'blank' | 'external'}
 */
export function destination(target, { consoleUrl }) {
  if (target === 'about:blank' || target === '') return 'blank';
  let url;
  try {
    url = new URL(target);
  } catch {
    return 'external';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'external';
  const home = new URL(consoleUrl);
  if (url.origin === home.origin) return 'console';
  if (url.protocol === 'https:' && url.hostname === 'github.com' && GITHUB_SIGN_IN.test(url.pathname)) return 'signIn';
  return 'external';
}

/**
 * Whether an answer is a Woodshed console's /api/me, which every console gives signed out too (console/server.mjs,
 * authRoute): the setup page's check that the address is a console, not any web app.
 * @returns {boolean}
 */
export function isConsoleMe(me) {
  return Boolean(me) && typeof me === 'object' && typeof me.supported === 'boolean' && typeof me.signIn === 'boolean'
    && Object.hasOwn(me, 'login') && Object.hasOwn(me, 'admin');
}

/**
 * @returns {string|null}  the session a console page shows (`/s/<id>`), or null for any other page or another site
 */
export function sessionShown(url, consoleUrl) {
  try {
    const page = new URL(url);
    if (!consoleUrl || page.origin !== new URL(consoleUrl).origin) return null;
    return /^\/s\/([0-9a-f]{8})$/.exec(page.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * A path on the console as a URL on it, and never anywhere else: `/s/x` is the console's, and anything that would
 * resolve off it (`//host`, `/\\host`, a scheme) is the console's home.
 * @returns {string}
 */
export function consolePath(consoleUrl, path) {
  const home = new URL(consoleUrl);
  if (typeof path !== 'string' || !/^\/(?![/\\])/.test(path)) return home.href;
  try {
    const url = new URL(path, home);
    return url.origin === home.origin ? url.href : home.href;
  } catch {
    return home.href;
  }
}
