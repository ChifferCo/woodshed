Choice cards are two or three exclusive choices side by side, each with a title and one line saying what picking it
does, where a select would hide the difference. Console settings' MCP servers card uses them for **Ordinary** or
**Production** (`mcpKind` in `public/consoleSettings.js`, `.choice-card` in `public/style.css`).
New session's **Agent** uses them for its four agents (`createAgentCards` in `public/launcher.js`, `.lagents`): the one
place with more than three, since which agent runs is the form's first choice and a select hid what each runs on. They
sit four across, compact (10px 12px padding, a 12px line), two across under 560px. Each card has a third line,
`choice-meta` in `meta` mono, with what that agent would start with (each part an inline-block, so `gpt-5.5 (saved)`
moves to the next line whole), and the picked agent's menus are a panel under the
cards (`.lsettings`: an `amber` border on `amber-tint`, the README's Agent section).

- A `fieldset` whose `legend` is the row's name (`set-name`), then the cards in a grid: two columns on a desktop, one
  under 560px. Each card is a `label` over a native radio (hidden, filling the card), so a click anywhere picks it and
  the arrow keys move between them; the card's line is the radio's `aria-describedby`. Focus shows the `amber` ring.
- A card is `ground` with a `line` border, its title in `ink` 600 and its line in `sub`, with a drawn radio ring in
  `meta`. The picked one has the `amber` outline and a filled `amber` ring, as the Slack dialog's options do. Never
  orange: picking one is not the page's primary action.
- A choice with a cost takes its own colours when picked: Production fills with `prod`, all its text `prod-ink`, and its
  title carries the Production tag's lock. Under the cards, while it is picked, a callout says what will happen
  (`.prod-callout`: a `prod` border, 4px on the left, on `ground`, headed by the Production tag), in a few plain lines.
- A choice not available here stays shown, disabled (`stopped` fill, `sub` text), and its line says why instead of what
  it does. Never hide it. Where a step elsewhere makes it available, the line is that step's link, over the radio
  (New session's `Sign in on My settings` for an agent with no sign-in saved).
