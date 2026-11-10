# Contributing to Woodshed

Thank you for helping. Before your first pull request, read [CLAUDE.md](CLAUDE.md): it has the rules for secrets,
and where to look when something breaks.

## Working on Woodshed

Woodshed has no dependencies and no build step. Clone it and run `node --test`. For a change to the console's pages,
`node console/bin/devConsole.mjs` runs the console with made-up sessions, so you can check the page in a browser.

## Pull requests

Pull requests are welcome, from anyone. For a large change, open an issue first so we can agree on the approach.

Every contribution is accepted under the [Woodshed Contributor License Agreement](CLA.md). It lets ChifferCo, Inc.
publish your contribution under Woodshed's licenses, the commercial one included. You keep the copyright in your work.
Agree to it before your first pull request is merged: CLA Assistant (cla-assistant.io) asks you to sign on that pull
request once it is set up here, and until then, comment on it "I have read the Woodshed CLA and I agree to it." A pull
request from someone who has not agreed to it is not merged.

The checks on a pull request from a fork run after a maintainer approves them.

## Licenses

Woodshed is copyright ChifferCo, Inc., and licensed in two parts ([COPYRIGHT](COPYRIGHT) says which covers what):

- `ee/`: a [commercial license](ee/LICENSE) from ChifferCo, Inc.
- Everything else: [AGPL-3.0-only](LICENSE-AGPL).

Contributions are accepted under the [Contributor License Agreement](CLA.md). Code outside `ee/` never imports from
`ee/`.
