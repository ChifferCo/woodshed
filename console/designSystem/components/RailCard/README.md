One session in the rail. The whole card opens the session; the buttons on it do not.

- Line one: title (`card-title`), an ownership tag when there is one, then star and ⋯. On Everyone the Assigned tag is the name of whoever has the session.
- Line two (`meta`): the status word in its color first, so it starts at the same place on every card, then a name only where the card does not already say it: on Mine `from <person>` for a shared session someone else started, on Everyone `from <person>` for one nobody has. In the last 15 minutes before an idle session pauses, an `amber-ink` `pauses in N min` (`timer`) follows. The PR chip or issue number sits at the right end, then Take it or Resume. A PR chip in GitHub's merge queue is `wait` on a 12% wash of `wait`, as GitHub colors it, and says `queued` instead of a mark.
- No running time on the card: it is under the session's Details.
- With more than one project, a 3px left edge in the project's `proj-*` colour (`has-project proj-<key>`), kept through hover and the open session's outline; a row on a phone keeps it too. The project's name is the card's tooltip and part of its link's accessible name, so the colour is never the only sign. A seventh project, past the palette, has a `line` edge.
- Status colors: `wait` for Needs you and Paused, `slate` for Working and Waiting on a job (a ring, since it waits on a machine), `green` for Done, `bad` for Failed. The word is always shown.
- A stopped session is on `stopped`, title at 12px weight 500, with a ring dot.
- The open session has an `amber` outline.
- The consumer provides the session, its status, the PR and the handlers. No CPU, memory or Start app here; they are in the pane bar.
