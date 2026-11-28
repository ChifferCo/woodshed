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
| `launcher` | `start`, `stop`, `isAlive` and the rest, for session containers, and optionally `progress` and `keptMachine` (below) | `console/fleet.mjs` |
| `secrets` | `list`, `read`, `write`, `save`, `remove`, over the names in `console/secrets.mjs` | The Secrets page, sign-in, the GitHub App key |
| `homes` | `put`, `get`, `copy`, `remove` and the rest, for saved Claude homes | `console/sessionApi.mjs` |
| `dbAdmin` | `start(command)`, `stop(id)`, `outcomes(ids)`, runs of `session/dbAdmin.mjs` | `console/databases.mjs` |
| `databases` | The databases `dbAdmin` makes a copy of for each session, `postgres` and `mongo` (which needs `postgres`): the installation's own, `[]` without `dbAdmin` | `console/databases.mjs`, the tunnel, Restore a dump and the session page's Open ▾ |
| `webhooks` | `run(handler)`, which hands each GitHub or Slack message to `handler.dispatch` | `console/webhookDispatch.mjs` |
| `webhookUrl` | `() => Promise<string>`, where GitHub should post | The Secrets & webhooks page |
| `slackEventsUrl` | `() => Promise<string>`, where Slack's Event Subscriptions should post: the receiver's `/slack` | The Set up Slack dialog and the app manifest it gives (Console settings, Slack) |

### A secret store's limit on one value

A `secrets` store may declare `maxValueBytes`: the most bytes it holds in one secret's value. The AWS store declares
65,536 (Secrets Manager's own limit) and the local store 1,048,576. A store that declares none is held to 65,536, so
the default stays safe. Today only Your files, on My settings' Repo settings, reads it: all of a person's files for one
repo are one secret, so a save over the limit is refused naming it (`your files for <repo> together are over the 1024 KB
this console's secret store holds`), and the console's request body limit for that save follows it. The other secrets (an env file, a token) stay
at 64 KB.

### A secret store that makes a secret when it is first written

A `secrets` store may declare `createsOnWrite: true`: `write` makes a secret that does not exist yet. The local store
declares it. The Secrets page then lists each secret that is not there yet with `creatable: true` and offers Set, so
the first value can be given on the page. A store that declares none (AWS: Terraform makes every secret first) lists
a missing secret as "Missing in AWS" with no Set, because that is a misconfiguration. An embedding program's store
whose `write` creates a missing secret should declare it too.

### A wait's progress

A launcher whose `start` throws one of the fleet's "no room" errors (`NO_ROOM_RE` in `console/fleet.mjs`) puts the
session back in the queue, to be tried again a minute later. When the wait is for something the launcher can follow,
such as a machine being set up for the sessions, it may also have `progress(sessionId)`, which answers
`{steps: [{label, state, note, at}]}`, or `null` for nothing to show:

- `label`: the step in words, such as `Installing Docker` (up to 80 characters).
- `state`: `done`, `current`, `pending` or `failed`. A step in any other state is left out.
- `note`: optional, a short line beside the label: what the current step is doing, or why a step failed (up to 200).
- `at`: optional, an ISO time the step began. A done step's seconds run to the next step's `at`, the current one's to
  now, and the wait's clock from the earliest.

The fleet calls it every couple of seconds while a session waits for its retry, and once as the start goes back in the
queue; an error keeps the steps it had and is logged once (`fleet: wait progress not read`). Neither provider here has
one: their waits are AWS's quota, which says nothing of its progress.

### A machine kept between a session's runs

A launcher that keeps a stopped session's machine (its disk, its databases) for the next Resume, rather than making a
new one each start, may have `keptMachine(sessionId)`: `null` when it keeps none for that session, else `{outdated}`,
true when the machine was made from an older image of the session's repo than a new session gets. Resume starts the
session on that older image, as before; the stopped private session's page then also offers **Resume on the latest
image**, whose start passes `{latestImage: true}` as `start`'s third argument. The launcher then leaves an outdated
machine, what it held with it, and makes a new one; a machine that is not outdated is kept as on any Resume, so the
option is safe on a start tried again. Neither provider here has one: an ECS task and a local container are made
anew at every start.

### Telling the launcher a session is gone

A launcher that keeps something per stopped session (a machine or VM held for a Resume, its disk) may have
`forget(sessionId, {why})`, so it can free that instead of keeping it on a timer of its own. The console calls it when it
forgets the session for good: a shared session's kept data cleaned up (retention, Delete now) and a private session
removed (Remove, Remove My Woodshed, a tainted one's removal), and only then: never for a session that is kept, running or
still on a person's list, so no Resume of it is possible afterwards. It may be called more than once for the same session
(a failed or unanswered call is tried again every 10 minutes), so it must take that; it may throw, which only queues the
retry, and a call that does not answer in 30 s counts as failed. A launcher without it is unaffected. Neither provider
here has one: an ECS task and a local container keep nothing once stopped.

To add one: a folder with an `index.mjs` returning that object, an entry in `console.mjs`'s `PROVIDERS`, its own
settings in `NEEDS` so the other providers refuse them, and a README in the shape of these two: what it gives, how to
set it up, how to use it day to day, how to remove it.
