# The local provider

Woodshed on one machine with Docker: the console runs on the machine, each session is a container of the session
image, and the databases and services sessions share run on the network `compose.yml` makes. `index.mjs` is what it
hands the console. Each part is
off until its setting names it, so a console with none of them set runs sessions in Docker and nothing else.

| Part | File | Setting |
| --- | --- | --- |
| Session containers | `dockerLauncher.mjs` | Always; `WOODSHED_LOCAL_DOCKER_NETWORK` puts them on the stack's network. A host serving many orgs points it at another machine's daemon (`dockerHost`, `reachHost`; `docs/hosting.md`), and `dbAdminRunner.mjs` too |
| Secrets, each file sealed with a key | `secretStore.mjs`, `secretKey.mjs` | `WOODSHED_LOCAL_SECRETS_DIR`, `WOODSHED_LOCAL_SECRETS_KEY_FILE` |
| Saved Claude homes | `homeStore.mjs` | `WOODSHED_LOCAL_HOMES_DIR` |
| Each session's own databases | `dbAdminRunner.mjs`, with `postgres.yml` and `mongo.yml` | Postgres: `WOODSHED_LOCAL_DB_POSTGRES_HOST` and `_DB_POSTGRES_ROOT_USER`. Mongo, which needs Postgres: `WOODSHED_LOCAL_DB_MONGO_HOST`. With the secrets folder |
| GitHub and Slack webhooks | `webhookReceiver.mjs` | `WOODSHED_LOCAL_WEBHOOK_PORT`, with the secrets folder |
| Hosted mode: GitHub access and sign-in from the service that hosts the console | `../../console/githubBroker.mjs`, `../../console/trustedIdentity.mjs` | `WOODSHED_CLOUD_GITHUB_BROKER_URL` and `_GITHUB_BROKER_TOKEN_FILE`, `WOODSHED_CLOUD_TRUSTED_IDENTITY_SECRET` (`console/README.md`, "Hosted mode"). With the broker, no webhooks |

The console picks this provider with `WOODSHED_PROVIDER=local`, or with no provider setting at all.
`console/README.md` lists every setting. A setting of this provider stops a console started on the aws provider,
and the other way round (`../console.mjs`).


You need Docker with the compose plugin, Node 22, the GitHub CLI (`gh`, https://cli.github.com) on the console's
PATH, and a GitHub App for the repo its sessions work on. Every GitHub call the console makes goes through `gh`, with
the App's token when it has one. The console can
make it for you at `/setup/github` (below); `providers/aws/README.md`, "Setting it up", step 2, says which permissions. Without the App the console runs on your
own `gh` token, which reaches far more than one repo.

## Setting it up

On a laptop, `install.sh` at Woodshed's root does steps 1 to 5 for one repository, with everything in `~/.woodshed`:
`bash woodshed/install.sh`, or `curl -fsSL https://woodshed.run/install | bash` with no checkout. It reads your
`gh` token to fetch the repository and builds the image as `woodshed-session:<owner>-<name>`, on the published
runtime (`ghcr.io/chifferco/woodshed-session-runtime`, `session/README.md`) when it can pull it, so the machine builds
only the checkout and its installs. When the repository's
project file has `databases`, it starts the server of each engine they are on, Postgres on 15432 and Mongo on
17017, so a laptop's own databases keep theirs, and each session gets its own copy; with none it starts neither, and
sessions get none.
`WOODSHED_NETWORK` puts sessions on a docker network of the repository's own, such as its compose file's
`<folder>_default`, to reach the services it runs there. `WOODSHED_PROJECT_FILES_DIR`, an absolute path, is a folder of
project files the installation supplies, `<owner>/<name>.yaml`, for a repository with no `.woodshed/project.yaml` of its
own: `install.sh` reads the repository's from it, for the databases it starts and the image it builds, and saves it in
`stack.env` as `WOODSHED_CLOUD_PROJECT_FILES_DIR` ("Project files the installation supplies", below). It starts the console with `~/.woodshed/bin/woodshed`, which
starts it again when the GitHub App setup page asks. By hand, on any machine:

1. Build the session image from the repo root, as `session/Dockerfile` says, and tag it `woodshed-session`.
2. Copy `stack.env.example` and `session-env.example.json` outside the repo, fill them in, and make both readable
   by you only. Pick the engines the repo's sessions need: one for each `engine` in its project file's `databases`,
   each on its own. Leave out the lines of an engine you do not host, in both files (`PGHOST`, `PGPORT` and
   `PGSSLMODE`, or `WOODSHED_MONGO_HOST`, in the session env), and make up a root password for each
   one you do, such as with `openssl rand -hex 24`. If the repo's app needs shared
   services, such as a fake S3, copy `services.example.yml` too and make it the repo's: each service joins the
   `woodshed` network with no published port, and `session-env.json` sets the variable each reaches sessions in and
   lists them in `WOODSHED_SERVICES`, which db-admin runs pass to the seed.
3. Start the databases, and the services if you have them:

   ```bash
   docker compose -f woodshed/providers/local/compose.yml -f woodshed/providers/local/postgres.yml -f woodshed/providers/local/mongo.yml -f ~/woodshed/services.yml --env-file ~/woodshed/stack.env up -d
   ```

   Each database and the services is a file of its own: leave out `-f …/mongo.yml` without Mongo, `-f …/postgres.yml`
   too without any database, and `-f ~/woodshed/services.yml` without shared services, here and in each compose
   command below. With none of them, there is nothing to start: `docker network create woodshed` gives sessions the
   network alone. Postgres and Mongo are separate files rather than compose profiles because compose reads every
   service's required values (the `:?` root passwords) whatever profiles are on, so a profile left off would still
   need its password.

4. Make the secrets key, then put each root password in the secret store, where db-admin runs read them.
   `secret.mjs` reads the value from stdin, so it is never on a command line:

   ```bash
   set -a && . ~/woodshed/stack.env && set +a
   node woodshed/providers/local/bin/secret.mjs new-key "$WOODSHED_LOCAL_SECRETS_KEY_FILE"
   printf %s "$WOODSHED_LOCAL_PG_ROOT_PASSWORD" | node woodshed/providers/local/bin/secret.mjs put db-root/postgres
   printf %s "$WOODSHED_LOCAL_MONGO_ROOT_PASSWORD" | node woodshed/providers/local/bin/secret.mjs put db-root/mongo
   ```

   The console logs `console: databases` at start with the ones it makes a copy of for each session (`kinds`).

5. Start the console with the same settings, then open `WOODSHED_CLOUD_PUBLIC_URL`:

   ```bash
   set -a && . ~/woodshed/stack.env && set +a && node woodshed/providers/console.mjs
   ```

6. Open the console: with no GitHub App, My Woodshed's setup card and `/setup/github` walk through making one (GitHub's
   manifest flow, or paste an App's ID and key), installing it on the repo and restarting the console. Started from a
   shell as in step 5, restart it by hand: stop it and run the same command. Run by a systemd unit with
   `Restart=on-failure`, the page's Restart button does it (console/README.md, "Setting up the GitHub App from the
   console"). Then, on its
   Secrets & webhooks page, set the session secrets. Then build the
   database template once: `docker run` the image as a db-admin run does, with `template`
   (`dbAdminRunner.mjs` has the flags), or start a session, whose first copy waits for it.

`node woodshed/providers/local/bin/secret.mjs list` shows which secrets have a value, never a value.

## What to know

- **No secrets settings? Choose a store on the dashboard.** Without `WOODSHED_LOCAL_SECRETS_DIR`, the Secrets &
  webhooks page offers **Local files** (sealed, with a key made in the state folder) or **AWS Secrets Manager** (a
  prefix, and the AWS credentials the console runs with). The choice is kept in the state folder, so My settings can
  save a Claude token on a console started with nothing else set. Switching does not copy secrets across.

- **The secrets are sealed with a key, and losing the key loses them.** Each file in `WOODSHED_LOCAL_SECRETS_DIR` is
  AES-256-GCM with the secret's name bound in, so a copy of the folder, such as a backup, gives nothing away, and a
  file changed or moved to another secret's name does not open. Keep a copy of the key apart from the folder. The
  key does not protect against someone who can act as the console's user: they can read it too. A db-admin run gets
  the plain values it needs, never the key, in a folder that goes when it ends.

- **The session API needs an address containers can reach.** Sessions fetch GitHub tokens, their databases and
  their Claude home from it. Do not use `0.0.0.0` on a machine others can reach.
  - On Linux, set `WOODSHED_CLOUD_SESSION_API_HOST` to the `woodshed` network's gateway, an address of this machine
    (`docker network inspect woodshed`), and `WOODSHED_CONSOLE_URL` in the session env to the same address on 7691.
  - On Docker Desktop (macOS, Windows) the containers run in a VM, so that gateway is not on this machine. Set
    `WOODSHED_CLOUD_SESSION_API_HOST=127.0.0.1` and `WOODSHED_CONSOLE_URL=http://host.docker.internal:7691`, which
    Docker Desktop routes to this machine's loopback.
- **Postgres and Mongo, those you run, are also on this machine's loopback**, at `WOODSHED_LOCAL_PG_PORT` and
  `WOODSHED_LOCAL_MONGO_PORT` (5432 and 27017). Change them in the env file if a database of your own has those.
- **The databases' files are in `WOODSHED_LOCAL_DATA_DIR`.** The root passwords are read only when those folders are
  first made: changing them later means changing them in Postgres and Mongo too, then in the store.
- **Webhooks need a public address.** The receiver listens on `127.0.0.1` by default; put a proxy with HTTPS in front
  of it and set `WOODSHED_LOCAL_WEBHOOK_URL`. Without the port set, the console polls GitHub every 30 seconds.
- **Project files the installation supplies.** With `WOODSHED_CLOUD_PROJECT_FILES_DIR` set (docs/reference.md, "The
  project file"), the console reads the default project's file from it when the repo has none on its default branch,
  and each session and db-admin run gets the files it needs as read-only bind mounts under
  `/run/woodshed-project-files`, which `WOODSHED_CLOUD_PROJECT_FILES_DIR` (in a session) or `--project-files-dir` (in a
  db-admin run) names there (`projectFileMounts.mjs`). A session gets its own repo's file and the image's repo's, which it
  reads for the secrets to withhold on another project; never the folder, which may hold other repos' files. Each is
  looked for when the container starts, so a file added later reaches the next session; one in a running session stays
  as it was. The console logs `launcher: installation project files` with the repos mounted, and `local: db-admin run
  started` says `installationProjectFile`. A repo's own `.woodshed/project.yaml` wins over the installation's wherever
  it is read. The folder must be the same path for the docker daemon, and its files readable by uid 1000, the image's
  `node` user. Set it on the first run of `install.sh`: `stack.env` is written once, so an install made before the
  folder had the repo's file keeps the env files, seed secrets and database engines of no project file, and its image
  the installs of none. `install.sh` then says `was written for another project file`: set `WOODSHED_CLOUD_ENV_FILES`
  and `WOODSHED_CLOUD_DB_ENV_SECRETS` in `stack.env` to what the file names (or, with no databases yet, move
  `stack.env` aside to have it written again), and run it with `WOODSHED_REBUILD=1` to build the image from the file.
- **A shared service keeps nothing across restarts** unless its compose file gives it a volume. A fake S3's buckets
  can be made on every start by an init script it mounts, such as localstack's `/etc/localstack/init/ready.d/`.

## On a server your team reaches

There is no installer: how the machine is set up is yours to decide, with your agent. These are the choices to make
and what tripped up the first install on a plain VM (Ubuntu 24.04, for a repo with one Postgres and no Mongo).

- **Size.** A session is capped at `WOODSHED_CLOUD_SESSION_MEMORY` and `_CPUS` (6g and 2 by default) but uses about
  2–3 GB once Claude and its browser run. 12 GB holds three at a time with swap behind them; set
  `WOODSHED_CLOUD_MAX_SESSIONS` to match.
- **Run the console as a service**, as its own user in the `docker` group, with `Restart=on-failure`: it survives
  reboots, and the GitHub App setup page's Restart button needs something that starts it again.
- **It needs HTTPS.** Sign-in and session apps set `__Host-` cookies, which browsers keep over HTTPS only, so put a
  proxy with a certificate in front (Caddy gets one by itself). For the name, a domain of your own with a wildcard
  record for session apps, or no DNS at all with sslip.io ("Session apps without a wildcard certificate", below).
- **The first start has no sign-in.** Until `/setup/github` has made the App, anyone who reaches the console is its
  admin. Let the proxy answer only your IP until the App is in, then set `WOODSHED_CLOUD_REQUIRE_SIGN_IN=1` and open it.
- **Docker skips the firewall, both ways.** A published port (`-p 5432:5432`, `ports:` in a compose file) is open to
  the internet whatever ufw says: publish on `127.0.0.1` or not at all, and check the repo's own compose file too.
  The other way, ufw's default deny drops the sessions' calls to the session API: allow the sessions' bridge in on
  7691 only (`ufw allow in on br-<network id> to <gateway> port 7691 proto tcp`).
- **The repo's own services.** Without each session's own databases (the table above),
  run the repo's services on a docker network, without published ports, and put sessions on it with
  `WOODSHED_LOCAL_DOCKER_NETWORK`: every session then shares them, so say so to the people using it.
- **The repo's app on another origin.** Session apps answer at `https://<id>.<app domain>`, which the repo's own app
  may refuse: Better Auth says "Invalid origin", Next's dev server never hydrates (`allowedDevOrigins`). Give the app
  the origin through `WOODSHED_CLOUD_SESSION_ENV_FILE`, which every session gets, so the machine's name stays out of
  the repo.
- **The session image is built on the machine**, for the repo `WOODSHED_CLOUD_REPO` names, and nothing rebuilds it:
  build it again when an install's files or `.woodshed/project.yaml` change, or every session reinstalls. A rebuild
  also picks up the day's Claude CLI and, on the published runtime, the week's system packages.
- **Claude tokens.** Each person saves theirs on My settings, made with `claude setup-token`. A token copied across a
  wrapped line can lose a character and still look right: claude in the session then says `OAuth access token is
  invalid`. Save it again, then start a new session.

### On Hetzner Cloud

The list above holds on any VM. On Hetzner Cloud, add these.
None was tried on a Hetzner install of Woodshed yet: they are what Hetzner's own pieces offer for the points above.

- **The server.** Woodshed needs nothing Hetzner-specific: Ubuntu 24.04 with Docker, as above. A shared-vCPU type
  with 16 GB (CPX41, or the Arm CAX31) holds about four sessions by the sizing above; the session image builds natively
  for x86 and Arm alike.
- **Fence it with a Hetzner Cloud Firewall**, not only ufw. It filters in front of the server, so a port Docker
  publishes cannot get round it: allow 22 from your own IP, 80 and 443 from anywhere, and nothing else. The sessions'
  calls to the session API stay inside the server, so they need no rule there.
- **Keep the data on a Volume**: `WOODSHED_CLOUD_STATE_DIR`, the secrets and homes folders, and the databases' data
  folder. A rebuilt or resized server then keeps sessions, secrets and databases.
- **Keep the secrets key on the server's own disk**, not the Volume, so a copy of the Volume does not carry the key
  that opens it. With the settings `stack.env.example` uses, mount the Volume at `/var/lib/woodshed` and move only
  the key: `WOODSHED_LOCAL_SECRETS_KEY_FILE=/etc/woodshed/secrets.key`, mode 600, owned by the console's user. Server
  Backups then cover the key and your copies of the Volume cover the rest, apart. Make it there before the first start
  (`sudo install -d -m 700 -o <console user> /etc/woodshed`, then `node woodshed/providers/local/bin/secret.mjs new-key
  /etc/woodshed/secrets.key` as that user), or move an existing key there with `mv` and change the setting: the files
  it sealed open with it wherever it is. Keep one more copy of the key
  somewhere offline: losing it loses every secret. A store picked on the Secrets page instead (Local files) keeps its
  key in `<state dir>/secrets.key`, with no setting to move it, so on a server use the two settings rather than the
  page.
- **Back the Volume up yourself.** Hetzner's server Backups and Snapshots do not include attached Volumes, and Volumes
  have none of their own: copy the folders above somewhere else on a schedule, such as Hetzner's Object Storage.
- **The name.** A record for the console and a wildcard for session apps, at your registrar or in Hetzner DNS, or
  sslip.io with no DNS at all ("Session apps without a wildcard certificate", below).

## Session apps without a wildcard certificate

Each session's app answers at `https://<session id>.<WOODSHED_CLOUD_APP_DOMAIN>` (`console/README.md`, "Session
apps"). AWS covers those names with a wildcard certificate, which needs a DNS challenge and so a DNS zone of your own.
Without one, the proxy in front of the console gets a certificate for each name the first time a browser asks for it:
Caddy's on-demand TLS. Before it does, Caddy asks the console whether the name is one of its own, so nobody can make
the machine request certificates for made-up names and use up the Let's Encrypt rate limit.

With no DNS of your own, [sslip.io](https://sslip.io) (or nip.io) resolves every name with an IP in it to that IP:
`woodshed.203-0-113-10.sslip.io` and every name under it go to `203.0.113.10`. sslip.io is not on the Public Suffix
List, so Let's Encrypt counts every certificate for any `*.sslip.io` name, everyone's, against one weekly limit for
`sslip.io`; Caddy falls back to ZeroSSL when Let's Encrypt refuses. A name of your own avoids that.

1. Start the console with the question's port, beside its usual settings:

   ```bash
   WOODSHED_CLOUD_PUBLIC_URL=https://woodshed.203-0-113-10.sslip.io
   WOODSHED_CLOUD_APP_DOMAIN=woodshed.203-0-113-10.sslip.io
   WOODSHED_CLOUD_TLS_ASK_PORT=7692
   ```

   It logs `tls: ask listening`. `GET http://127.0.0.1:7692/tls-ask?domain=<name>` answers 200 for the console's own
   name, the names in `WOODSHED_CLOUD_HOSTS`, and `<id>.<app domain>` for a session on the console's list that is not
   deleted, stopped ones included (a kept session resumes at the same name, and a certificate got early costs nothing).
   Everything else gets 403. It listens on `127.0.0.1` only, refuses a caller that is not loopback or a request with a
   forwarding header (`X-Forwarded-For`, `Forwarded`, `X-Real-IP`), and the console's own port has no `/tls-ask`. Do not
   proxy to 7692: Caddy calls it directly.

2. The Caddyfile, checked with `caddy validate` on Caddy 2.11:

   ```caddyfile
   {
   	on_demand_tls {
   		ask http://127.0.0.1:7692/tls-ask
   	}
   }

   woodshed.203-0-113-10.sslip.io {
   	reverse_proxy 127.0.0.1:7690
   }

   *.woodshed.203-0-113-10.sslip.io {
   	tls {
   		on_demand
   	}
   	reverse_proxy 127.0.0.1:7690
   }
   ```

   The console's own name gets an ordinary certificate at start. The wildcard site never gets a wildcard certificate:
   with `on_demand` Caddy gets one for the exact name in each handshake, after the ask answers 2xx. Caddy's `ask` is
   the short form of `permission http { endpoint … }`; both send `?domain=<name>`.

3. Open an app: the first visit to each name waits a few seconds for its certificate. The console logs
   `tls: certificate asked` with `allowed` and `why` (`console host`, `extra host`, `session`, `unknown`). Refusals are
   logged at most once a minute, with how many there were (`refused`), since anyone can make Caddy ask.

The app's dev server must accept the new names too (Next's `allowedDevOrigins`, say): one that lists only the
AWS installation's domain loads a page on another but never brings it to life until it lists this one.

## Using it day to day

| What | How | Running sessions |
| --- | --- | --- |
| The console | Stop it, update the checkout, and start it again as in step 5 | Carry on; the console picks them back up. Open terminals need a reload |
| The session image | Build it again with the same tag | Keep their image; only new sessions get the new one |
| The databases and shared services | `docker compose -f woodshed/providers/local/compose.yml -f woodshed/providers/local/postgres.yml -f woodshed/providers/local/mongo.yml -f ~/woodshed/services.yml --env-file ~/woodshed/stack.env pull`, with the files you run, then the same with `up -d` | Lose their connections while the databases restart |

What survives a restart: the console's sessions (`WOODSHED_CLOUD_STATE_DIR`), the secrets, the saved Claude homes and
the databases (`WOODSHED_LOCAL_DATA_DIR`). What does not: what a shared service keeps without a volume, and a webhook still waiting for a
retry, which the GitHub poll then finds.

## Removing it

1. Stop the console, then the services, with the same env file as `up`, since compose reads its required values for
   `down` too: `docker compose -f woodshed/providers/local/compose.yml -f woodshed/providers/local/postgres.yml -f woodshed/providers/local/mongo.yml -f ~/woodshed/services.yml --env-file ~/woodshed/stack.env down`, with the files you run.
2. Remove the sessions' containers and any kept db-admin run (two filters in one `docker ps` must both match, so one
   each):

   ```bash
   docker ps -aq --filter label=woodshed-cloud.session | xargs -r docker rm -f
   docker ps -aq --filter label=woodshed.db-admin=1 | xargs -r docker rm -f
   ```

3. Delete the folders the settings name: the state folder, the secrets folder and its key, the homes folder and the
   data folder. The secrets go with the key alone, but the data folder holds every session's databases in the clear.
