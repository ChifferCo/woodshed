---
name: woodshed
description: "Use the `woodshed` command line to work with a Woodshed console for the person: sign in, start a cloud session and follow it, list, stop, resume or remove sessions, give one more time before a long task, run a command in a session, carry Claude settings to and from private sessions, and turn on Woodshed's review for a repo. Use when the person asks to start or check a Woodshed session, to run something in one, to keep one from pausing, to sync their Claude settings with Woodshed, or to turn on Woodshed's review for a repo."
---

# Work with Woodshed from the command line

Woodshed runs coding agents in cloud dev environments: a console, and a session (a container with its own branch,
databases and running app) per task. `woodshed` is its command line. It acts as the person who signed it in, with a
token the CLI keeps to itself. You run it for them; you never hold their credentials.

## 1. Check what this CLI has

The command line is growing, and the person's copy may be older or newer than this skill. Before using a command, check
it is there:

```sh
woodshed --help
woodshed session --help     # once `session` is listed
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
- **Herdr's `hc` is the person's to install or update.** `session herdr` exits 3 and says so when it is missing or
  older than it needs: tell them, and do not run an installer or `hc update` for them.
- **Stopping and removing are the person's call.** `session stop` ends the work in progress (a running one's
  work is checkpointed on the way, but exit 0 does not promise it reached GitHub: check the branch before saying so);
  `session remove` deletes the saved conversation. Do either only when asked, and pass `--yes` to `remove` only then.
- **Use the console the person gave you.** `--console <url>`, else `WOODSHED_CONSOLE`, else the last one signed in to,
  else the hosted `https://console.woodshed.run`. On a fresh computer that is the hosted one, so for a self-hosted
  console pass its `--console <url>` to `login` and `status` alike. Plain `http://` is refused except on `localhost`.

## 4. The commands

| Command | Does | Exits | Arrives in |
| --- | --- | --- | --- |
| `woodshed login [--no-browser]` | Prints a code and opens the console's `/cli` page; waits up to 10 minutes for the person to approve | 0 signed in, 2 code expired, 3 denied | main |
| `woodshed logout` | Ends this computer's sign-in | 0 | main |
| `woodshed status` | The console, its org, who is signed in, and the Herdr `hc` here with its version | 0, 2 not signed in | main |
| `woodshed session new [--repo R] [--branch B] [--agent claude\|codex] [--model M] [--no-wait\|--connect\|--herdr] ["prompt"]` | Starts a private session and waits, step by step, until it runs; `--connect` then puts the terminal on its agent's, `--herdr` adds it to Herdr as below | 0 running, 2 needs the person, 1 failed or stopped, 3 a repo they cannot start on, or no `hc` | main |
| `woodshed session connect <id> [--shell]` | Puts the person's own terminal on the session's agent, or its shell; resumes a paused one first. Interactive: suggest it to them, and use `tunnel` yourself | 0 disconnected, 1 could not open, 2 sign-in ended, 3 shared or saw production | main |
| `woodshed session herdr <id>` | Makes one of their sessions a machine in Herdr, `woodshed-<id>`, in the app's sidebar; resumes a paused one first | 0 connected, 2 needs the person, 1 failed, 3 no `hc` 0.1.21 or newer, shared, or saw production | main |
| `woodshed session list [--all]` | Their sessions and the shared ones they see, with state and when each pauses | 0 | main |
| `woodshed session get <id>` | One session: state, branch, pull request, pause, the hours it runs on, its console link | 0, 1 none they can see | main |
| `woodshed session stop <id>` | Stops it, checkpointing a running one's work on the way (waits up to 3 minutes) | 0, 1 not answered in time | main |
| `woodshed session resume <id> [--no-wait]` | Starts one of their stopped sessions again, conversation and all | as `new`; 3 a shared session | main |
| `woodshed session remove <id> [--yes]` | Takes it off the list with its saved conversation, and forgets its Herdr machine | 0, 2 not confirmed, 3 a shared session | main |
| `woodshed session extend <id>` | Puts its pause or stop off by an hour (allowed in its last 15 minutes) | 0, 3 refused | main |
| `woodshed session limits <id> [--idle-hours N\|default] [--lifetime-hours N\|default]` | Its own idle pause and lifetime | 0, 1 out of range, 3 not theirs | main |
| `woodshed settings plan [--pull] [--only …] [--own-files <checkout>]` | Lists what push (or pull) would do with each item; sends and writes nothing | 0 | #278 |
| `woodshed settings push [--only …] [--own-files <checkout>]` | Uploads their Claude settings, skills, MCP servers, and a checkout's ignored env files | 0, 2 not listed before or not confirmed | #278 |
| `woodshed settings pull [--only …] [--replace]` | Writes the shared copy to this computer | 0, 2 something held | #278 |
| `woodshed tunnel <id> -- <line>` | Runs `<line>` with `sh -c` in their running session, in its checkout | the line's code, 255 the pipe failed | main |

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

### Start a session and follow it

```sh
woodshed session new --repo acme/app --branch 123 --json "Fix the login redirect loop"
```

`--branch` takes a branch, or a pull request or issue (`123`, `pr 123`, its URL). A prompt is needed, except on a
branch or pull request, where a session with none starts as a review of it. Without `--repo`, the repo New session
opens on for them. Each start step is a `{"event":"step",…}` line, and the last line is `running`, `needs-you`,
`failed` or `stopped` with the session, whose `url` is its page on the console. On `needs-you` (exit 2), give the
person that `url` and stop. With `--no-wait` the command returns as soon as the console has the session: follow it with
`session get <id> --json`.

A prompt that starts with `-` goes after `--`: `woodshed session new -- "-v is broken"`.

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

### See a session's app

The command line has no command for this. Give the person the session's console page (`url` in `session get --json`),
whose Open app opens it.

### Carry Claude settings

Their private sessions keep Claude settings in step (`settings.json`, `CLAUDE.md`, keybindings, agents, commands,
skills, user-scope MCP servers). `settings` joins this computer to that.

1. `woodshed settings plan` (add `--own-files <checkout>` for that checkout's ignored env files). Show the person the
   whole list: each item, its size, and `upload`, `skip` or `refuse` with why.
2. Push only what they agree to: `woodshed settings push`, with `--only <name>` for a part of it. An item never listed
   before exits 2 until a plan has shown it.
3. For pull, `woodshed settings plan --pull` lists what pull would write and what each item would run on this
   computer (an MCP server's command, hooks, a skill's shell lines). Those are held until a list has shown them, so that
   **the person** sees what will run here. Show them that list and wait for their yes before `woodshed settings pull`.
   Never run `plan --pull` just to unlock a held item. `--replace` overwrites files that differ (a copy of each goes
   under `~/.config/woodshed/backups/`): only when they ask, and preview it with the same flags as the pull
   (`woodshed settings plan --pull --replace`, and the same `--only`), so the list shows what it replaces.

Refused items stay refused: MCP logins, keys in an MCP server's `env` or headers, files that look like secrets. Do not
rename or edit a file to get it past the check.

### Turn on a repo's review

Woodshed's review runs in a review session the console starts, and is turned on in the repo's own project file,
`.woodshed/project.yaml`: its `pullRequests.review` with `runner: woodshed`. The verdict is posted by the console's
reviewer App, so `author` is that App's `<slug>[bot]` login, and `commentAuthor` the console's own App's; `heading`
(required) is how the review's body starts, `rerun` what a commit subject carries to run the review again, and
`workflow` may be left out. Check the file with `node <a Woodshed checkout>/shared/project.mjs check`, run from the
repo, before proposing it. `project.reference.yaml` in a
Woodshed checkout has every field. No GitHub workflow, Actions secret or Anthropic key is involved, so nothing here needs a credential.

A `woodshed review enable` command that writes this and checks the console is ready for it is being built; it is in no
copy of the CLI yet. Until `woodshed --help` lists `review`, make the edit as you would any change to the repo: on a
branch, in a pull request the person reviews. If you don't know the reviewer App's login, ask the person: an admin
makes the App on the console's settings, and it is not something to guess.
