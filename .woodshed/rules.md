# Working on Woodshed

- Woodshed is dependency-free Node ESM with no build step. Read `CLAUDE.md` before changing anything, and the
  README of the folder you change.
- Its checks are `node --test $(git ls-files '*.test.mjs' '**/*.test.mjs')`, which CI runs, and for a change to
  the console's pages, the page itself.
- This repo's app is the dev console, which serves made-up sessions with no AWS, GitHub or Docker. Start it with
  **Start app**, or yourself with `bash scripts/devConsoleApp.sh start` (`stop` stops it), not with a bare
  `node console/bin/devConsole.mjs`: the script's console also answers behind **Open app** and writes the log that
  tells a pull request the app was started. Check each page you change at `http://localhost:7690/s/aaaa1111` in the
  Playwright browser; people check it through **Open app**. A change to `console/public/` cannot open a pull request
  until the app has been started in the session. Files in `console/public/` are read on each request; after changing
  the console's server code (`console/*.mjs`), stop and start the app again.
- Under `## Proof` in the pull request: the tests that ran, and for a page, what the page showed.
- This repo is public: every branch, commit, pull request and comment is too, from the first push. Keep out of them
  anything about the installation you run in: links to its console, Slack, Notion or other private repos, its log
  lines, account ids, domains and people's emails, and screenshots that show its data. Prove a change with the dev
  console's made-up sessions and with tests; where the proof needs the installation, say what you checked in words.
- Commit messages and pull request titles are one line in Conventional Commits form, `type(scope): summary` (`feat`,
  `fix`, `docs`, `refactor`, `test`, `chore`, `ci` or `perf`), lowercase and imperative. No body unless a reader
  needs the why, and no trailers: no `Co-Authored-By`, no session links, no generated-by footers. Pull requests are
  squash-merged with their title as the commit message, so the title is what the history keeps.
- For a change people can see, such as a console page, show it under `## Proof` with screenshots: take them from the
  dev console's made-up sessions, never from a real installation, push them with
  `scripts/prAssets.sh <pr>-<slug> name.png=path …`, and embed the URLs it prints (`![name](url)`). Show before and
  after when the change alters something that exists.
