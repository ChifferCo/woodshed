# Woodshed in the Herdr app

`woodshed/` is a mod for the [Herdr app](https://herdr.dev), the desktop app for terminals and coding agents: a
Woodshed panel beside your terminals. It does nothing itself. Every action runs the `woodshed` command line
(cli/README.md), which holds your sign-in; the mod never sees a token.

- **The panel** lists your running My Woodshed sessions: state, and when each pauses or stops by itself. Click a
  session for its info.
- **New session…** asks for a repo, a branch (or a pull request or issue number), the agent and a prompt, then shows the
  start step by step (`woodshed session new --json`). The prompt may be left out only on a branch or pull request,
  where the session reviews it, as the console's own New session allows. Closing the dialog does not stop the start;
  a start that failed goes back to the form, its fields kept.
- **Session info** shows the session's branch, pull request, when it pauses or stops, and the hours it runs on
  (`woodshed session get`). **Extend** puts the pause or stop off by an hour (`woodshed session extend`). The console
  allows that in the last 15 minutes, so the button waits until then. Nothing keeps a session awake for being
  connected to it, this panel included. **Open on the console** opens its page, whose Open app opens its app: the
  command line has no command for the app's address or its ports.
- **Notifications:** when an agent in a session's machine starts waiting on you, a toast names the session and its
  title. Clicking it focuses the agent. Herdr's own toast still comes too.

A start runs as a herdr-core terminal on this computer, named `woodshed-new-<time>`, so it outlives the dialog and the
window. It stays out of your spaces, and is removed once it ends. `hc ls` lists it meanwhile.

## What it needs

- The `woodshed` command line on your shell's `PATH`, signed in (`woodshed login`). With no sign-in, the panel offers
  **Sign in…**, which runs `woodshed login` in a new tab, where you see the code.
- Its `session` commands, which the command line has had since #279.
- For notifications, a session added to Herdr as the machine `woodshed-<id>`. That is the name `woodshed session
  connect` is to use; until it ships, add one by hand with `woodshed tunnel`:
  `hc machine add --name woodshed-<id> --via 'woodshed tunnel <id> --' --install`.

## Installing it

```sh
cp -R herdr-mod/woodshed ~/.config/herdr-app/mods/woodshed
```

The first time Herdr sees the folder, it docks the panel on the right of the window you are looking at. After that,
your layouts decide where it goes. Notifications come from the panel, so they need it in your layout, shown or not.
`mod.open woodshed` (from the palette) opens it as a dialog instead. For keys, add bindings like these to
`~/.config/herdr-app/keys.json`, on keys you don't already use:

```json
{ "global": { "cmd-alt-w": "mod.open:woodshed", "cmd-alt-n": "woodshed.new", "cmd-alt-i": "woodshed.info" } }
```

`woodshed.info` acts on the focused space's session, when it is on a `woodshed-<id>` machine,
and reach the panel only while it is shown. To remove the mod, delete the folder.

## A link to `http://localhost:<port>` in a session's terminal

A mod cannot handle a click on it. Herdr gives mods no hook on a terminal's text or its clicks: `herdr.d.ts` has no
link event, and `TextView.on_link_click` is for a mod's own text. So the mod cannot see the link and bring that port
here, and the command line has no command to forward one. The session's app is reached from its console page (Open
app). Whether the app opens a clicked URL from a remote terminal in this computer's browser was not tried.

## Checking a change

```sh
herdr-app check herdr-mod/woodshed      # loads it once, as the app would; writes its jsconfig.json and .d.ts there
node --test herdr-mod/*.test.mjs        # each action against a stand-in CLI and herdr-core, and what it reads
```

`check` renders only a copy's first state: try the dialogs in the app. Everything that is not drawing is in
`woodshed/actions.js` (what each action runs, given the command line and `hc` to run) and `woodshed/woodshed.js` (how it
reads their answers), so the tests run it under node.
