A secret field is where a person pastes a secret the console or a program keeps for them: a token, an API key, a
signing secret. What is pasted is masked from the first character, so it is never on the screen for someone beside
them, or in a screenshot, until they ask to see it.

- A `field` in Red Hat Mono, `type="password"`, with `autocomplete="new-password"` (a browser never fills in a password
  it saved), no spell check and no capitals. Its label says what to paste ("Vault token"), its placeholder
  how it starts (`hvs.…`, `xoxb-…`).
- **Show** (`btn btn-plain`) beside it, at its right on one row, turns the field to plain text to check the paste
  before it is sent, and reads **Hide** while it shows (`aria-pressed`). It never fetches anything: it shows only what
  was typed.
- Its label names the field by `for`, never by wrapping it: a label around the field would wrap Show too, and its
  word would be read as part of the field's name.
- A field left shown is masked again as its form is sent (on the form's `submit` event), so the browser is less likely
  to keep the paste in its form history. A script that sends the form calls `requestSubmit()`, which fires that
  event; `submit()` skips it and sends the field as it is.
- The field is always empty when drawn. A secret that is kept is never sent back to the page: the row says it is kept
  and when ("Kept since 3 May"), and a new paste replaces it ("Leave empty to keep the saved one").
- The sentence under it says the secret is kept sealed and never shown again, when that is so.

The console's own pages draw it in the browser (My settings' Claude token, Settings → Slack's keys, an MCP server's
header value, Secrets & webhooks). A program embedding the console draws it on its server with `secretField` in
`console/settingsMarkup.mjs`, which takes no value and draws its label when given one; `public/hostRows.js` makes its Show work. `.secret-field` in
`public/style.css` lays out the field and its button.
