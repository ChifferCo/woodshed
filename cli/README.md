# The woodshed command line

`woodshed` signs in to a Woodshed console from your computer, says who is signed in, and asks for a repo's review to be
turned on. Later commands (sessions, tunnels, settings) are added here. It is plain Node 22 with no dependencies, like
the rest of Woodshed.

## Running it

From a checkout of this repository:

```sh
node cli/woodshed.mjs login --console https://console.example.com
node cli/woodshed.mjs status
```

To type `woodshed` instead, link it onto your PATH once:

```sh
ln -s "$PWD/cli/woodshed.mjs" ~/.local/bin/woodshed
```

An installer (`curl … | bash`, npm) comes later.

## Commands

| Command | What it does | Exits |
| --- | --- | --- |
| `woodshed login` | Asks the console for a code, prints it, and opens the console's `/cli` page in your browser. Check the page shows the same code and press **Sign in the CLI**. The token it gets is kept as below. Signing in again on the same computer ends its earlier sign-in. | 0 signed in, 2 the code expired with nobody approving it, 3 denied |
| `woodshed logout` | Ends the token at the console and forgets it here. | 0 |
| `woodshed status` | The console's name and address, its org (the GitHub account its repos are on), and who is signed in. | 0 signed in, 2 not signed in or the sign-in ended |
| `woodshed review enable\|status\|list` | Turn on Woodshed's review for a repo by a request an admin of it approves: see "Review". | 0 applied, 2 waiting on an approval or expired, 3 refused, 1 failed |

Every command takes:

- `--console <url>`: the console to use. Without it, `WOODSHED_CONSOLE`, else the one you last signed in to, else
  `https://console.woodshed.run`. A bare name gets `https://`. Plain `http://` is refused except on this machine
  (`localhost`, `127.0.0.1`), so a token never crosses a network in the clear.
- `--json`: one JSON object per line on stdout. `login` writes `{"event":"code",…}` with the code and address first,
  then `{"event":"signed-in",…}`; a failure is `{"event":"error","status":…,"error":…}`.

`login` also takes `--no-browser`, which prints the address instead of opening it (on a server over SSH, say).

Exit codes, for every command: `0` done, `2` waiting on a person (sign in, or approve), `3` refused (denied, or an
address it will not send a token to), `1` anything else (the console not reached, a console from before the command
line).

## Review

`woodshed review` asks the console to turn on Woodshed's review (and QA) for a repo, as `scripts/enable-review.sh`
does, without anyone holding an admin token or the Anthropic key: an admin of the repo approves the request on its page
in the console, which applies it with its own GitHub App and key (console/README.md, "Turning on a repo's review").

```sh
woodshed review enable acme/game            # asks, prints the approval page, waits until it is decided
woodshed review enable --qa acme/game       # QA too, in the repo's CI (--qa-runner woodshed: as a Woodshed session)
woodshed review enable --no-wait acme/game  # returns at once with exit 2 and the page
woodshed review status <id> [--wait]        # one request: its steps, and for those who can write to the repo, the plan
woodshed review list                        # the requests you asked for, newest first
```

`enable` exits `0` once the request is applied, `3` when it is refused or withdrawn, `1` when a step failed (which one,
and GitHub's reason, for those who can write to the repo), and `2` when it expired after 24 hours with nobody deciding,
or at once with `--no-wait`. `status` exits the same for the request's state, `2` while it waits. Ctrl-C stops the wait,
never the request. `--ref <commit>` pins an older commit of Woodshed's workflows, one Woodshed's main has. With `--json`,
`enable` writes `{"event":"requested",…}` with the request and its `url`, then `status` and `step` events, and
`{"event":"done",…}` with its `outcome`: `applied`, `refused`, `failed` or `expired`. An agent stops at exit `2` and
hands the person the link.

The token reaches only the review setup's `GET /api/review-setup`, `POST /api/review-setup` and
`GET /api/review-setup/<id>`, as you and never as a console admin: approving and refusing are done on the page. In a
Woodshed session there is no command line token: an agent there asks with the session API's `POST /review-setup`.

## Where the token is kept

One token per console, never in a command's arguments:

- macOS: the login Keychain, service `woodshed-cli`, account the console's address (given to `security -i` on stdin).
- Linux with a Secret Service (a desktop session's keyring): libsecret, through `secret-tool` on stdin.
- Otherwise, on macOS and Linux: `~/.config/woodshed/credentials.json` (or under `$XDG_CONFIG_HOME`), readable only by you (`0600`). `login`
  and `status --json` print its path when it is used.

Windows is not supported yet: with no keyring here and no file mode to rely on, `login` refuses to keep the token.

`~/.config/woodshed/cli.json` says which console you used last and, for each, who is signed in and which of these holds
the token. It never holds a token.

## The console's side

The token is a command line token of its own (`wsc_…`), not the database tunnel's `wt_` token from My settings: that one
lasts 12 hours, you have one at a time, and it is made only once your databases are ready. A command line sign-in is one
per computer and lasts 90 days. The console keeps only its hash, and My settings' **Command line** row lists each
computer, with Revoke. Remove My Woodshed, and being taken off People, end them all.

The routes are in `console/cliSignIn.mjs`, and console/README.md, "Sign-in", says how the sign-in is guarded.

## Checking a change

`node --test cli/*.test.mjs` runs the commands against the console's real handler, with a stand-in for your browser.
To try it by hand against `node console/bin/devConsole.mjs 7712` (no sign-in, so you are `@local`):

```sh
node cli/woodshed.mjs login --console http://localhost:7712
node cli/woodshed.mjs status --json
node cli/woodshed.mjs logout
```
