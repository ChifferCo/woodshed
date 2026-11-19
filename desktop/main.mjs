// Woodshed's desktop app: the console in a window of its own, the session apps it opens in windows beside it, and a
// notification and a Dock badge when one of your sessions needs you. Everything else is the console's page as a
// browser shows it: the app holds no token and talks to nothing but the console the person typed.
import { app, BrowserWindow, Menu, Notification, ipcMain, nativeImage, net, session, shell } from 'electron';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attention } from './attention.mjs';
import { consoleUrlFrom, destination } from './links.mjs';

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

// `--console=<url>` opens that console for this run without saving it (for trying a dev console); otherwise the saved
// one, or the setup page. Not an environment variable: WOODSHED_CONSOLE_URL is already a session's own (the console it
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
  mainWindow.loadFile(path.join(here, 'setup.html'), { query: { current: readSettings().consoleUrl ?? '', ...(error ? { error } : {}) } });
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
  try {
    const res = await net.fetch(new URL('manifest.webmanifest', url).href, { redirect: 'follow' });
    const manifest = res.ok ? await res.json().catch(() => null) : null;
    if (!manifest?.name) return { error: `${url} answered, but not as a Woodshed console (status ${res.status}).` };
  } catch (err) {
    return { error: `${url} did not answer: ${err.message}` };
  }
  writeSettings({ consoleUrl: url });
  consoleUrl = url;
  appDomain = null;
  mainWindow.loadURL(url);
  startWatching();
  return { ok: true };
});

// --- Attention: the badge and notifications, from the same /api/sessions the rail reads, with the window's cookie. ---

let waiting = new Map();
let firstRead = true;
let timer = null;

function startWatching() {
  waiting = new Map();
  firstRead = true;
  clearTimeout(timer);
  poll();
}

async function poll() {
  clearTimeout(timer);
  timer = setTimeout(poll, POLL_MS);
  if (!consoleUrl) return;
  let body;
  try {
    const res = await session.defaultSession.fetch(new URL('api/sessions', consoleUrl).href, { credentials: 'include', headers: { Accept: 'application/json' } });
    // Signed out, or a page in place of JSON: nothing to count until the person signs in.
    if (!res.ok || !String(res.headers.get('content-type')).includes('json')) return;
    body = await res.json();
  } catch {
    return;
  }
  appDomain = body.appDomain || null;
  const { badge, now, notify } = attention(body, waiting, { first: firstRead });
  waiting = now;
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
      mainWindow.loadURL(new URL(`s/${encodeURIComponent(n.id)}`, consoleUrl).href);
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
  app.on('second-instance', () => {
    if (!mainWindow) return createMainWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(() => {
    consoleUrl = consoleOverride() ?? (readSettings().consoleUrl || null);
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
