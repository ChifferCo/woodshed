# Woodshed in the Herdr app

`woodshed/` is a mod for the [Herdr app](https://herdr.dev), the desktop app for terminals and coding agents: a
Woodshed panel beside your terminals. It does nothing itself. Every action runs the `woodshed` command line
(cli/README.md), which holds your sign-in; the mod never sees a token.

- **The panel** lists your running My Woodshed sessions: state, when each pauses or stops by itself, and the ports
  forwarded from it. Click a session for its info.
- **New session…** asks for a repo, a branch (or a pull request or issue number), the agent and a prompt, then shows the
  start step by step (`woodshed session new --json`). The prompt may be left out only on a branch or pull request,
  where the session reviews it, as the console's own New session allows. Closing the dialog does not stop the start;
  a start that failed goes back to the form, its fields kept.
- **Session info** shows the session's branch, pull request, when it pauses or stops, and the hours it runs on
  (`woodshed session get`). **Extend** puts the pause or stop off by an hour (`woodshed session extend`). The console
  allows that in the last 15 minutes, so the button waits until then. Nothing keeps a session awake for being
  connected to it, this panel included.
- **Open app** opens the session's app address in your browser (`woodshed open`), behind the console's sign-in.
- **Forward port…** brings the session's ports to this computer's `localhost` (`woodshed forward`): blank for every
  port it listens on, or `3000 5173:5174`. A port taken here moves to the next free one, and the dialog says so. The
  forward keeps going when the dialog closes, until **Stop forwarding**. While it runs, anyone with an account on this
  computer can reach those ports.
- **Notifications:** when an agent in a session's machine starts waiting on you, a toast names the session and its
  title. Clicking it focuses the agent. Herdr's own toast still comes too.

Long commands run as herdr-core terminals on this computer, named `woodshed-new-<time>` and `woodshed-fwd-<id>`,
so they outlive the dialog and the window. They stay out of your spaces. `hc ls` lists them.

## What it needs

- The `woodshed` command line on your shell's `PATH`, signed in (`woodshed login`). With no sign-in, the panel offers
  **Sign in…**, which runs `woodshed login` in a new tab, where you see the code.
- Its commands as they arrive: `session` (#279) for the list, New session, info and Extend; `open` and `forward` (#281)
  for Open app and Forward port. Before then, the panel shows the command line's own error.
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
{ "global": { "cmd-alt-w": "mod.open:woodshed", "cmd-alt-n": "woodshed.new", "cmd-alt-o": "woodshed.open",
              "cmd-alt-p": "woodshed.forward", "cmd-alt-i": "woodshed.info" } }
```

`woodshed.open`, `forward` and `info` act on the focused space's session, when it is on a `woodshed-<id>` machine,
and reach the panel only while it is shown. To remove the mod, delete the folder.

## A link to `http://localhost:<port>` in a session's terminal

A mod cannot handle a click on it. Herdr gives mods no hook on a terminal's text or its clicks: `herdr.d.ts` has no
link event, and `TextView.on_link_click` is for a mod's own text. So the mod cannot see the link and start a forward
for it.

What works instead: **Forward port…** with every port keeps each port's number on this computer where it is free. A
dev server's `http://localhost:5173`, opened here, then reaches the session's 5173. The exception is a port taken
here, which the dialog shows as moved. Whether the app opens a clicked URL from a remote terminal in this computer's
browser was not tried.

## Checking a change

```sh
herdr-app check herdr-mod/woodshed      # loads it once, as the app would; writes its jsconfig.json and .d.ts there
node --test herdr-mod/*.test.mjs        # each action against a stand-in CLI and herdr-core, and what it reads
```

`check` renders only a copy's first state: try the dialogs in the app. Everything that is not drawing is in
`woodshed/actions.js` (what each action runs, given the command line and `hc` to run) and `woodshed/woodshed.js` (how it
reads their answers), so the tests run it under node.
