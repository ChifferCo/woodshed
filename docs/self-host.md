# Setting Woodshed up, step by step

A runbook for setting Woodshed up for one repository, written to be followed by a person or by their coding agent.
Each step says who does it, the command, and how to tell it worked. **You** marks a step only the person can do: it
needs a browser, an account or a decision. An agent stops there, says what to do, and waits. Claude Code, run in this
checkout, follows it through the `setup-woodshed` skill (`.claude/skills/`), with `write-project-file` for the project
file and `debug-woodshed` when a check fails.

To only look at the console, with made-up sessions and nothing else (no Docker, GitHub or Claude):
`node <woodshed>/console/bin/devConsole.mjs`, then `http://localhost:7690/s/aaaa1111`.

To run real sessions, pick one:

| Where | Sessions run on | Effort | Section |
| --- | --- | --- | --- |
| This machine, to try it | Docker here | One script, then a repo and a token in the browser | [On this machine](#on-this-machine) |
| A server your team reaches (Hetzner, OVH, any VM) | Docker on that machine | An afternoon: HTTPS, a service, a firewall | [On a server](#on-a-server) |
| AWS | Fargate | Terraform in an account of its own | [On AWS](#on-aws) |

**You** pick. An agent shows "What each one sets up", below, before asking, so nothing it makes later is a surprise,
and says that a computer you already have works as well as a rented one.

### What each one sets up

Claude's own use is apart from all of these: each person's Claude plan, or the team's API key.

**This machine.** Nothing is rented and nothing is billed. Docker containers on it: the console (on localhost only,
with no sign-in), Postgres and Mongo when the install is made for a repository whose project file has `databases`,
the project's shared services, and one container a session, about 4 GB of memory each. Sessions stop when the machine sleeps, and only you reach it.

**A server.** The same containers, on a machine your team reaches, with Caddy in front for HTTPS. It can be a VM you
rent (on Hetzner Cloud a CPX41 or CAX31, 16 GB for about four sessions at once) or a computer you already have that
stays on, such as a desktop in the office: then the only cost is its power. You keep its firewall, updates and
backups.

**AWS.** Terraform makes, in an AWS account that holds nothing else:

| What | Monthly, us-east-1 |
| --- | --- |
| The base box, an EC2 that runs the console and Caddy around the clock. `t3.small`; `t3.medium` when Mongo or a shared service runs on it too | about $15; $30 |
| Its two disks, 50 GB | about $4 |
| Its public IP address | about $3.65 |
| A Route 53 zone for the console's name | $0.50 |
| Secrets Manager, about seven secrets | about $3 |
| With `postgres` in `databases`: RDS Postgres, `db.t4g.micro`, 20 GB | about $14 |
| ECR images, the webhooks Lambda and its queue, the session logs | cents |
| **Before any session runs** | **about $26** without databases, $40 with Postgres, $42 with Mongo, $56 with both |
| Each session on Fargate (2 vCPU, 8 GB), only while it runs | about $0.13 an hour: about $6 a month at 2 hours a workday, $22 at 8 |

It also sets an AWS budget, $150 a month by default, which emails at 80% and 100% and stops nothing.
`providers/aws/README.md`, "How it is built", lists every piece.

Everything here is described in more depth in `providers/local/README.md` and `providers/aws/README.md`; this page
only orders it. `<woodshed>` below is where Woodshed is checked out. Older docs write its paths as `woodshed/…`, from
when it sat in a folder of another repo: from Woodshed's own checkout, drop that prefix. `CLAUDE.md` is for changing Woodshed and running an installation, not for setting one up: an agent can
skip it until something breaks, then use its "By symptom" list.

## Before any of them: the project file

A session is only as useful as the repository's `.woodshed/project.yaml`: without one it gets a checkout and Claude,
but no installs, no databases and no app to check its change in. Writing it is the step an agent does best. On a
server or AWS it comes before the install; on this machine after it, for the repository you pick in the console
("On this machine", step 5), since that install builds nothing from it.

1. **Agent.** Read the repository: its package files, docker compose file, env examples, migration and seed commands,
   and how its app starts. Then copy what fits from `project.reference.yaml` (every field, with an example) into
   `.woodshed/project.yaml` in the repository. Only `version: 1` is required; a misspelt field is refused, never
   ignored.
2. **Agent.** Check it from the repository's root:

   ```bash
   node <woodshed>/shared/project.mjs check
   ```

   **Done when** it prints `.woodshed/project.yaml: read from the checkout` and a line each for the installs,
   databases, env files, app and pull requests you meant. A mistake exits 1 with each problem and the field it is
   about: it also checks the file against the checkout, so a workflow, folder, script or port it names that is not
   there, or an env file git would not ignore, fails it too.
3. **You.** Commit it to the repository's default branch. The session image is built from the default branch, so a
   file on another branch is not read by the install.
4. **Agent.** Have the repository's CI run the same check on each pull request that changes the file or a workflow it
   names: a workflow of the repository's own, `.github/workflows/woodshed-project.yml`, calling Woodshed's reusable
   one (`docs/reference.md`, "Checking it"):

   ```yaml
   name: Woodshed project file
   on:
     pull_request:
       paths: ['.woodshed/**', '.github/workflows/**']
   permissions:
     contents: read
   jobs:
     check:
       uses: ChifferCo/woodshed/.github/workflows/project-check.yml@main
   ```

   `with: { ref: <commit> }` pins Woodshed's check to a commit, so a change to it reaches the repository only when the
   pin moves. **Done when** the pull request that adds it shows a passing `check / Project check`.

Things the file cannot hold: secrets. An env file's secret values (API keys the app's dev setup needs, never
production ones: `CLAUDE.md`, "Rules") are set on the console's Secrets & webhooks page after it starts.

## On this machine

Needs Docker with compose, Node 22 or later, git, and `gh` signed in. On macOS and Windows, Docker Desktop must be
running. No repository is named up front: the install makes a console with none, and you pick one in it, from the
repos your `gh` login can push to. The project file comes after that, for the repo you picked.

1. **Agent.** Check the tools: `docker info`, `docker compose version`, `node -v` (22 or later), `gh auth status`.
   **You**, before anything else: install what is missing, and sign `gh` in with `gh auth login` (an agent asks you to
   type `! gh auth login` at its prompt). The console and every session run on that login: they clone, push and open
   pull requests as you, and the repos you can pick are the ones it can push to.
   **You**, and decide now: will you use it from your other devices, through Tailscale? If so, only you, or others on
   the tailnet too? "From your other devices", below, says what each sets up.
2. **Agent.** Run the installer without starting the console, since it would hold the terminal:

   ```bash
   WOODSHED_NO_START=1 bash <woodshed>/install.sh
   ```

   With Tailscale add `WOODSHED_TAILSCALE=1` for only you, or `WOODSHED_TAILSCALE=shared` for others on the tailnet too.

   From no checkout: `curl -fsSL https://woodshed.run/install | WOODSHED_NO_START=1 bash`. It asks nothing. The first
   run builds a session image for any repository, `woodshed-session:generic`, with no checkout in it: a few minutes on
   the published runtime, much longer when it cannot pull that and builds the runtime too (its log says which). Each
   session then clones its repo and runs its installs at start.

   **Done when** it exits 0 having printed `Set up in ~/.woodshed`, after `No repository yet, so no databases`.

   Without `WOODSHED_NO_START`, it first checks that nothing else listens on 7690, 7691 or (with
   `WOODSHED_TAILSCALE=1`) the app ports, and stops with what holds one (`port 7690, which the console needs, is taken
   by node (pid …)`): often a console left from another install. Its own console is not in the way: a second run
   stops it and starts it again with the new settings.
3. **Agent.** Start the console in the background, and keep its log:

   ```bash
   ~/.woodshed/bin/woodshed >~/.woodshed/console.log 2>&1 &
   ```

   **Done when** `curl -fsS -o /dev/null http://localhost:7690/` succeeds, and the log's `console: listening` line has
   `repo: ''`.
4. **You.** Open the console: `http://localhost:7690` here, or with Tailscale `https://<name>` on your phone or any of
   your devices. Its setup card's **Add a repo** opens **Console settings**, Repos: pick the repository from the list
   of those your `gh` login can push to, and **Add**. The first one added is the console's default.

   **Done when** the console's log has `projects: repo added` with that repo.
5. **Agent**, when that repository has no `.woodshed/project.yaml` on its default branch yet: write it, as "Before any
   of them: the project file", above, says (the `write-project-file` skill), and have it committed. Sessions read the
   file at start, from their branch, so nothing is rebuilt for it.

   If the file has `databases`, this install hosts none yet, and the console refuses sessions with `the project file's
   databases need postgres, which this installation does not host (it hosts none): run WOODSHED_REPO=owner/name bash
   install.sh again on this machine`. Do that, with `WOODSHED_NO_START=1` and the same `WOODSHED_TAILSCALE`, then stop
   the console and start it again as in step 3: the run builds that repository's own session image (several minutes)
   and starts its databases, and keeps the rest of the install.
   Do the same when the file has env files with a `secret`, so they get their slot on **Secrets & webhooks**. Read
   "Known gaps", below, before the first session.
6. **You**, optional. Sessions push and open pull requests as you, with your `gh` sign-in, so a GitHub App is not
   needed on this machine: skip this step unless you want sessions to push as a bot scoped to the repository. Then
   the setup card's **Connect a GitHub App (optional)** leads to `/setup/github`: create the App on GitHub (one
   confirmation there, under the repository's organization or your own account; an organization may need an owner to
   approve it), install it on the repository, then press **Restart the console**. The launcher starts it again by
   itself.

   **Done when** the console's log has `console: GitHub App from the setup page`, or you skipped it.
7. **You.** Choose your agent: the setup card's **Claude** or **Codex** opens that box on **My settings**, and either one
   is enough. For Claude on a Claude plan: run `claude setup-token` in a terminal, and save the token. Copy it in one
   piece: a token that lost a character to a wrapped line looks right and fails in the session. With an Anthropic API
   key instead: save it as `anthropic-api-key` on **Secrets & webhooks**. For Codex: run `codex login` and paste
   `~/.codex/auth.json`, or paste an OpenAI API key; then pick Codex as the agent in New session.
8. **You**, if step 5 ran the installer with the repository and its project file has env files with a `secret`: set
   each on **Secrets & webhooks**.
9. **You.** Press **New session** and say what to build.

   **Done when** the session reaches its terminal and claude is working. Its log starts `Cloning the project's repo`
   (`image: none` on the generic image) and `Project repo cloned`. A session that fails at start shows why; the
   console's log and `CLAUDE.md`, "By symptom", say more.

To set it up for one repository from the start instead, as before: `WOODSHED_REPO=owner/name WOODSHED_NO_START=1 bash
<woodshed>/install.sh`, with the project file committed first, since the image is built from it. It reads the
repository with `gh auth token` (or `GH_TOKEN`), builds `woodshed-session:<owner>-<name>` with its checkout and
installs, so sessions start without either, and starts Postgres and Mongo for the file's `databases`.

What to know on this machine:

- Nothing is open to the network: the console listens on localhost only, with no sign-in, so do not expose port 7690
  other than through Tailscale's `serve`, below.
- Sessions use this machine's Docker, so a repo's compose services, Supabase local or Testcontainers run: the
  containers Claude starts run on this machine beside the session, and their published ports are forwarded into it.
  That is root on this machine for Claude in every session: it can do anything here that you can. That is part of
  what "only you" means. `WOODSHED_SESSION_DOCKER=0` (in `~/.woodshed/stack.env`, or with the installer) turns it off.
  Those containers outlive the session that started them: `docker ps` lists them, and `docker rm -f` removes them.
  A browser-side address in the app's env (`SUPABASE_URL=http://127.0.0.1:54321` in an Expo web app) works in the
  session's own Playwright browser, but not from your phone through Open app, which reaches only the app's own port.
- Session apps (**Open app**) need HTTPS and a name or port of their own, which the installer sets only with
  `WOODSHED_TAILSCALE=1`: without it the session runs and checks the app itself, but there is no link to open it from
  your browser.
- More repos: **Console settings**, Repos, **Add a repo** lists every repo your `gh` login can push to. Each starts its
  sessions in the install's session image, cloning its own repo at start, so its dependencies install then. Only the
  install's repository (`WOODSHED_REPO`) has databases and env file secrets.
- GitHub webhooks need a public address, so the console polls GitHub every 30 seconds: a `woodshed` label or a
  `/woodshed` comment takes up to that long. **New session** is immediate.
- Everything is in `~/.woodshed`. `WOODSHED_REBUILD=1` with the installer builds the session image again, which it
  needs after the project file's installs change when the install has a repository. Back up `~/.woodshed`'s secrets
  key apart: losing it loses every secret.

### From your other devices

Tailscale's `serve` puts the console at `https://<this machine>.<tailnet>.ts.net`, for your tailnet's devices alone.
`providers/local/README.md`, "From your other devices, with Tailscale", has the detail.

- **Only you**: `WOODSHED_TAILSCALE=1`. No sign-in and no GitHub App, as on localhost: the tailnet is the gate, so
  every device on it must be yours (`tailscale status`), and no server on it may be one others have a shell on (a
  shared dev box reaches the console as you). Each session's app opens on a port of that name,
  `https://<name>:7701/` and on. **Done when** `tailscale serve status` lists 443 and the app ports, and
  `https://<name>` opens the console on your phone.
- **Others too**: `WOODSHED_TAILSCALE=shared`, then step 6 is not optional and comes first, before step 4, at
  `https://<name>/setup/github`; then set `WOODSHED_REQUIRE_SIGN_IN=1` in `~/.woodshed/stack.env`, restart the console
  and sign in first. Open app needs a domain of your own for this. Sessions still use this machine's Docker, so
  everyone who can start one has this machine, as on a server (below). **Done when** the console's log has
  `console: GitHub App from the setup page`, and opening it from another device asks to sign in with GitHub.

## On a server

There is no installer for a server. `providers/local/README.md`, "Setting it up" and "On a server your team reaches",
has every step; this is the order, with the checks. Steps marked **Server** run on the machine.

Sessions use the server's Docker unless `stack.env` says `WOODSHED_SESSION_DOCKER=0`. On a console others use, that
means anyone who can start a session, from a GitHub label or comment too, gets root on the server: the secrets key, so
every stored secret and Claude token, and every other session's containers and databases. Only people you would give
root on the box should be able to start sessions there.

1. **You.** Make the machine: Ubuntu 24.04, about 4 GB of memory a session (16 GB holds about four). On Hetzner Cloud,
   a CPX41 or CAX31.
2. **You.** Put a firewall in front of it, not only ufw: Docker's published ports get past ufw. Allow 22 from your IP,
   80 and 443 from anywhere, nothing else (a Hetzner Cloud Firewall does this).
3. **You.** Pick the name: a domain with an `A` record for the console and a wildcard `*.` record for session apps, or
   no DNS with sslip.io (`woodshed.<ip with dashes>.sslip.io`).
4. **Server.** Install Docker with compose, Node 22 (Ubuntu's own is older), git, `gh` and Caddy, and add swap
   (Hetzner's images have none; the sizing above counts on it). Make a user for the console in the `docker` group,
   which is as good as root on the machine. On Hetzner, attach a Volume and mount it at `/var/lib/woodshed`.
5. **Server.** Steps 1 to 4 of `providers/local/README.md`, "Setting it up": build the session image, fill in
   `stack.env` and `session-env.json` (outside the checkout, mode 600), start the databases, make the secrets key and
   store the root passwords. Keep the key off the Volume: `WOODSHED_LOCAL_SECRETS_KEY_FILE=/etc/woodshed/secrets.key`.
   For a server also set `WOODSHED_PUBLIC_URL` and `WOODSHED_APP_DOMAIN` to the name from step 3, and
   `WOODSHED_TLS_ASK_PORT=7692` without a wildcard certificate.

   **Done when** `docker compose … ps` shows the databases healthy and `node <woodshed>/providers/local/bin/secret.mjs
   list` lists `db-root/postgres` (and `db-root/mongo`).
6. **Server.** Run the console as a systemd service. Leave `WOODSHED_REQUIRE_SIGN_IN` unset for now.

   ```ini
   [Unit]
   After=docker.service
   Requires=docker.service

   [Service]
   User=<console user>
   EnvironmentFile=<path to stack.env>
   ExecStart=/usr/bin/node <woodshed>/providers/console.mjs
   Restart=on-failure

   [Install]
   WantedBy=multi-user.target
   ```

   **Done when** the console's log (`journalctl -u <unit>`) has `githubSetup: restart from the page` with
   `offered: true`, and `console: databases` with the engines you meant.
7. **Server.** Caddy in front of port 7690, as in `providers/local/README.md`, "Session apps without a wildcard
   certificate" (that Caddyfile works for a domain too). **Until step 9 is done, answer only your own IP**: with no
   GitHub App there is no sign-in and whoever reaches the console is its admin, and once there is, the first person to
   sign in becomes its first admin. Put this first in both sites of the Caddyfile, and take it out in step 9:

   ```caddyfile
   @notme not remote_ip <your IP>
   respond @notme 403
   ```

   Not in the Hetzner firewall instead: certificates need 80 and 443 open to everyone.

   **Done when** `https://<name>/` loads from your IP, and the console's log has `tls: ask listening`.
8. **Server.** Let sessions reach the session API: `ufw allow in on br-<network id> to <gateway> port 7691 proto tcp`,
   with the `woodshed` network's id and gateway from `docker network inspect woodshed`.
9. **You.** On `https://<name>/setup/github`: create the App, install it, and press **Restart the console**.
   **Server.** Set `WOODSHED_REQUIRE_SIGN_IN=1` and restart the service. **You.** Sign in, so you are the first
   admin. **Server.** Only then take the IP fence out of the Caddyfile and reload Caddy.

   **Done when** the log has `console: GitHub App from the setup page` and `auth: signed in`, and opening the console
   from another browser asks to sign in with GitHub.
10. **You.** My settings (a Claude token), Secrets & webhooks (env file secrets, `anthropic-api-key` for sessions not
    on someone's plan, then **Set up webhook**), and **New session**, as on this machine. Invite teammates on
    **People**. A team key goes on the Secrets page only, never in `session-env.json`, which every session reads.
11. **Server.** Back up the Volume on a schedule; Hetzner's backups leave Volumes out. Copy the databases with
    `pg_dumpall` and `mongodump` rather than their live folders. Rebuild the session image when the project file's
    installs change.
12. **You.** Keep it current: the Console settings page's **Woodshed** card says when Woodshed's `main` has commits the
    server lacks, and **Update to latest** pulls them, builds the session image when it changed and restarts the
    console (`providers/local/README.md`, "Staying up to date"). It needs the systemd unit's `Restart=on-failure`.

## Known gaps

Found by running this runbook with an agent. Each is a problem in Woodshed, not a step to skip:

- **The local provider never builds the database template.** On AWS the deploy workflow's session job does. Here, when the project
  file has `databases`, every session's copy waits five minutes for a template and fails with `there is no database
  template`. Until a command for it exists, the only way is a `docker run` of the session image with `template`, as
  `providers/local/dbAdminRunner.mjs` builds one: try a repository without `databases` first.
- **The published session runtime may not be pullable.** The installer then builds it on the machine, which is much
  slower the first time.

## On AWS

`providers/aws/README.md`, "Setting it up", is already a numbered runbook: follow it. Its **you** steps are the AWS
account (one for Woodshed alone), the GitHub App (made by hand on AWS, before Terraform), reading `terraform plan`
before `apply`, the App's Callback URL, client secret and private key right after the apply (uploaded from a shell,
before the console first starts: without them nobody can sign in to set anything), the GitHub environments, the DNS
delegation when there is a `domain`, and the session secrets on the console's Secrets & webhooks page. An agent with AWS credentials in that account can run the rest, and must stop and show the plan
when it changes or destroys anything.

`name_prefix` is required and names every AWS resource: `woodshed` for a new installation. An installation set up
before the setting existed must set `woodshed-cloud`, the name its resources already have, or the plan makes everything
again under the new name and leaves its secrets, Claude homes bucket, images and state behind. Changing it on a live
installation needs a migration of the base box too (its `/etc/fstab` entry and data folders, `providers/aws/README.md`,
"Setting it up", step 2).

Two choices are optional, and an agent should not ask for them as if they were required: a console domain (left out,
the console is named on sslip.io and needs no DNS), and which repos sessions work on. `github_repo` is required, since
the deploy workflow runs there and the session image is built from it, but with `sessions_on_github_repo = false` it is
only that: the console starts with no repo, and its first admin adds them on the Console settings page.

## When a step fails

The console logs a line for nearly everything it does; `CLAUDE.md`, "By symptom", lists the lines by what someone sees
going wrong. Look up the symptom there before changing a setting.
