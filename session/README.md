# The session image

One image holds everything a session needs except the databases: Node 22.16,
`gh`, `tmux`, `ttyd`, Redis, Postgres 16's client (`psql`, `pg_dump`, from PostgreSQL's apt repository: the major
the installations host, `PG_CLIENT_MAJOR` in the `Dockerfile`), the Claude Code CLI, the Playwright MCP with its
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
   home), so one its owner uninstalls stays uninstalled. The plugins its owner
   installed for the whole home elsewhere (the shared settings' plugin items) are
   installed the same way, once each (`session/syncedPlugins.mjs`), logged as
   `Plugins from your other sessions installed`. The owner's own lines for
   `~/.gitconfig`, `~/.inputrc` and `~/.bash_aliases` from My settings are
   written after the image's (`writeOwnDotfiles`).
   A shared session never gets them: it holds no integration token.
2. Writes the project file's env files in layers, later ones winning (`shared/repoSettings.mjs`): each file's
   `defaults` from the project file, the installation's values, a private session's owner's own lines, then the
   file's `overrides` with the databases' and shared services' addresses (see "The project file" in
   `../docs/reference.md`). The installation's values and the owner's come from the console's repo settings
   (`POST /repo-settings`, console/README.md "Repo settings"), which every session but an ask fetches with the owner's
   settings (`fetchRepoSettings`). Only a private session's answer has an owner's layer: a shared or QA session's has
   none, and the session drops one it is handed without `personalFor`. The answer waits in
   `~/.config/woodshed/repo-settings.json`, readable by the session's user alone and outside the saved `~/.claude`,
   until the env files and the rules are written, then is deleted. A layer with no value there is empty. Env files
   that name one secret share its key, so each of their paths is written the key's values, with its own defaults and
   overrides. A console from before the route answers 404: the log says `Repo settings not offered by the console, the
   env files get the repo's defaults alone`. Any other refusal stops the start (`could not get the repo settings from the
   console (status …)`), after the retries a 503 gets. The log says `Repo settings fetched` with each layer's keys and
   sizes, and `Env files written` with each file's layers, sizes and the keys the session's wiring replaced
   (`replaced by the session`; files that share a key are one entry, `api/.env, worker/.env from app-env (…)`, with the
   values' sizes once and each path's layers), and a line for repo settings no env file of the checkout has a key for:
   never a value.
3. Starts its own Redis on 127.0.0.1, with redis-commander for Open ▾, when the
   project file's `env` or `envFiles` mention `REDIS_URL` (`startRedisIfUsed`), and
   logs `Redis started`; otherwise it logs `Redis not started (the project uses none…)`,
   and statusd reports `redis: false`, so Open ▾ has no Redis. A shared Redis
   would let one session's worker run another session's jobs when the app's queues
   have no key prefix. The image keeps `redis-server` either way.
   It also starts its databases' viewers (pgweb, mongo-express) on loopback, on the databases the console made it or
   the ones its environment names, and statusd reports whose (`viewers`, the engines), so Open ▾ offers those.
4. Starts `claude --permission-mode auto` in tmux, through `session/bin/claude`, inline (never Claude Code's full-screen
   renderer, nor codex's alternate screen, so the conversation stays in tmux's history and the browser's scrollback), with the task as its first message and the rules
   in `prompt.md` with `appAddress.md` (the app's `https://<SESSION_ID>.<SESSION_APP_DOMAIN>/` address, since the person
   cannot reach the session's localhost) and, for a repo whose project file has no app or that has none, `noApp.md`
   (what Set up app does, for claude to offer it in a private session, and in a shared one to run the app for its proof without committing the file;
   `appRules`), then the project's own (`.woodshed/rules.md` here), then the installation's instructions for the
   repo and the private session's owner's own from the repo settings, with which of them win (`Instructions added to
   the rules` in the log, with their sizes), as a system prompt, then `ttyd` on 7681 and `statusd` on 7682. A private
   session whose owner picked Herdr on My settings (Agent terminal, the `/settings` answer's `terminal`, logged in
   `Owner's settings fetched`) runs claude or codex in Herdr instead of tmux: the image's pinned herdr-core
   (`hc`, `HERDR_CORE_VERSION` in the `Dockerfile`) starts a core, a kept shell terminal named `claude` in the checkout,
   and the agent's command typed into it (`Herdr started` in the log; `WARNING: Herdr did not start, the agent runs in
   tmux` with `hc`'s last line otherwise, and `/tmp/woodshed-herdr.log` has the rest). The TUI tab's ttyd then runs
   `hc attach claude`. A shared session, a question, a review and a QA run use tmux either way, and so does the
   Terminal tab. A private session started or resumed with `woodshed session new --herdr --parent` (or `session herdr
   <id> --parent`; `WOODSHED_HERDR_PARENT=1`) runs in Herdr whatever its owner picked, and leaves the `claude` terminal
   to its owner's Herdr, which makes it from a terminal of theirs with `hc run --on`, its parent (cli/README.md, "The
   session's agent as a child of a terminal here"): hc gives a terminal its parent only as it starts, and only from the
   caller's side. It writes `/tmp/woodshed-agent-terminal.json` with the checkout, starts statusd (the tunnel the
   terminal comes through), and types the agent in once the terminal is there (`Agent's terminal made by its parent`
   with the parent), or after 5 minutes makes it itself with none (`WARNING: no parent made the agent's terminal`). The choice
   reaches statusd, claude and `woodshed-login` as `WOODSHED_TERMINAL` (`tmux` or `herdr`); `Claude started` logs it as
   `terminal`. Auto mode runs
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
   records them again, then writes `ready` or `failed: …` (the command and its dir) to `/tmp/woodshed-deps`. A Grok Build or OpenCode session (or an Antigravity CLI one on its owner's own login) runs none of them: the branch's command could read its owner's own sign-in, so the file says `skipped: …` with each changed install's command and dir, for the agent to run. The
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
and the Shared page name the step it is on. Its last row, Connecting to the
session, is the console's own: the wait from claude opening until the console
reads the session's statusd, which it can only once the launcher has answered
with the session's address. The console also asks a starting
session's statusd every 2 seconds, rather than every 10, so the terminal
opens as soon as claude does.

`entrypoint.sh seed` migrates and seeds the next database template, as its own
user. Only the db-admin task runs it (`session/dbAdmin.mjs`), after emptying it. It writes the env files as a shared
session does, from the repo settings db-admin read for the databases' env files (`WOODSHED_SEED_REPO_SETTINGS`).
`entrypoint.sh migrate` runs only the `migrate` commands, on a copy of the current template, and `entrypoint.sh
migrate-own` runs them on an owner's own databases, as the owner's user: the task's `migrate <login>` and
`migrate-session <session id>`, for a host that changed an owner's databases outside the task and wants the image's
schema on them. Its log ends `Owner's databases migrated`, never `Templates ready for the swap`.

## Environment

| Variable | Needed for | Notes |
| --- | --- | --- |
| `SESSION_ID` | session | Also ttyd's base path, `/term/<id>` |
| `SESSION_TOKEN` | session | Required. statusd wants `Authorization: Bearer <token>` |
| `TERMINAL_TOKEN` | session | ttyd's basic auth, `woodshed:<token>`. Defaults to `SESSION_TOKEN`; the console always sets its own, because ttyd hands its credential to every browser that opens the terminal |
| `WOODSHED_CONSOLE_URL` or `GH_TOKEN` | session | Where GitHub tokens come from, to push the branch and open the PR. With the GitHub App, the console's session API: `session/githubToken.sh` fetches an hour-long installation token from it, which git's credential helper and the `gh` wrapper (`/usr/local/bin/gh`) use. Without the App, one fixed `GH_TOKEN`. Never written to `.git/config` |
| `ANTHROPIC_API_KEY` | session | The team key, for Claude Code and the app: the docker launcher's env file only. The ECS task definition has none: claude then reaches the console's Anthropic proxy with `SESSION_TOKEN` as its key ("The Anthropic proxy" in `../console/README.md`, under My Woodshed), and the app uses whatever key its own env files hold, from the repo settings |
| `SESSION_APP_DOMAIN` | session | The domain the console's app proxy serves session apps under (`WOODSHED_APP_DOMAIN`, `apps.<domain>` on AWS), so the session's app is `<SESSION_ID>.<SESSION_APP_DOMAIN>`, which `appRules` gives claude (`appAddress.md`). Unset when the console has session apps off. Woodshed's own app (`console/bin/devConsole.mjs`) lets in that name and loopback alone; a console from before it sends none, and the dev console then lets in loopback alone, with a warning |
| `WOODSHED_SESSION_DOCKER`, `DOCKER_HOST` | session | `1` and `unix:///var/run/docker.sock` when the docker launcher gave the session the machine's Docker socket, `own` and the same socket when it runs the session under Sysbox with a daemon of its own (`../providers/local/README.md`, "Docker in a session"); the launcher alone sets them, and drops a `WOODSHED_SESSION_DOCKER` from the session env file. With `1`, `writeRules` adds `hostDocker.md` to claude's rules, and `startDockerPorts` runs `dockerPorts.mjs`, which forwards each port the machine's containers publish to the same port on the session's 127.0.0.1 (`/tmp/woodshed-docker-ports.log`). With `own`, the launcher runs `ownDocker.sh` as root in place of the entrypoint: it starts `dockerd` (`/tmp/woodshed-dockerd.log`), waits for it, and runs the entrypoint as `node`; `writeRules` adds `ownDocker.md` |
| `SESSION_KIND` | session | `private` for a My Woodshed session. The entrypoint fetches its owner's settings from the session API (`POST /settings`). Their own lines for the env files (the repo settings' personal layer, from My settings' Repo settings card) and `~/.tmux.conf` (the `/settings` answer's `files`), where they keep some, go after the installation's text and the image's tmux config, and the overrides still go on top. Their own instructions for the repo go after the installation's in the rules. Their own whole files for the session's repo (`ownFiles`, from that repo's tab on Repo settings) are written after the env files by `session/ownFiles.mjs`, only where git ignores the path and does not track it (`Own files written` in the log, or a `WARNING` naming each one skipped and why). claude runs on their plan, directly: the `/settings` answer carries their Claude token, which becomes claude's `CLAUDE_CODE_OAUTH_TOKEN`, with no `ANTHROPIC_API_KEY` or `ANTHROPIC_BASE_URL`. That token is inference-only, so `/remote-control` needs `/woodshed:remote-control` (the `session/claudePlugin` command, passed with `--plugin-dir`, which runs `woodshed-login`: `claude auth login` in a tmux session of its own, the code pasted in the chat, then claude reopened with `--resume`) in that session; the login is per session, since refresh tokens rotate, and a restored home drops it |
| `WOODSHED_PROJECT_FILES_DIR` | session | The installation's folder of project files, set by the docker launcher to `/run/woodshed-project-files`, where it mounts the session's repo's file and the image's repo's read-only, when the installation has them (`../providers/local/README.md`). Read only for a repo with no `.woodshed/project.yaml` of its own on the checkout or default branch, or one whose own file Woodshed cannot read; the log's `Project file read` then says `from: installation` (`../docs/reference.md`, "The project file"). The db-admin task takes the same folder as `--project-files-dir`, never from its environment, and hands it to `entrypoint.sh seed` |
| `PROJECT_REPO` | session | `owner/name`, set by the console for a session on a project other than the installation's default (`WOODSHED_PROJECTS`). Every project runs in the default project's image for now, so the entrypoint clones that repo at start next to the image's checkout (`/work/<name>`, or `/work/<name>-project` when the image's checkout has that name), through the credential helper, and uses it as `REPO_DIR`; its log says `Cloning the project's repo` and `Project repo cloned`. The project's installs run then, as for any install the image has no record of. Unset, or the image's own repo, the image's checkout is used as before. The console also sets it for the default project when that is a repo an admin added on Console settings (a console that started with no repo), since no image holds its checkout. An image built with no repo (`REPO` empty in the Dockerfile, as install.sh builds `woodshed-session:generic` for a local install that names none) has no checkout: every session clones its repo, keeps the secrets the console handed it, and runs its installs at start; one with no `PROJECT_REPO` stops with `the session image has no checkout and the console named no repo` |
| `RESUME_SESSION` | session | Resume on a stopped private session: claude's conversation id, reopened with `claude --resume` from the restored Claude home, in place of a prompt |
| `AGENT` | session | `codex`: a private session runs OpenAI's Codex CLI (`session/bin/codex`) in place of claude, in the same tmux pane. It signs in with the owner's own Codex sign-in (`codexAuth` in the `/settings` answer, written to `~/.codex/auth.json`) or, with none, through the console's `/openai` proxy on the team key. The rules go in `~/.codex/AGENTS.override.md`, which codex reads in place of `AGENTS.md`, followed by the owner's own `AGENTS.md` (synced, `settingsSync.mjs`); the checkout is trusted in the owner's synced `config.toml` (`shared/codexConfig.mjs`); permissions map to codex's sandbox and approval flags (`codexFlags`). statusd reads its state from the pane alone (`codexState.mjs`: no hooks), and writes a refreshed ChatGPT login back at stop. A Codex conversation is not kept for Resume, and it has no plugins. Its Plan chip reads the rate limits from local Codex rollout events (`codexPlanUsage.mjs`); no chip appears when Codex reports no plan limits |
| `AGENT` | session | `grok` or `opencode` (shared/agents.cjs): a private session runs Grok Build (`grok`) or OpenCode (`opencode`) in the same pane, through `session/bin/<command>`, installed and pinned in the image's runtime stage (Grok's raw binary by sha256, OpenCode from npm), with their updaters off. The primary agent uses its owner's own sign-in: `agentAuth` in the `/settings` answer (the start stops at `the console sent no sign-in`), kept as given in `~/.config/woodshed/agent-auth` (0600). Grok: an xAI key the wrapper hands grok alone in `XAI_API_KEY`, or the login `grok login` saved, written to `~/.grok/auth.json`; `config.toml` turns off its updater, telemetry and what it takes from `~/.claude` (MCP servers, hooks), `trusted_folders.toml` trusts the checkout, the rules go in `~/.grok/rules/woodshed.md`, and its hooks, in the image's root-owned `/etc/grok/requirements.toml` (`session/grokRequirements.toml`), run `hookState.mjs` as claude's do. OpenCode: the `auth.json` of `opencode auth login`, written to `~/.local/share/opencode/auth.json`; its config turns off its updater and sharing and gives the effort as its agents' `variant`; the rules go in `~/.config/opencode/AGENTS.md`. Flags per mode: `grokFlags`, `opencodeFlags`. Like codex: no MCP servers, no plugins, no Resume of their conversation. At stop statusd sends a login it refreshed back to `POST /agent-auth` (`statusd: <agent> sign-in sent back`), since their refresh tokens work once. The Review tab's analysis runs on claude in their sessions. A review session runs them too, when the default includes them or its author picked them (`REVIEW_AGENTS`, `session/review.sh`), but never on a sign-in of its own: grok gets the session's token as `XAI_API_KEY` and `GROK_MODELS_BASE_URL` at the console's `/grok/v1`, in a home of the review's own (`REVIEW_GROK_HOME`) that prefers that key, trusts no folder (so the pull request's own rules files are not read into its first request: the base branch's are in its prompt), and keeps the image's `/etc/grok/requirements.toml`; opencode gets an `auth.json` holding the token as `REVIEW_OPENCODE_PROVIDER`'s key and a config pointing that provider alone at `/opencode/<provider>/v1`, with no plugin (`--pure`). The console's `reviewAgentProxy.mjs` swaps the token for the author's sign-in. Each runs headless with its own approvals (`grok -p --always-approve --no-memory --disable-web-search --disallowed-tools x_search`, `opencode run --auto`), as codex's review does: the container is the sandbox. OpenCode never reads the repo's own `opencode.json` or `.opencode/` (`OPENCODE_DISABLE_PROJECT_CONFIG` in `session/bin/opencode`), where a `baseURL` could send the owner's key elsewhere; the repo's `AGENTS.md`, or `CLAUDE.md` where it has none, is copied after the rules into OpenCode's own `AGENTS.md` at start instead, never through a symlink (`WARNING: the repo's AGENTS.md is a symlink, so OpenCode does not get it`). Grok Build runs no MCP server, a repo's own `.grok/config.toml`, `.mcp.json` or `.cursor/mcp.json` included: the image's root-owned `/etc/grok/requirements.toml` (`session/grokRequirements.toml`) locks them all down, and `grok inspect` lists each as `BLOCKED`. Grok reads a repo's `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md` and rules folders (`.grok/rules`, `.claude/rules`, `.cursor/rules`) into its first request by itself, so a start where one of them, or a link in a rules folder, points outside the checkout stops with `points outside the checkout` (`refuseRulesOutsideCheckout`): such a link could name the owner's sign-in. The project file's own `rules` and `setup` files are never read through a link out of the checkout, for any agent (`readRepoFile`: `is a link to a file outside the checkout, which is never read`, and the start stops). Grok Build's Plan chip reads the allowance it logs as `billing: fetched credits config` in `~/.grok/logs/unified.jsonl` (`grokPlanUsage.mjs`); no chip when that line has no percent. OpenCode reports none. |
| `AGENT` | session | `antigravity` (shared/agents.cjs): a private session runs Antigravity CLI in the same pane. It is the one agent with two credentials. It is pinned in the image by version and sha512 (the release manifest's, checked as Google's installer checks it, installed as `/usr/local/bin/agy`, recorded in `/usr/local/share/woodshed-agents`), runs through `session/bin/agy` (`AGY_CLI_DISABLE_AUTO_UPDATE=true`, which must be exactly `true`; `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=true`) and keeps everything under `~/.gemini`. **The team's Gemini key** (when the owner saved no Google login; only in a My Woodshed session, since fleet refuses Antigravity CLI without an owner): the wrapper gives agy the session's own token as `GEMINI_API_KEY` and `$WOODSHED_CONSOLE_URL/gemini` as `GOOGLE_GEMINI_BASE_URL` (`WOODSHED_AGY_AUTH=key`), and the run's settings file says `modelProvider: gemini`; agy then sends `POST /v1beta/models/<model>:streamGenerateContent?alt=sse` with `x-goog-api-key: <the session's token>` (also for a second, small model that names its conversations), which the console's proxy (`console/geminiProxy.mjs`) swaps for the key it holds. The session never holds the team's key. **The owner's own Google login** (`agentAuth` in the `/settings` answer, absent when none is saved, which is no error here as it is for Grok and OpenCode): `WOODSHED_AGY_AUTH=own`, no key and no other address, the login file (`~/.gemini/antigravity-cli/antigravity-oauth-token`, 0600) written back from it by `installAntigravityLogin` (`session/antigravitySetup.sh`); agy refreshes the access token in it itself and its refresh token does not rotate, so nothing is sent back at stop. Each run gets its own `--settings` file (`session/antigravitySettings.mjs`, merged over `~/.gemini/antigravity-cli/settings.json` and never saved) that makes the credential and Woodshed's permission mode, since agy's own modes do not: it never asks before an edit in the checkout, in any mode, and `--mode plan` only puts `/plan` in front of the first message. So `plan` denies `write_file(<checkout>)`, `default` asks for it, `acceptEdits` is `--mode accept-edits` and `auto` is `--dangerously-skip-permissions` (the container is the sandbox); a command asks in every mode but `auto`, as agy's own policy does with its terminal sandbox off, and `agentMode: ""` stops agy starting in its own `auto` mode. Woodshed's own files under `/tmp` are `read_file` allow rules there. `configureAntigravity` writes `settings.json` (the checkout in `trustedWorkspaces`, inline rendering, no tips or survey), `cache/onboarding.json` with all three booleans true (skipping the theme and Terms of Service pages, whose data-use box is ticked by default), `config/hooks.json` (the session's own hooks, `hookState.mjs agy`) and the rules in `~/.gemini/AGENTS.md` (with the repo's `CLAUDE.md` after them where it has no `AGENTS.md` or `GEMINI.md`, which agy reads itself), and refuses a rules file, `.agents` folder or file of agy's own home that is a symlink out of the checkout. agy has no setting that turns off a repo's own `.agents/hooks.json`, `.agents/mcp_config.json` or plugins, which load in a trusted folder (and the folder must be trusted: the CLI asks, and its only other answer exits), so a start that holds a sign-in (the owner's login, or any personal credential already in the container: a Claude token or login, a Codex, Grok Build or OpenCode sign-in, as the session's own agent or beside it, `personalCredentialPresent` in `antigravitySetup.sh`) stops when the checkout ships one, and the team's key with only the session's own token in the container just logs `WARNING: the repo ships hooks, MCP servers or plugins`. That warning is remembered for the run where the repo's code cannot reach: in statusd's memory (the setup exports `WOODSHED_REPO_STARTUP_CODE=1` before the entrypoint execs statusd, and statusd sets it itself when it sets up an extra Antigravity on such a checkout), and statusd says it in every status read (`startupCodeRuns`), which the console keeps for the run. The marker file, `~/.config/woodshed/repo-startup-code`, is only a fallback for a statusd that was started again: the code agy runs is the session's user, so it can delete the file, and deleting it lifts nothing. From then on no personal sign-in of the owner's goes into the container: statusd refuses the owner's Codex sign-in, Claude token and Google login for an agent started beside (`refuseWhileRepoStartupCodeRuns`, a 409 saying why) before anything is written, and the console, which asks the session's statusd just before it would send one, sends none at all. A team-key agent carries none and starts. A new session is the way round. No MCP servers, plugins, Resume or review. Flags: `antigravityFlags` (`--settings`, `--add-dir` for the uploads, the mode's, `--model`, `--effort`, the first message with `-i`). |
| `WOODSHED_START_TOKEN` | session | A private session's token for starting sessions of its person's with `woodshed-session` (`session/startSessions.mjs`, console/README.md "Sessions that start sessions"). The entrypoint moves it to `/tmp/woodshed-start-token` (0600) and unsets it before anything starts, so statusd and the app never have it in their environment |
| `MODEL`, `EFFORT`, `PERMISSION_MODE` | session | Optional: `claude --model`, `--effort` and `--permission-mode` (default `auto`; `default` passes none), from New session |
| `PGHOST`, `PGPORT` (5432 by default), `PGSSLMODE`, `PGSSLROOTCERT` | both | Postgres's server, set only where the installation hosts it (the postgres engine, `shared/databases/postgres.mjs`). A session needs it only when the project file's `databases` has a postgres one, and stops at start, naming it, without it. With no engine's server, a shared session asks the console for no databases |
| `WOODSHED_MONGO_HOST` | both | Mongo's server, as `host:port`, set only where the installation hosts it (`shared/databases/mongo.mjs`); `MONGODB_URI` is made from it and the console's user and password |
| `PGUSER`, `PGPASSWORD`, `PGDATABASE`; `MONGODB_URI` | both | Optional for a session: a database to use as it is (the docker launcher), `MONGODB_URI` whole. The ECS task definition has none, so the entrypoint asks the session API (`POST /settings`) for the databases the console made: a shared session's own, waiting while the console answers 503, or a private session's owner's, one user, password and name on every engine. Each engine then exports its own variables (`PGHOST` to `PGDATABASE`, `PGSSLMODE`, `PG_URL`; `MONGODB_URI`), which the project file maps to the app's names. That user may create more databases beside its own, such as its tests' |
| `WOODSHED_SERVICES`, and each variable it lists | both | The installation's shared services: the list of their variables, each set to its URL. An env file line needing one that is not set is a warning in the log, not a stop. db-admin passes them to the seed, and refuses a name not ending in `_URL` or `_ENDPOINT`, or a value that is not a plain http(s) URL |
| `WOODSHED_SEED_REPO_SETTINGS` | seed, migrate, migrate-own | The file of repo settings, in the session API's answer's shape, that `dbAdmin.mjs` read for the databases' env files (the default project's installation values, its entryPoint's `--project`) and deletes after the seed. Unset without `--project`: the env files get the repo's defaults alone |
| `ISSUE`, `PR` or `PROMPT` | session | What to work on. `PROMPT` can be combined with the other two |
| `STARTED_BY`, `BRANCH` | session | The GitHub login credited in the PR body, and an explicit branch name |
| `SESSION_URL` | session | The session's page on the console (`WOODSHED_PUBLIC_URL`, or localhost for a local console), linked from the PR body. A console from before it sends none, and the line names Woodshed unlinked; `writeRules` drops it too when the project file says `consoleLinks: false` |
| Each install secret, by the variable the installation names for it, and `WOODSHED_INSTALL_SECRETS` | session | What the repo's installs read, such as a registry's token (`install_secrets` in Terraform), in the variable its tools read, as it arrives: a reinstall and claude's terminal have it there. `WOODSHED_INSTALL_SECRETS` lists those variables, space-separated. Only needed when an install runs again |
| `SESSION_MODE`, `ASKED_BY` | session | `ask` for a question from Slack: the default branch checked out detached, no databases, Redis, viewers or env files, the env files' secrets and each install secret `WOODSHED_INSTALL_SECRETS` lists unset before claude starts, and `session/ask.md` in place of `prompt.md`. `PROMPT` is the question and `ASKED_BY` the asker's Slack name |

## statusd

The console's only way into a running session besides the terminal:

| Route | Does |
| --- | --- |
| `GET /status` | `{ sessionId, state, editor, lastMessage, branch, head, prUrl, prUrls, usage, planUsage, app, appServers, appName, apps }`. `apps` is the project's apps, `[{ name, label }]` (one named `app` for a project file's `app`, none without one), and `appName` the one statusd runs: the default, the first, until a Start app picks another, then the last picked, or the app claude started itself from the shell: when the current app's frontend port is down and exactly one other app's frontend port (not shared with the current one) accepts a connection, `/status` switches to that app, logging `statusd: app running is not the one picked, following it`, and never while a Start app or Stop app of statusd's is going; `app` and `appServers` are that app's. `planUsage` is the last reading of the owner's plan: Claude's status line (`session/planUsage.mjs`), Codex's local rollout `token_count` events (`session/codexPlanUsage.mjs`, tagged `agent: 'codex'`). Grok Build reads the allowance it logs as `billing: fetched credits config` in `~/.grok/logs/unified.jsonl` (`session/grokPlanUsage.mjs`, tagged `agent: 'grok'`, the week or month that line names). OpenCode reports no plan limits a session can read, so OpenCode's is null. Codex windows are mapped by duration, including a weekly primary window. No credentials or transcript content are returned. Shape: `{ asOf, fiveHour, sevenDay }`, each window `{ usedPercent, resetsAt }` or null (a Grok window may also carry `label`, `short` and `spanMs`), and null before the agent reports plan limits. `usage` is the container's, from its cgroup (v2 or v1, `session/usage.mjs`): `cpuPercent` (100 is one core busy, measured between two calls at least 2 s apart), `memoryBytes` without the inactive file cache, `memoryLimitBytes` and `cores`. `appServers` is `{ frontend, backend, frontendPort, backendPort }`: whether the frontend and the backend accept a connection on the project file's `app.frontendPort` and `app.backendPort` (or `APP_PORT` and `APP_API_PORT`), whoever started them, and those ports (null with no app). `app` is `running` when both do, `api-down` or `frontend-down` when one does, and otherwise `starting`, `stopping`, `failed` or `stopped` from the last **Start app** or **Stop app**; `none` when the project file has no app (read again every 10 seconds and at each **Start app** until it has one). `lastMessage` is the last thing said in the transcript, `{ role, text, at }`. `agentOnlySend: true` says `POST /send` takes `agentOnly`, and `safeSend: true` that it types only at the agent's prompt between turns (a session started before that has neither: the console refuses Chat's messages to it). `boxText` is whether text waits in the agent's input box at its prompt, or null when statusd could not see the box (mid-turn, under a dialog). `prUrl` is `gh pr view`'s for the branch checked out now, or null for none (or a failed lookup), kept a minute for that branch, its upstream, its remote's URL and its own `remote`, `merge` and `pushRemote` settings only, so a checkout of another branch, a new upstream (a pull request's `refs/pull/<n>/head` included) or a remote pointed elsewhere is reported at the next read. `prUrls` is the pull requests of every local branch but the default one (the 20 with the newest commits), a git worktree's and one pushed and left included, the lowest number first: one GraphQL call for all of them (`createBranchPulls`), kept a minute while the branches and their commits are as they were. A pull request counts only when it is from the repo's own branch of that name and its head commit is on the local branch, so an older one that once used the name does not; a failed read gives the last good list, is kept its minute too, and logs `statusd: pull requests of the other branches not read` once per reason. After them come the pull requests claude opened with `gh pr create` anywhere in the session, a second clone or another repo's included: claude's PostToolUse hook (`hookState.mjs`) records each URL its output names in `/tmp/woodshed-opened-pulls.json` (`openedPulls.mjs`, the 20 newest), which a Codex, Grok Build or OpenCode session never writes. `state` is what Claude is doing, below |
| `POST /send` | `{"text": "..."}` typed into the agent's pane, then Enter, only at its prompt between turns and never into a prompt. A question or an approval opens only mid-turn, at any moment, so mid-turn no last look at the pane could keep one from taking the Enter as its answer: while the agent works (its state `working`, or claude's screen showing a turn behind a stale hook), or before it was seen taking the last message (a hook since its Enter, its pane seen working, or 20 s), it types nothing and answers 409 `{ why: 'working', busy: true }`. The console keeps the message in the session's saved `pendingMessages` (console/fleet.mjs) and sends it again after each status read, in order, so a console restart or a stop mid-turn does not lose it. At its prompt (`typeMessage`, `panePrompt.mjs`) the pane is read before the text and again before the Enter. A question, an approval or any highlighted numbered menu on screen (a folder-trust prompt) gives 409 `{ why: 'prompt-open', typed, error }`. `typed` means the text is in the agent's box, unsent: nothing is typed again. Nothing is typed into a box that holds text, someone's draft in the TUI tab or one left unsent: 409 `box-in-use` until it is sent or cleared. The box is read with its colours (`composerEmpty`), where an empty box's suggestion or placeholder is dim and a draft is not. One thing is typed at a time, Sign in's command included (`typing`). An agent not at its prompt (starting, exited) gives 409 `not-at-prompt`, a pane that could not be read 503 `pane-unread`, a typing call that failed before any of the text went in 500 `not-typed`, and one that failed after part of it went in 409 `partly-typed` (`typed: true`: in the box, unsent, never typed again). Control characters are not typed: CRLF becomes a newline, and the others (an ESC would be the Escape key, a NUL cannot pass) are left out. Logs `statusd: text sent to claude` or `text not sent`, with lengths, never the text. With `"agentOnly": true` (the console's review feedback for a My Woodshed session), the same guards apply, and first: with `"prUrl"` (and `"headSha"`), a 409 `the branch checked out is not on that pull request now` unless a fresh `gh pr view` there gives that pull request, open, on that commit, with no checkout during that lookup; a 409 `the session is stopping` once the stop's `/checkpoint` has started; and with `"withinMs"` (from statusd getting it) or `"notAfter"` (the caller's own deadline, time in transit included), a 409 `too late: the caller has stopped waiting` when it is past either. Just before typing, tmux's `pane_current_command` must still be the agent's (`claude`, `codex`, `grok`, `opencode`) (409 `the agent is not running in its pane`, so the text never reaches the shell an exited agent leaves) and the deadline not passed, so a caller that gave up and sends again never has it typed twice |
| `GET /agents`, `POST /agents` | The agents a private coding session's owner started beside its own (`session/agents.mjs`), and a new one: `{"agent": "claude"\|"codex"\|"grok"\|"opencode", "model", "effort", "permissionMode", "prompt"}`, at most three. Model takes a supported Claude Code model, a Codex name, a Grok Build model ID, or an OpenCode `provider/model` ID such as `openai/gpt-5`. An empty model uses the agent's default. Effort takes a name supported by the selected agent. Each runs in a terminal of its own (`agent-2`, ...) in the same checkout: a tmux session, or where the session's agent runs in Herdr a Herdr terminal on the session's core (no parent, no `--keep`; its variables go before its command line, since `hc run` takes none), claude with the session's flags (`/tmp/woodshed-agent-claude-flags`, written by the entrypoint without New session's model, effort and mode) and `--session-id`, codex as `codexFlags` would start it; the first message is read from `/tmp/woodshed-agent-N-prompt.md` by the shell, never typed. A claude's hooks write `/tmp/woodshed-agent-N-state.json` (`WOODSHED_CLAUDE_STATE_FILE`) and name its transcript; a codex's rollout is the one its process holds open (`/proc/<pid>/fd`). The session's own agent never reads one of theirs as its own. An extra Codex agent runs on its owner's sign-in when the console sends one with the start (`codexAuth`, written as `~/.codex/auth.json` and taken back when the start fails after it), or on the team key through the proxy; the session never asks for it. Extra Grok Build reuses the primary sign-in in a Grok session. In other private coding sessions, the console sends the start through `POST /agents/with-grok-proxy`. Grok gets a temporary home and uses the session token for the console's scoped xAI model proxy. The owner's xAI API key stays on the console. Each terminal gets its own conversation ID and hook state. Extra OpenCode reuses the primary sign-in in an OpenCode session, with a separate config and transcript database in each terminal. Stopping the pane removes its config and keeps its transcript database in the container. A failed launch removes both. Extra Claude beside Grok Build or OpenCode uses the owner's saved Claude token directly, supplied with the start, and skips project settings and MCP servers. Extra Codex in those sessions starts with the checkout marked untrusted, so its project config does not load. 404 outside a private coding session, 409 once tainted (the lockdown stops them all: they are not reopened on the console's proxy) or with three running. `/status` lists them under `agents`, each `{ id, agent, model, effort, permissionMode, startedAt, state, heldIds, deliveredIds, refusedIds, leftInBox }`, and leaves it out where none can start Extra Antigravity CLI (`"agent": "antigravity"`, with `"antigravityAuth"`: the owner's own Google login as the console saved it, when they have one) runs `session/bin/agy` with a settings file of its own (`/tmp/woodshed-agent-N-agy-settings.json`, removed when it stops) for its mode and credential, in the one `~/.gemini` every agy of the session shares, which statusd's `antigravityBeside` sets up with `configureAntigravity` (refusing a branch that ships hooks, MCP servers or plugins where a sign-in is at risk); with no login, the team's key through the console's proxy. Its hooks write its own `/tmp/woodshed-agent-N-state.json` and name its `transcript_full.jsonl`, which its Chat reads. |
| `* /agents/<id>/transcript\|send\|interrupt\|prompt\|answer\|stop` | One of those agents' Chat routes, as the session's own below: its own record of its conversation, a message (held while it works and typed once it is back at its prompt, with the same guards as `POST /send`; its `heldIds`, `deliveredIds` and `leftInBox` say what became of each), Esc, what its pane asks and the answer to it. `stop` ends its tmux session. The TUI tab attaches to one through ttyd's `--url-arg`: `/term/<id>/?arg=agent-2` runs `session/bin/woodshed-attach agent-2` (`tmux attach`, or `hc attach` in Herdr), and anything else attaches to the session's own. In Herdr a message goes in through `hc send --if idle`, as the session's own does, and scrolling is Herdr's client's |
| `POST /checkpoint` | Saves the Claude home, then commits anything uncommitted and pushes the branch, before a stop. An ask session only saves its Claude home |
| `* /redis/<id>/...` | Forwarded, without the token, to the session's redis-commander, which listens on 127.0.0.1:7683 only. The console's Redis button. 404 `this session has no Redis` when the project uses none |
| `* /__woodshed/code/...` | Forwarded, without the token, to openvscode-server (VS Code), which listens on 127.0.0.1:7688 only. Refused with 404 when the checkout's project file says `editor: false`; `/status`'s `editor` is true when it says `true` and the image has the editor. statusd starts it on the first request (`session/codeEditor.mjs`), logging to `/tmp/openvscode-server.log`; an ask session answers 404. Websockets too, with the token in `Authorization` like its other requests. The console sends these for `https://<id>.<app domain>/__woodshed/code/` (`console/editorProxy.mjs`): the console's **Editor ↗** |
| `POST /app/start` | Runs the project file's `app.start` in the background, logging to `/tmp/woodshed-app.log`. The console's Start app button. With several apps, `{"app": "<name>"}` picks one, and no body (an older console's) the default; a name that is none of them answers 400. Picking another than the one statusd runs stops that one first with its own `stop`, when it has one and something of it ran, then starts the one picked; a Stop app during that stop keeps the next from starting |
| `POST /app/stop` | Runs the running app's `stop` (the project file's `app.stop`) in the background, to the same log, after interrupting a start still in progress. The console's Stop app button |
| `POST /upload?name=&pane=` | The body, one file of at most 25 MB, saved as `/tmp/uploads/<time>-<rand>-<name>`, and its path typed at the `agent` (claude), `terminal` (the shell) or `agent-N` (an agent beside claude) pane's prompt with no Enter, answered with `typed`: false for an agent in Herdr, whose path the page types itself. A file pasted or dropped on a terminal (`session/terminalFiles.mjs`) |
| `GET /image?path=` | A picture a terminal path names, after the shed's `terminalImages.mjs`: png, jpg, gif or webp, its real path inside the repo, `/tmp/uploads` or Claude's scratchpad, symlinks resolved first. 404 otherwise |
| `GET`/`POST`/`PATCH`/`DELETE /shed-review/...` | The shed's own review page and server (`session/reviewShed/`), reached through the console's `/review` and `/reviews/claude-<id>/...`: the checkout's review, and `/reviews/claude-<id>-pr<n>/...`, of another pull request the session opened, one of those the console names in `x-woodshed-pulls`, in a detached worktree under `/tmp/woodshed-review-worktrees`. |
| `GET /applog` | `{ logs: [{ name, text, bytes }] }`: the last 48 KB of `/tmp/woodshed-app.log` (`start`, where with several apps a `# Woodshed: starting <name>` line opens each start) and of each of the running app's `logs`. The App log tab |
| `POST /scroll` | `{"steps": -3, "pane": "agent"}`, a swipe or wheel the browser's own scrollback could not take (console/README.md, "Scrolling back"): wheel bytes, at most 40, to a full-screen program on the alternate screen that asked for the mouse; otherwise copy mode, a line a step, up to the 50000 lines tmux keeps (claude and codex inline, the shell) |
| `GET /transcript?limit=&since=` | `{ agent, entries: [{ role: 'user'\|'assistant'\|'tool', text, tool?, error?, diffs?, at }], partial, writtenAt }`: the conversation so far from claude's transcript or codex's rollout, read from the last 4 MB, newest 300 entries at most (`sessionTranscript.mjs`). Only a conversation of this session's: one written since the entrypoint began restoring the Claude home (the time in `/tmp/woodshed-home-restored-from`), or the one a Resume reopened (`RESUME_SESSION`), never an earlier session's that the owner's home brought. The same goes for `/status`'s `lastMessage` and `claudeSession`. Thinking and tool output are left out; `error: true` marks a tool run that failed (claude's `is_error`, codex's exit code), and a codex shell call is its command, a patch its files. An edit that did not fail carries `diffs`, what it changed (`transcriptDiff.mjs`): `[{ path, op: 'edit'\|'add'\|'delete'\|'rewrite', to?, add, del, hunks: [{ head, lines }], cut?, all? }]`, `path` relative to the checkout and each line `-`, `+` or ` `. claude's come from its edit's result (`toolUseResult.structuredPatch`, the real hunks) or, until that is written, from Edit's, MultiEdit's or Write's input; codex's from apply_patch's `*** Begin Patch` input, as a custom tool, a shell call of `apply_patch`, or a string in an `exec` script. Bounded: a line at 400 characters, an edit at 200 lines, and an answer's diffs at 192 KB, the newest kept and older ones left with their file and counts (`cut: true`). What a shell command changed is in no record. With `since`, the last answer's `writtenAt`, it answers `{ agent, unchanged: true, writtenAt }` while nothing newer was written, after a stat alone. The console's Chat tab |
| `POST /interrupt` | Esc typed into the agent's pane, which ends its turn (Ctrl+C for Grok Build, which Esc never stops): the Chat tab's Stop. Logs `statusd: agent interrupted` |
| `GET /prompt` | `{ prompt }`: what the agent's pane asks now, read from `tmux capture-pane` (`panePrompt.mjs`): claude's AskUserQuestion picker (`{ kind: 'question', step, question, options, multiSelect, questions }`, or `step: 'review'` on its Review your answers screen), an approval (`{ kind: 'approval', agent, key, complete, what, title, detail, approve, deny }`: claude's permission dialog, codex's approval, Grok Build's, whose shape is reconstructed from its source and strings, not captured, and answered with its row's number, or OpenCode's, read from real captures (`shared/__fixtures__/pane-opencode-approval-*-captured.ansi`), with the labels of the rows that say Yes and No. OpenCode's pick shows only as a colour, so `answerApproval` reads which choice is highlighted from the pane's colours (`opencodeHighlight`), presses Left that many times, checks Allow once is the one highlighted and the approval is still the same, then presses Enter; Esc rejects, whatever is picked. A pane read without colours (Herdr's) cannot show the pick, so an approve there is refused with `no-highlight` and left to the TUI tab; `key`, the sha256 of exactly what it asks, as drawn from its head to its first option; `complete: false` when it is longer than the page shows, so the page offers only the TUI tab), or `null`. A pane that could not be captured answers 503 `{ why: 'pane-unread' }`, never `null`, and logs `statusd: prompt not read, the pane could not be read`. The Chat tab's Needs you line agy's approval (`agent: 'antigravity'`) is read from its key hint `↑/↓ Navigate`, the numbered rows over it and the title over those (`Run this command?`, `Allow creation of this file?`, `Accept this file edit?`), read from real captures (`shared/__fixtures__/pane-agy-approval-*.txt`) and answered by moving the highlight with arrows and pressing Enter; its own question picker (`Question 1/2: …`, `esc Skip`) is read as needing a person and left to the TUI tab. |
| `POST /answer` | The Chat tab's answer: `{ kind: 'question', questions: [{ question, options, pick }] }` or `{ kind: 'approval', decision: 'approve'\|'deny', key }`, the `key` `GET /prompt` gave. Nothing is typed blind: the pane must show that prompt (the question's text and every option's label, or an approval whose key is that one: the same text, to the space, whole), the arrow keys are counted from the row it highlights, and the pane is read again after each step (the highlight where it should be, the next question, the review of the answers, the prompt gone). A pane that is not what it should be stops it with a 409 `{ error, why, typed }` (`why`: `no-picker`, `other-question`, `other-options`, `multi-select`, `other-approval`, `incomplete`, `not-moved`, `still-there`…; `typed`: questions answered before it stopped). One answer at a time. Logs `statusd: answer typed` with the picks' numbers or the decision and the arrow keys it took, or `statusd: answer refused` with `why`, never an answer's text |
| `UPGRADE /exec` | The exec pipe, for `woodshed tunnel` (`session/execPipe.mjs`): with `Upgrade: woodshed-tunnel` and the line base64'd in `x-woodshed-exec` (8 KB at most, so the request stays under Node's 16 KB of headers), it answers 101 and runs `sh -c <line>` as the session's user in the checkout, in a process group of its own, with statusd's environment less `SESSION_TOKEN` and `TERMINAL_TOKEN`. Both ways are framed (`shared/execFrames.mjs`): `[kind][length, 4 bytes][bytes]`. In: 4 stdin, 5 stdin's end. Out: 1 stdout, 2 stderr, 3 the exit code (128+n for signal n), then the socket closes. stdin ends only by its frame, so no proxy has to carry a half-closed connection: a connection that ends or closes before the line does is a disconnect, and the whole process group gets SIGHUP. The program's output waits while the socket's buffer is full, and the socket while the program is not reading. 409 in a tainted session, 404 in an ask session. Logs `statusd: exec opened` with the line's length, never the line, and `exec closed` with its exit code. The console opens it for a My Woodshed session's owner alone (`console/execPipe.mjs`) |
| `*` with `x-woodshed-app: Bearer <token>` | Any path, websockets too, forwarded without that header to the app's frontend, on the running app's `frontendPort` (`APP_PORT` overrides it). The token has its own header because the app's requests carry an `Authorization` of their own |

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

Each source is a reader in `session/agentState.mjs`: claude's (above), codex's (its pane alone, `paneStates.mjs`), Grok
Build's (its hooks through `hookState.mjs`, as claude's, which reads their camelCase; its pane for an approval and before
the first hook), OpenCode's (its pane alone), Antigravity CLI's (its pane first, `paneStates.mjs`, and its hooks through `hookState.mjs agy` where the pane says nothing: it fires none as it opens, SessionStart comes with the first message, and a turn cut short with Esc fires none at all, so a hook's `working` never outranks the screen that shows its prompt again), a QA run's (its marker file), and Herdr's. For Grok Build, OpenCode and Antigravity CLI, whether the agent's program runs at all (`agentOpen`, tmux's `pane_current_command`) tells
starting and exited from at its prompt (`source: 'hook'` or `'pane'`). An agent in Herdr (`WOODSHED_TERMINAL=herdr`) is read by Herdr first: the status
herdr-core keeps for its terminal, the agent's own OSC 7501 record (`hc get claude`; claude sends them, codex 0.167
does not), `idle` or `done` as `done`, `working` as `working` and `blocked` as `needs-you` (`source: 'herdr'`). Its own
reader stays behind it and wins when it says more: claude's PermissionRequest hook on a prompt the record does not call
blocked, or a background agent still running after its Stop. With no record (`error`, a shell, codex) the agent's own
reader stands alone.

statusd reads and types into the agent's terminal through `session/agentPane.mjs`, tmux's `claude` pane or Herdr's
`claude` terminal through `hc`. Herdr reads the screen without its colours and types text only as a paste with its
Enter, so in Herdr `POST /send` is `hc send`, only while claude's record says `idle` or `done` (`--if idle` for the
first; hc's `--if` has no `done`, which claude says after every finished turn, so `done` also needs its screen at the
prompt) or, for codex, which reports no status, its screen shows its prompt. hc refuses a blocked program and holds for a person's draft in an attached client; `boxText` is null, as statusd cannot tell a draft from claude's dim
suggestion; a file dropped on the TUI tab is saved and not typed in; and `POST /scroll` on the agent answers 409, as the
attached `hc` client takes the wheel itself. `POST /answer`, `GET /prompt` and `POST /interrupt` work as in tmux, with
`hc keys` and `hc read`.

## A tainted session

A session gets the MCP servers the console hands it (`WOODSHED_MCP_SERVERS`, `configureMcp`, `taint.mjs mcp-config`),
each at the console's relay in claude's `--mcp-config` (`/tmp/woodshed-mcp.json`, which holds the session token). A My
Woodshed session that may use production has its production server there too, turned off in `/mcp` until its person
turns it on (`WOODSHED_PROD_MCP` keeps the launcher able to lock it down). Its first call taints it, and the console locks its network down
from outside (`../docs/reference.md`, "Production access"). Inside, `taint.mjs` makes the session work within that:
statusd's `POST /taint`, or the entrypoint of a resumed one (`WOODSHED_TAINTED`), writes `/tmp/woodshed-tainted`, points
every tool at the console's egress proxy (`/tmp/woodshed-egress.env`, sourced by `~/.profile` and `~/.bashrc`), trusts
the proxy's authority for GitHub, adds `tainted.md` to the rules, and reopens claude on the console's Anthropic proxy
(`bin/claude`) with web search and fetch off and only its production servers among its MCP servers. Nothing here is the
lockdown: undoing it reaches nothing more. A tainted session installs nothing again (`/tmp/woodshed-deps` says so),
offers no default plugins, has no Remote Control and syncs no settings.

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

Auto mode also asks a person, once, before claude's first file read outside the
working directories ("Read outside the working directories", Claude Code
2.1.325), which held every private session at Needs you on its first step,
reading its environment notes. So the same file allows a `Read` of each file
outside the repo that Woodshed points claude at, by its path and nothing else:
`/tmp/woodshed-setup.md` (the notes), `/tmp/woodshed-deps` (the installs'
status, which the project's notes have claude wait for),
`/tmp/woodshed-docker-ports.log` (`hostDocker.md`) and `/tmp/answer.md` (an
ask's answer). `/tmp/uploads` is a working directory already (`--add-dir`). A
rule rather than another `--add-dir`: a working directory also takes writes and
is named to the model. Any other read outside the repo, such as an app log the
project file puts under `~/.cache`, still asks once per session.
`entrypoint.test.mjs` fails when Woodshed's rules name a `/tmp` file with no rule.

The same file runs `session/readyGate.mjs` before each Bash command and the
GitHub MCP's pull request calls. It refuses to open a pull request for review,
or to mark one ready (`gh pr create` without `--draft`, `gh pr ready`, or the
MCP with `draft` false), when the branch changes the project file's `app.paths`
and the app was never started in this session: none of its `app.logs` has
anything in it, and the session's saved home does not keep them. With several
apps (`apps`) each counts alone: a change under one app's `paths` needs that
app's own logs written, whichever other app ran. Claude reads why, and either
starts the app and proves the change, or, when the change cannot be shown in
it or the start fails, writes what it tried under `## Proof` and opens the pull
request ready all the same; only an app that cannot start at all, with nothing
in its logs, leaves it a draft (#26686 was opened ready without the app
ever running). Sessions open their pull requests ready (`prompt.md`): a draft
is for unfinished work, since the review's tag and the console's QA label only
follow a ready one. Anything the hook cannot work out lets the call
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
  -e PROMPT="..." woodshed-session

curl -H 'Authorization: Bearer test-token' localhost:17682/status
# Terminal: http://localhost:17681/term/ws-test/  (user woodshed, password test-token)
# Editor: curl -H 'Authorization: Bearer test-token' localhost:17682/__woodshed/code/  (a browser needs the console in front)
```

`GH_TOKEN="$(gh auth token)"` makes the session push as you, so give it a
prompt that does not push unless that is what you want.

With no console, the session gets no repo settings: its env files hold the repo's `defaults` and the overrides alone.
