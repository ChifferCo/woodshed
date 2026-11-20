A tag is a small uppercase label on a card's first line, to the right of the title. It says who owns the session, not what state it is in.

- **Assigned**: outlined, `slate`. **Private**: filled `private` with `private-ink` and a CSS lock. **Unassigned**: `stopped` fill, `sub` text.
- **Production**: filled `prod` with `prod-ink` and the same lock, on a private session that has seen production data
  (console/mcpRelay.mjs), in place of Private: it is still its owner's alone, and this says more. It shows on every
  such card, even on a rail that would leave Private out, and on its pane bar as **Production data**, after the status
  word. Its title says since when, what the session still reaches and that all it kept is deleted when it is removed.
- Filled means private, outlined means assigned.
- Tags and status words never share a color. Status is `wait`, `slate`, `green` or `bad`; ownership is `slate` outline, `private`, `prod` or grey.
- PR chips share the row's look (`chip` type): green when open, `bad` with ✗, and a grey `+N` chip, first, for the older pull requests a card has no room for (RailCard).
- The consumer provides the tag word. Keep it one word, except where the Assigned tag is the assignee's name in sentence case: on Everyone, and on Mine for a session you started that someone else has.
