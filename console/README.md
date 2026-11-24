# The console

It starts through `providers/console.mjs`, which picks a provider and hands it to `startConsole` in
`console/server.mjs`: `aws` (sessions as Fargate tasks, and the AWS CLI its secrets, Claude homes, databases and
webhook queue go through) or `local` (sessions in docker on the same machine, with none of those yet).
`WOODSHED_PROVIDER` names it; without it, `WOODSHED_LAUNCHER=ecs` means `aws`, and the default `docker` means
`local`. Nothing in `console/` imports a provider.

`console/server.mjs` is dependency-free Node ESM, like Woodshed, and keeps its
look. Every session page is one shell: the rail on the left, and a pane on the right. The rail's head is
one row: a **Mine | Everyone** switch, **+ New session**, and on Everyone a **People** filter. Each side is a page
of its own: `/all` (Everyone) shows the shared sessions in the pane, with a status filter, and `/` (Mine) shows New
session. **People** filters Everyone by who started a session (it takes several people; `?by=<login>,<login>` in
the URL). Your avatar menu (My settings, the console's pages, Sign out) is at the foot of the rail and opens upward.
A card shows the title and its tag (on Everyone, and on Mine for a session you started that someone else has, the Assigned tag is the assignee's name), then a second line with the status, a name only when the card does not already say it (`from <person>` on a shared session someone else started, on Mine, or one nobody has, on Everyone), and the PR chip at the right end. On a console with more than one project, each card's left edge is its project's colour (the name is in its tooltip), and a row of chips under the head (**All**, then each project with its colour and count) filters the rail to one project; the browser keeps the pick (`woodshed-rail-project`), and one naming a project that is gone is All. How long it ran and who started it are under its Details; the app's button and the
CPU and memory badge are in the pane bar, not on the card. **Assigned sessions.** The person who adds the `woodshed` label, or writes the first `/woodshed` comment, has the shared session
if they *Can be assigned* (a switch per member on People, off for a new member, which needs Sessions from GitHub; an admin
turns it on, see "Sign-in"). A starter who cannot be assigned leaves it unassigned. **Mine** lists your private sessions and the shared ones you
started (your label or `/woodshed` comment, on your Claude plan when your switch is on) or that are assigned to you: **Needs you** (stopped sessions waiting on you; **Move to Stopped** in a card's ⋯ menu marks one stopped by you, which moves it to Stopped and leaves Resume as it was), then **Active** (those waiting on you first), **Finished** (assigned shared sessions whose pull request is in Slack) and **Stopped**; **Everyone** lists every shared session with **Unassigned** at the top. Both end with **Reviews and QA**, folded until opened: the review and QA sessions the console starts on pull requests, which run by themselves, so they are never Unassigned and cannot be assigned: no Take it, and no Assign in their ⋯ menu. A console one person uses has one list of
every session, with no switch, and its head reads **My sessions** (`/all` opens it): one nobody signs in to (it listens on
loopback alone), one whose People list has a single member, or one whose `WOODSHED_ONE_PERSON` is `1`. The setting
decides when set, `0` keeping the two views (the dev console sets it, `DEV_CONSOLE_ONE_PERSON=1` for the one list);
`/api/sessions` says which in `onePerson`. **Take it** on
an unassigned card, or **Assign to me**, **Hand over…** (a dropdown of who can be assigned) and **Unassign** in the card's ⋯ menu, change
who has it; only someone who can be assigned can (`POST /api/sessions/<id>/assign`). A later comment from someone else does not move it, but
someone who can be assigned commenting on an unassigned session takes it. Assignment is a label, not a permission: a shared session stays visible
to everyone with Sessions from GitHub, and a private one cannot be assigned. On an issue's session the GitHub issue follows: the assignee is put on
the issue, a hand over or Unassign takes off the person the console put there, and someone GitHub already had assigned
stays (`console/issueTracking.mjs`). The console's colors, type and rail rules are written down in `console/designSystem/` (tokens, usage rules and component cards); `console/designSystem.test.mjs` fails when its colors differ from `style.css`. `/s/<id>` opens on the tab the session belongs to, with the shed's session pane: a bar
with **Chat**, **TUI**, **Terminal** and **Review** tabs, the title, status, issue,
branch and PR, and the session's buttons. Terminal and Review each hold two views, picked under a small switch beside
the tabs while one shows: **Shell** or **App log**, and **Review** or **Diff**; each tab opens the one last open. On the
right: **Invite** (below), one meter for the plan and the machine, **Open ▾** (the editor and the databases' viewers),
the app's button and **Stop**. As the bar narrows the session's name keeps its room: the meter goes first unless
something runs high, then Invite, then Details, Open and the PR chip fold into **⋯**, and on a bar narrower still the
name and status take a row of their own. What the bar leaves out is in Details (the
meter's readings and Invite) or in ⋯. On a phone the rail is the page,
after the standalone shed's: sessions are rows with a star and ⋯ big enough for
a thumb, Shared's status filter is chips above the list, ⋯ opens as a sheet
from the bottom, and **+ New session** is a screen of its own (`/?new=1`).

**Invite**, in a private session's bar, copies `/?new=1&on=PR%20%23123` (the session's PR, or its branch
while it has none and GitHub has it). Whoever opens it signs in first (`/login?next=` keeps the address) and lands on
New session with Work on filled in, to start their own private session on their own Claude. The link holds the PR or
branch alone, so the session stays private. With nothing pushed there is no button, and Details says why.
The settings pages (My settings, Settings with its General and Secrets &
webhooks tabs and any a program embedding the console adds, and People) keep the same frame: a list of them takes the rail's place,
with **‹ Back to sessions** and the avatar menu above it. Webhook events, a log rather than a setting, is in neither the
list nor the menu: Secrets & webhooks links to it, it has a **‹ Secrets & webhooks** link above its title, and Settings
is marked in the list while it is open. Keyboard shortcuts is under the list's This browser group, not the avatar menu.
Each page opens with a **tag for whose sessions it changes** (`Only you`: your My Woodshed sessions; `Everyone`: shared
sessions and the console), and the side list has a **search** at its top (`public/settingsSearch.js`, `settingsIndex.cjs`). The search
lists every section of every page you can open, narrows as you type (`repo`, `token`, `timeout`, `slack`…) and takes
you to the section, on its page. A new card on a settings page needs an entry in `settingsIndex.cjs`
(`settingsIndex.test.mjs` fails when its id is not on the page). Where a name appears on both sides, the card says
whose it is: **My repo settings** and **My session timeouts** are yours; Settings' Sessions card and each repo's Settings are everyone's.
- **TUI** is the agent's own screen, live: claude's (or codex's) tmux, through ttyd on 7681.
- **Terminal** is a plain shell in the repo, beside claude, with the same
  environment. It runs in its own tmux session, `shell`, through a second ttyd
  on 7684 at `/shell/<id>/`, behind the same sign-in and owner checks as the
  TUI's.
- **Diff**, while the session runs, is what its checkout changes against its merge base with the default branch, uncommitted
  and untracked work included, as plain git diff: no analysis and no GitHub. It is read when the tab opens and on
  **Read again**, never on a timer. A file past the review parser's line caps, or past 2 MB of hunks in all, shows
  its counts only. statusd's `GET /diff`
  (`session/sessionDiff.mjs`) builds it with the review's own `worktreeDiff` and `parseUnifiedDiff`, and answers in
  the shape of `console/review.mjs`'s `shapeReview`, so the page draws it with the stopped Review tab's code. Once the
  session stops, Review shows what it pushed.
- `?tab=terminal` opens on Terminal's Shell, `?tab=applog` on its App log, `?tab=review` on Review and `?tab=diff` on
  Review's Diff.
  With no `?tab`, as from the rail, a session opens on the tab it was last left on in that browser tab
  (`public/sessionTabs.cjs`: sessionStorage, read only by the login that picked it and dropped at sign-out), and on
  one it was never left on, the person's default view: Chat or TUI, one for a desktop and one for a phone (under
  720px), from My settings' Display card (`viewPrefs.mjs`, `GET` and `POST /api/my/session-view`; the console logs
  `viewPrefs: session view changed`). Chat unless they changed it. Until a tab is picked it follows the window's width. The page
  never writes `?tab` itself: a tab picked lives in the history entry's state, so a reload, Back and Forward keep it
  (the entry's tab wins over its address), and an address only ever carries a link's tab, kept as it came after a pick
  or a fallback (it goes through sign-in as it came, and a ?tab nobody linked to never reaches someone else).
  `?tab=chat` asks for Chat itself, as Open the chat and Resume do; a tab remembered as `agent` before TUI's rename
  opens TUI. A tab the session cannot show now opens the other view of its pair where that one can show, as the bar's
  tab does (Diff once it stopped opens Review, Terminal with no shell App log), and TUI otherwise; a remembered one is
  then remembered as the tab it opened. Until the route's lookup answers, the list may be the kept snapshot's, so the tab is held and tried again first.

Both terminals stay connected while another tab shows. A session started from an
image without the second ttyd has Terminal greyed out.

**The terminal page.** Both tabs frame the console's own page, `/static/term.html#term/<id>` (or `#shell/<id>`):
xterm.js, copied into `public/vendor/xterm/` at the versions ttyd 1.7.7 bundles, and `public/terminalPage.js`, which
speaks ttyd's protocol on `/<kind>/<id>/ws`. The page names its files by hash, as every page does, so the browser keeps
it and opening a terminal loads only its websocket; ttyd's own page (190 KB gzipped, sent with no cache headers) came
from the session through the console on every open. The session's ttyd is the connection alone. Its first message is
the console's (`terminalProxy.mjs`): ttyd's credential with the size the page asked for, so the page never holds the
credential, and every other ttyd path, `/<kind>/<id>/token` among them, answers 404. A browser's compression offer goes to ttyd with
`client_no_context_takeover` added, and ttyd's answer comes back with it too should ttyd leave it out, so the browser
compresses each message on its own: the console can read that first message compressed and send its own uncompressed,
and nothing after it refers back to bytes ttyd never saw. ttyd's output stays compressed. The session's `-t` flags (theme, scrollback) reach the page as ttyd's
preferences, as they did ttyd's page. tmux sizes the agent's window by the client used last, and only input counts, so after a phone opened a session a
desktop that only scrolls or comes back to the front would stay at the phone's width: the page sends tmux a focus-in
on a wheel, a click or tap, or its window coming to the front (at most every 2 s, and only while tmux asked for focus
events, `focus-events on` in `session/tmux.conf`), which gives tmux that device's size again, and only from a terminal on
screen: one not displayed (a phone on its list, another tab) never takes the window. Nor is a terminal ever fitted below
20 columns or 5 rows: a frame squeezed to nothing for a moment as the page changes would make xterm's fit its 2x1
minimum, tmux would draw every device's screen at 2 columns, and claude's lines would stay that narrow in their
history. The last size stays until the next resize. In one browser,
`localStorage['woodshed-terminal-page'] = 'ttyd'` goes back to
ttyd's page (`session.js`, `terminalSrc`), which works as before without `/token`.

On a phone (720px wide or less) it works as the shed does there: the sessions
page is the rail, and a session's page is its pane alone, with **‹** back to the
list. The terminal is drawn at 0.7 of its size so about 70 columns fit, and a
key bar under the pane bar sends what a phone keyboard lacks: esc, ↑, ↓, tab,
⇧tab, ⏎ and ^C, with **A−** and **A+** for the size. Keys go to the terminal
frame's xterm without focusing it, so the phone's keyboard stays down. The
pane bar is two rows there: the name over its state, PR and usage, with **⋯**
for the session's details, the app, its databases, the key bar's switch and the
card's own actions; then the tabs.
The size and the key bar's choice are remembered in the browser.

A running session opens on its **Chat** tab unless its person picked TUI as their default view (`public/chat.js`): the conversation as a chat instead of the agent's
terminal. The thread is read from the agent's own record of it, claude's transcript or codex's rollout, through
statusd's `GET /transcript` (session/README.md), every 1.5 s while the agent works or a message waits to show and every
5 s otherwise, with `since` so a record that did not move costs the session a stat. The person's messages are on the
right; the agent's replies are Markdown, read into a tree and built as DOM nodes, never as HTML, with only http(s)
and mailto links (`public/chatThread.cjs`); each run of tool calls between them is one work log, summed up in a line
(`Ran 3 commands, edited 2 files`, `1 failed`) that folds open to the calls, open while it is the turn still running.
Under a turn's last work log that edited a file, **Changed N files** lists what the turn's edits changed, a row a file
with its `+N −M`, each folding open to its hunks in the Diff tab's colours, built from the edits the record carries
(statusd's `GET /transcript` gives each edit a small diff: session/README.md). It is open while the turn runs and folded
once it is over. Files a command changed (`sed -i`, a generator) are in no record: a turn that ran one says so, with a
link to the **Diff** tab, which has the whole branch.
The composer under it sends with Enter (Shift+Enter is a new line; on a phone Return is a new line and the arrow
sends), takes files from **📎**, a paste or a drop (to `/tmp/uploads`, their paths added to the message), dictation
where the browser has it, and keeps its draft with the phone's message box. A message shows as sent until the record
holds it. While the agent works the line over the composer says **Working** with its clock, from the console's state
or sooner from the record (a turn that ends on the person or a tool, written in the last 90 s and after the console
last said it settled), and **■** stops the turn: `POST /api/sessions/<id>/interrupt`, which types Esc into the agent's
pane (`console: agent interrupted from the page`). claude's questions (AskUserQuestion) are answered in their card:
one option picked for each question, then **Send answers**, `POST /api/sessions/<id>/answer`, which statusd types
into claude's picker only once its pane shows that same question with those options, from the highlighted row, and
checks the pane again after each step (`session/panePrompt.mjs`, session/README.md). An approval the pane shows,
claude's permission dialog or codex's approval, is read from the screen (`GET /api/sessions/<id>/prompt`) onto the
**Needs you** line with **Approve** and **Deny**, under the same check. A pane that is not what was answered is a 409
the page shows as `Not answered: <why>` with a way to the TUI tab; the console logs `console: answer typed in from
the page` with the picks' numbers or the decision, never their text. A free-text answer, a question that takes
several options, and anything else the agent asks only in its terminal stay **Answer in the TUI tab**. The agent still runs in its terminal, on
the **TUI** tab (`?tab=tui`; `?tab=agent`, its old name, still opens it): hooks, Remote Control and Resume work as before. A session that is not running has
no Chat tab and shows its start or its end there.

**More than one agent in a session.** The owner of a running My Woodshed session can start another agent in it, beside
its own: the agent switch on the pane bar, after the tabs while Chat or TUI shows (`components/AgentSwitch`), has
**+ Another agent**, a dialog with New session's Agent, Model, Effort and Permissions and an optional first message
(`POST /api/sessions/<id>/agents`, checked as New session checks its form; the console logs `console: another agent
asked for`, and `fleet: another agent allowed in the session` the first time a session runs that agent). Up to three
run beside the session's own, each in the same checkout in a terminal of its own (`session/agents.mjs`): a tmux
session, or a Herdr terminal when the owner's Agent terminal is Herdr, which their own Herdr then shows beside `claude`. The
switch lists them all with their state words and says how many others need you; picking one points Chat at its own
conversation (`/api/sessions/<id>/agents/<agent-N>/transcript`, `send`, `interrupt`, `prompt`, `answer`) and the TUI
tab at its terminal (`#term/<id>?arg=agent-N` on the terminal page, which puts `arg` on its websocket for ttyd's URL
argument; `/term/<id>/?arg=agent-N` on ttyd's own page). The pick is kept per session in the browser tab.
**Stop** in the switch's menu ends one. A Codex agent beside claude runs on its owner's Codex sign-in, which the
console sends with that start alone, or on the team's OpenAI key through the console's proxy, which the session may use
only once the agent started (`fleet.allowAgent`), as a Codex session does. A session's lockdown drops that at once and cuts
its calls on the way (`openaiProxy: calls cut at the lockdown`). A shared session, a question, a review and a QA run have none, nor a session
that has seen production data: its lockdown stops them. They last while the session runs: a Resume starts its own
agent alone. The command line does the same (cli/README.md, "Sessions"): `woodshed session agents <id>` lists them,
`woodshed session agent <id> --agent codex --model … "first message"` starts one, `… stop agent-N` ends one, and
`woodshed session connect <id> --agent agent-N` puts a terminal on one (`x-woodshed-agent` on the terminal pipe,
`console/execPipe.mjs`).

Under claude's terminal on the TUI tab, a phone has a message box
(`public/messageBox.js`): the phone's own keyboard, so autocorrect, dictation
and paste work, **📎** for photos and files, and **🎤** for the browser's speech
recognition (hidden where the browser has none). Files go to `/tmp/uploads` with
nothing typed (`upload?pane=none`); **Send** puts the text and their paths into
claude as one message, through statusd's `POST /send`. Return is a new line. An
unsent draft stays with its session in this tab. A terminal whose connection
dropped (a phone in the background closes it) reconnects by itself once the page
is in front, at most three times a minute; past that it says "Press ⏎ to
reconnect" (`terminalPage.js`; on ttyd's own page, `terminal.js` presses it).

Review, while the session runs, is the shed's own page and server, run inside
the session: statusd hands `/shed-review/*` to `session/reviewShed/`, which
mounts the shed's `review/index.mjs` unchanged, and the console only carries
`/review?session=claude-<id>` and `/reviews/claude-<id>/...` to it
(`console/reviewProxy.mjs`, which knows nothing of reviews). The tab frames that
page, once, so the chat and open asks survive a tab switch. Opening it takes a
review of the checkout and starts the analysis, the first time the tab opens in
the container and only when the review has none: a reload, a finished or failed
analysis (its **Retry analysis** is yours), or a **Discard** pressed since, runs
nothing (statusd logs `review: analysis on opening` with `started`). A resume is
a new container, so it takes the review again and runs the analysis again. The shed's `gh` calls
act as whoever the session's token belongs to, so writes to GitHub (comments,
verdict, rename, merge, ticking files viewed) are on only in a My Woodshed
session whose owner connected GitHub. In a shared session, or one whose owner
has not connected, the page gets no pull request, so it draws no write control
and no Discussion tab, and the session refuses a GitHub write called directly.
Read-only means GitHub only: anyone who can see a shared session can still start
its analysis, ask and chat, which spend its Claude.

A session with more than one pull request has a review of each. The checkout's, `claude-<id>`, is of the branch checked
out now; each other pull request the session opened has its own, `claude-<id>-pr<n>`, taken from GitHub's head of it
into a detached worktree under `/tmp/woodshed-review-worktrees`, so the checkout and its branches are never touched,
with its own analysis, Q&A, comments, verdict and merge, which go to that pull request. **Pull requests** above the
title links each; asked for the one checked out, the page opens the checkout's. The proxy names the session's pull
requests on its own repo to statusd (`x-woodshed-pulls`, from the session's `prUrls`), and statusd opens no review of a
pull request it did not name (`review: refused, not one of the session's pull requests`); a review of another one logs
`review: pull request review ensured` with the number.

What the page does, from the shed's own review code:
- **The diff** is the checkout against its merge base with the default branch (with the base of its pull request
  instead, when it has one open on another branch, so a stacked one shows only its own change), with
  everything uncommitted and untracked (as `.gitignore` allows), read through a
  scratch index so the session's own is left alone. **Read again** reads it
  afresh.
- **Analyze the change** runs `claude -p` in the session, on its own Claude
  (the owner's plan for My Woodshed, the session's for a shared one), with only
  Read, Grep and Glob and none of the repo's settings or MCP servers. It writes
  an overview, the decisions it makes, how the code is shaped now (with a
  before-and-after drawing when the change rewires how pieces connect), and a
  reading order of the files with a note on each, shown on each file too. It
  is kept under `/tmp/woodshed-review` for the session's life, and says when
  the checkout has moved since.
- **Ask about a line** (its number), **or a file**: claude reads the code to
  answer, in a few paragraphs.
- **Chat** beside it: one message at a time, with the conversation so far, the
  analysis and the files. It can only read; changes are made in the TUI tab.

With GitHub connected in a My Woodshed session, the page also writes to GitHub
as you:
- **Comment** on a line, under its ask box: posted at once, or added to your
  draft review (**Start a review**, then **Add to review**).
- **Submit review**: approve, request changes or comment, with your draft's
  comments if you have any, or **Drop the draft**.
- **Rename PR**: the pull request's title.
- **Merge…**, last: the shed's checks, on a fresh read, then the merge queue
  when the repo has one, or a squash merge pinned to the head it checked.
- **Discussion**: the pull request's description, reviews and comments, and the
  files you have viewed on GitHub.

Once the session has stopped, Review reads GitHub's compare API
(`console/review.mjs`) with the console's App token instead, so it shows what
the session has **pushed**: the files changed against the default branch, each
with its diff, cut at 400 lines. A branch GitHub does not have yet says so.

```bash
WOODSHED_STATE_DIR=/tmp/wsc WOODSHED_IMAGE=woodshed-session \
  WOODSHED_SESSION_ENV_FILE=session-env.json node woodshed/providers/console.mjs
# http://localhost:7690
node woodshed/console/bin/start-session.mjs <issue url> --as <login>
```

## How sessions start

Every 30 seconds it reads the repo's issue events and new comments:

| On GitHub | What happens |
| --- | --- |
| `woodshed` label on an issue | A new session, unless one is already active for it, on `woodshed/<issue>-<id>` or the branch of the issue's last session |
| `woodshed` label on a PR | Nothing: the task would be the PR's own description, and the session would push to its branch. Comment `/woodshed <what to do>` instead |
| `/woodshed <text>` on an issue or PR with an active session | The text is typed into claude, or held until claude is at its prompt between turns (open, and not working), in the session's saved `pendingMessages` |
| `/woodshed <text>` with no active session | A new session with the text as its request. On a PR it checks out the PR |

Only people with write access can start or message a session; others are
ignored and logged. A writer whose *Sessions from GitHub* is off on People
gets a comment saying nothing started and why, and their label is taken off
(`fleet: trigger ignored, no sessions from GitHub`); what is ignored for
everyone, such as a label on a PR, gets no comment. The trigger gets a 👀 reaction, and a new session gets one
comment with its link. A new session on an issue also moves the issue's card to
In progress on every project board whose Status has that option, whoever
started it; boards without one are left alone. This and the issue's assignee
need the GitHub App's Issues write and the org's Projects write (read and
write) permissions. The first poll only records where GitHub is, so a
restart never replays old labels or comments. On a console with several projects, the same on another project's
repo starts or reaches a session on that project, from its webhook or the poll
(`webhooks: message for another project` in the console's log, and `project` on the fleet's lines that follow). The poll
reads every project's repo on that project's own token, with its own cursors (`githubProjects` in `state.json`), so a
repo added while the console runs also starts from where GitHub is then; one repo GitHub refuses is logged (`fleet: a
project's github poll failed`) and the others are still read. The console's comments on a repo (a session started, queued, resumed or failed, or a refusal) link to the console and
the session's app unless that repo's project file, read from its default branch, says `consoleLinks: false`, as a public
repo's should (`commentConsoleUrl` in `fleet.mjs`; `fleet: comment names no console address` in the log). When the file
cannot be read, the default project's comments keep their links and another project's leave them out.

Each repo has its own label and switches, on its settings page (Console settings → Repos → Settings, the **Sessions
from GitHub** card; `console/repoTriggers.mjs`): **Start sessions from the label** and **/woodshed comments** turn each
off for that repo alone, and the label's name is the repo's own, `woodshed` above being the console's
(`WOODSHED_LABEL`) for a repo never given one. GitHub matches a label whatever its case, and so does the console. A
name equal to the repo's QA label (`pullRequests.qa.label`) is refused, since the fleet tells them apart by name. They
are kept in `state.json` under `repoTriggers`, by project, and a removed repo's go with it. Both the poll and the
webhooks read them, so a change applies to the next label or comment. A label or comment a repo turns off is ignored
with nothing posted on the issue: the console logs `fleet: trigger ignored, the repo turns it off`, and the Webhook
events page lists a webhook's as ignored with the reason. Each change logs `repoTriggers: changed` with the `project`,
`key` (`label`, `labels`, `comments`), `from`, `to` and `by`. The console's comments (a refusal, a failed start) name
the repo's own label.

GitHub's webhooks reach the console within a second or two: GitHub posts to a
Lambda Function URL (`providers/aws/webhooks/index.mjs`), which checks the signature and
queues a small message, and the console long-polls the queue. The console
still takes no inbound connection. While messages keep arriving, the GitHub
poll runs only every 5 minutes, to catch a lost delivery; when the queue goes
quiet for a minute it is back to every 30 seconds. A label or comment both
paths see is handled once. A session's own `Needs a human:` comment
("Messages to the assignee") comes only through the webhook: the poll does
not look for it.

Pull requests are read the same way. A change to a pull request (closed,
pushed to, retitled, marked ready or draft, in or out of the merge queue), a
review of it, or a finished workflow run on it is a `pr` message, and the
console reads that pull request again within seconds: its chip, its wait for
the Slack post, and a kept session's retention. The webhook only says when to
look; what is shown is always read from GitHub. While pull request webhooks
arrive (any in the last half hour; CI sends many), the console reads a pull
request on its own only every 5 minutes, for a lost delivery, instead of every
minute. A pull request in its grace period after an approval, or waiting for
its QA check, is still read every minute, since those waits end on the clock.
Only a change to a pull request a session opened is kept on the Webhook events
tab, as **Read again**, with what read it. This needs the App subscribed to
**Pull request review** and **Workflow run** too; without them pull requests
are read at the full speed, as before.

At most 5 shared sessions run at once; the rest queue. A session pauses after
an hour without claude working, or stops at 8 hours in all; a stop commits and
pushes work in progress first (statusd `/checkpoint`). Those numbers, and the
retention ones below, are the defaults: the Console settings page changes them.
My Woodshed sessions take no shared slot: each person may have 3 running or
waiting, which the same page changes. On AWS, above both is the account's
Fargate vCPU quota: a start AWS has no room for goes back in the queue, saying
so (`AWS has no room for another session`), and is tried again a minute later.
On the local provider the machine's own CPU and memory are the ceiling, and
docker refuses no start for room.

The page says what the provider does, in the provider's words: its `words`
(`providers/README.md`, `console/providerWords.mjs`) reach every page in
`pageShell`'s `woodshed-provider` meta tag. A starting session's checklist
begins "Getting a machine from AWS", "Waiting for AWS to start it" and "Pulling
the session image" on AWS, and "Starting a container" and "Booting the
container" on the local provider, which has no wait for a pull of its own.

A start waiting for room shows the provider's `noRoom` title and detail. When
the launcher can say how the wait is going (its optional `progress`,
`providers/README.md`), the page shows its steps under them, as the start's
checklist: each step's seconds, the current one counting, a failed one with
what stopped it, and the wait's clock. The fleet reads it every couple of
seconds while the session waits (`checkWaiting`), keeps it on the session as
`waitProgress` when it changed, and drops it when the session starts.

A console that restarts (each redeploy, a crash, the box rebooting) is away for a few seconds, and sessions wait for
it: their calls to the session API that are safe to repeat (`/settings`, `/home/restore`, `/attachments`,
`/progress`, `/github-token`, and the settings pull at start) try again for about 40 s on anything but a 4xx. `/answer`
is not repeated, since it posts to Slack. On SIGTERM, which Docker sends before a redeploy's restart, the console
(`shutdown.mjs`) stops its loops and takes no new connection, lets the requests in flight answer, and exits within 7 s,
inside Docker's 10: it logs `console: stopping`, then `console: stopped`. Terminals and tunnels are cut and reconnect.

## Session states

The rail and the Shared page group shared sessions by state, and the Shared
page has a tab for each:

| State | Container | Moves on when |
| --- | --- | --- |
| **Working** | running (or queued, starting, stopping) | claude's turn ends, or it asks something. Paused at 8 hours. *Waiting on a job* is here too: claude's turn ended on an open pull request with a background shell still waiting on something that ends (a poll loop or `sleep`, a `gh`, `curl` or `aws … wait` check, a test or build run; a dev server does not count), and it wakes itself when the shell ends |
| **Waiting for input**: *needs you*, *done*, *in review* | running | someone answers, review feedback comes in, the PR is posted to Slack, or an hour passes |
| **Waiting for input**: *paused* | stopped | it is resumed. With no pull request it is deleted 7 days after it stopped |
| **Stopped** (folded) | stopped | it is resumed. Someone pressed Stop on the console; otherwise the same as *paused*. A question from Slack goes to Ended instead |
| **Finished** | stopped | its pull request merges or closes, or it is resumed. Deleted 14 days after it stopped if its pull request stays open |
| **Merged** (or closed) | stopped | 3 days pass, or someone presses **Delete now** |
| **Ended** (folded) | stopped | it leaves the list 14 days after it was deleted, or when someone presses **Remove** in its ⋯ menu: a failed first start, a session deleted, or one that stopped before sessions were kept. A paused question from Slack is here too, with Resume, until it is deleted 7 days after it stopped: a follow-up in its thread picks it up |

*In review* is a session done with its turn whose pull request waits for the
review and the agent suite (see Slack below). The page shows when a waiting
session pauses.

Every stop of a shared session that ran keeps it (`kept` in `state.json`): its
databases (`woodshed__<id>`) stay, and statusd saves its Claude home to the
homes bucket at `_sessions/<id>/claude-home.tar.gz`, a name no GitHub login can
have: every 5 minutes while it runs, when something in it changed, and once
more at the stop. **Resume** (on its card or page, with an optional message), a
`/woodshed` comment on its issue or on the pull request it opened, or the
label added again, runs the **same** session again: the same id, page,
branch and databases, new tokens, and `claude --resume` on its conversation.
The comment's text, or the message, is typed in once claude is open. Without a
saved conversation claude starts on the session's own prompt.

A kept session is cleaned up 3 days after its pull request merged or closed
(the console reads that pull request at most every 15 minutes), 14 days after
it last stopped with its pull request still open, 7 days after it stopped with
no pull request, or at once with **Delete now**: its databases are dropped on
the next sweep and its Claude home deleted, and it moves to Ended. A home that
cannot be deleted then is tried again every 10 minutes. The deletion date
follows the Console settings page's numbers as they are now, so changing one
moves it for sessions already kept, and a resume starts the count again. A comment after that starts a new session on the same branch, as before.

A deleted shared session, and one that ended keeping nothing, stays on the
list as Deleted for 14 days after its delete (the Console settings page's
**Take a deleted session off the list after**), then leaves it. **Remove** in
its ⋯ menu takes it off at once, for everyone. Its branch and pull request stay
on GitHub. One whose Claude home is still being deleted stays until it is
gone, and a question from Slack until its thread was told it went unanswered.
My Woodshed sessions are unchanged: Active and Stopped, and their own Resume.

## My Woodshed

**My Woodshed** (`/`) is for every member, whatever their switches on People, and has nothing to create or turn on. Until your
Claude token or Codex sign-in is saved and your databases are ready, the top of the rail's Mine view has a **setup card** and **+ New session**
opens the same card in the pane in place of the form. The card lists Choose your agent, whose **Claude** and **Codex** take you to
that box on My settings, and, once either is saved, the databases (the console starts the copy then, so it is progress; if it failed or never
started the row has an **Open My settings** button). It goes when both are done. Connect GitHub, which makes your sessions push and review as you, is on My settings and not a
step: sessions work without it. My Woodshed is the shed's launcher, inside the console. The rail
lists your own sessions, Active and Stopped, under **+ New session**. The form starts
with **Project**, the repo the session works on. With one project it only names it; with more, it lists the projects whose repo you
can write to (`console/projectAccess.mjs`; GitHub is asked once every 10 minutes per person
and project, so a person just given write access waits up to 10 minutes for it to show), opening on your default, marked **— your default**. **Make my default** beside
another one saves it (`POST /api/my/projects/default`, kept per person in `viewPrefs`), as does
the **My default project** row on My settings, saved as it is picked; `?project=<name>` picks one for that visit.
The **Agent terminal** row beside it picks what your private sessions run claude or codex in, saved as it is picked
(`POST /api/my/terminal {"terminal": "tmux"|"herdr"}`, kept per person with the Reviews choice, `userSettings: terminal
changed` in the log): **tmux**, the default, or **Herdr**, the session image's pinned herdr-core, whose terminal the
TUI tab attaches to and your own Herdr can too (session/README.md, "What a container does"). It reaches your next
private session in the session API's `/settings` answer (`terminal`); shared sessions, reviews, QA runs and questions
are in tmux whatever it says. `woodshed session new --herdr --parent` sends `herdrParent: true` with the start (and
`session herdr <id> --parent` with the resume), for that run alone: the session runs in Herdr and waits for its agent's
terminal from the person's own (`WOODSHED_HERDR_PARENT`; session/README.md). Resume asks again, so a session on a project whose repo you can no longer write
to does not start (403). The form
asks for a prompt and, optionally, the rest below. It asks for no name: the session starts named after the prompt's
first line, and the console asks Claude Haiku for a better one on the team's Anthropic key (`console/autoName.mjs`).
The rail shows it a second or so later; if the call fails, the first line stays. Either way the console then sets the
session's `namedAt`, and a page that saw the session before it (or opens it within 30 s) shows a small **Named …
Rename** offer under its title for 10 s: a click on it keeps it open, and **Rename** turns it into a field that saves
with Enter, as the title's own rename does. `POST /api/my/sessions` still takes a `name`, which skips all of this.
- **Continue a PR or branch**: `#123` for an issue or PR, `PR #123`, or a branch name. Left empty, the session starts a
  new branch from the default branch. The field lists the project's open pull
  requests (`GET /api/pulls`, the 100 updated last, read by the console in one GraphQL call and kept a minute per
  project): typing narrows them by number, title, branch or author, ▾ or ↓ shows them all, and a pick writes `PR #123`
  and names it under the field. The console logs `console: open pull requests read` with the count, or `console: open
  pull requests not readable` with gh's error, after which the list from before is shown and says so;
- claude's model, effort and permission mode;
- files: the paperclip, a paste or a drop, up to 8 of 25 MB each and 40 MB
  together. Each goes to the console as it is picked (`POST /api/my/uploads`,
  `console/attachments.mjs`, kept on the console's disk for a day). Start moves
  them under the session, and the entrypoint fetches them from the session
  API (`POST /attachments`) into `/tmp/uploads` at each start, Resume too,
  listing their paths under the prompt as the shed does. They go with the
  session's Remove.

**Dictate**, beside Attach files, speaks the prompt with the browser's speech recognition (`public/dictation.js`,
shared with the phone's message box): settled words go after what is typed, the line under the prompt shows the ones
still settling, and **Stop**, or Start, keeps them. It is hidden where the browser has none (Firefox). Chrome and Edge
send the audio to Google and Microsoft, Safari to Apple; the console sees only the text.

`/` in the prompt lists the repo's skills (`.claude/skills/*/SKILL.md`) and
commands (`.claude/commands/<folder>/<name>.md`, as `<folder>:<name>`) on its
default branch, read by the console in one GraphQL call and kept for an hour.

With no issue or PR the branch is `woodshed/<login>-<id>`, cut from the default branch.

A session started there is **private** to whoever started it. The console
records it with an `owner`, fixed for its whole life, and every route that
reaches a session answers anyone else exactly as for an id that does not
exist:
- the list and the page;
- the terminal and its websocket;
- Redis;
- the app and its sign-in;
- Review, Start and Stop app, and Stop.

GitHub triggers never reach a private session. A `/woodshed` comment on an issue
that has one starts a shared session instead, on its own branch. My Woodshed
takes none of the shared slots, and has a limit per person of its own: how
many of your sessions have a Fargate task (starting, running or stopping) at
once. At the limit, New session's button says **Start when one frees up**,
and Resume does the same: the session waits in your own line, marked
**Waiting** on the rail with its place, and the oldest in line starts as soon
as one of your tasks stops or is paused. A session in line has no task and
costs nothing, so the line has no limit; each one still runs on your Claude
plan once it starts. **Take it out of the line** stops it, and Resume puts it
back, at the end of the line.

Under Stopped, the rail has a third group, as the shed does:
- **Pull requests** lists your open pull requests on every repo you may start
  sessions on, then those waiting on your review. With more than one project,
  each row has its project's edge and name, and the rail's project filter
  applies to them too.
- **Start** on one opens New session on its repo, with it under Work on;
  **Open** or **Resume** is your session on its branch in that repo.
- The console asks GitHub's search for them at most once a minute per person,
  each repo on its own project's token. A repo that does not answer keeps its
  last rows (`console: pull requests not readable` with the `project`).

The rest of the shed's rail and shell is here too, on every session's page
(Shared's as well):
- **Pin** (the star) puts a session at the top of its group. It is yours
  alone: the console keeps it per person (`viewPrefs` in `state.json`), so it
  follows you to any browser.
- **Rename** (a click on the name in the pane bar, or the palette) changes the name
  every page shows, for everyone who can see the session.

The terminals are the shed's too (`console/public/terminal.js`, on both the
TUI and Terminal tabs):
- **Copy out**: a drag in claude copies, as tmux sends it by OSC 52, with a
  "Copied" toast. Safari refuses a copy that comes from the socket, and says so.
- **Links**: on a phone a tap opens a URL, a wrapped one rejoined first.
- **Pictures**: a png, jpg, gif or webp path claude printed shows a thumbnail
  on hover and opens a viewer on click, with ← and → through every picture on
  screen. The console fetches it from the session's statusd (`GET /image`),
  which serves only the repo, `/tmp/uploads` and Claude's scratchpad.
- **Files**: paste or drop up to 8 files (25 MB each, 40 MB together) on a
  terminal. Each goes through the console to `/tmp/uploads` in the session,
  and its path is typed at that terminal's prompt with no Enter. claude starts
  with `--add-dir /tmp/uploads`, so it reads them without asking.
- **Scrolling back** (the wheel, or a swipe on a phone) is the browser's own when
  the pane is on the main screen: claude and codex run inline, never full screen
  (`session/bin/claude`, `session/bin/codex`), and tmux leaves what scrolls off
  in the browser terminal's own scrollback (`session/tmux.conf`), so the view
  moves with no round trip. That scrollback holds what came since the terminal
  attached: past its top, tmux's copy mode takes over where it ran out, through
  statusd's `POST /scroll`, and scrolling back down to the bottom leaves it. A
  pane on the alternate screen (a full-screen program), in copy mode or split
  scrolls through tmux as before. tmux says which in the terminal's title, and
  `public/terminalScroll.cjs` reads it.
- **Find**: ⌘F on a Mac, Ctrl+Shift+F elsewhere (Ctrl+F is the pane's, a character forward), from the terminal or the
  page around it, or **find** on a phone's key bar, opens a bar over the terminal's top right. xterm paints on a
  canvas, so the browser's own find sees nothing there: the bar reads xterm's buffer (`public/terminalFind.cjs`), which
  is the screen and the browser's scrollback, case ignored and a wrapped line read as one. Every match is marked, the
  one shown in bright amber and scrolled to; Enter goes to an older one, Shift+Enter a newer one, Esc closes it. The
  marks are xterm decorations, not its selection, since the terminal page copies every selection to the clipboard, as
  ttyd's did. What scrolled
  off before this browser attached is in tmux's history alone: scroll past the top into copy mode, then `?` searches it.
- **The conversation so far**, the Chat tab's thread, for an app to show and scroll by itself, apart from the terminal:
  `GET /api/sessions/<id>/transcript?limit=<n>&since=<writtenAt>` answers what was asked, what the agent said, and a
  line for each tool it ran (marked when it failed, and with what an edit changed, as `diffs`), newest last, from the agent's own record (statusd's `GET
  /transcript`), or `{unchanged: true}` while nothing was written since the last answer. Anyone who can open the
  session may read it, while it runs.

And what the shed shows about each session:
- **The pull request's chip**, on the card and the pane bar: open, draft,
  merged or closed, `queued` in yellow while it waits in GitHub's merge queue
  (its place on hover), and otherwise one mark for what most needs a look (✗ a failing check
  or changes requested, a spinning ring while checks run, ✓ green or approved), with the
  counts on hover. While a review or QA session the console started is at work on the pull
  request (waiting in line or running: `woodshedRunsOn` in `console/sessions.mjs`), the chip
  says `review`, `QA` or `review, QA` with the ring in place of the ✓, since its checks say
  nothing of them until they report; a failing check keeps its ✗ beside the word. The hover
  card and the chip's tooltip say `Woodshed review running`. A session that opens another pull request keeps each one
  it reported (`prUrls`, oldest first, by number): the one of the branch checked out and
  those of its checkout's other branches, a git worktree's included, and those claude opened with `gh pr create` from
  another clone (statusd's `prUrls`, session/README.md). One on another repo is kept only for a private session, and only
  on a project its owner may start sessions on (`projectAccess`, as New session offers them), since the console reads
  it with that project's token (`reportableRepos` in `console/fleet.mjs`): a shared session, review, QA run or question
  keeps its own repo's alone; its chip names its repo (`woodshed-cloud #151`), and it goes where it was
  first seen, since two repos' numbers say nothing of which came first. It shows a chip for each, but a merged
  or closed one only while no newer one came after it, so the newest always
  stays. The card and pane bar show the newest two of those, a phone's bar
  the newest one, and the older fold into a `+N` chip that names each on hover;
  Details lists every one (the 20 newest are kept) with its state. The console reads every session's pull request in one
  GraphQL call a minute with its App token (`console/prChips.mjs`), a merged
  or closed one every 15 minutes.
- **CPU and memory**: the container's, from statusd's `/status`, in the pane bar's meter (`CPU 41%` while all is
  well, the whole line once one runs high), and after the status word on a phone. Amber past 70% of its memory or
  75% of its cores, red past 90% or 95%, the one over the line first.
- **Plan**: in a private session's pane bar meter, how much of your session agent's (Claude or Codex) plan is used,
  its fullest window's share (`Plan 68%`), amber from 70%, red from 90% and `Plan out` at 100%. Click the meter for each
  window's share and when it resets, a tick for how much of it has gone by, how old the reading
  is, and the machine's CPU, memory and disk against their limits (on a phone, the plan under ⋯). Claude Code hands the limits only to its status
  line, after each answer: `session/statusline.sh` saves them to
  `~/.claude/woodshed-usage/claude.json` and statusd's `/status` returns them
  (`session/planUsage.mjs`; Codex uses local rollout limits from `session/codexPlanUsage.mjs`). Readings and running counts are shared only between private sessions using the same agent. Every private session on the same agent
  shows the newest reading any of them has, a stopped one's last
  included, and a window whose reset has passed reads 0%. Claude Code reports
  the all-models week only, not claude.ai's per-model one, and leaves a window
  out at times; `/api/oauth/usage` refuses the setup token a session runs on.
- **App log**: Terminal's second view, with the end of the frontend's, the backend's and Start
  app's logs, read every 3 seconds while it is open. The shed's is a
  terminal on the app's tmux; here the dev servers run without one, and a
  third ttyd would need its own port in the security group.
- **A pull request on the rail** opens your session already on its branch
  (**Open**), resumes a stopped one there (**Resume**), or starts a new one.
- **⌘K** (or **/**) opens the command palette: jump to a session (stopped ones
  once you type), go to a page, or Tab on a session for its actions. **?** (or
  **⌘?**) lists the keys; **⌘.** hides the rail, as does the
  button beside the user menu at its foot, and a strip down the left edge
  shows it again; **⇧⌘,** goes to My settings'
  Display card: the theme (device, light or dark) and review files, kept in
  the browser, and whether a session opens on Chat or TUI, one choice for a
  desktop and one for a phone, kept for you on every device; **⇧⌘O** (or **N**) is
  New session; **G** then **M**, **E** or **S** goes to My Woodshed, shared
  sessions or My settings. Ctrl works for ⌘ outside a terminal, and the pages
  write the keys as Ctrl on Windows and Linux. A key alone works only while
  nothing takes typing, and never inside a terminal or the Review, whose
  frame gets the ⌘ keys alone. Which key does what is
  `public/keys.cjs`, read by the sheet, the hints and the handler alike. A
  control with a key (New session, the settings list's Keyboard shortcuts)
  shows a hint with it when the pointer rests on it.
- **Install as an app**: the console serves the shed's manifest and icons
  (`woodshed/shared/pwa.mjs`) under its own name, before sign-in, since a
  browser fetches the manifest without cookies. There is no service worker,
  for the shed's reason: it would sit in front of the terminals.

**GitHub**, on My settings: **Connect GitHub** signs you in once more, and this
time the console keeps GitHub's answer. That's a GitHub App user token, and
with the App's expiring user tokens (its default), a refresh token too. It goes
in Secrets Manager at `<prefix>/users/<login>/github` (on AWS, `<prefix>` is Terraform's `name_prefix`, here and below) and never reaches a
session. A connected owner's private session then:
- gets their own token from the session API's `/github-token`, which an
  installation token answers for everyone else, so it pushes and opens pull
  requests as them, on any project. The owner's token reaches every repo the App
  is on that they can write to, and the project file's `githubAccess` decides
  how much of that the session gets (`sessionApi: github access for a private
  session` logs it): `full`, the default, hands it over as it is; `repo` has it
  scoped down by GitHub to that project's repo and the permissions sessions get
  (`POST /applications/{client_id}/token/scoped`, with the App's client secret;
  `githubUser.mjs`, `scopedTokenFor`), made once
  per person and repo and kept until it nears its expiry; Disconnect revokes each
  of those at GitHub too, along with the full token. When GitHub makes none
  (no client secret, or it refuses), a `repo` session gets the project's App token,
  which reaches its repo alone: its commits are still authored as the owner (the
  git identity below), but pushed and opened as the App;
- commits with their name and `<id>+<login>@users.noreply.github.com`, which
  My settings can change.

Each refresh spends the refresh token and saves the new one before the token is
used, one refresh per person at a time. A refresh GitHub refuses (the
authorization was revoked, or six months passed unused) disconnects them. Their
next push then fails with that reason rather than quietly pushing as the App.
**Disconnect** and Remove My Woodshed delete the stored token and revoke it at
GitHub. A session keeps a token for 5 minutes at most, so a running one is back
to pushing as the App within 5 minutes.

**MCP logins and Claude memory** carry over between your private sessions.
- **While it runs, and on stop:** every 5 minutes, when something in it
  changed since the last save, statusd sends the session's `~/.claude` and
  `~/.claude.json` to the session API (`POST /home`), as a gzipped tar without
  caches, and its checkpoint does once more at the stop. A session that ends
  without a stop, such as a crash, so loses 5 minutes at most. The console
  streams it into the private S3 bucket `<prefix>-homes-<account>`, up
  to 200 MB, as the session's own (`<login>/sessions/<id>/claude-home.tar.gz`).
  At the stop it also copies it inside S3 to yours
  (`<login>/claude-home.tar.gz`), which is the last of your sessions to stop.
  The saves in between are for that session's Resume after a crash: copying
  them too would swap yours between your running sessions every few minutes.
- **On start:** a new private session restores yours (`POST /home/restore`)
  before claude starts; a resumed one restores its own, or yours when it has
  none (a session stopped before sessions kept their own homes).

So you log in to an MCP once, and memory, settings and transcripts follow you,
and two sessions that stop one after the other each keep their own
conversation.

**Your Claude settings are the same in every running session**
(`session/settingsSync.mjs`): `settings.json`, `CLAUDE.md`, `keybindings.json`,
`agents/`, `commands/` and `skills/` under `~/.claude`, your MCP logins (the
`mcpOAuth` entries of `~/.claude/.credentials.json`) and your user-scope MCP
servers (the `mcpServers` entries of `~/.claude.json`); codex's `config.toml`,
`AGENTS.md`, `prompts/` and `skills/` under `~/.codex` (never `auth.json`, nor
codex's own `skills/.system`); and the plugins you installed for your whole
home. Every 20 seconds
statusd sends the session API (`POST /claude-settings`) what changed in that
session and gets back what your other sessions changed, which the console
merges item by item and keeps as `<login>/claude-settings.json` in the same
bucket. A new or resumed session applies the latest before claude starts, over
whatever its home held. Transcripts and the rest of claude's state stay each
session's own. Your computer joins the same copy with `woodshed settings`
(cli/README.md, "Settings").
- **Codex:** each session keeps the folders it trusts (`[projects."…"]` in
  `config.toml`) and any entry holding a credential (an MCP server's key) out of
  what it sends, and its own in what it writes (`shared/codexConfig.mjs`), so its
  checkout stays trusted and a key stays where it was typed. The console refuses
  a `config.toml` holding a credential, and a plugin's marketplace beyond what a
  session can add: it logs `sessionApi: shared Claude settings refused` (or
  `cliSettings: refused`) with the reason. The session's rules win over
  your `AGENTS.md`: codex reads `AGENTS.override.md` in its place, which the
  start writes as the rules followed by your `AGENTS.md`, left as it is.
  Synced changes to `AGENTS.md` reach Codex's instructions the next time the Woodshed session starts.
- **Plugins** go as their name and marketplace (`installed_plugins.json#plugins/<name@marketplace>`),
  never their files: a new session installs each its home lacks before claude
  starts (`session/syncedPlugins.mjs`), adding the marketplace first, logged as
  `Plugins from your other sessions installed`. Each is offered once, in the
  default plugins' list, so one you uninstalled or turned off in a session is
  not put back. A plugin installed for one repo alone, or from a marketplace
  that is a folder, a pinned ref or a URL with a sign-in, stays where it is.
- **When claude sees a change:** the files change on disk within 20 seconds.
  Claude Code reloads `settings.json`, keybindings, skills and agents while it
  runs; `CLAUDE.md` and the MCP servers it reads as it starts, so a running
  session gets those at its next start. Servers are never written into a
  running session's `~/.claude.json`, which claude rewrites all the time. A
  new MCP login reaches a running session's file, but claude can write the
  file again from what it holds without it: there it is best effort, and
  certain at the next start. A stop runs one last round first, so a change
  made just before it is not lost.
- **What does not spread:** an MCP login or server removed in one session
  (`/mcp` Clear authentication, `claude mcp remove`) stays removed only there,
  because a session that never saw a newer login rewrites the file without it,
  and that must not delete it everywhere. Your Claude plan login stays each
  session's own, and a file over 1 MB is not sent: your other sessions keep the
  last version that was. Forget it and Remove My Woodshed delete
  the shared copy with your homes.
- **From your computer:** `woodshed settings push` sends your laptop's items into the same copy, and `pull` writes
  the copy's into your laptop (cli/README.md, "Settings"), through `GET/POST /api/cli/settings` with the command
  line's token (`cliSettings.mjs`). A computer never sends or gets an MCP login, and never removes an item. Claude MCP server
  definitions pushed from a computer are kept in the same stored settings object in a map only the CLI can read. They
  take precedence on computers if a session has saved the same server name. The session API returns only the session's
  copy. Codex MCP server definitions from a computer stay on that computer. A model or other Codex setting pushed from
  a computer keeps the session copy's existing MCP definitions. Admin-configured MCPs reach sessions through the
  relay. The console logs `cliSettings: pushed` with the token's
  id and the counts, `cliSettings: refused` when the copy exceeds 5 MB or an MCP definition or hook has a literal header, and
  `cliSettings: refused, a removal from a computer` or
  `MCP logins from a computer` for a client other than the command line's. `--own-files` saves into your own files on My settings
  through the Repo settings routes, with their checks and log lines.

**Resume**, on a stopped private session's rail card or page, starts the same
session again, with its page, branch and options, and runs
`claude --resume <id>`. The id is the conversation statusd last saw, from the
newest transcript's name. When the restored home doesn't hold that
conversation, the session starts its original prompt again: a session that
never reached claude, or one stopped before sessions kept their own homes.
**Remove**, on a stopped private session's page, takes it off the list and
deletes the home it kept; its branch stays on GitHub. **Forget it** on My
settings and Remove My Woodshed delete your kept home and every one of your
sessions' own (everything under `<login>/sessions/`), so no Resume brings back
what was forgotten. Forget it is refused while one of your sessions runs, since
that session would save its home again within 5 minutes; Remove My Woodshed
stops them first.

**Repo settings**, on My settings, hold your own values for each repo's env files, your own instructions and your own
files ("Your files" below), for your private sessions on that repo ("Repo settings" below says how they are kept and
handed out):
- The repos you can write to are rows (New session's check), each read once it is opened; inside, a switch shows its
  Instructions, Env files or Your files. `?repo=<project>` opens one and `&file=<key>` one of its env files. A repo you cannot write to is not listed, and its routes answer 403.
- Each env file shows its layers as a session writes them: the repo's `defaults`, this installation's values (read only,
  behind **Show**, since reading them is logged), **Your values**, and what the session sets itself, then a table of
  which wins each key, with a **Yours** column. Then the repo's rules, the installation's instructions and yours.
- Saving keeps yours at `<prefix>/users/<login>/repos/<project>/env/<key>` (and `…/instructions`). **Clear mine**, or
  saving nothing, deletes them. A shared session never gets them.
- The entrypoint still writes the session's own lines last (the databases, Redis, ports and URLs, listed on the page),
  so those always win. A running session keeps the files it started with.

**tmux and dotfiles.** **tmux**, on My settings, adds your own lines to `~/.tmux.conf`, after the session image's
`tmux.conf`, so a setting in both uses yours. Saving keeps them at `<prefix>/users/<login>/tmux-conf`; **Clear mine**, or
saving nothing, deletes them. `/api/my/files/tmux-conf` is its route; your own lines for the env files are Repo settings,
above. **git**, **readline** and **Shell aliases** do the same for `~/.gitconfig`, `~/.inputrc` and `~/.bash_aliases`
(`gitconfig`, `inputrc`, `bash-aliases`), written after what the session sets in your private sessions only, and hold
less than those files can (`shared/dotfiles.mjs`): git's aliases, colors and how diff, merge, pull, push and rebase
behave, never `[user]`, `[credential]`, `[url]` or `[include]`, since a session commits as you and signs in to GitHub
by itself; readline's lines; and `alias` lines alone, never an export or a command. Anything holding a credential is
refused, saying which line and why (`userSettings: file refused` in the log, with the key). `woodshed settings push`
fills them from your computer's files (cli/README.md, "Settings").

**Your files**, in each repo's tab on Repo settings, are whole files of your own for that repo, by their path in it (an
`app/.env.production` that your MCP servers read, a tool's local config), which every private session of yours on that
repo writes into its checkout at start. Another repo's sessions never get them, so one path can hold a different text
for each repo:
- A repo's are one secret, `<prefix>/users/<login>/repos/<project>/files` (JSON, path to text; 20 files at most, and the
  secret store's `maxValueBytes` for the JSON: 64 KB in AWS, 1 MB in the local provider, 64 KB for a store that declares
  none; the panel shows it). `state.json` keeps only each path and when it was saved
  (`people.<login>.repos.<project>.files`). `GET`/`POST /api/my/repos/<project>/files` read and save them, refused (403)
  for a repo you cannot write to, as the rest of Repo settings is.
- A path is checked as it is saved and again in the session (`shared/ownFiles.mjs`): inside the repo, no `..`, not
  under `.git`, and not one of that repo's env files (from its project file on the default branch: a save waits until it
  can be read), which take your values instead.
- The session writes a file only where git ignores it and does not track it, mode 600, so it cannot reach a commit
  (`session/ownFiles.mjs`). Its log says `Own files written`, or a `WARNING` with each file skipped and why.
- The console logs `repoSettings: own file saved` or `removed` with the project and path, and `sessionApi: settings
  handed out` names them under `wholeFiles`. Taking the repo off the console, or Remove My Woodshed, deletes them.
- A running session keeps the files it started with; an edit made in a session is not saved back.
- Before they were per repo, all of a person's files were one secret for every repo, `<prefix>/users/<login>/own-files`
  (`people.<login>.ownFiles`). At each start the console moves those into the default project's, beside any the person
  already keeps there, which win for a path in both (`repoSettings: own files moved to the default project`, with the
  paths `added` and `kept`, and `leftOut` when the two together would be over the limit, which keeps theirs alone), then
  deletes the old secret; one that fails (`own files not moved`) is tried again at the next start and reaches no
  session meanwhile. `/api/my/own-files` still answers a page opened before, on the default project's.

**Session timeouts**, on My settings, override the console's *Pause a session
waiting for input after* (0.25 to 24 hours) and *Stop a working session after*
(1 to 24 hours) for your own My Woodshed sessions, in the same ranges as Console
settings. An empty box is the console's number; shared sessions always use the
console's. The numbers are kept in `state.json` under the person (`people.<login>.limits`),
apply to running sessions on the next tick, and log `userSettings: own session limits
changed`.

**Remove My Woodshed**, at the bottom of My settings, asks you to type your
login. It then:
- deletes your saved settings, files, GitHub connection and Claude home;
- stops each of your private sessions (pushing its work first, as any stop does);
- takes them all off the list.

Branches and pull requests stay on GitHub, and shared sessions you started stay
on Shared.

**My settings** (`/settings`, in the avatar menu) is groups of rows (Sign-ins, Sessions, Kept for you, Repos and
files, Display): each row says a setting's name, what it is now and its status word, and opens in place on its form.
Several may be open at once, and a link or the settings search that names one opens it. It holds your Claude token: make
it with `claude setup-token` on your laptop. The console keeps it in Secrets
Manager at `<prefix>/users/<login>/claude-token`, makes that secret itself,
and never shows it again. `state.json` notes only when it was saved.
The setup card, and New session, wait until a Claude token or a Codex sign-in is saved: either
is enough, and a Claude session still needs the Claude token. Your private sessions get it
at start, for claude alone: the entrypoint keeps it in
`~/.config/woodshed/claude-token`, outside the Claude home it saves, and
`session/bin/claude` hands it to claude as `CLAUDE_CODE_OAUTH_TOKEN`. claude
then calls Anthropic directly, which the Artifact tool needs: it calls
`api.anthropic.com` itself whatever `ANTHROPIC_BASE_URL` says, so behind the
proxy it is refused with `Invalid bearer token`. Only you can open a private
session, and the token spends only your plan, but it is in the session: a
command run there can read the file, so treat a token you suspect leaked as
you would any other, and save a new one. Saving a new token or removing it
reaches running sessions only at their next start.

New session opens on **Codex** for someone with a Codex sign-in saved and no Claude token, and on Claude otherwise,
until they pick an agent. Its **Agent** menu lists only the agents set up to run (`agents` in `GET /api/my`): Claude with a
Claude token saved, Codex with a Codex sign-in saved or the team's `openai-api-key`. With one, the menu is greyed out
on it, and a Codex start with neither is refused (409). Its Codex **Model** and **Effort** menus are OpenAI's catalog, the one codex itself reads
(`codexModels.mjs`): `GET https://chatgpt.com/backend-api/codex/models?client_version=<codex's version>`, asked with
your own Codex sign-in, or the team's OpenAI key with none, kept 10 minutes. A model OpenAI ships shows the day it
ships, and a start is refused with a model or effort the list does not offer. The console never refreshes a ChatGPT
sign-in, since that rotates the refresh token your sessions hold: with its access token expired, or OpenAI not
answering, the menus are your last list read, or else codex's built-in list (`BUILT_IN`, from `codex debug models
--bundled` of the image's codex), and a line under them says so. `CODEX_CLIENT_VERSION` follows the image's
`CODEX_VERSION`, which `codexModels.test.mjs` checks; refresh `BUILT_IN` with it.

Under the token, the switch **Also use it for shared sessions I start from
GitHub** (on by default, and only with a token saved) runs the shared
sessions you start, with the label or a `/woodshed` comment, on your plan too.
The console decides at each start and resume, from whoever started the session,
so a resume by someone else or one for review feedback stays on the starter's
plan, and a switch turned off applies from the next launch. It records the
login as the session's `plan`, which the Shared page, the rail, the session's
**Details ▾** and the start comment show (`◆ Mona Octocat's Claude`, the start comment
with `@login`, or `Team key`). The
session API's `/settings` answer tells that session its `plan`, and the
entrypoint has claude go through the proxy on it. It asks whether or not the
console makes the session databases (a console with no db-admin, or a project
with no Postgres or Mongo, answers `{plan}` alone, and a 404 on the team key). The token never reaches a
shared session: anyone signed in who opens it can type into it, and spends
that person's plan while it runs, but cannot take the token away. So the
Artifact tool does not work there, nor on the team key.

**The Anthropic proxy** (`console/anthropicProxy.mjs`, at `/anthropic/` on the
session API's port) is how claude in every shared session reaches Anthropic,
so no shared session holds the team key or anyone's Claude token. A private
session from an image before its own token still uses it. `session/bin/claude`,
ahead of the real claude on the session's `PATH`, points `ANTHROPIC_BASE_URL`
at it and hands claude the session's own `SESSION_TOKEN` as its credential,
for claude alone: the entrypoint exports none of it, and `CLAUDE_ENV_FILE`
takes it away again from every command claude runs. The repo's app is left
to its own env files, however it was started, and calls Anthropic itself on
whatever key they hold: the env file secret's, or the owner's own line. A call with the
session token in
`x-api-key` goes on the team key, which the console reads from
`<prefix>/anthropic-api-key` and keeps 5 minutes; a call with it as a
bearer, which is what claude sends when it has it as
`CLAUDE_CODE_OAUTH_TOKEN`, goes on the session's plan: a shared one's `plan`,
or an older private session's owner's. Copied out of a terminal, the session token
is worth nothing: only session tasks reach that port, and only while the
session is active. claude keeps its plan behaviour behind the proxy, except
that it fetches no managed settings or organization policy with a custom base
URL (`/status` says so). The docker launcher's sessions, which get the team key
in their env file, use it directly.

### Sessions that start sessions

Claude in a My Woodshed session can hand a piece of work to a new session of the same person's: asked to "open a
session for X", it writes the new session's first prompt as a full brief and runs `woodshed-session new --prompt-file
<file>` (`session/startSessions.mjs`; the session's rules say how, `session/prompt.md`). The new session is an ordinary
private session of that person's, with a branch of its own, and `woodshed-session list` and `get <id>` say how each it
started is doing: its state, branch, pull request, last line and link. The two are not tied together otherwise:
stopping one does nothing to the other.

- **The credential is its own** (`console/sessionStarts.mjs`). At each launch of a private session the console makes a
  start token, `wst_` and 64 hex, keeps only its sha256 on the session (`startTokenHash`, which `publicSession` never
  sends to a page) and hands the token in `WOODSHED_START_TOKEN`. The entrypoint writes it to
  `/tmp/woodshed-start-token` (mode 0600) and unsets it before anything starts (`keepStartToken`), so neither statusd nor
  the app it starts has it in their environment; `woodshed-session` reads the file. It works only on the session API's
  `/sessions` routes, never on `/api/cli` or a page, which no browser reaches, and refuses any call with an Origin. It
  does nothing once the session stops (the hash goes with its run), and a resume makes another. A session's app, which
  runs as the same user in the same container, can read the file if it goes looking: what the token can do is bounded
  instead, below. `ownsSessionToken` knows it too, so a host routes the call to its installation as it does the session
  token's.
- **Who gets one**: a running private session, never a shared one, a question from Slack, a review or QA run, or a
  session that has seen production data (its prompt could carry that data to an untainted session; a taint after the
  launch makes the token do nothing).
- **The start** is New session's own (`startMine` in `server.mjs`), as the session's owner: their Claude token (or Codex
  sign-in), their databases, write access to the project's repo (the session's own unless `--repo` names another
  project), and the project's readiness; the owner must still be on the console and still have write access to its repo on GitHub, checked as for a command
  line token (once an hour per person, `createWriteAccess`): New session's project check asks nothing of the default
  project, whose writers the page's sign-in rechecks. It counts
  in their My Woodshed sessions and waits in line past the limit, and a hosted console bills it as any session. Its
  permission mode is the starting session's (`acceptEdits` becomes `default` for Codex), never one it picks. A branch
  that is the starting session's own is refused. It gets nothing of the starting session's but `startedFrom`, its id.
- **Limits**: none of its own. The person's **My Woodshed sessions per person** applies as it does to New session: past
  it, a started session waits in line.
- **How it shows**: the started session's hover card and Details say **Started from** with the other's name (a link in
  Details), and the other's say **Started here** with each it started. On Mine's rail it sits under the session that
  started it while that one is live (`W.railGroups`), folded or open with the toggle on the main card (`3 sessions · 1
  needs you`), and one that asks its person shows on Needs you too (design system, RailCard).
- **A piece of the work, or work of its own**: by default a started session is a piece of the starting session's work:
  it is grouped under it and in its `list`. `woodshed-session new --separate` starts work of its own
  (`startedApart`): at the top of the rail, in no group and in no `list` but `--all`, still saying where it came from.
  The session's rules (`session/prompt.md`) tell Claude to choose by what it is asked: related work is a piece, unrelated
  work or work the person says they will drive is separate, and it says which it chose.

The console logs `sessionStarts: session started` with `from`, the new `id` and its `status` (`queued` when it waits in line), `sessionStarts: start
refused` with `why` (`no prompt`, `same branch`, `not a member`, `write access gone`, or `start checks` with
New session's `status`), `refused, no running session has that start token` and `refused, a browser's call`. The
session's log says `Session starts on` when it got a token.

**Messages between them.** A session reaches every other private session of the same person's (never anyone else's, a
shared one, a question from Slack, a review or a QA run), on the same token and the same session API: nothing goes from
one session's machine to another's. `list --all` lists them; `list` alone the ones this session started.

- `woodshed-session send <id> "<message>"` (`reply "<message>"` for the session's starter) types it in at the other's
  prompt as the Chat tab's message is (`fleet.send`), headed `[Message from session <id> "<title>", …]` with how to
  answer, so the agent and its person tell it from what the person typed. It is held while that session works, waits
  in line or is paused, and typed once it is at its prompt again, as a held Chat message is.
- `wait <id>` answers once it is done, needs its person, or stopped; `--reply` (and `send --wait`) once it has worked on
  what was sent, or says nothing took it up (never seen working, with nothing held, for 90 s). The console answers each
  wait within 4 minutes and the command asks again.
- `read <id>` is what it was asked and said, from its statusd's `/transcript`, tools left out. A session that has seen
  production data is never read by another (403), and what any route says of it (`get`, `list`, `wait`) carries
  nothing its agent wrote: no last message, and `tainted: true`.
- `stop <id>` and `resume <id>` are the page's Stop and Resume, with Resume's checks (`resumeMine` in `server.mjs`).
- `rename "<name>"` renames the session itself, `rename <id> "<name>"` another of the person's, as the page's rename.

The console logs `sessionStarts: message` with `from`, `to`, the `chars` and `outcome` (`sent`, `queued`, `in-box`,
`unknown`), `sessionStarts: session stopped`, `sessionStarts: resume` with the `status`, `sessionStarts: session renamed`, and `sessionStarts: transcript
not read` when the other's statusd did not answer.

### MCP servers

Admins give sessions' claude MCP servers on Console settings' **MCP servers** card, or through its API
(`/api/console-settings/mcp-servers`, `server.mjs`'s list), which a hosting program calls as an owner behind its proxy's
identity header. Every one is reached through the console's relay (`mcpRelay.mjs`), `/mcp/<name>` on the session API
with the session's own token as its bearer, so a session never holds what a server takes to let it in. The list is
`mcpServers` in `state.json`, or an embedding program's (`mcpServers` below, "Embedding the console"), beside the one
the environment names (`woodshed-prod`, from `WOODSHED_PROD_MCP_URL`), which is changed only where it is set. Each
server (`mcpServers.mjs`, `checkServer`):

- `name` (what claude calls it), `url` (its Streamable HTTP endpoint, which the console calls), `people` and `repos`
  (GitHub logins and `owner/name`, or `*`).
- `production`: one that reads production data. Only My Woodshed sessions running claude get it, turned off until
  their person turns it on in `/mcp`, and its first call taints the session (below). It can be added only where the
  console can lock a session down: the docker launcher, or AWS with `prod_mcp`'s guarded network, and a session API and
  egress proxy address. Otherwise the page and the API say why.
- `shared` (ordinary ones only): shared sessions and questions from Slack get it too. A QA run or a review never gets
  any, since it runs a pull request's code, nor does a Codex session yet.
- `auth`, what the relay adds to each call: `oidc`, a five-minute token the console signs for `audience` (below);
  `header`, a header (`header`, such as `authorization` or `x-api-key`) whose value is kept in the secret store as
  `mcp-servers/<name>/header`, written once on the card or with `/header` and never read back; or `none`.

**Testing a server** (`mcpTest.mjs`, `POST /api/console-settings/mcp-servers/test`): the card's Add server and Save test
first, and each row has Test. The console itself calls the server as the relay would, with the same auth, and sends
`initialize`, `notifications/initialized` (which must be accepted) and `tools/list`. A signed token (`sub`
`console:test`, `test: true`) is made only for a saved server, to its saved address and audience: a server not saved
yet, or one typed with another address or audience, is tested with no token, so no admin can catch a token at an
address of their own and replay it to a server that trusts this console (a production server should refuse any `sub`
but `private:<login>` anyway). A saved header value goes only to its saved address's origin; a typed one wherever the
form says, and a saved value is read only while the server's address and the value's revision are still those the
caller started with, so a test or relayed call in flight across an edit sends it nowhere. The server's own words (its
name and version, a JSON-RPC error's message) come back only from a test that added nothing: one that added a header or
a token answers with the tool count and an error's code alone, since a server could echo what it was sent. The console
connects to the address its link-local check passed, never resolving the name again. No two
servers share an audience: a token the relay makes for one is never one another takes. It answers whether it was reached, the server's name and version and how
many tools it has, or one sentence saying what failed (not reached, refused what the console added, no MCP endpoint at
that path, not an MCP server). No session takes part, nothing is tainted, and neither the answer nor the log
(`mcpServers: server tested` with `ok` and `status`) carries the server's body or any secret. A failed test saves
nothing unless the admin chooses Add anyway. The console never calls a link-local address, the instance metadata's
among them, by address or by a name resolving to one: the relay and the test both refuse it.

A server added, changed or removed reaches sessions started after it; a removed one's calls are refused at once
(`mcpRelay: refused, no such server`). The fleet hands each session its servers' names in `WOODSHED_MCP_SERVERS`, and
the session writes claude's `--mcp-config` from them (`session/taint.mjs mcp-config`). The console logs `mcpServers:
server added`, `server changed` (with `productionWas` when its kind changed), `server removed`, `header saved` or
`header cleared` with who, `mcpRelay: first call relayed` once for each session and server, `mcpRelay: refused` with
`why`, `mcpRelay: auth not added` (a header with no value yet), `mcpRelay: the MCP server refused what the console
added` (a 401 or 403 from it) and `mcpRelay: MCP server not reached`.

A signed token is RS256 from the console as an OpenID Connect issuer (`oidcIssuer.mjs`: the key in the
`oidc-signing-key` secret or `oidc-signing-key.pem` in the state folder, made the first time one is signed), with
`iss` the console's address (`WOODSHED_OIDC_ISSUER`), `aud` the server's audience, `sub` `private:<login>` for a My
Woodshed session or `session:<id>` for a shared one, and `login`, `session_id`, `session_kind` and `repo`. The
discovery document and the keys are at `/.well-known/openid-configuration` and `/.well-known/jwks.json`, before
sign-in; the card shows both for the server's own configuration. A local console with no secret store yet keeps its key
in `oidc-signing-key.pem` in the state folder; once a store is chosen and the console restarts, it makes a new key there,
which the JWKS then serves: a server fetching the JWKS follows by itself, and a test token signed before it no longer
checks.

### Production access

A My Woodshed session can debug a real production bug through a production MCP server such as woodshed-prod-mcp, which
masks and audits what it returns, and the console makes sure what the session saw stays in it (`../docs/reference.md`,
"Production access", says what it covers; `../CLAUDE.md`'s Rules, why it is the one exception). Off until an admin adds
a production server on Console settings (above, "MCP servers"), or the environment names one (`WOODSHED_PROD_MCP_URL`,
with `WOODSHED_PROD_MCP_PEOPLE` and `_REPOS`).

- **The relay** (`mcpRelay.mjs`): `/mcp/<name>` (and `/prod-mcp` for the environment's `woodshed-prod`) on the session
  API. Each call goes on with the server's auth, for woodshed-prod-mcp a signed token with `aud` `woodshed-prod-mcp`.
- **The session.** An eligible session's claude gets the production server from `--mcp-config` (`/tmp/woodshed-mcp.json`),
  in its `disabledMcpServers` for the checkout: claude makes no call to it until its person turns it on in `/mcp`. It is
  never started without the machine's Docker socket, which would let it undo a lockdown (its own, under Sysbox, stays).
- **Who can be tainted**: only a session that could use a production server when it started, first or on a Resume (`mayUseProduction` on
  its record, `fleet: a session that may use production`), which started as the lockdown needs: no machine's Docker,
  its own databases, and on AWS the guarded network. One started before a server listed it is refused (503, `started
  before it could use production`): a new session is ready for it. Its pass-through on AWS is likewise for those alone.
- **The taint** (`fleet.taint`): the first relayed call of any kind to a production server locks the session down through the launcher
  (`lockDown`), and only then sets `taintedAt` and forwards the call; the egress proxy holds the session to the
  lockdown's rules from the moment it starts. A lockdown that fails answers the call 503 and leaves the session as it
  was. The fleet ends the app's shares, then tells the session's statusd (`POST /taint`), which points every tool at
  the egress proxy, adds `session/tainted.md` to the rules, stops the settings sync and reopens claude's conversation on
  the Anthropic proxy with web search and fetch off and its production servers alone (the relay refuses it every
  other server), typing in what changed (`taint.mjs`'s message). A resumed tainted
  session starts so (`WOODSHED_TAINTED`). Its card says **Production**, its pane bar **Production data**; it has no Share
  the app, Editor or Remote Control.
- **The egress proxy** (`egressProxy.mjs`, `githubEgress.mjs`, `egressCerts.mjs`): on `WOODSHED_EGRESS_PORT`, taking the
  session's token as its proxy credential. A tainted session reaches GitHub's hosts alone, through TLS the proxy opens
  with its own authority (made by `openssl` in `egress/` in the state folder, name-constrained to github.com): git and
  the API on its project's owner's repos that are not public, and the API's pull request writes and GraphQL mutations,
  each id checked; its own project's repo it may always read (fetch, clone, API reads), public or not, so a resumed
  session gets its branch, though it never pushes to a public one (the GraphQL document read with a tokenizer as GitHub reads it: a mutation must be the document's only
  operation, with no fragment definitions or variable defaults, each top-level field an allowed one, every value a variable, and every value that lands
  in an `ID` variable or an `id`/`…Id`/`…Ids` field checked). A guarded session not tainted yet (AWS) goes anywhere on
  the public internet, untouched, but never to the console's own network: the name is resolved and every address it
  has must be public (no loopback, link-local and so no instance metadata, private or shared ranges), and that address
  is the one dialed. A session whose launcher does not guard its egress is refused pass-through altogether
  (`passThrough`). Every tunnel an untainted session has open is cut the moment its lockdown starts (`fleet.onLocking`,
  `egress: open connections cut at the lockdown`), as are its calls to ordinary MCP servers (`mcpRelay: ordinary calls
  cut at the lockdown`), and none opens while it runs. It logs `egress: refused` with the host and why, never the path.
- **What it kept** (`sessionApi.mjs`, `fleet.mjs`): its Claude home is saved for its Resume but never copied to the
  owner's, `/claude-settings` refuses it, and its container's log is never read into the console's. It is removed
  Console settings' **Remove a stopped session that saw production data after** (24 hours, or
  `WOODSHED_PROD_MCP_REMOVE_AFTER_HOURS`) after it stops, home and attachments with it; a home that would not delete is
  tried again (`taintedHomesPending` in `state.json`). Its record goes with it, statusd's readings and all.
- **The Anthropic proxy** reads a tainted session's calls and refuses one that would have Anthropic reach the internet
  for it (`web_search`, `web_fetch`, `mcp_servers`, or an image or document anywhere in it with a `url` source):
  `anthropicProxy: refused, a tainted session asked Anthropic to reach the internet`. A POST it cannot read as JSON is
  refused too (`anthropicProxy: refused, a tainted session's call the console cannot read`).
- **Its databases**: a My Woodshed session that may use production is given a copy of its own at its first start, as
  a shared session is (`ownDatabases` on its record, `woodshed__<id>`), never its owner's `woodshed_<login>`, which the
  owner's other sessions read: `fleet: a session that may use production gets databases of its own`. The copy is
  kept while the session is on the list and dropped once it is removed (`keptIds`, the databases sweep).

What woodshed-prod-mcp could add to tie its audit to Woodshed: its audit entries could carry the token's `session_id`
and `login`, so a call is traced to the session that made it.

## Setting up the GitHub App from the console

A console with a secret store (AWS, or the local provider's secrets folder) and no GitHub App
(`WOODSHED_GITHUB_APP_ID` unset) offers `/setup/github`, and My Woodshed's setup card lists **Connect a GitHub App**
first. On one person's console with a `gh` token, the App is
optional: one that listens on loopback and asks nobody to sign in (`isOnePersonConsole`), whatever name a proxy of
theirs (Tailscale's `serve` to their own devices) reaches it by. There the card lists **Connect a GitHub App (optional)**, which never holds New session back, since sessions push
and open pull requests as that person with their `gh` token and nobody else reaches the console to sign in
(`githubAppSetup.mjs`, `optional`). An App still pushes as a bot scoped to the repo, and is what lets teammates sign in. It starts without `gh` too, but needs it for every GitHub call afterwards, the App's included: without it the
console logs `console: gh not installed, GitHub calls will fail` at start. The page has three steps:

1. **Make the App.** *Create the App on GitHub* posts GitHub's App manifest (`githubAppSetup.mjs`, `appManifest`: the
   permissions sessions and sign-in need, the Callback URL `<public URL>/auth/callback`, no webhook; not the
   **Email addresses** account permission, which GitHub refuses in a manifest and "Who is who on Slack" says how to
   add), under the repo
   owner's organization or the person's own account. GitHub asks for one confirmation and sends the browser back to
   `/setup/github/created` with a single-use code, which the console trades for the App's ID, private key and client
   secret. The key and client secret go to the secret store (`github-app-key`, `github-app-client-secret`), never to
   `state.json`; the ID goes to `state.json` under `githubAppSetup`. A state nonce ties the code to a Create click made
   here. Or paste an existing App's ID and key (and optionally its client secret and installation ID): GitHub must accept
   the ID with that key before anything is kept.
2. **Install it** on the repo. *I installed it* asks GitHub where (`GET /repos/<repo>/installation`) and mints a test
   token before saving the installation ID; the ID can be given by hand.
3. **Restart the console.** It reads its App at start (`applyStored`): `console: GitHub App from the setup page`. An App
   named in the environment wins, and with one in force the page is closed. Set up the webhook afterwards on the
   Secrets & webhooks page.

   Where something starts the console again when it exits, the step has a **Restart the console** button
   (`POST /api/setup/github/restart`, an admin's and same-origin like the page's other calls). The console answers, then
   exits with code 75 a moment later, and the page waits for `/api/me` to say sign-in is supported (only a console with
   its App has it) before sending the browser to sign in. Sessions are containers of their own and keep running. The
   exit is non-zero because systemd's `Restart=on-failure` starts a unit again only after one. The console counts as
   supervised when systemd runs it (`INVOCATION_ID` is set: the unit must have `Restart=on-failure` or `always`), or
   when `WOODSHED_SUPERVISED=1`, which a container with a restart policy needs, since Docker does not tell a
   container its policy. `WOODSHED_SUPERVISED=0` turns the button off. Anywhere else, such as a `node` started
   from a shell, the step says how to restart it by hand instead. The console logs `githubSetup: restart from the page`
   at start with `offered` and the supervisor, `githubSetup: restart asked` with who asked, or
   `restart refused, nothing would start the console again`. On AWS the setup page never shows: the base box requires
   sign-in, so its console does not start without the App in its environment.

The page and its calls are an admin's like the Secrets page. A console with no sign-in has no admin to tell apart, which
is why it is only for a console nobody else can reach, until the App exists and sign-in can be switched on.

### Which console does the automatic work

A repo can be connected to more than one console, such as your own and one on a hosted service, and each hears
the same GitHub events. Without more, each starts its own session from the label or a comment, and its own review and
QA. `pullRequests.runsOn` in the project file names the one that does, by the login its GitHub App acts as
(`acme-woodshed[bot]`, say). Any other console also leaves the QA label (`qa.autoLabel`) to it, logs `fleet: skipped, pullRequests.runsOn names another console` and
starts nothing, though sessions started from its page still run. Left out, every console acts, as before. Consoles that
act as the same App all match a login alone; `<login>/<name>` picks one of them by the name each is given
(`WOODSHED_RUNS_ON_NAME`, lowercase letters, digits and dashes), so `acme-woodshed[bot]/staging` is that App's console
named `staging`, and a console with no name matches no such line.

A pull request one of a console's own sessions opened is the exception: that console reviews and QAs it as the person
who started the session, on their plan, whatever `runsOn` names (`fleet: pull request opened by a session, run as its
starter`). Any other console skips a bot-authored pull request on a session branch (`woodshed/…`) it has no session for
(`fleet: pull request opened by another console's session, left to it`), which also keeps two consoles of one App off
each other's. So a session's pull request never falls to a team key because another console heard it first. Once a
session's record is gone (removed from its ⋯ menu, or cleared a few days after it was deleted), every console skips
its pull request, which then gets no review or QA until it is replaced.

### The reviewer App

GitHub never lets a pull request's author approve it, Apps included, and a pull request a shared session opens is the
installation's App's. So a review session (`pullRequests.review.runner: woodshed`) submits its verdict as a second App,
the reviewer App (`reviewerApp.mjs`), which asks for pull requests (write) and nothing else. Once the console has its
App, `/setup/github` offers it, and the setup card lists it right after the App, to admins (optional: sessions work
without it, only their approvals do not count). Once the rest of setup is done it stays on New session, above the form,
until the reviewer App is made:

1. **Make the reviewer App.** *Create the reviewer App on GitHub* posts its manifest (`reviewerManifest`: no webhook,
   no sign-in). GitHub sends the browser back to `/setup/github/reviewer-created`, and the console keeps the key in the
   secret store (`github-reviewer-app-key`) and the App's ID and slug in `state.json` under `reviewerApp`. No restart:
   the key is read at each review.
2. **Install it** on each repo whose review runs as a session. The project file names neither App: the console fills
   in `pullRequests.review.author` with the reviewer App's `<slug>[bot]` and `commentAuthor` with its own
   (`reviewLogins.mjs`), so renaming either App changes nothing there. The console App's login is read from GitHub when
   the console starts; the reviewer App's follows a rename from the login its next review comes back with. A login the file does name still wins. With no
   reviewer App no verdict is trusted, because sessions hold the console App's tokens and one could approve as it. The
   review's PR comment and the Merge risk check stay the installation's App's.

It asks for contents (write) as well as pull requests, because GitHub counts an approval toward a branch rule's required
review only from an App that can write to the repo. Each review still goes out with a token narrowed to pull requests.
A reviewer App made before it asked for contents needs it added in its settings on GitHub, then accepted on each
installation.

**Is it ready for a repo?** `GET /api/review-readiness?repo=<owner/name>` (`reviewReadiness.mjs`) says, for a repo the
asker may start sessions on: the project, the console App's login, whether the reviewer App is made and installed on
the repo (with its install link), what the default branch's project file says of `review`, `qa` and `runsOn`, and each
missing step with who takes it (`missing: [{key, step, by}]`, keys `repo`, `reviewer-app`, `reviewer-installed`,
`reviewer-installed-unknown` when its installation could not be read, and `runs-on` when the default branch's `runsOn`
names another console, read as the fleet reads it, App and name). Of any other repo it says only that the console does
not have it for them, and asks GitHub nothing more. Anyone signed in may read it, and so may the command line's token
(`woodshed review enable` and `status`, cli/README.md, "Review"), as its person. Each call, a cookie's or a token's, is
held to write access on the repo, asked of GitHub then (a command asks once), so a person who lost it reads nothing
more of the repo, even with a cookie sign-in has not rechecked yet (`reviewReadiness: refused, no write access to the
repo`). A token's call that carries an Origin is a page's, and is
refused. A hosting program's proxy passes it through
when it carries `Authorization: Bearer wsc_…`, as it does `/api/cli/*`. A host's reviewer App may give
`installedOn(repo)`; without it, whether it is installed is `null`. It logs `reviewReadiness: reviewer App
installation not read` when GitHub did not answer.

**On by default.** Every repo the console has is reviewed in a session, with nothing to turn on or commit: where the
project file the console reads names no `pullRequests.review` (or there is no file), the console runs by
`console/defaultReview.mjs`'s review, `runner: woodshed` on a commit whose message has `[woodshed-review]`, added by
`reviewGatesOf` in `installation.mjs` (the fleet's `reviewGates`). It only starts reviews: what a pull request waits for,
its Slack post and QA, stays the file's alone, so a repo whose file names no review posts once out of draft and green,
as before, whatever a default review said. `woodshed review start` (`reviewOnDemand`) runs by it too. The file's own
`review`, on any runner, wins; it is where a team reviews every commit, uses another tag, or adds QA (`woodshed review
enable`). The default is the review alone: `suites`, `qa`, `mergeRisk` and `runsOn` stay the file's. Each coding session
is told the tag in `WOODSHED_REVIEW_TAG` (fleet.mjs, decided at each start), which its rules use when its checkout's file
names none, so the pull requests sessions open carry it. Someone who wants no review of their own pull requests picks
none on My settings ("Who reviews"). `GET /api/review-readiness`
says what runs in `review` (`{runner, rerun, from}`, `from` being `project file` or `default`).

**A push that dismissed the review's approval is reviewed again, tag or not.** Where the repo dismisses stale
approvals, a commit pushed after the review approved takes the approval away, and nothing else gives it back: a merge of
the default branch with git's own message (`Merge branch 'main'`, `Merge remote-tracking branch 'origin/main'`) carries
no tag. So when the review's own last verdict on the pull request is an APPROVE of an older commit and GitHub lists that
review as `DISMISSED`, the next pull request event (the push, or the dismissal itself) starts a review of the head
(`approvalDismissed` in `fleet.mjs`; it logs `fleet: the review's approval was dismissed by a push, reviewing it again`).
A fix after changes were asked for still waits for the tag, so a session can push its fixes in several commits for one
review, and a repo that keeps stale approvals is not reviewed again, since its approval stands. The tag is read from the
commit's whole message, not GitHub's shortened headline, and a merge commit's counts like any other.

At each verdict the console finds the reviewer App's installation on the repo, mints a token narrowed to pull requests,
and submits the review at the reviewed commit. It logs `fleet: review verdict submitted` with `as: 'reviewer App'`, or
`as: 'console App'` when no reviewer App was made, in which case GitHub refuses an approval of the App's own pull
requests.

### The review in a session

The session and the reusable Actions workflow share the common review instructions. The session prompt
(`shared/codeReview/prompt.txt`) has its own verdict and merge-risk criteria. The session writes files for the
console to post to GitHub:

- **Inline comments** (`inline-comments.json`) go on the diff's lines with the verdict. GitHub refuses a whole review
  when one comment is on a line the diff does not show, so the console then submits the verdict with the comments in
  its body (`folded: true` in the log).
- **Earlier inline comments** are in the session's context, with ids. Those by `review.author` that the head fixes go
  in `resolved.txt`, and after an APPROVE the console resolves them and the review's outdated threads, never a
  person's (`fleet: review threads resolved`).
- **The merge risk** is the Merge risk check and the `merge risk: low|medium|high` label, the other two taken off.
- **The PR comment** says `Reviewing`, with the spinner Claude's GitHub Action shows, as soon as the session starts, and becomes the review's comment when it ends.
  A session that ends without a review turns it into `The review did not finish` with the reason
  (`fleet: review ended without a report`).

### Who reviews: Claude Code, Codex, both or none

Each person picks who reviews the pull requests they open, on My settings' **Reviews of my pull requests** card
(`reviewAgents.mjs`; kept with their settings, `userSettings.mjs` `reviewAgents`): **Claude Code and Codex**, **Claude
Code only**, **Codex only** or **No code review**. A choice is offered only while something can run it:

- Claude Code: the team's `anthropic-api-key`, or their own Claude token while they run shared sessions on it;
- Codex: the team's `openai-api-key`, or their own Codex sign-in while they use it for reviews (below).

With no choice saved, a review runs the most there is: both, else the one there is, else none. A saved choice that can
no longer run keeps what of it can, else falls back the same way, and the console says why. A pull request is the
person's whose session opened it, or its GitHub author otherwise (`pullOwner`); one whose author fails the identity
checks of their Claude plan (`teamKeyReason`), or a bot, gets the most the team keys can run.

The review gets `review.agents` and `REVIEW_AGENTS` (`claude`, `codex` or both), and `session/review.sh` runs each.
Codex works as in a Codex session: it reads the checkout, runs what it likes (the container is the sandbox) and writes
its verdict's files itself, in `.review/codex/`. It gets `REVIEW_CODEX_MINUTES` (20 by default), then is stopped, and
Claude's verdict goes out alone. Codex alone sends its own verdict.

**No code review** starts no session and posts nothing on the pull request. The console keeps the skip in `state.json`
(`reviewSkips`, by project and number), and what waits for a review goes on without one for that pull request: the
Slack post and its brief (the gates come without `review`, `gatesFor` in `fleet.mjs`) and QA (`reviewApproved`). A
review that runs on it later clears the skip.

The two verdicts become one (`codeReview.mjs merge`):

- The stricter conclusion wins, so a pull request is approved only when both approve.
- The highest reported merge risk wins. When both rate it High, the check prefers a report with a failure reason
  and a pre-merge check.
- The comment and summary have a section from each, and each inline comment says whose it is.
- An earlier comment is resolved when the reviewer who wrote it (its `**Claude Code:**` or `**Codex:**`, read from the
  comment records `review.sh` keeps in `earlier-comments.jsonl`) found it fixed;
  one with no such mark, or whose writer wrote no verdict, only when every reviewer that gave a verdict found it fixed.
- When one writes no verdict, the other's goes out alone and says so.

The PR comment says `Reviewing with Claude Code and Codex`.

No sign-in ever enters the review session, which reads what anyone who can push to the pull request wrote. The
console's OpenAI proxy (`openaiProxy.mjs`) adds one of these to each of codex's calls, as the Anthropic proxy does for
claude:

- **The author's own Codex sign-in.** On My settings' Codex card, **Also use it for reviews of my pull requests** is on
  once a sign-in is saved, unless the person turns it off, as the Claude token's switch for shared sessions is. It needs
  the same checks as running a shared session
  on their Claude plan (`teamKeyReason`); a bot author never has it. The review keeps `review.codexLogin` and
  `review.codexVia`, and the session gets `REVIEW_CODEX_AUTH`:
  - `chatgpt` for a ChatGPT login, with `REVIEW_CODEX_ACCOUNT`, the login's account id (an id, no credential).
    `review.sh` gives codex a stand-in login for that account whose access token is the session's `SESSION_TOKEN`,
    refreshed just now so codex never refreshes it. codex talks to a ChatGPT backend only over https, so it is pointed
    (`chatgpt_base_url`, `openai_base_url`) at `session/chatgptRelay.mjs` on 127.0.0.1, with a certificate made for
    the run from a CA whose key is deleted at once and which only this codex trusts (`CODEX_CA_CERTIFICATE`). The
    relay passes each call on to the console's `/chatgpt/backend-api/`, where the proxy puts the author's access token
    and account on Codex's API (`codex/…`) and the account check (`wham/accounts/check`), and refuses the rest of
    ChatGPT, such as the author's chats. The console never refreshes the login (`codexModels.mjs` says why): one whose
    access token has expired is not used. codex first tries a websocket, which the relay does not carry, and falls
    back to https after five tries, a few seconds.
  - `key` for an API key, which the proxy puts on `/openai` in place of the team key.

  On a key, the author's or the team's, a review reaches only Codex's own calls on `/openai`: `/v1/responses`,
  `/v1/responses/compact` and `/v1/models`, in plain form. The key's files, vector stores, fine-tuning and the rest get
  a 404 (`openaiProxy: refused an OpenAI path a review's codex does not need`), since the pull request's code runs in
  the review. A private Codex session is its owner's, and reaches all of it as before.

  The proxy checks the switch and the sign-in at each call, so one turned off or expired mid-review stops being used
  at once.
- **The team's `openai-api-key`**, on `/openai`, for everyone else (`REVIEW_CODEX_AUTH=key`), and for an author whose
  saved ChatGPT login has expired.


The console logs:

- `userSettings: reviews of my pull requests` with the `choice`;
- `userSettings: own Codex sign-in for reviews` on each person's switch;
- `fleet: review session started` with its `agents` and `codex` (`own ChatGPT login`, `own key` or `team key`);
- `fleet: review runs other than the author chose` with `choice`, `agents` and `why`;
- `fleet: review not started` with `reason: 'the author chose no code review'`;
- `openaiProxy: first call on the author's ChatGPT login`, `on the author's key` or `on the team key`;
- `openaiProxy: refused, the author's sign-in not usable` with `why`.

In the session's pane: `Codex reviews on the author's ChatGPT login, which the console adds to its calls` or `on a key
the console adds to its calls`, then `Codex ended (exit=…)`, and `Codex took longer than … minutes and was stopped`
when it did. Codex's own log is at `.review/logs/codex.jsonl`.

**A review asked for by hand.** `woodshed review start` (cli/README.md, "Reviewing your open pull requests now", and
`woodshed setup`'s last review step) calls `POST /api/my/pulls/<number>/review` with the project's name, which the
command line's token reaches (cliSessions.mjs). The project must be one the person may start sessions on, which asks
GitHub for their write access to its repo (projectAccess.mjs), and the fleet's `reviewOnDemand` then starts the same
review session a tagged commit does (`startReview`), on the pull request's head as it is, tag or not. It runs by the
review the fleet's gates carry: the project file's, or every repo's default where the file names none. It refuses
(`fleet: review asked for, refused` with the `reason`): 409 where the project file itself chooses another runner for
its review (`runs its review in GitHub Actions`), or its `pullRequests.runsOn` names another console, 403 a pull request whose author (or, for one a session opened, that session's starter) is
someone else, since the review runs on the author's sign-ins and choice, 409 one closed or a draft, and 409 with
`startReview`'s own reason (a review running on an older commit, the author chose no review), and 409 while another ask
for the same pull request, or a tagged commit's review of it, is still starting (one guard for both, so they start
one session). A head commit a review session is reviewing, or gave its verdict on,
answers 200 with that session instead of starting another; one whose review failed, stopped with no verdict, or whose
verdict GitHub did not take (`review.posted` false) may be asked again. A new one answers 201 (`fleet: review asked for` with the `outcome` and its `id`).

### The approval waits for QA

When QA runs here (`pullRequests.qa.runner: woodshed`) and the pull request carries the QA label, the review's APPROVE
is held instead of submitted, so "Approved" on GitHub means reviewed and tested in any repo, with no branch rule that
requires the QA check. The review's comment, the merge risk and the inline comments' context go out as usual; the
console keeps the verdict on the review session (`review.held`) and starts QA on it at once (`fleet: review approval held
until QA finishes`). When QA reports on that commit (`fleet: held approval released after QA`):

- **Pass, or Not covered:** the APPROVE goes to GitHub with QA's result as its last line, and the fixed threads are
  resolved.
- **Fail:** the verdict goes in as REQUEST_CHANGES, saying the review approved but QA failed.
- **The head moved meanwhile:** nothing is submitted; the new commit gets its own review.
- **QA could not start** (the labeler has no write access, the project is not ready): the APPROVE goes out at once, its
  last line saying why (`fleet: held approval released, QA did not start`).

Only a report on the commit the QA session started on releases an approval: a report naming another commit did not
test it.

Without the label, as when someone removed it, the APPROVE goes out at once. A QA session that never reports leaves the
approval held: removing and adding the label runs QA again, which releases it.

## Webhook events, secrets and the GitHub App's webhook

In AWS the console has two more pages: Secrets & webhooks, a tab of Settings under Console in the menu under your
avatar, and Webhook events, linked from it (from its GitHub webhook card, or its note when there is no webhook card).
Only an admin can open them (see "Sign-in"). The same menu signs
you out.

- **Webhook events** (`/events`): each message it took off the webhooks queue,
  one line each: when it came, what the console did with it (started or messaged
  a session, skipped one the poll already handled, ignored, failed), the event,
  what it was on, who sent it and the delivery id, and a status word (Acted on,
  Ignored, Skipped, Failed). Labels and comments
  it does not act on, and Slack events that are not mentions, are left out.
  Each message is one line appended to `webhookEvents.jsonl`, beside
  `state.json`; the page shows the last 7 days, and a sweep every 12 hours
  (`webhookEvents: swept` with how many it kept) takes older lines out. A
  delivery the Lambda refused never reaches the queue: GitHub's Recent
  Deliveries page shows those. When a source is switched off on Console
  settings (below), the page says so above the list.
- **GitHub webhooks** row on Console settings, under This console (`/console-settings#webhooks`): a
  switch for GitHub on the row itself, and on the Slack group's Questions row one for Slack, shown
  where webhooks reach the console (a queue, the local receiver, or the program
  it is embedded in), that turn each source off on its own. **GitHub webhooks** off, the console drops
  each GitHub delivery as it arrives, so the queue forgets it, and polls GitHub
  at full speed (`WOODSHED_POLL_SECONDS`) as a console with no webhooks does.
  The poll finds only the session label and `/woodshed` comments, so what only
  a webhook starts stops until it is on again: QA labels, QA after a review
  approves, `qa.autoLabel`, review sessions started by a commit's tag, and the
  assignee's message for a session's `Needs a human:` comment. The console logs
  `webhooks: off, dropped a delivery the poll does not cover` with its `kind`
  at the first of each.
  The Slack card's **Questions** switch (only on a console that answers them) off, it drops each
  mention of its bot, which nothing else brings, and lists it as ignored. Each
  is kept in `state.json` under `webhooks.<source>`, with who turned it and
  when; the console logs `webhooks: switched` with `source`, `off` and `by`,
  then `webhooks: off, deliveries dropped from now on` with the `source` at the
  first delivery it drops, and at start `console: GitHub webhooks are switched
  off on Console settings, polling` or `console: Slack questions are switched
  off on Console settings`.
- **Secrets & webhooks** (`/secrets`, the second tab of Settings): groups of rows that open in place, as on My
  settings (`public/settingsRows.js`), one row per secret. A closed row says what the secret is for, when it last
  changed and whether it is set; open, it has the value behind Show and the form that sets or replaces it. A link to
  `#secret-<name>` opens that row. Replace saves a new version, so the one before stays restorable as
  `AWSPREVIOUS`. Show reveals a session secret, since anyone who reaches the
  console can already read it in a session's terminal; the GitHub App's key is
  write-only. Slack's two keys are not listed: they are set on the Slack card
  (below, "Slack"), and a row says so. A new App key is used at once, after a test token minted with it
  succeeds. The GitHub webhook group has three rows: Connection, Payload URL and secret, and a link to Webhook
  events. Connection checks four things (the App's webhook switched
  on, the five events subscribed, the App connected to the Lambda with the
  stored secret, GitHub's last delivery accepted) and **Set up webhook** walks
  through them in three steps: the boxes only GitHub's settings page can tick
  (Active, the events, the Webhook URL), Connect (make the secret and set it on
  the App with the Lambda's URL, `PATCH /app/hook/config`), and a test label
  whose delivery the modal follows from GitHub (`GET /app/hook/deliveries`) to
  the console's events log. The Lambda rereads
  its secret when a signature fails, so Rotate secret on the Payload URL and secret row takes effect at once.

Every change says what it changes and what that affects before it goes ahead.
Replacing or rotating a secret needs its name typed; the server checks the
same word on every write, including the setup's Connect.
The console's role can describe, read and write these six secrets and no others, and
list every secret's name and dates (`ListSecrets` cannot be narrowed), so the
page loads with one CLI call. The console runs at most three AWS CLI processes
at once: each takes about 75 MB, and its container has 512 MB. So the fleet's
tick reads every session's task in one `describe-tasks`, not one each, which
would keep a save waiting behind it.

## Databases

Which database engines an installation hosts is its own: Postgres, Mongo, both, or none, each on its own (`databases`
in Terraform, which sets `WOODSHED_DATABASES`; on the local provider, the `WOODSHED_LOCAL_DB_*` it sets). Each
engine is a module in `shared/databases/` (docs/reference.md, "Databases"). Everything below is for the project file's
databases on the engines it hosts: without Mongo there is no Mongo copy, viewer, tunnel or restore, and with no database
there is no db-admin task and My settings has no Your databases. Open ▾ still has the viewers of a session whose
environment names its databases (below): only a session with no database of its own has Redis alone. The console logs `console:
databases` once at start, with `made`, the `engines` it makes a copy on, the ones sessions are `hosted` on and the ones
its `tunnel` reaches.

Each repo is checked on its own (`databaseGate.mjs`): when a repo's project file, read from its default branch, names a
database on an engine the installation does not host, no session on that repo that would get databases starts, and
every other repo still does. That repo is a **blocker**: one sentence naming the repo (`acme/api's project file asks
for a Mongo database, and this console only runs Postgres.`), the fix's steps in order (on AWS, add the engine to
`databases` in Terraform and apply; on the local provider, its `WOODSHED_LOCAL_DB_*`, or `install.sh` again with
`WOODSHED_REPO` where the install named no repo; then "Or take the Mongo database out of acme/api's project file",
linked to the file on GitHub), and the People list's admins to ask. `GET /api/my` has `projectBlockers`, each blocked
project you may start on by name (and `databasesRefusal`, the default project's as a sentence, for older pages);
Console settings' Repos card says Needs setup or Ready on each repo, with the blocker under it.

New session opens on your default repo only while it can start, else on the first that can, so a blocked repo never
shows up front while another works. The repo picker is always there, the only repo named as text with a way to add
another (Add a repo for an admin), and a blocked repo is listed with `needs setup`: picking it puts its card where the
prompt and Start were, with the numbered fix for an admin, and for anyone else "Only an admin can fix this", whom to
ask and a message to send them with Copy. My settings' Your databases lists the same cards. The API answers a start
with the reason and the first step (`Not started: acme/api's project file asks for … Add "mongo" to databases …`), and
a label, `/woodshed` comment or QA label gets the same on its issue. The console logs `console: project databases not
hosted` with the `project`, what the file `needs` and what is `hosted`, `console: project ready again`, and `fleet:
session refused, its project is not ready` or `fleet: trigger refused, its project is not ready`. A question from
Slack, which gets no database, still starts.

Every session's databases are a copy of one **template** on each engine, migrated and seeded
from the default branch, and every database has a user of its own, with its own password, the same on
each engine, that reaches nothing else:

| Database (on each engine) | User | Password | Who connects | Lives |
| --- | --- | --- | --- | --- |
| `woodshed__<session id>` | the same | `<prefix>/sessions/<id>/database` | That shared session, from the session API, and the viewers inside it | From the session's start until it ends |
| `woodshed_<login>` | the same | `<prefix>/users/<login>/database` | That person's private sessions, from the session API, and the viewers inside them | Until **Reset my data** or **Remove My Woodshed** |
| `woodshed__template` | `woodshed__template`, which cannot log in | none kept | Nobody: Postgres's is closed to connections, which a copy needs | Until the next template |

The template is the session image's: after each session build (by hand, or
every morning), the deploy workflow's session job runs the `<prefix>-refresh-db-template`
SSM document on the base box, which runs the db-admin task's `template` and
waits for it. That migrates and seeds `woodshed__template_next` from the image's
checkout, then swaps it in: Postgres by a rename, Mongo, which has no rename,
by copying it over. Each engine then writes a marker last that copies wait for
(Postgres's in the template's comment, Mongo's in a collection of its own). The
marker says which commit the template was built from, and `template` compares
it with the image's, for each database by its own `paths`; the strongest answer
is every database's, since their commands run together:

- nothing under a database's `paths` changed: the template is kept, and the task ends
  in seconds. The deploy workflow's session job makes the same check before it starts the
  task, against the last successful session build, and skips the step;
- only new migration files: a copy of the template is migrated and swapped in,
  with no seeding, which takes about a minute. If the copy's migrations fail,
  it builds from empty instead;
- anything else under its `paths`, an edited or removed migration, or a
  template that does not say its commit: built from empty, migrated and seeded,
  about four minutes.

A change to app code the seeds call waits for the next full build. A copy is
`CREATE DATABASE … TEMPLATE` and `REASSIGN OWNED` in Postgres, and `$out` with
the indexes in Mongo: seconds. A session's branch, or the default branch since the image,
can hold migrations the copy lacks, so the project's setup notes (its `setup`) should have Claude run
the database's `migrate` before the app.

Root is RDS's master user (Terraform's `database_user`, its password in RDS's own secret)
and Mongo's `root` (`<prefix>-root/mongo`), each only where the installation runs that database. Only the **db-admin task**
reads either: a one-off Fargate task, `<prefix>-db-admin`, running
`session/dbAdmin.mjs` from the session image. The console never sees a root
password. It can run the task, but only with one of these commands:

- `template`: build the template again, and swap it in;
- `reset <login>`: a person's user, and their databases as a fresh copy;
- `drop <login>`;
- `clone <session id>`, `drop-session <session id>`: a shared session's.
- `migrate <login>`, `migrate-session <session id>`: the project's `migrate` commands on a person's or a shared
  session's databases as they are, as their own user. The console runs neither: they are for a host that runs the
  task itself and changed an owner's databases outside it (put other data in a copy, say), so they hold the image's
  schema before anything uses them. Nothing is copied, emptied or seeded, the templates are not touched, and a
  project whose databases have no `migrate` logs `Nothing to migrate`. A migration that fails ends the run with
  `ERROR {"message":"migrating <name> failed (exit <code>)"}`.

After each of them, the task also closes every database to the roles that do not own it. Postgres lets every role
connect to a new database and make temporary tables there, a copy never takes its template's permissions, and a
session's own user makes databases of its own, such as a project's tests' `__test` and `__template` (named in its
`.woodshed/project.yaml`; `__`, so no login's database can be one), again before every test run. No user could read another's tables in one, but it could see the schema and hold a
connection that stops a copy. So each run revokes `CONNECT` and `TEMPORARY` from `PUBLIC` on every database but
`postgres` and `rdsadmin`, which every role needs, and the templates: a database is open only until the next run (a
shared session's start, a reset or drop, or the nightly template). Its log says `Closed databases to other users`
with how many, or names any still open.

The task definition's `entryPoint` fixes the hosts and every flag, the default project whose repo settings the
seed reads (`--project`) among them, and a run can
override only the command and the environment, from which `dbAdmin.mjs` takes
no host and Node no code (`env -u NODE_OPTIONS`). Without Mongo it has no
`--mongo-host`, and refuses a `MONGO_ROOT_PASSWORD` in its environment. Its log is in the sessions'
log group, under `db-admin/`.

Each person's own are made when they first save a Claude token, and are shown
on My settings with **Reset my data**. New session waits until they are ready.
**Remove My Woodshed** drops them. A shared session's are copied as the console
starts its container, so the two overlap, and the session waits for them at the
session API. On every tick the console drops those of each session that has
ended, however it ended: a stop, a failed start, a container that died
(`sweep` in `console/databases.mjs`). The session task definition holds no
database password at all: every session's entrypoint asks the session API for
its own.

Mongo runs with `--auth`. Its root user is made once on the base box
(`<prefix>-mongo-root`, through Mongo's localhost exception), and its
password is written to the secret, which the box may write but not read.

A session's databases open from the session's page, under **Open ▾** with
**Redis**. The session runs its own pgweb
(`/pg/<id>/`) and mongo-express (`/mongo/<id>/`) on loopback, as its databases'
user, so they reach those and nothing else (`startDbViewers` in
`session/entrypoint.sh`): on the databases the console made for it, or on the ones its environment names (the docker
launcher, a host that runs each session's own), which have no restore copy. Its statusd reports the engines whose
viewers it started (`viewers`), and Open ▾ offers those: an installation that makes no databases still shows each
session's own, and a session on a project with Postgres alone is offered no Mongo. A session from an image before
statusd said so is offered the viewers of the databases the console makes. A shared session's pgweb is locked to its
database (`--lock-session`), and so is a private session's on a database its environment names. A private
session's on its owner's own has two bookmarks instead, `your-database` and `restored-copy` (the copy Restore a Postgres dump makes,
below), with `--bookmarks-only`: its Connect button offers those two and refuses any other host, and its database
list switches only to where the owner's own user may connect. Like Redis, they go through the console to the
session's statusd; for a private session the console answers anyone but the
owner as for an id that does not exist. The image copies both from their
official images, pinned by digest. A session whose project uses Redis (its env mentions `REDIS_URL`) has its own,
with a **Redis** button on the session's page: `/redis/<id>/` goes through the
console to the session's statusd, which forwards it to redis-commander inside
the container. Sessions started before the image had redis-commander answer
`not found`.

### The editor

**Editor ↗**, under **Open ▾** in the session's pane bar (and **⋯** on a phone), opens VS Code on its checkout in a new tab, at
`https://<id>.<app domain>/__woodshed/code/`. The project file's `editor` turns it on and off (README.md, "The project
file"): with `false` the image is built without it, and a session whose checkout says `false` refuses it. The button
shows only while the session's statusd reports `editor: true`, which needs both. The session runs openvscode-server, Gitpod's MIT-licensed build of VS
Code, on 127.0.0.1:7688, started by statusd on the first request for it (`session/codeEditor.mjs`), so the first open
waits a few seconds and a session nobody opens it in never runs it.

It is on the session's app name, never the console's, because the workbench runs code the session controls: an
extension claude installs, or whatever answers on the editor's port. On the console's origin that code would act
with the console cookie of whoever opened it, an admin's included. The app's name already runs the session's own
code, and its sign-in cookie is that one session's alone (`__Host-`, so no other name sees it).

`console/editorProxy.mjs` lets in only someone who can open the session itself: the app's sign-in cookie says who,
and an app shared with members or by a link never opens the editor. It refuses a request another site sent, other
than opening its page (a sibling session's app counts as another site), and a websocket whose Origin is not the app's name, then forwards to
statusd with the session token, which statusd drops before it forwards. The editor has no connection token of its
own. Its terminal is a shell with the session's environment, as the Terminal tab's is. A console with no app domain
has no editor, and neither does a question from Slack. Sessions started before the image had it answer `not found`.

### From your own computer

Once a person's databases are ready, My settings has **From your computer**:
**Make a token** shows a command, once, which downloads
`/static/woodshed-db.mjs` (plain Node 18.3 or later, nothing to install) and runs it with
the token. It prints two connection strings and listens on localhost, Postgres
on 15432 and Mongo on 37017 (`--pg-port`, `--mongo-port` pick others), so
TablePlus, DataGrip, psql or Compass connect as if the databases were local.

Each connection the tool makes becomes one HTTPS request to the console,
`/api/tunnel/pg` or `/api/tunnel/mongo` with `Upgrade: woodshed-tunnel`. The
console answers 101 and copies bytes to RDS or the box's Mongo, the only two
places it goes (`console/dbTunnel.mjs`). Nothing new is open to the internet:
it is port 443, through Caddy, which passes the upgrade on as it does the
terminals' websockets. Postgres keeps RDS's own TLS end to end, hence
`sslmode=require` in the printed string (its name is not `localhost`).

The script has no sign-in cookie, so the token is its sign-in, as
`Authorization: Bearer wt_...`. It lasts 12 hours, and the console keeps only
its SHA-256. **Make a new token**, **Revoke**, Remove My Woodshed and the 12
hours each end it and close every tunnel it opened, and so does leaving the program's member list behind a hosting proxy
(at the next read of it, which a failed read retries every 5 s, backing off to a minute). It reaches only its owner's
databases: the console hands out their password, and the database still asks
for it.

### Restoring a dump

Your databases' **Restore a dump** on My settings puts a dump of your own, Postgres or Mongo, in place of the
template's data, in two steps (`console/dbRestore.mjs`). The page shows each as a checklist, as a session's start does:
the step running, how far it has got, how long each took, and the one that failed.

1. **Restore.** The dump is sent to the console (a bar, with Cancel), kept on its data volume only until it is
   restored, checked, and restored into a copy beside your database, `woodshed_<login>__restore`. The page counts the
   items as pg_restore goes (`412 of 1,030 items`, and the table it is on), or the collections as mongorestore does,
   then lists the copy's tables or collections with their rows, and for Postgres the newest migration in it and how
   many of the default branch's migration files (the files in the Postgres database's `migrations` folder, in the
   project file) it has not run, read through the GitHub App. Both come from the database's `migrationsTable` in the
   project file; a project with none gets neither. **Open in the database viewer** points a running private session's pgweb at the copy (its
   `restored-copy` bookmark; its Connect button goes back to `your-database`), or for Mongo opens the session's second
   mongo-express, which runs on the copy alone (`/mongo-copy/<id>/`, port 7687, `startViewers` in
   `shared/databases/mongo.mjs`). Your database is not touched.
2. **Apply to my database** (typing `apply`). Postgres: your sessions' connections are closed, your database renamed
   to `__previous`, the copy given its name, and `__previous` dropped last; if the copy cannot take the name, your
   database gets its own back. Mongo, which cannot rename a database: your data is copied to `__previous`, your
   database emptied and the copy copied in, both dropped last; on a failure `__previous` is copied back. An Apply that
   stopped half way leaves the data in `__previous`, and the next Apply puts it back before anything else. In Mongo
   that holds only for a backup that finished: the backup step writes a marker last, and replace takes it out once
   the database is right again, so a backup cut short, or one a failed cleanup left behind, is dropped, never copied
   back over newer data. Afterwards
   the card says what was applied and when, until the next restore. **Discard** drops the copy.

The page gives the commands that make a dump that applies cleanly, each in its own box, and keeps them under **How to
make a dump** once a restore has run: `pg_dump --format=custom --no-owner --no-privileges --no-comments`, with
pg_dump 16 or the `postgres:16` image for anyone whose pg_dump is another version, and `mongodump --archive --gzip` of
one database. The project file's `databases[].dump` says what they leave out (docs/reference.md, "The project file"):
`skip`, the Postgres tables whose rows come over empty (`--exclude-table-data`) or the Mongo collections left out, and
`extensions`, the only Postgres extensions the dump keeps (`--extension`), which the database's user may create. A table
other rows point at cannot be left out alone: their foreign key fails, and the restore stops. With no `dump`, nothing is
left out and pg_dump picks the extensions. The page says to run the Postgres database's `migrate` after a restore, or
to migrate it when the project file names no command. Only those formats are taken, up to 2 GB: a plain `.sql`
file would go through psql, which runs `\!` lines as shell commands in the console. The page reads a file's first
bytes before sending it, and the console checks them again. The console's pg_restore is 16, as RDS is: a newer one
sends settings Postgres 16 refuses (`SET transaction_timeout`), so a pg_dump 17 archive is refused, saying so. The
Postgres restore is one transaction that stops at the first error (`--single-transaction --exit-on-error`, with
`--no-owner --no-acl`); mongorestore runs with `--stopOnError`, every collection of the archive going into the copy. It runs in the console's
512 MB container, so it restores one collection at a time, 25 documents a batch, with `GOMEMLIMIT=200MiB`: its
defaults held over 400 MB for 47 MB of conversations, and the kernel killed it (`MONGORESTORE_THRIFT` in
`console/restoreRunners.mjs`). A restore is a whole database, never an addition: restore one dump that holds
everything, not one for some collections and another for the rest.
A failed restore drops the half-made copy. Every drop and rename ends only the person's own connections and tries
three times, two seconds apart: RDS's own (its monitoring, autovacuum) may connect to a new database for a moment,
the person may not end them, and `DROP DATABASE … WITH (FORCE)` would fail on them.

The console runs the tools itself (`console/restoreRunners.mjs`: pg_restore, psql, mongorestore, and mongosh with
`console/mongoRestore.js`), as your own database user, to the addresses the tunnel uses
(`WOODSHED_TUNNEL_POSTGRES`, `_MONGO`): what it does is what that user could do from your computer. No password
is ever an argument: Postgres's is in `PGPASSWORD`, mongosh's in its environment, and mongorestore's in a `--config`
file only it reads, deleted after. In Postgres the user owns its databases and has `CREATEDB`, which is all a restore,
a rename and a drop need. In Mongo a user can touch only the databases its roles name, so the db-admin task gives each
person's user `readWrite` and `dbAdmin` on its `__restore` and `__previous` too: when it makes the user, and on every
run for users made before (`Restore roles checked` in its log). The two names hold `__`, which no person's database
can, since a GitHub login never holds `--`: a login's `_restore` could be someone else's database. Reset my data and
Remove My Woodshed drop the copy and the backup with the rest.

## Session apps

Each running session's app answers at `https://<session>.woodshed.example.com`.
Dev servers still start only when needed: **Start app** on the session's page,
the rail or the Shared page runs the project file's `app.start` in the session,
and the button turns into **Open app** once the backend and the frontend both
answer. Claude starting them itself counts too. **Stop app** sits beside it, as
in the shed, and runs its `app.stop`, after interrupting a start still in
progress. Half an app says which half: `API down` when the page loads but every
call under it would fail, `frontend down` when only the backend answers (Start
app then starts the frontend). The GitHub comment that announces a session gives
the app's address. A project file with no `app` has nothing to start, so the button is **Set up app**
instead. It first says in a dialog what it does (Woodshed does not know how to start the app yet; the agent works it
out, saves it and starts it), since its name alone did not, then types a request into the session's claude
(`SETUP_APP_PROMPT` in `console/fleet.mjs`; held until its turn ends, as a message would be) to work out how the app
runs, write the `app` section, commit it and leave the app running. statusd reads a project with no app again every
10 seconds and on each Start app, so **Open app** shows once the file has one and the frontend answers. Claude's rules
say the same (`session/noApp.md`), so a private session offers it when the person wants to see the app, and give it
the app's address (`session/appAddress.md`) in place of a localhost one the person cannot reach.

A project file with several apps (`apps`, docs/reference.md) runs one at a time. **Start app ▾** opens a menu of their
labels, and picking one sends its name (`POST /api/sessions/<id>/app/start` with `{"app": "<name>"}`, passed on to
statusd's `/app/start`); statusd stops the app that runs first, with that app's own `stop`, then starts the one picked.
While one runs, the button beside **Open app** carries its label (`Admin ▾`) and opens the same menu, and Open app
goes to whichever runs. With one app there is no menu, and the request has no body. statusd's `/status` lists the apps
and names the one running (`apps`, `appName`); a session from an image before several apps lists none, so the console
shows it one Start app and refuses a name for it, and an older console's Start app sends no name, which starts the
default, the first.

The session has 2 vCPU, so a start is the one moment its CPU badge runs high:
both cores are busy while the app's servers load, then the container idles.
What a project's start command runs in a session, and why, is the project's to
document (its `.woodshed/`).

A wildcard DNS record and a wildcard certificate (the same DNS check as the
console's) send every `<session>.woodshed.example.com` to the console, which picks
the session from the name (`console/appProxy.mjs`) and forwards to its statusd,
which forwards to the frontend on the session's loopback. No new port opens on a
session. The app runs at `/` as it does locally: the frontend reaches its backend
through its own proxy, and an app that signs in a test user itself (a dev-only login route) never sends the
browser to its login provider, which then needs no callback for these names. The
apps sit behind the same sign-in as the console (see "Sign-in").
A console with no wildcard certificate, such as a local install on a VM named through sslip.io, has its proxy get one
per name on demand instead. Before each, the proxy asks the console on a loopback-only port
(`WOODSHED_TLS_ASK_PORT`, `console/tlsAsk.mjs`) whether the name is the console's own or a session's;
`providers/local/README.md`, "Session apps without a wildcard certificate", has the Caddyfile.
A session started before its image had **Start app** shows no app.

### Session apps on ports

A console with a single name and no wildcard, such as one person's console that Tailscale's `serve` puts at
`https://<machine>.<tailnet>.ts.net` for their own devices (`providers/local/README.md`, "From your other devices, with
Tailscale"), gives each app a port of that name instead: `WOODSHED_APP_PORTS=7701-7710`. The console listens on each
port too, on its own host, and the proxy in front maps the same port of the name to it (`console/appPorts.mjs`). A
port is lent to a session once its app is starting or up, and the session keeps it while it is active, so an open tab
keeps working; a stopped session's port goes to the next one. The session list carries each running session's
`appUrl` (null until a port is lent, when Open app and Editor ↗ go through `/auth/app`, which lends one). The console
logs `appPorts: listening` at start, `appPorts: port lent` with the `id`, `port` and the session it was `from`, and
`appPorts: no port free for the session's app` when every port is held: stop a session, or name more ports.

An app port answers its session's app alone, never the console's own pages, which would then share the app's origin;
a port lent to nobody answers 404. The console's writes and websockets need its own origin, and a port is part of an
origin, so an app's page cannot drive the console. Cookies do not keep ports apart, though: the apps share their own
cookies by name (two sessions' `session` cookies overwrite each other), and the console's app sign-in cookie could not
keep one app's viewers from another's. So app ports are for a console nobody signs in to: the console refuses to start
with them beside `WOODSHED_REQUIRE_SIGN_IN`, a hosting proxy, a host past loopback or `WOODSHED_APP_DOMAIN`, and
**Share the app** is not offered.

### Sharing the app

A My Woodshed session's app is its owner's alone, as the session is. **Share**, beside the app's button in the
session's pane bar (**Share the app…** in its ⋯ on a phone or a narrow window, and in the palette's actions for it),
lets the owner open it to more people. While members or a live link can open the app the button reads **Shared**, its
title saying who. Only the app: the terminal, Review, the Redis and database viewers, Start/Stop and
the share controls themselves stay owner-only (`canOpenApp` in `server.mjs` adds to `canOpen` for the app's name and
nothing else, and the proxy hands the app's path only the session's status port and token). The owner chooses the
audience each time, and either can be turned off:

- **Members of this console.** One switch. Anyone signed in on the People list opens `https://<id>.woodshed.example.com`
  through the console's own app sign-in. Someone who cannot sign in (no write access, not on the list) cannot use it.
- **A link anyone can open.** For someone with no account here, such as a designer without write access. The owner picks
  an expiry (1 hour to 7 days) and gets `https://<id>.woodshed.example.com/__woodshed/share?t=<token>`, shown once.
  Opening it trades the token for a `__Host-woodshed_view` cookie for that one app and redirects to `/`, so the token
  leaves the address bar. The cookie holds the same token and every request checks it again, so **Revoke**, the expiry
  and the session stopping end access at once, websockets included. A session has at most ten links. The owner may
  name a page of the app for a link to land on (`{"path": "/landing-a"}`, which adds `&next=/landing-a`): after the
  trade it redirects there rather than to `/`. `shareNext` in `appShares.mjs` keeps it to a path on the app's own
  name, never another site's (`//host`, `/\host`, a scheme) nor the console's `/__woodshed/` paths, and a `next` added
  by hand that is not one lands on `/`.

The command line does the same with `woodshed session app <id> share` (cli/README.md, "Sharing a session's app"): the four
routes take its token through `cliSessions.mjs`'s gate and answer as the page's, by the same code, owner and private
session only, refused once it has seen production data.

`state.json` keeps `appShares` (the switch, and for each link its id, a SHA-256 of the secret, who made it and when it
ends), never a token. A session that is no longer active loses all its shares at the console's next tick, so a
resumed session starts private. Neither audience is read-only: the app signs in as the session's dev user, and so does
whoever opens it, so they can use it and change its data. The proxy removes the share cookie before the app sees the
request. A link is a secret: anyone it is forwarded to gets in, and the console logs only its id (`appShares: link
issued`, `link opened`, `link refused`, `link revoked`, `members changed`, `shares ended`).

## Sign-in

In AWS the console is open to the internet behind Caddy, and asks for a
**GitHub sign-in**: anyone with write access to the repository can sign in,
through the GitHub App's own user authorization (`console/auth.mjs`). Every
page, API call, terminal, Redis viewer and database viewer needs it. A session lasts 12
hours, and write access is checked again every hour, so leaving the repository
signs you out. The GitHub user token is used once, to learn the login, and
dropped.

**The desktop app** (`desktop/`) signs in through the person's own browser, where they are usually signed in to GitHub
already (`console/desktopSignIn.mjs`). Its Sign in with GitHub opens `/auth/desktop?challenge=` in the browser, which
signs in as usual if it has to, then asks **Sign in to the Woodshed app?** as whom. Only that button, a form POST from
the console's own page (Origin checked, the page never framed), makes the code, so another program on the machine that
opens the browser with a challenge of its own and catches `woodshed://` gets nothing without the person's press. The
page after it opens `woodshed://signed-in?code=&challenge=` with a code that lives two minutes and works once; the
challenge goes back with it so the app claims only the link of the sign-in it is waiting on. The app claims it at `POST /auth/desktop/claim` with the verifier the challenge was made from (PKCE's S256), for a
session of its own, which keeps the browser session's last access check and ends when the browser's would, so
handing a sign-in to the app never extends it: signing the browser out leaves the app signed in, and the other way round. `GET
/auth/desktop/ready` says the console does this; a console behind a hosting proxy, which signs people in itself,
answers none of these, and the app signs in inside its window there, unless the program answers them itself
("Embedding the console": `handleDesktopSignIn` with its own sign-in). The ready answer's `signInPaths` are the paths the
console's pages sign in at (`/auth/start` here), which the app sends to the browser. The console logs `auth: desktop sign-in code
issued`, `auth: desktop signed in`, or `auth: desktop sign-in code refused` with `known` and `verified`.

**The woodshed command line** (`cli/`) signs in by a device code (`console/cliSignIn.mjs`), as `gh auth login` does.
`woodshed login` asks `POST /api/cli/device` for a code, prints it, and opens `/cli?code=` in the browser, which signs in
as usual if it has to, then asks **Sign in the woodshed command line?**, naming the computer, the code and when it was
asked. Only that page's button, a form POST from the console's own page (Origin checked, never framed),
approves it; Deny refuses it. The CLI asks `POST /api/cli/token` every 5 seconds meanwhile, and gets its token once.
`woodshed setup` uses `login --no-wait` to return the approval link immediately and collect the result on the next run.
`GET /api/cli/me` reports `sessionSignIns`, one boolean per personal agent sign-in of the CLI token's owner.
The device-flow POST routes (`/api/cli/device` and `/api/cli/token`) refuse a call with an Origin header, so no web page
starts a sign-in to hand someone the link of. The code lasts 10 minutes. The token (`wsc_…`) is its own kind, not the
database tunnel's: one per computer, 90 days, sent as `Authorization: Bearer`. Besides `/api/cli/*` (including
`/api/cli/settings` for shared Claude settings and own files) and
`/api/tunnel/exec/*` the token signs in to the routes listed in `console/cliSessions.mjs`. For `woodshed session` these
are `GET /api/sessions`, `GET /api/my/projects`,
`POST /api/my/sessions`, `POST /api/my/sessions/<id>/resume|remove`, `POST /api/sessions/<id>/stop|extend|limits` and
`POST /api/sessions/<id>/app/start|stop` (Start app and Stop app; Set up app stays the page's),
while `woodshed review` uses `GET /api/review-readiness` ("The reviewer App"). For `woodshed config`
(`console/cliConfig.mjs`), `GET /api/cli/config` returns the person's choices on My settings and
never a secret, and `POST /api/my/terminal`, `/api/my/reviews`, `/api/my/codex-auth/reviews`,
`/api/my/claude-token/shared`, `/api/my/projects/default` and `/api/my/github/identity`, which answer the token with
that same view rather than the page's whole My settings answer. Each is answered by the page's own code as the token's
person, so it sees and changes exactly what they could on the page.
Every other route refuses it with 403, and so do those for a call with an Origin header (a page's). Those writes need no
`x-woodshed` header or Origin, which only stand between another site and the browser's cookie; each logs
`cliSessions: call` with the login, the token's id and the path, and a refusal `cliSessions: refused, not a route the
command line may call`. Like a browser's sign-in, its person must still have write access on GitHub, asked at the
token's first use and then hourly by the one check every call with a token goes through (`authenticate` in
`cliSignIn.mjs`: `/api/cli/me`, `/api/cli/logout`, these routes and the pipe into a session alike): when GitHub says no,
every command line sign-in of theirs ends (`cliSignIn: refused, write access gone`), and a `woodshed logout` that finds
it so answers that the token ended, as it asked. GitHub not answering lets the call through and is asked again 5
minutes later (`cliSignIn: write access not rechecked`). A session a terminal is connected to is not kept awake by it: `woodshed session extend` and
`limits` ask for more time, as Extend and the session's own Pause and stop do on its page. The console
keeps only its SHA-256, in `state.json` under `cliTokens`, and My settings' Command line row lists each computer with
Revoke. Remove My Woodshed, People's Remove and leaving a hosting program's list end them all. The console logs
`cliSignIn: sign-in started`, `sign-in approved` or `denied`, `token made`, `token revoked` with `by`, and `refused, a
browser's call` or `refused, the token's person is no longer a member`.

Starting a sign-in needs no identity, so at most 5 may wait from one client address (an IPv6 one counted by its /64),
and 200 on the console as a backstop: one client filling its share leaves the rest to everyone else. Past either,
`/api/cli/device` answers 429 with `Retry-After`, the seconds until the oldest of those waiting expires, and `scope`
(`client` or `console`). A code stops counting once it is collected, or denied in the browser (a denied one is kept for its CLI's next
poll, at most 200 of them, the oldest dropped first). The console logs `cliSignIn:
sign-in refused, too many waiting` at most once a minute for each `scope`, with how many it `refused` since (from any
address) and `lastFrom`, the address of the one that wrote the line. The client's address is the socket's, or, when that is a trusted
proxy, the last entry of `X-Forwarded-For` that no trusted proxy wrote (`console/clientAddress.mjs`). Caddy writes the
address it saw there and drops what the client sent, and the console's own Caddy (AWS's base box,
providers/local/README.md) and Tailscale's serve reach it from loopback, which is trusted by default. A proxy that reaches
the console from another address (Caddy in a container of its own, a load balancer) is listed in
`WOODSHED_TRUSTED_PROXIES`; until it is, every client behind it is one address. The header from anyone else is ignored,
so nobody makes up an address to get more places.

**Into a session from the command line**: `woodshed tunnel <id> -- <line>` (cli/README.md) is one request,
`/api/tunnel/exec/<id>` with `Upgrade: woodshed-tunnel`, that token, and the line base64'd in `x-woodshed-exec`
(`console/execPipe.mjs`). The console checks, as it opens and every 15 seconds after, that the token is live and its
person still on People with write access (`authenticate`, above), that the session is running and is theirs (a My Woodshed session's owner: shares come later),
and that it is not tainted or being locked down; then it sends the request to the session's statusd `/exec` with the
session's token in place of the person's, as it reaches statusd for the viewers, and copies bytes both ways once statusd
answers 101. statusd runs `sh -c <line>` as the session's user in the checkout, without `SESSION_TOKEN` or
`TERMINAL_TOKEN` in its environment, in a process group of its own. Both ways are framed (`session/execPipe.mjs`,
`shared/execFrames.mjs`): stdin and its end in, stdout, stderr and the exit code out. stdin's end is a frame, so Caddy
never carries a half-closed connection, and a connection that ends early is a disconnect, which hangs up the line's
whole process group. `pipe()` on both hops, and each end pausing on a full buffer, hold a slow side back end to end. Revoking the token (My settings, `woodshed logout`, Remove My Woodshed, People's Remove, leaving a
hosting program's list) closes its pipes at once, and so does a session's lockdown starting (`fleet.onLocking`). A
pipe is not activity: the session pauses when idle as it does without one, which ends it: keeping a session up is
done explicitly (its Extend), never by holding a pipe open. Nothing new is open: it is the console's port, through Caddy, and statusd's,
which the console already reaches. The console logs `execPipe: opened` with who, the session, the token's id and the
computer, `execPipe: closed` with its seconds, bytes and `why`, `execPipe: refused` with `why` (`not theirs`,
`tainted`, `not running`), `refused, no valid token`, `refused by the session` with statusd's status, and `session
unreachable`; statusd logs `statusd: exec opened` with the line's length (never the line) and `exec closed` with its
exit code.

**A terminal from the command line**: `woodshed session connect <id> [--shell]` (cli/README.md) is a websocket,
`/api/tunnel/term/<id>` (the TUI tab's terminal, the agent's) or `/api/tunnel/shell/<id>` (the Terminal tab's shell),
with the same token and the size it opens at in `x-woodshed-terminal-size` (`<columns>x<rows>`). The console checks it
as it does a pipe, as it opens and every 15 seconds after, and closes it on the same revokes and lockdown. It sends it
on to the session's ttyd for that tab with ttyd's credential in place of the person's token, as `terminalProxy.mjs`
does the page's. ttyd 1.7.7 also wants its credential in the terminal's first message: the console sends that message
itself, with the size asked for, as it does the page's, so `TERMINAL_TOKEN` never leaves it. No compression is asked
for. Then it copies bytes both ways. The log lines are the pipe's, with `kind` (`term` or
`shell`; `exec` for a pipe). It is the same terminal as the tab's: the agent's tmux or Herdr terminal, or the shell's
tmux, so what is typed in one shows in the other.

**A review from the command line**: `woodshed review <id>` (cli/README.md) makes the Review tab's own calls,
`/reviews/claude-<id>/...`, with the command line's token in place of the browser's sign-in, and no Origin. The review
proxy's `forCli` (`reviewProxy.mjs`) checks the token with cliSignIn's `authenticate` (live, its person on People with
write access), then lets through only a running session of that person's own: never a question from Slack, a shared
session, one that has seen production data or is being locked down (409), nor the page itself (`/review`). It forwards
as the page's calls are, with the session's token in place of the person's; what the review may write to GitHub stays
the session's rule. The console logs `console: review call from the command line` for each write, with who, the
token's id, the session and the path, and `console: review call from the command line refused` with `why` (`not
theirs`, `tainted`, `no valid token`, `a browser's call`). `woodshed session list` reads `GET /api/my/pulls` with the
same token (cliSessions.mjs), for the person's open pull requests with no session.

**A console with no repo yet** (neither `WOODSHED_REPO` nor `WOODSHED_PROJECTS`, and nothing added on the
Repos card) has no repository to ask about. It lets in the owner of the account its GitHub App is installed on: that
user, or an active admin of that organization (`console/appOwner.mjs`, asked with a token of the installation narrowed
to `members: read`, so the App needs Organization permissions, Members: read; without it the login page says so). The
first to sign in is the first member and an admin, as on any new console. Once a repo is added, write access to it is
what is asked again, at the next hourly check.

Write access alone is not enough: a person must also be on the console's list,
on the **People** tab of Settings (`console/members.mjs`, `members` and `memberRequests`
in `state.json`). An admin can invite a handle (it must have write
access), accept or decline someone asking to join, and remove another member;
nobody can remove themselves. A writer who is not on the list signs in only as
a visitor: the login page offers **Ask to join**, and lets them in by itself
once an admin accepts. Admins see a dot on their avatar while someone is
asking.

**Admins.** Each member on People has an *Admin* switch, off for a new member.
Only an admin sees the Console group in the avatar menu (Settings, whose tabs
are General and Secrets & webhooks, listed under it too, then People; Webhook events is reached from Secrets &
webhooks), and the console answers 403 to
anyone else's call behind those pages (`ADMIN_API_RE` in `console/server.mjs`;
it logs `console: admin call refused`). The pages themselves still load and say
so. Only an admin turns the switch on or off, and the last admin cannot turn
theirs off (`members: admin changed` logs each change). A console with no
sign-in, like `devConsole.mjs`, treats everyone as an admin, and so does a list
with no admin yet (the one a console starts from the people already using it),
until the first is switched on. The first person to sign in to a console with
an empty list is its first admin. Locked out with no admin left: stop the console, set `"admin": true` on your entry under `members`
in `/var/lib/<prefix>/console/state.json`, and start it again.

**The page** reads as the other settings pages do (`public/settingsRows.js`): **Asking to join** is a group of plain
rows, one per person, with Accept and Decline on the row, and is left out while nobody asks; **Members** is a group
whose box holds the table below, which scrolls sideways inside the box on a phone; and **Invite someone** (Add someone
behind a hosting proxy) is that box's last row, which opens in place on its form (`/people#invite-card` opens it).

**What each member can do.** Members is a table, one row per member, with a **Role** select and what that role can do
beside it, in words. A role is a name for one set of three switches, which the console keeps and checks
(`console/peopleRoles.mjs`): picking one sets all three at once (`POST /api/people/access`, `members: role set` in the
log), and the role shown is read back from the switches, so a list from before roles shows as roles too.

| Role | Admin | Sessions from GitHub | Can be assigned |
| --- | --- | --- | --- |
| Owner | on | on | on |
| Member | off | on | on |
| Contributor | off | on | off |
| Private only | off | off | off |

The first person to sign in to a new console is a full Owner. An owner with a switch off (behind a hosting proxy, where
Can be assigned starts off, or an admin from before roles) shows as **Owner (partly)**, with what they lack in words;
picking Owner turns the rest on. Picking any other role for yourself while you are an owner asks first, since it takes
these pages away at once and only another owner can give them back; the last owner is refused anyway. Invite someone takes a role too, picked from a table of the roles with what each can do; without one (an older page or a script), someone new has every switch
off, Private only. The switches:
- *Admin*, above.
- *Sessions from GitHub* (`githubSessions`): the `woodshed` label and
  `/woodshed` comments start or message a session for them, and they see
  shared sessions and the Everyone tab. Without it the console answers on the
  issue that nothing started, takes the label off ("How sessions start"),
  lists them no shared session, and answers 404 for one's id, as for someone
  else's private session; their rail is Mine alone, and `/all` opens Mine.
- *Can be assigned* (`assignable`, once called Engineer): see "Assigned
  sessions" above. It needs Sessions from GitHub, so it is greyed out without
  it, and turning that off turns this off too and gives their sessions back
  to Unassigned. An old `engineer` field in `state.json` is ignored: the
  switch starts off, and sessions already assigned keep their assignee.

**Behind a hosting proxy** there is no People list of the console's own, and no People page, unless the program
embedding the console hands over its list (`members`, "Embedding the console"). With it, People is a tab of Settings, as on any console,
after General and Secrets & webhooks, for owners (the admins there). Who is in and each person's role (Owner or
Member) are the program's: **Add someone** takes a GitHub handle and a People role, Remove and the Role column change
them there (Owner is the program's owner role, every other People role its member role), and core keeps no copy of the list (`console/hostedMembers.mjs`). Nobody asks to join, so there is no Asking to
join, accept or decline, and no dot. The switches stay the console's, in `state.json` under `memberSwitches` by
lowercased handle: *Sessions from GitHub* is on for everyone listed (it was never asked behind a proxy, and it also
gates seeing shared sessions), so only those turned off are kept; *Can be assigned* is off, as above. Someone the list
no longer has is no member, assignable or not, from the next read, and their switches are cleared then. The Slack link
works as above. Nobody removes themselves, and the last owner is neither removed nor made a member, before the
program is asked; the program's own refusal is shown as it says it.

Taking someone off the list shuts them out at once. A console that never had a list starts one from the people signed
in to it and those with My Woodshed sessions; with nobody to start from, the
first sign-in is the first member.

The login (the GitHub handle) is the key for everything a person has here. The
pages show each handle's GitHub display name instead, with the handle on hover,
or `@handle` for someone with none; Slack posts and GitHub comments keep the
handle, which GitHub turns into a mention (`console/githubPeople.mjs`). The
name comes from the sign-in, or for someone who only adds labels or comments,
from GitHub's `/users/<handle>`, asked again once a day. The console also keeps
the account's numeric id, the first one seen for each handle. GitHub frees a
handle its owner renamed away from, and another account can take it later:
that account is refused at sign-in, and its labels and `/woodshed` comments are
ignored, so it never reaches the first owner's token, databases or sessions.
Both live in `state.json` under `githubAccounts`.

**When a sign-in fails**, the login page says whose problem it is
(`signInFailure` in `console/auth.mjs`). The person's own get their own
message: no write access to the repository, a handle that was another
account's, or an expired or replayed link (GitHub's `bad_verification_code`
included). Anything else is the console's: GitHub not reached, `gh` missing or
failing, GitHub refusing the App's client secret or Callback URL, or GitHub not
saying who signed in. Then the page says only "The console could not check your
access with GitHub. Ask whoever runs it to look at its log.", and the console
logs `auth: sign-in failed` with `step` (`sign-in code`, `write access`,
`connect` or `members`) and the error's first line. No error text reaches the
page.

The login page names the repository only to a browser `/api/me` tells it to:
not a signed-out one once sign-in is required, since the repository may be
private.

Locally the console listens on 127.0.0.1 and has no sign-in: never
bind it to a public address, since a terminal is full control of a session.

The base box sets `WOODSHED_REQUIRE_SIGN_IN=1`, so sign-in is required
from the console's first start and never goes optional: with no client secret
nobody gets in, and a replaced secret is required at once. The console refuses
to start with it set and no GitHub App. Without it (a console nobody else can
reach), saving the secret only makes sign-in *available*, and the first sign-in
that completes makes it required, so a wrong Callback URL locks nobody out.

Setting it up, or locked out by a wrong or missing client secret:

1. In the GitHub App's settings (General): set **Callback URL** to
   `https://woodshed.example.com/auth/callback` (`WOODSHED_PUBLIC_URL`
   plus `/auth/callback`), and **Generate a new client secret**.
2. Save it to a file only you can read, upload it, and delete the file:
   `aws secretsmanager put-secret-value --secret-id
   <prefix>/github-app-client-secret --secret-string file://<file>`.
   On the local provider, `node woodshed/providers/local/bin/secret.mjs put
   github-app-client-secret < <file>`.
3. Restart the console on the base box (`cd /opt/<prefix> && sudo docker
   compose restart console`): it reads the secret at start. Then sign in.

Once signed in, the Secrets & webhooks tab replaces the secret without a
restart.

Sign-in's cookies belong to one host name, and GitHub sends people back only
to the console's own (`WOODSHED_PUBLIC_URL`). So once the client secret
is set, a page opened on the bare IP moves to `woodshed.example.com`.

The console's cookies are `__Host-` cookies, which a browser takes only from
`woodshed.example.com` itself, so code in a session app cannot plant or shadow
them. A session app cannot read them either, so it gets a sign-in of its own:
a page opened on `<session>.woodshed.example.com` without one goes to the
console's `/auth/app`, which, once you are signed in there, sends the browser
back with a one-time code that lives a minute. The app's name trades it for a
`__Host-woodshed_app` cookie good for that one app. The console takes that
cookie off every request before it reaches the app, and the app's other cookies
pass through. An app's sign-in rests on the console session that made it:
signing out of the console, its 12 hours running out, or the hourly check
finding write access gone signs its apps out too. Requests that are not page
loads (an API call, a websocket) get a 401 without the cookie rather than a
redirect.

- Every request must arrive by a name the console answers to: loopback, the
  machine's hostname (or its MagicDNS name), the host of
  `WOODSHED_PUBLIC_URL`, or one listed in `WOODSHED_HOSTS`. That
  stops DNS rebinding.
- Writes and terminal websockets must come from the console's own origin
  (Woodshed's `sameOrigin.mjs`), and writes also need the `x-woodshed: 1`
  header, which a cross-site form cannot send.
- The proxy adds each session's ttyd credentials, in the terminal's first
  websocket message too, and passes on only ttyd's page itself (`/<kind>/<id>/`,
  as written: ttyd reads `%74oken`, `//token` and `token;x` as its `/token`),
  so the browser never holds the terminal credential. It is a separate token from the one
  statusd checks all the same, and only the console can reach statusd.
- The database viewers and the Redis viewer have no login of their own, so a
  page on another site must not reach them through a signed-in browser.
  The console refuses any request to `/term/`, `/redis/`, `/pg/` or `/mongo/`
  whose `Sec-Fetch-Site` says another site sent it. A typed URL or a
  bookmark still works; a link to a viewer from Slack does not.

## Hosted mode

A service can host a console for an organization: it has already connected the organization's GitHub (its own GitHub
App, installed on their repos) and signs people in itself, in front of the console. Two settings hand both to it, so
nobody makes a second App at `/setup/github` or signs in with GitHub again. Each is off unless set, and a self-hosted
console is as it was.

**Borrowed GitHub access** (`WOODSHED_GITHUB_BROKER_URL` and `WOODSHED_GITHUB_BROKER_TOKEN_FILE`, both or
neither; `console/githubBroker.mjs`). The console has no GitHub App of its own, and refuses to start with
`WOODSHED_GITHUB_APP_ID` set too. Every installation token, for its own GitHub calls and polls and for what
sessions get from `POST /github-token`, comes from the host:

```
POST <url>
Authorization: Bearer <the file's contents, trimmed>
Content-Type: application/json

{"repo": "owner/name", "permissions": {"contents": "write", "metadata": "read", ...}}
   (either left out when not wanted: no repo when the token is for no one repo, no permissions for the console's own)

-> 200 {"token": "ghs_...", "expiresAt": "<ISO 8601>", "permissions": {...}}
   anything else is a refusal; its JSON body may say {"error": "..."}
```

`permissions` narrows the token as GitHub's own `POST /app/installations/{id}/access_tokens` does, so the host passes
it on: the console asks with none for itself, with `SESSION_PERMISSIONS` (`projectTokens.mjs`: no workflows) for a
coding session, and read-only for a question from Slack. When it asked for some, the answer must give the token's
`permissions` as GitHub answered them, and a token that says nothing, or may do more than was asked, is not used
(`githubBroker: token wider than asked, not used`): a session gets no token rather than a wider one. Each repo's token
with the same permissions is kept until 5 minutes before `expiresAt`. The file is read at each ask, so the host can
rotate it, and its contents are never logged. The console logs `githubBroker: token borrowed` with the repo, the
expiry and how long the ask took, or `githubBroker: token refused` with the status and the host's `error`, or `not
reached`. There is no `/setup/github` (404), no GitHub sign-in through the App, no **Connect
GitHub** on My settings (private sessions push with the broker's token), and no webhook: the console polls
(`console: webhooks off, GitHub access is borrowed`), and the Secrets & webhooks page keeps every secret but the
App's own. Commits are `woodshed-bot`'s, as with an App ("Who commits" in `docs/reference.md`).

**Sign-in from a trusted proxy** (`WOODSHED_TRUSTED_IDENTITY_SECRET`, at least 32 characters;
`console/trustedIdentity.mjs`). The proxy signs each request it passes on, page loads, API calls and websocket
upgrades alike, on the console's name and on the session apps' names, with a fresh header good for about a minute:

```
X-Woodshed-Identity: <payload>.<sig>
  payload  base64url(JSON {"login": "<github login, lowercase>", "role": "owner" | "member", "exp": <ms since epoch>})
  sig      base64url(HMAC-SHA256(secret, payload))
```

The signature is compared in constant time, and an expired header, one whose `exp` is more than 5 minutes ahead, a
forged one, one signed with another secret or none at all signs nobody in: a page goes to `/login`, which says to come in through the host, and an API call or a
websocket gets a 401, as without a session today. The header is then the only sign-in, required from the first
request (which satisfies `WOODSHED_REQUIRE_SIGN_IN` and a console bound to a public address): the console has
no GitHub sign-in, no session cookie, no Sign out and no **Connect GitHub**. The host says who is in, so there is no
People list and nobody's write access to the repo is asked (nor, for another project, to its repo); everything else
that hangs off a login works as signed in, My settings, private sessions and each person's secrets
(`users/<login>/claude-token`) among them. `role: owner` is an admin (Secrets & webhooks, Webhook events, Console
settings); `member` is not, and gets 403 there. With no People list, nobody can be assigned a shared session, and the
`woodshed` label and `/woodshed` comments start sessions for anyone with write access to the repo, as the console
checks them: there is no Sessions from GitHub switch to ask. A program that hands over its own list of who is in (the
`members` hook, "Embedding the console" below) gets People back, as a tab of Settings, with those switches.

A session's app takes the header on its own name: `/auth/app` on the console sends the browser straight on to the
app's `/__woodshed/auth`, with no code, and every app request, the editor's and the websockets included, is signed in
by its header alone. An app's name that gets no header there answers 403 rather than sending the browser round again
(`app: no identity from the hosting proxy on the app's name`). Share links work as they do elsewhere, for whoever the
proxy lets through. The console never passes the header on to a session (the app, the editor, the terminals and the
viewers), where the session's own code could replay it within its minute. A refused header logs `trustedIdentity:
identity refused` with `why` (`forged`, `expired`, `too long`, `malformed`, `bad identity`), at most once a minute for
each.

Writes still need the console's own origin and `x-woodshed: 1`, and terminal websockets its own origin: the proxy
signs every request a signed-in browser sends, a cross-site one too. `woodshed-db.mjs`'s tunnel keeps its own token,
which is not refused when the host later lets someone go: it lasts at most 12 hours. The console logs `console:
hosted mode` with which of the two are on at start.

**One person's console** (`WOODSHED_ONE_PERSON=1`, or `config.onePerson: true` for an embedding program). With no
People list of its own (a program's is not counted) a hosted console cannot count who uses it, so the host says when it is one person's own, such as a
personal workspace: the rail then shows one list of every session, with no Mine | Everyone switch. Without it, Mine
still lists the shared sessions each person started, since nobody can be assigned one here.

## Embedding the console

`console/installation.mjs` is one console without its servers: `createInstallation` builds the fleet, GitHub clients,
secrets, settings, pages and session API from a config in `loadConfig`'s shape and the services that hold its data and
run its sessions, and returns `handle` and `upgrade` for the console's server, `sessionApi` for the session API's, and
`start` and `stop` for its loops. `startConsole` builds one from the environment and serves it. Another program can
build one from services of its own (a `store` from `openServiceStore` over its own load and save, a launcher, secret
and home stores in the providers' shapes) and serve it from its own servers. It can also pass:

- `trusted: {userFor(headers)}`: who the request is from, where the program signs people in itself, as a hosted-mode
  proxy's header says on a single console.
- `config.githubBroker.source`: a GitHub token source called in the process (`createInProcessBroker`), with the HTTP
  broker's checks and cache.
- `userMenu(headers)`: what the program adds to the user menu and the settings pages' side list (`menuOf` in
  `server.mjs`, `designSystem/components/MenuGroups`), `{subtitle?, you?, groups?, sections?}`: `subtitle`, a line under
  the person's name on the user button; `you: [{label, href}]`, the person's own pages, after My settings under their
  name in the menu and in the side list's You group; `groups: [{label, items: [{label, href?, current, note?}]}]`, what
  the person switches between, after those, the one in use `current: true` (it needs no `href`); and
  `sections: [{label, items: [{label, href, items?: [{label, href}]}]}]`, the program's own headed groups after the
  Console group, in the menu and the side list, an entry with its own pages under it as Settings has its tabs (listed
  always in the menu, and in the side list on those pages). Each `href` is a path on the console's name or an http(s)
  address, text is cut at 100 characters, fifty links in all, and anything else is dropped; a hook that throws adds
  nothing and logs `console: user menu not given`. A group with no label and no `current` items, the way to put links
  under the name before `you`, is still read as `you` links: move them to `you`.
- `settingsTabs(headers)`: tabs of the program's own pages on Settings, `[{label, href}]`, after General and Secrets &
  webhooks (`settingsTabsOf` in `server.mjs`: at most eight, each `href` a path on the console's name, the rest
  dropped; a hook that throws adds none and logs `console: settings tabs not given`). The program serves each page
  itself, rendered with `settingsFrame({title, body, current, heading?, tabs?, login?, linkQuery?, styles?})` from
  `server.mjs`: its own HTML (`body`, which it has escaped) under the title Settings and the tabs, with `current` (the tab's `href`) marked,
  in the settings pages' frame, with the side list and avatar menu (`public/hostSettings.js`). A page that is one of
  `userMenu`'s `you` or `sections` entries instead passes `heading`, its title in place of Settings, and `tabs`
  (`[{label, href}]`, paths, at most eight), the row under it, such as the entry's own pages, or none: `current` then
  marks its entry in the side list and menu, and its tab in the row and among the entry's pages. `styles` are its
  stylesheets (paths), loaded after the console's, so its rules use the design system's variables and follow the
  theme; it scopes them to `.host-page`, which holds its part. Its forms and links stay the program's. Someone who is not an admin sees the program's tabs alone, and Settings in the Console group opens the
  first of them; with no tabs, nothing changes for them. It draws its part with the console's own components, made on
  its server by `settingsMarkup.mjs` (designSystem/components/SettingsRows, "From a program's server"), so it looks
  like the console's pages and follows the design system as it changes; their rows open in place (`public/hostRows.js`).
- `repoPage({name, repo, headers})`: groups of the program's own on a repo's settings page (Console settings → Repos →
  Repo settings), after the console's, for what it keeps about the repo: its session image's project file, the data its
  sessions start from. Async; it answers markup from `settingsMarkup.mjs`, `{markup, scripts}`
  where its groups need scripts to work (an upload's: paths on the console's address, at most eight), or `null` for
  none. The admin's view of the repo carries it as `host: {html, scripts}` (`GET /api/console-settings/repos/<project>`),
  and the page puts the markup in as a template's contents, so no `<script>` in it runs, then loads each script once:
  markup from `settingsMarkup.mjs` alone, which escapes every value, never a string the program built some other way. A
  script listens on the document, or for `woodshed:host-groups` on `window`, which the page fires each time it draws the
  groups anew (a save answering with new ones). Its forms post to the program, which sends the page back to
  `/console-settings/repos/<project>#<row>`, opening that row. A hook that throws, or answers anything else, adds none
  and logs `repoSettings: the program's groups not given`; the page is shown without them.
- `standalonePage({title, body, brand: {label, href, icon?}, groups?, current?, login?, signOut?, dialog?, refresh?, styles?, scripts?})`
  from `server.mjs`: a page of the program's that stands outside any console, such as a first visit before there is a
  console to be in. It is the settings pages' frame drawn by the server, the program's name (and its mark, `icon`, a path) heading the side list in
  place of Back to sessions, its `groups` of links under it and Sign out posting to `signOut`, with the design system's
  stylesheet and `hostRows.js` and no console script, so it asks no console anything. `dialog` is a step drawn over it
  (`settingsMarkup.mjs`'s `dialog`), the page inert behind; `refresh` reloads it after that many seconds.
- `members: {list(), add({login, role, by}), remove({login, by}), setRole({login, role, by})}`, with `trusted` only
  (given without it, `createInstallation` throws): the program's own list of who is in, for the People page (above,
  "Sign-in", behind a hosting proxy). `list()` answers `[{login, role, note?}]`, `role` `owner` or `member` (an
  entry with another role, or that is no GitHub handle, is left out and logged); `note`, a few words People shows
  under the person (`hasn't signed in yet`), is plain text on one line, cut to 80 characters, and left out (the person
  kept) when it is not text. The others change it, `by` being the owner who did, and resolve once done. `add` may
  resolve to `{told}`, one sentence of what the program did about it (`We emailed them a link.`), which People shows
  after the add in place of its own `Nothing is sent to them: tell them the link.`; plain text, cut to 200 characters,
  and `told` in `/api/people/add`'s answer (`null` when the program said nothing). Owners are the admins, as the proxy's header says. Core keeps no copy of the
  list: it reads it at start, and keeps the answer 5 seconds. The fleet asks who may start a session from a label or be
  assigned one as it goes, without waiting, so it is answered from the list as last read, which is read again in the
  background once it is older; People's own reads, and each change made there, wait for a fresh one. Until a first
  list is read nobody is in (`members: the program's list not read at start`). Core keeps each person's switches:
  *Sessions from GitHub* on and *Can be assigned* off for someone new, cleared when they leave the list. Only someone
  on the list starts a session from GitHub (a label or `/woodshed`), as intended: the list is who is in. Each read
  gives the shared sessions of anyone it does not have back to Unassigned, so someone dropped while the console was
  down is released at the next start. An empty list while core knows of someone (the last list read, a stored switch
  or an assigned shared session) is kept from: the last list stays, nothing is cleared or released, and it logs
  `members: the program's list came back empty, kept the last one`; a console that never had anyone takes it as it
  is. People never empties the list, since nobody removes themselves and the last owner stays. A call that
  throws an error with `shown: true` shows its message on the page as it is; any other is logged (`members: the
  program failed a change`) and answered 500. Without the hook a hosted console has no People, as before.
- `signOut(req)`, with `trusted`: how the program signs someone out, for the user menu's **Sign out**, which a
  hosted console otherwise leaves out since it signs nobody in itself. The menu posts to `/auth/sign-out` as on a
  console of its own; the console refuses a post from another site, then calls `signOut` with the request (its
  cookies are the program's) and answers 303 to the `location` it returns (a path or an https address, else `/`)
  with its `setCookie` (one or a list). One that throws answers 500 and logs `console: sign-out failed`.
- `config.linkQuery`: query parameters every link the console hands out carries (GitHub comments, Slack posts,
  `SESSION_URL`, the copied New session link), for the program to route them.
- `newId`: how session ids are made, when they must be unique beyond the installation.
- Where the program signs people in itself (`trusted`), the desktop app's routes are its own to answer, since core's
  sign-in is off: `handleDesktopSignIn` (`desktopSignIn.mjs`) with an `auth` of the program's (`visitorFor` says who
  the browser is signed in as, `desktopCode` issues a code for them when they press Sign in, `claimDesktopCode` makes
  the app a session of the program's), the codes from `createDesktopCodes` (`auth.mjs`), and `signInUrl(back)` and
  `signInPaths` for the program's sign-in page.
- The command line's routes are core's own (`cliSignIn.mjs`): `/cli` is behind the program's sign-in like any page, and
  `/api/cli/*` carries its own token in `Authorization`, so the program's proxy passes those through without its
  sign-in, as it does `/api/tunnel/*`. When a request carries `Authorization: Bearer wsc_…`, also pass through the
  session routes listed in `cliSessions.mjs` and the six settings writes listed in `cliConfig.mjs`. The console checks
  the token itself and refuses it on other routes.
- `cliDevices`, from `createCliDevices()` (`cliSignIn.mjs`): for a program serving several installations at one address,
  one waiting room for the command line's sign-ins that it gives them all. `POST /api/cli/device` and `/api/cli/token`
  carry no sign-in, so the program answers them itself, with `handleCliApi` and a `createCliSignIn` on that same room;
  the installation whose `/cli` page the person approves the code on makes the token, in its own state and checked by
  its own `allowed`, when the command line next asks, and the token's answer says that installation's `about`. The
  page names the org it signs in to, and asks again if the browser has moved to another installation since it showed,
  told by the installation's own id (`cli.id`), so two with the same name and org are still told apart.
  Every later call carries the token: `inst.cli.owns(headers)` says which installation holds it (no check of `allowed`,
  nothing written), and the program sends the request there, which answers or refuses it as its own. A program that
  answers `GET /api/cli/me` itself passes the installation's `sessionSignIns` to `handleCliApi`: without it the answer
  has none, and `woodshed setup` cannot tell whether Claude Code and Codex are connected.
- `repos: {list?(), add({repo, name?, by}), remove({name, repo, by}), names?}`: where the program keeps the
  installation's repos, which it built `config.projects` from, so Console settings' Repos card changes them there and
  core keeps no list of its own (`addedProjects`, above under the Repos card). `list` answers what Add a repo offers:
  `{repos: [{repo, private}] (or owner/name strings), grant: [{account, href}], install, complete?}`, the links
  `https://` only. Core takes connected repos out of the Add a repo picker. Set `complete: true` only when the list
  includes every repo the App can reach, including connected ones. The CLI can then tell when a repo has lost access.
  `add` checks the repo, keeps it, and answers the project as the program
  named it, `{name, repo}`; `remove` takes one off. Either throws an error with `shown: true` (and `link: {href, text}`
  where the fix is a page, such as giving the GitHub App access) for a refusal the page shows as it is; core refuses
  the default project, a repo with sessions on it, and a repo or name already there before it asks. `names: false` when
  the program names each repo itself: the page then asks for no name, and one sent is refused.
- `projectReadiness({name, repo})`: why sessions cannot start on a project, where the program knows something core
  does not (its session image is not built, an install secret has no value). Async; it answers `null` when the
  project is ready, or a blocker without `project` and `repo`, which core fills in:
  `{reason, fix: [{text, href?, label?}], ask?: {who, text?}}`. `reason` is one plain sentence naming the repo;
  `fix` the steps someone who can fix it takes, in order, each with an optional link (`href`, https or a console path
  such as `/console-settings`) and its button text (`label`); `ask` whom someone who cannot should ask (GitHub logins)
  and an optional message, ready to send. Core asks it before its own database check, on each look at New session, My
  settings and Console settings and at each start (an answer is kept 10 seconds), and shows and refuses with it as
  with its own (above, "Databases"); a link that is neither https nor a path, or a step with no text, is dropped. A
  hook that throws blocks nothing: core logs `console: project readiness not read` and runs its own check.
- `hostApp: {login(), reviewer?}`: the App whose GitHub access the program lends (`githubBroker`), which the console
  cannot ask GitHub about itself. `login()` answers its `<slug>[bot]` (or null while unknown), asked each time, so the
  console trusts its comments, the QA label it adds (`qa.autoLabel`) and a review session's PR comment as that App's.
  `reviewer` is the program's reviewer App: `{login(), configured(), submitReview({repo, number, event, body, sha,
  comments})}`, as `reviewerApp.mjs`'s, through which review sessions' verdicts are submitted and trusted. Give it
  `installedOn(repo)` (true or false, throwing when GitHub fails) and `view()` (`{installUrl}`) too: without them
  `woodshed setup` and `woodshed review status` say of every repo that the console cannot tell whether it is
  installed (`reviewer-installed-unknown`), with no install link and nothing logged. Without a `reviewer`,
  no verdict counts (above, "The reviewer App"), and the console offers no reviewer App setup of its own. Logged as
  `console: GitHub App from the host`.
- `mcpServers: {list(), save({server, by}), remove({name, by})}`: where the program keeps the MCP servers sessions get
  (above, "MCP servers"), so Console settings' card and its API change them there and nothing goes to `state.json`.
  `list` answers the servers in the API's shape (each is checked, and one that does not check is left out with
  `mcpServers: a server from the program left out`); it is read at start and after each change. `save` is handed the
  server as core keeps it, with `headerSavedAt`, `updatedBy` and `updatedAt`, to keep as it is; a header's value stays
  in the console's secret store, never the program's list. A program that only adds servers for its people can call
  the API instead, as an owner.
- `woodshedUpdate: false`: no Woodshed card on Console settings, no dot on the avatar for it (`updates` is left out of
  `/api/me`), and no update check, for a program that deploys Woodshed itself. Its update routes
  (`/api/console-settings/updates`, `/check`, `/update`) answer 404, as on a console that runs from no git clone (below,
  "Console settings").
- `githubConnect: {clientId(), clientSecret(), href}`, behind `trusted` only: Connect GitHub on My settings through
  the program's GitHub App, for a console with no sign-in of its own. Connect sends the person to `href` (a path),
  where the program signs them in with its App's user authorization and hands GitHub's answer to the code to the
  installation's `connectGitHub({login, answer})`, then sends them to `/settings?connected=1`; `login` is who signed in
  here, and GitHub must say it is them. From there it is the Connect GitHub above (`githubUser.mjs`): kept in
  `provider.secrets` at `users/<login>/github`, refreshed and ended with `clientId()` and `clientSecret()`, and handed
  to that person's private sessions alone. The program's App is installed beyond this console's repos, so the token is
  always scoped by GitHub: to this console's repos of the session's repo's owner when the project file's `githubAccess`
  is `full` (`sessionApi: github access for a private session` logs `repos`), and to the session's repo alone when it is
  `repo` or the file cannot be read (logs `repo`); a session that gets no scoped token pushes as the App. The
  installation's `disconnectGitHub(login)` is Disconnect, for when the person leaves. `automatic: true` says the
  program connects people on its own (on their first page, say): My settings then shows the connection as a status,
  "Pushes as @you", or, unconnected, says it did not happen and offers Connect as the way back. Without a secret store it is off
  (`console: Connect GitHub off, the host gave no secret store to keep tokens in`).
- The installation's `matchSlack({login, emails})`, for a program that signs people in itself: the Slack match core's
  own sign-in makes (`slackPeople.mjs`), which links a member's Slack user from the verified emails on their GitHub
  account so People shows it and assignment pings reach them. Call it as they sign in, with `emails()` answering those
  emails (GitHub's `/user/emails`, which a GitHub App's user token reads only with the account permission Email
  addresses: read); it is called only when a look is due, at most once a day, and never over a link set by hand on
  People. Someone the program's `members` list does not have is not matched (`skipped`). It never throws, and answers
  `linked`, `unmatched`, `manual` or `skipped`; Slack's bot needs `users:read.email`.
- A launcher's `progress(sessionId)`: the steps a start waiting for room is at, when the wait is the program's own,
  such as a machine it sets up for the sessions (`providers/README.md`, "A wait's progress").
- `start({ deliveredWebhooks: true })`, then `dispatchWebhook(message)` for each GitHub event (`githubEvents.mjs`'s
  `toMessage` makes the message from GitHub's own payload): the GitHub poll then runs only as a fallback.

- `maxValueBytes` on the program's secret store (`providers/README.md`, "A secret store's limit on one value"): the most
  bytes it holds in one value. Your files on Repo settings, one secret per person and repo, are held to it (64 KB when the store declares
  none), so a store with no such cap, such as one sealed in a database, should declare its own.

- `createsOnWrite: true` on the program's secret store when its `write` makes a secret that does not exist yet
  (`providers/README.md`, "A secret store that makes a secret when it is first written"): the Secrets page then
  offers Set on a secret nobody has written. Without it, such a secret shows no Set.

- `slackEventsUrl: () => Promise<string|null>`: the Request URL Slack's Event Subscriptions should post to, which the
  Set up Slack dialog shows and puts in the app manifest it gives (below, "Slack"), for a program that receives Slack's
  events itself. Without it the console asks its provider's `slackEventsUrl` (`providers/README.md`); with neither, or
  when it throws (`slack: events URL not read`), the dialog says the address is unknown and how to find it, and the
  manifest has no events.
- `slackInstall: {label, description?, available?, href?, installed?}`: the program's own way to put a Slack app in a
  workspace, offered in the dialog as a second option beside "Use your own Slack app". Every word of it is the
  program's: `label` is the option's title, `description` the line under it. `available` (true when left out, or a
  function answering it) false shows the option disabled, with nothing added: the program says why in its own
  `description`, such as when it will be ready; `href` (https, or a path on the
  console) is where Continue goes when it is picked. `installed()` (async allowed) answers whether this console was
  connected that way: the card's Bot row then says installed with the option's label, and offers **Reinstall**
  (`href`) in place of Replace keys. Core has no install flow of its own: whatever `href` leads to writes the same
  `slack-bot-token` the dialog does. Without the hook the dialog opens on the own app's steps.

A Claude token or Codex sign-in written straight into the secret store, as `users/<login>/claude-token` or
`codex-auth`, counts as saved, as one saved on My settings does (`userSettings: sign-ins follow the secret store`).

## Slack

When a shared session opens a pull request, the console posts it to its
project's Slack channel (below) as `PR title - PR link - 🟢 Low risk` (🟡 Medium, 🔴 High, or
`⚪ Risk not posted` without a trusted merge risk check), with its decision
brief (below) as a reply in that post's thread, once, and only after it has earned it by the
gates in the repo's project file (`pullRequests`, docs/reference.md, "The project file", read from
the default branch every 10 minutes): the `review`'s latest verdict is APPROVE, and every
job of each of the `suites` (each check run whose name starts with its `jobs`) passed on
its head commit. A suite whose workflow's `on.pull_request` path filters leave out every
file the pull request touched never runs, so it is not waited for; the console reads the
filters from the workflow file on the default branch, and waits for the suite when it
cannot. With no `pullRequests` (or no project file, or neither a review nor a suite), it
is posted once it is out of draft and none of its checks is running or failed (with no checks at all, 2 minutes after it was first seen, so they have time to show). A project
file that cannot be read holds every pull request until it can. A My Woodshed session's
pull request is never posted: it is watched instead (below). Until then the
pull request waits in `state.json` (`slackPending`), checked once a minute and
past the session's end; one closed, or still waiting after a week (a number on
the Console settings page), is dropped unposted. Once it is posted, its session stops (`posted to Slack`) and is
Finished. While it waits, a review verdict asking for changes on
its head commit, or a suite that failed or was skipped there, is typed
into the session, once each, with the `rerun` tags to put on the next commit, and a paused session is resumed with it.
A pull request older than the session is never posted: a resumed
branch's, or the one a PR's own session works on.

**A My Woodshed session's pull request is watched**, with or without Slack (`watch` on its `slackPending` item), so
the session keeps going until its review and suites pass:

- **What it hears.** Each verdict asking for changes and each failed or skipped suite, as a shared session does, and
  once the gates pass on a head commit, a note (once per commit) to read the review's notes, fix what is real, see any
  other check in `gh pr checks` through, say what passed and stop. A suite whose path filters leave the change out is
  named as not run. Where a shared session would post a `Needs a human:` comment, it asks its owner at its terminal.
  Nothing is posted to Slack or written on GitHub.
- **Which pull request.** Only on a session whose statusd types only into a running agent when asked
  (`agentOnlySend` in its status; an older image's is not watched: `fleet: pull request not watched, the session's
  image types into its pane unchecked`). Only its owner's: one they opened, or one the console's App opened (a session that pushes
  as the App) from the branch the console made for the session at its start (`madeBranch`: `woodshed/<owner>-<id>` or
  `woodshed/<issue>-<id>`, not an existing branch it was started on, nor whatever it has checked out since; while the App's login is not read yet, such a pull request is decided a minute
  later), in the repo itself and not a fork, after the session started (`slack:
  someone else's pull request, not watched`). Never a review-only session's, nor one on another repo than its
  project's (`fleet: pull request on another repo than the session's project, not watched`, as for a session whose
  project left the list). Each watch is its session's own: two sessions on one pull request are each told, and a shared
  session's post on it still goes out.
- **How long.** While the session runs, so a fix pushed after the approval is followed to its own verdict. It ends when
  the pull request closes, the session stops (nothing resumes a My Woodshed session but its owner), its project leaves
  the console or its repo is another now (a default project replaced; each watch keeps its `repo`), the week runs out
  (passed or not; checked again after GitHub's reads, before the session is told, as is the head commit: a push
  during the reads makes them the old commit's, and nothing is said of it), or the project file has no review or
  suite (`slack: pull request no longer waiting` with why). A watch that ran out is not started again by the session
  coming back to its pull request (`watchesExpired` in `state.json`, by session, kept until the session leaves the
  list). A close during the reads ends the watch too.
- **While the session is elsewhere.** While it reports another pull request or none (a branch with none, or statusd's
  lookup failing), the watch waits, keeping what it told, and goes on once the session is back; it still ends if the
  pull request closes meanwhile.
- **Resume and delivery.** A resumed session's watch starts again, its week over, and its new run is told where the
  pull request stands. A stopping session hears nothing, and one claude is not open in (read again from statusd just before typing in, with
  the pull request it reports, and the pull request read again from GitHub to be still open on the same commit, and statusd checks the pane once more as it types, `agentOnly`, so a closed claude's
  shell never gets the text) is told at the next check
  (each minute, even while webhooks flow) rather than held, so nothing is typed in at a later Resume.

The console learns of the pull request from the session's status (`prUrl`),
reads it and its checks from GitHub with the App's token
(`console/prAnnouncer.mjs`, the gates in `console/pullGates.mjs`), and posts with
`chat.postMessage` as the bot whose token is `slack-bot-token`. The token is
console only, like the App key: a session never sees it.

### Setting it up: the Slack card

Console settings has one **Slack** group for all of it, a row each for the bot, pull requests and questions
(`public/consoleSettings.js`, its server side
`console/slackSetup.mjs`). Not set up, it is one line that says what Slack does and has **Set up Slack**, which opens a dialog
(`public/slackSetup.js`). Where the program embedding the console offers an install of its own (`slackInstall`,
"Embedding the console"), the dialog first asks which way to connect; otherwise it opens on the own app's steps:

1. **Create the app from this manifest**: the console makes a Slack app manifest (`slackManifest`) with the bot's
   scopes (`app_mentions:read`, `channels:history`, `channels:read`, `chat:write`, `groups:read`,
   `reactions:write`, `users:read`, `users:read.email`; the `channels:history` scope lets a question read the thread it was
   asked in, and an app made before it is reinstalled with it: until then the console logs `slack: call refused`
   with `missing_scope` and `asks: thread not read`, and answers from the mention alone), the Messages tab the assignee's direct messages need, and this console's events Request URL
   with the `app_mention` bot event. The URL is the embedding program's (`slackEventsUrl`), else the provider's: the
   webhooks Lambda's function URL at `/slack` on AWS, the local receiver's `WOODSHED_LOCAL_WEBHOOK_URL` at `/slack`.
   With neither the manifest has no events, and the dialog says where the address comes from. Paste it at
   api.slack.com/apps, Create New App, From a manifest.
2. **The Bot User OAuth Token** (`xoxb-…`, OAuth & Permissions, after Install to Workspace). The dialog checks it with
   Slack's `auth.test` as soon as it is pasted, and shows its workspace and bot, and any scope the app lacks (from
   Slack's `x-oauth-scopes`); the save checks it again before anything is kept.
3. **The Signing Secret** (Basic Information, App Credentials), for questions only: pull requests are posted without
   it.
4. **The channel for pull requests**, from the channel picker (below).

**Save and connect** (`POST /api/console-settings/slack`, `{"botToken", "signingSecret", "channel"}`, each optional)
writes the same `slack-bot-token` and `slack-signing-secret` the Secrets page used to, so what reads them (this file,
the webhooks Lambda, the local receiver) is unchanged, and the Secrets page no longer lists them: a line there points
to the card. A token Slack refuses, or a value of the wrong shape, keeps nothing. Neither value is ever sent back:
`GET /api/console-settings/slack` answers who the bot is (kept in `state.json` under `slackBot` until the secret
changes), whether the signing secret is set, the channel, the events URL, the manifest and the install option. The
console logs `slack: keys saved` with the workspace, the bot and which fields changed (never a value), and `slack:
call refused` for `auth.test` with Slack's error.

Connected, the card has a row each:

- **Bot**: the bot, its workspace, how it was connected (your own app, or installed with the program's option) and who
  set it when, and a scope the app lacks. **Replace keys** opens the dialog at the own app's steps with the manifest
  folded away and both fields empty: a field left empty keeps its value. A console connected through the program's
  install has **Reinstall** instead. A saved token Slack refuses shows as **Token refused**, with Slack's error.
  What the card says of the saved token is kept until the token changes, and an app reinstalled with new scopes keeps
  its token: **Check again**, next to a missing scope or a refused token, asks Slack about it now and reads the
  channel list again (`POST /api/console-settings/slack/recheck`, `slack: saved token checked again`).
- **Pull requests**: the channel, which the closed row names; opened, the picker again with **Save channel** and
  **No channel** (closing the row cancels a pick), and under **Limits** the two waits before a
  post (the review and suites, and the QA check; the table below).
- **Questions**, only where the console answers them at all (a Slack bot and a session API): the switch that was on
  the Webhooks card (`POST /api/console-settings/webhooks` with `source: "slack"`), when the bot was last mentioned
  (from the Webhook events log), a note while no signing secret is saved, and **Limits** for the questions' own
  (below, "Questions from Slack").
- **Disconnect Slack**, in the Bot row behind a typed `slack`, deletes both secrets (`POST /api/console-settings/slack/disconnect`;
  `slack: disconnected`). It is offered only where the secret store makes a secret on its first write
  (`createsOnWrite`, providers/README.md), as the local store does: a store whose secrets its infrastructure made, as
  Terraform makes AWS's, would be left without the one the webhooks Lambda reads, so there the keys are replaced
  instead.

**The channel picker**, in the dialog, on Change channel and on a repo's Settings (below), lists the workspace's
channels that are not archived (`GET /api/console-settings/slack/channels?q=`, Slack's `conversations.list` with
`public_channel,private_channel`), the bot's first, searchable by name, each saying whether the bot is in it. Like the
member search on People, it reads at most two pages of 1,000 and keeps the list a minute, searching it in the console
(`slack: channel list read`). In the dialog, before the token is saved, it lists with the pasted one (`POST` with
`{"q", "botToken"}`: a token never goes in a URL). It needs the `channels:read` and `groups:read` scopes, which the
manifest asks for. **An app made before them has neither**: Slack answers `missing_scope`, and the picker falls back
to the channel's ID (`C…`, at the bottom of the channel's About tab), with a note to add the two scopes on the app's
OAuth & Permissions page, reinstall it, and Replace keys with its token if Slack issued a new one.

### The decision brief

Approved and green is not yet sent. The post and its brief go out together,
once all of these hold on the head commit:

- The approval's grace period is over: 5 minutes after the session was told of
  the APPROVE, so it reads the review's notes first. With no `review`, there is none.
- The `qa` check finished, with any conclusion (not one whose title starts with
  `Waiting`, as a QA workflow may post before an approval). A pull request
  without the `qa` label never runs QA, so it does not wait. One whose QA has not
  finished 30 minutes after it was first seen approved and green (a number on
  the Console settings page) goes out with `QA: not run`. With no `qa`, the brief
  says `QA not run (not configured)`.

It leads with what to do, then what to look at, in short sections a blank line
apart (`console/decisionBrief.mjs`):

```
Add GTM - https://github.com/…/pull/7 - 🟡 Medium risk     ← the post
  👉 Please confirm before merging                          ← its thread

  Decisions
  • Kept the 30 s timeout rather than 60 s
  • Named the route `shared`

  Risks
  • Public routes added without login

  QA ✅ 5/5 passed · Full brief →
  @assignee this one is yours to decide.
```

A decision or a risk shows only its headline in Slack: its bold lead, or else
its first sentence, whole, without the `path:line` references it opens with
(the PR comment keeps those). With no decisions in the PR body the Decisions section is
left out.

Every part is quoted from what others posted, never worked out by the console;
a signal that is missing is said to be missing:

- **Merge risk** is the title of the `mergeRisk` check the review's workflow
  posts, `Low|Medium|High: <reason>`. Any
  workflow can post a check by that name, so it counts only when it is on the
  pull request's head commit, from GitHub Actions' app, and the run it links is
  one GitHub says is the `review.workflow` on that same commit. GitHub points
  the `details_url` of a check posted with `GITHUB_TOKEN` at the check itself,
  so the run is read from the summary's `Set by the AI review ([run](…))` (one
  `actions/runs/<id>` read), so a link to another pull request's review does
  not pass. An older commit's tier does not count. Without one, as on a pull
  request reviewed before the check existed, the line is
  `⚪ Risk not posted` on the post and the session's own `Risk:` line from the
  PR body in the thread (`Self-assessed risk`), which `prompt.md` asks for. A
  repo with no `mergeRisk` gets no risk tag on the post, and no merge risk
  section in the brief.
- **QA** is the `qa` check's own verdict and counts, and the first
  thing its PR comment (by `qa.author`, starting with `qa.heading`) lists as untested.
- **Risk areas** are the review comment's `What you accept by merging`, then its
  `Not tested: check before merging` as `Not tested: …`, each by the one line of
  its folded item (or a repo's own review's
  `Risk areas to eyeball manually`), from `review.commentAuthor`'s comment that folds
  the review under the heading's words, from the run whose review approved.
- **Decisions** are the PR body's `## Decisions`, those naming a file a risk
  area names first.
- **The ask**, first, is `Can be merged without further review!` only when
  Merge risk is Low, QA passed and every check on the head commit is green;
  otherwise `Please confirm before merging`, or `Please look before merging`
  with no decisions listed. It is a suggestion: nothing merges by itself.

The reply in the thread is best effort: a brief Slack refuses leaves the post
as it is, and the post is not made again (`slack: decision brief not replied`).
Slack lists every risk area and decision, each as its headline.
The full brief is one PR comment, headed `## 🧭 Decision brief`: every
decision, a link to the body's `## Proof`, QA's covered and not covered, every
risk area and the Merge risk reasons. The console edits the comment it left
before rather than adding another, and the Slack brief links to it. The
session's assignee is mentioned in the post's thread after it, with no direct
message: the thread is enough, and a DM is kept for a decision the session is
waiting on ("Messages to the assignee")
(`<@member> this one is yours to decide.`, as plain `text`, since Slack
documents mentions for it and not for `markdown_text`). An unassigned session,
an assignee with no Slack link, or a private session gets the channel only.

Text quoted from GitHub is made plain as the assignee messages make titles
plain: angle brackets become look-alikes, `](` is split and `@` gets a
zero-width space, so nothing in it can become a Slack link or mention. The PR
comment puts the same space after each `@`, so a quote notifies nobody.

To turn it on, use the Slack card's Set up Slack (above), and invite the bot to the channel (`/invite @<bot>`). The
channel is kept in `state.json` (`settings.slackChannel`), and none turns the posts off. A repo can have a channel of
its own on its Settings page (below). The token and the channel are read for each post, so neither needs a restart.

### A channel for each project

A project can have a channel of its own: the **Slack** card on its repo's
Settings page (Console settings → Repos → **Settings**,
`/console-settings/repos/<project>#slack`), for the installation's repos and the ones
added there alike. The Repos card's row says where its pull requests go
(`PRs to C…`, or the console's channel) and links there. The card says what
the channel is for and where the next post goes, and Clear sends the repo's
pull requests back to the console's channel; with no Slack (no secret store)
it says so and its field is off. It reads the channel with the page's view
(`slack`: `channel`, `consoleChannel`, `canPost`) and saves it with
`POST /api/console-settings/projects/slack-channel` with
`{"name", "channel"}` (admins only, checked as the Slack card's channel is: a
channel ID, never a name). It is kept in `state.json` under
`settings.projectSlackChannels`, by project name, and removing an added repo
drops it. A project's pull requests and their decision briefs go to its own
channel when it has one, and to the Slack card's channel otherwise. Its channel is picked with the same channel
picker as the Slack card's, falling back to the ID where the app lacks `channels:read` and `groups:read`. A project
with neither has its pull requests left untracked, as every pull request was
with no channel, and tracked once a channel is set; one tracked before its
channel was cleared is still read, so it is dropped when it closes, and waits
for a channel until it gives up (`slack: ready, but its project has no channel
now`, then `no Slack channel`). The channel is
chosen once for each post, just before it, so the brief and the mention land
in that post's thread, and where the post went is kept on the session
(`slackPost`: its `channel` and `ts`), so a later change to the setting moves
only the posts after it. The console logs `slack: pull request channel chosen`
with the `project` and `channel: 'project'` or `'console'` for each post, and
`slack: project channel changed` with who changed it. Invite the bot to each
channel. Questions from Slack are not part of this: they are answered in the
thread they were asked in, on the default project.

## Who is who on Slack

The console messages people directly (below, "Messages to the assignee"), so
it keeps which Slack user each GitHub handle is, in `state.json` under
`slackAccounts` (`console/slackPeople.mjs`). It is apart from the per-person
settings, so Remove My Woodshed keeps it.

- **Automatically.** When someone signs in, the console looks their email up on
  Slack (`users.lookupByEmail`): the verified emails GitHub lets it read, else
  the public one on their profile. At most once a day for each person. Most
  accounts use the team's own email domain; anyone else, or anyone whose email
  is private, is linked by hand. A bot or a deactivated
  account counts as no match. Only members are matched. A missing scope or no match leaves the person
  "Not linked" and never stops the sign-in.
- **By hand.** On the People page an admin can link or change anyone's Slack
  user with a member ID (a Slack profile's "Copy member ID") or an `@handle`,
  checked with Slack. A link set by hand is never overwritten by the automatic
  match; saving it empty takes it away.
- **GitHub's side.** To read the verified emails the GitHub App needs the
  **Email addresses** account permission, read-only (the App's settings,
  Permissions & events, Account permissions). Without it the console can only
  use the email a person made public on their profile, and the rest are linked
  by hand. Each person may be asked to accept the new permission when they next
  sign in.
- **To turn it on,** add the `users:read.email` bot scope: the Slack app's
  **OAuth & Permissions** page, Bot Token Scopes, then **Reinstall to
  Workspace** (Slack shows the banner once a scope is added). Reinstalling keeps
  the bot token's value unless Slack issues a new one: Replace keys on the Slack
  card with the page's Bot User OAuth Token if it changed. Without the scope, the console logs `slack: call refused` with
  `missing_scope` for `users.lookupByEmail` and people stay "Not linked".

For code that needs a person's Slack user, `slackUserFor(login)` on
`createSlackPeople` gives the ID, or null.

## Messages to the assignee

The person a shared session is assigned to gets a direct message from the bot
(`console/assigneePings.mjs`), at three moments only, all needing them before the
pull request can be done:

- **Needs you:** the session stopped to ask something (claude's state turned
  `needs-you`). Once each time it starts asking: a session still asking on the
  next read is not messaged again, and finishing a turn is not a question.
- **Needs a human:** the session left a comment that opens with
  `Needs a human:` on its issue or pull request, as its prompt and the review
  and CI feedback ask when it cannot go on (`session/readyGate.mjs` asks for one
  when a change cannot be proven in the session). The webhooks handler (the
  Lambda, or the local provider's receiver) passes on each such comment with
  its author, and the console keeps only one from its own App, `<slug>[bot]`
  as GitHub names it (`console/appIdentity.mjs`), since that is how a session
  comments and anyone could type the words. It messages the assignee once for
  each comment, with its link. The console's own comment for a pull request that gave up is not
  one: that has its own message, below.
- **Its pull request gave up:** it was not approved with green checks in time,
  so it was not posted to the channel. The message says the review verdict and
  the suite, as the GitHub comment the console leaves there does.

A pull request that is ready is not one of them: its brief and the mention are
in the thread of its channel post ("The decision brief", above).

Each message has the session's link. An assignee with no Slack link on People,
an unassigned session and a private one get nothing new: the console logs
`pings: skipped, the assignee has no Slack link` and posts nothing to the
channel. The message goes by `chat.postMessage` to the member ID, which needs
only the `chat:write` scope the channel posts use; it lands in the bot's own
conversation with the person, so the Slack app's **App Home** page needs
**Messages Tab** on for people to read it there.

## Questions from Slack

Mention the bot in any channel it is in, with a question after the mention.
Any full member of the workspace in that channel can ask; there is no
write-access check, since an ask session changes nothing. The console looks each
asker up with `users.info` and refuses, in the thread, a guest, a bot, a
deactivated account, someone from another organization in a shared channel, and
anyone Slack will not say anything about.

1. The Lambda's `/slack` path checks Slack's signature (the
   `slack-signing-secret`, and a timestamp under five minutes old) and queues the
   mention. A bot's message, an edit, or someone from another workspace in a
   shared channel is dropped there.
2. The console (`console/asks.mjs`) adds 👀, replies in the thread with a link
   to the session, and starts an **ask** session: kind `ask`, shared like
   GitHub's, on the team key. It takes none of the shared slots: up to 3 run at
   once, apart from them ("Questions running at once" on the Console settings
   page).
3. The session checks out the default branch detached, with no databases, no Redis and no
   app. Its GitHub token reads only (contents, pull requests and issues), and
   it gets no repo settings, and the install secrets are unset before claude starts.
   `session/ask.md` tells claude to read the code, link each claim to it at the
   commit it read, and post the answer with `session/answer.sh`, which goes
   through the session API's `POST /answer` to the thread. When the person who mentioned it asked for an issue in that
   message, it searches for an open one first, then runs `session/issue.sh`, which goes through `POST /issues`: the
   console opens the issue with its App (the session's token never writes). Only for someone linked on People whose GitHub login writes to that repo, only on the console's own repos,
   labels the repo already has. The console posts the issue's link in the thread; a refusal's reason is told to the session.
4. Another mention in the same thread is typed into that session, or resumes it
   with its conversation once it has stopped. A mention in a new thread is a new
   question.
5. It stops after 5 minutes without working, so soon after it answers, or 2
   hours in all. Both are under the Slack card's Questions row, behind Limits,
   apart from the shared sessions' limits. One that failed, or stopped
   before posting any answer, says so in the thread. A stopped one is kept 7 days
   for follow-ups (the "no pull request" number on the Console settings page).

A follow-up has to mention the bot too: the app reads mentions only
(`app_mention`), not every message in a channel.

To turn it on, on the same Slack app as the pull request posts: Set up Slack on the Slack card (above, "Setting it up:
the Slack card"). An app made from its manifest already has the scopes (`app_mentions:read`, `channels:history`, `chat:write`,
`reactions:write`, `users:read` and `users:read.email` for questions) and Event Subscriptions with this console's
Request URL (on AWS, the `slack_events_url` Terraform output; Slack checks it at once) and the bot event
`app_mention`; paste its **Signing Secret** in the dialog's third step. An app made by hand needs the same, then
Replace keys with its signing secret. Invite the bot to the channels where people should ask.

## QA sessions

A project whose file says `pullRequests.qa.runner: woodshed` runs its QA here rather than in its CI
(docs/reference.md, "QA in a Woodshed session"):

1. The webhooks pass every label on a pull request to the fleet (`handleQaLabel`), which reads the project file from
   the default branch and drops any label that is not its QA label, without an entry in the events log.
2. The person who added it needs write access and sessions from GitHub, as for the console's own label. A QA session
   already running on the pull request, or a closed pull request, starts nothing. With a review gate, a pull request
   whose head the review has not approved gets a neutral `Waiting` QA check instead, and a submitted review
   (`qaAfterReview`, from the webhooks' `review submitted`) starts QA on a labelled pull request once the review
   approves its head, as whoever added the label (the issue events' last `labeled`), once for each commit.
   With `qa.autoLabel` the console adds the label itself when a same-repo pull request opens or is marked ready
   (`qaAutoLabel`); a label its own App added stands for the pull request's author, on the team key when the author
   fails the checks above. When the author is the console's own App (a pull request one of its sessions opened), the
   review and QA stand for the person who started that session instead, so they run on that person's plan
   (`fleet: pull request opened by a session, run as its starter`).
3. The fleet starts a `pr` session with a `qa` field (base branch, head commit, heading, comment): `SESSION_MODE=qa`,
   `PR` and `QA_BASE` in its environment, its own databases, and the read-only GitHub token an ask session gets. It
   posts the QA comment saying it is running.
4. `session/qa.sh` runs in the session's terminal, and statusd reports the session working until it is done. Its
   tests drive Playwright's MCP with `recordVideo` on, behind `session/qaBrowser.mjs`, which closes the browser when
   claude ends so Playwright writes each page's video whole. Once the browser's processes are gone it sends each video (up to 5, 25 MB each,
   WebM only, one at a time) to `POST /qa-video` and a still from the first one's last second (Playwright's own ffmpeg,
   PNG) to `POST /qa-poster`, which the fleet keeps through `qaRecordings.mjs` (`qaVideo`, `qaPoster`) for 14 days,
   then the verdict, the report, the commit it tested and the cost to `POST /qa-report` (`qaSessions.mjs` checks it),
   once.
5. The fleet writes the report into the QA comment, with the still linking to the first video at `/qa/<session id>/video/1` and a link to each, posts the QA check on the commit tested with the verdict and the
   report (the decision brief reads the report from there, since sessions can comment as the App but not post a
   check), and stops the session with `QA finished: <verdict>`. It pushes nothing and is not kept, so its databases go
   at the next sweep.

## Console settings

The Settings page (`/console-settings`, first under Console in the avatar
menu; its General tab, beside the Secrets & webhooks tab) holds the numbers above. Only an admin can
open it and change them. It is groups of rows that open in place, as My settings is (`public/settingsRows.js`,
designSystem/components/SettingsRows): **This console** (Woodshed, GitHub webhooks), **Repos**, **Shared sessions**,
**Kept sessions** (Retention, Sessions holding data), **Slack** and **MCP servers**. A closed row says what it is set
to and its status word, several may be open at once, and a link or the search that names a row opens it
(`/console-settings#card-retention`; `#card-projects` opens on Add a repo, and the older `#slack` and `#webhooks`
still land on theirs). Each row of numbers saves its own values together with its Save
button, sending only the ones that changed, with no typed confirm since changing a value back undoes it (the typed
confirm is kept for what cannot be undone: Stalled's fixes below, secrets, a
restore), and the server refuses a value out of its range, keeping none of that
save's. Its closed row says **Defaults**, **Changed**, or **Not saved** while a typed number waits for its Save:

| Row | Setting | Range | Default |
| --- | --- | --- | --- |
| Shared sessions, Running at once | Shared sessions running at once | 1 to 20 | `WOODSHED_MAX_SESSIONS`, 5 |
| Shared sessions, Running at once | My Woodshed sessions per person | 1 to 10 | 3 |
| Shared sessions, Timeouts | Pause a session waiting for input after | 0.25 to 24 hours | `WOODSHED_IDLE_HOURS`, 1 |
| Shared sessions, Timeouts | Stop a working session after | 1 to 24 hours | `WOODSHED_LIFETIME_HOURS`, 8 |
| Retention | Delete a merged or closed session after | 0 to 30 days | 3 |
| Retention | Delete a finished session whose PR stays open after | 1 to 90 days | 14 |
| Retention | Delete a paused session with no pull request after | 1 to 60 days | 7 |
| Retention | Remove a stopped session that saw production data after | 1 to 168 hours | `WOODSHED_PROD_MCP_REMOVE_AFTER_HOURS`, 24 |
| Slack, Pull requests' Limits | Stop waiting for the review and the suite after | 1 to 30 days | 7 |
| Slack, Pull requests' Limits | Wait for the QA check before the brief for at most | 0 to 180 minutes | 30 |
| Slack, Pull requests | Channel | picked from the channel picker (a channel ID where the app cannot list them), or none for no posts; a project with its own channel on its repo's Settings posts there instead | none |
| Slack, Questions' Limits | Questions running at once | 1 to 10 | 3 |
| Slack, Questions' Limits | Stop a question's session when idle for | 1 to 120 minutes | 5 |
| Slack, Questions' Limits | Stop a question's session after | 0.5 to 8 hours | 2 |

The two Sessions limits can be changed for one session alone, on its ⋯ menu's **Pause and stop…**, by whoever has it:
a shared session's assignee (an unassigned one is taken first) or a private session's owner. Anyone else is refused
with 403 (`POST /api/sessions/<id>/limits`, in the same ranges; an empty field goes back to its owner's from My
settings, then the console's). In a session's last 15 minutes before it pauses or stops by itself, its rail card and
pane bar offer **Extend** to that same person, which puts that an hour later each press (`POST
/api/sessions/<id>/extend`); a resume forgets it. The console logs `fleet: session extended` with `why` (`idle` or `lifetime`) and `until`, and `fleet:
session limits changed` with who changed them. A question from Slack has neither.

Slack's limits are in its Pull requests and Questions rows, under Limits, once Slack is set up (above, "Setting it
up: the Slack card"); each saves its own values, as a row of numbers does.

They live in `state.json` under `settings`, and the console reads them each
time it uses one, so a change applies on its next tick with no restart. The
environment values are what a setting is until someone changes it.

The **MCP servers** group, last, has a row for each server sessions get ("MCP servers"
above, under the Anthropic proxy). A server's row opens on its form, with **Save**, **Test** and **Remove**: there is
no Edit button, and closing the row drops what was typed. **Add a server** is the group's last row. A server the
installation's configuration sets is a line with Test alone. Each change applies at once, with no typed confirm, and is logged with who made it.
A header's value is a password field, sent once and never shown again. Where the console cannot lock a session down
the card says why and offers no Production kind.

The **Woodshed** row, first on the page under This console, follows the git clone the console runs from (`console/woodshedUpdate.mjs`;
`WOODSHED_CHECKOUT` names another): at start and every hour, and on **Check now** (`POST
/api/console-settings/updates/check`), it runs `git fetch` on the remote of the branch the clone tracks, and lists the
commits `HEAD` lacks, newest first (30, then how many more), with the count beside Console settings in the avatar menu
and a dot on the avatar, for admins only (`updates` in `/api/me`). **Update to latest** (`POST
/api/console-settings/updates/update`, no typed confirm) is refused while the last check's fetch failed, or while the
clone has commits the branch lacks, and otherwise runs as a checklist on the card: **Pull the new commits**
(`git merge --ff-only`, stopped when tracked files are edited), **Check the new code starts** (the new
`providers/console.mjs` with `WOODSHED_START_CHECK=1`, which loads every module, reads the console's settings and
makes its provider, then exits without listening; 60 seconds at most), **Build the
session image** (only when `session/` or `shared/` changed and sessions run in docker: the new clone's `install.sh` with
`WOODSHED_BUILD_ONLY=1`, `WOODSHED_IMAGE` set to the console's own, `WOODSHED_REPO` the environment's default project's (none on a console that started with no repo, which builds the image with no checkout again: an added repo is never in the image) and the
App's token as `GH_TOKEN`; its output goes to `woodshed-update.log` in the state folder and its last lines to the page),
then **Restart the console**, which exits with code 75 for its supervisor (`supervisorOf`, as the GitHub App setup's
Restart). A failed step puts the clone back on the commit it was on (`git reset --keep`), so the console runs as it
did. New code that passes the start check and still fails after the restart leaves nothing answering: after two
minutes the page says so, with the `git -C <clone> reset --keep <from>` that goes back. Without a supervisor the card shows the commands instead of the button; with no clone (the AWS console image), or
where the program embedding the console passed `woodshedUpdate: false` ("Embedding the console"),
`/api/console-settings/updates` answers 404 and there is no card. `state.json` keeps the last update under
`woodshedUpdate` (from, to, who, when, and whether the image was built), which the card says after the restart. The
console logs `woodshedUpdate: following` with the clone, its branch and remote at start, `woodshedUpdate: checked` with
`behindBy` and `aheadBy`, `check failed`, `update started`, `updated, restarting`, and `update failed` with the step
(`pull`, `starts`, `image`) and whether it went back; the start check logs `console: start check passed`.

The **Repos** group, next, has a row for each repo sessions can start on (the projects above): closed, it says
whether the repo is the default or who added it, its sessions and where its pull requests go; opened, it has its
colour, the link to its own settings page and Remove. **Add a repo**, the group's last row, is a list of the repos the GitHub App may reach and that are not projects yet
(`GET /api/console-settings/projects/repos`: each of the App's installations, `GET /app/installations`, then its repos,
`GET /installation/repositories` with a token narrowed to reading metadata), with an optional name; **Add repo** sends
the pick (`POST /api/console-settings/projects`). Under it, *Not listed?* links each installation's settings on GitHub,
where the repos it may reach are picked (Repository access), and the App's install page for another account; the list
is read again on **List again** and when the tab comes back into view. On a console with no App that runs on its `gh` login (one person's own machine),
the list is every repo that login can push to (`gh api user/repos`, `ghRepoLister`), since sessions push with it, and the
console logs `projects: repos listed` with `via: 'gh'`. With borrowed GitHub access, or when GitHub did not list them,
the field takes `owner/name` typed in (a `github.com`
link works too). The list's last option, **Another repo**, swaps it for that field too (**Choose from the list** goes
back), for a repo the list does not have: the console then checks it as below and says where to give the App access. The console logs `projects: repos listed` with how many, or `projects: repos not listed` with GitHub's error; an installation whose repos GitHub refused is left out, with `projects: an installation's repos not listed`.
Add repo, Remove and a row's Slack channel Save apply on the click, with no typed confirm, since each is undone by doing the other. The console checks the repo first: with the GitHub App it must be able to reach
it (`GET /repos/<repo>/installation`, as the App), and the installation's number is kept with the project when it is not
the console's own. A repo on an account the App is installed on, but not given, is refused with a link to that
installation's settings, to give the App access to it; a repo on an account without the App, with a link to the App's
install page (`https://github.com/apps/<slug>/installations/new`, the slug read from GitHub); on a console with no App (the local provider) `gh` must be able to read it. A repo already a
project, or a name in use, is refused with its reason. The added repos are kept in `state.json` under `addedProjects`
and appended to `WOODSHED_PROJECTS`'s list in the live config (`liveConfig`), so one applies at once, with no
restart, and a project's New session **Project** field shows it to whoever can write to it. On a console that started
with no repo the card says so, and the first repo added is the default (`liveConfig`), until it is removed and the next
one takes its place. No session image holds an added default's checkout, so `liveConfig` marks it `clonedAtStart` and its sessions get `PROJECT_REPO` and clone it at start, like any added repo's (`fleet.mjs`); on the local provider a refusal for its databases names the install that hosts them (`WOODSHED_REPO=<repo> bash install.sh`, `databaseGate.mjs`'s `fix`); until then New session's setup card lists **Add a repo** (`repoNeeded` in `/api/my`), and a start
is refused with `Not started: the console has no repo yet` (`fleet: session refused, the console has no repo yet`).
**Remove**
(`POST /api/console-settings/projects/remove`) takes an added repo off, and is disabled while a session is running on it
or listed to resume (a shared one kept, or any of a person's My Woodshed sessions still on their list), since that session would fall back to the default project's repo. The installation's own projects,
the default among them, are read-only here: they change where `WOODSHED_PROJECTS` is set. Each row, theirs too, has a
Slack channel field for that repo's pull requests ("A channel for each project" under Slack). An added repo is on the
same terms as any other project: My Woodshed sessions, and labels and `/woodshed` comments on its issues (a webhook about
it is no longer dropped), in the default project's session image and databases, with Slack questions staying on the
default project. Its own project file's databases are checked on their own: a repo whose file needs an engine the
installation does not host shows Needs setup on its row, with why and the fix, and Ready otherwise. The
console logs `projects: repo added` and `projects: repo removed` with who did it, and `projects: installation not read`
when GitHub did not answer.

In a console embedded with a `repos` hook (below, "Embedding the console"), the program keeps the list: Add a repo
offers the program's list with its links to give access, **Add repo** and **Remove** go to it (`via: 'host'` in
`projects: repo added` and `removed`), and nothing is written to `addedProjects`. Every project is the program's, and any
but the default can be removed here, on the same terms as above; one added on this page before the program kept the
list stays in `addedProjects` and is removed from it. A program that names each repo itself (`names: false`) gets no
name field. The change applies to the installation at once, until the program builds it again from its own list; the
program's refusal is shown under the field with its link, and a failure that is not a refusal answers `The change failed;
the console log says why`.

`woodshed repo` uses `GET /api/cli/repos` to list, `POST /api/cli/repos` with `{repo, name?}` to add, and
`POST /api/cli/repos/remove` with `{repo}` to remove. Each authenticates the `wsc_` token and refuses any `Origin`
header. The add and remove go through the same project code as the Repos card, including the hosting program's `repos`
hook and the usual settings cleanup on remove. Hosted CLI requests check current membership and role when the host
supplies the `members` hook. Hosted changes require a verified owner role. Other signed-in members see only the
repos they can start sessions on.

Each repo on the card has a row of six colours, its colour on the rail (`public/projectColors.cjs` holds the palette and
the rule, for the server and the pages alike). A pick is saved at once (`POST /api/console-settings/projects/color`,
`{"name", "color"}`), checked against the palette, and refused when another repo has that colour, whose swatch is
disabled. A repo nobody picked a colour for, the installation's own as well as an added one, takes the first colour no
repo has, in the order the repos are listed; a pick pins every repo's colour as it shows then, so the one freed does
not move to another. Past six repos the rest have no colour. The picks are kept in `state.json` under `projectColors`,
and the console logs `projects: colour set` with the project, the colours and who set it. Removing a repo drops its
pick (`projects: colour forgotten`), so a repo added again under that name takes a free colour, not one another repo has
had since.

### Repo settings

Each repo has its own env file values and instructions, in layers (`shared/repoSettings.mjs` says how a session's files
and prompt are made of them): the repo's own (`.woodshed/project.yaml`: each env file's `defaults`, and `rules`), the
installation's (layer 2, set by admins), each person's own (layer 3, in their private sessions only) and the session's
wiring (each env file's `overrides`, the project's `env`, Woodshed's own variables), which no layer before it changes.
`console/repoSettings.mjs` keeps layers 2 and 3 in the console's secret store, one value each:

| Name | Holds |
| --- | --- |
| `repos/<project>/env/<key>` | the installation's lines for one env file of the repo |
| `repos/<project>/instructions` | the installation's instructions for the repo, at most 16 KB |
| `users/<login>/repos/<project>/env/<key>` | one person's own lines for that env file |
| `users/<login>/repos/<project>/instructions` | one person's own instructions for the repo |
| `users/<login>/repos/<project>/files` | one person's own whole files for the repo (My settings, "Your files" above) |

`<key>` is the env file's key in the project file: its `secret`, or one made from its path (`web/.env.local` is
`web-env-local`). Env files that name one secret share its key, and so one value a layer, written to each of their
paths (`api/.env` and `worker/.env` both from `app-env`). A value is at most 64 KB, and is kept only for an env file the repo's project file names (on its
default branch). Instructions that look like a credential (an Anthropic, OpenAI, GitHub, Slack or AWS key, a private
key) are refused: they go into the session's prompt. `state.json` keeps, under `repoSettings.<project>` and
`people.<login>.repos.<project>`, when each was saved, by whom, its size and the names of the keys it sets, never a
value; a record whose secret is gone reads as none and is dropped (`repoSettings: record dropped, its secret is gone`).
On AWS the base box's role makes, reads and deletes `<prefix>/repos/*` itself (`PeoplesAndSessionsOwnSecrets` in
`providers/aws/terraform/baseBox.tf`), so a new env file needs no Terraform.

An admin sets layer 2 on the repo's own page, `/console-settings/repos/<project>` (public/repoSettings.js), which the
**Settings** link on its row of Console settings' Repos card opens. It is groups of rows that open in place, as My
settings is (public/settingsRows.js): **Env files**, **Prompt**, **Sessions from GitHub** and **Slack**; a closed row says
what it holds, and several may be open at once. Each env file of the project file is a row, which says how many keys this
installation sets for it; `?file=<key>` opens one. Open, it shows its key, the repo's `defaults` (read only, with a link to the file on
GitHub), the installation's values (hidden until **Show and edit**, since reading them is logged), the keys the session
sets itself, and a table of which layer wins each key: key names only, never a value. Env files that name one secret
are one row, `app-env → api/.env, worker/.env`, with a note that the values are written to both files; each file's
defaults and overrides are shown under its path where they differ, and the table has a row a file (`LOG_LEVEL in api/.env`)
for a key the files do not agree on. Then the installation's
Instructions, read when their row opens, with the 16 KB count as they are typed; a save that looks like a credential is
refused under the field.
A key saved for an env file the project file no longer names is a row marked **Unused** with **Delete**, which removes everyone's values
for it after a typed confirm. A project file with no env files gets a short how-to in their place: an `envFiles` entry with a `path`
(and `defaults` if any) in a pull request, no `secret` needed, and a row here once it is on the default branch. Then
**Sessions from GitHub**: the label's and the `/woodshed` comments' switches on their rows, and the label's name in a row
that opens (`#github` opens it). Last, the **Slack** group's Pull request channel row ("A channel for each project",
above; `#slack` opens it). The page loads for anyone signed
in; its calls answer 403 to anyone but an admin, and it says so.

Each person sets layer 3 on My settings' repo rows, under **Repos and files** (public/myRepoSettings.js, with the layers drawn by
public/repoLayers.js, which the admin page shares), for each repo they can write to: see "My Woodshed" above. Env
files that share a key are one tab there too (`app-env → api/.env, worker/.env`), and a person's values are written to
each of them.

Repo settings are the only place an env file's values are set: no secret on Secrets & webhooks, Terraform or the task
definition holds them. A value saved by the old start-time copy from a Terraform secret says `copied from Terraform` in
place of who saved it.

The JSON API:

| Route | Who | Answers |
| --- | --- | --- |
| `GET /api/console-settings/repos/<project>` | admins | the project file's env files, one a key (key, `paths`, and `files`: each path's defaults and wiring, `overrides`, `optional`, `env`; `path`, `defaults` and `wiring` are the first path's), each layer's records, `table` (each key, the layers that set it and the one that `wins`, one row for all the paths where they agree, else one a path with its `path`), `unnamed` (keys saved that the file no longer names), the instructions' records |
| `GET`, `POST /api/console-settings/repos/<project>/env/<key>` | admins | `{"text"}`, the installation's values; a POST of `{"text": ""}` clears them |
| `POST /api/console-settings/repos/<project>/env/<key>/remove` | admins | deletes the installation's and everyone's values for a key the project file no longer names |
| `GET`, `POST /api/console-settings/repos/<project>/instructions` | admins | `{"text"}` |
| `GET /api/my/repos` | everyone | the repos you can write to, each with the keys and instructions you keep for it, and `defaultProject`, the person's default |
| `GET /api/my/repos/<project>` | writers | the admin view, plus your own records (`personal`) |
| `GET`, `POST /api/my/repos/<project>/env/<key>` | writers | `{"text": yours, "installation": the installation's or null}`; a POST saves yours |
| `GET`, `POST /api/my/repos/<project>/instructions` | writers | the same, for the instructions |

Every `/api/my/repos/<project>` route answers 403 to someone who cannot start sessions on the repo (New session's check,
`projectAccess.mjs`), logged `repoSettings: refused, cannot write to the repo`: they keep nothing for it and read
nothing of it. Nobody reads another person's layer, admins included. A write needs the console's origin and
`x-woodshed: 1`, as every write does. The console logs `repoSettings: installation values saved` (`project`, `key`,
`by`, `bytes`, `keys`), `own values saved` (`project`, `key`, `login`, `bytes`), `instructions saved` (`layer`,
`project`, `by`, `bytes`), their `cleared` lines, and `installation values shown` with who read them and where: key
names, sizes and logins, never a value.

A session is handed its own project's values by the session API's `POST /repo-settings`, chosen by its token and never
by what it asks for: `{"project", "envFiles": {"<key>": {"installation", "personal"}}, "instructions": {"installation",
"personal"}, "personalFor"}`, every key the console keeps for the project (null where a layer has none). `personal` is
filled only in a private session, from its owner's names; a shared or QA session gets the installation's alone, an ask session
404, and 503 while the store does not answer. The console logs `repoSettings: handed out` with the session, the project,
the keys each layer gave and whether each has instructions. The session writes them into its env files and rules
(session/README.md, "What a container does").

The database template's seed (`session/dbAdmin.mjs`, `seedEnvFiles`) writes the env files its databases name from the
default project's installation values the same way, layers 1, 2 and 4 (no one's own lines: the seed is no one's). It
reads them itself, as
`repos/<project>/env/<key>` for the project its entryPoint's `--project` names, never a name a run gives; on AWS its task
role may read that project's `repos/<project>/env/*` and no other repo's (`TheSeedsEnvFiles` in
`providers/aws/terraform/ecs.tf`). A key that two env files name (they share a secret) is read once and written to
both. Its log says `Seed env files read` with where each key came from (`repo settings` or `none`) and the paths that
name it, never a value.

**Remove** on the Repos card deletes the repo's installation values and every person's own for it
(`repoSettings: repo forgotten`, with how many), and **Remove My Woodshed** deletes the person's for every repo.

Below the cards, **Sessions holding data** lists, checked again every minute:
- **Stalled**, each with why and its fix behind a typed confirm: a shared
  session stuck starting or stopping for 20 minutes (**Stop it**, **Finish the
  stop**: the task is stopped and the session kept, without the last push);
  databases whose session is deleted but whose drop failed (**Drop again**);
  databases no session has (**Drop**); and a saved conversation no kept
  session has (**Delete**), found by listing `_sessions/` in the homes bucket.
- **Kept**, each stopped shared session still holding its conversation and
  databases: why it stopped, its database name, whether a conversation is
  saved, and when it will be deleted, with **Resume** and **Delete now**.
- The total: database copies on RDS and Mongo, and saved conversations with
  their size in S3 (on the local provider: on Postgres and Mongo, and in the
  homes folder).

My Woodshed sessions never show there, nor the homes they keep under
`<login>/sessions/`: those go only with the session's Remove, Forget it or
Remove My Woodshed.

## Settings

| Variable | Default | |
| --- | --- | --- |
| `WOODSHED_HOST`, `WOODSHED_PORT` | `127.0.0.1`, `7690` | |
| `WOODSHED_CONSOLE_NAME` | `Woodshed` | What the console calls itself: the pages' title, the sign-in page's heading, the installed app's name (the manifest and the Apple title) and the console's GitHub comments. 1 to 40 printable characters, trimmed, without `< > " '` or a backtick; any other value gives the default, with a warning once. Set on the base box from Terraform's `console_name`. An installed app keeps the name it was installed with until it is installed again |
| `WOODSHED_RUNS_ON_NAME` | none | Which of the consoles that act as one GitHub App this is, for a project file's `pullRequests.runsOn: <app login>/<name>` ("Which console does the automatic work"). Lowercase letters, digits and dashes, at most 63; anything else stops the console at start |
| `WOODSHED_PUBLIC_URL` | `http://localhost:<port>` | The base of the link posted on GitHub; its host is accepted |
| `WOODSHED_HOSTS` | none | More names to accept, comma-separated |
| `WOODSHED_APP_DOMAIN` | none | Session apps answer at `<id>.<this>` ("Session apps"); none turns them off, unless `WOODSHED_APP_PORTS` is set |
| `WOODSHED_APP_PORTS` | none | On one person's console only (loopback, no sign-in): ports such as `7701-7710` the console also listens on, each lent to one session's app, which answers at `<public URL's name>:<port>` (`appPorts.mjs`, "Session apps on ports"). Not beside `WOODSHED_APP_DOMAIN`. The installer sets it with `WOODSHED_TAILSCALE=1` |
| `WOODSHED_TLS_ASK_PORT` | none | A port on `127.0.0.1` where a reverse proxy asks before getting a certificate on demand: `GET /tls-ask?domain=<name>` answers 200 for the public URL's host, `WOODSHED_HOSTS` and a session's app name, 403 otherwise (`tlsAsk.mjs`). For a console with no wildcard certificate; `providers/local/README.md` has the Caddyfile |
| `WOODSHED_ONE_PERSON` | tells by itself | `1`: one person uses this console, so the rail shows one list of every session with no Mine \| Everyone switch; `0`: always the two views. Unset, a console nobody signs in to or with one member on People is one person's. Hosted mode has no People list, so its host sets it. See "Hosted mode" |
| `WOODSHED_LOCAL_LOGIN` | `local` | The handle a local console with no sign-in gives the person using it, so My settings (their Claude token, private sessions) works there. Ignored with a GitHub App or on AWS |
| `WOODSHED_REQUIRE_SIGN_IN` | off | `1` requires GitHub sign-in on every route from the start, with or without a client secret. Set on the base box |
| `WOODSHED_TRUSTED_PROXIES` | loopback (`127.0.0.0/8, ::1`) | The proxies whose `X-Forwarded-For` names a request's client, for limits kept per client (the command line's waiting sign-ins, "Sign-in"): addresses or CIDR ranges, comma-separated, replacing loopback, which must then be listed itself if it is still wanted; `none` trusts no proxy. A value that is not one stops the console at start (`clientAddress.mjs`). List only what reaches the console in front of everyone else: a proxy listed here can name any client |
| `WOODSHED_TRUSTED_IDENTITY_SECRET` | none | Hosted mode: the secret a trusted proxy in front of the console signs each request's `X-Woodshed-Identity` header with, at least 32 characters. Set, that header is the only sign-in, and it is required; `role: owner` is an admin. See "Hosted mode" |
| `WOODSHED_GITHUB_BROKER_URL`, `_GITHUB_BROKER_TOKEN_FILE` | none | Hosted mode: where the console asks its host for every installation token, and a file holding the bearer it asks with. Both or neither, and never with `WOODSHED_GITHUB_APP_ID`. See "Hosted mode" |
| `WOODSHED_SUPERVISED` | on under systemd, else off | `1` says something starts the console again when it exits (a container with a restart policy), so the GitHub App setup page offers Restart; `0` says nothing does, even under systemd. See "Setting up the GitHub App from the console" |
| `WOODSHED_STATE_DIR` | `/var/lib/woodshed-cloud` | Holds `state.json` (sessions, their tokens, the polling cursors) and `webhookEvents.jsonl` (the Webhook events tab) |
| `WOODSHED_REPO`, `WOODSHED_LABEL` | none (`owner/name`), `woodshed` | The one repo this installation works on, and the label of every repo that does not name its own on its settings page ("How sessions start"). Unset, with no `WOODSHED_PROJECTS`, the console starts with no repo, and the first one an admin adds on the Repos card is the default ("Sign-in" says who may sign in until then). The local provider's installer sets it only when given `WOODSHED_REPO`, and then builds the session image from it; without, the console starts with no repo, on `woodshed-session:generic`, an image with no checkout, and every session clones its repo at start |
| `WOODSHED_PROJECTS` | one project, `WOODSHED_REPO` | The repos this installation works on, as JSON: `[{"name": "app", "repo": "owner/app", "default": true}, …]`. A name is lowercase words of letters and digits joined by single dashes, at most 32 long; a project may give `installationId`, the GitHub App installation on its repo's account, when that is not `WOODSHED_GITHUB_APP_INSTALLATION_ID`'s; names and repos are each used once; with more than one project, exactly one is `default`. Unset, the one project is `WOODSHED_REPO`, named after its repo; set beside it, `WOODSHED_REPO` must be the default's repo. A session records its project's name beside its `repo`, and its GitHub token (`/github-token`) reaches that project's repo alone (`projectTokens.mjs`). A My Woodshed session can start on any project you can write to (New session's **Project**); every project runs in the default project's session image for now, and a session on another one gets `PROJECT_REPO` and clones that repo at start (`session/entrypoint.sh`, `useProjectRepo`). A label or `/woodshed` comment on another project's issue starts or reaches a shared session on that project, with its write access, reactions, comments, the issue's assignee and board, and its pull request's chip, Slack post and gates (that repo's own project file) read on its repo; a webhook about a repo that is no project's is dropped (`webhooks: message from a repo that is not a project, dropped`). New session's `/` list and the Review tab follow the session's project too. The poll (the fallback for a lost webhook) reads every project's repo too. Questions from Slack still run on the default project; each project's own file is checked for its databases. A list that is wrong stops the console with what is wrong. Repos an admin adds on the Console settings page's Repos card are appended to this list while the console runs |
| `WOODSHED_DB_ENV_SECRETS` | none | On the local provider: the keys of the env files the databases' commands read (every `envFiles` of the project file's `databases`), comma-separated; a db-admin run is given the default project's repo settings for them. `install.sh` sets it from the project file. `WOODSHED_ENV_FILES`, from before Repo settings, is read no more |
| `WOODSHED_INSTALL_SECRET_PAIRS` | none | The secrets the repo's dependency installs read, as `secret=VARIABLE` pairs (`registry-token=REGISTRY_TOKEN`): each is a secret on the Secrets page, and reaches a session in its variable as it is, with `WOODSHED_INSTALL_SECRETS` listing the variables. A variable that is one of Woodshed's own (`SESSION_VARIABLES` in `shared/reservedNames.mjs`, or `WOODSHED_*`) stops the start. Terraform sets it from `install_secrets` |
| `WOODSHED_POLL_GITHUB` | on | `0` turns polling off; sessions then start only from `start-session.mjs` |
| `WOODSHED_WEBHOOK_QUEUE` | `woodshed-cloud-webhooks` with the `ecs` launcher, else none | The webhooks queue's name or URL; `0` turns webhooks off. Set on the base box from Terraform's queue, `<name_prefix>-webhooks`; the default is for a box whose stack predates that, and goes later |
| `WOODSHED_FALLBACK_POLL_SECONDS` | `300` | How often the poll runs while webhooks arrive, and how often a pull request is read on its own while pull request webhooks arrive |
| `WOODSHED_CHECKOUT` | the console's own folder | The Woodshed git clone the Console settings page's Woodshed card follows and Update pulls. The dev console points it at a made-up one |
| `WOODSHED_ACTIONS_WORKFLOWS` | none | The avatar menu's GitHub Actions links, as `label=file.yml` pairs, comma-separated: the repo's workflows that build the images and apply the infrastructure. None leaves the group out. Set on the base box from Terraform's `console_workflow_links`. The default project's file's `workflowLinks` (docs/reference.md, "The project file") wins over it: this is read only where the file leaves that out or cannot be read, so move the links there and drop this |
| `WOODSHED_MAX_SESSIONS` | `5` | Shared sessions at once, until the Console settings page says otherwise. Set on the base box from Terraform's `max_sessions` |
| `WOODSHED_IDLE_HOURS`, `WOODSHED_LIFETIME_HOURS` | `1`, `8` | The same, for the pause and stop times |
| `WOODSHED_LAUNCHER` | `docker` | `docker` on a dev box, `ecs` in AWS |
| `WOODSHED_DATABASES`, `WOODSHED_ECS_DB_ADMIN_TASK_DEFINITION` | none | For `ecs`, both from Terraform's `databases`: the ones the installation runs, comma-separated (`postgres,mongo`, `postgres`, or empty for none), and the db-admin task's family, set only when there is one. The aws provider refuses to start without the first, or when the two disagree |
| `WOODSHED_ECS_CLUSTER`, `_ECS_TASK_DEFINITION`, `_ECS_SUBNETS`, `_ECS_SECURITY_GROUP`, `_ECS_LOG_GROUP` | none | For `ecs`; the base box bootstrap sets them from Terraform. Region from `AWS_REGION` |
| `WOODSHED_IMAGE` | `woodshed-session` | |
| `WOODSHED_SESSION_MEMORY`, `WOODSHED_SESSION_CPUS` | `6g`, `2` | Docker limits per session |
| `WOODSHED_SESSION_DOCKER` | with the `docker` launcher, every session's own Docker where the machine has Sysbox; else the machine's on one person's console (loopback, no sign-in, no hosting proxy) and none on a console others sign in to; none with `ecs` | Which Docker sessions get, so Claude can run a repo's compose services, Supabase local, Testcontainers or an image build (`../providers/local/README.md`, "Docker in a session"). Their own is a daemon inside the session's container under Sysbox's `sysbox-runc`, which reaches nothing of the machine's and goes with the session; whoever can start a session on a server is trusted with the other sessions there (`../CLAUDE.md`, Rules). The machine's is its socket, root on the machine for whoever can start a session: on a console others use, a GitHub label or comment is enough, and it reaches the secrets key and every other session, so there it takes `1`. `0` turns both off. A question from Slack never gets either, nor does a project file decide it. With `ecs`, a value only logs that a Fargate task can have neither |
| `WOODSHED_SESSION_ENV_FILE` | none | A JSON object of strings passed to every session: the shared services and secrets from the table above |
| `WOODSHED_GITHUB_APP_ID`, `_GITHUB_APP_INSTALLATION_ID`, `_GITHUB_APP_KEY_FILE` | none | The GitHub App. When set, the console mints installation tokens with the key (`githubApp.mjs`) for its own GitHub calls and for sessions, and `GH_TOKEN` is not used. With the `ecs` launcher and no key file, the key is read from `<prefix>/github-app-key`; until it has a value the console runs without GitHub |
| `WOODSHED_SECRET_PREFIX`, `WOODSHED_WEBHOOK_FUNCTION` | `woodshed-cloud/`, `woodshed-cloud-webhooks` | With the `ecs` launcher: where the Secrets page finds its secrets (and the `project` tag of those it makes), and the Lambda whose URL it sets on the GitHub App. Set on the base box from Terraform's `name_prefix`; the defaults are for a box whose stack predates that, and go later |
| `WOODSHED_LOCAL_SECRETS_DIR`, `WOODSHED_LOCAL_SECRETS_KEY_FILE` | none | On the local provider: the folder the Secrets page keeps its secrets in, one `<name>.json` each, readable by the console's user only (`providers/local/secretStore.mjs`), and the key each file is sealed with, AES-256-GCM, from a file of its own outside the folder, mode 600 (`secretKey.mjs`; `bin/secret.mjs new-key` makes one). The folder needs the key; a plain file in it is sealed at start. Each session also gets each install secret from it as it starts, unless `WOODSHED_SESSION_ENV_FILE` sets them. With the GitHub App and no key file, the App's key is read from it too. Without it, the local provider has no Secrets page |
| `WOODSHED_LOCAL_HOMES_DIR` | none | On the local provider: the folder saved Claude homes are kept in, at the same names as the S3 bucket's keys (`providers/local/homeStore.mjs`), readable by the console's user only. Without it, the local provider keeps no Claude home between sessions |
| `WOODSHED_LOCAL_DB_POSTGRES_HOST`, `_DB_POSTGRES_ROOT_USER`, `_DB_MONGO_HOST` | none | On the local provider: where each session's own databases are made, Postgres on 5432 by the first two (both or neither) and Mongo as `host:port`, each only for an engine the installation hosts, each on its own (`providers/local/postgres.yml` and `mongo.yml` run them). A db-admin run is a container of the session image (`providers/local/dbAdminRunner.mjs`); it reads the root passwords from `db-root/postgres` and `db-root/mongo` in `WOODSHED_LOCAL_SECRETS_DIR`, each for a database it runs, and sees only the database password its command makes and the env files the databases' commands read (their `envFiles`): the default project's repo settings for them, as the AWS task role does. Its flags name the default project (`--project`). A failed run's container is kept for `docker logs`, root passwords in its environment, until the next run of the same action and owner removes it. Each run's secrets are copied under `db-admin-runs/` in `WOODSHED_STATE_DIR`, which must be the same path for the docker daemon, as it is when the console runs on that machine |
| `WOODSHED_LOCAL_DOCKER_NETWORK` | none | The docker network sessions and db-admin runs join, to reach the shared services by name (`providers/local/compose.yml`'s `woodshed`) |
| `WOODSHED_LOCAL_WEBHOOK_PORT`, `_WEBHOOK_HOST`, `_WEBHOOK_URL` | none, `127.0.0.1`, none | On the local provider: where its webhook receiver listens (`providers/local/webhookReceiver.mjs`), at the Lambda's paths, `POST /github` and `POST /slack`, checked against `github-webhook-secret` and `slack-signing-secret` in `WOODSHED_LOCAL_SECRETS_DIR`, which it needs. `_WEBHOOK_URL` is the public address a proxy in front of it answers at, and the Secrets & webhooks page sets `<url>/github` on the GitHub App. A message the console fails on is tried three times; one still waiting when the console restarts is lost, and the poll finds it |
| `WOODSHED_TUNNEL_POSTGRES`, `_TUNNEL_MONGO` | none | Where `woodshed-db.mjs`'s connections go, as `host:port`, each used only for a database the installation runs. Each one is a tunnel of its own, and the script listens for those alone; without either, or without own databases, My settings has no From your computer. Without the Postgres one there is no Restore a dump for Postgres either, and without the Mongo one none for Mongo. Set on the base box, for the databases it runs: RDS and the box's private address |
| `WOODSHED_SESSION_API_HOST`, `_SESSION_API_PORT` | none, `7691` | With the App: the address the session API listens on (`sessionApi.mjs`). In AWS, the base box's private IP, which only session tasks can reach |
| `WOODSHED_PROD_MCP_URL` | none | Production debugging ("Production access" above): one production MCP server from the environment, `woodshed-prod`, such as woodshed-prod-mcp, which the console's relay at `/prod-mcp` on the session API reaches, beside those Console settings adds. Set on the base box from Terraform's `prod_mcp.url` |
| `WOODSHED_PROD_MCP_PEOPLE`, `_PROD_MCP_REPOS` | none | Whose My Woodshed sessions, on which repos, may use it: GitHub logins and `owner/name`, comma-separated, or `*` for all. Empty is nobody |
| `WOODSHED_PROD_MCP_REMOVE_AFTER_HOURS` | `24` | How long a tainted session is kept, stopped, for its Resume, before it is removed with all it kept, until Console settings' Retention card says otherwise |
| `WOODSHED_OIDC_ISSUER` | `WOODSHED_PUBLIC_URL` | The issuer the relay's signed tokens name, whose `/.well-known/jwks.json` an MCP server fetches: the console's public address, unless its documents are served from another name |
| `WOODSHED_EGRESS_PORT`, `WOODSHED_EGRESS_PROXY_URL` | `7693`, the session env's `WOODSHED_CONSOLE_URL` on that port | The egress proxy a tainted session leaves through (`egressProxy.mjs`), on the session API's address, and the URL sessions reach it at (on AWS, the base box's private address, from Terraform) |
| `WOODSHED_ECS_GUARDED_SUBNETS`, `_ECS_GUARDED_SECURITY_GROUP` | none | For `ecs` with `prod_mcp`: the network a session that may use production starts on (`../providers/aws/README.md`, "Production access"). Both or neither |
| `GH_TOKEN` | `gh auth token` | Without the App: polls, comments and reacts. Sessions push with it too unless the env file sets its own `GH_TOKEN`, and the console warns at startup when it does not: your own token reaches far more than this repo, which undoes the narrow token "Why permissions are off" in `../session/README.md` relies on |

These had an older prefix until the project became Woodshed; the old names still work and log a deprecation
(`../docs/reference.md`, "Renamed variables", which also has the two that were renamed otherwise).

Tests: `node --test woodshed/console/*.test.mjs`.
