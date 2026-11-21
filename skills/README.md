# Skills for your own agents

`woodshed/` teaches Claude Code and Codex the `woodshed` command line (cli/README.md): signing in, starting and
following sessions, giving one more time, running a command in one, bringing its ports to `localhost`, and carrying
Claude settings. It works for you, as you: it never reads the CLI's token, and anything waiting on you (a sign-in, an
approval, a session that needs you) it hands back with the link and stops.

These are for the computer you run `woodshed` on. The skills in `.claude/skills/` are a different set: they are for
working on this repository and an installation (setting one up, a project file, debugging).

## Installing it

From a checkout of this repository:

```sh
# Claude Code: every project on this computer
mkdir -p ~/.claude/skills && ln -s "$PWD/skills/woodshed" ~/.claude/skills/woodshed

# Codex
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills" && cp -R skills/woodshed "${CODEX_HOME:-$HOME/.codex}/skills/"
```

The link follows the checkout as you pull; copy it again after a pull for Codex. To give it to one project only, put it
in that project's `.claude/skills/` instead. A new conversation picks it up: ask it
to "start a Woodshed session on acme/app".

The skill says which change each command arrives in, and checks `woodshed --help` before using one, so an older CLI
than the skill is fine. `test/cliSkill.test.mjs` fails when the skill marks a command as on `main` that the CLI lacks,
or one the CLI has as still on its way: the change that adds a command updates its row in the skill's table.
