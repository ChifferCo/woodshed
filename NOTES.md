# Woodshed in ten lines

- Woodshed is an open-source platform (AGPL-3.0, plain Node with no dependencies) that runs coding agents in cloud dev environments.
- It is for teams and developers who want Claude Code or Codex to take tasks end to end, side by side, without sharing a branch or database.
- Each task gets a session: a container with its own branch, its own copy of the databases and a running copy of the app.
- The console is the hub: it takes requests, starts and tracks every session, and lets a person watch or take over any of them.
- Work starts from GitHub (a `woodshed` label or a `/woodshed` comment), a Slack mention, or New session in the console.
- Providers run the sessions: `local` uses Docker on a laptop or server, `aws` uses one Fargate task per session with RDS and Secrets Manager.
- A repo describes itself in `.woodshed/project.yaml`: what to install, which env files to write, how to build its database and start its app.
- A session copies the database template, checks out a branch, does the work, checks it in the running app and opens a PR with proof.
- Later comments and review feedback go back to the same session; an idle session pushes its work, pauses, and resumes when needed.
- Sessions never hold cloud keys or production data; it also offers AI review and QA for any repo, a CLI and a desktop app.
