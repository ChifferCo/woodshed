# Woodshed reference

How Woodshed fits together, what a session can reach, and the project file, field by field. The
[README](../README.md) is the short version.

Claude sessions that run in containers, and a console that starts them, lists them, and gives each one a live
terminal and a review of its changes. A `woodshed` label or a `/woodshed …` comment on a GitHub issue or pull request
starts one, and so does **New session** in the console. Mentioning the bot in Slack with a question about the code
starts a short read-only one that answers in the thread.

Woodshed is for anyone to host. Where it runs is a **provider**. What an installation names (its domain, repository,
account and people) lives in that installation's own repo, never in this folder, such as in its `.woodshed/install/`.
The repo its sessions work on describes itself in `.woodshed/project.yaml` ("The project file", below). The examples
here use `woodshed.example.com` for an installation's domain.

## Folders

| Folder | What | More |
| --- | --- | --- |
| `console/` | The console: its pages, the fleet that starts and stops sessions, sign-in, Slack, databases | [console/README.md](../console/README.md) |
| `session/` | The session image: everything that runs inside a session's container | [session/README.md](../session/README.md) |
| `shared/` | Modules the console and the sessions both run, and other tools can embed: review, the project file's reader, the terminal and same-origin helpers | [shared/README.md](../shared/README.md) |
| `providers/` | Where Woodshed runs. `providers/console.mjs` picks one and starts the console on it | [providers/README.md](../providers/README.md), and "Providers", below |
| `test/` | Checks across the folders: `layout.test.mjs` | |
| `scripts/` | Tools for working on Woodshed itself: `prAssets.sh` attaches screenshots to a pull request | |

Imports go one way, and `test/layout.test.mjs` checks every one:
- `shared/` imports nothing outside itself.
- Nothing in `woodshed/` imports from outside it, so no installation's values are part of it.
- `console/` and `session/` reach a provider only through what is passed in, never by importing `providers/`.

`woodshed-check.yml` runs it, with every other test in this folder, on every change under `woodshed/`.

`CLAUDE.md` in this folder is for debugging: where every piece lives, what each secret is for, and fixes by symptom.
`docs/self-host.md` is for setting Woodshed up, in order, with a check after each step; `AGENTS.md` points a coding agent
to it or to `CLAUDE.md`, by what it was asked.

## Providers

A provider gives the console up to six things. Each one it lacks, the console runs without.

| | `aws` | `local` |
| --- | --- | --- |
| Session containers | Fargate tasks (`aws/ecsLauncher.mjs`) | Docker on the console's machine (`local/dockerLauncher.mjs`) |
| Secrets | Secrets Manager (`aws/secretStore.mjs`) | Files in the folder `WOODSHED_LOCAL_SECRETS_DIR` names, each sealed with the key in `WOODSHED_LOCAL_SECRETS_KEY_FILE` (`local/secretStore.mjs`) |
| Saved Claude homes | S3 (`aws/homeStore.mjs`) | Files in the folder `WOODSHED_LOCAL_HOMES_DIR` names (`local/homeStore.mjs`) |
| GitHub and Slack events | A Lambda URL into SQS (`aws/webhookQueue.mjs`), with GitHub's poll as the fallback | Received directly on `WOODSHED_LOCAL_WEBHOOK_PORT`, with the Lambda's own checks (`local/webhookReceiver.mjs`); without it, GitHub's poll only |
| Databases | Those `databases` in Terraform names: RDS Postgres, and the base box's Mongo, copied by a db-admin Fargate task (`aws/dbAdminRunner.mjs`) | The Postgres, and the Mongo, `WOODSHED_LOCAL_DB_*` names, copied by a db-admin container (`local/dbAdminRunner.mjs`); without them, the ones the session's environment names |
| The machine | The base box and the rest of `aws/terraform/` | Your own |

`WOODSHED_PROVIDER` (`aws` or `local`) picks one. Without it, `WOODSHED_CLOUD_LAUNCHER=ecs` means `aws`, and the
default `docker` means `local`. On a VM, such as one on Hetzner Cloud, the local provider runs as it is
(`providers/local/README.md`, "On a server your team reaches").

- **Try the console on your machine:** `node console/bin/devConsole.mjs`, then open `http://localhost:7690/s/aaaa1111`.
  It serves made-up sessions on the local provider, with no AWS, GitHub or Docker. A session on this repo runs it as
  its app, with `scripts/devConsoleApp.sh` (`.woodshed/project.yaml`).
- **Host it on AWS:** [providers/aws/README.md](../providers/aws/README.md) covers setting it up, updating it, what it
  costs, and removing it.
- **Work on Woodshed with Woodshed, on your machine:** [.woodshed/README.md](../.woodshed/README.md). The lightest
  setup there is: the console and session containers alone, with no databases, secrets folder or GitHub App.
- **Host it on one machine with Docker:** [providers/local/README.md](../providers/local/README.md) has the compose file
  for the shared services and the settings for the console beside it.

### Hosted mode

A service that hosts a console for an organization, with the organization's GitHub already connected and its own
sign-in in front, hands both to the console with two settings, each off unless set:

- `WOODSHED_CLOUD_GITHUB_BROKER_URL` and `WOODSHED_CLOUD_GITHUB_BROKER_TOKEN_FILE`: the console has no GitHub App of
  its own and asks the host's broker for every installation token, its own and its sessions', each narrowed as an
  App's would be. No `/setup/github`, no
  Connect GitHub, no webhooks (it polls). It refuses to start with `WOODSHED_CLOUD_GITHUB_APP_ID` set too.
- `WOODSHED_CLOUD_TRUSTED_IDENTITY_SECRET`: a proxy in front signs every request with an `X-Woodshed-Identity` header
  (an HMAC-SHA256 over the person's login, role and expiry), which is then the only sign-in, and required. The host
  says who is in, so there is no People list; its `owner`s are the console's admins.

"Hosted mode" in [console/README.md](../console/README.md) has the request, the header's format and what each changes.

## How it works

```
 GitHub issue or PR                    AWS account (us-east-1), its own VPC
 ──────────────────                    ─────────────────────────────────────────────
 "woodshed" label  ──┐  webhook ▶ Lambda URL ▶ SQS
 "/woodshed …"       │                    │ long-polled
  comment          ──┘                    ▼
                                       Base box (EC2, always on)
                                       ├─ console  ── starts and stops sessions,
                                       │              shows each one's terminal
                                       ├─ Caddy    ── HTTPS, your IP only
 Your browser ── https://<ip> ───────▶ ├─ Mongo, and the shared services
                                       └─ data disk (survives restarts)
                                              │ starts one task per session
                                              ▼
                                       Fargate session (one per issue)
                                       ├─ Claude Code, working on its own branch
                                       ├─ the repo's own app, to test in a browser
                                       └─ pushes the branch and opens a PR
                                              │
                                       RDS Postgres (shared by every session)
```

1. Someone with write access adds the `woodshed` label to an issue, or comments
   `/woodshed <request>`.
2. Within 30 seconds the console sees it, reacts with 👀, and starts a Fargate
   task from the session image.
3. The session checks out its branch (`woodshed/<issue>-<id>`, or the PR's
   branch), starts Claude with the issue as its task, and posts a comment with
   a link to it in the console.
4. Claude works like it does on a dev box: it changes code, runs the app, checks
   the change in a browser (a change to an agent tool, by asking the agent to
   call it in the app's chat; a bug fix, on the default branch too, to show the bug) and
   opens a PR with a `## Proof` section. Anything it could not prove is marked
   "not proven". The PR stays a draft unless the check can only run after
   merge, such as one that needs a new session image.
5. Another `/woodshed <text>` comment on the same issue is typed into that
   session. Open its terminal in the console to watch or take over.
6. A session pauses after an hour waiting for input, stops at 8 hours in all
   (both on the Console settings page),
   and stops once its pull request is posted to Slack (its project's channel from the Repos card of
   Console settings, else the Slack card's channel), or when someone presses
   Stop. It commits and pushes work in progress first and keeps its
   conversation and databases, so a later label or comment resumes it where it
   was. See "Session states" in `console/README.md`.

## Using it

- **Start:** the `woodshed` label on an issue, or `/woodshed <what to do>` on any issue or PR.
  These are **shared** sessions: everyone signed in sees and opens them.
- **Start one of your own:** **New session** on **My Woodshed** (`/`). It is
  **private**: nobody else can list it or open it, it runs on your own Claude
  token from **My settings** (avatar menu), and the console posts nothing on
  GitHub: no comment, no reaction. The session still pushes its branch and
  opens a PR, as every session does, and that PR is public to the repo.
  See "My Woodshed" in `console/README.md`. With a pull request or branch in **Work on** the
  prompt is optional: leave it empty and the session stays on its starting
  page until the machine is up, then moves to its Review tab with the analysis
  already running. Claude starts with no prompt, so it waits for you. The move
  happens only for a page that saw the session starting: opened once it is up,
  it stays on Agent, and the analysis starts when you open Review.
- **Talk to it:** `/woodshed <text>` on the same issue, or type in its terminal.
- **Watch:** the console lists every session; click one for its live terminal.
- **Review:** the session page's **Review** tab shows what its checkout
  changes against the default branch, uncommitted work included, with Claude's analysis
  of it, answers about any line or file, and a chat. A stopped session's tab
  shows what it pushed, as GitHub has it.
- **Try its app:** **Start app** on the session's rail card (in the pane bar
  while the rail is hidden), then **Open app**, at
  `https://<session>.woodshed.example.com`.
- **Edit its code:** **Editor ↗** in the session's pane bar opens VS Code on its checkout in a new tab, on the
  session's app name, started the first time someone opens it. The project file's `editor` turns it on and off. See "The editor" in `console/README.md`.
- **Ask a question:** mention the bot in any Slack channel it is in, e.g.
  `@woodshed how does a task decide to retry?`. A session reads the default branch and answers
  in the thread. See "Questions from Slack" in `console/README.md`.
- **Stop:** the Stop session button. Work in progress is pushed first.
- **Who can:** anyone with write access to the repo. Everyone else is ignored.
- **The console:** `https://woodshed.example.com`, with a Let's Encrypt
  certificate, open to the internet behind a GitHub sign-in. The bare IP
  answers too, with Caddy's own certificate, and moves to the name.
- **Its name:** the console calls itself Woodshed unless the installation names it: `WOODSHED_CLOUD_CONSOLE_NAME`
  (`console_name` in Terraform, a line in the local provider's `stack.env`), such as `Acme Woodshed`. The name is the
  pages' title, the sign-in page's heading, the installed app's name and what the console's GitHub comments call it.
  1 to 40 printable characters without `< > " '` or a backtick; the console uses Woodshed in place of any other value,
  and warns once. An app already installed from the browser keeps its old name until it is installed again.

## Who commits

| What | Whose name |
| --- | --- |
| Commits | `woodshed-bot <woodshed-bot@users.noreply.github.com>`; in a private session whose owner connected GitHub, the owner's name and noreply address |
| Pushes, PRs, comments, reactions | The installation's GitHub App, as `<slug>[bot]` ; a connected owner's private session pushes and opens PRs as them, "via `<slug>`" |
| The PR body | Names who started it and links the session's page: "Started by @<login> via [Woodshed](<console>/s/<id>)". When the repo's project file says `consoleLinks: false` (a public repo), the console is not linked: "Started by @<login> via Woodshed." |
| Attribution | Claude Code's own `Co-Authored-By` trailer and PR footer, unless the repo's `.claude/settings.json` turns them off (`attribution`), as this one does |

The only long-lived GitHub credential is the App's private key, in
`woodshed-cloud/github-app-key`, which only the console reads (it never touches
the disk) and never shows. The console
mints installation tokens from it: one hour, this repo only. Sessions ask the
console for one (`POST /github-token` on port 7691, with their `SESSION_TOKEN`)
whenever git or `gh` needs it, and get less than the console: contents, pull
requests and issues, no workflows.

## What a session can reach

- **Has:** what the repo's env files hold (its own Anthropic key, for one, in
  the env file's secret or the owner's own line), hour-long GitHub tokens from
  the console, and the installation's install secrets (such as a package registry's token), if it has any. A My Woodshed
  session also has its owner's own Claude token, for claude alone. Never the
  team key, and a shared session never has anyone's Claude token: its claude
  reaches Anthropic through the console, which adds them ("The Anthropic
  proxy", under My Woodshed in `console/README.md`).
- **Has to itself:** its databases, in Postgres and in Mongo where the installation runs them: a shared
  session's own, copied as it first starts and dropped once it is cleaned up, or a My Woodshed
  session's owner's (see "Databases" in `console/README.md`). Nothing one session does to its data
  reaches another. All of them share the installation's shared services, such as a fake S3.
- **Never has:** AWS credentials (sessions run with no task role), production
  data, or production integration tokens. See `CLAUDE.md` for the rules.

## The project file

A session reads what it needs from the repo it works on (its env files, dependency installs, databases and app) from
`.woodshed/project.yaml` at that repo's root, through `woodshed/shared/project.mjs`. It reads the
checkout's copy, so a branch can change it, and the default branch's when a branch predates the file. A repo with no file gets
an empty project: no dependency installs, env files, databases or app, and Woodshed's own rules alone.

**A project file the installation supplies.** To try Woodshed on a repo without committing a project file, the
installation can keep one for it: `WOODSHED_CLOUD_PROJECT_FILES_DIR` names a folder of them, one a repo, at
`<owner>/<name>.yaml` as GitHub names the repo (matched in any case). It is read only when the repo has no
`.woodshed/project.yaml` of its own, on the checkout or the default branch: once one is committed, it wins. Its `from`
is `installation`, beside `checkout`, `default branch` and `none`, in each log line that prints it (the entrypoint's
`Project file read`, the console's `projectFile: read`, the db-admin task's `Project read`, `stageDeps.sh`'s `project
file from`). It is read and refused as a repo's file is, with its path named in place of `.woodshed/project.yaml`. A
missing folder, or no file for the repo, is an empty project. The repo is told from the checkout's `origin` on GitHub.
Every reader gets it: `install.sh` (`WOODSHED_PROJECT_FILES_DIR`, which it saves in `stack.env` as this setting) for its
own reading and the image build's `stageDeps.sh`, the console, and, on the local provider, each session and db-admin
container, given the files they need read-only (`providers/local/README.md`). The AWS provider does not hand the files to
its tasks yet, so its console refuses to start with the setting, rather than read a file its sessions would not. The files hold no secrets, as a committed one holds none, and must be
readable by the session image's `node` user (uid 1000).

Only `version` must be written. A field that can be none (`null`, `[]`, `{}`, or `false` for `editor`) may be left
out, and is then none (`consoleLinks` left out is `true`): a file of `version: 1` alone is a repo with no dependencies, env files, databases or app. Inside
a section the same holds (`app.stop`, an env file's `secret`, `pullRequests.review.rerun`), while what the section
needs to work is required (`app.start`, its ports and `howToProve`; a database's `engine` and `dir`). A name
that is not a field (`envfiles`), a required field left out, an empty file or a `version` other than 1 stops the
session at start with the field named, and makes `readyGate` refuse to open a pull request until the branch fixes it.
Nothing required has a default: the ports, the database's folder and `howToProve` come from the file. `project.reference.yaml`
writes every field there is, with an example, and says which are required and what each one is when left out.

**Checking it.** `node <woodshed>/shared/project.mjs check`, run from the repo's root (or with `REPO_DIR` naming it),
reads the file as a session's start does, then checks it against the checkout it is in, so a repo needs no tests of its
own against Woodshed's code (`shared/projectCheck.mjs`). It reads files and asks git what it ignores and tracks, with no
network and no AWS. It prints a line for each part a session takes, or exits 1 with every problem at once, one line
each, naming its field:

- `pullRequests`: `review.workflow` and each suite's `workflow` are files there; each suite's `on:` section reads, since
  the console takes its path filters from it; and some job of the suite's workflow has check runs whose names start
  with its `jobs`: the job's `name`, or its id without one, a matrix's ` (…)` and a called workflow's ` / …` after it,
  and for a name with an expression, its text before the expression or a name quoted in it.
- `envFiles`: one entry a path and a secret; no secret is one of the console's own (`github-app-key` and the rest), or
  reaches the session in one of Woodshed's own variables (`gh-token` would be `GH_TOKEN`); each path is a file that git
  ignores and does not track, since it holds its secret's text, and not a folder, `.git/` or the project file; each line
  is `NAME=value` or a `#` comment; and a placeholder that is almost one (`{{ PGHOST }}`, `{{pgHost}}`), which would be written as it is,
  is refused. `env` the same: a variable name, not one of Woodshed's own, and no such placeholder.
- `dependencies.installs`: each `dir` is a folder, and each of its `files` without a glob is there.
- `databases`: each `dir` is a folder, its `paths` are there, `migrations` is a folder under one of them.
- `app`: neither port is below 1024 (the app runs as an unprivileged user) or one a session's own programs take
  (claude's and the shell's terminals, statusd, Redis and its viewer, the editor, the database viewers:
  `SESSION_PORTS` in `shared/reservedNames.mjs`); something in the checkout starts with each of its `paths`; and each
  `logs` file is under `~/` or in the repo.
- Every command (an install's, a database's `migrate` and `seed`, `app.start` and `app.stop`): the script it hands a
  shell, node or python, or runs by its path, is there, relative to the command's folder, unless git ignores it (an
  install's or a build's, as `node_modules/.bin/x`), and not outside the repo (`../setup.sh`); and `npm run <script>` (or
  `pnpm`, `yarn`) names a script of that folder's `package.json`. Each part of `a && b` is checked up to a `cd`, and a
  word the shell would expand (`$HOME`, `~`) is left alone.
- `rules` and `setup` are files there.

Beside what each part is, it prints `install variables`, the `${NAME}`s an install's `.npmrc` reads, each of which
must be an install secret of the installation's, and `from the session`, the variables the `env` and the env files'
lines use that neither the `env` nor the databases give, such as a shared service's URL. A repo runs it on its pull
requests with the reusable workflow `.github/workflows/project-check.yml` (`docs/self-host.md`, "Before any of them:
the project file"), whose inputs are `ref`, the Woodshed branch, tag or commit to take the check from (default `main`),
`repository` (default `ChifferCo/woodshed`) and `node-version` (default `22.16.0`).

**Changing the format.** While Woodshed is in beta the format stays `version: 1` and changes in place: a new
or changed field comes with every project file it applies to, in the same pull request, and with no reader for the old
shape. Each branch carries its own copy, and the image reads it, so after such a change an open branch from before it
stops at start until it merges the default branch, and a session on an image from before it refuses the new file until
the images are rebuilt. Once the format is stable, a change comes with the next `version` instead, and the reader
goes on reading the older one.

It is YAML, read by `woodshed/shared/yamlLite.mjs` so the session needs no dependency for it: mappings, lists, comments,
quoted and plain values, `|` and `>` block text, and one-line `[a, b]` and `{a: 1}` (so JSON reads too). Anchors,
aliases, tags, `?` keys, a plain value over more than one line and a repeated key are refused with their line. A value
with `: ` in it, or one starting with `{`, `` ` `` or `@`, needs quotes or block text. Each env value is a string:
quote a number (`PORT: '9000'`).

| Field | What reads it | What it is |
| --- | --- | --- |
| `version` | `project.mjs` | `1`, the format this version of Woodshed reads |
| `dependencies` | `stageDeps.sh` and the `Dockerfile` (the image workflow), `refreshDeps` (entrypoint), `session/deps.sh` | `installs[]`: each a `dir` in the repo; its `files` there, globs allowed within one folder (`packages/*/package.json`), which the image workflow stages for the build and whose change reinstalls at a session's start; the `command` that installs, one line run with bash in the dir; and its `output`, at least one folder it makes that the image keeps, under the dir or under the home as `~/...` (`[node_modules, ~/.cache/ms-playwright]`). Nothing else an install writes reaches the image. A secret an install reads, such as a registry's token, is not here: it is the installation's install secret, in the variable the repo's own tools read (below). Left out, or `{installs: []}`: nothing to install |
| `env` | `writeEnvFiles` | Variables exported for everything the session runs, after the databases' own (below), so a value can map one to the app's name: `DATABASE_HOST: '{{PGHOST}}'` |
| `envFiles[]` | `writeEnvFiles`, the db-admin task | `path` in the repo, `secret` (its base text, which reaches the task in the secret's name in capitals: `api-env` is `API_ENV`, and on My settings each person adds their own lines to it), and `lines` written after both. `{{NAME}}` is the variable's value; a line with `{{NAME?}}` is left out when it is empty. My settings lists the variables the `lines` write, read from this file on GitHub (`console/projectFile.mjs`) |
| `databases[]` | `writeEnvFiles`, `seed`/`migrate`, `dbAdmin.mjs`, the console, the image workflow | The databases each session gets its own copy of (see "Databases" below). Each names its `engine` (`postgres` or `mongo`, one database an engine) and the `dir` its commands run in; `migrate` and `seed` (`null` for none); `envFiles`, the secrets its commands need, each one an `envFiles` entry's `secret`; `paths`, what its template is built from, and `migrations`, the folder under them where a new file only migrates a copy (`null` for none); for `postgres`, `migrationsTable`, the `table` (or `schema.table`) and `column` where its migration tool records each migration it ran, which Restore a dump reads (`null` for none: nothing is said of a dump's migrations); `dump`, what Restore a dump's commands leave out: `skip`, tables whose rows (postgres) or collections (mongo), and for `postgres` the `extensions` the dump keeps (`null`: nothing left out); `user` and `name`, for a database the environment does not name (the docker launcher). `[]`: the db-admin task refuses to run, and sessions get none. The image workflow builds the templates again when `paths` changed since the last session build |
| `app` | statusd's Start app and Stop app, `readyGate.mjs` | `start` and `stop` commands, the `frontendPort` and `backendPort` statusd probes (the same port twice for an app that is one server, as Woodshed's own dev console is), `logs` (name to file, `~` and `{{CHECKOUT}}` filled in) for the App log tab and to tell the app was started, `paths` that count as an app change for `readyGate` (prefixes: write a folder with its `/`, as `web/`, or `web` also matches `webhooks.md`), and `howToProve`, its refusal's advice. `stop` may be `null`, and then Stop app does nothing, not even for a start still waiting on its health checks. statusd reads it once, when the session starts, so a change to it takes effect at the next start. `app: null`: no Start app, no ports probed, and no pull request refused |
| `editor` | `stageDeps.sh` (the image workflow), statusd | `true` or `false`: VS Code in the browser on the checkout (**Editor ↗**). The image workflow's `stageDeps.sh` writes the built commit's value to `woodshed-deps.editor`, and the `Dockerfile` leaves openvscode-server out of the image when it is `false`. statusd reads the checkout's copy once, at start: `false` refuses the editor and hides the button. Optional: left out, or no project file at all, it is `false` |
| `consoleLinks` | the console's GitHub comments, from the default branch; `writeRules` | `true` or `false`, default `true`. `false` keeps the installation's console address out of what is posted to the repo: the console's comments on its issues and pull requests (a session started, queued, resumed or failed, a refusal) and the session's link in the pull requests it opens (`{{VIA}}` reads `Woodshed`, unlinked). For a public repo. The console reads it with the project's other gates; when the file cannot be read, a comment on the installation's default project keeps its links and one on another project leaves them out |
| `githubAccess` | the session API's `/github-token`, from the default branch | `full` or `repo`, default `full`. A private session acts as its owner, whose connected GitHub token it gets. `full` hands it the token as GitHub issued it, reaching every repo the GitHub App is on that the owner can write to. `repo` has GitHub scope it to this repo and the session permissions (`githubUser.scopedTokenFor`; the App's token when GitHub makes none): for a repo whose content outsiders write, such as public issues, where a prompt injection should reach no other repo. Shared sessions and questions use the App's token either way. When the file cannot be read, a session on the installation's default project gets `full` and one on another project `repo`. `repo` is only as strong as the protection on the repo's default branch: the setting lives in the repo it guards, so someone who can change that branch's project file can switch it back to `full` |
| `rules`, `setup` | `writeRules` | The project's rules, after `prompt.md`, and its environment notes: inline in a shared session's rules, in `/tmp/woodshed-setup.md` for a private one |
| `pullRequests` | the console's pull request announcer, from the default branch's copy | What a pull request waits for before the console posts it (console/README.md, "Slack"). `review`: the code review, as the `author` and `heading` of its verdict (a pull request review whose body starts with `heading`), the `workflow` file that writes it, the `rerun` tag a commit carries to run it again (a session's rules tell it to end the last commit of each push with it once its PR is ready), and the `commentAuthor` of the PR comment the brief quotes its risk areas from (the one with the review folded under `<summary>` of the heading's words, `## Code review` giving `<summary>Code review</summary>`; `null` for none). `suites[]`: test suites that must pass, each a `name` to show, its `workflow` file, the `jobs` name its runs' jobs start with (a skipped matrix's one run, whose name is the whole expression, counts by the `'jobs` quoted in it), and its `rerun` tag. A pull request touching only paths the workflow's `on.pull_request` `paths-ignore` (or not its `paths`) names is not held for it: the console reads the workflow from the default branch. `qa`: a QA pass, as its `check` run's name (one whose title starts with `Waiting` is not a result yet), the `label` that asks for it, and the `author` and `heading` of its comment. `mergeRisk`: the `check` run that rates the merge, trusted only from a run of `review.workflow` on the head commit, so it needs `review`. Each is `null` (or `[]`) for none. `null`, or no `review` and no `suites`: the console posts a pull request once it is out of draft and none of its checks is running or failed |

## Using it on another repo

An installation works on one repo, and nothing in this folder names one. To set one up for your own repo:

- **The repo:** `WOODSHED_CLOUD_REPO=owner/name` for the console (it refuses to start without it), `github_repo` for
  Terraform, and the image workflow builds the repo it runs in.
- **The session image:** `session/Dockerfile` takes `REPO` and `REPO_DIR` (`/work/<name>`, `checkoutDir` in
  `shared/project.mjs`) as build arguments. The image workflow passes them and stages the files of the project file's
  `dependencies.installs` (`session/stageDeps.sh`), so the image runs those installs and no others, in any language.
  The optional build secret `install_env` is `NAME=value` lines, the install secrets below under their variables, which
  `deps.sh` exports before the installs; the image workflow writes it from repo secrets of the installation's choosing.
- **Install secrets:** what the installs read that is secret, such as a private registry's token. `install_secrets` in
  Terraform (`WOODSHED_CLOUD_INSTALL_SECRETS`, `secret=VARIABLE` pairs, for the console) maps each secret's name to the
  variable the repo's tools read it from (`{ "registry-token" = "REGISTRY_TOKEN" }`, the one its `.npmrc` names, say).
  Each is made by Terraform, set on the Secrets page, and reaches a session in that variable as it is, for a reinstall
  and claude's terminal alike; Woodshed names no variable and renames nothing. Sessions also get
  `WOODSHED_INSTALL_SECRETS`, the list of those variables, which an ask session unsets. A variable cannot be one of
  Woodshed's own (`WOODSHED_*`, `SESSION_ID`, `GH_TOKEN`, `PGHOST` and the rest, `SESSION_VARIABLES` in
  `shared/reservedNames.mjs`) or an env file's.
- **The env files:** `env_files` in Terraform (`WOODSHED_CLOUD_ENV_FILES` for the console) is each `envFiles` entry's `secret` with its `path`,
  and `database_env_secrets` is every `envFiles` of the project file's `databases`. Each secret is made by Terraform, set on the Secrets page and
  reaches a session as its name in capitals. A test checks this installation's tfvars against its project file.
- **The databases:** `databases` in Terraform names the engines the installation hosts, each on its own:
  `["postgres"]`, `["mongo"]`, `["postgres", "mongo"]` or `[]`. Each of the project file's `databases` needs its engine
  there ("Databases" below). An engine left out has no resources at all (RDS, Mongo on the base box, their secrets and
  security group rules), and with none there is no db-admin task either. With Postgres, `database_name` and
  `database_user` are the database and master user RDS starts with, which nothing else uses; a change replaces RDS.
- **The shared services:** `shared_services` in Terraform names the containers the base box runs for every session,
  such as a fake S3, each with its image, port and the variable its URL reaches sessions in, whose name ends in `_URL` or
  `_ENDPOINT`. Sessions and the db-admin
  task also get `WOODSHED_SERVICES`, the list of those variables. On the local provider they are a compose file of the
  installation's own, and its session env sets each variable and the list (`providers/local/README.md`).
- **The project file:** `.woodshed/project.yaml` in the repo, as above.

- **The default branch** is whatever the remote says (`HEAD`), read at each session's start into `DEFAULT_BRANCH`, so a repo
  may use `main`, `trunk` or any name. The deploy workflow's `if`s can read `github.event.repository.default_branch`
  (`providers/aws/README.md`, "The deploy workflow"); a `push` or `schedule` trigger cannot, so one that names a branch
  names the repo's own.
- **Which services a session needs** follow the project file: its `databases`, and Redis, started only when its
  `env` or `envFiles` mention `REDIS_URL` (`usesVariable` in `shared/project.mjs`; the start logs `Redis started` or
  `Redis not started`, and Data ▾ offers Redis only then). A shared service is the installation's: an env file line needing a variable that is not set
  is named in the start's log (`Env files written`, `unset:`), with a warning.
- **Exceptions** to the rules in `CLAUDE.md` belong to an installation, in its own `.woodshed/install/README.md`.

Still specific to one repo, and not yet settings:
- The db-admin task's drivers, borrowed from each database's `dir`'s `node_modules` (`pg`, and `mongoose` for Mongo),
  until the image ships its own.

## The review in another repo

`.github/workflows/review.yml` reviews Woodshed's own pull requests, and any repo can run the same review on its own by
calling it. A workflow of the repo's, with a `pull_request` trigger, calls it pinned to a commit:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
jobs:
  review:
    permissions: { contents: write, pull-requests: write, issues: read, id-token: write, checks: write }
    uses: <woodshed's repo>/.github/workflows/review.yml@<commit>
    with:
      tag: '[review]'
      rules: CLAUDE.md CONTRIBUTING.md
      instructions: .github/review.md
      risk-areas: .github/riskAreas.md
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

- `tag`: what the last commit's message carries to ask for a review (default `[woodshed-review]`).
- `rules`: the repo's rule files, separated by spaces (default `CLAUDE.md .woodshed/rules.md CONTRIBUTING.md`).
- `instructions`: a file saying what this repo wants a review to look for, added to the prompt (default
  `.woodshed/review.md`; none is fine).
- `risk-areas`: a file listing the changes this repo always counts as High merge risk (default
  `.woodshed/riskAreas.md`; none is fine).
- `allowed-bots`: bots whose pull requests are reviewed, such as the App an installation opens them as (default
  `woodshed-cloud`).

The review also rates the merge risk, Low, Medium or High, and posts it as a neutral `Merge risk` check on the reviewed
commit, which never blocks merging, and as a `merge risk: low`, `medium` or `high` label on the pull request. That is
why the caller grants `checks: write`. The label is only for people: anyone who can triage can change it, so the
console reads the check. To show it in the decision brief and
Slack, the project file's `pullRequests.mergeRisk.check` is `Merge risk`.

An input left empty takes its default. The rules, the instructions and the risk areas are read from the branch the pull request merges into, so a pull request cannot soften
its own review. The repo's Actions settings must allow GitHub Actions to create and approve pull requests, or the
approval is refused. On an approval, the review resolves its own threads that later commits made outdated, and those
whose comment the reviewer judged fixed by the head (a fix on other lines leaves the thread current), so a ruleset that
requires conversation resolution is not blocked by fixed findings; a person's thread, and one of the review's it did
not judge fixed, stay open. That runs in a job of its own, with no checkout and no Claude, because
resolving a thread needs `contents: write`, which the calling job grants and the reviewer's job never takes. A repo
that already calls the review adds `contents: write` to its calling job when it moves to a commit with this job: GitHub
refuses to start a called workflow whose job asks for more than the caller grants. To have the console wait for it, the project file's `pullRequests.review.workflow` names the
repo's calling workflow, the run GitHub reports.

## Databases

Each of the project file's `databases` is on an engine, a module in `shared/databases/` (`postgres.mjs`, `mongo.mjs`,
listed in `index.mjs`). The rest of Woodshed knows databases only through those modules: adding an engine, MySQL say,
is a module there with its entry in `ENGINES`, and its server in each provider (an instance in Terraform beside
`database.tf`, a `<engine>.yml` in `providers/local/`). A module says:

- **How the installation gives it:** the db-admin task's entryPoint flags (`--pg-host`, `--pg-root-user`, `--pg-ca`;
  `--mongo-host`) and its root password's variable (`PG_ROOT_PASSWORD`, `MONGO_ROOT_PASSWORD`), and which variable
  says a session's installation hosts it (`hostedIn`: `PGHOST`, `WOODSHED_MONGO_HOST`).
- **What the db-admin task does on it** (`admin`), as root: make a user, copy the template to a database, drop one,
  build the next template, swap it in and mark it ready with the commit it was built from (Postgres in the database's
  comment, Mongo in a collection of its own), and its upkeep after each run (Postgres closes databases every user could
  connect to; Mongo gives people's users their restore roles). Its driver comes from the database's `dir`.
- **The session's variables** (`sessionEnv`, and `seedEnv` for the template's commands), in the engine's own names,
  which a session exports and the project file maps to the app's in its `env` and env file lines: postgres gives
  libpq's `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` and `PGSSLMODE` (so `psql` connects with no setup)
  and `PG_URL`; mongo gives `MONGODB_URI`. Woodshed names no app's variable.
- **Its viewers** (pgweb at `/pg/<id>/`; mongo-express at `/mongo/<id>/`, and on a private session's restore copy at
  `/mongo-copy/<id>/`), which Data ▾, statusd and the console's proxy list from the modules.

Every owner has the same user name and password on each engine (`woodshed_<login>`, `woodshed__<session id>`), and
one record and one db-admin run cover them all (`console/databases.mjs`). The templates are built together, since one
database's seed may read another's: each database's `paths` decide keep, migrate or rebuild, the strongest of those is
every one's, and the commands run in the list's order, each database's `migrate` then its `seed`, with every database's
variables set. A copy waits until each engine's template is ready.

The installation says which engines it hosts: `databases` in Terraform (`WOODSHED_CLOUD_DATABASES` for the console), or
the local provider's `WOODSHED_LOCAL_DB_*`. A project file whose `databases` need an engine it does not host starts no
session: the console reads the default branch's file (`console/databaseGate.mjs`), says why on New session and My
settings, refuses the API's starts with the reason, and answers a label or `/woodshed` comment with it. A session started
from a branch whose own file differs stops at start with the same reason (`requireDatabases` in the entrypoint).

## License

Woodshed is copyright ChifferCo, Inc. ([COPYRIGHT](../COPYRIGHT)) and licensed under
[AGPL-3.0-only](../LICENSE-AGPL): version 3, not later versions. That covers every folder, `shared/` included, except
`ee/`, which holds paid features under a [commercial license](../ee/LICENSE). Contributions are accepted under the
[Contributor License Agreement](../CLA.md); [CONTRIBUTING.md](../CONTRIBUTING.md) says how to contribute.
