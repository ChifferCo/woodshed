# Where to look for serious merge risk in Woodshed

These examples supplement the review rubric. Tie a High rating to a plausible failure introduced by the diff.

- Session boundaries: can a session gain access to another person's data, production credentials, or resources
  outside its intended network or mounts?
- Sign-in and permissions: can a person or project gain access to something they should not be able to see or start?
- Install and upgrade: could an existing installation lose stored settings, sessions or user work, or suffer a
  widespread outage during rollout?
- Actions on a person's behalf: could Woodshed push, merge, post or send data under the wrong identity, to an
  unintended destination, or without the person's authorization?
