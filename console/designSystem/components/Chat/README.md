The Chat tab (`public/chat.js`): a running session's conversation, read from the agent's own record of it, in place of
its terminal. One column, at most 800px wide and centred in the pane, on `ground`, over a composer pinned to the foot.

- **The person's message**: on the right, at most 85% of the column, a bubble on `slate-tint` with a `line` border and
  `radius 14 14 4 14`, `ink` text as typed (line breaks kept). One sent from the page that the record does not hold yet
  has a dashed border and a `meta` mono line under it: `Sending…`, then `Sent, waiting for claude`, or, while the console holds it because the agent is busy, `Not sent yet: it goes in when claude is back at its prompt`, which stays until the agent's record holds it. A held one the session could not take safely (it came back on a
  statusd that types blind) says `Not sent: this session runs a Woodshed that cannot send safely. Type it in the TUI
  tab`, and one sent with no answer in time `No answer in time: it may have gone in…`; each goes ten minutes on.
- **The agent's reply**: plain text on the ground, no bubble, 14.5px at 1.65. Markdown is drawn: headings as 15.5px
  700, lists with `meta` markers, quotes with a 3px `line` rule in `sub`, inline code on `stopped` with a `line-soft`
  border, tables with `stopped` heads, and fenced code in a `line` box (`radius 8`) whose head is the language in
  `meta` mono and a `slate` **Copy**. Links are `slate`, and only http(s) or mailto.
- **A work log**: the tool calls between two messages, one box on `stopped` with a `line` border (`radius 8`). Its
  line is a ▸ then what was done, in words (`Ran 3 commands, edited 2 files`), `ink` 600, and `N failed` in `bad` mono
  at the right. Open, each call is a mono row: the tool's name in `slate`, what it was asked in `sub` (cut to a line),
  and `failed` in `bad`. The log of the turn still running is open, with the `slate` ring; once the turn is over it
  folds, unless the person opened or closed it.
- **What a turn changed**: under the turn's last work log that edited a file, one box on `ground` with a `line` border
  (`radius 8`). Its line is a ▸, `Changed N files` in `ink` 600 (`Changing N files` with the `slate` ring while the
  turn runs), and the turn's `+N −M` at the right, mono, `add` and `del` 600. Open, a row a file in the Diff tab's own
  file row (`rv-file`: a `line` border, `radius 6`, mono 12px, the folder in `meta`, the name in `ink` bold, a `new`,
  `deleted` or `rewritten` tag, its counts), each folding open to its edits' hunks in the Diff tab's lines: `add-tint`
  and `del-tint` rows, `hunk-tint` heads in `slate`. Long lines scroll inside the hunk box, never the page; a cut edit
  or a rewrite says so in a `sub` line. Under the files a `sub` line with a `slate` link to the **Diff tab**: `Commands
  may have changed files too: see the Diff tab.` when the turn ran a command, since the record holds only what the
  edit tools changed. Open while the turn runs, folded once it is over, unless the person opened or closed it; each
  file starts folded. A file the turn edited several times is one row, its edits' hunks in order and their counts
  summed.
- **A question the agent asked** (claude's AskUserQuestion): its own box, out of the work log, on `ground` with a
  `line` border (`radius 8`). Its head is `claude asks` in `ink` 600 and, at the right, where it stands in `meta` mono
  (`Waiting for your answer`, `Sending your answers…`, `Sent, waiting for claude`, `Answered`, `Not answered`); then
  each question in `ink` 600.
  - **Open** (the newest entry, not answered, one option a question): each option is a full-width button, a `line`
    border (`radius 6`) on `ground`, its number in `meta` mono, the label in `ink`; `slate` border on hover. The one
    picked has a `slate` border on `slate-tint` and a `slate` ✓ at the right (`aria-pressed`). Under them, one quiet
    `btn-plain` **Send answers** (**Send answer** for one question), off until every question has a pick, and a `meta`
    line: what to do next, and a `slate` text link to the TUI tab for typing an answer of one's own. Never orange:
    Send in the composer stays the view's one primary action.
  - **Refused**: when the session would not type it (its pane showed another question, or none), a `bad` line over the
    button, `Not answered: <the session's reason>.`, with a `slate` link **Answer in the TUI tab**. The picks stay, to
    send again.
  - **Closed** (answered, declined, or a question that takes several options): the options as a numbered list in
    `sub`, the pick sent from here in `ink` 600. A multi-select question says `This takes several options: pick them in
    the TUI tab`.
- **A note**, such as `Interrupted` or older messages being left out: centred `meta` mono, 11.5px. A turn Esc or ■ Stop
  cut short says `Interrupted` (claude's and codex's alike); codex's turn ended by No at its approval says `Denied: <the
  command>`.
- **The status line**, over the composer: a word, never a colour alone. `Working` in `slate` 600 with the `slate` ring
  and the turn's clock in `meta` mono. `Needs you` is the only `wait`: a `wait` border round the line, the word in
  `wait`, what is asked in `sub`, and an outlined `wait` button. For a question above it reads `claude asks above: pick
  your answers there` with **TUI tab**; for anything else it cannot answer here, **Answer in the TUI tab**. `Claude
  exited` in `ink`. `Not sent` in `ink` when text waits in the agent's box at its prompt (a draft in the TUI tab, or a
  message a prompt cut off), with a plain **TUI tab** button: neutral, not `wait`, since nothing asks for the person.
  Nothing when the agent is done, or once the record ends on an interrupt. A record that ends on an open question is
  Needs you, not Working, whatever the agent's hooks said last.
- **An approval** (claude's permission dialog, codex's approval, read from the pane): until the pane has been read, the
  Needs you line says `Reading what codex asks…`, with no button; then, with no approval on it, the line to the TUI tab
  above. With one, the line says `codex asks: <its own question>` (claude's with what it is, `Bash command: Do you want
  to proceed?`), then what it would run in a mono box on `stopped` with a `line-soft` border (`radius 6`, the reason
  last), then three buttons at the right: quiet `btn-plain` **TUI tab** and **Deny**, and **Approve** outlined in
  `wait`, the line's own colour. While one is on its way it says `Approving…` or `Denying…` and both are off; a refusal
  is a `bad` line in the box, `Not answered: <reason>. Answer in the TUI tab.` Once answered, until the agent's state
  moves, the line is `Approved` or `Denied` in `ink` 600 and `· waiting for codex` in `sub`, with no border. Approve is
  never orange or green: it answers the agent, and the session's state is still the one that is coloured.
- **The composer**: a `line` box on `ground`, `radius 12`, `amber` border while focused (the focus ring). The field has
  no border of its own, 15px (16px on a phone, which iOS will not zoom). Under it: the agent's name in a mono `line`
  pill, a `meta` hint (`Enter to send · Shift+Enter for a new line`, none on a phone), then quiet 32px icon buttons (the paperclip for files,
  the mic, `bad` while it listens), **■** Stop, outlined on `ground`, only while the agent works, and Send, the arrow on
  `action` with `action-ink`: the view's one primary action. Send is `chip-count` with `meta` while there is nothing to
  send. Files waiting to go are mono chips on `chip-count` over the field. A message the console refuses (a session
  started before Chat could send safely, whose statusd would type it blind) goes back in the field, and a toast says
  `Not sent: <why>`.
