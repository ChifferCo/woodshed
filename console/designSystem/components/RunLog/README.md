The run log is a fold under an ended QA or review session's facts (`.run-log-box`, session.js `qaRunLog`): what the run did and how
each claude pass ended, for a run that sent no verdict.

- Closed: a `Run log` summary in 14px, `ink`, with the browser's disclosure arrow. Nothing is fetched until it opens.
- Open: a panel (`.run-log`) of `pre-wrap` text in `--mono` at 12.5px/1.45, `ink` on `ground`, a 1px `line` border,
  6px radius, 10px 12px padding, at most 60vh tall and scrolling. Long lines wrap.
- Its words are the console's own (`## steps`, `## plan`, `## test`), never colored: a status is a word, so `Ended: ran
  out of turns` is in the text. While it loads it says `Loading…`; if it fails, one sentence says so.
- Credentials are taken out before the log is kept (`shared/qa/runLog.mjs`, `redact`).
- Only an admin and whoever started the run get the fold; for anyone else it is not drawn, and the console answers its route 403.
