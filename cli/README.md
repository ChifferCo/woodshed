# The woodshed command line

`woodshed` signs in to a Woodshed console from your computer, says who is signed in, and opens a pipe into your
running sessions. Later commands (sessions, settings) are added here. It is plain Node 22 with no dependencies, like the rest of Woodshed.

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
| `woodshed tunnel <id> -- <line>` | Runs `<line>` with `sh -c` in your running session, as its user, in its checkout, with this command's stdin, stdout and stderr as its own, as `ssh host <line>` does: the words after `--` are joined by spaces into one line. A terminal runtime reaches a session through it (`--via 'woodshed tunnel <id> --'`). Below. | the line's exit code; 255 when the pipe could not open or broke |
| `woodshed forward <id> <port>[:<local>]...` | Your session's port on this computer's `localhost`, on `<local>` when given, else the same number, until Ctrl-C. A local port that is taken (on 127.0.0.1 or ::1) moves to the next free one, and it says which. Below. | 0 at Ctrl-C, 2 not signed in, 3 refused, 1 anything else |
| `woodshed forward --auto <id>` | The same for every port your session listens on, as it starts and stops listening. | as above |
| `woodshed open <id>` | Your session's app's address, `https://<id>.<app domain>/`, which opens behind the console's sign-in (or a share link made on the console). | 0, 2 not signed in, 1 a console whose apps have no names of their own |

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

## Ports on your computer

`woodshed forward` listens on `localhost` and makes each connection there one request to the console,
`/api/tunnel/port/<id>/<port>`, which the session's statusd connects to `localhost:<port>` inside the session
(`console/execPipe.mjs`, `session/portPipe.mjs`). The same rules as the tunnel's hold: your own running session, never
a tainted one, closed when the sign-in is revoked. A console restart or a dropped network cuts only the connections
open at that moment; the next one opens again by itself, so a dev server's page reloads as if nothing happened. The
session's own ports (its terminals, statusd, the viewers, the editor, Redis) are never forwarded: the console opens
those. As with `ssh -L`, a forward listens on loopback with no sign-in of its own, so anyone with an account on
this computer can connect to it while it runs: don't forward a session's port on a computer you share with people who
should not reach it.

`--auto` reads the session's socket tables (`/proc/net/tcp` and `tcp6`) every 2 seconds through one tunnel it holds
open, and forwards each port something listens on where `localhost` reaches it. A port that stops listening has its
forward closed. When that tunnel is cut, the forwards stay and it follows again by itself. `--json` writes
`{"event":"following","again":…}` each time its connection to the session opens,
`{"event":"forwarding","port":…,"local":…,"moved":…,"url":…}` for each port, and `{"event":"closed",…}`.

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
