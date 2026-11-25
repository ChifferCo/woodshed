Which agent the Chat and TUI tabs show, when a private session's owner started more than one in it
(`session/agents.mjs`). `session.js` draws it (`agentSwitch`) on the pane bar, after the tabs, while Chat or TUI shows,
and only for the owner of a running private session whose image can start them. A private Claude Code, Codex, Grok
Build or OpenCode session can start Claude Code and Codex agents alongside its own.

- **The switch**: a `pbtn` with a `bar-well-line` border, in `bar-ink`: the agent shown and its model when one was
  picked (`Claude · opus`), then in `bar-sub` how many agents the session has (`3 agents`) once it has more than one, and
  ▾. When another agent than the one shown needs you, `1 needs you` in `bar-amber`, the bar's needs-you colour, and the
  border turns `bar-amber-line`. A status is a word here too: never the colour alone.
- **Its menu** is the page's one menu (MenuGroups): under **Agents**, a row each, the session's own first (`Codex (the
  session's own)`), the one shown with ✓, each with its state word and, for one started beside it, its permission mode
  and effort in the note. Under **Start**, **+ Another agent** (while fewer than three run beside it) and, for an agent
  started beside it that is shown, **Stop Codex** in `bad`, last.
- **+ Another agent** opens the `confirm` dialog (TextDialog's look): a sentence saying it works in the same checkout, New
  session's four choices two by two (Agent, Model, Effort, Permissions; Codex's models from the catalog), an optional
  first message, then Cancel and **Start agent**, orange. While it starts, both are disabled and the action says
  `Starting…`; a refusal stays in the dialog as a `form-error`. It picks the other agent first: a second opinion is the
  usual reason to start one.
- Never orange on the bar: switching agents is not the view's primary action. On a phone the switch stays, on a row of
  its own under the tabs, since it is how Chat and TUI reach another agent there. The session's ⋯ menu also offers
  **+ Another agent** on every tab when the owner can start one. Starting from outside Chat or TUI opens Chat with the
  new agent selected.
