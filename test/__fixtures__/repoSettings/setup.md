Environment notes:

- The api's dependencies are installed into `api/node_modules` by the image; wait for `/tmp/woodshed-deps` before running tests.
- Postgres and Mongo are the session's own copies: `make db-reset` restores the template.
- Playwright's Chromium is in `~/.cache/ms-playwright`.
