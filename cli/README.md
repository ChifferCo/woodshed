# The woodshed command line

`woodshed` signs in to a Woodshed console from your computer, says who is signed in, starts and manages your sessions,
opens a pipe or terminal into your running sessions, adds them to Herdr's sidebar, and moves work from Herdr into a
session. It reads and sets your choices on My settings and carries your Claude settings between your computer and
private sessions. It is plain Node 22 with no dependencies.

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

## Start here with `woodshed setup`

Setup's aim is your first automated code reviews: Claude Code and Codex reviewing your pull requests on your repo. Run
`woodshed setup` on a terminal, or give your coding agent the repo:

```sh
woodshed setup --yes --repo acme/app --reviews default
```

Use `--console <url>` for your own console and `--no-browser` to print links without opening them. When setup exits 2,
follow the link or supply the choice it asks for, then run it again with the same options. A new CLI sign-in starts
in your browser and setup collects the approval the next time you run it.

It goes in this order:

1. **Sign in**, then **repos**: repeat `--repo` to choose several; the first is for a session.
2. **Claude Code and Codex.** Setup asks for both: with both connected, your pull requests get reviews from both. On a
   console with no team keys (a new org on console.woodshed.run), reviews run on the pull request author's own saved
   Claude token and Codex sign-in, each used for reviews from the moment it is saved (console/reviewAgents.mjs). While
   one is missing, setup exits 2 with the My settings link and what to run for it: `claude setup-token` for Claude,
   whose token you paste under Claude; `codex login`, then all of `~/.codex/auth.json` (or an OpenAI API key) under
   Codex. Setup never handles a token itself. Use only one? Pass `--agent claude` or `--agent codex`, or answer so on a
   terminal, and setup does not ask for the other.
3. **Review on the repo.** Every repo is reviewed by default, on a commit whose message has `[woodshed-review]`
   (sessions add it for you), with no checkout, project file or pull request: for each repo setup runs `woodshed review
   status --repo <repo>`, stops with the link when the console's reviewer App still has to be made or installed, and
   otherwise tells you the tag. `--reviews` sets your own reviewer choice (`default` is the most the console can run:
   both, once both are connected).
4. **Reviews of your open pull requests**, the step setup is for: it lists your open pull requests on each repo
   (`woodshed review pulls`) and starts the console's review on them now (`woodshed review start`), then gives each
   review's link. On a terminal it asks which, Enter for all (closing the input, Ctrl-D, starts none). `--review-prs
   all`, `none` or numbers (`12,15`) say which: with several repos, each names its repo, as `owner/name#12` (a bare number
   is refused there, since it could be yours on more than one); a number reaches only a repo that lists it as yours. With `--yes` and no `--review-prs`, the 5 updated last (enough to see reviews work on your own code without spending
   your plan on old branches, and `--review-prs all` takes every one). Without `--yes` or a terminal, setup exits 2
   listing them, for `--review-prs`. A draft is left until it is ready, and a head commit reviewed already is not
   reviewed again. With no open pull requests, it says a review starts on your next one whose last commit's subject
   ends with the review's tag (`[woodshed-review]` by default; a session adds it, on your own computer you add it).
   Every repo is reviewed by default; only one whose project file runs its review elsewhere (GitHub Actions, or
   another console by `runsOn`) gets none, and setup says why. With `--reviews none` it starts none.
5. **Optional: the agent terminal**, Herdr or tmux, for new private sessions. On a terminal Enter keeps the saved
   choice; `--terminal herdr` or `--terminal tmux` sets it.
6. **Optional: a first coding session**, only with `--prompt`, or a prompt typed in when asked. Without one, setup
   finishes and says how to start one. When the terminal choice is Herdr and setup finds a compatible `hc` on macOS or
   Linux, it uses `session new --herdr` to show the agent in a space on the session's machine. On Windows it starts a
   regular session and prints the link. If a private session already exists for the first repo, setup gives you its
   link. Setup then ends with the reviews' links again.

Use `--prompt=--help` for a prompt that looks like an option. `--skip-reviews` skips steps 3 and 4, and `--no-session`
step 6.

`--yes` and runs without a terminal never prompt. `--json` prints one checklist entry per line with
`event: "setup"`, `step` (`login`, `repos`, `agent`, `repo-review`, `review-choice`, `pr-reviews`, `terminal`,
`session`, `reviews`), `status`, `message`, and a `url` when relevant; `pr-reviews` and `reviews` carry `reviews`, each
with its `number`, `url` and `pullUrl`. When this CLI lacks a repo, review, or config command, setup skips that step and
says where to do it.

### Command organization

Name top-level commands for a Woodshed workflow, such as `move` or `tunnel`, or group related operations by the
resource they act on, as in `session list`, `review status` and `settings push`. Put integration choices in flags
when they select how the workflow runs. For example, `move --from herdr --to new` selects the source and destination.
Keep a source explicit even when only one is supported. Keep session management under `session`. For example,
`session herdr <id>` adds the selected session to Herdr.

## Commands

| Command | What it does | Exits |
| --- | --- | --- |
| `woodshed setup` | Guides sign-in, repos, Claude Code and Codex, and reviews of your open pull requests; a terminal choice and a first session are optional. | 0 done, 2 needs you, 3 refused, 1 failed |
| `woodshed login` | Asks the console for a code, prints it, and opens the console's `/cli` page in your browser. Check the page shows the same code and press **Sign in the CLI**. The token it gets is kept as below. Signing in again on the same computer ends its earlier sign-in. | 0 signed in, 2 the code expired with nobody approving it, 3 denied, 1 too many sign-ins waiting (below) |
| `woodshed logout` | Ends the token at the console and forgets it here. | 0 |
| `woodshed status` | The console's name and address, its org (the GitHub account its repos are on), who is signed in, and the Herdr `hc` found here with its version (`hc` in `--json`: `installed`, `version`, `minimum`, `ok`), for `session herdr`. | 0 signed in, 2 not signed in or the sign-in ended |
| `woodshed move --from herdr [--terminal T\|--tab T\|--space S] --to <id>\|new` | Moves terminals here into a session, agents with their conversations: below. | 0 moved, 2 a moved agent needs you, 3 refused, 1 failed and undone |
| `woodshed repo list` | Lists connected repos and, for admins, which repos can be added and where the GitHub App has access. | 0 listed, 2 sign in, 1 failed |
| `woodshed repo add <owner/name> [--name N]` | Adds a repo as in Console settings. Use `--name` on consoles that let you choose a project name. | 0 added, 2 GitHub App access or sign-in needed, 3 refused, 1 failed |
| `woodshed repo remove <owner/name>` | Removes a repo and its Woodshed settings as in Console settings. | 0 removed, 2 sign in, 3 refused, 1 failed |
| `woodshed review <id>\|<pull request>` | Reviews one of your sessions' change on this terminal, as the console's Review tab: [below](#reviewing-a-session-on-this-terminal). | 0 quit, 2 the sign-in ended, 3 a shared session or one that has seen production data, 1 anything else |
| `woodshed review status\|enable` | Whether a repo's pull requests are reviewed in Woodshed sessions (on by default, on `[woodshed-review]`) and what the console still needs; `enable` writes the review into the project file, for QA, every commit or another tag. Below. | 0 done, 2 an admin's step, a sign-in or a merge still to come, 1 a project file that does not read or check |
| `woodshed review pulls\|start` | Lists your open pull requests on a repo, and has the console review them now: [below](#reviewing-your-open-pull-requests-now). | 0 done, 2 a sign-in, 3 a pull request or repo not yours, or a repo whose project file runs its review elsewhere, 1 anything else |
| `woodshed tunnel <id> -- <line>` | Runs `<line>` with `sh -c` in your running session, as its user, in its checkout, with this command's stdin, stdout and stderr as its own, as `ssh host <line>` does: the words after `--` are joined by spaces into one line. A terminal runtime reaches a session through it (`--via 'woodshed tunnel <id> --'`). Below. | the line's exit code; 255 when the pipe could not open or broke |
| `woodshed config list\|get\|set` | Reads or sets [your choices on My settings](#your-choices-on-my-settings). | as below |
| `woodshed settings plan\|push\|pull` | Sync [Claude and Codex settings, plugins, dotfiles and ignored checkout files](#settings) with private sessions. Claude MCP definitions pushed from computers stay between computers. | as below |

Every command takes:

- `--console <url>`: the console to use. Without it, `WOODSHED_CONSOLE`, else the one you last signed in to, else
  `https://console.woodshed.run`. A bare name gets `https://`. Plain `http://` is refused except on this machine
  (`localhost`, `127.0.0.1`), so a token never crosses a network in the clear.
- `--json`: one JSON object per line on stdout. `login` writes `{"event":"code",…}` with the code and address first,
  then `{"event":"signed-in",…}`; a failure is `{"event":"error","status":…,"error":…}`.

`login` also takes `--no-browser`, which prints the address instead of opening it (on a server over SSH, say).
`login --no-wait` returns 2 with the approval link and keeps the short-lived device code in the same kind of
credential store as the CLI token. Run it again on the same console to collect the approval. `status --json`
includes `sessionSignIns` when the console supports it, with a boolean for each personal Claude and Codex sign-in.

Exit codes, for every command: `0` done, `2` waiting on a person (sign in, or approve), `3` refused (denied, or an
address it will not send a token to), `1` anything else (the console not reached, a console from before the command
line).

## Choosing repos

`woodshed repo list --json` returns a `repo-list` event with `projects`, `available` and `canChange`. Each row's
`githubAppAccess` is `true` or `false` when known and `null` otherwise. `choicesIncomplete` flags a partial inventory.
If the inventory is unavailable, `choicesError`
explains why and the connected repos still appear. Members can list repos they can start sessions on. Only admins can
see the console's GitHub App inventory or add and remove repos.

When GitHub App access is needed, `repo add` exits 2 with `status: "needs-github-app"` and the install or access link
in `url` when available. It opens that link from a terminal unless `--no-browser` is set. Grant access on GitHub, then
run the same add again. If the console's response to a change is lost, run `repo list` to see whether it went through.

## Review

Every repo the console has is reviewed by default: put `[woodshed-review]` in a commit's message on a pull request, and
the console reviews it at that commit, with nothing to turn on or commit. Woodshed's sessions add the tag to the commits
they push. `woodshed review status --repo owner/name` (or, in a checkout, `woodshed review status`) says whether review
is on, what it runs by (`default`, or the repo's project file, which wins when it names a review) and what the console
still needs, such as its reviewer App.

`woodshed review enable`, run in a checkout of a repo the console has, writes Woodshed's review into its project file,
for QA in a session too (`--qa`), every commit, or another tag: in a review session the console starts on each pull request, whose verdict the console posts as
its reviewer App (console/README.md, "The reviewer App"). It needs no GitHub workflow, Actions secret or Anthropic key,
and writes none: `scripts/enable-review.sh` is for a repo with no Woodshed console.

```sh
woodshed review enable                 # pullRequests.review with runner: woodshed, on commits tagged [woodshed-review]
woodshed review enable --qa            # QA too, in a session, when the woodshed-qa label goes on a pull request
woodshed review enable --every-commit  # each new commit, with no tag (--rerun <tag> for another tag)
woodshed review enable --dry-run       # what it would change, nothing written
woodshed review status [--repo R]      # what runs (default or the project file), and the console's reviewer App
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
once a review runs in a session, by the default or the default branch's file, the console runs its reviews (the default branch's `runsOn`, if any, names it, App and
name, as its fleet reads it) and its reviewer App is known to be installed; else `2` with what comes next.

### Reviewing your open pull requests now

Every repo is reviewed: by its project file's `pullRequests.review`, or, when it names none, by the console's default
review in a session. The console starts one on a pull request when its last commit's subject ends with the review's tag,
`[woodshed-review]` by default (a Woodshed session adds it to its pushes; on your own computer, add it to the subject),
or on each commit with `--every-commit`. To have your open pull requests reviewed now, tag or not:

```sh
woodshed review pulls --repo acme/app            # your open pull requests there, and how the repo is reviewed
woodshed review start 12 15 --repo acme/app      # the console's review of each, now; prints each review's link
```

Without `--repo`, the repo is the GitHub origin of the checkout at `--dir`, or here. `pulls` lists what GitHub's search
finds you wrote: at most 10 of your open pull requests across the console's repos, the updated last first, and not one
a session of yours opened (its author is the console's App). `start` takes those by number all the same. When GitHub
did not answer, the console's last list is shown and `pulls` says it may be out of date (`stale` in `--json`). A pull request is its number,
`#number` or URL. `start` calls `POST /api/my/pulls/<number>/review` (console/README.md, "A review asked for by hand"),
which starts the same review session a tagged commit would, as you: on your own Claude token and Codex sign-in where
the console has no team keys, and as your reviewer choice on My settings says. It answers with that review's link when
the head commit is being reviewed, or has its verdict, already (a review that failed with none may be asked again). It refuses a pull request that is not yours, a draft, and
a repo whose default branch's project file chooses another runner for its review (GitHub Actions), or whose
`pullRequests.runsOn` names another console, which runs its reviews (exit 3 for each, with the reason). One refused does not keep the others from starting. `--json` prints a
`{"event":"review","number":…,"outcome":"started"|"running"|"reviewed"|"refused",…}` line for each, with its
`session.url`, or its `error`.

## Reviewing a session on this terminal

`woodshed review <id>` opens one of your My Woodshed sessions' review full-screen, the review the console's Review tab
shows (`shared/review`, in the session). `123`, `#123` or a pull request's URL open the session of yours that opened
it, your running one first. A bare number on more than one of your sessions' repos is refused (give the URL), and so is
a pull request whose session's review now posts to another one, such as one that replaced it: a verdict or a merge
would land there, so open that session by its id instead. A paused one is resumed first, as `session connect` does. It draws, in the page's order:

- **The header**: the title (the pull request's own once there is one), its branch, the pull request's state, verdict
  and checks, the commit, `+`/`−`, what was read (the working tree as of when, or the pull request at which commit),
  and the analysis's state while it runs or when it failed. The pull request's number (`#311`) is a link to it on
  GitHub, as on the page: a terminal hyperlink (OSC 8), which Herdr, Ghostty, iTerm2, kitty, WezTerm and recent VS
  Code terminals open on a click (most with Cmd or Ctrl held) and others draw as plain text. Its address is the one the
  review has for that number (else the session's pull request with it, as the console lists it), and only an https
  one with no control character or space in it, whose path ends `/pull/<number>`, is linked.
- **The tab bar**, each tab after its number: `1 Overview │ 2 Q&A │ 3 Discussion │ 4 Files changed │ 5 Chat`, on one
  line at 80 columns. The number opens the tab (`Tab` and `Shift-Tab` move to the next and the one before); a tab keeps
  its number when there is no Discussion. While you type in a box (the chat, a question, a comment, a sheet's comment
  or title), a number is text.
- **1 Overview**: the pull request's description, the overview, the decisions and the architecture, its diagram as a
  list of what connects to what, marked added, removed or changed. **2 Q&A**: the questions someone new to the code
  would ask, each answered from the code, started when the review opens (as on the page; the tab shows it as it goes). They are folded, as on the
  page: `↑`/`↓` choose one, `Enter` opens it (one at a time, with its follow-ups folded under it) and `←` closes it;
  `i` asks where the cursor is: a follow-up under the chosen question, or on the last row, `＋ Ask a question of
  your own`, a new one at the end. A question waits for its answer where it was asked, with the cursor on it. `A` asks
  them all again. **3 Discussion** (with a
  pull request): what was said about the change as a whole. **4 Files changed**: every file, grouped in the
  analysis's reading order with each group's reason, and under each file its role, `+`/`−`, conversations and what it
  does. `Enter` opens one's diff, with every conversation under its line (`↑`/`↓` move the line a comment goes on,
  `n`/`p` the next file, `Esc` back to the list); `i`, on the list or in a diff, starts a chat about that file (and
  line), as the page's Send to the conversation does. **5 Chat**: the page's
  conversation panel, with the session's agent reading the branch (`Enter` asks, `↑`/`↓` in the box offer the page's
  suggestions). The shed does not stream an answer: the chat says how long it has been reading, then draws it.
- **The actions**, offered where the page offers them, the GitHub ones only with a pull request: `c` a line comment
  (into your draft review, or `Tab` to post it at once while there is no draft), `s` submit your review (comment,
  approve or request changes, with your draft comments; `Ctrl-D` twice discards the draft), `m` merge (after GitHub's
  read of whether it may: approved, checks passing, the head this review read; into the merge queue where the base
  has one), `t` rename the pull request. `r` Re-review (pulls the branch, takes the diff again and reads it again; with
  nothing new, `a` reads the same commit again), `a` runs or retries the analysis, `d` discards the analysis and the
  conversation. `o` opens the pull request (its underlined number in the header) on GitHub in your browser. `?` lists
  the keys; `q` quits, and the session and the review go on.

The pull request opens only from its own address, and only a pull request's page on `https://github.com`, with the
platform's opener (`open` on macOS, `xdg-open` on Linux, `rundll32`'s `FileProtocolHandler` on Windows, which opens it as
`start` does without `cmd.exe`) given the address as its argument, never through a shell (`cli/browser.mjs`). Over SSH, or
on Linux with no display, nothing is opened: the status line shows the address instead, as it does when the opener
fails. The number is a terminal hyperlink too: in Herdr, Ctrl-click on it opens it.

The footer names the keys for what is on screen. It draws in the terminal's own colours (bold, dim, reverse and the
eight basic colours, foreground only), so it reads on a light terminal as on a dark one; `NO_COLOR` keeps bold, dim and
reverse. It follows the window's size from 40 columns up. Text from the session never reaches the terminal with a
control character in it.

The page's rules hold: a write to GitHub goes as you, from your own session, once you connected GitHub on My settings
before it started; otherwise the session hides the pull request and refuses the write (`session/reviewShed/policy.mjs`).
With `--json`, or with no terminal, it prints the analysis and the diff's summary once and exits: one
`{"event":"review","review":{…}}` with `title`, `pullRequest`, `analysis` (`status`, `overview`, `decisions`,
`architecture`) and `diff` (`files`, `additions`, `deletions`, and `groups` in reading order). `pullRequest` is the
live pull request the review may write to, with its `url` checked as the header's link is (null when it does not
pass), and the text has that address after its number; a review that hides the pull request (the person has not
connected GitHub) has `pullRequest: null` and no address, though the header still links a pull request review's
number from what was read at launch. Neither has an escape code in it. Opening a review with no analysis yet starts it,
as opening the tab does. Opening it starts the Q&A too, whatever the analysis's state, unless its commit already has
one: the first open of the review in its session, and each Re-review, start one.

**How:** the page's own calls, `/reviews/claude-<id>/...`, with this computer's token (console/README.md, "A review
from the command line"). Only your own sessions, never one that has seen production data, never the page itself.

### Trying it on the dev console

`DEV_CONSOLE_REVIEW_PR=1 node console/bin/devConsole.mjs 7712` makes `/s/beadfeed` @local's own session, whose branch
has a made-up open pull request, #26701, answered by a stand-in `gh` (`console/bin/devReviewGh.mjs`), so the writes run
against it and nothing reaches GitHub. Sign in with `node cli/woodshed.mjs login --console http://localhost:7712`, then
`node cli/woodshed.mjs review beadfeed`. Its Chat, Q&A and Re-review run `claude` when one is on the PATH.

## The tunnel into a session

`woodshed tunnel` is a byte pipe, so it prints nothing of its own except on stderr, and only when something fails; it
ignores `--json`. It opens one HTTPS request to the console, `/api/tunnel/exec/<id>` with this computer's token, which
the console passes to the session's statusd (`console/execPipe.mjs`, `session/execPipe.mjs`). It opens only into a
running session of yours (a My Woodshed session), never one that has seen production data. What it runs gets the
session's environment without the session's own token. Revoking this computer's sign-in, or the session stopping,
closes it. An open tunnel does not keep the session awake: it pauses when idle as it would without one, which ends the
tunnel. Exit 255 is the tunnel's own failure (not signed in, refused, the console or session not reached, cut before the
line ended), and it always says why on stderr. A session that is paused or stopped is refused with 409, and the
message, which Herdr shows as its machine's reason, says to run `woodshed session herdr <id>`: a resumed session runs a
new `hc` core, so resuming it alone leaves its machine unreachable, and `session herdr` resumes it and adds the machine
again. A line that itself exits 255 exits 255 too, with nothing of the tunnel's
on stderr, as ssh does. The line is at most 8 KB: a longer one belongs in a script in the session. Closing the tunnel
before the line ends (Ctrl-C, a cut network) hangs up everything the line started in the session.

## Sessions

`woodshed session` starts and manages sessions as the person signed in, as the console's pages do (`sessions.mjs`):

| Command | What it does | Exits |
| --- | --- | --- |
| `session new [--repo R] [--branch B] [--agent claude\|codex] [--model M] [--connect\|--herdr [--parent[=T]]] ["prompt"]` | Starts a private session, as My Woodshed's New session does: on `R` (`owner/name`, default the repo New session opens on for you), working on branch `B` or a pull request or issue (`123`, `pr 123`, its URL), with that agent and model. Then it waits, printing each start step as it is done, until the session runs. `--no-wait` returns once the console has it. Ctrl-C stops the wait, not the session. `--connect` then puts this terminal on its agent's, as `connect` does; `--herdr` adds it to Herdr, as `herdr` does (below), and checks for `hc` before starting anything; `--parent` with it makes the agent's terminal a child of a terminal here (below). | 0 running (with `--connect`, until you disconnect; with `--herdr`, added), 2 running and needs you, 1 failed or stopped (or `hc` could not add it), 3 a repo you cannot start on, or no `hc` |
| `session connect <id> [--shell]` | Puts this terminal on one of your sessions' agent, as its TUI tab shows it (claude or codex, in tmux or Herdr), or with `--shell` on its shell, the Terminal tab's. A paused or stopped one is resumed first. Below. | 0 disconnected (Ctrl-\\) or the session's terminal closed normally, 2 the sign-in ended, 1 could not open or reconnect, or the session's terminal closed it on an error, 3 a shared session, or one that has seen production data |
| `session herdr <id> [--parent[=T]]` | Makes one of your sessions a machine in Herdr, `woodshed-<id>`, so it shows in the app's sidebar beside this computer: below. A paused or stopped one is resumed first, and waited for as `resume` does; with `--parent`, resumed waiting for its agent's terminal from here. | 0 connected, 2 connected and the session needs you, 1 its start failed, `hc` could not add it, or `--parent` and its agent's terminal was already there, 3 no `hc`, one older than 0.1.21, a shared session, one that has seen production data, or `--parent` outside a Herdr terminal |
| `session list [--all]` | Your sessions and the shared ones you can see, as the console's page shows them to you: id, state (the page's words), kind (below), whose, when it pauses or stops by itself, project and title. Under each, every pull request it opened, as the console's chips read it (`#123 open · approved · checks 3 passing`; `not read yet` before the console has read it), and `review it: woodshed review <id>` under your own sessions'. Then your own open pull requests on the console's repos that no listed session opened (My Woodshed's Pull requests group). Ended shared sessions only with `--all`; a review or QA run has ended once it stops, since nothing of it is kept to resume. With `hc` here, it also names the `woodshed-<id>` machines in Herdr whose session is no longer on the console (`herdrLeftovers` in `--json`), and says to run `prune`. | 0 |
| `session get <id>` | One session: state, kind, whose, branch, agent, pull request, a review's or QA's verdict, its app, when it pauses or stops, and the hours it runs on. | 0, 1 none you can see |
| `session app <id> [start [--app NAME] [--no-wait]\|stop]` | A running session's app, as the page's Open app, Start app and Stop app: whether it is up and the link that opens it. `start` starts it (or `NAME`, one of the project's apps) and waits up to 5 minutes for it to come up; `stop` stops it. Below. | 0 up, asked or stopping, 2 the project file names no app (Set up app on the page), 1 not up in time, its start failed, or the app was still stopping, 3 not running, a question from Slack, a console that serves no session apps, the session refused, or `stop` with no stop command in the project file |
| `session watch [--kind K,…] [--everyone] [--every S] [--herdr]` | Follows the console and prints one line per session that starts, runs, is done with its turn, needs you, pauses, stops, finishes or fails, until stopped; `--herdr` runs it in a Herdr terminal of its own instead, and returns: [below](#watching-sessions). | runs until Ctrl-C (`--herdr`: 0 started or already running); 2 the sign-in ended, 3 refused, or `--herdr` with no `hc` 0.1.21 or newer |
| `session stop <id>` | Stops it, and waits until the console has stopped it, a running one's work checkpointed on the way (up to 3 minutes: past that it says to check with `get`). One that paused or failed by itself is marked stopped by you, as the page's Stop does, so it no longer waits on you. | 0, 1 not answered in time |
| `session resume <id> [--no-wait]` | Starts one of your stopped sessions again, its conversation and all, and waits as `new` does. | as `new`; 3 a shared session (resume it on the console) |
| `session remove <id> [--yes]` | Takes one of your sessions off the list with its saved conversation, stopping it first, and forgets its `woodshed-<id>` machine in Herdr when there is one. It asks first on a terminal; with no terminal it needs `--yes`. | 0, 2 not confirmed, 3 a shared session |
| `session prune` | Forgets the `woodshed-<id>` machines in Herdr whose session is no longer on the console's list: removed on the page, or cleaned up by the console, which only `session remove` would have forgotten. Below. | 0, 1 `hc` could not list or forget one |
| `session extend <id>` | Puts its pause or stop off by an hour. The console allows it in the session's last 15 minutes, to its owner, or a shared session's assignee. | 0, 3 refused |
| `session limits <id> [--idle-hours N\|default] [--lifetime-hours N\|default]` | Its own idle pause and lifetime, in place of yours or the console's; `default` goes back to them. The other is kept. | 0, 1 out of range, 3 not yours to change |

Nothing keeps a session awake for being connected to: it pauses after its idle hours and stops at its lifetime unless
you, or an agent working for you, ask for more with `extend` or `limits`. `list` and `get` (`pause` in `--json`: `at`
and `why`, `idle` or `lifetime`) say when, so an agent can decide whether to.

With `--json` each prints one object per line: `new` and `resume` an `{"event":"started"|"resumed","session":{…}}`,
then a `status` event as it goes in line or starts, a `step` event per start step, and last `running`, `needs-you`,
`failed` or `stopped` with the session; `list` one `{"console","login","sessions":[…],"pullRequests":[…]}`, `get` one `{"session":{…}}`.
Each session has `pullRequest` (`number`, `repo`, `url`, `title`, `state`, `review`, `checks`: the chip's fields, null
while unread), `pullRequests` (every one it opened) and `reviewCommand` (`woodshed review <id>` for your own sessions,
else null); `pullRequests` at the top are your open ones with no session, with their `project` and `branch`. A console
from before it gave them adds `pullRequestsError` and lists the sessions all the same.


Each session's `kind` is what the console's page tells it apart as:

| `kind` | What it is | WHOSE in `list` |
| --- | --- | --- |
| `private` | A My Woodshed session (`mine` is `true` for your own) | `mine`, or `@owner` |
| `shared` | One started from a label, a `/woodshed` comment or the console | who has it (`you`, `@login`), or `shared` for nobody |
| `review` | A review the console runs on a pull request (`pullRequests.review` with `runner: woodshed`), titled `Review: …` | who it was started for: the pull request's author (`you`, `@login`) |
| `qa` | QA the console runs on a pull request (`pullRequests.qa` with `runner: woodshed`), titled `QA: …` | who it was started for: the QA label's (`you`, `@login`) |
| `ask` | A question from Slack | `shared` |

`list` shows a review or QA run's kind with its pull request, `review #145`. In `--json`, `pullRequest` is the one a
review, a QA run or a session from a pull request's label was started on (with the chip's fields when it is also the
one it opened, else `number` and `url` alone), else the last one it opened; `verdict` a review's `APPROVE`, `REQUEST_CHANGES` or `COMMENT` or QA's check conclusion once it
reported, `startedBy` who it was started as, and `inMine` whether the console's rail lists it under Mine: your own
private sessions, and the shared sessions, reviews and QA runs you started or have. `mine` stays your own private
session's alone, the ones `resume`, `remove`, `connect` and `herdr` act on. Which sessions are listed at all is the
page's rule: someone else's private session never, and shared ones, reviews and QA runs among them, only when People
gives you Sessions from GitHub.
`herdr` (and `new --herdr` after its `running`) ends with `{"event":"connected","session":{…},"machine":{"name","action","state"},"agent":{"inHerdr","address"}}`,
and `remove`'s `removed` event has `machine`: `{"name","removed"}`, or null with no `hc` here.

### A session's app

A session runs its repo's app (the project file's `app`) once Start app, or `session app <id> start`, starts it, or its
agent does. `get`, `app`, and a start that reaches `running` say how it is: in `--json`, the session's `app` is the
page's state (`running`, `api-down`, `frontend-down`, `starting`, `stopping`, `failed`, `stopped`, or `none` when the
project file names no app), `appName` and `apps` which of several apps it is, and `appUrl` where it opens. That is the
link the page's Open app opens: `<id>.<app domain>` on the console's scheme and port, or with app ports the port the
console lent it, or the console's `/auth/app`, which lends one. `appLink` says which: `domain` or `port`. `appSignIn`
says whether the link needs a browser signed in to the console: true on a console that requires sign-in, where it is
not a public link and the page's Share the app shares it; false on one nobody signs in to (always with app ports, which
have no Share the app, and an app domain with sign-in off), where it opens for whoever reaches the console; null from a
console that does not say. `app`, `appUrl`, `appLink` and `appSignIn` are null while the session is not running, or on
a console that serves no session apps.

The link opens whatever answers on the app's frontend port in the session, not only what the project file's `start`
runs. To show something the app does not serve (static pages in a folder, a docs site), have the session serve it on
that port, with the app stopped when it holds the port, or start another of the project's apps that serves it (`--app
NAME`); a server started through `woodshed tunnel` needs `setsid … &` to outlive it. Serve a copy of only the files
meant to be seen (no dotfiles, no symlinks): everyone the link reaches, a share's viewers too, sees what that port
serves. The link then opens it, and
`session app` says `running`, or `api-down` when the app's backend is on another port that is not answering. To keep
it, add it to the project file as an app of its own (`apps`, docs/reference.md, "The project file").

`session app <id> start` waits until both the app's frontend and backend answer, and says when its start failed or
it is not up in 5 minutes: its start log is `/tmp/woodshed-app.log` in the session (`woodshed tunnel <id> -- tail -n
50 /tmp/woodshed-app.log`). A start while the app is still stopping (right after `stop`) is not taken by the session,
so it exits 1 at once, saying to try again once `session app <id>` says it is not running. A start of another of the
project's apps while one runs is a switch: the session runs the running app's `stop` first, then starts the new one,
and the command says so and waits for it. A running app with no `stop` in the project file is left running beside the
new one. `stop` on an app whose project file has no `stop` stops nothing: it exits 3 and says so. The commands it
suggests to start an app again name it with `--app` when it is one of several and not the default. A project file with
no app exits 2: Set up app, which asks the session's agent to write one, is on the console's page only. With
`--json`, `app` prints `{"event":"app","session":{…}}`, and `start` an `app-starting` event, then `app-running` or
`app-not-up` with the session; `stop` an `app-stopping`.

## Watching sessions

`session watch` tells you, or a program, when a session starts, runs, is done with its turn, needs you, pauses, stops,
finishes or fails, without opening it: no tunnel, no terminal, no machine in Herdr. It reads the console's session list (`GET
/api/sessions`, the one `list` reads) every 15 s (`--every`, 5 to 600) and prints what changed since the last read:

```sh
woodshed session watch --kind review,qa          # your reviews and QA runs: those on your Mine
woodshed session watch --everyone --json         # every session you can see, one event per line
woodshed session watch --herdr                   # yours, told in Herdr: below
```

```
Watching your sessions (Mine) on https://console.example.com, kinds: review, qa, every 15 s. Ctrl-C stops.
10:42:15  7e7e0010  started  review #145  Review: Fix the login bug  https://console.example.com/s/7e7e0010
10:49:30  7e7e0010  finished (REQUEST_CHANGES)  review #145  Review: Fix the login bug  https://console.example.com/s/7e7e0010
11:02:00  aaaa0001  paused (idle)  private  Fix the login redirect  https://console.example.com/s/aaaa0001
          woodshed-aaaa0001 in Herdr is unreachable until it runs again: woodshed session herdr aaaa0001 brings it back
```

- **Which:** by default those the console's rail lists under Mine (`inMine`); `--everyone` every session you can see.
  `--kind` keeps only `private`, `shared`, `review`, `qa` or `ask`, separated by commas.
- **Events:**

  | Event | When | `why` |
  | --- | --- | --- |
  | `starting` | In line or starting: a new session, or one resumed | |
  | `started` | It runs, from in line, starting, or stopped (resumed between two reads) | |
  | `done` | Its agent is done with its turn, or exited, and waits for a message | |
  | `needs-you` | It asks you something | |
  | `paused` | It stopped by itself after its idle hours (`resume` picks it up) | `idle` |
  | `stopped` | At its lifetime, by a person (`session.stoppedBy`), deleted (also when it is deleted after it had stopped), or otherwise | `lifetime`, `person`, `deleted`, `other` |
  | `finished` | A review or QA run reported (its `verdict`), its pull request merged or closed (also when that is read after it stopped), or this run was stopped for its Slack post | `reported`, `merged`, `closed`, `posted` |
  | `failed` | It failed, or did not start in time (`session.error`) | |

  A review or QA run works by itself, so its turns are not told: it says `starting`, `started`, `needs-you` if it
  asks, then `finished` with its `verdict`, or `failed`; one stopped before it reported is `stopped`, as any session.
  Its time is UTC.
- **A machine in Herdr:** when one of your sessions that `session herdr` made a machine pauses or stops, its line says
  that `woodshed-<id>` is unreachable until it runs again, and that `woodshed session herdr <id>` brings it back (it
  resumes the session and adds its machine again: `resume` alone leaves it unreachable). In `--json` the event has
  `machine`: `{"name","unreachable":true,"bringBack"}`. Only machines whose saved line is this command line's tunnel to
  that session on this console count, as for `prune`; with no `hc` here, nothing is said of one.
- **The first read** only learns what is there: a watch tells what happens from when it starts, never what was already
  running.
- **With `--json`**, the first line is `{"event":"watching","console","login","kinds","everyone","everySeconds","sessions","herdr"}`,
  unless the console cannot be reached at the start: then `unreachable` and `reachable` (below) come before it
  (`kinds` null for all, `sessions` how many it watches), then one `{"event","at","why"?,"session":{…},"machine"?}` per
  change, the session as `get --json` gives it.
- **A console it cannot reach** (a laptop asleep, a redeploy) is asked again at the same pace for as long as it runs:
  `{"event":"unreachable","at","error"}` once, then `{"event":"reachable","at","awaySeconds"}` when it answers, and the
  events of what changed meanwhile. Any 5xx answer counts as away too. Only a sign-in that ended (exit 2, `{"event":"error","status":"signed-out"}`) or a
  refusal (3) stops it.

### Notifications in Herdr, or anywhere

`session watch --herdr` keeps your Herdr told of your sessions without adding any of them as a machine. It checks for
`hc` (0.1.21 or newer, as `session herdr` does), then starts the same watch, with the same `--kind`, `--everyone` and
`--every`, in a terminal of `hc`'s own and returns:

```sh
hc run --bg --json --name woodshed-watch --no-parent --label herdr.space=woodshed --label herdr.tab=woodshed-watch -- \
  /usr/bin/env WOODSHED_WATCH_IN_HERDR=1 [XDG_CONFIG_HOME=…] <node> <this cli/woodshed.mjs> session watch --console <console> … --herdr
```

- **It runs on** with no parent, so closing the terminal you ran it from leaves it; `hc kill woodshed-watch` stops it.
  Run again while it runs, it is left as it was (`{"event":"herdr","action":"kept"}`; `started` with its `address` the
  first time). The words are run as they are, never through a shell, by the same absolute paths as a machine's `--via`
  line, so it finds this sign-in.
- **In its terminal**, each event is an OSC 7501 record, hc's own report of an agent's state, one per session (`id=<session>`), which
  `hc get woodshed-watch` lists under `records` and the Herdr app reads as it does its own agents':
  `starting` and `started` are `working`, `done`, `paused`, `stopped` and `finished` are `done`, `needs-you` is
  `blocked` with `kind=question`, and `failed` is `error`. Its `title` is the session's, and its `msg` says what
  happened (`aaaa0001 paused (idle)`), the session's link when it needs you or failed, and for a machine in Herdr that
  it is unreachable until `woodshed session herdr <id>` brings it back. hc takes a record's `title` and `msg` only in
  base64, which is how they are written. A session back at work after a question or a turn gets its record put back to
  `working`, with no line printed. A session's record is cleared (`state=clear`) an hour after it ended, or once
  it is no longer on the list or watched. The terminal shows the watch's lines too.
- **The first read** tells nothing, as above: a session already waiting on you when the watch starts gets a record at
  its next change.

A Herdr app mod gets `notify({title, body, level, icon, timeout})` and can run a command. One that runs `woodshed
session watch --kind review,qa --json` (in a herdr-core terminal of its own, as the Woodshed mod runs `session new`)
and reads its lines can turn each event into a toast: `started` into "Review #145 started", `needs-you` into "Review
#145 needs you" opening `session.url`, `finished` into "Review #145: REQUEST_CHANGES" (its `verdict`, or `stateWord`
when it has none), and `failed` into "Review #145 failed" with `session.error`, each with `session.title` as its body.
No hc machine, tunnel or `session herdr` is involved: the watch only reads the console's list, as `list` does.

Without Herdr, a pipe into Node does the same with the computer's own notifications (`notify-send` on Linux; on macOS,
`osascript` with `display notification`):

```sh
woodshed session watch --kind review,qa --json | node -e '
  require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
    const { event, session: s } = JSON.parse(line);
    if (!s) return;
    const what = `${s.kind} #${s.pullRequest?.number}: ${event}${s.verdict ? ` (${s.verdict})` : ""}`;
    require("child_process").execFile("notify-send", ["Woodshed", `${what}\n${s.title}`]);
  });'
```

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
- **Leftovers:** a session removed on the console's page, or cleaned up by the console, leaves its machine in the
  sidebar, unreachable. `session list` names each `woodshed-<id>` whose line is this command line's tunnel to that
  session on this console and whose id is not on the console's list at all, and `session prune` forgets those, with
  the same check as `remove`. A paused, stopped or deleted session still on the list keeps its machine (`session herdr`
  brings a paused one back), and any other machine is never touched. The list is the signed-in person's: a machine
  added while signed in to the same console as someone else reads as a leftover.
- **The agent** appears in a space on the machine when you picked Herdr under Agent terminal on My settings before the
  session started. `session herdr` places the running terminal (`woodshed-<id>/claude`) and keeps any existing layout.
- **Names:** with the Herdr app's window open, `session herdr` then names the agent's space after the session's title
  and its tab after its agent (`claude` or `codex`), with `herdr-app do space.rename` and `tab.rename`. It renames a
  space or tab only while it has Herdr's default name (none, the checkout's folder, a tab's number) or the name it gave
  last, which it keeps in the terminal's `woodshed.space-name` and `woodshed.tab-name` labels: never one you renamed.
  The console names a session a few seconds after it starts, so running `session herdr` again picks up a later title.
  With no `herdr-app` or no window, nothing is named and nothing is said. The machine stays `woodshed-<id>`.
  With tmux selected, open the agent in the browser or use `session connect`. The machine still works for new terminals.
- **No `hc`,** or one older than 0.1.21, exits 3 and says so. Nothing here installs or updates it: `hc update` does,
  when you choose.
- `hc` machines have no label of their own, so the sidebar shows the machine's name, `woodshed-<id>`; `session list`
  gives each id's title.

### The session's agent as a child of a terminal here

`session new --herdr --parent` (and `session herdr <id> --parent` for a paused or stopped session) makes the session's
agent's terminal a child of a terminal on this computer, so an agent there can `hc wait --children any` (or `all`) and
wake when the session's agent ends a turn, blocks, errors or exits, and Herdr types notes about it into its parent:

```sh
# from a Herdr terminal here (HC_TERMINAL_ID is set), say Claude Code's
woodshed session new --herdr --parent "fix the login bug"
hc wait --children any
```

- **Which terminal:** the one the command runs in, `HC_TERMINAL_ID`, with `--parent` alone; another here with
  `--parent=<t>` (its address or name), or `--parent t7` when the next word reads as an address. Either way the command
  must run in a Herdr terminal: `hc` takes a parent on another machine only from its caller's terminal, and refuses an
  explicit `--parent` across machines (`hc run --on m --parent t7` looks `t7` up on `m`). Exits 3 otherwise, before
  anything starts.
- **How:** the console starts (or resumes) the session with `herdrParent`, and its entrypoint starts Herdr but leaves
  the agent's terminal unmade, saying so in `/tmp/woodshed-agent-terminal.json` with its checkout. Once the session runs
  and its machine is added, this command reads that file through `hc file read --on` and makes the terminal the
  entrypoint would, with `HC_TERMINAL_ID` naming the parent:
  `hc run --json --bg --on woodshed-<id> --keep --name claude --cwd <checkout> --outlive-parent`. It is a login shell
  on the session's core, in the session's environment; the session types its agent into it with the same flags,
  prompt or `--resume` it uses in its own terminal. Herdr runs the agent whatever Agent terminal on My settings says.
- **It outlives its parent** by default (`--outlive-parent`): a cloud session is not ended because a laptop's terminal
  closed or slept, and hc's own default is to end a child with its parent's program, on another machine too.
  `--end-with-parent` keeps hc's default; `--no-notify` passes hc's, so no notes are typed into the parent.
  `hc wait --children` works either way.
- **What wakes the parent** is Herdr's: a turn ending or the agent blocking comes from the agent's own status records.
  claude sends them; the pinned codex sends none, so a codex child wakes `hc wait --children` only when it exits. The
  `connected` line's `parent.reportsStatus` says which.
- **A running session cannot take a parent.** hc sets a terminal's parent once, as it starts, and has no way to change
  it, so `session herdr <id> --parent` on a running session adds the machine and exits 1, saying its terminal was
  already there and what parent it has (`parent.has` in `--json`: the parent as the session's core names it, `<core>/t7`,
  or null for none), or that its agent runs in tmux (`parent.there: false`). Only one still waiting for its terminal (started with `--parent`, its command line stopped before it
  made it) takes one.
- **The session waits 5 minutes** for its terminal, then makes it itself, with no parent, so the agent starts all the
  same; the session's log says `WARNING: no parent made the agent's terminal`, and this command, if it comes later,
  exits 1. The log says `Agent's terminal made by its parent` with the parent when it came.

`hc` runs with your environment, so `HC_SESSION` and the XDG folders pick the core it talks to, as they do for `hc`
itself. `WOODSHED_HC_BIN` names another `hc` than the PATH's.

Besides its own `/api/cli/*`, the tunnel's `/api/tunnel/exec/<id>`, the terminals' `/api/tunnel/term|shell/<id>` and a review's `/reviews/claude-<id>/...`, the console lets the token reach these routes and
no others (`console/cliSessions.mjs`), each as its person:

- `GET /api/sessions`, `GET /api/my/projects`, `GET /api/my/pulls`
- `POST /api/my/pulls/<number>/review`: `woodshed review start`, on a pull request of your own
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

## Moving work into a session

`woodshed move` (`move.mjs`) takes work from this computer into one of your sessions. Its supported source is
`--from herdr`, which takes your Herdr terminals as they are. Run `woodshed move --help` for the options.
Use `woodshed session herdr <id>` to add an existing session to Herdr's sidebar.

```sh
woodshed move --from herdr --space api --to new          # a new session for each repo the space's terminals are in
woodshed move --from herdr --terminal t3 --terminal t5 --to <id>   # into one of yours, on the same repo
woodshed move --from herdr --tab main --to new --dry-run --json    # the move bundle, and nothing done
```

`--terminal` (repeatable; an `hc ls` address or a name), `--tab` or `--space` (an id or a name, as `herdr-app ls`
shows them) choose what moves. Each terminal is read from `hc` and is one of:

- **an agent,** Claude Code or Codex, by its program or its status record. Its conversation is its `claude.session`
  (or `codex.session`) label, else the id on its command line (`--resume`, `--session-id`), else the conversation of its
  folder last written when it last changed state, else, alone in its folder, the folder's newest
  (`~/.claude/projects/<folder>/<id>.jsonl`, or Codex's rollout file). One mid-turn refuses the move: a conversation
  moves between turns. Two whose conversation cannot be told apart refuse it too, and say to label them.
- **a shell,** in its folder;
- **a program** (`Terminal.foreground`'s argv): started again there only when you say so, with `--restart auto`, or yes
  to the question (`--restart ask`, the default; with no terminal to ask on, it is not). One whose command line holds
  what may be a credential (a known token's shape, a password argument, or an inline curl cookie) is
  never started again there, whatever `--restart` says: the session gets a shell in its place. Its command line is
  printed with those values as `…`, everywhere.

A session runs one kind of agent, with that kind's flags and guards (the ask before `gh pr merge`, the ready gate), so a
Claude terminal is not moved into a Codex session, nor the other way round, and `--to new` refuses a repo whose terminals
mix them.
A Codex move also needs a session image that reports the session's Codex launch flags, so the conversation resumes
with the sandbox and approval policy picked for that session.

Then, in order (`move.mjs` says each step):

1. **The code.** Each checkout's work is committed as it is, untracked files included, built in a temporary index so your
   branch, index and files are never touched, and pushed to `woodshed/move-<id>`. Files git ignores (`.env`) never go,
   and are named: `woodshed settings push --own-files` gives your sessions your own. A file that looks like a secret, by
   its name (`.env`, `*.pem`, `id_ed25519`, `credentials.json`) or its content (a private key, an AWS, GitHub,
   Anthropic, OpenAI, Slack or Stripe key, an npm token), refuses the move with its path, line and kind, never the value.
   What is read is everything the push would send that the remote does not have (its branches asked of it with
   `ls-remote`), commits not pushed yet included. The move checks outgoing file and directory names and scans blobs,
   including binary files, for recognized credentials. It also refuses literal credential header values in outgoing
   content, such as a bearer token in a plain-text or JSON request log. The Git scan allows values the remote's copy of
   the file already holds. Embedded JSON strings are screened with a bounded decoding budget. Files over 20 MB refuse
   the move. A remote that pushes to more than one place, or that
   git rewrites to another repo (`pushInsteadOf`), is refused.
   A new Git LFS pointer also refuses the move because its payload is outside the Git tree. The move's push skips LFS uploads.
   Changed submodule commits must exist on a remote-tracking branch in their initialized checkout. The move pushes only
   the parent repository.
   A conversation holding what looks like a credential refuses the move too.
2. **The session.** `--to <id>` is one of your own sessions on the same repo, resumed when paused; `--to new` starts one
   per repo on its branch, with no prompt (`Moved from <computer>: <space>`). Each is added to Herdr as `session herdr` does (a resumed one is added again, since its core is new).
3. **The conversations,** with every folder in them said as the session's, written with `hc file write --on` where the
   session's agent reads them. If a copy of the conversation is already there, the move keeps it and refuses the import.
   Nothing else of your home goes.
4. **The layout:** the same spaces, tabs and splits, with `herdr-app do space.new --machine woodshed-<id>`, `tab.new` and
   `pane.split`, read from the `herdr-app` document in `hc` (never written). With no Herdr window open, each terminal is
   started with the `herdr.space` and `herdr.tab` labels the app adopts it by, its splits side by side. A split's size is
   not kept: no app command sets one.
5. **The agents.** Two agents never work on one branch. In a new session, the first checkout for that repo is its
   primary checkout. Its first agent, if any, takes the place of the session's empty starter and keeps its flags, so
   the console follows it as the session's own. That needs Herdr picked as Agent terminal on My settings, or the move
   is refused. Agents from other checkouts, additional agents in the primary checkout, and agents moved into an
   existing session each get a branch of their own
   (`woodshed/move-<id>-<n>`) and a git worktree in the session's home, trusted for it ahead; those push their own
   branches, since a session's stop pushes only its own.
6. **The hand-over.** Each local agent is ended (`/exit`, `/quit`) only once its moved one reports a state, and its
   terminal is labelled `woodshed.moved=<where it went>`.

Anything failing before the hand-over undoes what the move made, in the session (its spaces, worktrees and files, or the
new session itself) and on GitHub (its branches), and leaves this computer as it was. Programs restart rather than move,
and their local copies keep running. Databases stay: the session has its own.

Exits: 0 moved; 2 a moved agent needs you (or not signed in); 3 refused (a secret, an agent mid-turn, another repo, a
shared or tainted session, no `hc`, or a new session's agent in tmux); 1 anything else, after undoing. With `--json`,
each step is a `step` event (`pushed`, `session`, `connected`, `conversation`, `layout`, `resumed`, `live`), and the
last is `moved` with the sessions, branches, each terminal's new address and the move bundle; `--dry-run` writes one
`bundle` event.

## Settings

`woodshed settings` joins this computer to the Claude and Codex settings your private sessions already keep in step
(console/README.md, "Your Claude settings"), saves a few dotfiles as your own lines for them on My settings, and saves a
checkout's ignored files as your own files for its repo there.

| Command | What it does | Exits |
| --- | --- | --- |
| `woodshed settings plan` | Lists each item with its size and what push would do with it: `upload` (new or changed), `skip` or `refuse`, and why. Sends nothing. With `--pull` (and `--replace`), what pull would write instead, and what each item that runs here runs. Writes nothing. | 0 |
| `woodshed settings push` | The same list, then the uploads. An item never listed before is asked about on a terminal; with no terminal (or `--json`) nothing is sent until `plan` has listed it. | 0 sent or nothing to send, 2 not shown before or not confirmed |
| `woodshed settings pull` | Writes the shared copy here: what is missing, and with `--replace` what differs, keeping a copy of each replaced file under `~/.config/woodshed/backups/`. Never deletes. Anything but `keybindings.json` is held until its content was listed, below. | 0, 2 something held |

Each takes:

- `--only <what>,...`: a kind of item (`settings`, `keybindings`, `memory` for `CLAUDE.md`, `agents`, `commands`, `skills`,
  `mcp`, `codex`, `plugins`, `dotfiles`, `own-files`), or a name as the list shows it (`skills/review`, `mcp/github`,
  `.codex/skills/review`, `plugin/review@acme-tools`, `dotfile/gitconfig`, `.env.local`). Repeatable.
- `--own-files <checkout>`: also the checkout's files that git ignores and does not track, saved as your own files for its
  repo (told from its `origin`), which your next session on it writes where git ignores them. Env files (`.env.local`,
  `*.local.json`, `.dev.vars`) are taken by default; any other ignored file only when `--only` names its path. A folder
  git ignores whole (`node_modules/`) is not looked into. A path the repo's project file writes as an env file is
  skipped: its values go on My settings' Repo settings.

**What is carried.** The session sync's own items, from `~/.claude` and `~/.claude.json`: `settings.json`, `CLAUDE.md`,
`keybindings.json`, `agents/`, `commands/`, `skills/`, and your user-scope MCP servers; from `~/.codex`: `config.toml`,
`AGENTS.md`, `prompts/` and `skills/` (never `auth.json`, your Codex sign-in, which is My settings'; nor codex's own
`skills/.system`); and each plugin you installed for your whole home (user scope), as the marketplace it comes from. Items
merge as a session's do, and push never removes one from the copy (the console refuses a removal from a computer). A
file's mode is not carried: a pulled script runs as `bash script.sh`, as it does in a session.

**Plugins** go as a name and a marketplace, never their files: your next private session installs each one it lacks
(adding its marketplace first), once, so one you uninstall or turn off there stays that way. One installed for a repo
alone (project or local scope) stays here, and so does one whose marketplace a session cannot add: a folder on this
computer, a source pinned to a ref, a URL with a sign-in. Pull never installs one here: it lists each your sessions have
and this computer has not, with the `claude plugin install` that does it.

**Dotfiles** go one way, from here, as your own lines on My settings (console/README.md, "tmux and dotfiles"), which your
private sessions write after their own: `dotfile/gitconfig` from `~/.gitconfig`, `dotfile/inputrc` from `~/.inputrc`, and
`dotfile/bash-aliases` from the `alias` lines of `~/.bash_aliases`, `~/.bashrc` and `~/.zshrc`. Each takes only what
`shared/dotfiles.mjs` allows, and the list names what it left out: git's aliases, colors and how diff, merge, pull, push
and rebase behave, never `[user]`, `[credential]`, `[url]`, `[include]`, a pager, an editor or a signing key; never an
export, a command, an alias naming a path in your home or one holding a credential. A push asks about each dotfile on its
own, and replaces what My settings had for it. Pull leaves them out.

Claude MCP definitions pushed from a computer are available to the person's computers only. Pull can also bring in a
server configured in a private session. If a laptop and a session save the same name, each keeps its definition.
Servers the console provides to sessions are configured by an admin and use its relay.
Codex MCP definitions configured on a computer stay there. A push keeps any Codex servers already shared by private
sessions. Pull keeps this computer's definitions and can add a session's servers. If either file uses a single inline
server map, pull keeps the computer's whole map.

**What runs here is shown first.** Sessions write the shared copy, unattended, and everything in it but
`keybindings.json` can make this computer's claude run something. So `pull` writes nothing else until a list has shown
that exact content (by its hash), listed with what it does: an MCP server's command and args or URL; every key of
`settings.json` (hooks, env, permissions, `defaultMode`, plugins) and of codex's `config.toml`; a skill's, command's or agent's frontmatter (its
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
- An MCP server run as `/opt/homebrew/bin/npx` (or from `/usr/local/bin`, `/usr/bin`, `/bin`) runs as `npx`, from
  the receiving computer's or session's PATH. Any other absolute program path is skipped.
- In `config.toml`, the folders each side trusts (`[projects."…"]`) and where codex sends its calls (`model_provider`,
  `[model_providers.…]`, `profile`, `[profiles.…]`, `openai_base_url`, `chatgpt_base_url`) stay each side's own. An entry
  that names a path in your home, holds a literal HTTP header, or holds a credential (an `env` value named like one,
  a `bearer_token`, a URL with a sign-in) stays on that side, along with the rest of its server entry.
  A `pull --replace` keeps those entries. An `env_key`, `bearer_token_env_var` or `env_http_headers` entry can still name a variable.

**What is refused**, by name or kind, never by showing it: MCP logins (sign in to the server where you use it), an MCP server
whose `env` holds a literal key, literal HTTP headers on an MCP definition or hook (`${VARIABLE}` is fine), a file named like a secret (`.env`, `*.pem`, `id_rsa`,
`credentials.json`) in a skills, agents or commands folder, and one holding what looks like a private key or a GitHub,
Anthropic, OpenAI, Slack, AWS, Stripe live or Google key. For own files, keys and certificates, files named for production
(`.env.production`) and live keys.

A symlink in `~/.claude` (a linked `skills/`, a linked `settings.json`) is neither read by push nor written through by
pull, nor is an empty own file pushed (My settings would take it as removing yours). `CLAUDE_CONFIG_DIR` and `CODEX_HOME`
are not followed: settings reads `~/.claude`, `~/.claude.json` and `~/.codex` only, and says so when one is set. A dotfile
is read through a symlink, since nothing is ever written to one.

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
