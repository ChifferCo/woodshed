# Providers

Where Woodshed runs. The console and the sessions are the same everywhere; a provider supplies what changes from one
place to another, and `console.mjs` here picks one and starts the console on it (`console/server.mjs`,
`startConsole`). Nothing in `console/` or `session/` imports a provider (`test/layout.test.mjs`).

| Provider | Runs on | How to use it |
| --- | --- | --- |
| `aws` | An AWS account of its own: the console on one EC2 machine, each session a Fargate task | [aws/README.md](aws/README.md) |
| `local` | One machine with Docker: the console on the machine, each session a container | [local/README.md](local/README.md) |

On a VM, such as one on Hetzner Cloud, the local provider runs as it is: `local/README.md`, "On a server your team
reaches", says what to decide, with Hetzner's own pieces under "On Hetzner Cloud".

## Picking one

`WOODSHED_PROVIDER` is `aws` or `local`. Without it, `WOODSHED_LAUNCHER` decides, as it always has: `ecs` is
`aws`, and `docker` (its default) is `local`. A setting only one provider serves, such as `WOODSHED_HOMES_BUCKET`
or `WOODSHED_LOCAL_SECRETS_DIR`, stops a console started on the other, naming it.

## What a provider gives the console

`<provider>/index.mjs` returns one object. Every part but the launcher may be `null`, and the console runs without
it: no Secrets page, no saved Claude homes, no databases of its own, or GitHub's poll in place of webhooks.

| Field | What it is | The console uses it in |
| --- | --- | --- |
| `name` | `aws` or `local` | Its start log, and which kind a fixed secret store is on the Secrets page |
| `words` | What the pages say about where a session runs: the start checklist's first steps (`null` leaves one out), the wait when there is no room, the note under the session limits, where homes and databases are kept, and the webhook receiver. `console/providerWords.mjs` lists each and has the defaults, which name no provider | Every page, through `pageShell`'s `woodshed-provider` meta tag |
| `launcher` | `start`, `stop`, `isAlive` and the rest, for session containers | `console/fleet.mjs` |
| `secrets` | `list`, `read`, `write`, `save`, `remove`, over the names in `console/secrets.mjs` | The Secrets page, sign-in, the GitHub App key |
| `homes` | `put`, `get`, `copy`, `remove` and the rest, for saved Claude homes | `console/sessionApi.mjs` |
| `dbAdmin` | `start(command)`, `stop(id)`, `outcomes(ids)`, runs of `session/dbAdmin.mjs` | `console/databases.mjs` |
| `databases` | The databases `dbAdmin` makes a copy of for each session, `postgres` and `mongo` (which needs `postgres`): the installation's own, `[]` without `dbAdmin` | `console/databases.mjs`, the tunnel, Restore a dump and the session page's Data ▾ |
| `webhooks` | `run(handler)`, which hands each GitHub or Slack message to `handler.dispatch` | `console/webhookDispatch.mjs` |
| `webhookUrl` | `() => Promise<string>`, where GitHub should post | The Secrets & webhooks page |

To add one: a folder with an `index.mjs` returning that object, an entry in `console.mjs`'s `PROVIDERS`, its own
settings in `NEEDS` so the other providers refuse them, and a README in the shape of these two: what it gives, how to
set it up, how to use it day to day, how to remove it.
