---
name: setup-woodshed
description: Set Woodshed up for someone's GitHub repository, on this machine (Docker), on a server their team reaches (a VM such as Hetzner), or on AWS. Use when asked to install, self-host, deploy or try Woodshed, or to "set Woodshed up for owner/name". Follows docs/self-host.md step by step, runs each step's check, and stops at the steps only the person can do.
---

# Set Woodshed up

`docs/self-host.md` is the runbook and the source of truth: this skill says how to drive it. Read the section for the
place you were given in full before the first command, and follow it in order. Do not work from memory of an older
copy; when this file and the runbook disagree, the runbook wins.

## 1. Know three things before you start

Ask for whichever the request does not say, in one message:

- **The repository**, as `owner/name`.
- **Where**: this machine (to try it), a server the team reaches, or AWS. The table at the top of `docs/self-host.md`
  says what each costs in effort. Someone who only wants to see the console needs none of this:
  `node console/bin/devConsole.mjs`, then `http://localhost:7690/s/aaaa1111`.
- **Where their checkout of that repository is**, if they have one here. Without it, clone it with `gh repo clone`
  into a folder of its own beside this one, never inside this checkout.

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
  `WOODSHED_CLOUD_REQUIRE_SIGN_IN=1` is set and they signed in as the first admin ("On a server", steps 7 and 9).
  On this machine, the console listens on localhost with no sign-in: never expose port 7690.
- **Docker's published ports get past ufw.** On a server, check that nothing (the repo's own compose file included)
  publishes a port on anything but `127.0.0.1`.
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
