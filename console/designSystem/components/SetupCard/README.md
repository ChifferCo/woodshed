The first-run card for My Woodshed. It lists only what a person can do or is waiting on, so it is short.

- **Choose your agent**: done when a Claude token or a Codex sign-in is saved, since a person may use only one agent. It has two outline buttons side by side, **Claude** and **Codex**, each going to that box on My settings (`/settings#claude`, `/settings#codex`), which scrolls to it and focuses it. Neither is orange: they are equal choices, not one primary action.
- **Your databases**: shown once a Claude token or a Codex sign-in is saved, as `Copying the template: about a minute`, `Ready`, `The copy failed` or `Not started`. It is progress while it copies. When it failed or never started it has an outline **Open My settings** button, so the card never sits with nothing to do.
- No "signed in" row (already true), no step for something the console does by itself, and no Connect GitHub (sessions work without it; it lives on My settings).
- Fill `amber-tint`, border `amber`, a `green` check when a row is done. The compact form (in the rail) drops the hint lines.
- It sits at the top of Mine, and fills the pane in place of the New session form until a Claude token or a Codex sign-in is saved and the databases are ready, which is what the server needs to start a session. It goes once both are true.
- The consumer provides the member's Claude token and Codex sign-in state and database status.
- **Nudged**: when New session is pressed while the card already fills the pane, the card pulses once with a 3px `amber` ring (0.9 s, none under reduced motion) and a toast says to finish setup, so the button never does nothing.
