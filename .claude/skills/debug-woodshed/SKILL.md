---
name: debug-woodshed
description: Find out why something in a running Woodshed installation is not working, from what the console and sessions log. Use when a session will not start or fails at start, sign-in fails, a label or /woodshed comment does nothing, a database copy, the app, webhooks, Slack posts or a secret misbehave, or a setup step's check does not pass. Not for changing Woodshed's code.
---

# Debug a Woodshed installation

The console logs a line for nearly everything it does, and sessions log each start step (`[woodshed …]`).
`CLAUDE.md`, "By symptom", maps what someone sees going wrong to the lines that say why. Work from the log, not from
guesses: never change a setting, restart a service or delete state to see whether it helps.

## 1. Pin the symptom down

Get, from the person or the page: what they did, what they saw (the console's words, an error in the session), and
when. The console shows a failed session's reason on its page; start there.

## 2. Find the entry

Search `CLAUDE.md` for the words the person saw, then for the area (`sign-in`, `webhook`, `database`, `template`,
`Claude home`, `Slack`, `app`). Read the whole "By symptom" entry: it names the log lines to look for and what each
means. The secrets table in `CLAUDE.md`, "The secrets", says what breaks when each one is wrong.

## 3. Read the logs where this installation keeps them

| Provider | Console log | A session's log |
| --- | --- | --- |
| This machine (`install.sh`) | `~/.woodshed/console.log` when started as `docs/self-host.md` says, else the terminal that runs `~/.woodshed/bin/woodshed` | `docker logs <container>`; `docker ps -a --filter label=woodshed.session` lists them (`label=woodshed-cloud.session` for one started before that label) |
| A server | `journalctl -u <unit>` | As on this machine |
| AWS | On the base box: `cd /opt/<name_prefix> && sudo docker compose logs console` (`name_prefix` is in the installation's tfvars: `woodshed`, or `woodshed-cloud` for one set up before it existed) | `aws logs tail /<name_prefix>/sessions`, stream `session/session/<taskId>`; `aws ecs describe-tasks` for `stoppedReason` |

`CLAUDE.md`, "Where everything is", has the rest for AWS (database admin runs, webhooks, images, state). Inside a
running session, its own logs are under `/tmp` (`/tmp/woodshed-app.log`, `/tmp/pgweb.log` and the others "By symptom"
names).

Filter for the lines the entry named, such as `grep -E 'auth:|githubSetup:'`. Quote the lines you found, with their
time, when you explain the cause.

## 4. Rules while debugging

From `CLAUDE.md`, "Rules":

- **Never print a secret's value**, in a command's output or its arguments. Check a secret by its name in a list
  (`node providers/local/bin/secret.mjs list`, `aws secretsmanager describe-secret` for `LastChangedDate`) or by a
  call that prints only its status code. Pass a token to curl on stdin (`-K -`).
- **Never read someone's saved Claude home or database**: list names and sizes only.
- **AWS: read `terraform plan` before every `apply`**, and stop to show the person anything it changes or destroys.
- A fix that needs a browser, an account or a decision (a GitHub App setting, a DNS record, a new token) is the
  person's: say exactly what to do, then check the log line that shows it worked.

## 5. Report

The cause, the log lines that show it, the fix (what you did, or what the person must do), and the line that shows the
fix worked. If "By symptom" had no entry for it, or a wrong one, say so, so `CLAUDE.md` can gain it.
