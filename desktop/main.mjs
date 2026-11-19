// Woodshed's desktop app: the console in a window of its own, the session apps it opens in windows beside it, and a
// notification and a Dock badge when one of your sessions needs you. Everything else is the console's page as a
// browser shows it: the app holds no token and talks to nothing but the console the person typed.
import { app, BrowserWindow, Menu, Notification, ipcMain, nativeImage, net, session, shell } from 'electron';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attention, enabledKinds, NOTIFICATION_KINDS } from './attention.mjs';
import { consoleUrlFrom, destination, isConsoleMe, consolePath } from './links.mjs';
import { PROTOCOL, browserUrl, createPending, linkInArgs, parseSignedInLink, signInStep } from './signIn.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const iconFile = path.join(here, 'icon.png');
const icon = existsSync(iconFile) ? nativeImage.createFromPath(iconFile) : undefined;
const POLL_MS = 20_000;

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
    // The console's Sign in with GitHub: in the person's browser, when the console can hand it back (signInInBrowser).
    const step = consoleUrl && win === mainWindow ? signInStep(url, consoleUrl) : null;
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
    if (where(url) === 'external') {
      event.preventDefault();
      openExternal(url);
    }
  });
}

function createMainWindow() {
  const { bounds } = readSettings();
  mainWindow = new BrowserWindow({
    width: 1440, height: 920, minWidth: 420, minHeight: 480, ...(bounds ?? {}),
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
  if (consoleUrl) mainWindow.loadURL(consoleUrl);
  else showSetup();
}

function showSetup(error) {
  mainWindow.loadFile(path.join(here, 'setup.html'), { query: { current: readSettings().consoleUrl || DEFAULT_CONSOLE, ...(error ? { error } : {}) } });
}

// The setup page's one call: check the address answers like a console, save it and open it.
ipcMain.handle('console:connect', async (event, typed) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || !event.senderFrame?.url.startsWith('file:')) return { error: 'Not from the setup page.' };
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
    const res = await net.fetch(new URL('api/me', url).href, { redirect: 'manual', headers: { Accept: 'application/json' } });
    const fromThere = !res.url || new URL(res.url).origin === new URL(url).origin;
    const me = res.ok && fromThere ? await res.json().catch(() => null) : null;
    if (!isConsoleMe(me)) return { error: `${url} answered, but not as a Woodshed console (status ${res.status}).` };
  } catch (err) {
    // `redirect: 'manual'` refuses a redirect with an error of its own.
    if (/redirect/i.test(err.message)) return { error: `${url} sends its console page elsewhere: type the console's own address.` };
    return { error: `${url} did not answer: ${err.message}` };
  }
  writeSettings({ consoleUrl: url });
  consoleUrl = url;
  appDomain = null;
  // A sign-in started on the console before is not this one's.
  pending.take();
  mainWindow.loadURL(url);
  startWatching();
  return { ok: true };
});

// --- Signing in through the browser, where the person is usually signed in to GitHub already (signIn.mjs). The
// console hands the sign-in back on a woodshed:// link; one that cannot (older, or behind a hosting proxy that signs
// people in itself) is signed in to in the window, as before. ---

const pending = createPending();

async function desktopSignInReady() {
  try {
    const res = await net.fetch(new URL('auth/desktop/ready', consoleUrl).href, { headers: { Accept: 'application/json' } });
    return res.ok && (await res.json().catch(() => null))?.desktop === true;
  } catch {
    return false;
  }
}

// `inWindow`: the address the page was going to, for a console that cannot hand the sign-in back.
async function signInInBrowser(next, inWindow) {
  const base = consoleUrl;
  const ready = await desktopSignInReady();
  // Change console… while the console was asked: this sign-in was for the other one.
  if (base !== consoleUrl) return;
  if (!ready) {
    console.log('woodshed-desktop: the console signs in inside the window');
    mainWindow?.loadURL(inWindow);
    return;
  }
  const { challenge } = pending.begin(next, consoleUrl);
  shell.openExternal(browserUrl(consoleUrl, { challenge, next }));
  mainWindow?.loadFile(path.join(here, 'signin.html'));
}

async function finishSignIn(link) {
  const signedIn = parseSignedInLink(link);
  if (!signedIn || !consoleUrl) return;
  // Only the sign-in started on the console open now: its code and verifier go to no other.
  const started = pending.take();
  if (!started || started.consoleUrl !== consoleUrl) {
    console.warn('woodshed-desktop: a sign-in link arrived with no sign-in started on this console, ignored');
    return;
  }
  if (!mainWindow) createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  const base = consoleUrl;
  let error = null;
  try {
    const res = await session.defaultSession.fetch(new URL('auth/desktop/claim', base).href, {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-woodshed': '1' },
      body: JSON.stringify({ code: signedIn.code, verifier: started.verifier }),
    });
    if (!res.ok) error = (await res.json().catch(() => null))?.error ?? `The console answered ${res.status}.`;
  } catch (err) {
    error = `The console did not answer: ${err.message}`;
  }
  // Change console… while the claim was on its way: the window is the new console's now, and stays so.
  if (base !== consoleUrl || !mainWindow) {
    console.warn('woodshed-desktop: a sign-in finished after the console changed, not opened');
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
  const { next } = pending.waiting() ? pending.take() : { next: '/' };
  signInInBrowser(next, new URL(`auth/start?next=${encodeURIComponent(next)}`, consoleUrl).href);
});
ipcMain.handle('signin:here', (event) => {
  if (!fromSignInPage(event) || !consoleUrl) return;
  const next = pending.take()?.next ?? '/';
  mainWindow.loadURL(new URL(`auth/start?next=${encodeURIComponent(next)}`, consoleUrl).href);
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

function forget() {
  seen = null;
  firstRead = true;
  app.setBadgeCount(0);
  if (process.platform === 'win32') mainWindow?.setOverlayIcon(null, '');
}

function startWatching() {
  generation += 1;
  reading = false;
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
  try {
    const res = await session.defaultSession.fetch(new URL('api/sessions', base).href, { credentials: 'include', headers: { Accept: 'application/json' } });
    // Signed out, or a page in place of JSON: nothing to count until the person signs in.
    if (res.ok && String(res.headers.get('content-type')).includes('json')) body = await res.json();
    else signedOut = res.status === 401 || res.status === 302 || res.status === 403 || res.ok;
  } catch {
    // The console did not answer: keep what the badge says until it does.
  } finally {
    if (mine === generation) reading = false;
  }
  if (mine !== generation || base !== consoleUrl) return;
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
  const goHome = () => consoleUrl && mainWindow?.loadURL(consoleUrl);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Sessions', accelerator: 'CmdOrCtrl+Shift+H', click: goHome },
        { label: 'New session', accelerator: 'CmdOrCtrl+N', click: () => consoleUrl && mainWindow?.loadURL(new URL('?new=1', consoleUrl).href) },
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
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' },
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
  app.on('second-instance', (event, argv) => {
    const link = linkInArgs(argv);
    if (link) return finishSignIn(link);
    if (!mainWindow) return createMainWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(() => {
    consoleUrl = consoleOverride() ?? (readSettings().consoleUrl || DEFAULT_CONSOLE);
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => callback(permitted(permission, details.requestingUrl, details)));
    session.defaultSession.setPermissionCheckHandler((wc, permission, origin, details) => permitted(permission, origin, details));
    if (process.platform === 'darwin' && icon) app.dock?.setIcon(icon);
    buildMenu();
    createMainWindow();
    startWatching();
    app.on('activate', () => { if (!mainWindow) createMainWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  // No webview, ever: a page that adds one would get a browser without the guards above.
  app.on('web-contents-created', (event, contents) => contents.on('will-attach-webview', (e) => e.preventDefault()));
}
