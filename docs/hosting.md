# Hosting many orgs from one console

A hosted service can run one console process for every org it hosts. Each org (a **tenant**) gets an installation of
its own inside that process, built from the settings and services the host gives for it: its own sessions, secrets,
Claude homes, people's settings, GitHub access, launcher and background loops. The servers are shared: one for the
console's pages, API, websockets and session apps, and one for the session API. Each org's sessions run on that org's
own compute, a machine running Docker that the console reaches over a private network such as WireGuard.

A self-hosted console is the single-tenant case of the same code: `providers/console.mjs` builds one installation from
the environment (`console/server.mjs`, `startConsole`) and serves it, with no change to its settings.

`console/hosted.mjs` is the host's way in. `node console/bin/devMultiTenant.mjs` runs it with two made-up orgs
("Running two tenants locally", below).

## The contract

```js
import { startMultiTenantConsole } from 'woodshed/console/hosted.mjs';

const consoleProcess = await startMultiTenantConsole({ config, tenancy, log });
// -> {
//   server,             the http.Server for pages, API, websockets and session apps
//   sessionApiServer,   the session API's http.Server, listening on config.sessionApi.host:port
//   dispatchGitHub(tenantId, { event, deliveryId, payload }),   one GitHub webhook event, for one tenant
//   reload(tenantId),   reads the tenant from tenancy.tenants() again (its repos changed, say); starts it if new
//   remove(tenantId),   stops the tenant's loops and drops it from memory; its data stays with the host
//   close(),            stops everything
// }
```

### `config`: the process's own

| Key | What |
| --- | --- |
| `host`, `port` | Where the console listens: `127.0.0.1` behind the host's proxy |
| `publicUrl` | The console's address, `https://console.example.com`: one for every tenant |
| `appDomain` | Session apps answer at `<session id>.<appDomain>`; empty turns them off |
| `sessionApi: { host, port }` | Where the one session API listens: an address every tenant's compute reaches, and nothing else does |
| `tlsAskPort` | Optional, as `WOODSHED_CLOUD_TLS_ASK_PORT` (`console/tlsAsk.mjs`): sessions of every tenant count |
| `stateDir` | Optional: where each tenant's own files are kept, a folder per tenant id (New session's attachments, dumps being restored, the webhook events log). Without it, the system's temporary folder: set it to a disk that lasts |

### `tenancy`: the host's people and orgs

| Function | What |
| --- | --- |
| `async tenants()` | Every tenant to run, at start and at each `reload` |
| `async identify(req)` | Who sent the request and which tenant is theirs now: `{ login, role, tenantId, tenants: [{ id, name, role }] }`, or `null` when nobody is signed in. `login` is the GitHub login, lowercase; `role` is `owner` or `member` in the current tenant; `tenants` are every org the person is in. Called for every request and websocket, on the console's name **and on the session apps' names** |
| `signInUrl(req)` | Where to send someone not signed in, with a way back to `req.url` |
| `switchUrl(tenantId, returnTo)` | The host's route that makes `tenantId` the person's current org, then sends them to `returnTo` on the console |
| `menuLinks(identity)` | Optional: the host's own pages for the console's menu, `[{ label, href }]`, such as Account, Members and Credits. An `href` that is not `http(s)://` or a path on the console's name is dropped |

The host owns sign-in, members and switching. The console never signs anyone in with GitHub in this mode, has no
People page, and asks nobody's write access to a repo: an org's members are who the host says. `owner` is an admin
(Secrets & webhooks, Webhook events, Console settings); `member` is not.

`identify` throwing is the host's failure, not a sign-out: the console answers 503 and logs `hosted: identify failed`.
An answer that is not an identity (a login that is not GitHub's lowercase form, an unknown role, a tenant id that is
not one) signs nobody in, and logs `hosted: identify gave something that is not an identity`.

### `Tenant`

```js
{
  id,        // stable and URL-safe: lowercase letters, digits and dashes, at most 63
  name,      // shown in the menu
  settings: {...},
  services: {...},
}
```

`settings` are what the environment gives a single console, in `console/config.mjs`'s own keys and shapes
(`tenantConfig` checks them, and a key it does not know stops the tenant, naming it):

| Key | As |
| --- | --- |
| `projects` | `WOODSHED_CLOUD_PROJECTS` parsed: `[{ name, repo, default?, installationId? }]`. The first is the default when none says so |
| `sessionApiUrl` | The URL this tenant's sessions reach the session API at, over its private network: `http://10.8.0.1:7691`. Sessions get it as `WOODSHED_CONSOLE_URL` |
| `sessionEnv` | `WOODSHED_CLOUD_SESSION_ENV_FILE`'s object: extra variables for this tenant's sessions |
| `maxRunning`, `maxPrivatePerPerson`, `maxAsks` | The limits, until the tenant's owners change them on Console settings |
| `limits` | `{ idleMs, lifetimeMs, startTimeoutMs, askIdleMs, askLifetimeMs }`, each in ms |
| `retention` | `{ afterCloseMs, withoutPrMs, openPrMs, slackGiveUpMs, qaWaitMs, removeAfterDeleteMs }` |
| `label` | `WOODSHED_CLOUD_LABEL` |
| `envFiles`, `installSecrets`, `actionsWorkflows` | Parsed: `[{ secret, path }]`, `[{ secret, variable }]`, `[{ label, file }]` |
| `dbEnvSecrets` | `[secret]` |
| `pollGitHub`, `pollMs`, `fallbackPollMs` | GitHub's poll: off, how often without webhooks, and how often with them |
| `launcher` | `{ image, memory, cpus }`, as the pages show them |
| `tunnelTargets` | `{ pg, mongo }`, `host:port` each, for `woodshed-db.mjs` (`console/dbTunnel.mjs`) |

`services` hold the tenant's data and run its sessions, each scoped to the tenant alone:

| Key | What |
| --- | --- |
| `store` | `{ async load() -> object \| null, async save(state) }`: the tenant's state, what `state.json` holds for a single console. Loaded once when the tenant starts; every change saves a copy of the whole state, one save at a time, the latest once when several come together, and a refused save is tried again after 5 seconds (`store: state not saved, trying again`) |
| `secrets` | `{ list, read, write, save, remove }`, as `providers/local/secretStore.mjs` and `providers/aws/secretStore.mjs` give them: the Secrets page's secrets and each person's `users/<login>/...` |
| `homes` | As `providers/local/homeStore.mjs` gives it: saved Claude homes |
| `github` | `{ async token({ repo, permissions }) -> { token, expiresAt, permissions } }`: the HTTP broker's contract (`console/README.md`, "Hosted mode"), called in the process. `expiresAt` is ISO 8601, a Date or ms. A token whose `permissions` are wider than asked, or missing when some were asked, is not used |
| `launcher` | `createDockerLauncher({ dockerHost, reachHost, ... })`, or any launcher (below) |
| `dbAdmin`, `databases` | As a provider gives them (`providers/README.md`), or `null` |
| `projectFiles` | `{ dir, hostDir }` or `null`: a folder of project files for repos with none of their own (`docs/reference.md`). The console reads `dir`; the tenant's compute has the same files at `hostDir`, which the host passes to the launcher and db-admin runner as `projectFilesHostDir` |
| `words` | Optional: what the pages say about where sessions run, as a provider's `words` (`console/providerWords.mjs`) |

### A tenant's compute

`providers/local/dockerLauncher.mjs` runs sessions on another machine's Docker:

```js
import { createDockerLauncher } from 'woodshed/providers/local/dockerLauncher.mjs';
import { withSessionSecrets } from 'woodshed/providers/local/index.mjs';

const launcher = withSessionSecrets({
  launcher: createDockerLauncher({
    image: 'woodshed-session:acme-app', memory: '6g', cpus: '2',
    dockerHost: 'ssh://woodshed@10.8.0.12',  // every docker call goes there, as DOCKER_HOST
    reachHost: '10.8.0.12',                  // session ports are published on this address alone
    network: 'woodshed',                     // optional: the network on that machine sessions join
    projectFilesDir: '/var/lib/host/acme/project-files', projectFilesHostDir: '/srv/woodshed/project-files',
    repo: 'acme/app',
  }),
  secrets, envFiles, installSecrets,         // each session's env-file secrets, read from the tenant's store
});
```

- The console proxies terminals, statusd and apps to `reachHost` and the published ports, over the private network.
  The ports are never published on another address of that machine.
- A session's own environment can never point the console's docker calls at another daemon: `DOCKER_HOST`,
  `DOCKER_CONTEXT` and the CLI's other settings are left out of it.
- `providers/local/dbAdminRunner.mjs` takes the same `dockerHost` and `projectFilesHostDir`. Its run's secrets cannot
  be a bind mount there, so the container is created, the secrets copied in with `docker cp`, then started.
- The session image is built on that machine with `install.sh`, which then sets nothing else up:
  `DOCKER_HOST=ssh://woodshed@10.8.0.12 WOODSHED_REPO=acme/app WOODSHED_HOME=<a folder for the build> WOODSHED_BUILD_ONLY=1 bash install.sh`.
- `ssh://` hosts need the console's user to have an ssh key the machine trusts, and the host key known.

### Webhooks

The host receives GitHub's events once, for every org, checks each one's signature, and hands it to the org's tenant:

```js
const done = await consoleProcess.dispatchGitHub('acme', {
  event: req.headers['x-github-event'], deliveryId: req.headers['x-github-delivery'], payload,
});
```

It resolves `true` when the console is done with the event (acted on it, or it was nothing for the console), and
`false` when handling it failed and the host should deliver it again. A tenant that is not running rejects. The
event becomes the message the AWS webhooks Lambda makes from it (`console/githubEvents.mjs`, kept the same as the
Lambda's by `githubEvents.test.mjs`), and an event about a repo that is none of the tenant's projects is dropped
(`webhooks: message from a repo that is not a project, dropped`). Each tenant's fleet takes webhooks as arriving, so
its GitHub poll falls back to `fallbackPollMs`: the poll stays as the fallback for an event that never came.

A session's "Needs a human:" comment is not acted on here: the console checks it against its own GitHub App's login,
and a hosted console has no App (`webhooks: a Needs a human comment, but the console has no GitHub App to have
written it`).

## How a request finds its tenant

The paths are a single console's; the tenant is never in them.

- **The console's name.** `identify(req)` names the person and their current tenant, and the request goes to that
  tenant's installation, as that person with the role the host gave. Not signed in: a page goes to `signInUrl`, an API
  call gets 401, and `/api/me` says so.
- **Links to another org.** A page with `?org=<id>`, for an org the person is in, goes to `switchUrl(id, <the same
  page>)`; for one they are not in, it opens in their current org, where its ids are unknown. The console puts
  `?org=` on every link it sends out of itself (a session's `SESSION_URL`, its GitHub comments and Slack posts) and on
  **Invite an engineer**. A session page with no `?org=` (`/s/<id>`) whose id is in another of the person's orgs
  switches the same way: session ids are unique across every tenant.
- **A session's app**, at `<id>.<appDomain>`, is the tenant's whose session has that id. The person is signed in to it
  when they are a member of that tenant (with that tenant's role), whatever their current org; anyone else gets only
  what a share link's cookie for that one app allows.
- **The session API** finds the tenant by the session's own token (`Authorization`, or `x-api-key` on `/anthropic`),
  among every tenant's active sessions, and the request's `Host` must be the tenant's `sessionApiUrl` host: a token
  sent to another tenant's address is refused (`sessionApi: refused, the session called another tenant's address`). A
  token no tenant has gets the same 401 as on a single console.
- **`woodshed-db.mjs`**'s tunnel finds its tenant by its token.

The page's menu (under the avatar) shows the org's name under the person's, and lists their orgs with a check on the
current one; each other org is its `switchUrl`. The host's `menuLinks` follow (`console/designSystem/components/OrgSwitcher`).

## What keeps tenants apart

The boundary is the installation: nothing in one tenant's installation holds anything of another's.

- **State.** Each tenant has its own state object from its own `store`, its own secrets, homes, launcher, db-admin
  runner and GitHub token source. A request, a websocket, a webhook and a session API call reach exactly one
  installation, chosen as above, and that installation's code only ever reads its own services.
- **Who is asking.** The person comes from `identify`, never from a header the browser sends: the console hands it to
  the installation on the request object, where no header and nothing the console proxies to a session carries it.
  Within one installation everything is as on a single console behind a trusted proxy (`console/README.md`, "Hosted
  mode"): private sessions are their owner's alone, admin pages are owners' alone, writes need the console's own origin
  and `x-woodshed: 1`, terminal websockets its own origin.
- **The same login in two orgs** is two people as far as the console is concerned: My settings, private sessions,
  Claude tokens and homes are kept per tenant.
- **Sessions.** A session's token and terminal token are its tenant's. Its app's share-link cookie names that app
  alone. Ids are unique across tenants.
- **Failures.** A tenant that cannot be built (its store, its settings, its services) is logged (`hosted: tenant not
  started`) and its people get a 503 page; the others run. Each tenant's loops (the tick, GitHub's poll, pull request
  chips, retention, the sweeps) run on their own timers, each run caught and logged: one tenant's slow GitHub or failing
  launcher holds up none of another's. An unhandled rejection is logged (`console: unhandled rejection`) rather than
  ending the process.
- **Logs.** Every line names its tenant (`tenant: 'acme'`, or `null` for the process's own), through
  `console/tenantLog.mjs`: each tenant's work runs inside its own async context, so a line made deep in a module that
  knows nothing of tenants still says whose it was.

What it does not do:

- The session API trusts the private network to carry each tenant's traffic from its own compute: a session token is
  the credential, as on a single console, and the `Host` check stops a token being replayed at another tenant's
  address, not a machine on the network forging a `Host`.
- One process holds every tenant's secrets it has read in memory, as a single console holds its own.
- Limits are per tenant; nothing caps one tenant's share of the console process itself.

## Running two tenants locally

```
node console/bin/devMultiTenant.mjs [port]
```

It runs the console on `port` (7690), a stand-in host on the next port that signs people in and switches orgs with
two cookies, and the session API on the one after. Two orgs, Acme Robotics and Globex Labs, each have sessions of their
own; `octocat` is an owner of Acme and a member of Globex, `ana-dev` is in Acme only and `priya-dev` in Globex only.
Open `http://localhost:7690/`, pick a person, and switch orgs from the menu under the avatar. Its sessions never start
a container.

`console/hosted.test.mjs` runs the same with real local secret and home stores and stand-in sessions, and fails on any
read of one tenant from another: sessions, secrets, homes, members, settings, session API tokens, websockets and
app-proxy cookies.
