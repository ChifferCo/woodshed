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
`/api/me`, which a console gives signed out too), keeps it, and opens it on every start after.

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
installation signs them (electron-builder's `CSC_LINK` and `CSC_KEY_PASSWORD`, and Apple's notarization).

The icon, `icon.png`, is the console's mark (`shared/pwa.mjs`) on Apple's icon grid: a rounded tile with a margin and
a shadow, since the Dock shows a PNG as it is and the web app's full-bleed square sits there as a box.
`renderIcon.mjs` draws it; run `npx electron renderIcon.mjs` here after the mark changes, and commit the file.

Run from a checkout (`npm start`), macOS names the app Electron in the Dock's tooltip and the app menu: that name comes
from Electron's own bundle, and only a built app (`npm run dist`) is called Woodshed there.

## Where links go

`links.mjs` decides, for every navigation and every window the page opens:

| Address | Where |
| --- | --- |
| The console itself | The app: the main window, or a window of its own for what the page opens in a new tab (a terminal, a database viewer) |
| A session's app, editor or viewer on the console's app domain (`appDomain` from `/api/sessions`), or another port of a local console's host | A window of its own, sharing the console's cookie, so its sign-in works as in a browser |
| The console's **Sign in with GitHub** (`/auth/start`) | The default browser, which hands the sign-in back (below); on a console that cannot, the window, as GitHub's sign-in pages (`/login…`, `/session`, `/sessions/…`) are |
| Everything else: pull requests, issues, docs | The default browser |

## Signing in

As native apps do, the app signs in through your default browser, where you are usually signed in to GitHub already
(`signIn.mjs`; the console's side is `console/desktopSignIn.mjs`, and console/README.md's "Sign-in" has the routes):

1. **Sign in with GitHub** on the console's page opens the browser at the console's `/auth/desktop`, with the SHA-256
   of a verifier only the app holds. The window says to finish there.
2. The browser signs in to the console as it always does (a click, when GitHub knows you), then asks **Sign in to the
   Woodshed app?** as whom. Its button, and only that, makes the code: another program could open the browser at the
   same page, but not press it. The next page opens `woodshed://signed-in?code=…`, and the browser asks whether to open
   Woodshed: say yes.
3. The app claims the code with its verifier, gets a session of its own, and opens where you were going. A code
   another program catches is no use without the verifier, works once, and lasts two minutes; a link the app started
   no sign-in for, or one for another console than the one open now, is ignored, and the page to open after it is
   always a path on that console.

`/auth/desktop/ready` also names the paths the console's pages sign in at (`signInPaths`): `/auth/start` on a console
of its own, the host's on one behind a program that signs people in itself (the hosted console's `/account/sign-in`,
which its `/login` redirects to). The app sends a click or a redirect to any of them to the browser. A console that
cannot hand the sign-in back (one from before this, or behind a proxy that answers none of these routes) is signed in
to inside the window, as in a browser. The waiting
page's **Sign in in this window instead** does the same anywhere.

`woodshed://` is the app's: a built app registers it (electron-builder's `protocols`); `npm start` registers Electron,
with this folder as its argument.

## Notifications and the badge

The main process reads `/api/sessions` every 20 seconds with the window's cookie, as the rail does, and `attention.mjs`
picks out your sessions, as the rail's Mine does (your private sessions, and the shared ones you started or have; every
session on a console one person uses). The badge counts your running sessions whose claude asks for you (`needs-you`). A
notification is a change between two reads, in the console's words, and clicking it opens that session:

| Kind | Says | On at first |
| --- | --- | --- |
| A session needs you | `Needs you: claude is asking a question.` | Yes |
| A session is done with its turn | `Done: claude finished its turn.` (not while it is in review or waiting on a job) | Yes |
| A session failed | `Failed: <its error's first line>.`, or `Failed: it did not start in time.` | Yes |
| A session is assigned to you | `Assigned to you by <name>.`, when someone else hands you a shared session | Yes |
| A pull request is opened | `Pull request opened: PR 12, <title>.` (not the one a session was started on) | Yes |
| A pull request is merged or closed | `Merged: PR 12, <title>.` or `Closed without merging: …` | Yes |
| A review of your pull request finished | `Review finished: approved.`, `changes requested`, `commented`, `approved, held until QA reports`, or `Review finished without a verdict.` | Yes |
| A QA run on your pull request finished | `QA passed: <its check's title>.`, `QA failed: …` or `QA finished: …` | Yes |
| A pull request's checks fail or pass | `Checks failing: 1 of 5 on PR 12, <title>.` or `Checks passing: all 5 on …` | No: each push runs them again, and claude usually watches them itself |
| A session is paused at its idle or lifetime limit | `Paused: idle 2 h. Resume it from the console.` | No: an idle pause follows a needs-you or done already heard |

**File → Notifications** switches each kind on or off, kept in the app's `settings.json` under `notifications`; the
badge counts whatever they say. A switched-off kind is still followed, so switching it on replays nothing. A session
with several changes in one read rings once, for the most pressing. The first read after a start notifies about nothing,
so opening the app does not replay every waiting session, nor does a session you are looking at. A pull request's review
decision is left out: Woodshed's own review rings from its review session, and a person's review reaches the session
that opened the pull request, whose next needs-you or done rings. Questions from Slack never count, and reviews and QA
runs only for their verdict. Signed out, the badge is cleared and what was seen forgotten, so signing in again starts
from a first read. A read that answers after Change console… (or a sign-in) is dropped: it can neither change the new
console's badge nor notify about the old one's sessions.

## What a page may do

Windows run with context isolation, the sandbox and no Node. The preload exposes one call, to the app's own setup
page and nothing else. The console's page may use the microphone (dictation), notifications and the clipboard; a
session app's page the clipboard and full screen; anything else is refused. No page may add a `<webview>`.

## Checks

`node --test desktop/*.test.mjs` (part of Woodshed's `node --test` run; a bare `desktop/` would run `main.mjs` too, which needs Electron) checks `links.mjs` and `attention.mjs`, which need no
Electron. To see the app itself, start a dev console (`bash scripts/devConsoleApp.sh start` from the repo's root) and
`npm start -- --console=localhost:7690`.
