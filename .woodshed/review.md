# What a review of Woodshed looks for

Read by `.github/workflows/review.yml` from the branch a pull request merges into, on top of the review's own checks.
Woodshed is open-source, dependency-free Node ESM with no build step, and this repository is public.

- The rules in `CLAUDE.md`: a variable a session reads that is missing from `PER_SESSION_ENV`; a change to how a
  session starts with no proof from the real image; a visible change to the console that skips
  `console/designSystem/`.
- The folders' READMEs: `docs/reference.md` lists them.
- Security: anything that hands a session or a visitor another person's or another project's data, or a token a
  session should not hold.
- This repository is public: anything about an installation in the diff, the description or the commit messages
  (links to a private console, Slack, Notion or private repositories, log lines, account ids, emails, screenshots with
  data).
- The pull request title and commit messages: one line in Conventional Commits form, no trailers.
