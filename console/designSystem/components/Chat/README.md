The Chat tab (`public/chat.js`): a running session's conversation, read from the agent's own record of it, in place of
its terminal. One column, at most 800px wide and centred in the pane, on `ground`, over a composer pinned to the foot.

- **The person's message**: on the right, at most 85% of the column, a bubble on `slate-tint` with a `line` border and
  `radius 14 14 4 14`, `ink` text as typed (line breaks kept). One sent from the page that the record does not hold yet
  has a dashed border and a `meta` mono line under it: `Sending…`, then `Sent, waiting for claude`.
- **The agent's reply**: plain text on the ground, no bubble, 14.5px at 1.65. Markdown is drawn: headings as 15.5px
  700, lists with `meta` markers, quotes with a 3px `line` rule in `sub`, inline code on `stopped` with a `line-soft`
  border, tables with `stopped` heads, and fenced code in a `line` box (`radius 8`) whose head is the language in
  `meta` mono and a `slate` **Copy**. Links are `slate`, and only http(s) or mailto.
- **A work log**: the tool calls between two messages, one box on `stopped` with a `line` border (`radius 8`). Its
  line is a ▸ then what was done, in words (`Ran 3 commands, edited 2 files`), `ink` 600, and `N failed` in `bad` mono
  at the right. Open, each call is a mono row: the tool's name in `slate`, what it was asked in `sub` (cut to a line),
  and `failed` in `bad`. The log of the turn still running is open, with the `slate` ring; once the turn is over it
  folds, unless the person opened or closed it.
- **A question the agent asked** (claude's AskUserQuestion): its own box, out of the work log, on `ground` with a
  `line` border (`radius 8`). Its head is `claude asks` in `ink` 600 and, at the right, where it stands in `meta` mono
  (`Waiting for your answer`, `Answered`, `Not answered`); then each question in `ink` 600 and its options as a
  numbered list in `sub`. It is read-only: the answer is given in the terminal, which the Needs you line opens.
- **A note**, such as `Interrupted` or older messages being left out: centred `meta` mono, 11.5px.
- **The status line**, over the composer: a word, never a colour alone. `Working` in `slate` 600 with the `slate` ring
  and the turn's clock in `meta` mono. `Needs you` is the only `wait`: a `wait` border round the line, the word in
  `wait`, what is asked in `sub`, and an outlined `wait` **Answer in the Agent tab**. `Claude exited` in `ink`. Nothing
  when the agent is done.
- **The composer**: a `line` box on `ground`, `radius 12`, `amber` border while focused (the focus ring). The field has
  no border of its own, 15px (16px on a phone, which iOS will not zoom). Under it: the agent's name in a mono `line`
  pill, a `meta` hint (`Enter to send · Shift+Enter for a new line`, none on a phone), then quiet 32px icon buttons (the paperclip for files,
  the mic, `bad` while it listens), **■** Stop, outlined on `ground`, only while the agent works, and Send, the arrow on
  `action` with `action-ink`: the view's one primary action. Send is `chip-count` with `meta` while there is nothing to
  send. Files waiting to go are mono chips on `chip-count` over the field.
