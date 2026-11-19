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
- The pull request title: one line in Conventional Commits form, no trailers. Not the branch's own commits: pull
  requests are squash-merged under their title, so a `WIP:` checkpoint, a merge commit, a body or a trailer on the
  branch never reaches main. Do not block on them, comment on them, or ask for a history rewrite.
- Judge test coverage by the behavior a test exercises. When asking for a test as a merge condition, name the new
  behavior that lacks coverage and a wrong result the existing tests would accept. A second test through another
  layer, another permutation of a covered case, or a regression test for an optional concern is optional. A
  separate path that implements its own guard and could silently lose data deserves its own check.
- On a follow-up, read the author's fix and the tests together. Once they address the reported failure, close that
  finding. Apply the same likelihood and impact threshold to anything newly discovered in the fix. For example,
  restoring an older tab preference is a convenience issue. Restoring data belonging to another login is a
  security issue.
