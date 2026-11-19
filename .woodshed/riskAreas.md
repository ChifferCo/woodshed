# Merge risk areas in Woodshed

Read from the branch the pull request merges into. Inspect these areas for the consequences in the shared rubric.

- Session variables, tokens, `PER_SESSION_ENV`, network and mounts: can a session reach secrets, another session or
  the host beyond its intended access?
- Console sign-in and authorization: can someone see or start sessions in another person's account or project?
- Installers, upgrades and stored settings: could an existing installation stop working or lose settings, sessions
  or session work? Check mixed versions and rollback.
- GitHub writes: can a change push, merge or post on the wrong repository or person's behalf, or bypass a required check?
