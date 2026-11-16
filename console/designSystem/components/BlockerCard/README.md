Why sessions cannot start on one repo, and how to fix it (`blockerCard` in `public/common.js`, from a blocker of
`databaseGate.mjs`: the console's own database check, or an embedding program's `projectReadiness`).

- Head: the repo in mono, then the word **Needs setup** as a `pill is-warn` (`amber-tint`, `amber-ink`). A status is a
  word: never the pill's colour alone. On Console settings' Repos card the row already names the repo and carries the
  word, so the card drops its head there; a repo that can start says **Ready** (`pill is-ok`).
- The reason: one plain sentence in `ink` that names the repo.
- For an admin: the fix as numbered steps (`cmd-steps`), each a line of text, a link under it as a `btn-plain btn-sm`
  with its label (`↗` when it leaves the console). Never orange: the card is not the view's primary action.
- For anyone else: "Only an admin can fix this.", whom to ask as bold `@login`s, and the message to send in a
  `value-box` with its own **Copy** (`btn-plain`).
- On New session, "Pick another repo above to start a session now." when another repo can be picked. The card takes
  the place of the prompt and Start only: the repo picker above stays, the blocked repo listed with `— needs setup`.
  New session never opens on a blocked repo while another can start.
- `ground` fill, `line` border, `radius-lg`, no shadow. The same card is on My settings' Your databases.
