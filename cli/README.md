# The woodshed command line

`woodshed` signs in to a Woodshed console from your computer, says who is signed in, starts and manages your sessions,
and opens a pipe into your running sessions. Later commands (settings) are added here. It is plain Node 22 with no
dependencies, like the rest of Woodshed.

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
| `woodshed login` | Asks the console for a code, prints it, and opens the console's `/cli` page in your browser. Check the page shows the same code and press **Sign in the CLI**. The token it gets is kept as below. Signing in again on the same computer ends its earlier sign-in. | 0 signed in, 2 the code expired with nobody approving it, 3 denied, 1 too many sign-ins waiting (below) |
| `woodshed logout` | Ends the token at the console and forgets it here. | 0 |
| `woodshed status` | The console's name and address, its org (the GitHub account its repos are on), and who is signed in. | 0 signed in, 2 not signed in or the sign-in ended |
| `woodshed tunnel <id> -- <line>` | Runs `<line>` with `sh -c` in your running session, as its user, in its checkout, with this command's stdin, stdout and stderr as its own, as `ssh host <line>` does: the words after `--` are joined by spaces into one line. A terminal runtime reaches a session through it (`--via 'woodshed tunnel <id> --'`). Below. | the line's exit code; 255 when the pipe could not open or broke |

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

## The tunnel into a session

`woodshed tunnel` is a byte pipe, so it prints nothing of its own except on stderr, and only when something fails; it
ignores `--json`. It opens one HTTPS request to the console, `/api/tunnel/exec/<id>` with this computer's token, which
the console passes to the session's statusd (`console/execPipe.mjs`, `session/execPipe.mjs`). It opens only into a
running session of yours (a My Woodshed session), never one that has seen production data. What it runs gets the
session's environment without the session's own token. Revoking this computer's sign-in, or the session stopping,
closes it. An open tunnel does not keep the session awake: it pauses when idle as it would without one, which ends the
tunnel. Exit 255 is the tunnel's own failure (not signed in, refused, the console or session not reached, cut before the
line ended), and it always says why on stderr. A line that itself exits 255 exits 255 too, with nothing of the tunnel's
on stderr, as ssh does. The line is at most 8 KB: a longer one belongs in a script in the session. Closing the tunnel
before the line ends (Ctrl-C, a cut network) hangs up everything the line started in the session.

## Sessions

`woodshed session` starts and manages sessions as the person signed in, as the console's pages do (`sessions.mjs`):

| Command | What it does | Exits |
| --- | --- | --- |
| `session new [--repo R] [--branch B] [--agent claude\|codex] [--model M] ["prompt"]` | Starts a private session, as My Woodshed's New session does: on `R` (`owner/name`, default the repo New session opens on for you), working on branch `B` or a pull request or issue (`123`, `pr 123`, its URL), with that agent and model. Then it waits, printing each start step as it is done, until the session runs. `--no-wait` returns once the console has it. Ctrl-C stops the wait, not the session. | 0 running, 2 running and needs you, 1 failed or stopped, 3 a repo you cannot start on |
| `session list [--all]` | Your sessions and the shared ones you can see: id, state (the page's words), whose, when it pauses or stops by itself, project and title. Ended shared sessions only with `--all`. | 0 |
| `session get <id>` | One session: state, branch, agent, pull request, when it pauses or stops, and the hours it runs on. | 0, 1 none you can see |
| `session stop <id>` | Stops it, and waits until the console has stopped it, a running one's work checkpointed on the way (up to 3 minutes: past that it says to check with `get`). One that paused or failed by itself is marked stopped by you, as the page's Stop does, so it no longer waits on you. | 0, 1 not answered in time |
| `session resume <id> [--no-wait]` | Starts one of your stopped sessions again, its conversation and all, and waits as `new` does. | as `new`; 3 a shared session (resume it on the console) |
| `session remove <id> [--yes]` | Takes one of your sessions off the list with its saved conversation, stopping it first. It asks first on a terminal; with no terminal it needs `--yes`. | 0, 2 not confirmed, 3 a shared session |
| `session extend <id>` | Puts its pause or stop off by an hour. The console allows it in the session's last 15 minutes, to its owner, or a shared session's assignee. | 0, 3 refused |
| `session limits <id> [--idle-hours N\|default] [--lifetime-hours N\|default]` | Its own idle pause and lifetime, in place of yours or the console's; `default` goes back to them. The other is kept. | 0, 1 out of range, 3 not yours to change |

Nothing keeps a session awake for being connected to: it pauses after its idle hours and stops at its lifetime unless
you, or an agent working for you, ask for more with `extend` or `limits`. `list` and `get` (`pause` in `--json`: `at`
and `why`, `idle` or `lifetime`) say when, so an agent can decide whether to.

With `--json` each prints one object per line: `new` and `resume` an `{"event":"started"|"resumed","session":{…}}`,
then a `status` event as it goes in line or starts, a `step` event per start step, and last `running`, `needs-you`,
`failed` or `stopped` with the session; `list` one `{"console","login","sessions":[…]}`, `get` one `{"session":{…}}`.

Besides its own `/api/cli/*` and the tunnel's `/api/tunnel/exec/<id>`, the console lets the token reach these routes and
no others (`console/cliSessions.mjs`), each as its person:

- `GET /api/sessions`, `GET /api/my/projects`
- `POST /api/my/sessions`, `POST /api/my/sessions/<id>/resume`, `POST /api/my/sessions/<id>/remove`
- `POST /api/sessions/<id>/stop`, `POST /api/sessions/<id>/extend`, `POST /api/sessions/<id>/limits`

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

A console keeps at most 5 sign-ins waiting from one address, and 200 in all. A code waits until it is approved and
collected, denied, or 10 minutes pass, so a `login` stopped part way holds its place until then. Past either limit,
`login` says `Too many sign-ins from this address are waiting` (or that the console has too many) with the minutes to
wait, and exits 1.

## Checking a change

`node --test cli/*.test.mjs` runs the commands against the console's real handler, with a stand-in for your browser.
To try it by hand against `node console/bin/devConsole.mjs 7712` (no sign-in, so you are `@local`):

```sh
node cli/woodshed.mjs login --console http://localhost:7712
node cli/woodshed.mjs status --json
node cli/woodshed.mjs session list
node cli/woodshed.mjs logout
```

### Trying the tunnel

The dev console has no real session, so start one yourself: the session image, running this checkout's statusd, with
its 7682 published on loopback. Then give the dev console its port and token, and sign in to it:

```sh
umask 077; openssl rand -hex 24 > /tmp/ws-exec-token; printf 'SESSION_TOKEN=%s\n' "$(cat /tmp/ws-exec-token)" > /tmp/ws-exec.env
docker run -d --name ws-exec -p 127.0.0.1:17682:7682 --env-file /tmp/ws-exec.env -e SESSION_ID=55aa55aa -e REPO_DIR=/tmp/work \
  -v "$PWD/session:/opt/woodshed/session:ro" -v "$PWD/shared:/opt/woodshed/shared:ro" --entrypoint sh <session image> \
  -c 'mkdir -p /tmp/work && cd /tmp/work && git init -q && exec node /opt/woodshed/session/statusd.mjs'
DEV_CONSOLE_EXEC_PORT=17682 DEV_CONSOLE_EXEC_TOKEN_FILE=/tmp/ws-exec-token node console/bin/devConsole.mjs 7712
node cli/woodshed.mjs login --console http://localhost:7712
node cli/woodshed.mjs tunnel 55aa55aa -- 'id -un; pwd'
```

`kill -HUP <the dev console's pid>` restarts its console on the same state, as a redeploy does, to see a tunnel (or a
terminal runtime's `--via` machine) reconnect.
