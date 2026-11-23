---
name: woodshed
description: "Use the `woodshed` command line to set up Woodshed, sign in, start a session and follow it, list, watch, stop, resume or remove sessions (reviews and QA runs among them), show the person what a session built through its app link (starting the app, or having its agent serve it), give one more time before a long task, run a command in a session, carry Claude settings to and from private sessions, change their My settings choices (terminal, reviews, default repo), turn on Woodshed's review for a repo, and point them at reviewing a session's change on their own terminal. Use when the person asks to set up Woodshed, start or check a session, be told when one starts or finishes, to show me, preview, open the pages of, see in the browser or try what a session built, run something in one, keep one from pausing, sync their Claude settings, change a My settings choice, turn on Woodshed's review for a repo, or review, approve or merge what a session did or its pull request."
---

# Work with Woodshed from the command line

Woodshed runs coding agents in cloud dev environments: a console, and a session (a container with its own branch,
databases and running app) per task. `woodshed` is its command line. It acts as the person who signed it in, with a
token the CLI keeps to itself. You run it for them; you never hold their credentials.

## Start here with `woodshed setup`

Setup's aim is the person's first automated code reviews: Claude Code and Codex reviewing their pull requests on their
repo. If they ask to get started, check `woodshed --help` for `setup`. Use the choices they gave you:

```sh
woodshed setup --yes --json --repo acme/app --reviews default
```

Pass the person's console with `--console <url>` when they use their own. Repeat `--repo` for multiple repos. Each
checklist entry has a `step`, `status`, and `message`. On exit 2, show them the message and any `url` or `userCode` and
stop. Run setup again after they complete that step. They approve the CLI sign-in and install any GitHub Apps in their
browser.

- **Agents (`step: agent`).** Setup asks for both Claude Code and Codex: with both connected, their pull requests get
  reviews from both. While one is missing it exits 2 with My settings' link, and the message says what they run for it
  (`claude setup-token` for Claude; `codex login`, then `~/.codex/auth.json` or an OpenAI API key, for Codex). They
  paste it on My settings themselves: never ask for, read, or pass a token. If they say they use only one, rerun with
  `--agent claude` or `--agent codex`, and setup does not ask for the other.
  Grok Build, Antigravity and OpenCode are not part of setup: a session runs them only on the person's own sign-in,
  pasted on My settings (`grok login` then `~/.grok/auth.json` or an xAI key; a Gemini API key; `opencode auth login`
  then `~/.local/share/opencode/auth.json`), and `woodshed status --json` lists each in `sessionSignIns`.
  After showing them the steps from that exit 2, don't wait for them to say they are done: run the same setup
  command again with `--wait` added (check `woodshed setup --help` lists it; on older builds, rerun when they say).
  It prints the steps again (`status: "waiting"`), asks the console every 5 seconds, reports each agent as it
  connects (`status: "connected"`), and goes on with the rest of setup once both are, for up to 15 minutes
  (`--wait=<N>m` for 1 to 60). Where your harness can run a command in the background and notify you when it exits
  (Claude Code's background Bash), run it that way; otherwise run it in the foreground with a timeout longer than
  the wait (over 15 minutes for a bare `--wait`; use `--wait=<N>m` when your tool's timeout is shorter). Run it once,
  not in a loop: when it exits 2 at `step: agent` (the time ran out), show them the steps again and stop until they
  say. Every other exit 2 (the CLI sign-in, a GitHub App or the reviewer App) is as above: show it and stop.
- **Review on the repo (`repo-review`, `review-choice`).** Every repo is reviewed by default, with no checkout, project
  file or pull request. Setup checks it per repo, exits 2 with the link when the console's reviewer App still has to be
  made or installed (an admin's step), and otherwise says the tag (`tag` in `--json`, `[woodshed-review]` unless the
  repo's project file names another): tell the person that putting it in a commit's message on a pull request gets it
  reviewed, and that sessions add it for them. `--reviews` is their own reviewer choice; `default` runs the most the
  console can, both once both are connected.
- **Reviews of their open pull requests (`pr-reviews`), the main step.** Setup lists their open pull requests on the
  repo and starts the console's review on them, then gives each review's link (`reviews` in the entry). With `--json`
  and no `--yes`, it exits 2 listing them: ask the person which, then rerun with `--review-prs all`, `none`, or numbers
  (`12,15`; with several repos each must be `owner/name#12`). With `--yes` and no `--review-prs` it reviews the 5 updated last.
  With `--reviews none` it starts none. With none open, it says a review starts
  on their next one whose last commit's subject ends with the review's tag (`[woodshed-review]` by default): a session
  adds it to its pushes, and on their own computer they add it themselves. Only a repo whose project file runs its
  review elsewhere (GitHub Actions, or another console by `runsOn`) gets none, and setup says so. Tell them the links when it ends: the final `reviews` entry repeats them.
- **Optional, after that: the agent terminal and a first coding session.** When `woodshed status` shows a compatible
  `hc` and the person hasn't chosen a terminal, ask whether they want Herdr for new private sessions, and pass
  `--terminal herdr` or `--terminal tmux` (check `woodshed setup --help` for it first; on older builds, point them to
  Agent terminal on My settings). Pass `--prompt "<task>"` only when they want a session now; without it setup finishes
  and says how to start one.

Use `--skip-reviews` or `--no-session` when the person chooses to skip those steps.

## 1. Check what this CLI has

The command line is growing, and the person's copy may be older or newer than this skill. Before using a command, check
it is there:

```sh
woodshed --help
woodshed session --help     # once `session` is listed
woodshed repo --help        # once `repo` is listed
```

The table in section 4 says which change each command arrives in. A command `--help` does not list has not shipped in
this copy: tell the person so. Never stand in for it by calling the console's API with `curl`, reading the token, or
running a script with their own credentials.

## 2. Exit codes decide what you do next

Every command uses the same codes:

| Code | Means | What you do |
| --- | --- | --- |
| `0` | Done. | Carry on. |
| `2` | Waiting on a person: a sign-in to approve, a session that needs them, a confirmation, a list they must see first. | Tell the person exactly what is needed, with the link or code the command printed, then **stop**. Do not retry in a loop, and do not try to answer it yourself. |
| `3` | Refused: not theirs, not allowed, an address it will not send a token to. | Report the reason as printed. Do not work around it (another session, another console, a different route, `--yes` they did not ask for). |
| `1` | Anything else: the console not reached, out of range, a bug. | Read the message; retry once if it was the network, else report it. A `session new` or `resume` whose answer was lost may have started anyway: run `session list` before trying again. |

`woodshed tunnel` is the one exception: it exits with the remote line's own code, and `255` when the pipe itself failed
("Run a command in a session", below). It also ignores `--json`: its output is the line's.

Pass `--json` when you will read the output: each command then writes one JSON object per line on stdout. Errors are
`{"event":"error","status":…,"error":…}`.

## 3. Rules

- **Never print, read or pass a token.** The CLI keeps it in the macOS Keychain, libsecret, or
  `~/.config/woodshed/credentials.json`. Do not open that file, query the Keychain for it, put it in an argument, an
  environment variable or a log, or paste it anywhere. The same goes for what a session holds: do not print a session's
  environment or env files.
- **Never approve on the person's behalf.** Sign-ins and approvals are made by the person, in their browser. Do not
  press the button for them with a browser tool.
- **Credentials never go through you.** Anything that needs an admin token or an API key is the console's, set by an
  admin on its pages. Do not ask the person to paste a key or token into the chat, and do not run
  `scripts/enable-review.sh` (it takes their own token and key) for them.
- **Being connected does not keep a session awake.** A session pauses after its idle hours with nothing to do (its own
  agent not working) and stops at its lifetime, whatever tunnels or terminals are open. If you need it longer,
  ask for the time (section 5).
- **Show what a session built through its app link, never from this computer.** When the person asks to see, show,
  preview or open what a session built (show me, open the pages, see it in the browser), give them the session's app
  link (section 5, "See and try a session's app"), started or served by the session first. Do not fetch its branch and
  serve it here on `localhost`, open files from a local checkout, or send raw GitHub file links: that is not what the
  session runs, with its databases and env, and it is not a link they can open from a phone or share. Opening the app
  link in their browser is fine when they ask you to.
- **Herdr's `hc` is the person's to install or update.** `session herdr` exits 3 and says so when it is missing or
  older than it needs: tell them, and do not run an installer or `hc update` for them.
- **Stopping and removing are the person's call.** `session stop` ends the work in progress (a running one's
  work is checkpointed on the way, but exit 0 does not promise it reached GitHub: check the branch before saying so);
  `session remove` deletes the saved conversation. Do either only when asked, and pass `--yes` to `remove` only then.
- **Inside Herdr, sessions go to Herdr.** When you yourself run in a Herdr terminal (`HC_TERMINAL_ID` is set) and
  `woodshed status --json` reports `hc.ok: true`, add each session you start or resume to Herdr unless the person
  says not to: pass `--herdr` to `session new`, and run `session herdr <id>` after a `resume`. Recipes below.
- **Reviewing is the person's, on their terminal.** When a session of theirs has work to look at, suggest they run
  `woodshed review <id>` themselves (section 5, "Review a session's change"): when a session you started or followed
  ends its turn with a pull request open, when `session list` prints `review it: woodshed review <id>`, and whenever
  they ask to review, approve or merge what a session did. It is interactive and every write in it (a comment, a
  verdict, a rename, a merge) goes to GitHub as them: never drive it, and never comment, approve or merge for them
  with `gh` instead. Read `woodshed review <id> --json` yourself when you need to say what changed.
- **Moving is the person's call.** `woodshed move --from herdr` ends the local agents it moves and pushes the work to a branch.
  Run it only when asked, and `--dry-run` first to show them what would move. Programs restart in the session only with
  `--restart auto` or their yes; never pass `--restart auto` for them unasked. For an exit 3 listing secret-looking
  files, tell the person which paths and kinds were flagged. Let them decide how to remove credentials from the work.
- **Use the console the person gave you.** `--console <url>`, else `WOODSHED_CONSOLE`, else the last one signed in to,
  else the hosted `https://console.woodshed.run`. On a fresh computer that is the hosted one, so for a self-hosted
  console pass its `--console <url>` to `login` and `status` alike. Plain `http://` is refused except on `localhost`.

## 4. The commands

| Command | Does | Exits | Arrives in |
| --- | --- | --- | --- |
| `woodshed setup [--yes] [--repo R] [--agent claude\|codex] [--reviews CHOICE] [--review-prs all\|none\|N,N] [--terminal herdr\|tmux] [--prompt TEXT] [--wait[=Nm]]` | Guides sign-in, repos, connecting Claude Code and Codex, and reviews of their open pull requests; then, optionally, the terminal and a first session | 0 done, 2 needs the person, 3 refused, 1 failed | main |
| `woodshed login [--no-browser]` | Prints a code and opens the console's `/cli` page; waits up to 10 minutes for the person to approve | 0 signed in, 2 code expired, 3 denied | main |
| `woodshed logout` | Ends this computer's sign-in | 0 | main |
| `woodshed status` | The console, its org, who is signed in, and the Herdr `hc` here with its version | 0, 2 not signed in | main |
| `woodshed repo list` | Shows connected repos and, for admins, repos available to add and GitHub App access | 0 listed, 2 sign in, 1 failed | main |
| `woodshed repo add <owner/name> [--name N]` | Adds a repo to the console | 0 added, 2 needs GitHub App access or sign-in, 3 refused, 1 failed | main |
| `woodshed repo remove <owner/name>` | Removes a repo and its Woodshed settings | 0 removed, 2 sign in, 3 refused, 1 failed | main |
| `woodshed session new [--repo R] [--branch B] [--agent claude\|codex\|grok\|antigravity\|opencode] [--model M] [--no-wait\|--connect\|--herdr [--parent[=T] [--no-notify] [--end-with-parent]]] ["prompt"]` | Starts a private session and waits, step by step, until it runs; `--connect` then puts the terminal on its agent's, `--herdr` adds it to Herdr as below (by default when you run inside Herdr with `hc` ok), and `--parent` with it makes the session's agent a child of this Herdr terminal (section 5) | 0 running, 2 needs the person, 1 failed or stopped, 3 a repo they cannot start on, no `hc`, or `--parent` outside a Herdr terminal | main |
| `woodshed session connect <id> [--shell]` | Puts the person's own terminal on the session's agent, or its shell; resumes a paused one first. Interactive: suggest it to them, and use `tunnel` yourself | 0 disconnected, 1 could not open, 2 sign-in ended, 3 shared or saw production | main |
| `woodshed session herdr <id> [--parent[=T] …]` | Makes a session a machine in Herdr and shows its Herdr agent in a space named after the session, in a tab named after its agent (never over names the person gave; run it again to pick up a later title). Resumes a paused session first, and re-adds the machine, which a plain `resume` leaves unreachable: run it after every `resume` inside Herdr. With `--parent`, a paused one is resumed waiting for its agent's terminal from this one | 0 connected, 2 needs the person, 1 failed, or `--parent` on a session whose agent's terminal was already there, 3 no `hc` 0.1.21 or newer, shared, saw production, or `--parent` outside a Herdr terminal | main |
| `woodshed session list [--all]` | Their sessions and the shared ones they see, with state, kind (`private`, `shared`, `review`, `qa`, `ask`) and when each pauses; each session's pull request (state, verdict, checks), `review it: woodshed review <id>` under those they can review, and their own open pull requests with no session; in `--json` also a review's or QA's `verdict` once it reported, and whether the console's Mine lists it (`inMine`); names Herdr machines of sessions no longer on the console | 0 | main |
| `woodshed session get <id>` | One session: state, kind, branch, pull request, a review's or QA's verdict, its app and the app's link, pause, the hours it runs on, its console link | 0, 1 none they can see | main |
| `woodshed session app <id> [start [--app NAME] [--no-wait]\|stop]` | A running session's app: whether it is up and its link; `start` starts it and waits up to 5 minutes until it is up, `stop` stops it | 0 up or asked, 2 no app in the project file, 1 not up in time, failed, or still stopping, 3 not running, `stop` with no stop command, or no session apps on this console | main |
| `woodshed session app <id> share [--members on\|off \| --link [--hours 1\|24\|168] [--path /page] \| --revoke <link id>]` | Who besides the person can open their private session's app (the members switch, live links with id, maker and end; never a secret), as the page's Share the app; `--members` switches members on or off, `--link` makes a link anyone can open and prints it once, `--revoke` ends one. Only when they ask: see the recipe | 0, 3 shared, not running, saw production, or a console with app ports, 1 an expiry other than 1, 24 or 168, or an unknown link, 2 sign-in ended | main |
| `woodshed session watch [--kind K,…] [--everyone] [--every S] [--herdr] [--json]` | Follows the console until stopped and prints one event per session that starts, runs, is done with its turn, needs the person, pauses (idle), stops (lifetime, a person), finishes (a review's or QA's with its verdict) or fails, and says when a session's Herdr machine is unreachable; Mine by default. `--herdr` starts it in hc terminal `woodshed-watch` instead, reporting to Herdr, and returns | runs until stopped (`--herdr`: 0 started or kept); 2 sign-in ended, 3 refused or no `hc` | main |
| `woodshed session stop <id>` | Stops it, checkpointing a running one's work on the way (waits up to 3 minutes) | 0, 1 not answered in time | main |
| `woodshed session resume <id> [--no-wait]` | Starts one of their stopped sessions again, conversation and all; inside Herdr, follow it with `session herdr <id>` | as `new`; 3 a shared session | main |
| `woodshed session remove <id> [--yes]` | Takes it off the list with its saved conversation, and forgets its Herdr machine | 0, 2 not confirmed, 3 a shared session | main |
| `woodshed session prune` | Forgets Herdr machines (`woodshed-<id>`, this CLI's tunnel) whose session is no longer on the console; never a paused or stopped one's | 0, 1 `hc` failed | main |
| `woodshed session extend <id>` | Puts its pause or stop off by an hour (allowed in its last 15 minutes) | 0, 3 refused | main |
| `woodshed session limits <id> [--idle-hours N\|default] [--lifetime-hours N\|default]` | Its own idle pause and lifetime | 0, 1 out of range, 3 not theirs | main |
| `woodshed move --from herdr [--terminal T …\|--tab T\|--space S] --to <id>\|new [--restart ask\|auto\|never] [--dry-run]` | Moves terminals on this computer into a session: each agent with its conversation, each shell, each program started again; pushes the work to `woodshed/move-<id>` first, and ends a local agent only once its moved one runs | 0 moved, 2 a moved agent needs the person, 3 a secret in the work, an agent mid-turn, another repo, 1 failed (all undone) | main |
| `woodshed settings plan [--pull] [--only …] [--own-files <checkout>]` | Lists what push (or pull) would do with each item; sends and writes nothing | 0 | main |
| `woodshed settings push [--only …] [--own-files <checkout>]` | Uploads their Claude and Codex settings, skills, plugins, a few dotfiles and ignored checkout files. Imported Claude MCP definitions sync between computers. | 0, 2 not listed before or not confirmed | main |
| `woodshed settings pull [--only …] [--replace]` | Writes the shared copy to this computer | 0, 2 something held | main |
| `woodshed review enable [--qa] [--rerun <tag>\|--every-commit] [--dry-run]` | In a checkout: writes `pullRequests.review` with `runner: woodshed` (and with `--qa`, QA in a session) into `.woodshed/project.yaml`, checks it, and asks the console what is missing | 0 ready to commit, 2 an admin's step or a sign-in, 1 the file does not read or check, or the console could not confirm | main |
| `woodshed review status [--repo R]` | Whether review is on (by default, on `[woodshed-review]`, or by the repo's project file) and what the console still needs; `--repo` needs no checkout | 0 on, 2 not yet, 1 the console could not tell | main |
| `woodshed review pulls [--repo R]` | Their open pull requests on the repo (else the checkout's), and how it is reviewed: on by default, by the project file's review or the console's default, with its tag | 0, 2 sign-in ended, 3 a repo they cannot start on | main |
| `woodshed review start <pull request>... [--repo R]` | The console's review of each of their own open pull requests, now, tag or not; prints each review's link, or the one already reviewing its head | 0 started, 3 not theirs, a draft, or a repo whose project file runs its review elsewhere, 1 failed | main |
| `woodshed review <id>\|<pull request>` | A full-screen review of one of their own sessions' change on their terminal, as the Review tab shows it: the analysis, Q&A, chat with the session's agent, the diff with comments, Re-review, and comment, verdict, rename, merge as them. Interactive: suggest it to them. `--json` (or no terminal) prints the analysis and the diff's summary once, for you | 0, 2 sign-in ended, 3 shared or saw production, 1 failed | main |
| `woodshed tunnel <id> -- <line>` | Runs `<line>` with `sh -c` in their running session, in its checkout | the line's code, 255 the pipe failed | main |
| `woodshed config list` | Their choices on My settings: `terminal`, `reviews`, `codex-reviews`, `claude-token-shared`, `default-repo`, `github-name`, `github-email` | 0 | main |
| `woodshed config get <key>` | One of them, bare (an empty line for none) | 0, 3 unknown key or a secret | main |
| `woodshed config set <key> <value>` | Changes it through My settings' own route and checks | 0, 3 unknown key, invalid value (it lists the valid ones), a secret, or a step only My settings does | main |

"main" is in every copy. A pull request number means the command arrives when that pull request merges; until then,
section 1 applies. Session ids are 8 hex characters, as `session list` prints them.

## 5. Recipes

### Sign in

```sh
woodshed status --json
```

Exit 0: signed in, carry on. Exit 2: not signed in, or the sign-in ended (they last 90 days, and can be revoked on My
settings). Then:

```sh
woodshed login --json          # add --no-browser where no browser can open (a server over SSH)
```

The first line is `{"event":"code","userCode":…,"verificationUrlComplete":…}`. Give the person the code and the link,
and ask them to check the page shows the same code before pressing **Sign in the CLI**. The command waits for them; let
it. Exit 2 means the code expired, 3 that they denied it: say so and stop.

### Choose repos for the console

Run `woodshed repo list --json` and use `projects` for connected repos and `available` for choices to add. `canChange`
tells you whether the person can make changes. `githubAppAccess` is `true` or `false` when known, and `null` otherwise.
Run `woodshed repo add <owner/name> --json --no-browser` for the repo the person asked to add. On exit 2 with
`needs-github-app`, give the person the `url` and ask them to grant access for that repo. Stop and run the same
command again once they say they have done it. Remove a repo with `woodshed repo remove <owner/name>` only when
asked. It also clears that repo's settings in Woodshed.

### Start a session and follow it

```sh
woodshed session new --repo acme/app --branch 123 --json "Fix the login redirect loop"
```

`--branch` takes a branch, or a pull request or issue (`123`, `pr 123`, its URL). A prompt is needed, except on a
branch or pull request, where a session with none starts as a review of it. Without `--repo`, the repo New session
opens on for them. Each start step is a `{"event":"step",…}` line, and the last line is `running`, `needs-you`,
`failed` or `stopped` with the session, whose `url` is its page on the console. On `needs-you` (exit 2), give the
person that `url` and stop. On `running`, also tell them the session runs their repo's app, which they can open and try
in their browser: "See and try a session's app", below. Once it has done its work and opened a pull request
(`session get <id> --json` has `pullRequest`), tell them they can review it on their terminal with `woodshed review
<id>`. With `--no-wait` the command returns as soon as the console has the session: follow it with
`session get <id> --json`.

A prompt that starts with `-` goes after `--`: `woodshed session new -- "-v is broken"`.

### Inside Herdr: add sessions to it

When `HC_TERMINAL_ID` is set (you run in a Herdr terminal) and `woodshed status --json` says `"hc":{…,"ok":true}`, the
person sees their sessions in Herdr's sidebar, so put each one there unless they say not to:

```sh
woodshed session new --herdr --json "Fix the login redirect loop"   # starts it, then adds it to Herdr
woodshed session resume <id> --json && woodshed session herdr <id> --json
```

A resumed session runs a new `hc` core, so its old machine stays unreachable until `session herdr` adds it again; a
Herdr machine whose tunnel says the session is not running is fixed the same way. `session herdr` names the agent's
space after the session's title, which the console sets a few seconds after the start: run it again later to pick the
title up. When `session list` names Herdr machines of sessions no longer on the console, offer `woodshed session prune`.
`hc.ok: false`, or no `HC_TERMINAL_ID`: leave Herdr out unless the person asks.

### Reviews and QA runs on their pull requests

The console starts a review (`Review: …`) on a pull request by itself at a commit whose message has `[woodshed-review]`
(every repo's default), or as the repo's project file's `pullRequests.review` says; and a QA run (`QA: …`) when the file
has `pullRequests.qa` with `runner: woodshed`. `session list --json` gives each `"kind":"review"` or
`"qa"`, `pullRequest` (`number`, `url`), `startedBy`, and `verdict` once it reported (`APPROVE`, `REQUEST_CHANGES`,
`COMMENT`, or QA's conclusion). `inMine: true` is one on the person's Mine on the console: their own pull request's.
A finished one has ended, so it is listed only with `--all`. These run by themselves and are nobody's to resume,
connect to or add to Herdr: to say how one went, read `session get <id> --json`.

To be told as they start and finish, the person (or a Herdr mod) runs a watch, which never opens a session:

```sh
woodshed session watch --kind review,qa --json
```

It runs until stopped, so start it only when asked, in the background or a terminal of its own, and never wait on it
in the foreground. Its first line is `{"event":"watching",…}` (after `unreachable` and
`reachable` when the console was away at the start), then one `{"event":"starting"|"started"|"done"|
"needs-you"|"paused"|"stopped"|"finished"|"failed","at","why"?,"session":{…},"machine"?}` per change. `why` says how
it ended: `paused` is `idle`, `stopped` is `lifetime`, `person`, `deleted` or `other`. `--everyone` watches every
session they can see, not only Mine.

### Keep Herdr told of every session

When the person wants Herdr to tell them as their sessions start, run, need them, pause, stop or fail, without adding
each as a machine:

```sh
woodshed session watch --herdr --json        # starts hc terminal woodshed-watch, and returns
```

It needs `hc` 0.1.21 or newer (exit 3 otherwise: the person installs or updates it). It returns at once with
`{"event":"herdr","action":"started"|"kept"}`: `kept` means one already runs, as it was started; to change its options,
the person runs `hc kill woodshed-watch` first. That terminal reports each session as an OSC 7501 record, which the
Herdr app reads as it does its agents' states. When a session that is a machine in Herdr (`session herdr`) pauses or
stops, the event's `machine` (and the record's message) says `woodshed-<id>` is unreachable until `woodshed session
herdr <id>` brings it back: offer that command, rather than `resume` alone, when the person wants it back in Herdr.

### Start a session as your child in Herdr, and wait on it

When you run in a Herdr terminal (`HC_TERMINAL_ID` is set) and want to hand work to a session and be woken when its
agent ends a turn, blocks, errors or exits:

```sh
woodshed session new --herdr --parent --json "Fix the login redirect loop"
hc wait --children any --json
```

The last line is `connected` with `parent: {"made": true, "address": "woodshed-<id>/t1", …}`: the session's agent runs
as Woodshed starts it, in a terminal that is your child and outlives you (`--end-with-parent` to end it with you,
`--no-notify` for no notes typed into you). With any agent but claude, `parent.reportsStatus` is false: codex, grok, agy and opencode tell
Herdr nothing of their turns, so `hc wait --children` wakes you only when it exits; poll `woodshed session get <id> --json`
for its state instead. `hc read woodshed-<id>/claude` shows its screen; `hc send` types to it.
Exit 3 with `no-parent`: you are not in a Herdr terminal; leave out `--parent`. Exit 1 with `no-parent` from
`session herdr <id> --parent`: that session's agent was already running (`parent.has` is the parent it has, maybe you
from an earlier run, or null), and hc cannot give a running terminal a parent; start a new session with `--parent` instead of restarting theirs. Never run a second agent with `hc run --on
woodshed-<id>` to get a child: it would not have the session's hooks, rules and permissions.

### Before a long task: will the session still be there?

```sh
woodshed session get <id> --json
```

`session.pause` is `{"at":…, "why":"idle"|"lifetime"}` (null while it is busy or not running), and `session.runsOn`
the hours it runs on. Then:

- The pause is within 15 minutes and the task needs longer: `woodshed session extend <id>` (an hour more each time).
- The task needs more than its limits allow: `woodshed session limits <id> --lifetime-hours N` (or `--idle-hours N`,
  for one that will sit idle while you work through a tunnel). `default` goes back to the person's own.
- Exit 3 from either: it is not theirs to change (a shared session is its assignee's). Tell the person; do not try a
  different session.

### Run a command in a session

```sh
woodshed tunnel <id> -- 'git status --short && npm test'
```

The words after `--` are joined into one line, run with `sh -c` as the session's user, in its checkout, with this
command's stdin, stdout and stderr. It opens only into their own running My Woodshed session, never one that has used
production data. Exit 255 with a reason on stderr is the pipe's own failure: not signed in, refused, not reached, or cut.
The line is at most 8 KB: write anything longer to a script in the session first. Closing the tunnel hangs up what the
line started, so start a server that must outlive it with `setsid … &`.

### Review a session's change

When a session of theirs has work ready (its pull request is open, or `session list` prints `review it: woodshed review
<id>` under it), or they ask to review, approve or merge a session's work or pull request, suggest to the person that
they run `woodshed review <id>` themselves, giving the exact command: it is a full-screen review on
their own terminal (in Herdr, say), and every write in it (a comment, a verdict, a rename, a merge) goes to GitHub as
them. Never drive it yourself. To say what the change is, read it with:

```sh
woodshed review <id> --json      # or a pull request: woodshed review 123 --json, or its URL
```

It prints one `review` event: `title`, `pullRequest` (`number`, `state`, `review`, `checks`), `analysis` (`status`,
`overview`, `decisions`, `architecture`) and `diff` (`files`, `additions`, `deletions`, and `groups` of files in the
analysis's reading order, each with its `role` and `preamble`). Opening a review that has no analysis yet starts one,
as the Review tab does; `analysis.status` is then `running`, so read it again a minute or two later. Only their own My
Woodshed sessions open (exit 3 for a shared one or one that saw production data), and a paused one is resumed first. A
pull request with no session of theirs exits 1 and says how to start one on it.

What to tell them it does, briefly: Overview first (the analysis); `2` Q&A, where questions open one at a time and
`i` asks a follow-up on the chosen one; `4` Files changed, every file with what it does, `Enter` to open one, `i` to chat about it,
`c` to comment on a line; `5` Chat with the session's agent; `s` submit a verdict, `m` merge, `t` rename; `o` opens
the pull request on GitHub (in Herdr, Ctrl-click on its underlined number does too); `?` the keys.
For a pull request with no session of theirs, offer to start one on it first
(`woodshed session new --repo <owner/name> --branch <number>`, which starts as a review of it), then `woodshed review`.

### Move work from this computer into a session

```sh
woodshed move --from herdr --space api --to new --dry-run --json   # what would move: the move bundle, nothing done
woodshed move --from herdr --space api --to new                    # or --to <id>: one of theirs on the same repo
```

`--terminal <t>` (repeatable, `hc ls` addresses), `--tab` or `--space` (by id or name, `herdr-app ls`) choose what moves.
Each agent between turns moves with its conversation. If one is mid-turn, wait for it to finish. When the CLI cannot
tell which conversation belongs to a terminal, use `hc label <t> claude.session=<id>` for Claude Code or
`hc label <t> codex.session=<id>` for Codex. Grok Build, Antigravity and OpenCode conversations are not moved yet: the
move refuses them, and a session running one, so leave those terminals out. The session uses its own databases. Ignored files (`.env`) stay local.
`settings push --own-files` gives their sessions their own.

### See and try a session's app

Each session runs the repo's own app (the project file's `app`), with its own databases, at a link of its own. This
link is how the person sees what a session built: whenever they ask to see, show, preview or open it ("show me the
pages", "let me see it in the browser"), and for a preview or a staging link. People often do not know they can open
it, so say so when it helps them too: when a session starts, when its agent says it has finished a change they can
see, or when they ask how to try or check what it built. Never stand in for it with this computer's copy (section 3).
Check `woodshed session --help` lists `app` first (section 1); on an older CLI, give them the session's console page
(`url`), whose Open app opens it.

```sh
woodshed session get <id> --json      # session.app and session.appUrl
woodshed session app <id> start --json  # when it is not up: starts it, waits until it is (one to three minutes)
```

`session.app` is the app's state, and `session.appUrl` the link. Then:

- `running`: give them `appUrl`. When `session.appSignIn` is true, it opens in the browser they are signed in to the
  console with: it is not a public link, so it will not open for someone else, and sharing it is the page's Share the
  app, on the session's ⋯ menu (`url`). When it is false, nobody signs in to the console: the link opens for whoever
  reaches the console, so say neither (with `appLink` `port` there is no Share the app either). When it is null, the
  console does not say: give the link alone.
- `stopped`, `failed` or `frontend-down`: run the start command `woodshed session app <id>` prints (it adds `--app
  <name>` for an app that is not the project's default, so the one that went down is the one started), then give them
  the link it prints. Ask first only when starting it would get in the way of what the session is doing. Exit 1 means
  it did not come up: say so, and where its log is (`woodshed tunnel <id> -- tail -n 50 /tmp/woodshed-app.log`, their
  own sessions only). Exit 1 saying it is still stopping means a stop had not finished: wait a few seconds, check
  `woodshed session app <id>` says it is not running, and start it again.
- `stopping`: wait a few seconds before starting it: a start while it stops is not taken.
- `starting`: it is on its way. `woodshed session app <id>` says again in a minute, or give them the link now.
- `api-down`: the page loads, but its API calls fail: give the link, and say so.
- `none` (exit 2 from `start`): the project file names no app yet. Set up app on the session's console page (`url`)
  has its agent write one: tell them, and stop.
- `app` null, or exit 3: the session is not running (offer `woodshed session resume <id>` for one of theirs), or this
  console serves no session apps.

With several apps (`session.apps`), `--app <name>` starts that one; with another running, the session runs that app's
`stop` first and the command waits through the switch. One with no `stop` in the project file is left running beside
it: say so if they ask why it still answers. `woodshed session app <id> stop` stops it, only when they ask; exit 3 saying
there is no stop command means the project file has no `app.stop`, so nothing was stopped: tell them.

#### When what they want to see is not what the app serves

The app link opens whatever answers on the app's frontend port in the session. When the thing to see is not what the
project file's app serves (static pages in a folder, a docs site, another service in the repo), Start app alone will
not show it: have the session serve it on that port, then give them the app link as above.

Whatever answers on that port reaches everyone the link reaches: with `session.appSignIn` false, whoever reaches the
console, and any Share the app link the owner made. So before serving, check that audience is right for what will show,
and serve only the files meant to be seen: a copy of the built pages with no dotfiles (a `.env.local` Woodshed writes)
and no symlinks, never the checkout or a source folder as it is.

- **Another app of the project file serves it**: `woodshed session app <id> start --app <name>` (`session.apps` lists
  them), and give the link it prints.
- **Otherwise, ask the session's agent** to serve a clean copy of it on the app's frontend port in the session, with
  the project's app stopped first (`woodshed session app <id> stop`, when the person agrees: it stops what the session
  runs). The link follows the app the session runs, `session.appName`: the port is that app's, and while it still
  answers the link shows it, not the copy. Its agent knows the ports and the checkout. Reach it in Herdr with `hc send
  woodshed-<id>/claude "<ask>"` (after `woodshed session herdr <id>`, between its turns), else point the person at the
  Chat tab on the session's console page (`url`) or `woodshed session connect <id>` to ask it themselves.
- **Or serve it yourself through the tunnel**, for one of their own sessions, the same way. Read the port with
  `woodshed tunnel <id> -- node /opt/woodshed/shared/project.mjs get app` (`frontendPort`); with several apps, `get
  apps` prints one per line, and the one whose `name` is `session.appName` is the port. The line below copies only the
  pages' plain files, no dotfiles or symlinks, into a new folder (never refilling one a server serves), stops the
  preview it started before, and starts one that outlives the tunnel with `setsid`, as closing the tunnel hangs up what
  it started:

  ```sh
  woodshed tunnel <id> -- 'd=$(mktemp -d /tmp/preview.XXXXXX) && (cd site && find . -name ".*" ! -name . -prune -o -type f -exec cp --parents {} "$d" \;) && { kill $(cat /tmp/preview.pid 2>/dev/null) 2>/dev/null; sleep 1; setsid python3 -m http.server <frontendPort> --bind 127.0.0.1 -d "$d" >/tmp/preview.log 2>&1 </dev/null & echo $! >/tmp/preview.pid; }'
  ```

Then `woodshed session app <id>` says `running` (or `api-down` when the project's app has a backend of its own that is
not running: the pages still open), and the link shows it. A project file with no app (`none`) has no port for the link
to reach: Set up app first, as above. If the person will want this again in later sessions, suggest
adding it to the repo's `.woodshed/project.yaml` as a named app (`apps`, each with a `name`, so `--app <name>` and
Start app ▾ start it), in an ordinary pull request: the `write-project-file` skill in Woodshed's repository
(`.claude/skills/write-project-file/`), and its `project.reference.yaml`, say how.

### Share a session's app

Only when the person asks to let someone else see or try their session's app. Check `woodshed session --help` lists
`app <id> share` first (section 1); on an older CLI, point them at Share the app on the session's console page (`url`):
the Share button beside its app button, or Share the app… in its ⋯ menu. What the share
opens is whatever answers on the app's port: get that right first with "See and try a session's app" above, and serve
only what is meant to be seen there, since everyone the share reaches sees it too.

```sh
woodshed session app <id> share --json                   # who can open it now
woodshed session app <id> share --members on --json      # everyone signed in to the console
woodshed session app <id> share --link --json            # a link anyone can open, for a day (--hours 1 or 168)
woodshed session app <id> share --revoke <link id>       # end one link
```

- Prefer `--members on` when the people are members of the console: it needs no secret and `--members off` takes it
  back. Make a `--link` only for someone with no account here, or when the person asks for one. `--path /landing-a`
  makes it open on that page of the app.
- A link is a secret, printed once: give it to the person in your reply, and say anyone who has it can use the app as
  the session's signed-in user, changing its data, until it expires or is revoked. Never post it anywhere yourself (a
  pull request, an issue, Slack, a commit, a file), never put it in a command another program logs, and never print
  it again: `session app <id> share` lists links without it.
- Sharing ends when the session pauses or stops, and a resumed session is private again: tell them when it pauses
  (`session get <id>`), and offer `woodshed session limits <id>` when the sharing must outlast that.
- Exit 3: a shared session (its app is already open to who can open the session), one not running (offer `resume`), one
  that has seen production data, or a console with app ports (nobody signs in: its link already opens for whoever
  reaches it). Report it; do not work around it.

### Change a choice on My settings

```sh
woodshed config list --json
woodshed config set terminal herdr --json
```

Keys and values: `terminal` (`tmux`, `herdr`), `reviews` (`none`, `claude`, `codex`, `both`, `default`),
`codex-reviews` and `claude-token-shared` (`on`, `off`), `default-repo` (`owner/name`), `github-name`, `github-email`.
Change one only when the person asks. `set` prints a `note` when the change reaches only sessions started after it
(`terminal`: running sessions keep theirs); pass it on. Exit 3 is final: an invalid value says `Valid: …` (pick from
that, or ask), and `On My settings: <link>` means a step only the person does on the page first (save a Claude token or
Codex sign-in, connect GitHub): give them the link and stop. Secrets are never set here: `config set claude-token` and
the like refuse without sending anything. Never ask the person for a token to get past that.

### Carry Claude settings

Their private sessions keep Claude settings in step (`settings.json`, `CLAUDE.md`, keybindings, agents, commands,
skills, user-scope MCP servers), Codex's (`~/.codex`'s `config.toml`, `AGENTS.md`, prompts, skills) and the plugins they
installed. `settings` joins this computer to that. Imported Claude MCP definitions sync between computers. Codex MCP
definitions from a computer stay on that computer.
`settings` also saves their git, readline and alias lines on My settings (`dotfile/gitconfig`, `dotfile/inputrc`,
`dotfile/bash-aliases`), which replace what My settings had.

1. `woodshed settings plan` (add `--own-files <checkout>` for that checkout's ignored env files). Show the person the
   whole list: each item, its size, and `upload`, `skip` or `refuse` with why.
2. Push only what they agree to: `woodshed settings push`, with `--only <name>` for a part of it. An item never listed
   before exits 2 until a plan has shown it. Push with an `--only` that leaves out `dotfiles` unless the person named
   one (`--only dotfile/gitconfig`): a dotfile replaces their lines on My settings. A pull
   never installs a plugin: its list gives the `claude plugin install` for them to run if they want it.
3. For pull, `woodshed settings plan --pull` lists what pull would write and what each item would run on this
   computer (an MCP server's command, hooks, a skill's shell lines). Those are held until a list has shown them, so that
   **the person** sees what will run here. Show them that list and wait for their yes before `woodshed settings pull`.
   Never run `plan --pull` just to unlock a held item. `--replace` overwrites files that differ (a copy of each goes
   under `~/.config/woodshed/backups/`): only when they ask, and preview it with the same flags as the pull
   (`woodshed settings plan --pull --replace`, and the same `--only`), so the list shows what it replaces.

Refused items stay refused: MCP logins, keys in an MCP server's `env` or headers, files that look like secrets. Do not
rename or edit a file to get it past the check.

### Turn on a repo's review

Woodshed's review runs in a review session the console starts, and is on for every repo by default: a commit whose
message has `[woodshed-review]` gets its pull request reviewed, and sessions add the tag themselves. Nothing to turn on
or commit. `woodshed review status --repo <owner/name>` says whether it is on and what the console still needs (exit 2
lists each step, such as the reviewer App: tell the person and stop).

To review every commit, use another tag, or add QA in a session, write it into the repo's own project file,
`.woodshed/project.yaml` (its `pullRequests.review` with `runner: woodshed`, which then wins). In a checkout of the
repo, on a branch:

```sh
woodshed review enable --dry-run   # what it would change
woodshed review enable             # writes it, checks it, and asks the console what is missing
```

It changes those lines alone and leaves out `author` and `commentAuthor`, which the console fills in with its reviewer
App's and its own App's logins: do not add them. Exit 0: commit the file and open a pull request the person reviews;
the review starts once it is merged. Exit 2: each missing step is printed (the reviewer App not made, or not installed
on the repo, or `runsOn` naming another console): tell the person and stop. Those are an admin's, on the console or
on GitHub. Exit 1: the file does not read, `project check` found a problem, or the console could not say it can run
the review; it says which. `woodshed review status` says later whether it is on. No GitHub workflow, Actions secret or
Anthropic key is involved, so nothing here needs a credential.
