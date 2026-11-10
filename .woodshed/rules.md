# Working on Woodshed

- Woodshed is dependency-free Node ESM with no build step. Read `CLAUDE.md` before changing anything, and the
  README of the folder you change.
- Its checks are `node --test $(git ls-files '*.test.mjs' '**/*.test.mjs')`, which CI runs, and for a change to
  the console's pages, the page itself: `node console/bin/devConsole.mjs`, then
  `http://localhost:7690/s/aaaa1111` in the browser. It serves made-up sessions, with no AWS, GitHub or Docker.
- Under `## Proof` in the pull request: the tests that ran, and for a page, what the page showed.
- This repo is public: every branch, commit, pull request and comment is too, from the first push. Keep out of them
  anything about the installation you run in: links to its console, Slack, Notion or other private repos, its log
  lines, account ids, domains and people's emails, and screenshots that show its data. Prove a change with the dev
  console's made-up sessions and with tests; where the proof needs the installation, say what you checked in words.
