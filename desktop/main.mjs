// Woodshed's desktop app: the console in a window of its own, the session apps it opens in windows beside it, and a
// notification and a Dock badge when one of your sessions needs you. Everything else is the console's page as a
// browser shows it: the app holds no token and talks to nothing but the console the person typed.
import { app, BrowserWindow, Menu, Notification, ipcMain, nativeImage, net, screen, session, shell } from 'electron';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { attention, enabledKinds, NOTIFICATION_KINDS } from './attention.mjs';
import { consoleUrlFrom, destination, isConsoleMe, consolePath } from './links.mjs';
import { APP_PAGE_CHROME_CSS, consoleChromeCss, TRAFFIC_LIGHTS } from './windowChrome.mjs';
import { CONSOLE_SIGN_IN_PATHS, PROTOCOL, browserUrl, createPending, linkInArgs, parseSetCookie, parseSignedInLink, signInPathsFrom, signInStep } from './signIn.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const iconFile = path.join(here, 'icon.png');
const icon = existsSync(iconFile) ? nativeImage.createFromPath(iconFile) : undefined;
const POLL_MS = 20_000;
const READY_MS = 5_000;
const POLL_TIMEOUT_MS = 15_000;
// How long setup's check and a sign-in's claim wait for the console before saying it did not answer.
const ANSWER_MS = 15_000;
// Settled once the start has made the main window: a second launch or a sign-in link that comes in while the start
// still waits on the console's ready answer waits for it too, so there is never a second main window.
let markStarted;
const appStarted = new Promise((resolve) => { markStarted = resolve; });

// --- Settings: the console's address and the window's place, in the app's own folder. ---

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function readSettings() {
  try {
    return JSON.parse(readFileSync(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
}
function writeSettings(change) {
  const next = { ...readSettings(), ...change };
  mkdirSync(path.dirname(settingsFile()), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}

// The hosted console, opened when nothing is saved. A self-hosted installation picks its own with File → Change console…
const DEFAULT_CONSOLE = 'https://console.woodshed.run/';

// `--console=<url>` opens that console for this run without saving it (for trying a dev console); otherwise the saved
// one, or the hosted one. Not an environment variable: WOODSHED_CONSOLE_URL is already a session's own (the console it
// reports to), and the app run from a session's terminal would pick that up.
function consoleOverride() {
  const flag = process.argv.find((a) => a.startsWith('--console='));
  if (!flag) return null;
  try {
    return consoleUrlFrom(flag.slice('--console='.length));
  } catch (err) {
    console.error(`woodshed-desktop: --console: ${err.message}`);
    return null;
  }
}
let consoleUrl = null;
let appDomain = null;
let mainWindow = null;

// --- Windows ---

const webPreferences = { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true };

function where(url) {
  return consoleUrl ? destination(url, { consoleUrl, appDomain }) : 'external';
}

function openExternal(url) {
  if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
}

// Every window the app makes keeps the console's and its apps' pages in the app, signs in to GitHub where it started,
// and sends everything else to the browser.
function guard(win) {
  const contents = win.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    const to = where(url);
    if (to === 'external') {
      openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow', overrideBrowserWindowOptions: { width: 1200, height: 860, icon, backgroundColor: '#1b2232', webPreferences } };
  });
  contents.on('did-create-window', (child) => guard(child));
  contents.on('will-navigate', (event, url) => {
    // The console's sign-in: in the person's browser, when the console can hand it back (signInInBrowser).
    const step = consoleUrl && win === mainWindow ? signInStep(url, consoleUrl, signInPaths) : null;
    if (step) {
      event.preventDefault();
      signInInBrowser(step.next, url);
      return;
    }
    const to = where(url);
    if (to === 'console' || to === 'signIn' || (to === 'app' && win !== mainWindow)) return;
    event.preventDefault();
    if (to === 'app') {
      const child = new BrowserWindow({ width: 1200, height: 860, icon, backgroundColor: '#1b2232', webPreferences });
      guard(child);
      child.loadURL(url);
      return;
    }
    openExternal(url);
    // A window the page opened blank and then sent away (`window.open('about:blank')`, then its location) has nothing
    // to show once its address went to the browser.
    if (win !== mainWindow && ['', 'about:blank'].includes(contents.getURL())) win.close();
  });
  // A redirect (sign-in's callback, an app's /auth/app) is checked as a navigation is.
  contents.on('will-redirect', (event, url) => {
    // A signed-out page sent to sign in by a redirect (the hosted console's /login): the browser too, but only for a
    // console that said it hands sign-ins back, so the window's own sign-in, when it falls back to it, is never caught.
    const step = consoleUrl && win === mainWindow && desktopReady ? signInStep(url, consoleUrl, signInPaths) : null;
    if (step) {
      event.preventDefault();
      signInInBrowser(step.next, url);
      return;
    }
    if (where(url) === 'external') {
      event.preventDefault();
      openExternal(url);
    }
  });
}

// macOS: no title bar, the traffic lights in the rail's head (windowChrome.mjs). `--mac-chrome` adds the same rules to
// the pages anywhere, to look at the layout on another system, where the title bar itself stays.
const macChrome = process.platform === 'darwin';
const MAC_MIN_WIDTH = 900;
const chromeRules = macChrome || process.argv.includes('--mac-chrome');

// The header's rules on each page of the main window: the console's own, or the app's setup and sign-in pages'.
// The lights stay the same size whatever the page's zoom, so the room left for them is worked out at the zoom in use, and
// worked out again whenever it changes (the View menu's zoom, below).
const chromeKeys = new WeakMap();
async function applyChrome(contents) {
  if (!chromeRules || contents.isDestroyed()) return;
  const url = contents.getURL();
  const css = url.startsWith('file:') ? APP_PAGE_CHROME_CSS : where(url) === 'console' ? consoleChromeCss(contents.getZoomFactor()) : null;
  const old = chromeKeys.get(contents);
  chromeKeys.delete(contents);
  if (old) await contents.removeInsertedCSS(old).catch(() => {});
  if (css) chromeKeys.set(contents, await contents.insertCSS(css).catch(() => null));
  if (mainWindow && !mainWindow.isDestroyed() && contents === mainWindow.webContents) fitMinWidth(mainWindow);
}
function addChrome(contents) {
  if (!chromeRules) return;
  contents.on('dom-ready', () => { chromeKeys.delete(contents); applyChrome(contents); });
}
// Zoom in, out or back, and the header's room with it.
function zoomBy(step) {
  const win = BrowserWindow.getFocusedWindow();
  const contents = win?.webContents;
  if (!contents) return;
  let level = step === 0 ? 0 : Math.max(-3, Math.min(5, contents.getZoomLevel() + step * 0.5));
  // In the main window under the macOS header, no further in than its screen keeps the page 900px wide: past that the
  // window cannot grow, and the console would take its phone layout under the lights.
  if (chromeRules && win === mainWindow && step > 0) {
    const most = screen.getDisplayMatching(win.getBounds()).workAreaSize.width / MAC_MIN_WIDTH;
    const now = contents.getZoomLevel();
    while (level > now && 1.2 ** level > most) level -= 0.5;
    // Never out: a page already past the cap (a zoom Chromium kept, a smaller screen) stays where it is.
    level = Math.max(level, now);
  }
  contents.setZoomLevel(level);
  applyChrome(contents);
}

// Zoomed in, the page is narrower than the window: the main window's minimum grows with the zoom, so the page stays in
// the desktop layout (900px), never the phone one under the lights. On each page too, since Chromium keeps a zoom.
function fitMinWidth(win) {
  // Never wider than the screen the window is on: zoomed in that far, the window fills it.
  const screenWidth = screen.getDisplayMatching(win.getBounds()).workAreaSize.width;
  const least = Math.min(screenWidth, Math.ceil(MAC_MIN_WIDTH * Math.max(1, win.webContents.getZoomFactor())));
  const [, minHeight] = win.getMinimumSize();
  win.setMinimumSize(least, minHeight);
  const [width, height] = win.getSize();
  if (width < least) win.setSize(least, height);
}

// `waiting`: the window is made for a sign-in link arriving with none open. It shows the waiting page, not the console:
// a hosted console's first page would redirect to sign in, and start a second sign-in while this one is claimed.
function createMainWindow({ waiting = false } = {}) {
  const { bounds } = readSettings();
  mainWindow = new BrowserWindow({
    width: 1440, height: 920, minWidth: 420, minHeight: 480, ...(bounds ?? {}),
    // No narrower than the console's desktop layout (900px), whose rail head holds the lights: narrower, the console
    // takes its phone layout, whose top-left controls the lights would cover.
    ...(macChrome ? { titleBarStyle: 'hiddenInset', trafficLightPosition: TRAFFIC_LIGHTS } : {}),
    ...(chromeRules ? { minWidth: MAC_MIN_WIDTH } : {}),
    title: 'Woodshed', icon, backgroundColor: '#1b2232', show: false,
    webPreferences: { ...webPreferences, preload: path.join(here, 'preload.cjs') },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  const keepBounds = () => {
    if (!mainWindow.isMinimized() && !mainWindow.isFullScreen()) writeSettings({ bounds: mainWindow.getBounds() });
  };
  mainWindow.on('resized', keepBounds);
  mainWindow.on('moved', keepBounds);
  mainWindow.on('closed', () => { mainWindow = null; });
  guard(mainWindow);
  addChrome(mainWindow.webContents);
  if (waiting) return mainWindow.loadFile(path.join(here, 'signin.html')).catch(() => {});
  if (consoleUrl) loadConsole(mainWindow, consoleUrl);
  else showSetup();
  return Promise.resolve();
}

// Each time setup's form is shown: an answer to a form shown before saves nothing, though the new one has its address.
let setupShown = 0;
function showSetup(error) {
  setupShown += 1;
  // A console page waiting for its ready answer (File → Sessions a moment ago) does not replace the form opened now.
  loadSeq += 1;
  mainWindow.loadFile(path.join(here, 'setup.html'), { query: { current: readSettings().consoleUrl || DEFAULT_CONSOLE, ...(error ? { error } : {}) } });
}

// The setup page's one call: check the address answers like a console, save it and open it.
ipcMain.handle('console:connect', async (event, typed) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || !event.senderFrame?.url.startsWith('file:')) return { error: 'Not from the setup page.' };
  // The setup page that asked: a late answer saves nothing once it is gone (its window closed, or it moved on), and so
  // never sends another window anywhere.
  const win = mainWindow;
  const from = win.webContents.getURL();
  const shown = setupShown;
  const stillAsked = () => mainWindow === win && !win.isDestroyed() && win.webContents.getURL() === from && setupShown === shown;
  let url;
  try {
    url = consoleUrlFrom(typed);
  } catch (err) {
    return { error: err.message };
  }
  // The console's own /api/me, which answers signed out too: a web app's manifest alone would let any site through,
  // and the page of whatever is saved here gets the console's permissions (the microphone, notifications).
  try {
    // No redirects: the answer must come from the address typed, since that origin is what gets the permissions.
    const res = await net.fetch(new URL('api/me', url).href, { redirect: 'manual', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(ANSWER_MS) });
    const fromThere = !res.url || new URL(res.url).origin === new URL(url).origin;
    // The body under the same 15 s: one that stops partway is a console that did not answer, not one that is wrong.
    let me = null;
    if (res.ok && fromThere) {
      try {
        me = await res.json();
      } catch (err) {
        if (err.name === 'TimeoutError' || err.name === 'AbortError') throw err;
        me = null;
      }
    }
    if (!isConsoleMe(me)) return { error: `${url} answered, but not as a Woodshed console (status ${res.status}).` };
  } catch (err) {
    // `redirect: 'manual'` refuses a redirect with an error of its own.
    if (/redirect/i.test(err.message)) return { error: `${url} sends its console page elsewhere: type the console's own address.` };
    // A timeout before the answer is a TimeoutError; one partway through its body reaches the read as an AbortError.
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return { error: `${url} did not answer in ${ANSWER_MS / 1000} s. Check the address, or try again.` };
    return { error: `${url} did not answer: ${err.message}` };
  }
  if (!stillAsked()) {
    console.log('woodshed-desktop: the setup page was gone when the console answered, nothing saved');
    return { error: 'The setup page closed before the console answered.' };
  }
  writeSettings({ consoleUrl: url });
  consoleUrl = url;
  appDomain = null;
  // A sign-in started on the console before is not this one's.
  pending.take();
  signInAttempt += 1;
  // What was seen and the badge are the old console's: they go now, with it, whatever happens to the page after.
  startWatching();
  // Known before the console's first page, which a hosted console redirects to its own sign-in: only its answer names
  // that path, so the redirect can go to the browser. The page is loaded only while setup still asks, and only if
  // nothing asked for another page meanwhile (File → Sessions, New session).
  await loadConsole(win, url, { still: stillAsked });
  return { ok: true };
});

// --- Signing in through the browser, where the person is usually signed in to GitHub already (signIn.mjs). The
// console hands the sign-in back on a woodshed:// link; one that cannot (older, or behind a hosting proxy that signs
// people in itself) is signed in to in the window, as before. ---

const pending = createPending();
// Each new sign-in (Sign in with GitHub, Sign in in this window instead, Change console…) is a new attempt: a claim
// that answers after a newer one began stores no account and moves no window.
let signInAttempt = 0;
// What the console's /auth/desktop/ready last said: whether it hands sign-ins back, and the paths its pages sign in at
// (a hosted console's are its host's), read at start and on Change console…, and asked again at each sign-in.
let desktopReady = false;
let signInPaths = [...CONSOLE_SIGN_IN_PATHS];

// One read in flight for a console at a time, shared by whoever asks meanwhile (the start, Change console…, a menu's
// load, Sign in): two at once could answer differently, the later one, if it failed, overwriting the good one.
let readyInFlight = null;
function readDesktopReady() {
  const base = consoleUrl;
  if (readyInFlight?.base === base) return readyInFlight.promise;
  const promise = askDesktopReady(base).finally(() => { if (readyInFlight?.promise === promise) readyInFlight = null; });
  readyInFlight = { base, promise };
  return promise;
}
async function askDesktopReady(base) {
  let ready = null;
  let answered = false;
  try {
    // 5 s at most: a console that never answers signs in inside the window, rather than leave Sign in doing nothing.
    const res = await net.fetch(new URL('auth/desktop/ready', base).href, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(READY_MS) });
    answered = true;
    ready = res.ok ? await res.json().catch(() => null) : null;
  } catch {
    ready = null;
  }
  // An answer from a console no longer in use is not this one's.
  if (base !== consoleUrl) return false;
  // No answer at all keeps what this console said before, if it said anything: a slow moment is not a change of mind.
  if (!answered && readyKnownFor === base) return desktopReady;
  desktopReady = ready?.desktop === true;
  signInPaths = signInPathsFrom(desktopReady ? ready : null);
  readyKnownFor = base;
  return desktopReady;
}
// The console whose ready answer `desktopReady` and `signInPaths` hold: a page of another is loaded only once its own is
// known (loadConsole), so its sign-in redirect goes where that console says.
let readyKnownFor = null;
// Loads wait for that answer in turn, and only the latest asked goes ahead: Change console…'s own load and File →
// Sessions pressed while it waits never both load, and never race each other's sign-in.
let loadSeq = 0;
async function loadConsole(win, url, { still = () => true } = {}) {
  const mine = ++loadSeq;
  const base = consoleUrl;
  if (readyKnownFor !== base) await readyBeforeLoading();
  if (mine !== loadSeq || base !== consoleUrl || !win || win.isDestroyed() || !still()) return false;
  win.loadURL(url);
  return true;
}
const desktopSignInReady = readDesktopReady;
// The ready answer before a console's first page, but never more than 5 s: a console that does not answer it signs in
// inside the window, as one from before the desktop sign-in.
const readyBeforeLoading = () => readDesktopReady();
// Where the window signs in, for a console that cannot hand the sign-in back or a person who asked to stay here.
const signInHere = (next) => new URL(`${signInPaths[0].replace(/^\//, '')}?next=${encodeURIComponent(next)}`, consoleUrl).href;

// `inWindow`: the address the page was going to, for a console that cannot hand the sign-in back. `again`: the waiting
// page's Open the browser again, which reuses the sign-in started; a press of Sign in with GitHub starts a new one.
async function signInInBrowser(next, inWindow, { again = false } = {}) {
  const base = consoleUrl;
  // Where the window was when the person pressed: a slow answer must not take it from wherever they went since (Change
  // console…, another page).
  // The very window, not only its address: one opened in its place may be at the same one.
  const win = mainWindow;
  const from = win?.webContents.getURL();
  const ready = await desktopSignInReady();
  if (base !== consoleUrl || !win || mainWindow !== win || win.isDestroyed() || win.webContents.getURL() !== from) {
    console.log('woodshed-desktop: the window moved on while the console was asked, sign-in not started');
    return;
  }
  if (!ready) {
    console.log('woodshed-desktop: the console signs in inside the window');
    mainWindow.loadURL(inWindow);
    return;
  }
  // Open the browser again reuses the sign-in already started, so a code from either tab is claimed with its verifier.
  const reused = again && pending.current(base);
  if (!reused) signInAttempt += 1;
  const started = reused || pending.begin(next, base);
  shell.openExternal(browserUrl(base, { challenge: started.challenge, next: started.next }));
  mainWindow.loadFile(path.join(here, 'signin.html'));
}

// An overtaken sign-in's session, ended on the console with its own cookie sent by hand. The cookie jar is never
// touched, so a newer sign-in's cookie stored under the same name meanwhile stays, whatever the order: left in the jar,
// the ended session's cookie signs nobody in. When the console does not end it (down, or a hosting layer's sign-out),
// it is left as it is: the newer sign-in overwrites it when it finishes, and until then the app is signed in as the
// account the person approved in their browser a moment ago. Removing it instead could remove the newer one.
async function endOvertakenSession(base, cookies) {
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  let ended = false;
  try {
    const res = await session.defaultSession.fetch(new URL('auth/sign-out', base).href, {
      method: 'POST', credentials: 'omit', redirect: 'manual', headers: { cookie: cookieHeader }, signal: AbortSignal.timeout(ANSWER_MS),
    });
    ended = res.status === 303 || res.ok;
  } catch (err) {
    // `redirect: 'manual'` reports the console's 303 as an error of its own: the sign-out was answered.
    ended = /redirect/i.test(err.message);
  }
  if (ended) console.log('woodshed-desktop: a sign-in stored after a newer one began, ended on the console');
  else console.warn('woodshed-desktop: a sign-in stored after a newer one began, not ended: the console did not take its sign-out, left for the newer one to replace');
}

async function finishSignIn(link) {
  await appStarted;
  const signedIn = parseSignedInLink(link);
  if (!signedIn || !consoleUrl) return;
  // Only the link of the sign-in waiting on the console open now, by its challenge: its code and verifier go to no
  // other console, and a stale tab's link, or another console's, leaves that sign-in waiting.
  const started = pending.takeFor(consoleUrl, signedIn.challenge);
  if (!started) {
    console.warn('woodshed-desktop: a sign-in link that is not the waiting sign-in\'s, ignored');
    return;
  }
  // The window and the page the sign-in may move on from, fixed before anything waits: with none open, one is made on
  // the waiting page, and its address is the page's own, not whatever it shows by the time it has loaded (a setup
  // form, a page opened meanwhile). Setup shown since, even at the same address, is the person moving on too.
  const shownAt = setupShown;
  let from;
  if (!mainWindow) {
    const loaded = createMainWindow({ waiting: true });
    from = pathToFileURL(path.join(here, 'signin.html')).href;
    const made = mainWindow;
    await loaded;
    if (mainWindow !== made) console.log('woodshed-desktop: the window made for a sign-in closed or was replaced while it opened; the sign-in is kept, no window is moved');
  } else {
    from = mainWindow.webContents.getURL();
  }
  const win = mainWindow;
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  const base = consoleUrl;
  const attempt = signInAttempt;
  const claimUrl = new URL('auth/desktop/claim', base).href;
  let error = null;
  let setCookies = [];
  try {
    // No redirects: the code and the verifier go to the console that made the code, and nowhere it might point. No
    // credentials either: the answer's cookie is stored below, and only while this is still the sign-in under way.
    const res = await session.defaultSession.fetch(claimUrl, {
      method: 'POST', credentials: 'omit', redirect: 'manual', signal: AbortSignal.timeout(ANSWER_MS),
      headers: { 'content-type': 'application/json', 'x-woodshed': '1' },
      body: JSON.stringify({ code: signedIn.code, verifier: started.verifier }),
    });
    if (res.url && new URL(res.url).origin !== new URL(base).origin) error = 'The console answered from another address.';
    else if (!res.ok) error = (await res.json().catch(() => null))?.error ?? `The console answered ${res.status}.`;
    else setCookies = res.headers.getSetCookie?.() ?? [];
  } catch (err) {
    error = /redirect/i.test(err.message) ? 'The console sent the sign-in elsewhere, so it was not finished.'
      : err.name === 'TimeoutError' || err.name === 'AbortError' ? `The console did not answer in ${ANSWER_MS / 1000} s, so the sign-in was not finished.`
        : `The console did not answer: ${err.message}`;
  }
  // Change console… while the claim was on its way: the window is the new console's now, and stays so.
  if (base !== consoleUrl || !mainWindow) {
    console.warn('woodshed-desktop: a sign-in finished after the console changed, not opened');
    return;
  }
  // A newer sign-in began while this claim was on its way: its account and its page are the person's now.
  if (attempt !== signInAttempt) {
    console.log('woodshed-desktop: a sign-in finished after a newer one began, dropped', { signedIn: !error });
    return;
  }
  if (!error) {
    try {
      const cookies = setCookies.map((header) => parseSetCookie(header, claimUrl)).filter(Boolean);
      if (!cookies.length) throw new Error('the console sent no session');
      // Checked just before the store as well as after: a sign-in overtaken already stores nothing.
      if (attempt !== signInAttempt || base !== consoleUrl) {
        console.log('woodshed-desktop: a sign-in overtaken before it was stored, dropped');
        return;
      }
      for (const cookie of cookies) await session.defaultSession.cookies.set(cookie);
      // A newer sign-in began while it was stored: that one's account is the person's, so this one is ended.
      if (attempt !== signInAttempt || base !== consoleUrl) {
        await endOvertakenSession(base, cookies);
        return;
      }
    } catch (err) {
      error = `The sign-in could not be kept: ${err.message}`;
    }
  }
  // The window closed while the session was stored: signed in all the same, with nothing to show it in.
  if (!mainWindow) {
    console.log('woodshed-desktop: a sign-in finished with no window open', { signedIn: !error });
    if (!error) startWatching();
    return;
  }
  if (!win || mainWindow !== win || win.isDestroyed() || win.webContents.getURL() !== from || setupShown !== shownAt) {
    console.log('woodshed-desktop: a sign-in finished after the window moved on, left where it is', { signedIn: !error });
    if (!error) startWatching();
    return;
  }
  if (error) {
    mainWindow.loadFile(path.join(here, 'signin.html'), { query: { error } });
    return;
  }
  mainWindow.loadURL(consolePath(base, signedIn.next));
  startWatching();
}

function fromSignInPage(event) {
  return mainWindow && event.sender === mainWindow.webContents && event.senderFrame?.url.startsWith('file:');
}
// The waiting page's two buttons: the browser again, or the window after all.
ipcMain.handle('signin:browser', (event) => {
  if (!fromSignInPage(event) || !consoleUrl) return;
  const next = pending.current(consoleUrl)?.next ?? '/';
  signInInBrowser(next, signInHere(next), { again: true });
});
ipcMain.handle('signin:here', (event) => {
  if (!fromSignInPage(event) || !consoleUrl) return;
  signInAttempt += 1;
  const next = pending.take()?.next ?? '/';
  mainWindow.loadURL(signInHere(next));
});

// --- Attention: the badge and notifications, from the same /api/sessions the rail reads, with the window's cookie. ---

// What the last read saw (attention.mjs, Seen), which the next is compared with; null until a first read.
let seen = null;
let firstRead = true;
let timer = null;
// Each start of watching (a new console, a sign-in) is a new generation: a read begun before it is dropped when it
// answers, so a slow answer from the last console can neither overwrite this one's state nor notify about its sessions.
let generation = 0;
let reading = false;
// Reads in a row the console did not answer.
let failures = 0;

function forget() {
  seen = null;
  firstRead = true;
  app.setBadgeCount(0);
  if (process.platform === 'win32') mainWindow?.setOverlayIcon(null, '');
}

function startWatching() {
  generation += 1;
  reading = false;
  failures = 0;
  forget();
  clearTimeout(timer);
  poll();
}

async function poll() {
  clearTimeout(timer);
  timer = setTimeout(poll, POLL_MS);
  if (!consoleUrl || reading) return;
  const mine = generation;
  const base = consoleUrl;
  reading = true;
  let body = null;
  let signedOut = false;
  let failure = null;
  try {
    // 15 s at most: a read that never answers would otherwise hold `reading`, and the badge and notifications with it.
    const res = await session.defaultSession.fetch(new URL('api/sessions', base).href, { credentials: 'include', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
    // Signed out, or a page in place of JSON: nothing to count until the person signs in.
    if (res.ok && String(res.headers.get('content-type')).includes('json')) body = await res.json();
    else if (res.status === 401 || res.status === 302 || res.status === 403 || res.ok) signedOut = true;
    // Anything else (a 502 or 503 from a console or proxy that is down) is a read that failed, as no answer is.
    else failure = `HTTP ${res.status}`;
  } catch (err) {
    failure = err.name === 'TimeoutError' || err.name === 'AbortError' ? `no answer in ${POLL_TIMEOUT_MS / 1000} s` : err.message;
  } finally {
    if (mine === generation) reading = false;
  }
  if (mine !== generation || base !== consoleUrl) return;
  // The console did not answer: said once for each run of failures. One miss keeps the badge, a console that misses three
  // reads in a row (a minute) clears it, since it no longer says anything true.
  if (failure) {
    failures += 1;
    if (failures === 1) console.warn('woodshed-desktop: sessions not read', { console: base, why: failure });
    if (failures === 3) {
      console.warn('woodshed-desktop: sessions not read three times, the badge cleared', { console: base, why: failure });
      forget();
    }
    return;
  }
  if (failures) console.log('woodshed-desktop: sessions read again', { after: failures });
  failures = 0;
  // Signed out: the badge and what was seen go, so signing in again (as anyone) starts from a first read.
  if (signedOut) {
    if (seen) console.log('woodshed-desktop: signed out, the badge cleared');
    forget();
    return;
  }
  if (!body) return;
  appDomain = body.appDomain || null;
  // A kind switched off is still followed, so switching it on later replays nothing.
  const { badge, now, notify } = attention(body, seen, { first: firstRead, enabled: enabledKinds(readSettings().notifications) });
  seen = now;
  firstRead = false;
  app.setBadgeCount(badge);
  if (process.platform === 'win32' && mainWindow) mainWindow.setOverlayIcon(badge ? icon : null, badge ? `${badge} need you` : '');
  if (!Notification.isSupported()) return;
  for (const n of notify) {
    // The person is looking at it already.
    if (mainWindow?.isFocused() && mainWindow.webContents.getURL().includes(`/s/${n.id}`)) continue;
    const shown = new Notification({ title: n.title, body: n.body, icon, silent: false });
    shown.on('click', () => {
      if (!mainWindow) createMainWindow();
      // The console this read came from: a notification from before Change console… does not open on the new one.
      if (base !== consoleUrl) return;
      mainWindow.loadURL(new URL(`s/${encodeURIComponent(n.id)}`, base).href);
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    });
    shown.show();
  }
}

// --- Permissions: the console's page may use the microphone (dictation), notifications and the clipboard; an app's
// page only the clipboard and full screen; anything else is refused. ---

const CONSOLE_PERMISSIONS = new Set(['media', 'notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen']);
const APP_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']);
function permitted(permission, origin, details) {
  const to = origin ? where(origin) : 'external';
  if (permission === 'media' && details?.mediaTypes?.some((t) => t !== 'audio')) return false;
  if (to === 'console') return CONSOLE_PERMISSIONS.has(permission);
  if (to === 'app') return APP_PERMISSIONS.has(permission);
  return false;
}

// --- Menu ---

function buildMenu() {
  const isMac = process.platform === 'darwin';
  // Through loadConsole: during a Change console… the new console's ready answer may not be known yet.
  const goHome = () => consoleUrl && loadConsole(mainWindow, consoleUrl);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Sessions', accelerator: 'CmdOrCtrl+Shift+H', click: goHome },
        { label: 'New session', accelerator: 'CmdOrCtrl+N', click: () => consoleUrl && loadConsole(mainWindow, new URL('?new=1', consoleUrl).href) },
        { type: 'separator' },
        { label: 'Open in browser', click: () => { const url = BrowserWindow.getFocusedWindow()?.webContents.getURL(); if (url?.startsWith('http')) shell.openExternal(url); } },
        { label: 'Change console…', click: () => mainWindow && showSetup() },
        { type: 'separator' },
        // One switch per kind (attention.mjs, NOTIFICATION_KINDS), saved in settings.json's `notifications`; the next
        // read uses it. The badge counts the sessions that need you whatever these say.
        {
          label: 'Notifications',
          submenu: NOTIFICATION_KINDS.map(({ key, label }) => ({
            label, type: 'checkbox', checked: enabledKinds(readSettings().notifications).has(key),
            click: (item) => writeSettings({ notifications: { ...readSettings().notifications, [key]: item.checked } }),
          })),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' },
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => BrowserWindow.getFocusedWindow()?.webContents.navigationHistory.goBack() },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => BrowserWindow.getFocusedWindow()?.webContents.navigationHistory.goForward() },
        { type: 'separator' },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => zoomBy(0) },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => zoomBy(1) },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', visible: false, acceleratorWorksWhenHidden: true, click: () => zoomBy(1) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => zoomBy(-1) },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]));
}

// --- Start ---

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setName('Woodshed');
  if (process.platform === 'win32') app.setAppUserModelId('run.woodshed.desktop');
  // The woodshed:// link: macOS hands it to the running app, Windows and Linux start a second one with it as an
  // argument, which the lock below turns into 'second-instance'. A run from a checkout registers Electron itself, with
  // this folder as its argument.
  if (process.defaultApp) app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1] ?? '.')]);
  else app.setAsDefaultProtocolClient(PROTOCOL);
  app.on('open-url', (event, link) => {
    event.preventDefault();
    app.whenReady().then(() => finishSignIn(link));
  });
  app.on('second-instance', async (event, argv) => {
    const link = linkInArgs(argv);
    if (link) return finishSignIn(link);
    await appStarted;
    if (!mainWindow) return createMainWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(async () => {
    consoleUrl = consoleOverride() ?? (readSettings().consoleUrl || DEFAULT_CONSOLE);
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => callback(permitted(permission, details.requestingUrl, details)));
    session.defaultSession.setPermissionCheckHandler((wc, permission, origin, details) => permitted(permission, origin, details));
    if (process.platform === 'darwin' && icon) app.dock?.setIcon(icon);
    buildMenu();
    await readyBeforeLoading();
    createMainWindow();
    markStarted();
    startWatching();
    app.on('activate', () => { if (!mainWindow) createMainWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  // No webview, ever: a page that adds one would get a browser without the guards above.
  app.on('web-contents-created', (event, contents) => contents.on('will-attach-webview', (e) => e.preventDefault()));
}
