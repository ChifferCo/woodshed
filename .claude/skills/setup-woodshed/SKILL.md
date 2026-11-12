---
name: setup-woodshed
description: Set Woodshed up for someone's GitHub repository, on this machine (Docker), on a server their team reaches (a VM such as Hetzner), or on AWS. Use when asked to install, self-host, deploy or try Woodshed, or to "set Woodshed up for owner/name". Briefs the person up front on what it will do and everything it needs from them, then follows docs/self-host.md step by step, runs each step's check, and stops at the steps only the person can do.
---

# Set Woodshed up

`docs/self-host.md` is the runbook and the source of truth: this skill says how to drive it. Read the section for the
place you were given in full before the first command, and follow it in order. Do not work from memory of an older
copy; when this file and the runbook disagree, the runbook wins.

## 1. Up front: one briefing, then wait for a go

The person should hear everything you need from them and everything you will do before anything changes, not find
out one step at a time. Send it as one message, and change nothing on the machine until they answer.

**First, ask where**, unless the request says: this machine (to try it), a server the team reaches, or AWS, with the
effort column of the table at the top of `docs/self-host.md`. Also the repository as `owner/name` if not given, and
where their checkout of it is, if they have one here (without one, clone it later with `gh repo clone` into a folder
beside this one, never inside this checkout). Someone who only wants to see the console needs none of this:
`node console/bin/devConsole.mjs`, then `http://localhost:7690/s/aaaa1111`.

**Then run the read-only checks** for that place, so the briefing says what is already in place:

| Where | Checks |
| --- | --- |
| This machine | `docker info`, `docker compose version`, `node -v` (22 or later), `git --version`, `gh auth status`, `gh repo view owner/name --json viewerPermission` |
| A server | The same, on the server over SSH once they gave you access; here, only `gh auth status` and the repository |
| AWS | `aws sts get-caller-identity` (and that the account holds nothing but Woodshed), `terraform version`, `gh auth status`, `gh repo view owner/name --json viewerPermission` (ADMIN, for the environments and variables) |

A missing login is fixed by the person in this session: tell them to type `! gh auth login` (or `! aws sso login`, and
the like) at the prompt, so its output lands here. Never ask for a token in the chat.

**Then the briefing**, short, in this order:

1. **What it will do**: what gets installed and where (`~/.woodshed` on this machine; the packages, a systemd unit and
   Caddy on a server; the Terraform in their AWS account and roughly what it costs idle, from `providers/aws/README.md`,
   "Costs"), what runs afterwards and on which address, what is open to the network and what is not, and how long the
   slow part takes (the session image's first build: several minutes, longer with no published runtime).
2. **What the checks found**: what is ready, and what they must fix first.
3. **Everything you will need from them, start to finish**, from the table below, each with when in the order it comes,
   so they can line it up now (an organization owner to approve the GitHub App, a dev API key for an env file).
4. **The order**, in one line each: the project file, the install, the GitHub App (not on this machine, where it is
   optional), their Claude, the first session.

Then ask them to say go.

### What the person does, by place

| Where | From them |
| --- | --- |
| Every place | Commit (or merge your pull request of) `.woodshed/project.yaml` to the default branch. On a server or AWS, make the GitHub App: a few clicks in the browser, on the repository's organization or their account, and an organization may need an owner to approve it. On this machine it is optional: sessions push as them with their `gh` sign-in, so leave it out unless they ask for one. Give sessions a Claude: run `claude setup-token` in their own terminal and save it on **My settings**, or an Anthropic API key on **Secrets & webhooks**. A dev value for each env file `secret` the project file names (never production) |
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

## 2. The project file comes first

Whatever the place, the repository's `.woodshed/project.yaml` is written and checked before anything is installed:
use the `write-project-file` skill. Its databases decide which engines the install starts, and its installs what the
session image builds, so an install run before it is an install run again.

## 3. Follow the section, step by step

| Where | Section of `docs/self-host.md` | Depth, when a step needs more |
| --- | --- | --- |
| This machine | "On this machine" | `providers/local/README.md`, "Setting it up" |
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
  On this machine, the console listens on localhost with no sign-in: never expose port 7690.
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
`databases`, and tell the person which of them they will hit.

## 6. When a step fails

Do not change settings to see what helps. Use the `debug-woodshed` skill: the console logs a line for nearly
everything it does, and `CLAUDE.md`, "By symptom", says what each one means. If the runbook itself was wrong or
missing a step, say so at the end, with what you did instead, so it can be fixed in `docs/self-host.md`.

## 7. Finish with

- What runs where: the console's URL, how to start it again (`~/.woodshed/bin/woodshed` on this machine, the systemd
  unit on a server, the deploy workflow on AWS), and where its log is.
- Every **You** step still open, in order.
- What to back up: on this machine and a server, the secrets key apart from the rest (losing it loses every secret).
