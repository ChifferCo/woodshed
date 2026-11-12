---
name: setup-woodshed
description: Set Woodshed up on this machine (Docker, with the repository picked afterwards in the console), or for someone's GitHub repository on a server their team reaches (a VM such as Hetzner) or on AWS. Use when asked to install, self-host, deploy or try Woodshed, or to "set Woodshed up for owner/name". Briefs the person up front on what it will do and everything it needs from them, then follows docs/self-host.md step by step, runs each step's check, and stops at the steps only the person can do.
---

# Set Woodshed up

`docs/self-host.md` is the runbook and the source of truth: this skill says how to drive it. Read the section for the
place you were given in full before the first command, and follow it in order. Do not work from memory of an older
copy; when this file and the runbook disagree, the runbook wins.

## 1. Up front: one briefing, then wait for a go

The person should hear everything you need from them and everything you will do before anything changes, not find
out one step at a time. Send it as one message, and change nothing on the machine until they answer.

**Before anything, GitHub's CLI.** Every place runs on `gh`: run `command -v gh` and `gh auth status` first. When `gh` is
missing, tell them how to install it (`brew install gh` on a Mac, https://cli.github.com otherwise) and wait; when it is
not signed in, ask them to type `! gh auth login` at the prompt. Do not go on until `gh auth status` passes: on this
machine the console and every session run on that login, and the repos they can pick are the ones it can push to.

**First, ask where**, unless the request says: this machine (to try it), a server the team reaches, or AWS, with the
effort column of the table at the top of `docs/self-host.md`. For a server or AWS, also the repository as
`owner/name` if not given. **On this machine, do not ask for the repository**: the install names none, and they pick
it afterwards in the console (Console settings, Repos, **Add a repo**, which lists what their `gh` login can push to),
so picking one never holds the setup up. A repository named in the request is fine: it is the one to add in the console
then, not an install setting. For this machine, ask in the same message:

- **Other devices?** Will they open it from their phone or another computer, through Tailscale? If so, run
  `tailscale status` (on a Mac, `/Applications/Tailscale.app/Contents/MacOS/Tailscale status` when it is not on the
  PATH): it must be up, with MagicDNS and HTTPS certificates on in the tailnet's DNS settings.
- **Only them, or others too?** Only them: no sign-in and no GitHub App, the tailnet is the gate, and each session's
  app opens on a port of the machine's name (`WOODSHED_TAILSCALE=1`). Check that `tailscale status` lists only their
  own devices, and say which are not if any. Owning every device is not enough: a server on the tailnet that other
  people have a shell on (a shared dev box, a CI runner, a teammate's VM) reaches a console with no sign-in as them.
  List the Linux and server peers from `tailscale status` and ask about each: who else logs in to it? Any with other
  people on it means "others too", or taking that machine off the tailnet first. Only them also means this, said once
  and plainly: sessions use this machine's Docker (for a repo's compose services, Supabase local or Testcontainers),
  so Claude in a session can do anything on this machine. `WOODSHED_SESSION_DOCKER=0` turns that off. Others too: the GitHub App and sign-in become required, and Open app needs
  a domain of their own (`WOODSHED_TAILSCALE=shared`), and anyone who can start a session has this machine through its
  Docker, as on a server (step 1 of the briefing). `docs/self-host.md`, "From your other devices", has both.

Someone who only wants to see the console needs none of this:
`node console/bin/devConsole.mjs`, then `http://localhost:7690/s/aaaa1111`.

**Then run the read-only checks** for that place, so the briefing says what is already in place:

| Where | Checks |
| --- | --- |
| This machine | `docker info`, `docker compose version`, `node -v` (22 or later), `git --version`, `gh auth status`, and with Tailscale `tailscale status --json` (its `Self.DNSName`, and the other peers' owners and OS: the Linux and server ones are the ones to ask about) |
| A server | The same, on the server over SSH once they gave you access; here, only `gh auth status` and the repository |
| AWS | `aws sts get-caller-identity` (and that the account holds nothing but Woodshed), `terraform version`, `gh auth status`, `gh repo view owner/name --json viewerPermission` (ADMIN, for the environments and variables) |

A missing login is fixed by the person in this session: tell them to type `! gh auth login` (or `! aws sso login`, and
the like) at the prompt, so its output lands here. Never ask for a token in the chat.

**Then the briefing**, short, in this order:

1. **What it will do**: what gets installed and where (`~/.woodshed` on this machine; the packages, a systemd unit and
   Caddy on a server; the Terraform in their AWS account and roughly what it costs idle, from `providers/aws/README.md`,
   "Costs"), what runs afterwards and on which address, what is open to the network and what is not, and how long the
   slow part takes (the session image's first build: a few minutes on this machine, where it holds no repository;
   several on a server or AWS; longer with no published runtime). On a server, and on this machine when others use it,
   say this plainly, once, and ask nothing about it: sessions use the machine's Docker, so anyone who can start a
   session (a GitHub label or comment included) gets root on the machine. That reaches the secrets key, so every stored
   secret and Claude token, and every other session's containers and databases. Only people they would give root on
   the box should be able to start sessions there, or `WOODSHED_SESSION_DOCKER=0` turns it off. AWS sessions never get
   it.
2. **What the checks found**: what is ready, and what they must fix first.
3. **Everything you will need from them, start to finish**, from the table below, each with when in the order it comes,
   so they can line it up now (an organization owner to approve the GitHub App, a dev API key for an env file).
4. **The order**, in one line each. On this machine: the checks, the install (no repository, with Tailscale when they
   chose it), the console up, then on their phone or browser: **Add a repo** on Console settings, the project file for
   that repo when it has none (you write it), their Claude token, the first session. The GitHub App is optional for
   them alone; when others use it, it comes first on the console, before the repo. On a server or AWS: the project
   file, the install, the GitHub App, their Claude, the first session.

Then ask them to say go.

### What the person does, by place

| Where | From them |
| --- | --- |
| Every place | Commit (or merge your pull request of) `.woodshed/project.yaml` to the default branch. On this machine, first pick the repository on the console's Console settings, Repos (**Add a repo**). On a server or AWS, make the GitHub App: a few clicks in the browser, on the repository's organization or their account, and an organization may need an owner to approve it. On this machine it is optional: sessions push as them with their `gh` sign-in, so leave it out unless they ask for one. Give sessions a Claude: run `claude setup-token` in their own terminal and save it on **My settings**, or an Anthropic API key on **Secrets & webhooks**. A dev value for each env file `secret` the project file names (never production) |
| This machine, with Tailscale | Tailscale signed in on this machine and the devices they will use, MagicDNS and HTTPS certificates on. Only them: nothing more. Others too: making the GitHub App at `https://<name>/setup/github` the moment the console runs, then signing in first, so they are its admin, and adding the others on People |
| A server, also | The machine (Ubuntu 24.04, about 4 GB a session) and SSH access to it for you. A firewall in their provider's panel. A name: a domain with an `A` and a wildcard record, or none with sslip.io. Their own IP, for the fence until sign-in. Signing in first, so they are the first admin |
| AWS, also | An AWS account for Woodshed alone, with credentials in this shell. A domain to delegate, with NS records at its parent's DNS. An email for the budget alerts. The GitHub App made by hand (its permissions are in `providers/aws/README.md`, "Setting it up", step 2), its private key uploaded on the console later. Approving each Terraform apply after reading its plan |

Everything else is yours: say so in the briefing, so they know the list above is the whole of it.

### The person's steps come as early as they can

- **The GitHub App first**, where it is needed. On AWS it is the first step anyway, before Terraform. On a server, it
  is made from the console's `/setup/github` page, so it can only come once the console runs: start the console the
  moment the runbook allows and make the App the first thing they do on it.
- **Fill the waits.** While the session image builds, ask them for what does not need the console: `claude setup-token`
  in their own terminal (they keep the token to paste on **My settings**), the env file values ready, on a server the
  DNS records and firewall, on AWS the NS delegation as soon as Terraform printed the nameservers.

## 2. The project file: first on a server or AWS, after the repo is picked on this machine

On a server or AWS, the repository's `.woodshed/project.yaml` is written and checked before anything is installed:
use the `write-project-file` skill. Its databases decide which engines the install starts, and its installs what the
session image builds, so an install run before it is an install run again.

On this machine the install builds nothing from it: sessions clone the repository and read the file at start. Once the
person added a repo on the console, check its default branch for one (`gh api repos/<owner>/<name>/contents/.woodshed/project.yaml`
answers 404 when it has none) and write it then, with the same skill, in a checkout cloned with `gh repo clone` beside
this one, never inside it. When the file has `databases`, or env files with a `secret`, the install must be made for
that repository to host them: run the installer again with `WOODSHED_REPO=<owner>/<name>` (and the same
`WOODSHED_TAILSCALE`), as "On this machine", step 5, says, and restart the console. Say so in the briefing once you
know, since that run builds the repository's own image (several minutes).

## 3. Follow the section, step by step

| Where | Section of `docs/self-host.md` | Depth, when a step needs more |
| --- | --- | --- |
| This machine | "On this machine" (no repository named: the install asks for none) | `providers/local/README.md`, "Setting it up" |
| A server | "On a server" | `providers/local/README.md`, "On a server your team reaches" and "Session apps without a wildcard certificate" |
| AWS | "On AWS" | `providers/aws/README.md`, "Setting it up" |

For each step:

1. Say which step you are on, in one line.
2. **Agent** and **Server** steps: run them. Keep long-running processes in the background with their log in a file
   (the runbook gives the command), never in the foreground where they hold the terminal.
3. Run the step's **Done when** check and quote what it printed. A step is done when its check passes, not when its
   command exited 0.
4. **You** steps: stop. Tell the person exactly what to do (the URL, the button, the command to run in their own
   terminal), what they will see when it worked, and wait for them to say so. Then run the check that follows it
   yourself, such as the log line `console: GitHub App from the setup page`.

**You** steps are the ones that need a browser, an account, money, a token or a decision: making the GitHub App,
`claude setup-token`, an AWS account, DNS records, a firewall in a provider's panel, approving a Terraform apply.
Never try to do them for the person, and never ask them to paste a token or key into this conversation: they save it
on the console's pages themselves.

## 4. Rules that hold everywhere

These come from `CLAUDE.md`, "Rules"; read it if a step touches secrets.

- **Never print a secret's value.** Check a secret by `node providers/local/bin/secret.mjs list` (names only) or a call
  that prints only a status code. Pass a value to a tool on stdin, never on its command line.
- **No production credentials in a session.** An env file's secrets are the dev setup's keys only. A team-wide key
  goes on the Secrets & webhooks page, never in `session-env.json`, which every session reads.
- **Nothing open before sign-in.** On a server, the proxy answers only the person's IP until the GitHub App is made,
  `WOODSHED_REQUIRE_SIGN_IN=1` is set and they signed in as the first admin ("On a server", steps 7 and 9).
  On this machine, the console listens on localhost with no sign-in: never expose port 7690, except to their own
  tailnet with `tailscale serve`, and never with `tailscale funnel`, which opens it to the internet. A tailnet with
  anyone else's devices on it takes the "others too" way, with sign-in.
- **Docker's published ports get past ufw.** On a server, check that nothing (the repo's own compose file included)
  publishes a port on anything but `127.0.0.1`.
- **AWS: `name_prefix = "woodshed"` for a new installation.** It names every AWS resource and has no default. One set up
  before it existed must set `woodshed-cloud`, or it loses its secrets, Claude homes bucket, images and state to a plan
  that makes everything again under the new name. Never change it on a live installation.
- **AWS: read `terraform plan` before every `apply`.** The first plan only creates. If one changes or destroys
  anything, stop and show the person the lines that do, before applying. Use an account that holds nothing but
  Woodshed (`providers/aws/README.md`, "How it is built").

## 5. Known gaps

`docs/self-host.md`, "Known gaps", lists problems in Woodshed that the runbook cannot step round yet (the local
provider's database template, among others). Read it before the first session when the project file has
`databases`, and tell the person which of them they will hit. On this machine, such a repo also needs the install made
for it (section 2), or the console refuses its sessions and says the command.

## 6. When a step fails

Do not change settings to see what helps. Use the `debug-woodshed` skill: the console logs a line for nearly
everything it does, and `CLAUDE.md`, "By symptom", says what each one means. If the runbook itself was wrong or
missing a step, say so at the end, with what you did instead, so it can be fixed in `docs/self-host.md`.

## 7. Finish with

- What runs where: the console's URL, how to start it again (`~/.woodshed/bin/woodshed` on this machine, the systemd
  unit on a server, the deploy workflow on AWS), and where its log is.
- Every **You** step still open, in order.
- What to back up: on this machine and a server, the secrets key apart from the rest (losing it loses every secret).
