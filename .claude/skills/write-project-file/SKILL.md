---
name: write-project-file
description: Write or fix a repository's .woodshed/project.yaml, the file that tells Woodshed sessions how to install the repo's dependencies, copy its databases, write its env files and start its app. Use when setting Woodshed up for a repo, when `shared/project.mjs check` fails, when a session stops at start with `.woodshed/project.yaml: …`, or when asked to add an app, a database or pull request gates to the project file.
---

# Write a repository's project file

The project file is the part of setting Woodshed up an agent does best: it is read from the repository, not asked of
the person. `project.reference.yaml` (at this checkout's root) writes every field with an example and says which are
required; `docs/reference.md`, "The project file", says what reads each one. Read both before writing.

`<woodshed>` below is this checkout; `<repo>` is the repository's checkout.

## 1. Read the repository

Look for, and note the file each answer came from:

- **Installs**: each package manager's lock file and the folder it is in (`package-lock.json`, `pnpm-lock.yaml`,
  `yarn.lock`, `requirements*.txt`, `poetry.lock`, `Gemfile.lock`, `go.sum`…), the install command, and what it makes
  (`node_modules`, `.venv`, `~/.cache/ms-playwright`). A private registry's token (`${NPM_TOKEN}` in `.npmrc`) is the
  installation's install secret, never a value in the file.
- **Databases**: docker compose services, env examples (`.env.example`), ORM config (Prisma, Drizzle, Knex, Alembic,
  Django, Rails, Mongoose), the migration and seed commands, the migrations folder, and the table the migration tool
  records runs in. Only `postgres` and `mongo` are engines; one database an engine.
- **Env files**: each file the app reads that git ignores, and which of its lines are secret (go in an env file's
  `secret`, set later on the console) and which are derived (go in its `lines`, from `{{PGHOST}}`, `{{MONGODB_URI}}`
  and the rest, `project.reference.yaml`'s `databases` comment).
- **The app**: how it starts in dev (one command that returns once it is up, or a script that backgrounds it), how it
  stops, its frontend and backend ports, its log files, and the folders whose change is an app change.
  A repo with more than one app (a second frontend, an admin site) writes `apps` instead of `app`: a list of the same
  fields, each with a `name` and an optional `label`, the first the default. Give each app its own log file.
- **Services in Docker**: a `supabase/` folder (Supabase local), or a compose file of services the app needs (a queue,
  a search engine, a Postgres the Woodshed databases do not stand in for). On the local provider, sessions use the
  machine's Docker unless `WOODSHED_SESSION_DOCKER=0`, so the app's `start` can bring them up there: `supabase start`,
  or `docker compose -p <name> up -d --wait`. Name them after the session (`$SESSION_ID`, in a compose project name or
  Supabase's `project_id`), since every session shares that Docker, and have `stop` take them down. `start` can check
  `WOODSHED_SESSION_DOCKER=1` and, without it, fail with what is missing (`this session has no Docker: supabase start
  needs it`) rather than a page that never loads. AWS sessions never have Docker: say so when the installation is on
  AWS.
- **CI**: the workflow that runs the tests on pull requests, and its job names, for `pullRequests.suites`.

If something cannot be told from the repository (which env values are secret, whether a seed needs a service it does
not run), leave it out and say so at the end, rather than guess.

## 2. Write the smallest file that works

Start with `version: 1` and add only the sections the repository needs, copying their shape from
`project.reference.yaml`. Every field you leave out is "none"; a misspelt one is refused, never ignored. Things the
file never holds: a secret's value, a production URL, anything about the installation (its domain, its people).

`app.howToProve` is the advice a session gets when it tries to open a pull request without starting the app: write
the real steps (the command, the URL, what to check), as this repository's own `.woodshed/project.yaml` does.

## 3. Check it until it passes

From `<repo>`'s root:

```bash
node <woodshed>/shared/project.mjs check
```

or from anywhere, such as this checkout, with `REPO_DIR=<repo> node <woodshed>/shared/project.mjs check`. Without
either, it checks whichever repository the shell is in, which from here is Woodshed's own file.

It reads the file as a session's start does and checks it against the checkout: a script, folder, workflow, port or
env file it names that is not there, or an env file git would not ignore, fails it with the field named. Fix each line
it prints and run it again. **Done when** it exits 0 with a line for each part you meant (installs, databases, env
files, app, pull requests). Read its `install variables` and `from the session` lines: each is something the
installation must provide, so list them for the person.

## 4. Hand it over

- Show the person the file, and for each section, the file in their repository it came from.
- They commit it to the default branch (a **You** step: it is their repository). The session image is built from the
  default branch, so a file on another branch is not read by the install.
- Offer the CI check from `docs/self-host.md`, "Before any of them: the project file", step 4: a workflow of the
  repository's own calling Woodshed's reusable `project-check.yml`.
- List what the installation must still provide: each env file `secret` (set on the console's Secrets & webhooks
  page), each install variable, each `from the session` variable, and Docker when the app's `start` needs it.

## When a session refused the file

A session that stops at start with `.woodshed/project.yaml: …`, or `readyGate` refusing `gh pr create` with `Not
opened: .woodshed/project.yaml: …`, quotes the same message `check` prints. Run `check` on that branch's checkout and
fix what it names; `CLAUDE.md`, "By symptom", has the entry for each.
