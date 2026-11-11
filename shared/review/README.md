# `review/` — read a pull request in an order that makes sense

Everything behind `/review` and `/reviews/*`, plus the parts of a session's
lifecycle that only exist when that session is reviewing something.

What a person sees is documented by each tool that serves the page. This file is about the
local rules — the things that are not obvious from any single module and that
will bite you if you do not know them.

## The one thing to understand first

**A review is not a thing with its own lifecycle. It is an aspect of a session.**

It used to be the other way round: the feature owned a private git checkout at
`~/.claude/bridge-reviews/pr-<n>`, deliberately outside `<repo>/.claude/worktrees/`,
garbage-collected on a 7-day TTL and an 8-entry LRU, reached from a `/review?pr=N`
landing page. All of that is gone.

Now:

- `POST /run` with a **`target`** (a PR number, a PR URL or a branch) creates the
  session's worktree at that head rather than off the default branch, and records what is
  being reviewed. A pull request from this repo is checked out on its own
  branch; a fork's pull request or a branch target gets a private
  `review/<stem>-<sessionId>` branch.
- `POST /reviews/<session>` reviews a session's **own** worktree against the default branch,
  for a session that was launched with an ordinary prompt and has since done
  some work. This is the third kind, `kind: 'worktree'`, and it is different in
  kind from the other two — see below.
- `POST /reviews/<session>/refresh` takes a **target** review again at whatever
  origin has now. A separate route from the bare `POST` on purpose: that one
  means "review this session's own working tree", which is a different question,
  and the 409 it answers a target session with is what says so.
- The session is an ordinary shed session: it appears in Active sessions, it
  can `Start app`, it can be stopped and resumed.
- The review's lifetime is the session's. There is no TTL, no LRU and no
  garbage collector, because the session's own Kill button is the collector.
- `/review?session=claude-<8hex>` renders it, reached by the **Review** link on
  that session's row. There is no landing page.

### The third kind: reviewing a session's own work

A pull request is finished and pinned; a session mid-feature is neither. That
difference is the whole of why `createWorktreeReview` is a separate path rather
than a third branch inside `prepareReview`:

- **It creates nothing**, so there is nothing to undo on failure — no 130 MB and
  no `review/*` branch.
- **It owns nothing.** The record carries `ownsWorktree: false`, and
  `removeReviewSession` reads it and returns `{removed: false}` without touching
  the worktree or the branch. Getting this wrong deletes the work being
  reviewed. It is the one property in this module with a dedicated test.
  The field is absent on records written before it existed, and all of those
  were bridge-created, so the default has to be `true`.
- **The diff is of the tree, not of a commit.** A session that is mid-feature
  has uncommitted edits and untracked new files, and a commit-to-commit diff
  shows neither. `worktreeDiff` builds a throwaway index — `read-tree HEAD` then
  `add -A` under a `GIT_INDEX_FILE` of its own — so one ordinary unified diff
  covers commits, staged and unstaged edits, deletions and untracked files
  together, with `.gitignore` honoured so the 2 GB of hardlinked `node_modules`
  stays out. **The session's real index is never touched**, which matters
  because someone is working in that tree right now and a review must not stage
  their files.
- **It is against the merge base**, not the tip of the default branch, so commits landing on
  it while the session works do not appear as the session's changes
  reversed.
- **It is re-runnable, and has to be.** The snapshot goes stale on the next
  keystroke. A second `POST` cancels any analysis in flight, replaces the diff,
  **deletes the old artifact** and re-runs. Leaving the artifact would be worse
  than leaving nothing: `restoreState` treats one on disk as authoritative, so
  the page would show the previous ordering and preamble against the new code —
  wrong, and confident about it.

`server.mjs` imports eight things from here: `handleReviewRequest`,
`reviewStartupSweep`, `parseReviewTarget`, `createReviewSession`,
`startReviewAnalysis`, `removeReviewSession`, `hasReviewFor` and
`reviewOwnsBranch`. That last one is not a synonym for `hasReviewFor`, and the
difference is load-bearing: Kill's confirmation and its tooltip have to say
whether commits survive, and once a session could review its own worktree,
"a review exists" stopped answering that. Branching the copy on the wrong one
tells someone their work is about to be deleted when it is not. The worktree
review needs nothing new from it: `POST /reviews/<session>` arrives through
`handleReviewRequest` like every other review route, and resolves the session's
worktree through `ctx.worktreePathFor`, which server.mjs now supplies so the
`<repo>/.claude/worktrees/bridge-<id>` layout rule stays stated in one place.

## Re-reviewing a target

A pull request review used to be final: the head was fetched at launch and a
pull request that gained a commit needed a whole new session, worktree and all.
`/refresh` replaces that. `refreshTargetReview` ends in the same four steps as
the worktree path — cancel, delete the artifact, clear the in-memory claim,
re-analyse — and everything before them is about keeping three things in step.

- **The worktree moves too, and that is not optional.** The analysis and every
  "ask about this line" run with it as their cwd, so a refreshed diff over an
  unmoved tree has the model reading one commit while the page shows another.
  It is a `git reset --hard`, on a live session worktree.
- **Which is why `planWorktreeMove` refuses more than it moves.** Clean and
  sitting exactly on the recorded head — move. Already on the new head — no-op,
  dirty or not, because that is what a session that pushed its own fixes looks
  like and its edits are not on the new head yet. Anything else, including a
  `git status` that did not answer, refuses. Every refusal is work that exists
  nowhere else, so each branch has a test that fails without it: delete the
  dirty-tree guard and two of `worktree.test.mjs`'s cases fail, the own-commits
  guard a third, the no-op case a fourth.
- **Nothing is written until the diff is in hand.** The fetch and `gh pr diff`
  come first, so a pull request that cannot be diffed leaves the review exactly
  as it was rather than half-refreshed.
- **The diff is written before the record.** The record names the commit the
  analysis is about: a new diff under an old header is survivable, an old diff
  under a new header has the model reordering code that is not there.
- **A write failure does not drop the state.** That record is the only thing
  naming the `review/*` branch, so `removeReviewState` here would strand the
  branch and the objects it pins. The tree has already moved by then, so the
  fix is to press the button again — the tree already being on the new head is
  exactly the no-op case.
- **An unmoved head costs nothing.** Same sha as the record means no diff, no
  artifact deletion and no run: the button is one press from a paid analysis,
  and "no new commits" is the honest answer.

## Shape

```
index.mjs      the route table, the async orchestration, the startup sweep
target.mjs     what the "PR or branch" field is allowed to become
worktree.mjs   creating and destroying the session's worktree at a head,
               and diffing a session's own worktree against the default branch
page.mjs       the /review document (CSS + client script), one template literal
askState.mjs   the ask panel's state model — also runs in the browser, see below
diff.mjs       parseUnifiedDiff + intraLineDiff — hand-written, no deps
highlight.mjs  tokenizeLine — also runs in the browser, see below
analyze.mjs    schema, prompt, NDJSON reducer, reconciliation
explain.mjs    prompt, validation, answer extraction
chat.mjs       the conversation about the change as a whole: prompt, history bound
jobs.mjs       `claude -p` child lifecycle, concurrency, orphan reaping
store.mjs      on-disk layout under $REVIEWS_DIR, one directory per session
github.mjs     the `gh` CLI
exec.mjs       promise-wrapped spawn
```

## Six rules

**1. Dependencies from `server.mjs` are injected, never imported.**
`server.mjs` imports `index.mjs`, so importing back would be a cycle. It passes
`{repoRoot, removeWorktree, readProcTable, readMeminfo, json, log, reqId}` as
`ctx` (built by `reviewCtx()` there). Re-implementing one of those here instead
is the specific mistake to avoid — `removeWorktree` passes `--force` twice for a
reason a second copy would not know, and a near-duplicate of the `/proc/meminfo`
parser was written here once and removed in review.
Always await the injected `removeWorktree` before inspecting the filesystem or
attempting fallback deletion; Git removal is asynchronous.

**2. No shell. Anywhere.**
Every subprocess goes through `exec.mjs`'s `run(file, argv)` or `spawn(bin,
argv)`. There is no string form and no `shell: true`, which is why
`server.mjs`'s `shQuote` is deliberately unused here.

**3. Everything git is async, and that is not a style preference.**
`git worktree add` of this repo writes ~130 MB and the repo's SessionStart hook
then hardlinks ~2 GB of `node_modules` on top; the whole thing takes tens of
seconds. Every other subprocess call in `/run` is `spawnSync`, and one
`spawnSync('git', ['worktree', 'add', ...])` there would freeze every other
tab's `/sessions` poll for the duration.

**4. `page.mjs` is a template literal, so no backticks and no `${`.**
A stray backtick corrupts the _client_ script while the server still parses and
serves 200s. `install.sh` re-parses the served page for exactly this reason, and
asserts the page has exactly one inline `<script>` (its extraction is a naive
`sed` range that would otherwise splice two blocks together). This applies to
comments too — a backticked identifier inside a comment breaks it just as well,
which has now happened twice.

**5. `tokenizeLine` and `createAskState` must be self-contained.**
`page.mjs` ships both to the browser via `${fn.toString()}`, so a reference to
any module-scope binding parses fine here and throws `ReferenceError` there.
`highlight.test.mjs` and `askState.test.mjs` each rebuild theirs with
`new Function` to prove the constraint, with a negative control.

`page.mjs` is over the repo's 800-line file rule, deliberately: it is one HTML
document, and every place you split it becomes a new `${...}` interpolation into
a template literal — which is precisely what rule 4 exists to keep rare.

**6. Client DOM is `createElement` + `textContent`, never `innerHTML`.**
Every string on that page — PR titles, diff hunks, model output — comes from
somewhere untrusted. The small markdown renderer exists because the model
returns markdown into a `textContent`-only DOM. The one piece of HTML the page
accepts is a pull request description's `bodyHTML`, fetched because its image
links are the only ones signed to load without a GitHub login. It is never
inserted: `renderGithubHtml` parses it into an inert `DOMParser` document and
rebuilds it with `createElement` from a tag and attribute allowlist, copying a
URL only when it is `http(s)`. Widen that list rather than reaching for
`innerHTML`.

## Things that are the way they are on purpose

- **`PATCH /reviews/<session>/title` renames the pull request, and leaves the
  record alone.** `session.json`'s `meta.title` says what the pull request was
  called when the review was taken and stays that way; the page already
  prefers the live title over it, so a rename shows immediately without a
  second write and a re-review picks the new one up on its own. It goes
  through `gh api -X PATCH`, not `gh pr edit`, which has been unreliable on
  this box. An empty title and a multi-line one are refused here rather than
  by the API, the second because GitHub silently flattens a newline and a
  reader who pasted two lines should be told rather than have one vanish.

- **The draft review is GitHub's too, and also GraphQL-only.** A line comment
  goes into the viewer's pending review — `addPullRequestReview` to start one,
  `addPullRequestReviewThread` to add to it, `deletePullRequestReviewComment`
  to drop one, `submitPullRequestReview` to send the lot. Four facts that are
  only learnable by trying them, all measured on the box:

  - a viewer gets **one** pending review per pull request, so `gh pr review`
    (which opens its own) is a 422 the moment a draft exists. That is why
    `/submit` checks for a draft and picks between the two paths rather than
    always using one;
  - deleting the **last** comment deletes the pending review with it. Nothing
    here has to tidy up after, but the page must drop the review id it holds
    or the next comment would be added to a dangling one;
  - which **side** of the diff a comment is on lives on the thread, not the
    comment: `PullRequestReviewComment` has `line`, `originalLine`,
    `startLine` and `originalStartLine`, and no side at all. So the query asks
    for `reviewThreads` beside the review and matches them back by comment id.
    Without it a comment on a deleted line is drawn beside the added line that
    replaced it, which is the wrong row and looks confident;
  - `startLine` cannot be passed as null to mean "one line" — GitHub reads a
    span of one and refuses it. A single-line comment and a span are two
    mutations;
  - every GraphQL route into a line comment goes through a review.
    `addPullRequestReviewThread` with a bare `pullRequestId` and no review id
    still returns the comment in state `PENDING`, measured. So a comment meant
    to be published the moment it is written has exactly one API, the REST
    `POST /pulls/{n}/comments`, which is why `postLineComment` is the one call
    in this file that is not GraphQL. It needs a head sha, read live rather
    than from the review record, which for a worktree review is the working
    tree's head and not the pull request's.

- **There is no way to upload an image.** GitHub's attachment upload is an
  endpoint its own web client uses and is in neither the REST nor the GraphQL
  API, so `gh` cannot reach it. The composer says so rather than offering a
  paperclip that could not work. Do not "fix" this by hosting the image on the
  shed: that URL is reachable on the tailnet and nowhere else, so the comment
  would render as a broken image for everyone it was written for.

- **The Viewed tick is GitHub's, and it is GraphQL-only.** There is no REST
  endpoint and no `gh pr` verb for it: reading is
  `pullRequest.files.nodes.viewerViewedState`, writing is `markFileAsViewed` /
  `unmarkFileAsViewed`, all through `gh api graphql`. The read hands the page
  the pull request's node id so a tick costs one round trip rather than two,
  and the page ticks optimistically and puts the tick back if GitHub refuses —
  which it does for a path the pull request does not contain, a real case on a
  worktree review showing a file that has not been pushed. A browser-local
  version of this existed first and is gone: two sets of ticks that drift
  apart are worse than one, because neither can be trusted.

- **`POST /reviews/<session>/discard` empties a review; it does not remove
  one.** The artifact, the conversation and any job breadcrumb go.
  `session.json` and `diff.json` stay, and that split is the point:
  `session.json` names the worktree and the `review/*` branch that nothing
  else names, so dropping it here would orphan both — the failure
  `removeReviewState` is careful not to commit — and the page needs a diff to
  have anything to render. Removing a worktree stays with the session's Kill,
  which orders the removal so a branch cannot be left behind. In-memory state
  is cleared before disk, the way `removeReviewSession` does it, or a killed
  run resuming from its close handler would write a fresh artifact over the
  discard.

- **Six routes write to GitHub. `POST /merge` is the one that cannot be
  undone, and `/submit` is the loudest of the rest.** `/submit` was once
  the only one, and several comments in this tree still said so after the
  others arrived — worth remembering when adding a seventh. The full set:
  `/submit` (an approval, a change request or a comment, with every draft
  comment attached), `/comments` in its `now` mode (a line comment, public
  immediately) and in its draft mode (a pending comment, private until
  submitted), `DELETE /comments` (removes one or the whole draft), `/viewed`
  (this account's per-file tick, which nobody else sees), `PATCH /title`
  (renames the pull request) and `POST /merge` (squash-merges it, or adds it to the merge queue when its base branch has one). Everything else here reads: `gh pr view`,
  `gh pr diff`, and a `claude` run over a diff already on disk.

  Submitting posts under whichever account `gh` is signed in as on the box,
  and that is visible to everyone on the pull request.
  Three things guard it. The action is a key into a fixed map, so an unknown
  one cannot become a `gh` flag. A review whose branch has no open pull
  request is refused with a 409 — and the page does not draw the control at
  all in that case, so the 409 is the floor rather than the thing a person
  meets.

  Note what that floor is NOT. It is not `review.kind === 'pr'`: a review's
  target is fixed at launch, but a branch's relationship to GitHub is not, and
  the commonest shape here is a session reviewing its own work that opens a
  pull request hours later. `livePrFor` answers "where can a verdict go now"
  per request, out of `prStatus`'s cache — free, because the launcher's own
  polling keeps it warm — and schedules a TTL-guarded refresh rather than
  awaiting one, so a review opened with no launcher tab beside it has its
  answer by the next load instead of blocking this one. Only an open or draft
  pull request counts; a merged one has nothing left to approve. And the comment goes to `gh` through a temporary file,
  not argv, because Linux caps one argument at 128 KiB and a long review would
  otherwise fail as a spawn error.

- **A merge is refused unless the pull request is still what this page
  showed.** Which write it is comes from GitHub, per pull request:
  `isMergeQueueEnabled` on a fresh read. A base branch with a merge queue
  refuses the direct merge endpoint with a 405, so there it is
  `enqueuePullRequest`, and GitHub squash-merges later under its own commit
  title. Anywhere else it is a squash-merge now, with the title typed on the
  page, through `-f` like every other typed value. An unreadable answer is a
  refusal, not a guess. `review/merge.mjs`
  holds the rules, in `mergeBlocker`: open, not already queued, not a draft,
  approved, head equal to the review's `headSha`, no uncommitted files in a
  worktree review (its `headSha` is only HEAD), every check finished and none
  failed, and no conflict or block reported by GitHub. They are read from a
  fresh `gh pr view` on every request, never `prStatus`'s cache. The checks
  rule is the one GitHub will not enforce for us: a repo may require no
  checks, or only a queue gate that passes on the pull request without
  running, so removing it means red pull requests merge from here. The same
  `headSha` goes to GitHub as the merge's `sha` or the enqueue's
  `expectedHeadOid`, which closes the gap between the check and the write: a
  push in between is a refusal, not a merge of commits nobody read. Never
  `--admin`.

- **The worktree is an ordinary session worktree, and the branch's own hooks
  run.** This is the load-bearing reversal. The repo's `SessionStart` hook fires
  because the path matches `.claude/worktrees/`, which is now wanted:
  `Start app` has to work. `.claude/settings.json` and
  `.claude/hooks/on-session-start.sh` are tracked files, so the ones that run
  are **the reviewed branch's**. Launching a fork's pull request therefore runs
  that fork's SessionStart hook. This is accepted: it is already true the moment
  you press `Start app` on any branch. Do not add a fork restriction here without
  changing that decision first.

- **The shed creates the worktree, not `claude --worktree`.** That flag
  branches off the repo's default branch and has no way to be told otherwise.
  `/run` therefore fetches into `refs/bridge-session/<sessionId>`, does
  `worktree add` onto the branch below, deletes the staging ref, and spawns
  tmux with `cd <wtPath> ; exec claude` and **no** `--worktree` — the same shape
  as `POST /sessions/<n>/resume`, which resumes into an existing worktree for
  the same reason.

- **A pull request from this repo is reviewed on its own branch.** That is what
  makes the review session an ordinary one: `git push` updates the pull
  request, and the rail's pull-request chip finds it by branch name
  (`prBranchFor` in `target.mjs`). Two cases refuse instead of falling back to
  a private branch, because a second copy of the branch splits one pull
  request across two places to push from:
  - the branch is checked out in another worktree (git refuses anyway; the
    error names the session that has it);
  - a local branch of that name has commits the pull request does not
    (moving it would drop them).

  A local branch that is behind the pull request is fast-forwarded and reused.
  The record's `ownsBranch` says whether the review created the branch.

- **Otherwise, a new private branch.** A fork's branch is not on origin, and a
  branch target keeps the old shape: `review/<stem>-<sessionId>`, which the
  session id makes collision-free.

- **What Kill does to the branch depends on which one it is.** `git worktree
  remove` leaves a branch behind, and a left-behind `review/*` branch pins the
  entire pull request head's objects with nothing left to collect it, so a
  private branch is always deleted: only the exact recorded name, and only
  when it matches `review/<stem>-<8hex>`. A pull request branch the review
  created is deleted only when its tip is already in the reviewed head or in
  `origin/<branch>`; with unpushed commits it is kept and Kill's toast says so.
  A pull request branch that predates the review is never deleted. Nothing
  here ever deletes a remote branch. The Kill and Remove confirmations branch
  on `reviewOwnsBranch`, which answers `'always'`, `'ifPushed'` or `false`.

- **Never `git worktree prune`.** This repo has dozens of live session
  worktrees registered. Removal is always the injected `removeWorktree` on one
  specific path.

- **There is a one-shot boot migration, and it must not be deleted.**
  `migrateLegacyState` removes `refs/bridge-review/*` and any `pr-<n>` /`meta/`
  state under `$REVIEWS_DIR`. Without it that state is stranded forever: the
  change that deleted the TTL and the LRU also deleted the only thing that would
  ever have collected it. It is idempotent by construction (nothing to list, no
  directories to match), so there is no "have I run yet" flag to get wrong. On
  this box it really did find and delete two refs on first boot.

- **The chat has no `--resume`.** Every turn is a fresh `claude -p` like an
  explain, and the transcript the shed keeps in `chat.json` is replayed into
  the prompt — the tail of it, bounded in turns and characters by
  `trimHistory`, because that replay is the one cost that grows with use. A
  turn that fails is not written to the transcript: the page hands the text
  back to the box, and recording it would replay an unanswered question into
  every later prompt. Polling goes through the explain endpoint, so a chat
  job's id is its askId; it has its own breadcrumb kind so an orphaned chat
  cannot clear the analysis's.

- **An ask panel is a conversation, and the page holds it.** Each question under a file, line or span is still one
  `claude -p` run, but the page sends the earlier turns of that panel in `history` and `buildExplainPrompt` replays the
  tail of them through `trimHistory`, as the chat does. The thread lives in `askState` per anchor, and only an answered
  exchange is added to it. Unlike the chat it is not written to disk: a reload starts the panel afresh.

- **There is no answer cache.** The old one keyed on the head SHA, which was
  sound only because every run re-checked-out to that SHA and `git clean`ed. The
  tree is now live and the head SHA never moves, so the key would go on matching
  after the code changed and the page would show a pre-edit answer labelled
  "cached". Of the three ways out, dropping the cache is the only one that
  cannot be subtly wrong — a tree fingerprint cannot cheaply cover the _content_
  of an untracked file, which is exactly the case where a reviewer asks twice.
  The in-flight join in `index.mjs` still stops a re-ask during a run paying
  twice. The full argument is in `store.mjs`.

- **`--no-session-persistence` on the analysis run is now load bearing.** The
  run's cwd is the session's own worktree, so a transcript would land in the
  same `~/.claude/projects/...bridge-<id>` directory as the interactive
  session's and be the newest `.jsonl` there — `readTranscriptTail()` would show the
  analysis's output as "what claude last said" and Resume would reattach to it.

- **The orphan sweep checks for `-p`, not just cwd.** It used to identify a
  review's `claude -p` child by its cwd, "a path nothing else on the box uses".
  That is now false: the analysis and the session's own interactive `claude`
  share a working directory by design, and both are `claude` in `/proc`. The
  cmdline is split on NUL and whole argv entries are compared — a substring
  search would match `--permission-mode`, and the prompt (kilobytes of pull
  request content) is on that argv too. Two flags are required rather than one,
  because `-n <name>` lets a session name put one attacker-chosen standalone
  entry on an interactive argv.

- **The output schema has no `maxLength`.** Capping there made the harness burn
  five structured-output retries and return nothing, at ~$0.50 a run — a real
  run produced a 1067-character preamble against a 700 cap. Length is trimmed by
  `clamp()` after the fact, where overrunning is free. There is a regression
  test.

- **`questions`, `architecture` and `decisions` are required fields, and there
  are deliberately no more.** Left optional, models simply omit them, exactly as
  they omitted `role`. An empty questions or decisions list is legal; a missing
  one is not. `questions` (what a reviewer has to answer before approving, each
  with the changed files that answer it) shares one section with the decisions
  on the page, under the overview; a path not in the diff is dropped from it by
  `reconcileArtifact`. A glossary, a problem statement, a what-to-check list and
  a tests list were each added as sections and cut again — every one read well
  on its own and together they made the page longer than the diff it
  introduces. If a new section is proposed, that is the bar: it has to earn its
  place over the ones that are there.

- **`reconcileArtifact` guarantees every file in the diff renders exactly
  once**, whatever the model returns. `page.mjs` guards it a second time.
  Losing a file because a model forgot to mention it is the worst bug this
  feature could have.

- **Breadcrumbs are per job kind.** An analysis and an explain run concurrently
  for the same session; a single `job.json` meant the explain deleted the
  analysis's, leaving a live child unreapable.

- **The ask panel's state is a module, not four variables.** Four separate bugs
  shipped from deriving panel state at render time off a "currently open"
  variable the handlers had already reassigned. `askState.mjs` documents all
  four and the invariants that replaced them. If you are about to add a fifth
  targeted fix, read that header first.

## An idle `claude` writes no transcript. Measured.

This decides whether a prompt-less review session can be resumed, because
`listResumable()` requires a `.jsonl` under `~/.claude/projects/`.

The experiment, run on this box on 2026-08-18 against Claude Code v2.1.222:
`git worktree add` a fresh `bridge-<8hex>`, `tmux new-session -c <wt> "exec
claude"`, and wait.

- At 24s the SessionStart hook had finished (the app's env file written).
- The pane showed a fully booted, idle prompt.
- After **7 minutes** there was still no `~/.claude/projects/...bridge-<id>`
  directory at all.
- Sending one message created the directory and the transcript within **5
  seconds** — the negative control, which proves the test can detect one.
- That transcript's fifth record is the SessionStart hook attachment, carrying
  `cwd`. So the record does exist and does carry `cwd`; it is simply not
  flushed until the first user message.

**Consequence, and it is handled:** a session launched with no prompt and never
spoken to is not resumable. `Stop` on it would end the tmux session, drop it out
of Active, fail to appear in Resumable, and silently keep a 130 MB worktree that
only Kill could reclaim. `listSessions()` therefore reports `hasTranscript`, and
the card disables `Stop` with an explanation until there is something to resume.
This is general — it is right for any prompt-less session — but a review
launched with a blank prompt is the only way to reach it routinely.

## Testing

`node --test review/*.test.mjs` — also run by `install.sh` before it installs
anything, alongside the shed root's own suites (44 here, 89 in total). The
count was cut to 31 once, from 97.

The suite was deliberately cut to what guards a property whose failure would be
**silent and expensive**. A test that demonstrates a regex works is a test
nobody reads and everybody trusts, and it was removed. What survives either
caught a real bug or would have caught one this feature actually shipped.

Fixtures are recorded from real runs (`__fixtures__/pr-23792.patch`,
`analysis-stream.jsonl`). **Do not stub the `claude` binary to make an
end-to-end test deterministic** — a fake binary emits whatever the test expects
and passes for the wrong reason, which has already happened in this directory's
history. Test the reducer, the extraction and the reconciliation against the
recorded transcript instead, and verify the live path by driving the real thing
in a browser.

Two traps when running a test instance:
`TMUX_TMPDIR` does not isolate anything when the session is itself inside tmux
(`$TMUX` wins — use `env -u TMUX`), and UNIX socket paths cap at ~108
characters, so the socket dir has to be short. A test instance also needs
`WOODSHED_REVIEWS`, `WOODSHED_TTYD_BASE` and
`WOODSHED_SHELL_BASE` pointed somewhere of its own — the ttyd ones are no
longer just about not fighting for ports, because an instance reaps stale ttyds
across its whole range at boot, so sharing a range kills the live service's
terminals. But note that its worktrees still land in the **real** repo, because
that is the thing under test.

## A second host: Woodshed sessions

`index.mjs` and `page.mjs` also run inside Woodshed sessions
(`woodshed/session/reviewShed/`), which supplies the `ctx` this
file's header describes and calls `ensureWorktreeReview` to open the page on a
session's own checkout without the launcher. The session image ships every
file this module imports from an allow-list, and a session test fails when a new
import is missing from it: when you add one, add it to
`woodshed/session/Dockerfile` and `Dockerfile.dockerignore`.
