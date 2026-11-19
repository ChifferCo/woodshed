The Slack channel picker (`public/slackSetup.js`, `slackChannelPicker`), on the Set up Slack dialog's last step, the
Slack card's Change channel and a repo's Settings: the workspace's channels from `GET /api/console-settings/slack/channels`.

- **The search**: the form's `field`, `Search channels`. Typing narrows the list after a short pause; nothing typed
  lists them all, the bot's first.
- **The list**: a `line` bordered box up to 240px tall that scrolls, a row each with `line-soft` between:
  - `#name` in `ink`, then a quiet `private` tag (`pill` on `stopped`, `meta`) for a private channel;
  - at the right, the bot's place in it as a word: `pill is-ok` **bot is in it**, or `pill is-warn` **invite the bot
    first**.
  - Hover and focus on `slate-tint`; the pick on `amber-tint`, 600, `aria-selected`.
- Under it, a `sub` line: `Chosen: #name (C…)`, or `No channel chosen.`; and when the list is cut, how many it shows.
- **Without the scopes** (`missing_scope`), or when Slack cannot be read, the picker is a `Channel ID` field in `mono`
  with a `cap-note` saying which scopes to add and to reinstall the app, and where the ID is in Slack. A name typed
  there is refused under it, in `bad`.
