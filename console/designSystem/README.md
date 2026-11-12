The look of the Woodshed console (`woodshed/console/public/style.css`) and its rail. Build mocks and console changes from these tokens; do not add a palette of your own.

## Content fundamentals

- Write short, plain sentences in the console's voice. Name things by what people recognize: "Resume", "Take it", "New session", "My settings", not "webhook config".
- A control says what happens. Buttons are verbs or "+ New session". Errors say what went wrong and what to do: "Slack has no active user U0NOSUCH999: give a member ID or @handle."
- Sentence case everywhere except group labels, which are uppercase `group-label`.
- A status is always a word. "Paused", "Needs you", "Working", "Done". A dot or color never stands alone.
- No emoji. Use the glyphs the console already uses: `▾ ▸ ✓ ✗ ⋯ ☆ ↗`.
- Say "Mine" and "Everyone" for the rail's two views, "People" for the filter on Everyone, "Assigned" and "Private" for the tags.

## Visual foundations

- **Color roles.** Orange (`action`) is only for the one primary action in a view: New session, Resume, Take it, Assign. Yellow (`wait`) is only for a session that needs a person, and for a PR chip in the merge queue, as GitHub colors it. `slate` is for working, in review, waiting on a job, links and the Assigned outline. `green` is done. `bad` is failed. `amber` is the focus ring and the open session's outline, never text.
- **Project colours.** `proj-*` (teal, plum, sienna, rose, violet, moss) say which project a session is on, and nothing else: never a status, a warning or an action. None of them is a status hue, and the palette is fixed, so do not add one or borrow a status colour for a project. A project colour never stands alone: its name is on the filter chip and in the card's tooltip. Two projects never share one.
- **Surfaces.** Page and cards on `ground`; rail groups and stopped cards on `stopped`. Borders are `line`; dividers inside the rail are `line-soft`. No shadows on cards. `menu` shadow only on menus.
- **Type.** `title` (Merriweather) once per page. Everything else is Red Hat Display: `card-title`, `button`, `group-label`. Meta lines, PR chips and counts are JetBrains Mono: `meta`, `chip`.
- **Spacing and radius.** Gaps are `space-2` between cards and head controls, `space-3` for rail padding. Cards are `radius-lg`, rail buttons `radius-md`, form buttons `radius-sm`, the People filter and count chips `radius-pill`.
- **Contrast.** Text meets 4.5:1 on the grounds named in its token note, in both themes. White on `action` is 4.8:1 in light; use `action-ink` in dark.
- **Dark.** Dark follows the device unless the console's settings sheet picked light. Both themes use the same token names.
- **Motion.** None beyond the spinning ring on a PR chip while checks run, and the same ring on a control waiting on the console (Starting…). A checklist's marks stay still: it is drawn again every second.

## The rail

- The rail head is one row: the Mine | Everyone switch, the People filter on Everyone only, and + New session on the right. The rail is 360px wide on a desktop.
- The user menu sits in a footer and opens upward.
- With more than one project, a row of filter chips sits under the head: All with its count, then one per project with its `proj-*` swatch, name and count. They are the legend of the cards' edges, and picking one shows only that project's sessions (the zone counts follow); the pick is kept in the browser.
- A card has two lines. Line one: the title, an ownership tag, then the star and ⋯ marks. Line two: the status word first, then a name only when the card does not already say it, with the PR chips (at most two, older ones folded into a grey `+N` chip; RailCard) or the issue number and Resume or Take it at the right end. Resume is the only filled button on a card. How long a session ran is under its Details, not on the card. With more than one project, the card's left edge is 3px of its project's `proj-*` colour, and the project's name is in its tooltip and its link's accessible name.
- A whole card is the click target. A button on it must stop the click from also opening the session.
- With several apps, Start app is **Start app ▾**, a menu of the apps' labels, and while one runs the button beside
  Open app carries its label (`Admin ▾`), which says which app runs and opens the same menu (`components/AppPicker`).
  One app: one Start app, no menu.
- CPU and memory, the Plan chip and Start app are in the pane bar, never on a card. So is **Editor ↗**, a quiet `pbtn` link to a new tab, never filled. The Plan chip shows the private session's agent's plan (Claude or Codex); only sessions on that agent share its readings and running count, and no chip appears before that agent reports limits: `bar-amber` from 70% of a window, with the word `out` at 100%. Its detail, in the bar's menu, colors a window from 70% `amber` with `amber-ink` for the number, never `wait`: the plan running low is not a session that needs a person.
- A pull request row has two lines, as a card does: its title and its checks' dot, then (`meta`) the project's name and the number, the checks in their colour and how long since it moved, with Open, Resume or Start and a `slate` ↗ to GitHub at the right end. With more than one project it has its project's 3px edge, and the name is always on line two.
- Group heads are `group-label` with a dot and a count. On Mine: Needs you (stopped sessions waiting on you), Active (every live session, those waiting on you first), Finished (shared sessions assigned to you whose pull request is in Slack), Stopped, then Pull requests. On Everyone: Unassigned first (shared sessions nobody has, with a primary **Take it** on each card), then the console's groups.
- A shared session someone has carries the Assigned tag: on Mine the word Assigned, on Everyone the name of whoever has it. Line two names who started a session only where nothing else does: on Mine a shared session someone else started, on Everyone one nobody has (`from <person>`). Who started it is always under Details. The card's ⋯ menu has Assign to me, Hand over to and Unassign; only someone who can be assigned (People) sees them. Someone without Sessions from GitHub has no Mine | Everyone switch: the rail head reads My sessions. **People** on Everyone filters by assignee. A resume keeps the assignee.

## Menus and presses

- A ⋯ menu is a `ground` panel with the `menu` shadow beside its button on a desktop, and a sheet from the bottom of the
  screen on a phone. Neither is ever taller than the screen: the menu stops 8px from its edges and the sheet 40px from
  its top, and either scrolls inside itself. A sheet taller than the screen put its top rows (the app's) out of reach of
  a finger.
- A row is a bold label over a `sub` note. A row that opens a new tab ends its label with ↗ and is a link, never a
  button that opens a window: a phone opens a link on the first tap.
- A press that waits on the console shows it at once, before the answer: the control is disabled and says what it is
  doing, `Starting…` or `Stopping…` with the spinning ring (a menu row on the `stopped` ground, staying open until the
  answer), the app's state moves to starting, and a toast says what happens (`Starting the app: one to three minutes`).
  A phone's bar has no app button, so its state line says `app starting` beside the status word, with the ring.
- A press that does nothing, because something else for the same session still runs, says so in a toast (`Still busy
  with …`). An error is a toast that stays 6 seconds and says what went wrong; an alert only on a page with no toast.

## Menu groups

- A program embedding the console may add a line under the person's name on the user button, in `meta` (mono, `meta`
  color), and nowhere else on the rail.
- It may add groups to the top of the user menu (`components/MenuGroups`): a `menu-label`, then a row per item. A
  choice in use has a `green` ✓ and 600 weight; a note, such as the person's role there, is a word in `meta` at the
  right end. Then a `line-soft` rule.
- Each one is a plain link: never orange, never a button that looks like an action on the session.

## Admin notices

- What waits on an admin (someone asking to join, Woodshed commits the console lacks) is a `menu-count` on its page's
  link, in the avatar menu and the settings list (`amber-tint` pill, `amber-ink` mono count), and one `amber` dot on the
  avatar whose title says what. Never orange, and never on the rail's cards.

## Woodshed card

- First on Console settings. The state is a sentence: "Up to date with …" in `green`, or "N commits behind …" in
  `set-name` weight, the running commit as a mono `rref`. The newer commits are a list, newest first: mono `slate` sha,
  the title cut to one line, then the author and age in `meta`; it scrolls past about ten.
- An update is a checklist (`components/Checklist`) under an Update head with its pill: Updating or Restarting
  (`is-work`), Failed (`is-bad`). Commands and a build's last lines are mono on `stopped`.
- **Update to latest** is the card's one orange button; **Check now** is quiet.

## Setup card

- A member who has saved neither a Claude token nor a Codex sign-in (or whose databases are not ready) sees one card at the top of Mine: `amber-tint` fill, `amber` border, the steps as rows with a `green` check when done. The agent row, Choose your agent, has two outline buttons, Claude and Codex: equal choices that go to that box on My settings, so neither is orange. The databases row appears once either is saved: progress while it copies, and an outline Open My settings button when it failed or never started.
- Show only what a person can do or is waiting on: no "signed in" row, no step for something the console does by itself, and Connect GitHub stays on My settings.
- The same card fills the pane when New session is pressed before a Claude token or a Codex sign-in is saved and the databases are ready.

## Checklists

- A job a person waits on, made of steps (a session's start, Restore a dump), is a checklist: done, now, next and
  failed rows, the running one with a 4px `slate` bar when it can say how far it has got (`components/Checklist`).
- Its status pill says the job's state in a word: `slate` while it runs, `green` when it is done or ready to check,
  `bad` when it failed. Never `wait`: a restore ready to check is not a session that needs a person.

## Invite an engineer

- A quiet pane-bar button (`pbtn`) on a My Woodshed session that copies a link to New session with Work on set to its PR, or its pushed branch. It is never orange: the session's primary action stays the only filled one.
- With no PR and no branch on GitHub yet the button says why in its own words ("Invite an engineer: push the branch first"), sits at 70% and copies nothing. Never copy a dead link.
- The link holds the PR number or branch name and nothing else. The session stays private.

## Commands to copy

- A command a person runs on their own computer is a `value-box` in mono, one argument a line, with its own **Copy**
  (`btn-plain`) beside it and a `meta` line above saying when to use it. Two commands never share a box: copying one
  must never run the other.
- Steps a person follows to get something to paste (My settings' Claude and Codex cards) are a numbered list
  (`cmd-steps`, its numbers in `meta`, 600): each step a line of `ink` text, its command in its own box under it. What
  the step does with the output ("Paste it below and press Save") is its own step, never folded into a sentence.
- Commands a person needs again after the first time stay on the page under a fold (`<details>`, its summary in
  `slate`, 600): Restore a dump's **How to make a dump**. Open before first use, folded after.

## People

- Members are a table: the person, one centred checkbox column per switch (Admin, Sessions from GitHub, Can be assigned),
  Slack, and Remove. Head cells are uppercase `group-label` on `stopped`, with a `meta` note under each switch's name.
  A thin `line` rule sets the feature columns apart from Admin. A switch that needs another is a disabled checkbox at
  45% with a title saying what it needs. Checkboxes take `slate` as their accent. The table scrolls sideways on a phone.

## Ownership tags

- **Assigned**: outlined, `slate` text and border. A shared session someone has. On Everyone it shows the person's name, in sentence case, instead of the word.
- **Private**: filled `private` with `private-ink` and a small lock. A session only its owner sees.
- **Unassigned**: `stopped` fill, `sub` text. A shared session nobody has taken.
- Filled means private, outlined means assigned. Never use a purple or red for ownership.

## Keyboard hints

- A control with a shortcut carries `data-keys` (its id in `public/keys.cjs`) and gets the key hint on hover or keyboard
  focus (`components/KeyHint`): `ink` fill with `ground` text, as the toast, its keys as outlined caps, and
  "Press ? for every shortcut" under it. Never on a phone. It replaces the control's `title`: never both.
- Keys are written for the computer: `⇧⌘O` on a Mac, `Ctrl` `Shift` `O` elsewhere, one cap per key.

## Iconography

No icon set. The console uses text glyphs (`▾ ▸ ✓ ✗ ⋯ ☆ ↗`) and 6px status dots; a stopped session's dot is a ring. A lock on the Private tag is drawn in CSS, not an image. The phone's message box under the terminal is the one place with drawn icons (📎 and the mic, as round buttons): on a desktop, the same actions are outline buttons with words, Attach files and Dictate (Stop while it listens, with a plain "Listening." line in `sub` under the field, no motion).
