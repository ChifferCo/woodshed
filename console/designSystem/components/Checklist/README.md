A checklist shows a job made of steps, as it runs: a session's start and a wait for room its launcher reports steps
for (`.start-steps`, session.js) and My settings' Restore a dump (`.restore-steps`, public/dbRestore.js). One row a
step, top to bottom in the order they run.

- Each row: a 16px mark, the step in words, and on the right in mono what it did or is doing (`3 s`, `1,106 items`,
  `412 of 1,030 items`). A step is a sentence a person would say ("Make the copy"), never a function name.
- **Done**: a `green` disc with `✓`. **Now**: an `amber` ring, open on the right, with the row's words in 600 weight and
  its right-hand words in `amber-ink`. **Next**: a `idle-dot` ring, the row in `meta`. **Failed**: a `bad` disc with `✗`,
  the row in `bad` at 600 weight, and what stopped it on the right (`stopped at item 326 of 1,106`).
- A step may carry a short note after its words, ` · ` then the note in 400 weight and `sub` (`.start-note`): what the
  current step is on (`· step 4 of 9`), or on a failed step, in `bad`, what stopped it.
- A step that can say how far it has got carries a 4px bar under its words, `slate` on `line-soft`, `radius-pill`,
  indented to line up with the words. Only the step that is running has one.
- The marks never animate: the list is drawn again every second, so an animation would restart each time.
- Above the list, the job's name on the left and its clock (`m:ss`, mono, 18px) on the right while it runs.
- The status pill beside the section's heading says the job's state in a word: `Sending`, `Restoring`, `Applying`
  (`slate` on `slate-tint`, `.pill.is-work`), `Ready to check`, `Applied` (`green` on `add-tint`, `.pill.is-ok`),
  `Failed` (`bad` on `del-tint`, `.pill.is-bad`). It is the same word the checklist shows, never a color alone.
