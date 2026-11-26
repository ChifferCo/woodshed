A session's Details: the facts about it under **Details ▾** in the pane bar (`sessionDetails` in `session.js`), and on a
phone at the top of the session's ⋯ sheet.

- A `card-menu-dl` grid of term and value: the term in `meta`, the value in `ink`, 12.5px, a 12px gap between the
  columns and 4px between rows. A value wraps anywhere rather than widen the menu.
- A row shows only when it has a value: Branch, Pull requests (more than one), Started by, Running for, Runs on, Pauses,
  Assigned to, Visible to, Invite, Production data, Started from, Started here, Messages.
- **Started from** and **Started here** name the other sessions as links (`a`, `slate`), joined by commas; one no longer
  on the list is named so, as text.
- **Messages** (`msg-lines`) lists the latest five messages between this session and others of the person's, newest
  first, as they were sent (one held for a session at work or paused is listed when sent, and typed in later), one item each, 6px apart. Each item:
  - the direction in `sub`: **From**, **To**, **Asked** (this session asked a question) or **Asked by**;
  - the other session's name as a link, or `a session no longer on the list` as text;
  - when, in mono 11px `meta` (`msg-at`), then `· may not have arrived` the same way when the console did not hear back
    that it went in;
  - on a line of its own, the start of the message in `sub`, cut to one line with an ellipsis (`msg-text`). The whole
    message is in the receiving session's Chat, or, for a reply handed to a wait, in that waiting command's output.
