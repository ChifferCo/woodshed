# QA rubric

Read this before planning edge cases and before giving any verdict. The repository's QA notes add what is particular
to its app: how to read what it saved, and the traps that make a working feature look broken.

## Edge cases

What the planner picks edge cases from, by the kind of change.

- **A page or panel:** nothing to show yet, a very long name or value, many items, the data still loading or failing
  to load, and opening it from its deep link rather than by clicking.
- **A form or an edit:** saving with a field left empty, saving twice quickly, cancelling halfway, and reloading the
  page to see the change was kept.
- **An API route or service:** a record saved before the change that lacks the new field, a missing or wrong id,
  another account's id (it must be refused), and the same request sent twice.
- **Background work:** a run that fails partway, a step that is skipped, and the work retried.

## Verdicts

- **❌ only when a stated acceptance criterion, or the pull request's stated intent where it has none, demonstrably
  fails.** Two parts of the app disagreeing, or behaviour that could be read either way, is ❓ with a question for the
  author.
- **Every finding comes from a test case and cites it**, e.g. "(TC-2)". Something only noticed by reading code is not
  a QA finding.
- **Prefer a question to a recommendation.** "Is it intended that…?" rather than "this should…".
- **Argue the other side first.** Before calling something a bug, ask whether it is the correct behaviour.
- **One failure that depends on generated output is not a finding.** If the result depends on what a model wrote, say
  so and mark it ❓ unless it fails the same way twice.
- **The screen and the data must agree.** When the UI says something saved, the data check should show it; when they
  disagree, report what each showed.
- **Look at every screenshot you take.** A blank page, an error overlay, cut-off or overlapping text, or a dialog
  hidden behind another is a ❓ finding even when the text checks passed.
- **Edge cases never fail the pull request.** They are the planner's guesses, not agreed criteria. ⚠️ means the change
  really misbehaves there, with what you saw; ✅ means it held; ❓ means it could not be checked.
- **A review that finds nothing is a fine result.** Do not inflate a nit to have something to say.
