One env file of a repo, or its instructions, as the layers a session writes it from, top to bottom in that order, on
Console settings → Repos → *repo* (`/console-settings/repos/<project>`) and on My settings' **Repo settings** card. A
later layer wins.

- A `line` box with `radius-lg` corners, inside the page's card. Its head is the file's path in `meta` mono, 600, then `key <key>` in `meta`.
- One row per layer, divided by `line-soft`: a grey tag with the layer's word (`stopped` fill, `sub` text, the Tag
  shape), then its title in 600. **Repo** · From the repo, **Installation** · This installation's values, **Session** ·
  Set by the session. My settings adds **Person** · Your values (**Person** · Your instructions) between Installation
  and Session, and there the Installation layer is read only.
- From the repo: the `defaults` lines, read only, mono on `stopped`, then "Change it in `.woodshed/project.yaml` ↗",
  a link to the file on GitHub. No defaults says "No defaults." in `meta`.
- The editable layer: a `meta` mono line saying when it was saved, by whom, its size and how many keys, or "None
  yet." A saved value stays hidden behind **Show and edit** (outline), as on Secrets & webhooks, since reading it is
  logged; then a mono textarea, **Save** (the card's one `btn-open`), and quiet **Clear** and **Hide**. Save is off until
  the text changed. Clear asks first, and says what a session reads instead. Under it, the no-production-credentials
  rule, every time.
- A refusal from the console (a 400, 409 or 502) is a `form-error` line right under the buttons, in the console's own
  words, and never repeats the text. What was typed stays in the field.
- Set by the session: the keys of the file's `lines`, those written only when the session has a value, and the
  project file's `env`, each as mono `code`, with why they win.
- What a session gets: a table, one row per key any layer sets: Key (mono), Repo, Installation, Session, and **Wins**
  as an outlined tag with the layer's word ("Session, if set" for a line that may be left out). A set cell is `✓`; the
  Session cell says `env` or `Woodshed` when the key wins from the environment. Values never appear in it. It scrolls
  sideways on a phone. On My settings it is "What your sessions get", with a **Yours** column after Installation, and
  **Yours** is the Wins word for the person's layer.
- On My settings the installation's values are read only: hidden behind **Show** (outline) once saved, then a mono
  `stopped` block like the repo's defaults, with "Set by your admins" under it. One read fills it and the person's own
  field, which is behind **Show and edit** once saved. Clear is **Clear mine**.
- While a legacy secret may still be read, a `cap-note` says which one the sessions read.
- Several env files are tabs above it (`file-tabs`), labelled by path, `•` on one with a saved value; `?file=<key>`
  opens one, so a link can point at it. On My settings the repos the person can write to are tabs above those, by
  `owner/name`, `•` on one where they keep something; `?repo=<project>` opens one.
- Instructions use the same box without the table: From the repo links its `rules` and `setup` files, and the
  editable layer counts bytes against the 16 KB limit as it is typed (`meta`, `bad` once over, and Save turns off).
- No new colours. Orange only on Save.
