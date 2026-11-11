# For coding agents

Woodshed runs coding agents in cloud dev environments: a console, and a container per task with its own branch,
databases and running app. What you were asked decides what to read:

- **Setting Woodshed up** for someone's repository, on their machine, a server or AWS: `docs/self-host.md`. It is a
  runbook with a check after each step, and it marks the steps only the person can do (a browser, an account, a
  token). Stop at those and say what to do. The repository's `.woodshed/project.yaml` is the part you write:
  `project.reference.yaml` has every field, and `node shared/project.mjs check`, run from that repository, checks it.
- **Something in an installation is not working**: `CLAUDE.md`, "By symptom", lists what the console logs for each.
- **Changing Woodshed**: `CLAUDE.md` first, for its rules on secrets and the design system, then the README of the
  folder you change. It is plain Node 22 with no dependencies and no build step; the checks are
  `node --test $(git ls-files '*.test.mjs' '**/*.test.mjs')`, and `node console/bin/devConsole.mjs` for a console page.

Never print a secret's value, and never put production credentials or a team-wide token in a session (`CLAUDE.md`,
"Rules").
