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
A card shows the title and its tag (on Everyone, the Assigned tag is the assignee's name), then a second line with the status, a name only when the card does not already say it (`from <person>` on a shared session someone else started, on Mine, or one nobody has, on Everyone), and the PR chip at the right end. On a console with more than one project, each card's left edge is its project's colour (the name is in its tooltip), and a row of chips under the head (**All**, then each project with its colour and count) filters the rail to one project; the browser keeps the pick (`woodshed-rail-project`), and one naming a project that is gone is All. How long it ran and who started it are under its Details; the app's button and the
CPU and memory badge are in the pane bar, not on the card. **Assigned sessions.** The person who adds the `woodshed` label, or writes the first `/woodshed` comment, has the shared session
if they *Can be assigned* (a switch per member on People, off for a new member, which needs Sessions from GitHub; an admin
turns it on, see "Sign-in"). A starter who cannot be assigned leaves it unassigned. **Mine** lists your private sessions and the shared ones assigned
to you: **Needs you** (stopped sessions waiting on you), then **Active** (those waiting on you first), **Finished** (assigned shared sessions whose pull request is in Slack) and **Stopped**; **Everyone** lists every shared session with **Unassigned** at the top. **Take it** on
an unassigned card, or **Assign to me**, **Hand over to** and **Unassign** in the card's ⋯ menu, change
who has it; only someone who can be assigned can (`POST /api/sessions/<id>/assign`). A later comment from someone else does not move it, but
someone who can be assigned commenting on an unassigned session takes it. Assignment is a label, not a permission: a shared session stays visible
to everyone with Sessions from GitHub, and a private one cannot be assigned. On an issue's session the GitHub issue follows: the assignee is put on
the issue, a hand over or Unassign takes off the person the console put there, and someone GitHub already had assigned
stays (`console/issueTracking.mjs`). The console's colors, type and rail rules are written down in `console/designSystem/` (tokens, usage rules and component cards); `console/designSystem.test.mjs` fails when its colors differ from `style.css`. `/s/<id>` opens on the tab the session belongs to, with the shed's session pane: a bar
with **Agent**, **Terminal**, **Review**, **Diff** and **App log** tabs, the title, status, issue,
branch and PR, and the session's buttons. On a phone the rail is the page,
after the standalone shed's: sessions are rows with a star and ⋯ big enough for
a thumb, Shared's status filter is chips above the list, ⋯ opens as a sheet
from the bottom, and **+ New session** is a screen of its own (`/?new=1`).

**Invite an engineer**, in a private session's bar, copies `/?new=1&on=PR%20%23123` (the session's PR, or its branch
while it has none and GitHub has it). Whoever opens it signs in first (`/login?next=` keeps the address) and lands on
New session with Work on filled in, to start their own private session on their own Claude. The link holds the PR or
branch alone, so the session stays private. With nothing pushed the button says so and copies nothing.
The settings pages (My settings, Secrets & webhooks, Webhook events and
Console settings) keep the same frame: a list of them takes the rail's place,
with **‹ Back to sessions** and the avatar menu above it.
- **Agent** is claude's tmux, through ttyd on 7681.
- **Terminal** is a plain shell in the repo, beside claude, with the same
  environment. It runs in its own tmux session, `shell`, through a second ttyd
  on 7684 at `/shell/<id>/`, behind the same sign-in and owner checks as the
  Agent's.
- **Diff**, while the session runs, is what its checkout changes against its merge base with the default branch, uncommitted
  and untracked work included, as plain git diff: no analysis and no GitHub. It is read when the tab opens and on
  **Read again**, never on a timer. A file past the review parser's line caps, or past 2 MB of hunks in all, shows
  its counts only. statusd's `GET /diff`
  (`session/sessionDiff.mjs`) builds it with the review's own `worktreeDiff` and `parseUnifiedDiff`, and answers in
  the shape of `console/review.mjs`'s `shapeReview`, so the page draws it with the stopped Review tab's code. Once the
  session stops, Review shows what it pushed.
- `?tab=terminal` opens on Terminal, `?tab=review` on Review, `?tab=diff` on Diff and `?tab=applog` on App log.

Both terminals stay connected while another tab shows. A session started from an
image without the second ttyd has Terminal greyed out.

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

Under claude's terminal on the Agent tab, a phone has a message box
(`public/messageBox.js`): the phone's own keyboard, so autocorrect, dictation
and paste work, **📎** for photos and files, and **🎤** for the browser's speech
recognition (hidden where the browser has none). Files go to `/tmp/uploads` with
nothing typed (`upload?pane=none`); **Send** puts the text and their paths into
claude as one message, through statusd's `POST /send`. Return is a new line. An
unsent draft stays with its session in this tab. A terminal whose connection
dropped while the phone was in the background (ttyd's "Press ⏎ to Reconnect")
reconnects by itself once the page is in front, at most three times a minute.

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

What the page does, from the shed's own review code:
- **The diff** is the checkout against its merge base with the default branch, with
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
  analysis and the files. It can only read; changes are made in the Agent tab.

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
| `/woodshed <text>` on an issue or PR with an active session | The text is typed into claude, or held until claude is open |
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
the **Default project** card on My settings; `?project=<name>` picks one for that visit. Resume asks again, so a session on a project whose repo you can no longer write
to does not start (403). The form
asks for a prompt and, optionally:
- a name. Left empty, the session starts named after the prompt's first line,
  and the console asks Claude Haiku for a better one on the team's Anthropic
  key (`console/autoName.mjs`). The rail shows it a second or so later; if the
  call fails, the first line stays;
- what to work on: `#123` for an issue or PR, `PR #123`, or a branch name;
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
Agent and Terminal tabs):
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
- **Swipe** on a phone scrolls the pane, through statusd's `POST /scroll`.

And what the shed shows about each session:
- **The pull request's chip**, on the card and the pane bar: open, draft,
  merged or closed, `queued` in yellow while it waits in GitHub's merge queue
  (its place on hover), and otherwise one mark for what most needs a look (✗ a failing check
  or changes requested, a spinning ring while checks run, ✓ green or approved), with the
  counts on hover. A session that opens another pull request keeps each one
  it reported (`prUrls`, oldest first) and shows a chip for each, but a merged
  or closed one only while no newer one came after it, so the newest always
  stays. The card and pane bar show the newest two of those, a phone's bar
  the newest one, and the older fold into a `+N` chip that names each on hover;
  Details lists every one (the 20 newest are kept) with its state. The console reads every session's pull request in one
  GraphQL call a minute with its App token (`console/prChips.mjs`), a merged
  or closed one every 15 minutes.
- **CPU and memory**: the container's, from statusd's `/status`, after the
  status word on the card and in the pane bar. Amber past 70% of its memory or
  75% of its cores, red past 90% or 95%, the one over the line first.
- **Plan**: on a private session's pane bar, how much of your Claude plan's
  five-hour and weekly limits is used, as a short bar and a share for each,
  amber from 70% and `✗ out until` its reset at 100%. Click it for when each
  window resets, a tick for how much of it has gone by, and how old the reading
  is (on a phone, under ⋯). Claude Code hands the limits only to its status
  line, after each answer: `session/statusline.sh` saves them to
  `~/.claude/woodshed-usage/claude.json` and statusd's `/status` returns them
  (`session/planUsage.mjs`). The plan is shared, so every private session of
  yours shows the newest reading any of them has, a stopped one's last
  included, and a window whose reset has passed reads 0%. Claude Code reports
  the all-models week only, not claude.ai's per-model one, and leaves a window
  out at times; `/api/oauth/usage` refuses the setup token a session runs on.
- **App log**: a tab with the end of the frontend's, the backend's and Start
  app's logs, read every 3 seconds while it is open. The shed's is a
  terminal on the app's tmux; here the dev servers run without one, and a
  third ttyd would need its own port in the security group.
- **A pull request on the rail** opens your session already on its branch
  (**Open**), resumes a stopped one there (**Resume**), or starts a new one.
- **⌘K** (or **/**) opens the command palette: jump to a session (stopped ones
  once you type), go to a page, or Tab on a session for its actions. **?** (or
  **⌘?**) lists the keys; **⌘.** hides the rail; **⇧⌘,** opens Settings, with
  the theme (device, light or dark, kept in the browser); **⇧⌘O** (or **N**) is
  New session; **G** then **M**, **E** or **S** goes to My Woodshed, shared
  sessions or My settings. Ctrl works for ⌘ outside a terminal, and the pages
  write the keys as Ctrl on Windows and Linux. A key alone works only while
  nothing takes typing, and never inside a terminal. Which key does what is
  `public/keys.cjs`, read by the sheet, the hints and the handler alike. A
  control with a key (New session, the user menu's and settings list's
  Keyboard shortcuts) shows a hint with it when the pointer rests on it.
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
servers (the `mcpServers` entries of `~/.claude.json`). Every 20 seconds
statusd sends the session API (`POST /claude-settings`) what changed in that
session and gets back what your other sessions changed, which the console
merges item by item and keeps as `<login>/claude-settings.json` in the same
bucket. A new or resumed session applies the latest before claude starts, over
whatever its home held. Transcripts and the rest of claude's state stay each
session's own.
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

**Env files and tmux**, on My settings, add your own lines to
each of the repo's env files (the project file's `envFiles` that have a `secret`, one tab each, labelled with the file's path) and `~/.tmux.conf`:
- Every session starts from the shared files: each env file's secret, and the session image's `tmux.conf`. The page shows
  each one, with a link to Secrets & webhooks to change it for everyone.
- Your lines go after the shared file, so a key set in both uses yours, and a
  change to the shared file still reaches you. The page names the shared keys
  yours replace.
- Saving keeps them at `<prefix>/users/<login>/<file>`. **Clear mine**,
  or saving nothing, deletes them.
- The entrypoint still appends its own lines last (the databases, Redis,
  ports and URLs, listed on the page), so those always win.
- A running session keeps the files it started with.

**Your own files**, on My settings, are whole files of your own, by their path in the repo (an
`app/.env.production` that your MCP servers read, a tool's local config), which every My Woodshed session of yours
writes into its checkout at start:
- All of them are one secret, `<prefix>/users/<login>/own-files` (JSON, path to text; 64 KB and 20 files at
  most). `state.json` keeps only each path and when it was saved (`people.<login>.ownFiles`).
- A path is checked as it is saved and again in the session (`shared/ownFiles.mjs`): inside the repo, no `..`, not
  under `.git`, and not one of the env files above, which take your lines instead.
- The session writes a file only where git ignores it and does not track it, mode 600, so it cannot reach a commit
  (`session/ownFiles.mjs`). Its log says `Own files written`, or a `WARNING` with each file skipped and why.
- The console logs `userSettings: own file saved` or `removed` with the path, and `sessionApi: settings handed out`
  names them under `wholeFiles`. Remove My Woodshed deletes them.
- A running session keeps the files it started with; an edit made in a session is not saved back.

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

**My settings** (`/settings`, in the avatar menu) holds your Claude token: make
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
until they pick an agent. Its Codex **Model** and **Effort** menus are OpenAI's catalog, the one codex itself reads
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
entrypoint has claude go through the proxy on it. The token never reaches a
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

## Setting up the GitHub App from the console

A console with a secret store (AWS, or the local provider's secrets folder) and no GitHub App
(`WOODSHED_GITHUB_APP_ID` unset) offers `/setup/github`, and My Woodshed's setup card lists **Connect a GitHub App**
first. It starts without `gh` too, but needs it for every GitHub call afterwards, the App's included: without it the
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

## Webhook events, secrets and the GitHub App's webhook

In AWS the console has two more pages, under Console in the menu under your
avatar at the top right. Only an admin can open them (see "Sign-in"). The same menu signs
you out.

- **Webhook events** (`/events`): each message it took off the webhooks queue,
  what it did with it (started or messaged a session, skipped one the poll
  already handled, ignored, failed) and the delivery id. Labels and comments
  it does not act on, and Slack events that are not mentions, are left out.
  Each message is one line appended to `webhookEvents.jsonl`, beside
  `state.json`; the page shows the last 7 days, and a sweep every 12 hours
  (`webhookEvents: swept` with how many it kept) takes older lines out. A
  delivery the Lambda refused never reaches the queue: GitHub's Recent
  Deliveries page shows those.
- **Secrets & webhooks** (`/secrets`): each secret's state and when it last
  changed. Replace saves a new version, so the one before stays restorable as
  `AWSPREVIOUS`. Show reveals a session secret, since anyone who reaches the
  console can already read it in a session's terminal; the GitHub App's key is
  write-only. A new App key is used at once, after a test token minted with it
  succeeds. The webhook card checks four things (the App's webhook switched
  on, the five events subscribed, the App connected to the Lambda with the
  stored secret, GitHub's last delivery accepted) and **Set up webhook** walks
  through them in three steps: the boxes only GitHub's settings page can tick
  (Active, the events, the Webhook URL), Connect (make the secret and set it on
  the App with the Lambda's URL, `PATCH /app/hook/config`), and a test label
  whose delivery the modal follows from GitHub (`GET /app/hook/deliveries`) to
  the console's events log. The Lambda rereads
  its secret when a signature fails, so Rotate under Advanced takes effect at once.

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
there is no db-admin task, Data ▾ has Redis alone, and My settings has no Your databases. The console logs `console:
databases` once at start, with `made`, the `engines` it makes a copy on, the ones sessions are `hosted` on and the ones
its `tunnel` reaches.

When the default branch's project file names a database on an engine the installation does not host, no session that
would get databases starts (`databaseGate.mjs`): New session and My settings say why, the API answers the start with
the reason (`Not started: the project file's databases need mongo, which this installation does not host (it hosts
postgres)`), and a label or `/woodshed` comment gets it on its issue. The console logs `console: project databases not
hosted` with what the file `needs` and what is `hosted`, `fleet: session refused, its databases are not hosted` or
`fleet: trigger refused, its databases are not hosted`. A question from Slack, which gets no database, still starts.

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

After each of them, the task also closes every database to the roles that do not own it. Postgres lets every role
connect to a new database and make temporary tables there, a copy never takes its template's permissions, and a
session's own user makes databases of its own, such as a project's tests' `__test` and `__template` (named in its
`.woodshed/project.yaml`; `__`, so no login's database can be one), again before every test run. No user could read another's tables in one, but it could see the schema and hold a
connection that stops a copy. So each run revokes `CONNECT` and `TEMPORARY` from `PUBLIC` on every database but
`postgres` and `rdsadmin`, which every role needs, and the templates: a database is open only until the next run (a
shared session's start, a reset or drop, or the nightly template). Its log says `Closed databases to other users`
with how many, or names any still open.

The task definition's `entryPoint` fixes the hosts and every flag, and a run can
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

A session's databases open from the session's page, under **Data ▾** with
**Redis**. The session runs its own pgweb
(`/pg/<id>/`) and mongo-express (`/mongo/<id>/`) on loopback, as its databases'
user, so they reach those and nothing else (`startDbViewers` in
`session/entrypoint.sh`). A shared session's pgweb is locked to its database (`--lock-session`). A private
session's has two bookmarks instead, `your-database` and `restored-copy` (the copy Restore a Postgres dump makes,
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

**Editor ↗** in the session's pane bar (and **⋯** on a phone) opens VS Code on its checkout in a new tab, at
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
hours each end it and close every tunnel it opened. It reaches only its owner's
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
instead: it types a request into the session's claude (`SETUP_APP_PROMPT` in `console/fleet.mjs`; held until its turn
ends, as a message would be) to work out how the app runs, write the `app` section and commit it. statusd reads a
project with no app again on each Start app, so the button turns into **Start app** once the file has one, and that
start runs it.

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

### Sharing the app

A My Woodshed session's app is its owner's alone, as the session is. **Share the app…** in the session's ⋯ menu lets
the owner open it to more people. Only the app: the terminal, Review, the Redis and database viewers, Start/Stop and
the share controls themselves stay owner-only (`canOpenApp` in `server.mjs` adds to `canOpen` for the app's name and
nothing else, and the proxy hands the app's path only the session's status port and token). The owner chooses the
audience each time, and either can be turned off:

- **Members of this console.** One switch. Anyone signed in on the People list opens `https://<id>.woodshed.example.com`
  through the console's own app sign-in. Someone who cannot sign in (no write access, not on the list) cannot use it.
- **A link anyone can open.** For someone with no account here, such as a designer without write access. The owner picks
  an expiry (1 hour to 7 days) and gets `https://<id>.woodshed.example.com/__woodshed/share?t=<token>`, shown once.
  Opening it trades the token for a `__Host-woodshed_view` cookie for that one app and redirects to `/`, so the token
  leaves the address bar. The cookie holds the same token and every request checks it again, so **Revoke**, the expiry
  and the session stopping end access at once, websockets included. A session has at most ten links.

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

**A console with no repo yet** (neither `WOODSHED_REPO` nor `WOODSHED_PROJECTS`, and nothing added on the
Repos card) has no repository to ask about. It lets in the owner of the account its GitHub App is installed on: that
user, or an active admin of that organization (`console/appOwner.mjs`, asked with a token of the installation narrowed
to `members: read`, so the App needs Organization permissions, Members: read; without it the login page says so). The
first to sign in is the first member and an admin, as on any new console. Once a repo is added, write access to it is
what is asked again, at the next hourly check.

Write access alone is not enough: a person must also be on the console's list,
on the **People** page (`console/members.mjs`, `members` and `memberRequests`
in `state.json`). An admin can invite a handle (it must have write
access), accept or decline someone asking to join, and remove another member;
nobody can remove themselves. A writer who is not on the list signs in only as
a visitor: the login page offers **Ask to join**, and lets them in by itself
once an admin accepts. Admins see a dot on their avatar while someone is
asking.

**Admins.** Each member on People has an *Admin* switch, off for a new member.
Only an admin sees the Console group in the avatar menu (People, Secrets &
webhooks, Webhook events, Console settings), and the console answers 403 to
anyone else's call behind those pages (`ADMIN_API_RE` in `console/server.mjs`;
it logs `console: admin call refused`). The pages themselves still load and say
so. Only an admin turns the switch on or off, and the last admin cannot turn
theirs off (`members: admin changed` logs each change). A console with no
sign-in, like `devConsole.mjs`, treats everyone as an admin, and so does a list
with no admin yet (the one a console starts from the people already using it),
until the first is switched on. The first person to sign in to a console with
an empty list is its first admin. Locked out with no admin left: stop the console, set `"admin": true` on your entry under `members`
in `/var/lib/<prefix>/console/state.json`, and start it again.

**What each member can do.** People is a table, one row per member and one
column per switch, each off for a new member and set by an admin:
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
- The proxy adds each session's ttyd credentials. ttyd still gives that
  terminal credential to the browser, so it is a separate token from the one
  statusd checks, and only the console can reach statusd.
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
checks them: there is no Sessions from GitHub switch to ask.

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
- `userMenu(headers)`: a line under the person's name and groups of links at the top of the user menu (`menuOf` in
  `server.mjs`, `designSystem/components/MenuGroups`).
- `config.linkQuery`: query parameters every link the console hands out carries (GitHub comments, Slack posts,
  `SESSION_URL`, the copied New session link), for the program to route them.
- `newId`: how session ids are made, when they must be unique beyond the installation.
- `start({ deliveredWebhooks: true })`, then `dispatchWebhook(message)` for each GitHub event (`githubEvents.mjs`'s
  `toMessage` makes the message from GitHub's own payload): the GitHub poll then runs only as a fallback.

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
pull request is never posted. Until then the
pull request waits in `state.json` (`slackPending`), checked once a minute and
past the session's end; one closed, or still waiting after a week (a number on
the Console settings page), is dropped unposted. Once it is posted, its session stops (`posted to Slack`) and is
Finished. While it waits, a review verdict asking for changes on
its head commit, or a suite that failed or was skipped there, is typed
into the session, once each, with the `rerun` tags to put on the next commit, and a paused session is resumed with it.
A pull request older than the session is never posted: a resumed
branch's, or the one a PR's own session works on.

The console learns of the pull request from the session's status (`prUrl`),
reads it and its checks from GitHub with the App's token
(`console/prAnnouncer.mjs`, the gates in `console/pullGates.mjs`), and posts with
`chat.postMessage` as the bot whose token is `slack-bot-token`. The token is
console only, like the App key: a session never sees it.

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

To turn it on:

1. A Slack app with a bot user and the `chat:write` scope, installed in the
   workspace. Invite the bot to the channel (`/invite @<bot>`).
2. The bot token (`xoxb-...`) on the Secrets & webhooks tab, as
   `slack-bot-token`.
3. The channel's ID (`C...`, at the bottom of the channel's About tab) in the
   Slack card of the Console settings page. The console keeps it in
   `state.json`, and an empty channel turns the posts off.

Both are read for each post, so neither needs a restart.

### A channel for each project

A project can have a channel of its own: the channel field on its row of the
Console settings page's Repos card, for the installation's repos and the ones
added there alike (`POST /api/console-settings/projects/slack-channel` with
`{"name", "channel"}`, admins only, checked as the Slack card's channel is: a
channel ID, never a name). It is kept in `state.json` under
`settings.projectSlackChannels`, by project name, and removing an added repo
drops it. A project's pull requests and their decision briefs go to its own
channel when it has one, and to the Slack card's channel otherwise. A project
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
  the bot token's value unless Slack issues a new one: copy the page's Bot User
  OAuth Token onto the Secrets & webhooks tab as `slack-bot-token` if it
  changed. Without the scope, the console logs `slack: call refused` with
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
   the app's env files and the install secrets are unset before claude starts.
   `session/ask.md` tells claude to read the code, link each claim to it at the
   commit it read, and post the answer with `session/answer.sh`, which goes
   through the session API's `POST /answer` to the thread.
4. Another mention in the same thread is typed into that session, or resumes it
   with its conversation once it has stopped. A mention in a new thread is a new
   question.
5. It stops after 5 minutes without working, so soon after it answers, or 2
   hours in all. Both are on the Console settings page's "Questions from Slack"
   card, apart from the shared sessions' limits. One that failed, or stopped
   before posting any answer, says so in the thread. A stopped one is kept 7 days
   for follow-ups (the "no pull request" number on the Console settings page).

A follow-up has to mention the bot too: the app reads mentions only
(`app_mention`), not every message in a channel.

To turn it on, on the same Slack app as the pull request posts:

1. Bot token scopes: `app_mentions:read`, `chat:write`, `reactions:write`,
   `users:read` and `users:read.email`. Reinstall the app if Slack asks, and put
   the new bot token on the Secrets & webhooks tab as `slack-bot-token`.
2. The app's **Signing Secret** (Basic Information) on the Secrets & webhooks
   tab as `slack-signing-secret`.
3. **Event Subscriptions**: on, with the `slack_events_url` Terraform output as
   the Request URL (Slack checks it at once), and the bot event `app_mention`.
4. Invite the bot to the channels where people should ask.

## QA sessions

A project whose file says `pullRequests.qa.runner: woodshed` runs its QA here rather than in its CI
(docs/reference.md, "QA in a Woodshed session"):

1. The webhooks pass every label on a pull request to the fleet (`handleQaLabel`), which reads the project file from
   the default branch and drops any label that is not its QA label, without an entry in the events log.
2. The person who added it needs write access and sessions from GitHub, as for the console's own label. A QA session
   already running on the pull request, or a closed pull request, starts nothing.
3. The fleet starts a `pr` session with a `qa` field (base branch, head commit, heading, comment): `SESSION_MODE=qa`,
   `PR` and `QA_BASE` in its environment, its own databases, and the read-only GitHub token an ask session gets. It
   posts the QA comment saying it is running.
4. `session/qa.sh` runs in the session's terminal, and statusd reports the session working until it is done. It sends
   the verdict, the report, the commit it tested and the cost to the session API's `POST /qa-report`
   (`qaSessions.mjs` checks it), once.
5. The fleet writes the report into the QA comment, posts the QA check on the commit tested with the verdict and the
   report (the decision brief reads the report from there, since sessions can comment as the App but not post a
   check), and stops the session with `QA finished: <verdict>`. It pushes nothing and is not kept, so its databases go
   at the next sweep.

## Console settings

The Console settings page (`/console-settings`, under Console in the avatar
menu, beside Secrets & webhooks) holds the numbers above. Only an admin can
open it and change them. Each card saves its own values together with its Save
button, with no typed confirm since changing a value back undoes it (the typed
confirm is kept for what cannot be undone: Stalled's fixes below, secrets, a
restore), and the server refuses a value out of its range, keeping none of the
card's:

| Card | Setting | Range | Default |
| --- | --- | --- | --- |
| Sessions | Shared sessions running at once | 1 to 20 | `WOODSHED_MAX_SESSIONS`, 5 |
| Sessions | My Woodshed sessions per person | 1 to 10 | 3 |
| Sessions | Pause a session waiting for input after | 0.25 to 24 hours | `WOODSHED_IDLE_HOURS`, 1 |
| Sessions | Stop a working session after | 1 to 24 hours | `WOODSHED_LIFETIME_HOURS`, 8 |
| Retention | Delete a merged or closed session after | 0 to 30 days | 3 |
| Retention | Delete a finished session whose PR stays open after | 1 to 90 days | 14 |
| Retention | Delete a paused session with no pull request after | 1 to 60 days | 7 |
| Slack | Stop waiting for the review and the suite after | 1 to 30 days | 7 |
| Slack | Channel | a channel ID, or empty for no posts; a project with its own channel on the Repos card posts there instead | none |

They live in `state.json` under `settings`, and the console reads them each
time it uses one, so a change applies on its next tick with no restart. The
environment values are what a setting is until someone changes it.

The **Woodshed** card, first on the page, follows the git clone the console runs from (`console/woodshedUpdate.mjs`;
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
`WOODSHED_BUILD_ONLY=1`, `WOODSHED_IMAGE` set to the console's own, `WOODSHED_REPO` the default project's and the
App's token as `GH_TOKEN`; its output goes to `woodshed-update.log` in the state folder and its last lines to the page),
then **Restart the console**, which exits with code 75 for its supervisor (`supervisorOf`, as the GitHub App setup's
Restart). A failed step puts the clone back on the commit it was on (`git reset --keep`), so the console runs as it
did. New code that passes the start check and still fails after the restart leaves nothing answering: after two
minutes the page says so, with the `git -C <clone> reset --keep <from>` that goes back. Without a supervisor the card shows the commands instead of the button; with no clone (the AWS console image),
`/api/console-settings/updates` answers 404 and there is no card. `state.json` keeps the last update under
`woodshedUpdate` (from, to, who, when, and whether the image was built), which the card says after the restart. The
console logs `woodshedUpdate: following` with the clone, its branch and remote at start, `woodshedUpdate: checked` with
`behindBy` and `aheadBy`, `check failed`, `update started`, `updated, restarting`, and `update failed` with the step
(`pull`, `starts`, `image`) and whether it went back; the start check logs `console: start check passed`.

The **Repos** card, next, lists the repos sessions can start on (the projects above) and adds more.
**Add a repo** is a list of the repos the GitHub App may reach and that are not projects yet
(`GET /api/console-settings/projects/repos`: each of the App's installations, `GET /app/installations`, then its repos,
`GET /installation/repositories` with a token narrowed to reading metadata), with an optional name; **Add repo** sends
the pick (`POST /api/console-settings/projects`). Under it, *Not listed?* links each installation's settings on GitHub,
where the repos it may reach are picked (Repository access), and the App's install page for another account; the list
is read again on **List again** and when the tab comes back into view. On a console with no App (the local provider,
or borrowed GitHub access), or when GitHub did not list them, the field takes `owner/name` typed in (a `github.com`
link works too). The console logs `projects: repos listed` with how many, or `projects: repos not listed` with GitHub's error; an installation whose repos GitHub refused is left out, with `projects: an installation's repos not listed`.
Add repo, Remove and a row's Slack channel Save apply on the click, with no typed confirm, since each is undone by doing the other. The console checks the repo first: with the GitHub App it must be able to reach
it (`GET /repos/<repo>/installation`, as the App), and the installation's number is kept with the project when it is not
the console's own. A repo on an account the App is installed on, but not given, is refused with a link to that
installation's settings, to give the App access to it; a repo on an account without the App, with a link to the App's
install page (`https://github.com/apps/<slug>/installations/new`, the slug read from GitHub); on a console with no App (the local provider) `gh` must be able to read it. A repo already a
project, or a name in use, is refused with its reason. The added repos are kept in `state.json` under `addedProjects`
and appended to `WOODSHED_PROJECTS`'s list in the live config (`liveConfig`), so one applies at once, with no
restart, and a project's New session **Project** field shows it to whoever can write to it. On a console that started
with no repo the card says so, and the first repo added is the default (`liveConfig`), until it is removed and the next
one takes its place; until then New session's setup card lists **Add a repo** (`repoNeeded` in `/api/my`), and a start
is refused with `Not started: the console has no repo yet` (`fleet: session refused, the console has no repo yet`).
**Remove**
(`POST /api/console-settings/projects/remove`) takes an added repo off, and is disabled while a session is running on it
or listed to resume (a shared one kept, or any of a person's My Woodshed sessions still on their list), since that session would fall back to the default project's repo. The installation's own projects,
the default among them, are read-only here: they change where `WOODSHED_PROJECTS` is set. Each row, theirs too, has a
Slack channel field for that repo's pull requests ("A channel for each project" under Slack). An added repo is on the
same terms as any other project: My Woodshed sessions, and labels and `/woodshed` comments on its issues (a webhook about
it is no longer dropped), in the default project's session image and databases, with Slack questions and the
database check staying on the default project. The
console logs `projects: repo added` and `projects: repo removed` with who did it, and `projects: installation not read`
when GitHub did not answer.

Each repo on the card has a row of six colours, its colour on the rail (`public/projectColors.cjs` holds the palette and
the rule, for the server and the pages alike). A pick is saved at once (`POST /api/console-settings/projects/color`,
`{"name", "color"}`), checked against the palette, and refused when another repo has that colour, whose swatch is
disabled. A repo nobody picked a colour for, the installation's own as well as an added one, takes the first colour no
repo has, in the order the repos are listed; a pick pins every repo's colour as it shows then, so the one freed does
not move to another. Past six repos the rest have no colour. The picks are kept in `state.json` under `projectColors`,
and the console logs `projects: colour set` with the project, the colours and who set it. Removing a repo drops its
pick (`projects: colour forgotten`), so a repo added again under that name takes a free colour, not one another repo has
had since.

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
| `WOODSHED_PUBLIC_URL` | `http://localhost:<port>` | The base of the link posted on GitHub; its host is accepted |
| `WOODSHED_HOSTS` | none | More names to accept, comma-separated |
| `WOODSHED_TLS_ASK_PORT` | none | A port on `127.0.0.1` where a reverse proxy asks before getting a certificate on demand: `GET /tls-ask?domain=<name>` answers 200 for the public URL's host, `WOODSHED_HOSTS` and a session's app name, 403 otherwise (`tlsAsk.mjs`). For a console with no wildcard certificate; `providers/local/README.md` has the Caddyfile |
| `WOODSHED_LOCAL_LOGIN` | `local` | The handle a local console with no sign-in gives the person using it, so My settings (their Claude token, private sessions) works there. Ignored with a GitHub App or on AWS |
| `WOODSHED_REQUIRE_SIGN_IN` | off | `1` requires GitHub sign-in on every route from the start, with or without a client secret. Set on the base box |
| `WOODSHED_TRUSTED_IDENTITY_SECRET` | none | Hosted mode: the secret a trusted proxy in front of the console signs each request's `X-Woodshed-Identity` header with, at least 32 characters. Set, that header is the only sign-in, and it is required; `role: owner` is an admin. See "Hosted mode" |
| `WOODSHED_GITHUB_BROKER_URL`, `_GITHUB_BROKER_TOKEN_FILE` | none | Hosted mode: where the console asks its host for every installation token, and a file holding the bearer it asks with. Both or neither, and never with `WOODSHED_GITHUB_APP_ID`. See "Hosted mode" |
| `WOODSHED_SUPERVISED` | on under systemd, else off | `1` says something starts the console again when it exits (a container with a restart policy), so the GitHub App setup page offers Restart; `0` says nothing does, even under systemd. See "Setting up the GitHub App from the console" |
| `WOODSHED_STATE_DIR` | `/var/lib/woodshed-cloud` | Holds `state.json` (sessions, their tokens, the polling cursors) and `webhookEvents.jsonl` (the Webhook events tab) |
| `WOODSHED_REPO`, `WOODSHED_LABEL` | none (`owner/name`), `woodshed` | The one repo this installation works on. Unset, with no `WOODSHED_PROJECTS`, the console starts with no repo, and the first one an admin adds on the Repos card is the default ("Sign-in" says who may sign in until then). The local provider's installer always sets one: it builds the session image from it |
| `WOODSHED_PROJECTS` | one project, `WOODSHED_REPO` | The repos this installation works on, as JSON: `[{"name": "app", "repo": "owner/app", "default": true}, …]`. A name is lowercase words of letters and digits joined by single dashes, at most 32 long; a project may give `installationId`, the GitHub App installation on its repo's account, when that is not `WOODSHED_GITHUB_APP_INSTALLATION_ID`'s; names and repos are each used once; with more than one project, exactly one is `default`. Unset, the one project is `WOODSHED_REPO`, named after its repo; set beside it, `WOODSHED_REPO` must be the default's repo. A session records its project's name beside its `repo`, and its GitHub token (`/github-token`) reaches that project's repo alone (`projectTokens.mjs`). A My Woodshed session can start on any project you can write to (New session's **Project**); every project runs in the default project's session image for now, and a session on another one gets `PROJECT_REPO` and clones that repo at start (`session/entrypoint.sh`, `useProjectRepo`). A label or `/woodshed` comment on another project's issue starts or reaches a shared session on that project, with its write access, reactions, comments, the issue's assignee and board, and its pull request's chip, Slack post and gates (that repo's own project file) read on its repo; a webhook about a repo that is no project's is dropped (`webhooks: message from a repo that is not a project, dropped`). New session's `/` list and the Review tab follow the session's project too. The poll (the fallback for a lost webhook) reads every project's repo too. Questions from Slack and the database check still run on the default project. A list that is wrong stops the console with what is wrong. Repos an admin adds on the Console settings page's Repos card are appended to this list while the console runs |
| `WOODSHED_ENV_FILES`, `WOODSHED_DB_ENV_SECRETS` | none | The repo's env files as `secret=path` pairs (`api-env=api/.env,web-env=web/.env.local`): each is a secret on the Secrets page and a tab on My settings. The second lists which of those secrets the databases' commands read (every `envFiles` of the project file's `databases`). Terraform sets both from `env_files` and `database_env_secrets`; the project file's own `envFiles` must name the same secrets |
| `WOODSHED_INSTALL_SECRET_PAIRS` | none | The secrets the repo's dependency installs read, as `secret=VARIABLE` pairs (`registry-token=REGISTRY_TOKEN`): each is a secret on the Secrets page, and reaches a session in its variable as it is, with `WOODSHED_INSTALL_SECRETS` listing the variables. A variable that is one of Woodshed's own (`SESSION_VARIABLES` in `shared/reservedNames.mjs`, or `WOODSHED_*`) or an env file's stops the start. Terraform sets it from `install_secrets` |
| `WOODSHED_POLL_GITHUB` | on | `0` turns polling off; sessions then start only from `start-session.mjs` |
| `WOODSHED_WEBHOOK_QUEUE` | `woodshed-cloud-webhooks` with the `ecs` launcher, else none | The webhooks queue's name or URL; `0` turns webhooks off. Set on the base box from Terraform's queue, `<name_prefix>-webhooks`; the default is for a box whose stack predates that, and goes later |
| `WOODSHED_FALLBACK_POLL_SECONDS` | `300` | How often the poll runs while webhooks arrive, and how often a pull request is read on its own while pull request webhooks arrive |
| `WOODSHED_CHECKOUT` | the console's own folder | The Woodshed git clone the Console settings page's Woodshed card follows and Update pulls. The dev console points it at a made-up one |
| `WOODSHED_ACTIONS_WORKFLOWS` | none | The avatar menu's GitHub Actions links, as `label=file.yml` pairs, comma-separated: the repo's workflows that build the images and apply the infrastructure. None leaves the group out. Set on the base box from Terraform's `console_workflow_links` |
| `WOODSHED_MAX_SESSIONS` | `5` | Shared sessions at once, until the Console settings page says otherwise. Set on the base box from Terraform's `max_sessions` |
| `WOODSHED_IDLE_HOURS`, `WOODSHED_LIFETIME_HOURS` | `1`, `8` | The same, for the pause and stop times |
| `WOODSHED_LAUNCHER` | `docker` | `docker` on a dev box, `ecs` in AWS |
| `WOODSHED_DATABASES`, `WOODSHED_ECS_DB_ADMIN_TASK_DEFINITION` | none | For `ecs`, both from Terraform's `databases`: the ones the installation runs, comma-separated (`postgres,mongo`, `postgres`, or empty for none), and the db-admin task's family, set only when there is one. The aws provider refuses to start without the first, or when the two disagree |
| `WOODSHED_ECS_CLUSTER`, `_ECS_TASK_DEFINITION`, `_ECS_SUBNETS`, `_ECS_SECURITY_GROUP`, `_ECS_LOG_GROUP` | none | For `ecs`; the base box bootstrap sets them from Terraform. Region from `AWS_REGION` |
| `WOODSHED_IMAGE` | `woodshed-session` | |
| `WOODSHED_SESSION_MEMORY`, `WOODSHED_SESSION_CPUS` | `6g`, `2` | Docker limits per session |
| `WOODSHED_SESSION_ENV_FILE` | none | A JSON object of strings passed to every session: the shared services and secrets from the table above |
| `WOODSHED_GITHUB_APP_ID`, `_GITHUB_APP_INSTALLATION_ID`, `_GITHUB_APP_KEY_FILE` | none | The GitHub App. When set, the console mints installation tokens with the key (`githubApp.mjs`) for its own GitHub calls and for sessions, and `GH_TOKEN` is not used. With the `ecs` launcher and no key file, the key is read from `<prefix>/github-app-key`; until it has a value the console runs without GitHub |
| `WOODSHED_SECRET_PREFIX`, `WOODSHED_WEBHOOK_FUNCTION` | `woodshed-cloud/`, `woodshed-cloud-webhooks` | With the `ecs` launcher: where the Secrets page finds its secrets (and the `project` tag of those it makes), and the Lambda whose URL it sets on the GitHub App. Set on the base box from Terraform's `name_prefix`; the defaults are for a box whose stack predates that, and go later |
| `WOODSHED_LOCAL_SECRETS_DIR`, `WOODSHED_LOCAL_SECRETS_KEY_FILE` | none | On the local provider: the folder the Secrets page keeps its secrets in, one `<name>.json` each, readable by the console's user only (`providers/local/secretStore.mjs`), and the key each file is sealed with, AES-256-GCM, from a file of its own outside the folder, mode 600 (`secretKey.mjs`; `bin/secret.mjs new-key` makes one). The folder needs the key; a plain file in it is sealed at start. Each session also gets each env file's secret and each install secret from it as it starts, unless `WOODSHED_SESSION_ENV_FILE` sets them. With the GitHub App and no key file, the App's key is read from it too. Without it, the local provider has no Secrets page |
| `WOODSHED_LOCAL_HOMES_DIR` | none | On the local provider: the folder saved Claude homes are kept in, at the same names as the S3 bucket's keys (`providers/local/homeStore.mjs`), readable by the console's user only. Without it, the local provider keeps no Claude home between sessions |
| `WOODSHED_LOCAL_DB_POSTGRES_HOST`, `_DB_POSTGRES_ROOT_USER`, `_DB_MONGO_HOST` | none | On the local provider: where each session's own databases are made, Postgres on 5432 by the first two (both or neither) and Mongo as `host:port`, each only for an engine the installation hosts, each on its own (`providers/local/postgres.yml` and `mongo.yml` run them). A db-admin run is a container of the session image (`providers/local/dbAdminRunner.mjs`); it reads the root passwords from `db-root/postgres` and `db-root/mongo` in `WOODSHED_LOCAL_SECRETS_DIR`, each for a database it runs, and sees only the database password its command makes and the env file secrets the databases' commands read (their `envFiles`), as the AWS task role does. A failed run's container is kept for `docker logs`, root passwords in its environment, until the next run of the same action and owner removes it. Each run's secrets are copied under `db-admin-runs/` in `WOODSHED_STATE_DIR`, which must be the same path for the docker daemon, as it is when the console runs on that machine |
| `WOODSHED_LOCAL_DOCKER_NETWORK` | none | The docker network sessions and db-admin runs join, to reach the shared services by name (`providers/local/compose.yml`'s `woodshed`) |
| `WOODSHED_LOCAL_WEBHOOK_PORT`, `_WEBHOOK_HOST`, `_WEBHOOK_URL` | none, `127.0.0.1`, none | On the local provider: where its webhook receiver listens (`providers/local/webhookReceiver.mjs`), at the Lambda's paths, `POST /github` and `POST /slack`, checked against `github-webhook-secret` and `slack-signing-secret` in `WOODSHED_LOCAL_SECRETS_DIR`, which it needs. `_WEBHOOK_URL` is the public address a proxy in front of it answers at, and the Secrets & webhooks page sets `<url>/github` on the GitHub App. A message the console fails on is tried three times; one still waiting when the console restarts is lost, and the poll finds it |
| `WOODSHED_TUNNEL_POSTGRES`, `_TUNNEL_MONGO` | none | Where `woodshed-db.mjs`'s connections go, as `host:port`, each used only for a database the installation runs. Each one is a tunnel of its own, and the script listens for those alone; without either, or without own databases, My settings has no From your computer. Without the Postgres one there is no Restore a dump for Postgres either, and without the Mongo one none for Mongo. Set on the base box, for the databases it runs: RDS and the box's private address |
| `WOODSHED_SESSION_API_HOST`, `_SESSION_API_PORT` | none, `7691` | With the App: the address the session API listens on (`sessionApi.mjs`). In AWS, the base box's private IP, which only session tasks can reach |
| `GH_TOKEN` | `gh auth token` | Without the App: polls, comments and reacts. Sessions push with it too unless the env file sets its own `GH_TOKEN`, and the console warns at startup when it does not: your own token reaches far more than this repo, which undoes the narrow token "Why permissions are off" in `../session/README.md` relies on |

These had an older prefix until the project became Woodshed; the old names still work and log a deprecation
(`../docs/reference.md`, "Renamed variables", which also has the two that were renamed otherwise).

Tests: `node --test woodshed/console/*.test.mjs`.
