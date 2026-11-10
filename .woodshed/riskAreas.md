# What is always High merge risk in Woodshed

Read by `.github/workflows/review.yml` from the branch a pull request merges into, on top of the review's own list.

- What a session can reach: the variables and tokens a session gets, `PER_SESSION_ENV`, the session image's network and
  mounts.
- The console's sign-in, and which person or project can see or start what.
- The installer and anything that runs on an installation that is already up: upgrades, migrations of its stored
  settings, cleanup that deletes sessions or their work.
- Anything that pushes, merges or posts on a repository on someone's behalf.
