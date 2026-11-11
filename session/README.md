# The session image

One image holds everything a session needs except the databases: Node 22.16,
`gh`, `tmux`, `ttyd`, Redis, the Claude Code CLI, the Playwright MCP with its
Chromium, and the repo at `/work/<repo name>` with its project file's dependency installs run. What an install keeps
under its dir is one layer; what it keeps under the home (`~/`, such as a test runner's own browser) is another, which
SOCI fetches only when a session uses it.

The code sits under `/opt` in the repo's own layout, so relative imports work the same as in a checkout:
`/opt/woodshed/session/` and `/opt/woodshed/shared/`. Nothing outside the image names those paths for long: the db-admin
task definition names `/opt/woodshed/session/dbAdmin.mjs`, and the status line the entrypoint writes into Claude's
settings at every start is each session's own (`session/settingsSync.mjs` keeps it out of what a person's sessions
share), so moving the code again needs only the task definition's apply after the image. A script started through a
symlink still runs (`shared/isMain.mjs`).

Build it from the repo root. The repo inside is cloned from GitHub at build
time, so both secrets are needed:

```bash
bash woodshed/session/stageDeps.sh woodshed-deps   # the installs' files; their manifest and the editor beside it
docker build -f woodshed/session/Dockerfile \
  --secret id=gh_token,env=GH_TOKEN \
  --secret id=install_env,src=install.env \
  --build-arg REPO=owner/name --build-arg REPO_DIR=/work/name \
  -t woodshed-session .
```

`install_env` is optional: a file of `NAME=value` lines, the installation's install secrets under the variables its
installs read (`REGISTRY_TOKEN='...'`), which `deps.sh` sources with `set -a` before the first install and logs by
name only. It is read as shell, so single-quote each value. Keep it
out of the build context and delete it after. It is about 1.35 GB compressed (about 4 GB unpacked), most of it what the installs keep and Chromium. The editor, openvscode-server, adds about 75 MB in a layer of its own, which SOCI fetches only in a
session whose editor is opened. It is left out when the project file's `editor` is `false`, which `stageDeps.sh` writes
to `woodshed-deps.editor` for the build. The deploy workflow's session job compresses it at gzip level 1, which takes a
fraction of the default level's time for a somewhat larger image.

The workflow builds it with a layer cache in ECR, the repository's
`:buildcache` tag, so most of a day's build is cached. Three build args decide
what is built again: `BASE_WEEK` the system packages, once a week;
`CLAUDE_DAY` the Claude CLI, once a day; and `BUILD_SHA` the checkout, every
run. The installs run in a stage of their own (`session/deps.sh install`), from the files `stageDeps.sh` copied out of
the build context and the manifest it wrote (`woodshed-deps.installs`), with a home of their own that is deleted
after, so their caches stay out. Only each install's `output` is kept, with a record of the files it was built from
(`/work/.woodshed-deps/<dir>/built-from`: each file's sha256). They run again only when those files or the manifest
change, and the build fails if the context's files are not the cloned commit's (`deps.sh check`). The cache tag counts
as one of the 5 images ECR keeps. It is built on `node:22-bookworm-slim`, with a compiler added back for native
modules an install builds.

Everything that is the same for every repository and changes at most weekly (the system packages, the CLIs and
Chromium) is the Dockerfile's `runtime` stage. `.github/workflows/sessionRuntime.yml` publishes it, for x86 and Arm, as
`ghcr.io/chifferco/woodshed-session-runtime:<commit>`, and `:latest` from main, when the Dockerfile changes and every
Monday. `--build-arg RUNTIME=ghcr.io/chifferco/woodshed-session-runtime:latest` builds a repository's image on it:
only the installs, the editor, Claude, the checkout and Woodshed's own files are built, which spares a small machine
most of the work. Claude stays out of the runtime because it changes daily: the installs are built on the runtime, so a
daily runtime would run them again every day. `install.sh` builds on the published runtime whenever it can pull it,
and builds the stage itself otherwise; without the build arg the stage is built here, as before. `:latest` trails a
change to the stage by the workflow's run, about the time the build takes.

## What a container does

`entrypoint.sh session` (the default):

1. Fetches the repo's default branch and creates `woodshed/<issue>-<session id>`, resumes that
   branch if it already exists on GitHub, or checks out a PR's head. The
   fetch runs alongside the session API calls for the owner's settings and
   the Claude home, so a start waits for the slowest of the three, not their
   sum. A saved home keeps the installed plugins' files
   (`~/.claude/plugins/cache`), a few MB. A plugin one lists without them, as
   a home saved before it kept them does, is installed again before claude
   starts (`session/missingPlugins.mjs`), logged as `Plugins installed again`.
   A private session also gets the default plugins in
   `session/defaultPlugins.mjs` (Slack's MCP, which posts as the session's
   owner) when its home has none of them and its owner has not turned one off,
   logged as `Default plugins installed` or `Default plugins already there`.
   Each is offered once (`~/.claude/woodshed-default-plugins.json` in the saved
   home), so one its owner uninstalls stays uninstalled.
   A shared session never gets them: it holds no integration token.
2. Writes the project file's env files from the base files it is given,
   with the shared services' addresses appended (see "The project file" in `../README.md`).
3. Starts its own Redis on 127.0.0.1, with redis-commander for Data ▾, when the
   project file's `env` or `envFiles` mention `REDIS_URL` (`startRedisIfUsed`), and
   logs `Redis started`; otherwise it logs `Redis not started (the project uses none…)`,
   and statusd reports `redis: false`, so Data ▾ has no Redis. A shared Redis
   would let one session's worker run another session's jobs when the app's queues
   have no key prefix. The image keeps `redis-server` either way.
4. Starts `claude --permission-mode auto` in tmux, through `session/bin/claude`, with the task as its first message and the rules
   in `prompt.md`, then the project's own (`.woodshed/rules.md` here), as a system prompt, then `ttyd` on 7681 and `statusd` on 7682. Auto mode runs
   routine work without asking and refuses risky actions; a session stuck on
   one shows as needing you. A shared session does not stop to ask: it follows
   the project's rules for working unattended (a repo's own pipeline may approve
   its plan or leave a `Needs a human:` comment on the PR), and at any other decision takes the
   recommended option and lists what it chose under `## Decisions` in the PR.
   One that cannot go on, such as one asked for a change the repo's rules put out of
   bounds, opens a draft PR saying why it stopped.
   A private session asks in its terminal. Claude's status line under the
   prompt is the dev box's (`session/statusline.sh`): path, branch, git state and context used. It also saves the
   plan's limits for the pane bar's **Plan** chip.
5. In the background, runs an install's `command` again only where its `files` differ from the image's record of
   them (`refreshDeps`, logged as `Dependency files changed since the image was built, reinstalling` with the dir),
   records them again, then writes `ready` or `failed: …` (the command and its dir) to `/tmp/woodshed-deps`. The
   project's notes have Claude wait for that file before it needs what the installs make, so a reinstall never
   delays the start. Nothing else runs before Claude: the dev servers
   start only when the task needs the app.

After each start step it tells the console's session API (`POST /progress`,
in the background, never waited on): `container`, `settings`, `home`,
`branch`, `databases`, `env` and `claude`. The console adds two of its own
from ECS: `machine` once the task has an address, and `pullStarted` when Fargate
began pulling the image, which its tick reads up to 10 seconds late. It keeps
their times as `startSteps`. While a
session starts, its page shows them as a checklist with a clock, and the rail
and the Shared page name the step it is on. The console also asks a starting
session's statusd every 2 seconds, rather than every 10, so the terminal
opens as soon as claude does.

`entrypoint.sh seed` migrates and seeds the next database template, as its own
user. Only the db-admin task runs it (`session/dbAdmin.mjs`), after emptying it.

## Environment

| Variable | Needed for | Notes |
| --- | --- | --- |
| `SESSION_ID` | session | Also ttyd's base path, `/term/<id>` |
| `SESSION_TOKEN` | session | Required. statusd wants `Authorization: Bearer <token>` |
| `TERMINAL_TOKEN` | session | ttyd's basic auth, `woodshed:<token>`. Defaults to `SESSION_TOKEN`; the console always sets its own, because ttyd hands its credential to every browser that opens the terminal |
| `WOODSHED_CONSOLE_URL` or `GH_TOKEN` | session | Where GitHub tokens come from, to push the branch and open the PR. With the GitHub App, the console's session API: `session/githubToken.sh` fetches an hour-long installation token from it, which git's credential helper and the `gh` wrapper (`/usr/local/bin/gh`) use. Without the App, one fixed `GH_TOKEN`. Never written to `.git/config` |
| `ANTHROPIC_API_KEY` | session | The team key, for Claude Code and the app: the docker launcher's env file only. The ECS task definition has none: claude then reaches the console's Anthropic proxy with `SESSION_TOKEN` as its key ("The Anthropic proxy" in `../console/README.md`, under My Woodshed), and the app uses whatever key its own env files hold, from their secrets or the owner's own lines |
| `SESSION_KIND` | session | `private` for a My Woodshed session. The entrypoint fetches its owner's settings from the session API (`POST /settings`). Their own lines for the env files and `~/.tmux.conf`, where they keep some, go after the env files' secrets and the image's tmux config, and the overrides still go on top. claude runs on their plan, directly: the `/settings` answer carries their Claude token, which becomes claude's `CLAUDE_CODE_OAUTH_TOKEN`, with no `ANTHROPIC_API_KEY` or `ANTHROPIC_BASE_URL`. That token is inference-only, so `/remote-control` needs `woodshed-login` (`claude auth login`) in that session; the login is per session, since refresh tokens rotate, and a restored home drops it |
| `WOODSHED_CLOUD_PROJECT_FILES_DIR` | session | The installation's folder of project files, set by the docker launcher to `/run/woodshed-project-files`, where it mounts the session's repo's file and the image's repo's read-only, when the installation has them (`../providers/local/README.md`). Read only for a repo with no `.woodshed/project.yaml` of its own on the checkout or default branch; the log's `Project file read` then says `from: installation` (`../docs/reference.md`, "The project file"). The db-admin task takes the same folder as `--project-files-dir`, never from its environment, and hands it to `entrypoint.sh seed` |
| `PROJECT_REPO` | session | `owner/name`, set by the console for a session on a project other than the installation's default (`WOODSHED_CLOUD_PROJECTS`). Every project runs in the default project's image for now, so the entrypoint clones that repo at start next to the image's checkout (`/work/<name>`, or `/work/<name>-project` when the image's checkout has that name), through the credential helper, and uses it as `REPO_DIR`; its log says `Cloning the project's repo` and `Project repo cloned`. The project's installs run then, as for any install the image has no record of. Unset, or the image's own repo, the image's checkout is used as before |
| `RESUME_SESSION` | session | Resume on a stopped private session: claude's conversation id, reopened with `claude --resume` from the restored Claude home, in place of a prompt |
| `AGENT` | session | `codex`: a private session runs OpenAI's Codex CLI (`session/bin/codex`) in place of claude, in the same tmux pane. It signs in with the owner's own Codex sign-in (`codexAuth` in the `/settings` answer, written to `~/.codex/auth.json`) or, with none, through the console's `/openai` proxy on the team key. The rules go in `~/.codex/AGENTS.md`; permissions map to codex's sandbox and approval flags (`codexFlags`). statusd reads its state from the pane alone (`codexState.mjs`: no hooks), and writes a refreshed ChatGPT login back at stop. A Codex conversation is not kept for Resume, and it has no plugins or plan chip |
| `MODEL`, `EFFORT`, `PERMISSION_MODE` | session | Optional: `claude --model`, `--effort` and `--permission-mode` (default `auto`; `default` passes none), from New session |
| `PGHOST`, `PGPORT` (5432 by default), `PGSSLMODE`, `PGSSLROOTCERT` | both | Postgres's server, set only where the installation hosts it (the postgres engine, `shared/databases/postgres.mjs`). A session needs it only when the project file's `databases` has a postgres one, and stops at start, naming it, without it. With no engine's server, a shared session asks the console for no databases |
| `WOODSHED_MONGO_HOST` | both | Mongo's server, as `host:port`, set only where the installation hosts it (`shared/databases/mongo.mjs`); `MONGODB_URI` is made from it and the console's user and password |
| `PGUSER`, `PGPASSWORD`, `PGDATABASE`; `MONGODB_URI` | both | Optional for a session: a database to use as it is (the docker launcher), `MONGODB_URI` whole. The ECS task definition has none, so the entrypoint asks the session API (`POST /settings`) for the databases the console made: a shared session's own, waiting while the console answers 503, or a private session's owner's, one user, password and name on every engine. Each engine then exports its own variables (`PGHOST` to `PGDATABASE`, `PGSSLMODE`, `PG_URL`; `MONGODB_URI`), which the project file maps to the app's names. That user may create more databases beside its own, such as its tests' |
| `WOODSHED_SERVICES`, and each variable it lists | both | The installation's shared services: the list of their variables, each set to its URL. An env file line needing one that is not set is a warning in the log, not a stop. db-admin passes them to the seed, and refuses a name not ending in `_URL` or `_ENDPOINT`, or a value that is not a plain http(s) URL |
| Each env file's secret, by its name in capitals (`app-env` is `APP_ENV`) | both | Whole base env files, one for each of the project file's `envFiles` with a `secret`. The overrides above are appended to them |
| `ISSUE`, `PR` or `PROMPT` | session | What to work on. `PROMPT` can be combined with the other two |
| `STARTED_BY`, `BRANCH` | session | The GitHub login credited in the PR body, and an explicit branch name |
| `SESSION_URL` | session | The session's page on the console (`WOODSHED_CLOUD_PUBLIC_URL`, or localhost for a local console), linked from the PR body. A console from before it sends none, and the line names Woodshed unlinked; `writeRules` drops it too when the project file says `consoleLinks: false` |
| Each install secret, by the variable the installation names for it, and `WOODSHED_INSTALL_SECRETS` | session | What the repo's installs read, such as a registry's token (`install_secrets` in Terraform), in the variable its tools read, as it arrives: a reinstall and claude's terminal have it there. `WOODSHED_INSTALL_SECRETS` lists those variables, space-separated. Only needed when an install runs again |
| `SESSION_MODE`, `ASKED_BY` | session | `ask` for a question from Slack: the default branch checked out detached, no databases, Redis, viewers or env files, the env files' secrets and each install secret `WOODSHED_INSTALL_SECRETS` lists unset before claude starts, and `session/ask.md` in place of `prompt.md`. `PROMPT` is the question and `ASKED_BY` the asker's Slack name |

## statusd

The console's only way into a running session besides the terminal:

| Route | Does |
| --- | --- |
| `GET /status` | `{ sessionId, state, editor, lastMessage, branch, head, prUrl, usage, planUsage, app, appServers }`. `planUsage` is the last reading of the owner's Claude plan the status line saved (`session/planUsage.mjs`): `{ asOf, fiveHour, sevenDay }`, each window `{ usedPercent, resetsAt }` or null, and null before Claude's first answer. `usage` is the container's, from its cgroup (v2 or v1, `session/usage.mjs`): `cpuPercent` (100 is one core busy, measured between two calls at least 2 s apart), `memoryBytes` without the inactive file cache, `memoryLimitBytes` and `cores`. `appServers` is `{ frontend, backend, frontendPort, backendPort }`: whether the frontend and the backend accept a connection on the project file's `app.frontendPort` and `app.backendPort` (or `APP_PORT` and `APP_API_PORT`), whoever started them, and those ports (null with no app). `app` is `running` when both do, `api-down` or `frontend-down` when one does, and otherwise `starting`, `stopping`, `failed` or `stopped` from the last **Start app** or **Stop app**. `lastMessage` is the last thing said in the transcript, `{ role, text, at }`. `state` is what Claude is doing, below |
| `POST /send` | `{"text": "..."}` typed into Claude's pane, then Enter |
| `POST /checkpoint` | Saves the Claude home, then commits anything uncommitted and pushes the branch, before a stop. An ask session only saves its Claude home |
| `* /redis/<id>/...` | Forwarded, without the token, to the session's redis-commander, which listens on 127.0.0.1:7683 only. The console's Redis button. 404 `this session has no Redis` when the project uses none |
| `* /__woodshed/code/...` | Forwarded, without the token, to openvscode-server (VS Code), which listens on 127.0.0.1:7688 only. Refused with 404 when the checkout's project file says `editor: false`; `/status`'s `editor` is true when it says `true` and the image has the editor. statusd starts it on the first request (`session/codeEditor.mjs`), logging to `/tmp/openvscode-server.log`; an ask session answers 404. Websockets too, with the token in `Authorization` like its other requests. The console sends these for `https://<id>.<app domain>/__woodshed/code/` (`console/editorProxy.mjs`): the console's **Editor ↗** |
| `POST /app/start` | Runs the project file's `app.start` in the background, logging to `/tmp/woodshed-app.log`. The console's Start app button |
| `POST /app/stop` | Runs the project file's `app.stop` in the background, to the same log, after interrupting a start still in progress. The console's Stop app button |
| `POST /upload?name=&pane=` | The body, one file of at most 25 MB, saved as `/tmp/uploads/<time>-<rand>-<name>`, and its path typed at the `agent` (claude) or `terminal` (the shell) pane's prompt with no Enter. A file pasted or dropped on a terminal (`session/terminalFiles.mjs`) |
| `GET /image?path=` | A picture a terminal path names, after the shed's `terminalImages.mjs`: png, jpg, gif or webp, its real path inside the repo, `/tmp/uploads` or Claude's scratchpad, symlinks resolved first. 404 otherwise |
| `GET`/`POST`/`PATCH`/`DELETE /shed-review/...` | The shed's own review page and server (`session/reviewShed/`), reached through the console's `/review` and `/reviews/claude-<id>/...`. |
| `GET /applog` | `{ logs: [{ name, text, bytes }] }`: the last 48 KB of `/tmp/woodshed-app.log` (`start`) and of each of the project file's `app.logs`. The App log tab |
| `POST /scroll` | `{"steps": -3, "pane": "agent"}`, a phone's swipe: wheel bytes to a pane that asked for the mouse (claude), copy mode for one that did not (the shell), at most 40 steps |
| `*` with `x-woodshed-app: Bearer <token>` | Any path, websockets too, forwarded without that header to the app's frontend, on the project file's `app.frontendPort` (`APP_PORT` overrides it). The token has its own header because the app's requests carry an `Authorization` of their own |

`state` comes from Claude's own hooks: `session/claudeHooks.json`, passed with
`--settings`, writes `/tmp/woodshed-claude-state.json` on each firing.

- `working`, `needs-you` or `done`, as the last hook says. Each Claude that
  opens resets it to `done` (`SessionStart`).
- `done` also when Esc ended the turn, which fires no hook: an interrupt record
  in the transcript after the last hook, or a prompt or finished tool call
  followed by 5 minutes with no transcript write and no tool call still open.
- `starting` while Claude opens: no hook yet and a shell on screen, for the
  container's first 2 minutes. The console holds typed messages and lists the
  session under Working.
- `not-running` when the pane holds a shell after that.

Before the first hook, Woodshed's `classifyPane` reads the pane instead.

## Why permissions are off

The container is the sandbox. It holds no production credentials, its GitHub
tokens last an hour, reach this one repo, read CI's results and rerun its jobs (Actions write) but cannot change workflows, and only
the console can reach its ports, with a per-session token on top. Sessions
start only for people with write access to the repo, which is private, so the
issue text Claude reads comes from org members. With prompts on, every
command would wait for someone to approve it.

Auto mode still has Claude's own check on each command, which can refuse a step
the session's rules ask for, such as adding a label to its pull
request. `session/claudeHooks.json` therefore allows every `gh pr` command
outright, so a session can open, edit, label, comment on and review its pull
request. `gh pr merge` still asks: pull requests land through the merge queue
once a person approves. So does any `gh pr -R` or `gh pr --repo` command, since
a rule matches the start of a command and `gh pr -R <repo> merge` would
otherwise get past it; a session only works on this repo and has no need for
either.

The same file runs `session/readyGate.mjs` before each Bash command and the
GitHub MCP's pull request calls. It refuses to open a pull request for review,
or to mark one ready (`gh pr create` without `--draft`, `gh pr ready`, or the
MCP with `draft` false), when the branch changes the project file's `app.paths`
and the app was never started in this session: none of its `app.logs` has
anything in it, and the session's saved home does not keep them. Claude reads why, and either
starts the app and proves the change, or opens a draft and posts a
`Needs a human:` comment tagging whoever started it (#26686 was opened ready
without the app ever running). Anything the hook cannot work out lets the call
through.

## Running one locally

On a dev box with the usual stack up, point the container at the host:

```bash
docker run -d --name ws-test --init --memory 6g --cpus 4 \
  --add-host=host.docker.internal:host-gateway \
  -p 127.0.0.1:17681:7681 -p 127.0.0.1:17682:7682 \
  -e SESSION_ID=ws-test -e SESSION_TOKEN=test-token \
  -e GH_TOKEN="$(gh auth token)" -e ANTHROPIC_API_KEY=... \
  -e PGHOST=host.docker.internal -e PGUSER=app_user -e PGPASSWORD=... -e PGDATABASE=app \
  -e MONGODB_URI=mongodb://host.docker.internal:27017/app \
  -e WOODSHED_SERVICES=S3_ENDPOINT -e S3_ENDPOINT=http://host.docker.internal:4566 \
  -e APP_ENV="$(cat app/.env)" \
  -e PROMPT="..." woodshed-session

curl -H 'Authorization: Bearer test-token' localhost:17682/status
# Terminal: http://localhost:17681/term/ws-test/  (user woodshed, password test-token)
# Editor: curl -H 'Authorization: Bearer test-token' localhost:17682/__woodshed/code/  (a browser needs the console in front)
```

`GH_TOKEN="$(gh auth token)"` makes the session push as you, so give it a
prompt that does not push unless that is what you want.
