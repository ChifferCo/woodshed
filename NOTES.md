# The five largest source files

Counted with `wc -l` over the files git tracks, code only: tests, fixtures, JSON, Markdown, CSS and HTML are left out.

1. **`shared/review/page.mjs`**, 6342 lines. The whole review page, served at `/review?session=claude-<id>`. It exports
   one template literal, `REVIEW_HTML`, which holds the page's HTML, its styles and its client script: the diff viewer,
   the analysis, line comments, verdicts and the ask panel, all built with DOM calls since every string on it is
   untrusted. `shared/review/index.mjs` imports it and serves it, inside a session through statusd's review routes
   (`session/reviewShed/host.mjs`).

2. **`console/server.mjs`**, 3258 lines. The console's HTTP server: every page (`/`, `/all`, `/s/<id>`, settings,
   secrets, events) and every `/api/...` route, with the list of routes written at its top. `createHandler` builds the
   request handler and `startConsole` builds a console from the environment and listens; `providers/console.mjs`
   calls `startConsole` once a provider is picked, and `console/installation.mjs` uses `createHandler`.

3. **`shared/review/index.mjs`**, 3028 lines. The review feature's public surface: a review is an aspect of a session,
   so this makes a session's worktree at a pull request's head (`createReviewSession`), runs the analysis, and answers
   the `/reviews/<session>/...` routes for comments, verdicts, renames and merges. It is loaded by the session's review
   host (`session/reviewShed/host.mjs`, which statusd mounts) and by the command line's review view
   (`cli/reviewView.mjs`).

4. **`console/fleet.mjs`**, 2996 lines. The console's engine: it turns GitHub labels and `/woodshed` comments into
   sessions, starts them when a slot is free, keeps their status fresh from statusd, stops them at their limits, and
   keeps stopped shared sessions resumable until their pull request has been closed for a while. Everything it talks
   to is passed in, so tests run it against fakes; `console/installation.mjs` builds it with `createFleet`, and the
   in-image test scripts under `providers/aws/bin/` and the local provider use it too.

5. **`console/public/session.js`**, 2954 lines. The browser script for the console's main page: the rail of sessions
   on the left and, on the right, a session's pane with its Chat, TUI, Terminal and Review tabs and its buttons. `/`
   (My Woodshed) and `/all` (Shared) are this same page, so it also navigates between them without reloading. The
   console serves it from `console/public/` as one of the page shell's scripts (`SHELL_SCRIPTS` in
   `console/server.mjs`), after `common.js`.
