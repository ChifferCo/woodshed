A change something asked for that a person must approve before the console makes it with its own credentials: turning
on a repo's review (`console/reviewSetup.mjs`, page `public/reviewSetup.js` at `/review-setup/<id>`). One page per
request, from the link the asker was given.

- The page head says what approving does, as a `title` sentence naming the thing: **Turn on review for acme/game**.
  Under it one `sub` line: who asked (a session's title, linked, and whose it is, or `@login`), how long ago, what is
  asked for, and when it expires while it waits.
- One `stopped` section (`secret-form`) headed **Approving it changes this** while it waits, **What was done** once
  decided (**Nothing was changed** when refused), with the status pill beside it: `Waiting for approval` (plain),
  `Applying` (`is-work`), `Applied` (`is-ok`), `Failed` (`is-bad`), `Refused` (plain). Never `wait`'s yellow: a request
  is not a session that needs a person.
- The steps are a checklist (`components/Checklist`), one row each, in the order they run, each a sentence a person
  would say (**Add .github/workflows/woodshed-review.yml on main**). Before a decision: a step that changes something is
  **next**, one already so is **done** and says so in its own words, one the console may not do is **failed** with what
  it lacks after ` · ` (`needs Workflows: write`). After: done, failed with GitHub's reason, or next for those never run.
- A file the step writes is folded under its row (`<details>`, its summary `slate` 600, **Show <path>**), the whole file
  in a `layer-pre`: the approver reads exactly what will be committed.
- What approving gives away is said plainly in a `sub` paragraph under the steps (the console's key, readable by every
  workflow in the repo). Why it cannot be approved now is a `form-error` sentence that says what to do.
- **Approve and apply** is the one orange button, disabled with the reason above it when the viewer may not approve; it
  shows `Applying…` with the ring while the console works. **Refuse** (or **Withdraw**, for whoever asked) is outline.
- A History list follows: each event's time in mono `meta`, what happened and by whom.
