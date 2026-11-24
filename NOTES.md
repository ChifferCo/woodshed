# Notes on Woodshed's five largest source files

Counted by lines with `wc -l` over the files git tracks, leaving out tests, fixtures, lockfiles, Markdown and JSON.

## 1. `shared/review/page.mjs` (6342 lines)

The review page served at `/review?session=claude-<id>`: one big template literal (`REVIEW_HTML`) holding the HTML,
CSS and client script of the diff viewer, with its file tree, comments, verdicts and AI analysis panels. It is a page
of its own, apart from the session list, so the list's polling never resets a diff someone is reading, and it builds
every node with `createElement`/`textContent` because everything on it comes from pull requests or a model. It is part
of the review feature in `shared/review/`, which runs inside each session (`session/reviewShed/host.mjs`) and which the
console only forwards requests to (`console/reviewProxy.mjs`).

## 2. `console/server.mjs` (3258 lines)

The console's HTTP server and entry point: its header lists every route (the rail at `/` and `/all`, a session's page
at `/s/<id>`, the settings pages and the `/api/*` endpoints), and `createHandler` answers them. It also exports
`startConsole`, which `providers/console.mjs` calls with a provider (`aws` or `local`), and the websocket upgrades for
terminals, session apps and database tunnels. It is the hub of `console/`: it wires the fleet, sign-in, members,
secrets and the session API together, and serves the static pages from `console/public/`.

## 3. `shared/review/index.mjs` (3028 lines)

The public surface of the review feature: the only module of `shared/review/` that its hosts import. It creates and
removes a session's review (of a pull request, a branch, or the session's own worktree), starts the analysis and QA
jobs, and answers every `/reviews/*` route in `handleReviewRequest`, calling GitHub through `github.mjs`. Its host's
helpers come in as a `ctx` object rather than imports, and the README stresses that a review is not a thing of its own
but an aspect of a session, living and dying with it.

## 4. `console/fleet.mjs` (2996 lines)

The console's engine (`createFleet`): it turns GitHub labels and `/woodshed` comments into sessions, starts them when a
slot is free, keeps their status fresh by calling each session's statusd, and stops them at their idle and lifetime
limits. It also keeps stopped shared sessions resumable until their pull request has been closed for a few days, and
writes the comments sessions leave on GitHub (start, resume, refusal, failure). Everything it talks to (launcher,
GitHub, databases, Slack) is passed in, so its tests run it against fakes.

## 5. `console/public/session.js` (2954 lines)

The browser script behind the console's main page: the rail of sessions on the left and, on the right, the open
session's pane, with its Chat, TUI, Terminal and Review tabs and its buttons. `/`, `/all` and `/s/<id>` are all this
one page, which moves between them without reloading, keeps terminal iframes alive across refreshes and tab switches,
and turns into separate rail and pane screens on a phone. It refreshes every 5 seconds (every second while a session
starts) from the console's `/api/sessions`, and builds on the shared helpers in `public/common.js` and `shell.js`.
