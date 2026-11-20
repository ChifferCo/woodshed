The card the desktop app's sign-in is told in, on pages that stand alone: no rail, no avatar menu. The browser shows two of
them (`console/desktopSignIn.mjs`), the app two more (`desktop/setup.html`, `desktop/signin.html`), all one shape.

- One `ground` card, `line` border, 12px radius and 32px padding, 440px wide at most, centred on the `stopped` ground,
  with 16px at the screen's edges on a phone. No shadow.
- A `title` heading (Merriweather) that says where the person stands, as a sentence: **Sign in to the Woodshed app?**,
  **You're signed in**, **Finish signing in in your browser**, **Open your Woodshed console**. Then one `sub` paragraph
  that says what happens next and what to say yes to.
- One orange button, the one thing to do: **Sign in to the app**, **Open the Woodshed app**, **Open the browser
  again**, **Open the console**. The way back is quiet: a `sub` link (**Cancel**) or an outline button (**Sign in in
  this window instead**), never a second orange.
- The consent card names the account in bold (`@login`) and says to sign in only after pressing Sign in with GitHub
  in the app: it is what keeps another program from signing itself in, so its words are not to be cut.
- An error is a `bad` line under the paragraph, in words (`That sign-in has expired or was already used. Sign in again
  from the app.`), and the button stays, to try again.
- The app's own pages carry the app's icon above the heading, at 72px with its own margin (`desktop/icon.png`); the
  browser's pages do not, as the console's address bar already says where they are.
- Both themes, from the device: the console's tokens, redefined under `prefers-color-scheme: dark`. These pages load no
  stylesheet of the console's, so each carries the few tokens it uses.
