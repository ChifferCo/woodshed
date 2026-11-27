Which agent the Chat and TUI tabs show, when a private session's owner started more than one in it
(`session/agents.mjs`). `session.js` draws it (`agentSwitch`) on the pane bar, after the tabs, while Chat or TUI shows,
and only for the owner of a running private session whose image can start them. A private Claude Code, Codex, Grok
Build or OpenCode session can start Claude Code and Codex agents alongside its own. Grok Build can start alongside
another agent with an xAI API key saved in My settings, or alongside a primary Grok Build agent on its existing
sign-in. An extra OpenCode pane starts in an OpenCode session and uses its primary sign-in.

- **The switch**: a `pbtn` with a `bar-well-line` border, in `bar-ink`: the agent shown and its model when one was
  picked (`Claude · opus`), then in `bar-sub` how many agents the session has (`3 agents`) once it has more than one, and
  ▾. When another agent than the one shown needs you, `1 needs you` in `bar-amber`, the bar's needs-you colour, and the
  border turns `bar-amber-line`. A status is a word here too: never the colour alone.
- **Its menu** is the page's one menu (MenuGroups): under **Agents**, a row each, the session's own first (`Codex (the
  session's own)`), the one shown with ✓, each with its state word and, for one started beside it, its permission mode
  and effort in the note. Under **Start**, **+ Another agent** (while fewer than three run beside it) and, for an agent
  started beside it that is shown, **Stop Codex** in `bad`, last.
- **+ Another agent** opens the `confirm` dialog in TextDialog's style. It explains that the agent works in the same
  checkout and shows Agent, Model, Effort and Permissions in a two-column grid. Claude Code and Codex use a Model
  menu, with Codex's choices from the catalog. Grok Build and OpenCode use a Model text field with a `Default`
  placeholder. Leave it empty to use the agent's default, or enter a model ID such as `grok-build` or
  `openai/gpt-5`. Changing agents clears the Model text field. Effort and Permissions follow the selected agent.
  An optional First message sits below the grid, above Cancel and the orange **Start agent** button. Both buttons
  are disabled while the action reads `Starting…`. A refusal appears in the dialog as a `form-error`.
  The dialog selects Codex first in most sessions and Claude Code first in a Codex session.
- Never orange on the bar: switching agents is not the view's primary action. On a phone the switch sits beside the
  session title and before ⋯. It keeps the needs-you indicator, hides the agent count, and truncates long agent or model
  names to leave room for the title. The menu lists each agent by its full name. The session's ⋯ menu also offers
  **+ Another agent** on every tab when the owner can start one. Starting from outside Chat or TUI opens Chat with the
  new agent selected.
