# The woodshed command line

`woodshed` signs in to a Woodshed console from your computer, says who is signed in, starts and manages your sessions,
opens a pipe or terminal into your running sessions, and adds them to Herdr's sidebar. It reads and sets your choices on My settings
and carries your Claude settings between your computer and private sessions. It is plain Node 22 with no dependencies.

## Running it

With Node 22 or newer, install or upgrade the CLI on macOS or Linux:

```sh
curl -fsSL https://woodshed.run/cli | sh
```

The installer puts the command in `~/.woodshed/cli` and links it from `~/.local/bin` (or `~/bin` if that is on
PATH instead). If needed, it prints the line to add to your shell profile. Then ask your agent to run `woodshed login`.
To install the optional Claude Code and Codex skill, run:

```sh
curl -fsSL https://woodshed.run/cli | sh -s -- --yes
```

From a checkout of this repository:

```sh
node cli/woodshed.mjs login --console https://console.example.com
node cli/woodshed.mjs status
```

On Windows, run it with `node cli\woodshed.mjs` from the checkout.

To type `woodshed` from a checkout on macOS or Linux, link it onto your PATH once:

```sh
ln -s "$PWD/cli/woodshed.mjs" ~/.local/bin/woodshed
```

### Packing the CLI for the website

The repository-root `package.json` lists the runtime files and bundled skill. Update its `files` list when the CLI
needs another file. Run `node --test cli/package.test.mjs` to pack, extract and run the standalone CLI.

Woodshed Cloud's Site workflow pins a core commit, runs `npm pack --offline --ignore-scripts` on it, and publishes
the tarball and its SHA-256 on woodshed.run. The site's installer checks that digest before installing the CLI.

## Commands

| Command | What it does | Exits |
| --- | --- | --- |
| `woodshed login` | Asks the console for a code, prints it, and opens the console's `/cli` page in your browser. Check the page shows the same code and press **Sign in the CLI**. The token it gets is kept as below. Signing in again on the same computer ends its earlier sign-in. | 0 signed in, 2 the code expired with nobody approving it, 3 denied, 1 too many sign-ins waiting (below) |
| `woodshed logout` | Ends the token at the console and forgets it here. | 0 |
| `woodshed status` | The console's name and address, its org (the GitHub account its repos are on), who is signed in, and the Herdr `hc` found here with its version (`hc` in `--json`: `installed`, `version`, `minimum`, `ok`), for `session herdr`. | 0 signed in, 2 not signed in or the sign-in ended |
| `woodshed review enable\|status` | In a checkout: reviews the repo's pull requests in Woodshed sessions, by its project file, and says what the console still needs. Below. | 0 done, 2 an admin's step, a sign-in or a merge still to come, 1 a project file that does not read or check |
| `woodshed tunnel <id> -- <line>` | Runs `<line>` with `sh -c` in your running session, as its user, in its checkout, with this command's stdin, stdout and stderr as its own, as `ssh host <line>` does: the words after `--` are joined by spaces into one line. A terminal runtime reaches a session through it (`--via 'woodshed tunnel <id> --'`). Below. | the line's exit code; 255 when the pipe could not open or broke |
| `woodshed config list\|get\|set` | Reads or sets [your choices on My settings](#your-choices-on-my-settings). | as below |
| `woodshed settings plan\|push\|pull` | Sync [Claude settings and a checkout's ignored files](#settings) with private sessions, and MCP definitions between computers. | as below |

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

`woodshed review enable`, run in a checkout of a repo the console has, turns on Woodshed's review for it the way a
connected repo has it: in a review session the console starts on each pull request, whose verdict the console posts as
its reviewer App (console/README.md, "The reviewer App"). It needs no GitHub workflow, Actions secret or Anthropic key,
and writes none: `scripts/enable-review.sh` is for a repo with no Woodshed console.

```sh
woodshed review enable                 # pullRequests.review with runner: woodshed, on commits tagged [woodshed-review]
woodshed review enable --qa            # QA too, in a session, when the woodshed-qa label goes on a pull request
woodshed review enable --every-commit  # each new commit, with no tag (--rerun <tag> for another tag)
woodshed review enable --dry-run       # what it would change, nothing written
woodshed review status                 # the checkout's file, the default branch's, and the console's reviewer App
```

`enable` edits `.woodshed/project.yaml` (made with `version: 1` when there is none): it adds or changes those lines and
nothing else, keeping every other line, comment and the order, and reads the result back to prove the rest of the
project reads the same (`cli/projectReview.mjs`). It writes no `author` or `commentAuthor`: with the session runner the
console fills in its reviewer App's and its own App's logins, so renaming either needs no change. Moving from the
Actions runner takes out the review's `workflow`, `author` and `commentAuthor` (and QA's `author`), which were the
workflow's; the workflow file itself is left for you to delete. It then runs `project check`'s checks on the result,
and writes nothing when they find a problem (exit 1).

Then it asks the console what is missing on its side, with this computer's token, through one read-only route,
`GET /api/review-readiness?repo=<owner/name>`: whether the repo is one you may start sessions on there, whether the
reviewer App is made, and whether it is installed on the repo. Each missing step is printed with who takes it, and the
command exits `2`, the file written all the same. With nothing missing it exits `0` and says to commit the file and
open a pull request: the review starts once that is merged, since the console reads the default branch's file. It warns
when the file's `runsOn` names another console, or names an `author` or `commentAuthor` that is not this console's.
`enable` exits `1` when the console could not be asked or did not answer (an origin not on GitHub, a console with no
GitHub App or from before the route): the file is written, but nothing says the review can run. `status` exits `0`
once the default branch says it, the console runs its reviews (the default branch's `runsOn`, if any, names it, App and
name, as its fleet reads it) and its reviewer App is known to be installed; else `2` with what comes next.

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
| `session new [--repo R] [--branch B] [--agent claude\|codex] [--model M] [--connect\|--herdr] ["prompt"]` | Starts a private session, as My Woodshed's New session does: on `R` (`owner/name`, default the repo New session opens on for you), working on branch `B` or a pull request or issue (`123`, `pr 123`, its URL), with that agent and model. Then it waits, printing each start step as it is done, until the session runs. `--no-wait` returns once the console has it. Ctrl-C stops the wait, not the session. `--connect` then puts this terminal on its agent's, as `connect` does; `--herdr` adds it to Herdr, as `herdr` does (below), and checks for `hc` before starting anything. | 0 running (with `--connect`, until you disconnect; with `--herdr`, added), 2 running and needs you, 1 failed or stopped (or `hc` could not add it), 3 a repo you cannot start on, or no `hc` |
| `session connect <id> [--shell]` | Puts this terminal on one of your sessions' agent, as its TUI tab shows it (claude or codex, in tmux or Herdr), or with `--shell` on its shell, the Terminal tab's. A paused or stopped one is resumed first. Below. | 0 disconnected (Ctrl-\\) or the session's terminal closed normally, 2 the sign-in ended, 1 could not open or reconnect, or the session's terminal closed it on an error, 3 a shared session, or one that has seen production data |
| `session herdr <id>` | Makes one of your sessions a machine in Herdr, `woodshed-<id>`, so it shows in the app's sidebar beside this computer: below. A paused or stopped one is resumed first, and waited for as `resume` does. | 0 connected, 2 connected and the session needs you, 1 its start failed or `hc` could not add it, 3 no `hc`, one older than 0.1.21, a shared session, or one that has seen production data |
| `session list [--all]` | Your sessions and the shared ones you can see: id, state (the page's words), whose, when it pauses or stops by itself, project and title. Ended shared sessions only with `--all`. | 0 |
| `session get <id>` | One session: state, branch, agent, pull request, when it pauses or stops, and the hours it runs on. | 0, 1 none you can see |
| `session stop <id>` | Stops it, and waits until the console has stopped it, a running one's work checkpointed on the way (up to 3 minutes: past that it says to check with `get`). One that paused or failed by itself is marked stopped by you, as the page's Stop does, so it no longer waits on you. | 0, 1 not answered in time |
| `session resume <id> [--no-wait]` | Starts one of your stopped sessions again, its conversation and all, and waits as `new` does. | as `new`; 3 a shared session (resume it on the console) |
| `session remove <id> [--yes]` | Takes one of your sessions off the list with its saved conversation, stopping it first, and forgets its `woodshed-<id>` machine in Herdr when there is one. It asks first on a terminal; with no terminal it needs `--yes`. | 0, 2 not confirmed, 3 a shared session |
| `session extend <id>` | Puts its pause or stop off by an hour. The console allows it in the session's last 15 minutes, to its owner, or a shared session's assignee. | 0, 3 refused |
| `session limits <id> [--idle-hours N\|default] [--lifetime-hours N\|default]` | Its own idle pause and lifetime, in place of yours or the console's; `default` goes back to them. The other is kept. | 0, 1 out of range, 3 not yours to change |

Nothing keeps a session awake for being connected to: it pauses after its idle hours and stops at its lifetime unless
you, or an agent working for you, ask for more with `extend` or `limits`. `list` and `get` (`pause` in `--json`: `at`
and `why`, `idle` or `lifetime`) say when, so an agent can decide whether to.

With `--json` each prints one object per line: `new` and `resume` an `{"event":"started"|"resumed","session":{…}}`,
then a `status` event as it goes in line or starts, a `step` event per start step, and last `running`, `needs-you`,
`failed` or `stopped` with the session; `list` one `{"console","login","sessions":[…]}`, `get` one `{"session":{…}}`.
`herdr` (and `new --herdr` after its `running`) ends with `{"event":"connected","session":{…},"machine":{"name","action","state"},"agent":{"inHerdr","address"}}`,
and `remove`'s `removed` event has `machine`: `{"name","removed"}`, or null with no `hc` here.

## A terminal on a session

`session connect <id>` makes this terminal the session's, as the console's tabs are in a browser: what it draws comes
here, what you type goes there, and its size follows this window. It needs a terminal (not a pipe or a file: for a
command, `woodshed tunnel`), and has no `--json`.

- **The agent's terminal**, by default: claude or codex as the TUI tab shows it, in tmux, or in Herdr when its owner
  picked Herdr. **`--shell`**: the Terminal tab's shell, a tmux of its own in the checkout. Each is the tab's own, so
  what you type shows in the browser too, and the other way round.
- **Ctrl-\\ disconnects** (as it detaches in Herdr's `hc`); the session and its terminal go on, and `connect` again picks
  it up as it is. tmux's own detach (its prefix, then `d`) or the program ending also closes it.
- **A dropped connection** (Wi-Fi, a laptop that slept, a console restarted) is opened again for a minute while the
  session runs, and the terminal is drawn again; a ping every 30 s finds one that went quiet. A session that paused or
  stopped meanwhile is said, and `connect` again resumes it.
- **How:** one websocket per connection, `/api/tunnel/term/<id>` or `/api/tunnel/shell/<id>`, with this computer's token
  (console/README.md, "A terminal from the command line"). The console hands it to the session's ttyd with ttyd's own
  credential, which never reaches this computer. Only your own sessions, never one that has seen production data, as
  for the tunnel. Being connected is not activity: the session pauses when idle as it would without it.

## Adding a session to Herdr

`session herdr <id>` runs Herdr's `hc` (`herdr-core`), never through a shell:

```sh
hc machine add --json --name woodshed-<id> --install \
  --via '<node> <this cli/woodshed.mjs> tunnel --console <console> <id> --'
```

- **Never `--temp`:** a temporary machine does not show in the app's sidebar.
- **The `--via` line** names node and this script by absolute paths, quoted for `sh`, since `hc`'s core runs it later
  with its own environment (an app started from the Dock has no shell's PATH): the PATH's `node` when it is the same file
  as the one running (`/opt/homebrew/bin/node`, which outlives an upgrade), and the link you ran `woodshed` by. It names
  the console, and `XDG_CONFIG_HOME` (made absolute) when you set one, so the tunnel finds this sign-in. Moving or
  deleting the checkout or link it names breaks the line: `session herdr` again writes a new one. `--install` lets `hc` copy itself
  into the session when the session's is missing or older; the session image has its own.
- **Run twice,** it leaves a `woodshed-<id>` that is connected through the same line alone. One that is not (a resumed
  session is a new container, whose `hc` core the old machine refuses as `a different core answers there`, or a line
  from another install of this command, or one added with `--temp`) is forgotten and added again. `hc machine rm` leaves
  the terminals in the session running. `session remove` forgets a `woodshed-<id>` only when its line is this command
  line's tunnel to that session on that console, never a machine of that name you made yourself.
- **The agent** is in the machine, as `woodshed-<id>/claude`, only when you picked Herdr under Agent terminal on My
  settings before the session started. Otherwise it runs in tmux, which `hc` cannot reach: the machine still works for
  new terminals and agents, and `herdr` says where the agent is.
- **No `hc`,** or one older than 0.1.21, exits 3 and says so. Nothing here installs or updates it: `hc update` does,
  when you choose.
- `hc` machines have no label of their own, so the sidebar shows the machine's name, `woodshed-<id>`; `session list`
  gives each id's title.

`hc` runs with your environment, so `HC_SESSION` and the XDG folders pick the core it talks to, as they do for `hc`
itself. `WOODSHED_HC_BIN` names another `hc` than the PATH's.

Besides its own `/api/cli/*`, the tunnel's `/api/tunnel/exec/<id>` and the terminals' `/api/tunnel/term|shell/<id>`, the console lets the token reach these routes and
no others (`console/cliSessions.mjs`), each as its person:

- `GET /api/sessions`, `GET /api/my/projects`
- `POST /api/my/sessions`, `POST /api/my/sessions/<id>/resume`, `POST /api/my/sessions/<id>/remove`
- `POST /api/sessions/<id>/stop`, `POST /api/sessions/<id>/extend`, `POST /api/sessions/<id>/limits`
- `GET /api/cli/config`, and `woodshed config`'s writes: `POST /api/my/terminal`, `/api/my/reviews`,
  `/api/my/codex-auth/reviews`, `/api/my/claude-token/shared`, `/api/my/projects/default`, `/api/my/github/identity`

## Your choices on My settings

`woodshed config` reads and sets the choices on your My settings page, through the page's own routes and the same checks
(`config.mjs`, `console/cliConfig.mjs`). `config` refuses keys for credentials, repo env values, own files and tmux
lines with a pointer to My settings. Use `settings --own-files` to sync whole ignored files. No message repeats a key
or value `config` refused, so a token pasted in the wrong place stays out of captured output.

| Command | What it does | Exits |
| --- | --- | --- |
| `config list` | Every key below and its value. | 0 |
| `config get <key>` | One value, bare, for a script (an empty line for none). | 0, 3 unknown key or a secret |
| `config set <key> <value>` | Changes it, and prints the new value. A change that reaches only sessions started after it says so. | 0, 3 unknown key, a value that is not valid (it lists the valid ones), a secret, or a step My settings needs first |

| Key | Values | Route |
| --- | --- | --- |
| `terminal` | `tmux`, `herdr`: what your private sessions run their agent in. Your next private session starts in it; running ones keep theirs. | `POST /api/my/terminal` |
| `reviews` | `none`, `claude`, `codex`, `both`, `default` (the most this console can run): who reviews your pull requests. | `POST /api/my/reviews` |
| `codex-reviews` | `on`, `off`: reviews of your pull requests run Codex on your own sign-in. Needs a Codex sign-in saved on My settings. | `POST /api/my/codex-auth/reviews` |
| `claude-token-shared` | `on`, `off`: shared sessions you start from GitHub run on your own Claude token. Needs a token saved on My settings. | `POST /api/my/claude-token/shared` |
| `default-repo` | A repo you can start sessions on, as `owner/name` or its name on the console: where New session and `session new` open. | `POST /api/my/projects/default` |
| `github-name`, `github-email` | What your sessions' commits say. Needs GitHub connected on My settings; setting one keeps the other. | `POST /api/my/github/identity` |

A switch reads `on` only where it has effect, as the page draws it: `claude-token-shared` with no token saved reads
`off`. A value that starts with `-` goes after `--` (`config set github-name -- -mia-`).
Setting `default-repo` to the installation's default clears your personal repo override.

With `--json`, `list` prints `{"console","config":{…}}`, `get` `{"key","value"}`, and `set`
`{"event":"set","key","value","changed","note"?,"config":{…}}`.

The console reads them for the token at `GET /api/cli/config`, which answers these keys and nothing else, and each
`set` answers with that same view, never the page's whole My settings answer.

## Settings

`woodshed settings` joins this computer to the Claude settings your private sessions already keep in step (console/README.md,
"Your Claude settings"), and saves a checkout's ignored files as your own files for its repo on My settings.

| Command | What it does | Exits |
| --- | --- | --- |
| `woodshed settings plan` | Lists each item with its size and what push would do with it: `upload` (new or changed), `skip` or `refuse`, and why. Sends nothing. With `--pull` (and `--replace`), what pull would write instead, and what each item that runs here runs. Writes nothing. | 0 |
| `woodshed settings push` | The same list, then the uploads. An item never listed before is asked about on a terminal; with no terminal (or `--json`) nothing is sent until `plan` has listed it. | 0 sent or nothing to send, 2 not shown before or not confirmed |
| `woodshed settings pull` | Writes the shared copy here: what is missing, and with `--replace` what differs, keeping a copy of each replaced file under `~/.config/woodshed/backups/`. Never deletes. Anything but `keybindings.json` is held until its content was listed, below. | 0, 2 something held |

Each takes:

- `--only <what>,...`: a kind of item (`settings`, `keybindings`, `memory` for `CLAUDE.md`, `agents`, `commands`, `skills`,
  `mcp`, `own-files`), or a name as the list shows it (`skills/review`, `mcp/github`, `.env.local`). Repeatable.
- `--own-files <checkout>`: also the checkout's files that git ignores and does not track, saved as your own files for its
  repo (told from its `origin`), which your next session on it writes where git ignores them. Env files (`.env.local`,
  `*.local.json`, `.dev.vars`) are taken by default; any other ignored file only when `--only` names its path. A folder
  git ignores whole (`node_modules/`) is not looked into. A path the repo's project file writes as an env file is
  skipped: its values go on My settings' Repo settings.

**What is carried.** The session sync's own items, from `~/.claude` and `~/.claude.json`: `settings.json`, `CLAUDE.md`,
`keybindings.json`, `agents/`, `commands/`, `skills/`, and your user-scope MCP servers. Items merge as a session's do, and
push never removes one from the copy (the console refuses a removal from a computer). Claude plugins, Codex's settings and
shell dotfiles are not carried, nor a file's mode: a pulled script runs as `bash script.sh`, as it does in a session.

MCP definitions pushed from a computer are available to the person's computers only. Pull can also bring in a server
configured in a private session. If a laptop and a session save the same name, each keeps its definition. Servers the
console provides to sessions are configured by an admin and use its relay.

**What runs here is shown first.** Sessions write the shared copy, unattended, and everything in it but
`keybindings.json` can make this computer's claude run something. So `pull` writes nothing else until a list has shown
that exact content (by its hash), listed with what it does: an MCP server's command and args or URL; every key of
`settings.json` (hooks, env, permissions, `defaultMode`, plugins); a skill's, command's or agent's frontmatter (its
`allowed-tools`) and each line that runs shell as it loads (`` !`cmd` ``); a script's first line. Values of env variables
named like credentials are not shown. On a terminal pull asks; with none it holds them (`hold`, exit 2) and writes the
rest, until `woodshed settings plan --pull` has listed them. A changed item is held again, and one with a line over 2000
characters is refused, since it cannot be shown whole.

An MCP server whose URL carries a sign-in (`https://user:pass@…`, a `?api_key=`) is refused both ways, and an own file
holding an AWS access key or a Slack token is not uploaded: sessions never get those.

**A session's edit is not undone.** Push sends an item only when the shared copy still holds what this computer last
pushed or pulled. One a session changed since is skipped with `pull it first, or --only <its name> sends yours over it`;
naming it (`--only settings.json`, not `--only settings`) sends yours.

**What changes on the way.** A session's home is `/home/node`, not yours:

- A path into what is carried (`~/.claude/skills/review/format.sh` in a hook) is moved to the other home.
- A setting naming any other path in your home (a hook running `~/bin/notify.sh`, a permission on `~/notes`) is left out,
  and the list says which. An MCP server naming one is skipped.
- `~/x`, `$HOME/x` and `${HOME}/x` follow the same rules: kept when they are carried, left out when they are not.
- `statusLine` stays each side's own. `apiKeyHelper` and the other credential helpers, and `env` variables named like
  credentials, stay here, and a `pull --replace` keeps yours.
- An MCP server run as `/opt/homebrew/bin/npx` (or from `/usr/local/bin`, `/usr/bin`, `/bin`) runs as `npx`, from the
  session's PATH. Any other absolute program path is skipped.

**What is refused**, by name or kind, never by showing it: MCP logins (sign in to the server where you use it), an MCP server
whose `env` holds a literal key, literal HTTP headers on an MCP definition or hook (`${VARIABLE}` is fine), a file named like a secret (`.env`, `*.pem`, `id_rsa`,
`credentials.json`) in a skills, agents or commands folder, and one holding what looks like a private key or a GitHub,
Anthropic, OpenAI, Slack, AWS, Stripe live or Google key. For own files, keys and certificates, files named for production
(`.env.production`) and live keys.

A symlink in `~/.claude` (a linked `skills/`, a linked `settings.json`) is neither read by push nor written through by
pull, nor is an empty own file pushed (My settings would take it as removing yours). `CLAUDE_CONFIG_DIR` is not
followed: settings reads `~/.claude` and `~/.claude.json` only, and says so when it is set.

`~/.config/woodshed/settings-state.json` keeps, for each console, the names of the items a push list has shown, the
hashes of what a pull list has shown that runs here, and each item's hash as it last went to or from this computer.
Never an item's content.

## Where the token is kept

One token per console, never in a command's arguments:

- macOS: the login Keychain, service `woodshed-cli`, account the console's address (given to `security -i` on stdin).
- Linux with a Secret Service (a desktop session's keyring): libsecret, through `secret-tool` on stdin.
- Otherwise, on macOS and Linux: `~/.config/woodshed/credentials.json` (or under `$XDG_CONFIG_HOME`), readable only by you (`0600`). `login`
  and `status --json` print its path when it is used.
- Windows: `%LOCALAPPDATA%\woodshed\credentials-dpapi.json`, each token sealed with DPAPI for your Windows account and
  for its console's address (a token copied under another console's address does not open), by Windows PowerShell 5.1
  (which ships with Windows), given the token on stdin. Where DPAPI cannot seal (an SSH sign-in with a key has no logon
  secret to seal with), `%LOCALAPPDATA%\woodshed\credentials.json`. Either is kept and read only when that folder is
  the default one, `%USERPROFILE%\AppData\Local\woodshed`, as spelled and as resolved through links and junctions: a
  new file on Windows takes its folder's ACL as it is made, and what is read from a folder someone else could replace
  could be theirs (DPAPI opens a blob sealed for the whole computer for any account). `XDG_CONFIG_HOME` is not read on
  Windows. The folder is made yours by Windows PowerShell, as `0700` is on macOS and Linux: your account its owner,
  nothing inherited from the folder above, and full control for your account and Windows' own SYSTEM and Administrators
  alone (which may open anything on the computer, as root may on macOS and Linux). `login` reads it back and checks each
  by SID, or refuses to keep the token there and ends it at the console. `%LOCALAPPDATA%`, not `%APPDATA%`, which a
  roaming profile copies to a server. PowerShell and the browser's `rundll32` are run from `System32` by their full
  path, never through a shell, and PowerShell without `PSModulePath`, which a PowerShell 7 terminal sets to modules
  Windows PowerShell cannot load. A token sealed at the desktop cannot be opened over SSH: `logout` there leaves it as it
  is and exits 3, so signing out at the desktop still ends it at the console.

`~/.config/woodshed/cli.json` (`%LOCALAPPDATA%\woodshed\cli.json` on Windows) says which console you used last and, for
each, who is signed in and which of these holds the token. It never holds a token.

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

`node --test cli/*.test.mjs` runs the commands against the console's real handler, with a stand-in for your browser,
and `settings` on a made-up laptop home and checkout.
To try it by hand against `node console/bin/devConsole.mjs 7712` (no sign-in, so you are `@local`):

```sh
node cli/woodshed.mjs login --console http://localhost:7712
node cli/woodshed.mjs status --json
node cli/woodshed.mjs session list
node cli/woodshed.mjs config list
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

### Trying session herdr

`session herdr` needs a session the dev console starts itself, in the session image built from this checkout, with an
`hc` core of your own, never the one your Herdr app uses. This recipe is for Docker Desktop or OrbStack, whose
`host.docker.internal` reaches this machine's loopback: on Linux's own Docker a container cannot reach the loopback
listeners below.

- Build the image as install.sh does with no repository (`woodshed-session:<tag>`).
- Serve a bare clone of a repo with a `.woodshed/project.yaml` over git's dumb HTTP (`git update-server-info`, then
  `python3 -m http.server --bind 127.0.0.1 <port>` in the folder above `example-org/example-repo`).
- Write a session env file (JSON) that points sessions at it and at a free session API port:
  `WOODSHED_CONSOLE_URL=http://host.docker.internal:<api port>`, and `GIT_CONFIG_COUNT=1`,
  `GIT_CONFIG_KEY_0=url.http://host.docker.internal:<port>/.insteadOf`, `GIT_CONFIG_VALUE_0=https://github.com/`.
- Start the dev console with it:

  ```sh
  TMPDIR=/tmp/ws DEV_CONSOLE_REPO_SETTINGS=1 DEV_CONSOLE_SESSION_IMAGE=woodshed-session:<tag> \
    DEV_CONSOLE_SESSION_ENV_FILE=<file> DEV_CONSOLE_SESSION_API_PORT=<api port> node console/bin/devConsole.mjs 7740
  ```

  (A short `TMPDIR` on macOS, whose own is too long for the dev console's tmux sockets.)
- On its My settings, pick Herdr under Agent terminal and save a Claude token (a dummy one: claude then asks to log in,
  in Herdr), and raise My Woodshed sessions per person on Console settings above its made-up running sessions.
- Then, with `HC_SESSION` and short `XDG_*` folders of your own exported (macOS socket paths stop at 103 bytes), log in
  and run `session new --herdr "…"`, `hc ls`, `session stop`, `session herdr` and `session remove`.
