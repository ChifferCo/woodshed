The look of the Woodshed console (`woodshed/console/public/style.css`) and its rail. Build mocks and console changes from these tokens; do not add a palette of your own.

## Content fundamentals

- Write short, plain sentences in the console's voice. Name things by what people recognize: "Resume", "Take it", "New session", "My settings", not "webhook config".
- A control says what happens. Buttons are verbs or "+ New session". Errors say what went wrong and what to do: "Slack has no active user U0NOSUCH999: give a member ID or @handle."
- Sentence case everywhere except group labels, which are uppercase `group-label`.
- A status is always a word. "Paused", "Needs you", "Working", "Done". A dot or color never stands alone.
- A session absent from the previous page's list shows "Loading…" until its page's lookup answers. Only a successful lookup can say there is no session; a failed lookup shows its error.
- No emoji. Use the glyphs the console already uses: `▾ ▸ ✓ ✗ ⋯ ☆ ↗`.
- Say "Mine" and "Everyone" for the rail's two views, "People" for the filter on Everyone, "Assigned" and "Private" for the tags.

## Visual foundations

- **Color roles.** Orange (`action`) is only for the one primary action in a view: New session, Resume, Take it, Assign. Yellow (`wait`) is only for a session that needs a person, and for a PR chip in the merge queue, as GitHub colors it. `slate` is for working, in review, waiting on a job, links and the Assigned outline. `green` is done. `bad` is failed. `amber` is the focus ring and the open session's outline, never text.
- **Project colours.** `proj-*` (teal, plum, sienna, rose, violet, moss) say which project a session is on, and nothing else: never a status, a warning or an action. None of them is a status hue, and the palette is fixed, so do not add one or borrow a status colour for a project. A project colour never stands alone: its name is on the filter chip and in the card's tooltip. Two projects never share one.
- **Surfaces.** Page and cards on `ground`; rail groups and stopped cards on `stopped`. Borders are `line`; dividers inside the rail are `line-soft`. No shadows on cards. `menu` shadow only on menus.
- **Type.** One family, Red Hat: Red Hat Display for text and the `title`, bold, once per page (`card-title`, `button`, `group-label` too), and Red Hat Mono for meta lines, PR chips, counts and code (`meta`, `chip`). The console serves both itself (`public/fonts/`), each a variable font holding every weight, never from Google Fonts: a family not served there falls back to the system's font. The component previews here load them from Google Fonts, as files opened on their own.
- **Spacing and radius.** Gaps are `space-2` between cards and head controls, `space-3` for rail padding. Cards are `radius-lg`, rail buttons `radius-md`, form buttons `radius-sm`, the People filter and count chips `radius-pill`.
- **Contrast.** Text meets 4.5:1 on the grounds named in its token note, in both themes. White on `action` is 4.8:1 in light; use `action-ink` in dark.
- **Dark.** Dark follows the device unless My settings' Display card picked light. Both themes use the same token names.
- **Motion.** None beyond the spinning ring on a PR chip while checks run or Woodshed's own review or QA is at work on it (then after the word `review` or `QA`, since a status is always a word), and the same ring on a control waiting on the console (Starting…). A checklist's marks stay still: it is drawn again every second.

## The rail

- The rail head is one row: the Mine | Everyone switch, the People filter on Everyone only, and + New session on the right. The rail is 360px wide on a desktop, and 412px in the desktop app on macOS, where its head also holds the window's traffic lights (`desktop/windowChrome.mjs`, below). On a console one person uses there is no switch: the head reads My sessions, over one list of every session in Mine's groups.
- The user menu sits in a footer and opens upward. In the desktop app a bell follows it there (`components/NotificationBell`), its list opening upward too. Beside them, a square quiet button with a sidebar icon hides the rail (⌘.); while it is hidden, a strip down the left edge, on `ground` with a `line` border, holds the same button at the foot to show it again. Neither shows on a phone, where the rail is its own page.
- With more than one project, a row of filter chips sits under the head: All with its count, then one per project with its `proj-*` swatch, name and count. They are the legend of the cards' edges, and picking one shows only that project's sessions (the zone counts follow); the pick is kept in the browser.
- A card has two lines. Line one: the title, an ownership tag, then the star and ⋯ marks. Line two: the status word first, then a name only when the card does not already say it, with the PR chips (at most two, older ones folded into a grey `+N` chip; RailCard) or the issue number and Resume or Take it at the right end. Resume is the only filled button on a card. How long a session ran is under its Details, not on the card. With more than one project, the card's left edge is 3px of its project's `proj-*` colour, and the project's name is in its hover card (or its tooltip without hover) and its link's accessible name.
- A whole card is the click target. A button on it must stop the click from also opening the session.
- Resting the pointer on a card, or focusing its name, shows its hover card beside it (`components/RailPeek`): the whole
  title, the status word and when it next pauses or stops, the agent's last line, each pull request with its checks in
  words, then the branch, agent, last activity, who started it and who has it. It replaces the card's tooltip, holds no
  action, and never shows on a phone.
- With several apps, Start app is **Start app ▾**, a menu of the apps' labels, and while one runs the button beside
  Open app carries its label (`Admin ▾`), which says which app runs and opens the same menu (`components/AppPicker`).
  One app: one Start app, no menu.
- The pane bar is one row: the tabs (Chat, TUI, Terminal, Review), a smaller switch beside them for Terminal's and Review's two views while one shows, while Chat or TUI shows on a private session with more than its own agent possible the agent switch (`components/AgentSwitch`: the agent shown, how many, and how many others need you in `bar-amber`, the status word's colour), the session's name, its status word, issue and PR, Details ▾ (`components/SessionDetails`), then on the right Invite, the meter, **Open ▾**, in a session's last 15 minutes before it pauses or stops `Pauses in N min · Extend` (or `Stops in`; `pbtn pextend`, in `bar-amber` with a `bar-amber-line` border, the bar's one warning), on a My Woodshed session whose app can be shared **Share** (`pbtn pshare`, quiet; **Shared** in `bar-slate` with a `bar-well-line` border while members or a live link open the app, its title saying who; never orange), the app's button and **Stop**. Every button on it is `pbtn` type (Red Hat Display, 600); only numbers are mono. The session's name never shrinks to nothing: as the bar narrows the meter goes first (unless something runs high), then Invite, then Details, Open, Share and the PR chip fold into **⋯**, as on a phone, and narrower still the name and its status take a row of their own over the tabs and buttons. What it leaves out is never lost: Details ▾ (or ⋯) then holds the meter's readings and Invite. On a phone the countdown stays on the status line, in `bar-amber` mono (`ptimer`), and **Extend 1 hour** is in ⋯ with the card's actions.
- CPU and memory, the Plan reading and Start app are in the pane bar, never on a card. The plan and the machine are one quiet meter (`pmeter`): `Plan 68% · CPU 41%` in `bar-sub` mono while all is well, a part in `bar-amber` as it runs high and red when it is out or nearly full, with an amber border then. It opens the bar's menu with each plan window and the machine (CPU, memory with its peak, the checkout's disk), each a bar against its limit, `slate` until `amber` (with `amber-ink` for the number) and `bad` when nearly full. On a phone the CPU and memory badge stays after the status word and opens the machine's dialog. **Editor ↗** and the databases' viewers are under **Open ▾**, never filled. The plan shows the private session's agent's plan (Claude, Codex or Grok Build; OpenCode reports none, so its sessions show no plan); only sessions on that agent share its readings and running count, and no reading appears before that agent reports limits. Its detail colors a window from 70% `amber` with `amber-ink` for the number, never `wait`: the plan running low is not a session that needs a person.
- A pull request row has two lines, as a card does: its title and its checks' dot, then (`meta`) the project's name and the number, the checks in their colour and how long since it moved, with Open, Resume or Start and a `slate` ↗ to GitHub at the right end. With more than one project it has its project's 3px edge, and the name is always on line two.
- Group heads are `group-label` with a dot and a count. On Mine: Needs you (stopped sessions waiting on you), Active (every live session, those waiting on you first), Finished (shared sessions you started or have whose pull request is in Slack), Stopped, then Pull requests. On Everyone: Unassigned first (shared sessions nobody has, with a primary **Take it** on each card), then the console's groups. Both end with Reviews and QA (sessions the console started to review or QA a pull request: each one still going, and the last that ended of each kind on each pull request), folded until opened: they run by themselves, so they are never Unassigned and carry no **Take it**, nor Assign to me, Hand over… or Unassign in their ⋯ menu. A status chip on the phone's Everyone shows those of that status in it.
- A session that has seen production data carries the Production tag (`prod`, `components/Tag`) on its card in place
  of Private, on every rail, and **Production data** on its pane bar after the status word. Its pane has no Share, Editor ↗ or Sign in for Remote Control, and its Details say since when. Never a status color: it is still
  Working, Needs you or Paused like any other.
- A shared session someone has carries the Assigned tag: on Mine the word Assigned when it is yours, and the name of whoever has it for one you started and handed over; on Everyone the name of whoever has it. Line two names who started a session only where nothing else does: on Mine a shared session someone else started, on Everyone one nobody has (`from <person>`). Who started it is always under Details. The card's ⋯ menu has Assign to me, Hand over… (one row, whose dialog picks the person from a dropdown) and Unassign; only someone who can be assigned (People) sees them. Someone without Sessions from GitHub has no Mine | Everyone switch, nor has anyone on a console one person uses: the rail head reads My sessions. Mine holds the shared sessions you started as well as those assigned to you. **People** on Everyone filters by assignee. A resume keeps the assignee.

## Settings pages

- A group's note is one sentence. An open row does not repeat its closed line: it says how to change the setting, or the one consequence. A second sentence is only a warning that prevents a mistake.
- My settings is groups of rows that open in place (`components/SettingsRows`), not a column of cards: Sign-ins,
  Sessions, Kept for you, Repos and files, Display, then Remove My Woodshed alone. A row says the setting's name, what
  it is now and its status word; several may be open at once. The groups show under My settings in the settings list
  while it is the page shown, as Settings' tabs do under Settings: each a link to its group, none ever marked, since
  all are on the one page.
- Every settings page is groups of rows that open in place, a program's own pages too: never a column of cards. Only a
  list read across, such as People's members or a ledger, stays a table, in a group's box. My settings is Sign-ins,
  Sessions, Kept for you, Repos and files, Display, then Remove My Woodshed alone.
- A program embedding the console draws its pages with the same components, rendered on its server
  (`console/settingsMarkup.mjs`): in the settings frame, as groups on a repo's settings page, or as a page that stands
  alone. It adds no component of its own; one it needs is added here first, for every page to have.
- A group's totals (how many people, what is held, how full a pool is) are figures (`components/Figures`): label, value
  in mono and a line under, in the group's box, never a column of cards. A list of records is still a table.
- A few things each set on or off at once, such as who reviews your pull requests on My settings, are an on/off grid (`components/OnOffGrid`): radios under Off and On, a row each, saved as they are picked.
- Two or three exclusive choices whose difference matters, such as an MCP server's Ordinary or Production, are choice
  cards (`components/ChoiceCards`): side by side, each a title and one line saying what it does, the picked one in the
  `amber` outline. A choice with a cost (Production) fills with its own colours (`prod`) when picked, with a callout under
  the cards saying what will happen. One not available here stays, disabled, and says why.
- Some of the console's repos, or all, is a repo pick (`components/RepoPick`): a fold whose summary says the pick, over
  **All repos** and a checkbox per repo. A saved repo the console no longer has stays listed, ticked. Never a typed list.
- A server or anything the console calls on a person's behalf is tested before it is saved: the button says
  `Testing…`, a failure is a `form-error` with a quiet **Add anyway** beside it, and the form keeps what was typed.
  A saved one's row has a quiet **Test**, whose answer is a line under the row.
- An HTTP header's name is shown in Title-Case (`Authorization`, `X-Api-Key`), whatever case it is kept in.
- Each settings page has a quiet `Only you` or `Everyone` tag beside its title, and the settings rail has a search at its top (`components/SettingsSearch`).
  Name a card by whose it is when the same thing exists on both sides: "My repo settings", "My session timeouts".

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
  color), and nowhere else on the rail. The settings pages' side head shows the avatar alone, neither the name nor that
  line, so **‹ Back to sessions** is never cut.
- The user menu, top to bottom (`components/MenuGroups`): the name and @handle; My settings, then the program's pages
  for the person, and a `line-soft` rule; the program's switcher groups; **Console**; the program's own sections; Sign
  out. With no program, My settings alone is under the name.
- A switcher group is a `menu-label`, then a row per item. A choice in use has a `green` ✓ and 600 weight; a note, such
  as the person's role there, is a word in `meta` at the right end.
- A section is a `menu-label` and its entries; an entry's own pages are under it as Settings' tabs are (below,
  Settings), always in the menu.
- The settings side list has the same groups, each a `side-group` heading: **You** (My settings, then the program's
  pages for the person), **Console**, the program's sections, then **This browser**. A program's entry has a `○` in
  the icon column, and its own pages open under it only on those pages. Its page has its own title (the entry's name)
  and, when it has pages of its own, their row under it, as Settings has its tabs.
- Each one is a plain link: never orange, never a button that looks like an action on the session.

## Admin notices

- What waits on an admin (someone asking to join, Woodshed commits the console lacks) is a `menu-count` on its page's
  link, in the avatar menu and the settings list (`amber-tint` pill, `amber-ink` mono count), and one `amber` dot on the
  avatar whose title says what. Never orange, and never on the rail's cards.

## Woodshed card

- First on Console settings, as a settings row (`components/SettingsRows`): closed, it says the running commit, when
  it was checked and its pill (**Up to date** `is-ok`, **N commits behind** `is-warn`, Updating, Restarting, Failed),
  and it stays open while an update runs. Opened, the state is a sentence: "Up to date with …" in `green`, or "N commits behind …" in
  `set-name` weight, the running commit as a mono `rref`. The newer commits are a list, newest first: mono `slate` sha,
  the title cut to one line, then the author and age in `meta`; it scrolls past about ten.
- An update is a checklist (`components/Checklist`) under an Update head with its pill: Updating or Restarting
  (`is-work`), Failed (`is-bad`). Commands and a build's last lines are mono on `stopped`.
- **Update to latest** is the row's one orange button; **Check now** is quiet.

## Setup card

- A member who has saved no Claude token and no agent's sign-in (or whose databases are not ready) sees one card at the top of Mine: `amber-tint` fill, `amber` border, the steps as rows with a `green` check when done. The agent row, Choose your agent, has one outline button per agent (Claude, Codex, Grok, OpenCode): equal choices that go to that box on My settings, so none is orange. The databases row appears once either is saved: progress while it copies, and an outline Open My settings button when it failed or never started.
- Show only what a person can do or is waiting on: no "signed in" row, no step for something the console does by itself, and Connect GitHub stays on My settings.
- The same card fills the pane when New session is pressed before a Claude token or an agent's sign-in is saved and the databases are ready.

## A repo that needs setup

- A repo sessions cannot start on is a blocker card (`components/BlockerCard`): the repo, the word **Needs setup**
  (`pill is-warn`), the reason in one sentence, then the fix as numbered steps for an admin, or whom to ask and a
  message with **Copy** for anyone else. Its links are `btn-plain`, never orange.
- New session never opens on it while another repo can start. The repo picker is always shown, the only repo as text
  with Add a repo (admin) or a line saying an admin can connect another; a blocked repo stays in the list with
  `— needs setup`, and picking it puts the card in place of the prompt and Start. Nothing on the rail or the New
  session button changes for it.
- Console settings' Repos group says **Ready** (`pill is-ok`) or **Needs setup** on each repo's row, with the card's
  reason and fix inside a row that needs it.

## Checklists

- A job a person waits on, made of steps (a session's start, Restore a dump), is a checklist: done, now, next and
  failed rows, the running one with a 4px `slate` bar when it can say how far it has got (`components/Checklist`).
- Its status pill says the job's state in a word: `slate` while it runs, `green` when it is done or ready to check,
  `bad` when it failed. Never `wait`: a restore ready to check is not a session that needs a person.

## Run log

- A QA or review session that has stopped shows what its run did under its facts, in a fold (`components/RunLog`): a `Run log`
  summary, and opened, a `line`-bordered, 6px-radius panel of mono text on `ground`, 12.5px, wrapped, at most 60vh
  tall and scrolling. Plain text only, never a status by color. It is read when opened, so a closed fold costs nothing.
- The text is the console's own record of the run. An admin and whoever started the run read the full log, with credentials
  taken out (it may still quote what the app printed); everyone else reads a summary of counts and fixed words, and a
  `hint` line above the panel says so.

## Invite

- A quiet pane-bar button (`pbtn`), **Invite**, on a My Woodshed session that copies a link to New session with Work on set to its PR, or its pushed branch. It is never orange: the session's primary action stays the only filled one.
- With no PR and no branch on GitHub yet there is no button: Details says it shows once GitHub has the branch. Never copy a dead link, and never spend the bar's room on a button that does nothing.
- The link holds the PR number or branch name and nothing else. The session stays private.

## Agent

- New session's **Agent** is choice cards (`components/ChoiceCards`), under the prompt and Continue a PR or branch:
  every agent, each its name, what it runs on (`Your Claude plan`) and, in `meta` mono under it, what it would start
  with (`opus · high · auto`; effort only when one is picked or saved), each part kept whole on its line where it
  fits. A default names what it is when the console knows it from the person's shared settings: `opus (saved)` on the
  card and `opus (your last pick)` as the menu's default option, `plan default` and `plan default (Opus or Sonnet)` for
  Claude Code with nothing saved, and plain `default` where the agent picks for itself (Grok Build, OpenCode, or a copy
  the console could not read). Never a model shown as certain that the console cannot know. The pick is in the `amber` outline. An agent with no
  sign-in saved stays, disabled, its line a link to its box on My settings and no settings line. The prompt's
  placeholder names the pick.
- Under the cards, the picked agent's Model, Effort and Permissions are a panel headed `<Agent>'s settings`: the pick's
  `amber` border on `amber-tint`, the field labels in `amber-ink`, open on every width. Each agent keeps its own
  settings while the page is open, a session started from it included, so picking Codex again finds what was picked for it. Never orange: the panel is the
  pick's, not the page's primary action.

## Work on

- New session's Work on, labelled **Continue a PR or branch** with `optional: leave empty to start a new branch`, is a combobox over the project's open pull requests (`components/PullPicker`): type to narrow
  them, or open the quiet ▾ for all. Each row is enough to pick from without GitHub: number, title, Draft, author,
  branch and last update. A pick writes `PR #123` and is named under the field. Anything typed still goes as typed.
- The list is a `menu` surface with rows on `slate-tint` when picked or hovered, never a status color.

## Choosing a Slack channel

- A Slack channel is picked, never typed, wherever one is chosen: the Set up Slack dialog, the Slack card's Change
  channel and a repo's own channel (`components/ChannelPicker`). A search field over a list of the workspace's
  channels, each `#name`, a quiet `private` tag for a private one, and a word for the bot: an `is-ok` **bot is in it**
  tag, or an `is-warn` **invite the bot first**. The pick is on `amber-tint`, hover on `slate-tint`, and a `sub` line
  under the list names it.
- Where Slack will not list them (an app without the scopes), the picker is the channel ID field, with a `cap-note`
  that says which scopes to add. It never shows an empty list as if the workspace had no channels.
- Slack on Console settings is one group of settings rows (Bot, Pull requests, Questions), each saying what it is
  now on its closed row; a row's numbers are in it under a **Limits** head, with no fold of their own. Not set up, it
  is one line with its sentence and the orange **Set up Slack**, its primary action. The dialog's way to connect is a radio card list; an option not yet
  available is disabled, and its own description says why.

## Naming a session

- New session asks for no name. Once the console has named the session, its page shows a rename offer under the title:
  a `menu` surface (`ground`, `line` border, `menu` shadow) with `Named` in `sub` and the name in `ink` 600, a
  `btn-plain` **Rename** and a quiet ×. A 2px `slate` line along its foot runs down over 10 s, when it goes. A click
  anywhere on it keeps it and drops the line; **Rename** turns it into a field with a `btn-plain` Save and a quiet
  Cancel. Never orange: renaming is not the session's primary action.
- To whoever may change when the session pauses and stops (its owner, or a shared one's assignee), the offer also asks
  how long it waits for input and how long it runs: `Pauses after` and `Stops after`, each in `sub` with a small `field`
  select, set off together by a `line` rule on their left (on their own row on a phone). Each one's first option is the
  usual number, `1 h (usual)`; a pick is saved at once, with a toast, and a time the session is already past is greyed.

## Commands to copy

- A command a person runs on their own computer is a `value-box` in mono, one argument a line, with its own **Copy**
  (`btn-plain`) beside it and a `meta` line above saying when to use it. Two commands never share a box: copying one
  must never run the other.
- Steps a person follows to get something to paste (My settings' Claude, Codex, Grok Build and OpenCode cards) are a numbered list
  (`cmd-steps`, its numbers in `meta`, 600): each step a line of `ink` text, its command in its own box under it. What
  the step does with the output ("Paste it below and press Save") is its own step, never folded into a sentence.
- Commands a person needs again after the first time stay on the page under a fold (`<details>`, its summary in
  `slate`, 600): Restore a dump's **How to make a dump**. Open before first use, folded after.

## People

- Members are a table: the person, a **Role** select (Owner, Member, Contributor, Private only), **What they can do**
  (that role in one plain sentence, in `foot`), **Personal tokens**, Slack, and Remove. A role stands for a set of
  switches, so there is one control per person, never a checkbox per switch. Head cells are uppercase `group-label` on
  `stopped`. Members are grouped by role, in the Role select's order, each role a table body of its own under a head row
  (`Owner · 2`, a `rowgroup` heading with the same look as the head cells), and sorted by name within it. Personal tokens names each sign-in the person saved on My
  settings (Claude, Codex, Grok Build, OpenCode, and GitHub once connected) as a green `pill`, or None in `foot`: never
  a value. Invite someone
  (Add someone) picks the role from a table under the handle: a row per role with a radio, a column per power (Private sessions,
  which every role has, then Settings pages, Sessions from GitHub, Can be assigned) that says Yes or No (No in `meta`), and its sentence; the picked row is on `stopped`. Invite comes after the table. The table
  scrolls sideways on a phone.
- People is a tab of Settings (below), titled Settings. Behind a hosting proxy whose program keeps who is in, the
  Role select is the same, Owner being the program's owner; adding is **Add someone**, with the same role table. There is no Asking to join card, no accept or decline, and no asking dot.
  The program's note about a person sits in their `meta` line under the name, where a console of its own says who
  added them; what it says it did on an add ends the hint under the field, in place of "Nothing is sent to them".

## Settings

- The console's own settings are one entry, **Settings**, first in the Console group of the avatar menu and the
  settings list. Its pages are tabs under the title, **General** (`/console-settings`) and **Secrets & webhooks**
  (`/secrets`): the rail's segmented control (`rail-seg`, `rail-seg-link`), links with `aria-current="page"` on the
  open one, never orange. The title says Settings on every tab; the tab's own note sits under the tabs.
- A program embedding the console adds its own pages as tabs after those (`settingsTabs`, README.md "Embedding the
  console"), in the same row, and draws each page's part under it. Someone who is not an admin sees only the program's
  tabs. The row stays one line and scrolls sideways when it is wider than the page, on a phone above all.
- Settings' tabs, the program's with the console's, also show as sub-items under Settings: in the settings list only on
  its own pages (a repo's settings are General's), and in the avatar menu always, since the menu is where people look
  for a page. They are indented on a thin `line` rule at their left (`side-subs` / `side-sub`, `menu-subs` /
  `menu-sub`), the open one marked as any current entry; Settings is then `aria-current="true"`, its icon `amber-ink`,
  not its ground. The tab row under the title stays. On a phone the list is one row, so it keeps Settings as one entry,
  marked, and leaves the tabs to the row under the title.
- People is the console's third tab, after Secrets & webhooks and before a program's, on every console: one place for
  it, never an entry of its own. It shows wherever the console keeps a list of who is in (behind a hosting proxy, only
  when the program hands over its own). Someone asking to join is counted on its tab, and on Settings with any Woodshed
  update, as one `menu-count`. Webhook events is a log, not a setting, and not a
  navigation entry either: Secrets & webhooks links to it (in the GitHub webhook card, or the page's note when there is
  none), its page has a `‹ Secrets & webhooks` crumb above the title, and Settings is marked current in the list on it.
  Its deliveries are plain rows of one box (Settings rows), never a table: when it came in `meta` mono, then what the
  console did (`ink`, 600) over one mono line with the event, what it was on, who sent it and the delivery's id, then a
  pill with the status word: Acted on (`green`), Ignored or Skipped (neutral), Failed (`bad`). On a phone the time
  sits over the text and the pill under it.
- Keyboard shortcuts is in the settings list's This browser group, not in the avatar menu: the menu holds pages, and
  `?` and the command palette open the sheet anywhere. The theme, review files and a session's default view are a group
  on My settings (Display, `⇧⌘,` from anywhere), not a sheet: one place for what is yours, and the group says which of
  its choices are this browser's.

## Repo settings

- A repo's settings are their own page, `/console-settings/repos/<project>`, reached by a quiet **Settings** link on its
  row of the Repos card. The heading is the repo (`title`), with a `‹ Settings · Repos` link above it.
- A row of the Repos card is the repo's name, where it was set, its sessions and, with Slack, where its pull requests go
  (`PRs to C…` or `PRs to the console's channel`, a link to the Slack card), then **Settings** and, for an added repo,
  **Remove**. No field: the channel is set on the repo's page.
- Four groups of rows that open in place (`components/SettingsRows`): **Env files** (a row per env file, by path),
  **Prompt** (Instructions), **Sessions from GitHub** (its two switches on their rows, then the label's name) and **Slack**
  (the pull request channel). A closed row says what it holds. An env file and the instructions are a layered file
  (`components/LayeredFile`): the layers in the order a session writes them, the layer's word as a grey tag, and for an
  env file a table of which layer wins each key. Values never appear in the table, a log or a tooltip: only in their
  own layer's field, behind **Show and edit** once saved.
- With no env files, the Env files group's box holds a short how-to: numbered steps (`cmd-steps`), the YAML in a
  mono `stopped` block, a link to the project file on GitHub (↗), and where the docs are.
- **Slack** is one box of the same shape: the channel ID field (mono), a `meta` mono line saying where the next pull
  request goes, Save and a quiet Clear (back to the console's channel), then a `sub` line on finding the ID and inviting
  the bot. What the channel is for, and what does not use it, are `sub` lines around the box. With no Slack, a
  `cap-note` says so and the field and buttons are off. `#slack` opens the page on it.
- Save is the card's one `btn-open`; Clear and Hide are quiet. A refusal is a `form-error` under the buttons, in the
  console's words, and the typed text stays.
- A non-admin gets the page's frame with one `cap-note` saying it is an admin's: no field, no value.
- My settings has the same layers for each repo the person can write to, under **Repos and files**: a row per repo
  (`components/SettingsRows`), which opens on a segmented control of Instructions, Env files and Your files. Env files
  has each env file's layers with **Person** · Your values between Installation and Session, and a **Yours** column in
  the table. The installation's layer is read only there. `?repo=<project>` (and `&file=<key>`) opens one repo's row.
  tmux is a row of its own after the repos.

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

## Chat

- A running session opens on **Chat**, the conversation as a chat (`components/Chat`); its terminal is the **TUI**
  tab beside it. The agent's replies are text on the ground; only the person's messages are bubbles, on the right.
- Tool calls are never shown one by one in the thread: each run of them between two messages is one work log, said in
  words (`Ran 3 commands, edited 2 files`), folded once its turn is over. A failed call is the word `failed` in `bad`.
- The line over the composer says the agent's state in a word: `Working` in `slate`, `Needs you` in `wait` with a way
  to the TUI tab, where the agent asks. Send is the view's one orange control; Stop is outlined.
- claude's question is answered in its card: options are `line` buttons, the pick on `slate-tint` with a `slate` ✓, and
  **Send answers** is a quiet `btn-plain`. An approval is answered on the Needs you line: **Approve** outlined in
  `wait`, **Deny** and **TUI tab** quiet. Neither is ever orange or green, and a refusal is a `bad` line saying
  `Not answered: …` with a way to the TUI tab.

## Find in a terminal

- ⌘F (Ctrl+Shift+F off a Mac) over a terminal opens a find bar at its top right (`components/TerminalFind`), dark like
  the terminal in both themes: the image viewer's `bar` ground and outlined `bar-well` buttons, never orange.
- Every match is washed `bar-amber-line` and the one shown `bar-amber`, with the terminal's ground as its text. The
  count says `3 of 12`, or `No match` in words, with the field's border `bar-amber-line`. Never a red.
- A terminal whose connection dropped says so in words, centred over it (`public/terminalPage.js`): `Reconnecting…`,
  `Reconnected`, `Connection closed. Press ⏎ to reconnect`. Dark like the terminal in both themes: light `ink` at 92%
  as its ground and dark `ink` as its text, in the system sans. Never orange or red, and no spinner.

## The review page's Q&A

The Review tab frames the review page (`shared/review/page.mjs`), which has a palette of its own; what is written here
holds there too, in its variables. Its **Q&A** tab is a folding tree of a newcomer's questions (`components/QaTree`),
with no section head or intro above it: it opens with its tools row. Every question starts folded, a folded one says how many follow-ups it holds, and its controls (Open all, Close all,
Ask again, Ask the questions) are quiet buttons, never orange. A question being answered says so in words beside its
spinner, and opening one keeps the keyboard focus on it. The reader asks too: an open answer ends with a one-line box
for a follow-up, and the tree with one for a question of their own, each the ask panel's field and a quiet **Ask**
button, never orange. A question they asked says "you asked" in `meta`.

Its **AI reviews** tab (`components/AiReviews`) shows what Claude Code and Codex posted on the pull request, newest
first, each a Discussion `saidbox` whose head is a keyboard disclosure, with each finding as a card and the follow-ups
asked about it under it. A resolved or outdated finding is dashed and labelled, never faded, so its text keeps 4.5:1.
Its **Ask** buttons are quiet, like the Q&A's, never orange. Over the reviews, the pull request's **Merge risk** and **QA**
checks sit as two smaller `saidbox`es, the tier or the QA verdict as a `verdictword` in its tone (`amber-ink` for
`medium` and `running`), the check's title under it and its summary behind a **Details** disclosure.

A session with more than one pull request has a review of each: the review switch (`components/ReviewSwitch`), a quiet
row above the title, only with two or more, lists them as mono pills, the one on screen in `ink` with no link and the
others links in `slate`, never orange.

Its tab bar ends with **Submit review**, then, for an approved pull request, either **Squash and merge** or the merge
hint (`components/MergeHint`): an Octicons info icon whose tip says why merging waits. The bar holds controls, never a
sentence, and no tab or button wraps its label: when they do not all fit on one row, the controls move to a row of
their own under the tabs, right-aligned. On a touch screen up to 720px, where the page turns tips off, the hint shows
its sentence beside the icon.

## Iconography

No icon set. The console uses text glyphs (`▾ ▸ ✓ ✗ ⋯ ☆ ↗`) and 6px status dots; a stopped session's dot is a ring. A lock on the Private tag is drawn in CSS, not an image. The phone's message box under the terminal is the one place with drawn icons (📎 and the mic, as round buttons): on a desktop, the same actions are outline buttons with words, Attach files and Dictate (Stop while it listens, with a plain "Listening." line in `sub` under the field, no motion).

## Asking for one line of text

- A name or an address the person types (Rename…, the payload URL) is asked in the console's own dialog
  (`components/TextDialog`, `W.askText`), never `window.prompt`: the desktop app has none, and the browser's looks like
  the browser, not the console. It is the `confirm` dialog with one field: a title saying what is asked, the field's
  label, Cancel quiet and the action orange, Enter to take it, Escape to drop it.

## The desktop app's window on macOS

- No title bar: the rail head and the pane bar run to the window's top edge, the traffic lights sit at the left of the
  rail head (80px of room there and in the settings pages' head), and those bars drag the window, their controls
  staying clickable. The rail is 412px so its row still fits. The window is never narrower than 900px, the desktop
  layout, so the phone layout never sits under the lights. The app adds this to the console's pages
  (`desktop/windowChrome.mjs`); the console in a browser is unchanged.

## Pages outside the console

- The desktop app's sign-in, in the browser and in the app, is one card on the `stopped` ground (`components/DesktopSignIn`):
  a `title` sentence of where the person stands, one `sub` paragraph, one orange button, and a quiet way back. The
  card that asks before signing the app in names the account and is never shortened.
