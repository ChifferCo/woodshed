# The desktop app

Woodshed's console in a window of its own, for macOS, Windows and Linux, built on Electron. It is the console's page as
a browser shows it, with three things a browser tab does not give:

- **A notification when one of your sessions needs you**, or finished its turn. Clicking it opens that session.
- **A badge** on the Dock (macOS), the launcher (Linux) or the taskbar (Windows) counting your sessions that are asking
  for you.
- **A window in cmd+tab / alt+tab** with Woodshed's mark, which keeps its size and place between starts.

It holds no token and talks to nothing but the console you typed: you sign in on the console's own page, as in a
browser, and the cookie stays in the app's profile.

This folder is the only part of Woodshed with dependencies (Electron and electron-builder, as dev dependencies). The
console, the sessions and the providers stay plain Node with none, and nothing outside this folder imports from it.

## Running it

From this folder, with Node 22 or later:

```bash
npm install
npm start
```

It opens the hosted console, `https://console.woodshed.run`, until you pick another. For a self-hosted installation,
**File → Change console…** asks for the console's address: the one you open in your browser (`https://woodshed.example.com`,
or `localhost:7690` for a console on this computer). Plain `http://` is accepted only for a console on this computer,
since sign-in cookies need https anywhere else. The app checks that the address answers like a console (its
`/manifest.webmanifest`), keeps it, and opens it on every start after.

`npm start -- --console=localhost:7690` opens a console for that run without saving it, for trying a dev console
(`node console/bin/devConsole.mjs`). It is a flag, not an environment variable, on purpose: `WOODSHED_CONSOLE_URL` is
already set inside every session.

## Building installers

```bash
npm run dist                  # this machine's platform
npm run dist -- --mac         # .dmg and .zip
npm run dist -- --win         # NSIS installer
npm run dist -- --linux       # AppImage and .deb
```

They land in `dist/`. The builds are unsigned: macOS Gatekeeper and Windows SmartScreen warn on first open until the
installation signs them (electron-builder's `CSC_LINK` and `CSC_KEY_PASSWORD`, and Apple's notarization). The icon
(`icon.png`) is written from the console's own mark in `shared/pwa.mjs` by `icon.mjs` before each start and build, so
the app and an installed web app look the same.

## Where links go

`links.mjs` decides, for every navigation and every window the page opens:

| Address | Where |
| --- | --- |
| The console itself | The app: the main window, or a window of its own for what the page opens in a new tab (a terminal, a database viewer) |
| A session's app, editor or viewer on the console's app domain (`appDomain` from `/api/sessions`), or another port of a local console's host | A window of its own, sharing the console's cookie, so its sign-in works as in a browser |
| GitHub's sign-in pages (`/login…`, `/session`, `/sessions/…`) | The window signing in |
| Everything else: pull requests, issues, docs | The default browser |

## Notifications and the badge

The main process reads `/api/sessions` every 20 seconds with the window's cookie, as the rail does, and
`attention.mjs` picks out your sessions, as the rail's Mine does (your private sessions, and the shared ones you
started or have; every session on a console one person uses). A running session whose claude asks for you
(`needs-you`) counts toward the badge and is notified; one that finished its turn (`done`) is notified only. Questions
from Slack, reviews and QA runs never count. The first read after a start notifies about nothing, so opening the app
does not replay every waiting session. Signed out, nothing is read.

## What a page may do

Windows run with context isolation, the sandbox and no Node. The preload exposes one call, to the app's own setup
page and nothing else. The console's page may use the microphone (dictation), notifications and the clipboard; a
session app's page the clipboard and full screen; anything else is refused. No page may add a `<webview>`.

## Checks

`node --test desktop/` (part of Woodshed's `node --test` run) checks `links.mjs` and `attention.mjs`, which need no
Electron. To see the app itself, start a dev console (`bash scripts/devConsoleApp.sh start` from the repo's root) and
`npm start -- --console=localhost:7690`.
