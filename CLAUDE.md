# Woodshed: debugging and the rules for secrets

Setting Woodshed up rather than changing or debugging it? Follow `docs/self-host.md` instead: most of this file is
about running an installation, AWS's above all.

Read this when something on Woodshed is not working, or before changing
what a session is given. The READMEs explain what each piece does and how it
is applied (`docs/reference.md` here, then `console/`, `session/` and
`providers/aws/`'s own); this file says where to look when it breaks. Do not restate them here.

## Rules

- **No production credentials or integration tokens in a session.** Sessions
  run Claude unattended in auto mode, which refuses risky actions but is no
  guarantee: anything in their environment can leak into a log, a commit or a
  PR. Never add the app's integration keys (payments, CRM, accounting, email,
  a hosted database, a bot's Slack token) or real AWS keys. The one exception is a person's own MCP sign-in in their private
  sessions: the default plugins (`session/defaultPlugins.mjs`, Slack's MCP)
  sign in as that person, by their own hand, and the login stays in their saved
  Claude home. A shared session never gets the default plugins or anyone's
  login, and nothing team-wide (a bot token) goes in any session. An installation's env files set `AWS_ACCESS_KEY_ID=test`
  on purpose when its backend uses localstack: it accepts anything.
- **An MCP server reaches a session only through the console's relay, which holds what it takes.** Admins add servers
  on Console settings' MCP servers card or its API (`console/mcpServers.mjs`, console/README.md "MCP servers"); the
  relay (`console/mcpRelay.mjs`) adds a token the console signs, or a header whose value is in the console's secret
  store, to each call. The session gets the server's name and the relay's address, never the value: no MCP credential
  in the image, a project file, a session's env or a Claude home. What the relay lets a session do with a team's
  header is the admin's choice, and is logged with who made it; a server that reads production data is marked
  production, never added as ordinary.
- **Production data reaches a session only through a production MCP server, and locks it down.** The one exception to
  the first rule, and it is narrow: a My Woodshed session running claude, of a person and on a repo a production
  server lists, may read production through it (such as woodshed-prod-mcp), relayed by the console (docs/reference.md
  "Production access"). Admins add one on Console settings, or the installation names one (`WOODSHED_PROD_MCP_URL`),
  and only where the console can lock a session down. Its first relayed call taints the session, and the call goes on
  only once its network is locked down, outside its container (the docker launcher's isolated network, AWS's guarded
  security group, and the console's egress proxy); a lockdown that fails refuses the call. Nothing untaints a session,
  a tainted session's calls to any other server are refused, and nothing it holds is copied anywhere that outlives it.
  Never extend it without the same lockdown: no production access for a shared session, a question from Slack, QA or
  a review, no MCP server of production in the image, a project file or a Claude home, and no enforcing it with
  anything inside the container (iptables, `HTTPS_PROXY`), which its agent can undo.
- **On one local server, whoever can start a session is trusted with the other sessions on it.** Where the machine has
  Sysbox, every session runs its own Docker (providers/local/README.md, "Docker in a session"), whose root reaches
  nothing of the machine's but can reach the network the sessions share, and so another session's calls to the
  console and the tokens in them. That is the deal of a shared server: a team whose members must be kept apart runs
  each session on a VM or task of its own (AWS, or a launcher that makes one), never several on one machine. The
  machine's own Docker socket, root on the machine and every secret, is never a default where others sign in: only
  `WOODSHED_SESSION_DOCKER=1` in that console's own `stack.env` gives it, and no Update turns either on unasked.
- **An installation's exceptions are written in its own `.woodshed/install/README.md`**, each with what has to happen to
  remove it. None is in this folder: what is here applies to every installation.
- **Never print a secret's value.** Check a secret by its shape, its
  `LastChangedDate`, or a call that uses it and prints only the status code.
  Set values on the console's Secrets & webhooks tab, which hands them to the
  AWS CLI in a file only the console can read, deleted straight after; from a
  shell, upload with `--secret-string file://…`, never by pasting a value into
  a command. Pass a token to curl on stdin (`-K -`),
  not in its arguments.
- **Only use IAM condition keys the action supports.** Check AWS's service
  reference (`https://servicereference.us-east-1.amazonaws.com/v1/ecs/ecs.json`,
  the action's `ActionConditionKeys`) before adding one. A guard like
  `Null: false` on a key the action never sends denies every call; the IAM
  simulator does not catch it. `RunTask` has no subnet or security-group key,
  which is why this must stay in an account of its own.
- **`terraform plan` is read before every `apply`.** A plan that changes or
  destroys something is called out to whoever asked for it first.
- **A variable a session reads goes in `PER_SESSION_ENV` too.** The ECS
  launcher (`providers/aws/ecsLauncher.mjs`) passes a task only the variables that
  list names, and drops the rest without a word; the fake launchers in the
  tests and the docker launcher pass everything, so no test of the fleet alone
  catches a missing one. `ecsLauncher.test.mjs` checks every variable the fleet
  sets for each kind of session reaches the task: add the new kind there.
  `REVIEW_ONLY` (#26404) and `SESSION_MODE` (#26539) were each found only in AWS.
- **A change to how a session starts is run in the real image before it
  ships.** Tests of the console and of the entrypoint's pieces do not prove the
  start: run the session image with the environment ECS gives it, as
  "Running a session start in the real image" below shows, and put its log in
  the PR.

## Changing how the console looks

The console's colors, type, spacing and rail rules are written down in `console/designSystem/`. Read its `README.md`
before you change anything a person sees: a page, the rail, a card, a button, a tag or a color. Use its tokens and its
rules (orange only for the one primary action, yellow only for a session that needs a person, a status is always a
word) instead of a new color or a new pattern.

When your change adds, removes or changes a color, a type style, a radius, a spacing step or a rule, a component's
look, or a new component, update the design system in the same PR:

- `designSystem/tokens.json` for a token (its `usage` note says where it is used and on which ground).
- `designSystem/README.md` for a rule, and `designSystem/components/<Name>/README.md` and `preview.html` for a component.
- `console/designSystem.test.mjs` fails when a color in `tokens.json` differs from `public/style.css`, so a color change
  that skips the design system fails `node --test`. A token that `style.css` does not define yet goes in the test's
  `PLANNED` list until it does.
- A text color must stay at 4.5:1 or better on the grounds its note names, in both themes. Say in the note when a pair
  from the source cannot.

An installation may keep a copy of the design system elsewhere for sharing (its `.woodshed/install/README.md` says
where). It is not the source: the repo is. Say in the PR when that copy needs to be refreshed from `designSystem/`.

## Where everything is

All in us-east-1, everything named `<prefix>*` and tagged
`project = <prefix>`, where `<prefix>` is the installation's `name_prefix` in its `terraform.tfvars`: `woodshed`, or
`woodshed-cloud` for one set up before the setting existed. `terraform output` (run from `providers/aws/terraform/` after
`terraform init -backend-config=../../../../.woodshed/install/aws/backend.hcl`) prints the ids.

| Thing | Name | Look at it with |
| --- | --- | --- |
| Base box | EC2 `<prefix>-base-box` | `aws ssm start-session --target <base_box_instance_id>` |
| Its stack | `/opt/<prefix>/compose.yml`, unit `<prefix>.service`, written by the SSM association `<prefix>-configure-base-box` from `providers/aws/terraform/baseBoxStack.sh.tftpl` | `sudo systemctl status <prefix>`, `cd /opt/<prefix> && sudo docker compose ps` / `logs console` |
| Its data | EBS `<prefix>-data` at `/var/lib/<prefix>` (Mongo, `console/` state, Caddy) | `findmnt /var/lib/<prefix>` |
| Sessions | ECS cluster `<prefix>`, task definition `<prefix>-session` | `aws ecs list-tasks --cluster <prefix>`, `describe-tasks` for `stoppedReason` |
| Session logs | CloudWatch `/<prefix>/sessions`, stream `session/session/<taskId>` | `aws logs tail /<prefix>/sessions --follow` |
| Postgres | RDS, password in the RDS-managed secret | Reachable from the base box and sessions only. It refuses unencrypted connections, so the task definition sets `PGSSLMODE=verify-full` and the image trusts AWS's RDS CA bundle (`NODE_EXTRA_CA_CERTS`). `no pg_hba.conf entry … no encryption` means `PGSSLMODE` is missing; `self-signed certificate in certificate chain` means the bundle is missing from the image (an image built before it was added) |
| Databases | Postgres on RDS and Mongo on the base box: `woodshed__template`, which the db-admin task builds after each session image (SSM document `<prefix>-refresh-db-template`) when its `paths` (the project file's `databases[].paths`) changed since the commit it was built from (`Template kept`, `Migrating a copy of the template` or `Building the template again` in its log, with why; the deploy workflow's session job skips the task when the last session build had the same `paths`), and a copy of it for each shared session (`woodshed__<id>`) and each person (`woodshed_<login>`). The console's `state.json` keeps where each copy is, under `sessionDatabases` and `databases` | The db-admin task's log: `/<prefix>/sessions`, stream `db-admin/db-admin/<taskId>`. The deploy workflow's session job prints the template task's exit code and log stream |
| Database viewers | `pgweb` and `mongo-express` inside each session, on its own databases, the console's or the ones its environment names (a private session's pgweb on the console's also on its restored copy, through bookmarks in `/tmp/woodshed-pgweb-bookmarks`, and a second mongo-express on its Mongo copy at `/mongo-copy/<id>/`), at `/pg/<id>/` and `/mongo/<id>/` | In the session, `/tmp/pgweb.log` and `/tmp/mongo-express.log` |
| Claude homes | S3 `<prefix>-homes-<account id>`, `<login>/claude-home.tar.gz`: each person's `~/.claude` between their private sessions (the last to stop), `<login>/sessions/<id>/claude-home.tar.gz`: one private session's own, for its Resume, and `_sessions/<id>/claude-home.tar.gz`: a kept shared session's, between its runs, and `<login>/claude-settings.json`: the settings every private session of theirs keeps in step with. Only the console's role reaches it | `aws s3 ls s3://<prefix>-homes-<account id>/` (names and sizes; never download someone's) |
| Images | ECR `<prefix>-session`, `<prefix>-console` | `aws ecr describe-images --repository-name …` |
| Terraform state | S3 `<prefix>-tfstate-<account id>` (or the tfvars' `tfstate_bucket`), see `.woodshed/install/aws/backend.hcl` | Created by hand, so `terraform destroy` leaves it |
| Webhooks | Lambda `<prefix>-webhooks` (URL: the `github_webhook_url` output), queue `<prefix>-webhooks` and `-dead`. The console's Webhook events tab lists what it did with each message | `aws logs tail /aws/lambda/<prefix>-webhooks`, `aws sqs get-queue-attributes --queue-url <url> --attribute-names All` |

## The secrets

| Secret | Used by | What breaks when it is wrong |
| --- | --- | --- |
| `anthropic-api-key` | The console only: its Anthropic proxy adds it to claude's calls in every session not on a Claude plan, and the console's Haiku call that names a My Woodshed session started with no name reads it through the proxy. An app in a session uses whatever key its own env files hold (or the owner's own line) instead, directly. Write-only on the Secrets tab. Never in a session: not in the task definition, and the session holds its `SESSION_TOKEN` in its place | claude says `the console has no Anthropic key` (the proxy's 503) or stops with a 401 from Anthropic. The console logs `anthropicProxy: team key read` with `set`, and `anthropicProxy: credential not read` when Secrets Manager failed. A private session named after its prompt's first line means the naming failed: the console logs `autoName: Anthropic refused` with the status, `autoName: failed`, or `autoName: no team Anthropic key`. Spend-capped by its Anthropic workspace |
| `openai-api-key` | The console only: its OpenAI proxy (`console/openaiProxy.mjs`) adds it to the calls of private Codex sessions with no sign-in of their own, and of review sessions whose author's choice on My settings has Codex review (unless the author's own sign-in is used, below). Write-only on the Secrets tab. Never in a session, which holds its `SESSION_TOKEN` in its place | codex says `the console has no OpenAI key` (the proxy's 503). The console logs `openaiProxy: team key read` with `set`, `openaiProxy: refused, not a Codex session`, and `credential not read` when Secrets Manager failed |
| `oidc-signing-key` | The console only, to sign the tokens its MCP relay adds for a server whose auth is a signed token (`console/oidcIssuer.mjs`); made by the console the first time one is signed. Its public half is at `<console>/.well-known/jwks.json`. Never in a session | `oidcIssuer: signing key not read` or `not saved`, and the relay answers 503; replacing it by hand keeps the old key in the JWKS for 15 minutes, so tokens in flight still check |
| `mcp-servers/<name>/header` | The console only: the value of the header its MCP relay adds to that server's calls (`console/mcpServers.mjs`), set on Console settings' MCP servers card or its API, write-only there, and deleted with the server or when its auth stops being a header. Never in a session, which reaches the server through the relay | The session's call answers 503 `has no value yet` (`mcpRelay: auth not added`) when none is saved, and `mcpRelay: the MCP server refused what the console added` with the status when the server takes it no more: save a new one on the card (`mcpServers: header saved` with the bytes, never the value). On AWS an `AccessDeniedException` saving it means the base box role lacks `mcp-servers/*` in `PeoplesAndSessionsOwnSecrets` (an apply is due) |
| `github-app-key` | The console only, to mint installation tokens for itself and for sessions. Read straight from Secrets Manager, never written to disk, and write-only on the Secrets tab. Never in a session | With no value the console logs `no GitHub App key yet` at start and skips polling until one is uploaded. Otherwise it logs `GitHub refused an installation token` with GitHub's reason. A session's `gh` says `could not get a GitHub token`: check `sessionApi:` lines in the console's log, then that port 7691 is open from the sessions' security group |
| `slack-bot-token` | The console only, to post each pull request a session opens to its project's channel on the Console settings page (or the Slack card's), and to answer questions from Slack in their threads. Set on Console settings' Slack card (Set up Slack, Replace keys), which checks it with Slack's `auth.test` first and never shows it back; the Secrets page no longer lists it. Never in a session | The card says **Token refused** with Slack's error. The console logs `slack: no bot token yet, nothing sent`, or `slack: call refused` with the method and Slack's error: `not_in_channel` means the bot was not invited, `invalid_auth` a wrong token, `channel_not_found` a name where the ID belongs, `missing_scope` a scope console/README.md's "Setting it up: the Slack card" lists (`app_mentions:read`, `channels:history`, `channels:read`, `chat:write`, `groups:read`, `reactions:write`, `users:read`, `users:read.email`) and the app lacks. `missing_scope` for `conversations.list` is an app made before the channel picker: the picker asks for the channel's ID until `channels:read` and `groups:read` are added and the app reinstalled. `slack: keys saved` says who set it, never the value |
| `slack-signing-secret` | The webhooks Lambda only, to check each Slack event (`/slack`). Set on Console settings' Slack card with the bot token, never shown back | Every mention is refused: the Lambda logs `webhooks: bad or missing Slack signature`, and Slack's Event Subscriptions page says the Request URL failed. With no value at all the Lambda fails the read, and Slack sees a 502 |
| `github-app-client-secret` | The console only, to sign people in with GitHub. Write-only on the Secrets tab. Never in a session | The base box's console always requires sign-in, so with no value or a wrong one nobody gets in: GitHub refuses each sign-in code and the console logs `auth: GitHub refused the sign-in code`. console/README.md, "Sign-in", sets it from a shell |
| `users/<login>/claude-token` | The Claude plan of one person's My Woodshed sessions, and the shared sessions they start while their switch for it is on. Made by the console on My settings, never by Terraform; write-only there. Handed to that person's private sessions alone, in the `/settings` answer, for claude to call Anthropic with directly (the Artifact tool needs a real token). Never handed to a shared session: the console's Anthropic proxy adds it to the calls of a shared session whose `plan` is that login and who started it | The session's log says `could not get the owner's settings` and it fails. The console logs `sessionApi: no Claude token for the owner`, or `anthropicProxy: no Claude token saved for the plan` when it was removed mid-session from a shared session's starter. A running private session keeps the token it started with until it stops. claude asks to log in when the token was revoked: save a new one |
| `users/<login>/codex-auth` | One person's Codex sign-in from My settings: an OpenAI API key, or `~/.codex/auth.json`. Handed to their private Codex sessions alone, in the `/settings` answer; a session writes a refreshed ChatGPT login back at stop (`POST /codex-auth`) since OpenAI rotates it. Never handed to a review: while their switch for reviews is on, the console's OpenAI proxy adds it to the calls of a review of their pull request (`review.codexLogin`), the access token and account of a ChatGPT login on `/chatgpt`, a key on `/openai`, and never refreshes it | The console logs `sessionApi: Codex sign-in decided` with `own`, and `Codex sign-in kept` or `refused` at stop; statusd logs `statusd: Codex sign-in sent back` with the status. For a review, `fleet: review session started` with `codex` (`own ChatGPT login`, `own key` or `team key`), `fleet: review runs other than the author chose` with `why` (an expired login), and `openaiProxy: refused, the author's sign-in not usable` when it was turned off or expired mid-review. codex asking to log in means the saved login expired or a session never stopped cleanly to save the rotated one: save a new one |
| `users/<login>/grok-auth`, `…/opencode-auth` | One person's own sign-in for Grok Build (an xAI key or `~/.grok/auth.json`) or OpenCode (its `auth.json`), from My settings (`shared/agents.cjs`). Those agents run on nothing else: no team key, no proxy. Handed to that person's private sessions of that agent alone, in the `/settings` answer; never to a shared session, a question, a QA run or a review. While their switch for reviews is on, the console's review agent proxy (`console/reviewAgentProxy.mjs`) adds it to the calls of a review of their pull request when the default includes that agent or their reviewer choice names it (`review.ownSignIns`): Grok's key or unexpired login on `/grok`, an Anthropic or OpenAI API key of OpenCode's on `/opencode/<provider>`, never a login, and never refreshes it. Their logins rotate, so a session writes the refreshed one back at stop (`POST /agent-auth`). No code of the branch's runs by itself in such a session. Extra Claude Code and Codex agents skip branch hooks and MCP servers, and use their own authentication paths. Extra Claude uses the owner's saved token directly, supplied with the start and stored outside the saved Claude home. Extra Codex uses its own sign-in if saved, or the scoped OpenAI proxy. The start lists the installs a branch changed in `/tmp/woodshed-deps` (`skipped: this <Product> session runs none of the branch's installs by itself`), and the agent runs them as commands of its own. What the agent itself runs, or the app once started, can read it, as it can the owner's Claude token and Codex sign-in | New session refuses with `save your <Product> sign-in on My settings first`; a start whose sign-in was removed since logs `sessionApi: no <Product> sign-in for the owner`, and one that got it `sessionApi: <Product> sign-in handed out` (`apiKey` true or false, never the value). At stop, `sessionApi: <Product> sign-in kept`, `not kept, the saved one is newer`, `not kept, the saved one is not the one the session was given` (a sign-in saved on My settings while it ran, or another session's refresh: the saved one stays) or `refused`. The agent asking to log in means the saved login expired or a session never stopped cleanly to save the rotated one: save a new one. For a review, `fleet: review session started` with `grok` (`own key`, `own login`) or `opencode` (`own <provider> key`), `fleet: review runs other than the author chose` with `why` (`Grok Build left out: the author's saved Grok Build login has expired`, `the author's saved OpenCode sign-ins have no API key of anthropic or openai`), and `reviewAgentProxy: refused, the author's sign-in not usable` when it was turned off, removed or expired mid-review |
| `repos/<project>/env/<key>`, `repos/<project>/instructions`, `users/<login>/repos/<project>/...` | Repo settings (`console/repoSettings.mjs`, console/README.md "Repo settings"): the installation's values for each env file of a repo and its instructions, and each person's own. Made, read and deleted by the console, and the only place the console keeps an env file's values: no Terraform secret or task definition holds them. A program that embeds the console may give a file's installation values from a source of its own instead (`envSources`, console/README.md "Embedding the console"): sessions then get the source's text, asked for at each start and never kept, and the typed value stays stored, handed to no session. What each file must hold is the installation's: its `.woodshed/install/README.md`. Handed out by the session API's `POST /repo-settings`, the personal ones to that person's private sessions alone, which write them into the env files and the rules. The db-admin task's seed reads the default project's `repos/<project>/env/<key>` for its databases' env files itself (its entryPoint's `--project`; on AWS its role reads that project's and no other's), so it sees the typed values and never a program's source | The console logs `repoSettings: handed out` with the keys each layer gave, and with `fromSource`, the files whose installation text came from a program's source: `repoSettings: env source text refused, the installation layer handed out as none` (how many, and what was wrong with them) or `env sources not read, the typed values handed out` (`why`: the hook threw, answered no object, or gave no answer in 10 s) says why a session got none of it. Neither carries the program's own text: an error's class, never its message or code. `sourceKeysDropped` on `handed out` counts keys a source answered that are no env file of the project file's: no session is handed those. The session logs `Repo settings fetched` with the keys and sizes it got, and `Env files written` with each file's layers; `Repo settings not offered by the console` means a console from before them, and its env files get the repo's defaults alone. The db-admin task logs `Seed env files read` with where each key came from (`repo settings` or `none`), and its seed the same `Env files written` line; `none` for a key that Console settings → Repos shows a value for means the entryPoint's `--project` is not the console's default project (Terraform names it from `projects`, else from `github_repo`). Never print a value: these lines carry keys and sizes only |
| `users/<login>/tmux-conf`, `…/gitconfig`, `…/inputrc`, `…/bash-aliases` | One person's own lines for tmux config and those dotfiles, from My settings' rows or `woodshed settings push`, written after the image's (or the start's) in their private sessions only. Readable by them, since their sessions hold the same text. The dotfiles take only what `shared/dotfiles.mjs` allows, which never holds an identity, a credential helper, a path or a credential. A `users/<login>/<env secret>` left from before Repo settings is read by nothing | A bad line breaks only that person's sessions: the session's log says `Owner's settings fetched` with `own lines in: ...`; **Clear mine** on My settings (the row, or the env file under Repo settings) fixes it. A refused save logs `userSettings: file refused` with the key (`cliSettings: dotfile refused` from a computer). The rules above apply to these too: no production credentials |
| `users/<login>/github` | One person's GitHub App user token from Connect GitHub (JSON: the token, its expiry, the refresh token), for their private sessions' git and `gh`. Made and rotated by the console (`githubUser.mjs`); never in a session | Their next push fails with `GitHub no longer accepts @<login>'s authorization`: the console logs `githubUser: GitHub refused the refresh, disconnecting`. Connect GitHub again on My settings. A session whose project file says `githubAccess: repo` gets it scoped to that project's repo (`githubUser: scoped token made`); `githubUser: GitHub refused a scoped token` or `no scoped token, the console has no client secret`, then `sessionApi: no scoped owner token for the session's project`, means it pushes as the App instead |
| `sessions/<id>/database`, `users/<login>/database` | The password of each database's own user: `woodshed__<id>` for that shared session and the viewers inside it, deleted with its databases; `woodshed_<login>` for that person's private sessions and the viewers inside them. Made by the console. Not on the Secrets tab | See the database symptoms below |
| RDS's own master secret, `<prefix>-root/mongo` | Each only where the installation runs that database (`databases` in Terraform). Root, for the db-admin task alone, through its execution role. Not the console, not the base box (which writes Mongo's once and cannot read it back), not a session | The db-admin task's log (`/<prefix>/sessions`, stream `db-admin/...`) fails at its first connection. A Mongo root password that could not be saved is in `/root/<prefix>-mongo-root` on the base box: put it in the secret, then delete the file |
| Each install secret (`install_secrets` in Terraform, such as `registry-token`) | The repo's dependency installs: the image build's (a line of the build's `install_env` secret, which the deploy workflow's session job writes from a repo secret) and a session's, only when a branch changed an install's files since the image was built. A session gets it in the variable `install_secrets` names, which claude's terminal has too; an ask session unsets each variable `WOODSHED_INSTALL_SECRETS` lists | `/tmp/woodshed-deps` says `failed: \`<command>\` in <dir>. Are the install secrets (<variables>) right?`, the log has `ERROR: the install failed` with the dir, and Claude asks for help. The image build logs `deps: install secrets in <variables>`, or `deps: no install secrets` when it got no `install_env`. In a session's Terminal, `[ -n "$<variable>" ] && echo set` |

The entrypoint adds the session's databases, Mongo, Redis (when the project uses it), the shared services, port and
URL on top of each env file's Repo settings values
(`writeEnvFiles` in `session/entrypoint.sh`), so those never belong in them.

## By symptom

- **A session cannot reach something since it was tainted.** That is the lockdown (docs/reference.md, "Production
  access"): the console logged `fleet: session tainted`, and its card says Production. A call through the egress proxy
  answers 403 `refused by this session's lockdown: <why>`, and the console logs `egress: refused` with the session, the
  host and why (once each); a call round it finds no DNS and no route. GitHub is allowed only for its own project's
  owner's private repos, and its own project's repo to read even when public: a push to a public repo answers `is public`, `is not <org>'s` is another owner's, `could not tell whether <repo> is private` is
  GitHub not answering anonymously (60 calls an hour). In the session, `cat /tmp/woodshed-egress.env` shows the proxy's
  variables, and `/tmp/woodshed-tainted` its taint. A git call that says `Proxy CONNECT aborted` is a git without
  `GIT_HTTP_PROXY_AUTHMETHOD=basic` (an image from before it). Nothing undoes a taint: what it needs that is not
  installed, a new untainted session installs. Before a taint, an AWS guarded session's call refused with `not a public
  address` is a name or address on the console's own network (loopback, the instance's metadata, the VPC), which the
  proxy never reaches for it; `reaches the internet itself` is a session whose launcher does not send it through the
  proxy. A tainted session's GraphQL call refused with `could not read`, `only operation`, `as variables` or `does not
  declare` is a mutation document shaped otherwise than `gh` makes them. Its Anthropic calls are refused for an image
  or document given by URL, and for a body that is not JSON (`anthropicProxy: refused, a tainted session's call the
  console cannot read`).
- **An MCP server from Console settings fails in `/mcp`, or a session does not have it.** First press **Test** on its row:
  it calls the server as the relay would and says what failed in one sentence (`mcpServers: server tested` with `ok` and
  `status`). A server at a link-local address, or a name resolving to one, is refused by both (`mcpRelay: refused, a
  link-local address`). A session gets the servers
  that existed when it started: its log says `MCP servers offered` with them, or nothing when it got none
  (`WOODSHED_MCP_SERVERS`, from `mcpServers.forSession`: a QA run, a review and a Codex session get none, a shared one
  only those marked for shared sessions, a production one only where the console can lock a session down). The console
  logs `mcpRelay: refused` with `server` and `why` (a person or repo the server does not list, a session that is not
  private, a tainted session calling an ordinary server), `mcpRelay: refused, no such server` for one removed since,
  `mcpRelay: auth not added` for a header with no value yet (set it on the card), `mcpRelay: the MCP server refused what
  the console added` with the `status`, and `mcpRelay: MCP server not reached` when the console cannot reach its URL
  (on AWS, the server's allowlist must have the base box's Elastic IP). For a signed token the server must trust this
  console: its issuer, audience (the card's, `woodshed-prod-mcp` for woodshed-prod-mcp) and JWKS URL
  (`<console>/.well-known/jwks.json`, shown on the card) must match, and that URL must answer from where it runs. Who
  changed a server: `mcpServers: server added`, `server changed`, `server removed`, `header saved` or `header cleared`.
- **A production server refuses, or Console settings will not add one.** The card says why the console cannot lock a
  session down (no session API, no egress proxy address, or on AWS no guarded network: Terraform's `prod_mcp`), and
  the console logs `mcpServers: production access is off, this console cannot lock a session down` at start for the
  environment's. A call refused with 503 logs `mcpRelay: refused, the session was not locked down` with the launcher's
  reason, after `fleet: lockdown failed, the session stays untainted`, or with `started before it could use production`
  for a session that was not eligible at its first start (`fleet: a session that may use production` is logged for
  those that are: they start on databases of their own and, on AWS, the guarded network), which a new My Woodshed
  session fixes: `machine's Docker socket` is a session started
  with it (a new one is not), `Docker 28 or newer` the docker launcher's isolated network, `given by its address` a
  destination in the session env the gateway cannot carry, and on AWS `outside the guarded network` a session started
  before `prod_mcp`. On the local provider the call that taints loses its connection as the session changes networks:
  claude reopens and reconnects (`statusd: claude reopened on the console's proxy`).

- **The console URL does not load.** On the base box: `systemctl status
  <prefix>`. Its first start fails until the console image exists;
  `sudo <prefix>-up` once it does. A 421 means
  the host name is not one the console knows, which is the DNS rebinding check
  working.
- **A console on sslip.io (no `domain` in Terraform) gives a certificate error.** Caddy gets each name's certificate
  on demand, after asking the console on 127.0.0.1:7692: the console logs `tls: ask listening` at start, then `tls:
  certificate asked` with `allowed` and `why` for each name, as in "Open app answers with a certificate error on a local
  install, or on AWS with no `domain`" below. `sudo docker compose logs caddy` on the base box has the issuer's answer; a Let's Encrypt rate limit
  on `sslip.io` is shared with everyone, and Caddy then tries ZeroSSL.
- **The desktop app's sign-in opens the browser, which signs in, and the app stays signed out.** The browser asks
  **Sign in to the Woodshed app?** first (a 403 on its button means the form did not come from the console's own page),
  and the page after it hands the app a `woodshed://` link: the console logs `auth: desktop sign-in code issued`, then `auth: desktop signed
  in` once the app claimed it, or `auth: desktop sign-in code refused` with `known` (false: used, expired, or from
  another console) and `verified` (false: not the verifier of the sign-in the app started). No claim at all means the
  link never reached the app: the browser asked whether to open Woodshed and was told no, or the OS has no app for
  `woodshed://` (a run from a checkout registers Electron for it; a built one registers itself). **Sign in in this
  window instead** on the app's waiting page always works (console/README.md, "Sign-in").
- **Nobody can sign in to a console with no repo yet.** Until an admin adds one (Console settings, Repos), only the
  owner of the account the GitHub App is installed on gets in: the console logs `appOwner: owner checked` with the
  `account`, its `type`, the `role` for an organization and `owner`. `appOwner: the App may not read the org's
  members` means the App lacks Organization permissions, Members: read, and the login page says so. Starts on such a
  console log `fleet: session refused, the console has no repo yet`.
- **The console's domain gives a certificate error, while the bare IP works.**
  Caddy has no certificate for the name yet: `sudo docker compose logs caddy`
  on the base box. `dig NS <domain>` must list the zone's
  nameservers (the `dns_nameservers` output); `AccessDenied` on a `route53:`
  call means the box's role cannot write the `_acme-challenge` TXT record.
  Caddy retries by itself, with a growing pause between tries.
- **The deploy workflow's console job fails to restart the console** (providers/aws/README.md, "The deploy workflow"). Its log prints
  the SSM command's output. `aws ssm list-command-invocations --details
  --instance-id <base_box_instance_id>` shows past runs. The base box must be a
  managed SSM node (`aws ssm describe-instance-information`). `no space left on
  device` in that output means old images filled the box's root disk: the restart
  and `<prefix>-up` prune unused images, so this is an image from before
  they did. On the box, `sudo docker system df`, then `sudo docker image prune -af`
  (running containers keep theirs) and re-run the job. The console keeps running on
  its old image meanwhile.
- **`woodshed review enable` says something is missing, or will not write the project file.** Exit 2 lists the
  console's steps, from `GET /api/review-readiness` (console/README.md, "The reviewer App"): `reviewer-app` is no
  reviewer App made (`/setup/github`), `reviewer-installed` one not installed on the repo, `reviewer-installed-unknown`
  its installation not read (`reviewerApp: key not read, installation not known` for the console's own reviewer App;
  `reviewReadiness: reviewer App installation not read` when GitHub failed; nothing logged when a host's reviewer App
  has no `installedOn`, console/README.md, "Embedding the console"), `runs-on` a default branch whose
  `runsOn` names another console, and `repo` a repo the console does not have, or the person cannot start sessions on
  or no longer writes to (`reviewReadiness: refused, no write access to the repo`). `Console: not asked` says why it was not: no sign-in, an origin
  not on GitHub, or a console from before the route. Exit 1 with `does not read as a project file` or `project check
  found problems` left the file as it was; `written inline` is a `pullRequests` or `review` written as `{…}`, which it
  does not edit. Exit 1 with `the console did not say it can run the review` kept the edit, but the console was not
  reached, has no GitHub App (404), or could not read the default branch's project file (`was not read`, with why). It writes no workflow, secret or key: a repo with no console uses `scripts/enable-review.sh`.
- **A label or `/woodshed` comment does nothing.** A label on a pull request
  never starts a session (console/README.md, "How sessions start"): the console logs
  `fleet: trigger routed` with `action: ignore`. Otherwise `docker compose logs
  console` on the base box. Check it has no `GitHub refused an installation
  token` lines, and that the person is a collaborator with write access: the console ignores
  anyone else. The repo's settings page (Console settings → Repos → Settings, Sessions from GitHub) may turn its label
  or `/woodshed` comments off, or name its label otherwise than `woodshed`: the console logs `fleet: trigger ignored,
  the repo turns it off`, and `repoTriggers: changed` with who changed it. A label of another name is not this repo's
  and starts nothing.
- **A shared session is Unassigned, or has the wrong person.** The console logs `fleet: session starts unassigned, its
  starter cannot be assigned` when the label or comment came from someone whose People role is Contributor or Private only (Can be assigned off), and `fleet:
  session assigned` with `from`, `to`, `by` and `how` (`label`, `comment`, `console`, `take it`, `hand over`, `unassign`) on every
  change. Someone who can be assigned commenting on an unassigned session takes it; a later comment on an assigned one does not move it.
  `members: can be assigned changed` and `members: sessions from GitHub changed` say who turned a switch. Assign answers 409
  `only someone who can be assigned sessions can assign one` or `@x cannot be assigned sessions`. A private session, a
  question from Slack, and a review or QA run the console started cannot be assigned (`a review or QA run has
  nobody to assign`).
- **A label or /woodshed comment got a "can't start Woodshed sessions from GitHub yet" reply.** Their Sessions from
  GitHub is off on People: the console logs `fleet: trigger ignored, no sessions from GitHub`, and `fleet: label removal
  failed` when GitHub kept the label. The same person sees no Everyone tab, and a shared session's link answers 404 for them.
- **An issue's assignee or project status did not follow its session.** The console logs `issueTracking: issue marked
  in progress` with the boards `moved` and `skipped` (`no In progress status`, `already in progress`), and
  `issueTracking: assignee put on the issue`, `taken off the issue` or `already on the issue`. `fleet: issue in progress
  failed` or `fleet: issue assignee failed` with `Resource not accessible by integration` means the GitHub App lacks
  the org's Projects write or the repo's Issues write permission, or the org has not accepted it yet.
- **Labels and comments take a minute, the Webhook events list stays empty, and QA labels, QA after a review, the
  automatic QA label, reviews started by a commit's tag or Needs a human messages do nothing.** Someone turned GitHub
  webhooks off on Console settings' Webhooks card: it says since when and by whom, and the console logs `webhooks:
  switched` with `source`, `off` and `by`, then `webhooks: off, dropped a delivery the poll does not cover` with the
  `kind` the first time each of those is dropped. The poll finds only the label and `/woodshed` comments. Turn the
  switch back on.
- **A label takes up to 5 minutes to start a session.** Webhooks are not
  arriving and the fallback poll found it. The webhook card on the Secrets &
  webhooks tab says which of its four checks fails; **Check again** opens the
  test step, which lists GitHub's last deliveries. A 401 means the App's
  webhook secret and `<prefix>/github-webhook-secret` differ, and
  Reconnect sets the stored one again. No deliveries at all after a label means
  the webhook is not Active in the App's settings. The Lambda's log shows each
  `queued` or `ignored` event, and the console logs `webhooks: listening` at
  start or `webhooks: queue not reachable` when its role cannot see the queue.
  Messages the console failed on three times sit in `<prefix>-webhooks-dead`.
- **Signing in fails.** The login page says why. "The console could not
  check your access with GitHub" is the console's own failure, not the
  person's: it logs `auth: sign-in failed` with `step` and the error.
  `gh is not installed on the console` (`spawn gh ENOENT` before it) at
  `write access` means `gh` is not installed where the console runs; `GitHub refused the sign-in code (incorrect_client_credentials)`
  a wrong client secret, after `auth: GitHub refused the sign-in code`;
  `fetch failed` GitHub not reached. "has expired or was already used" is
  GitHub's `bad_verification_code`: sign in again. GitHub showing "The
  redirect_uri is not associated with this application" means the App's
  Callback URL is not the console's `/auth/callback`. "has no write access"
  is the console's own collaborator check, the same one `/woodshed` comments
  get. The console logs `auth: signed in`, `auth: sign-in refused` and
  `auth: callback refused` (an expired or replayed link). `auth: signed in`
  with `member: false` is a writer not on the People list: they see Ask to
  join, and the console logs `members: asked to join`, then `members: request
  accepted` or `declined` with who did it (`members: invited` and `members:
  removed` likewise). `members: list started` at the first start after the
  list shipped says how many people it began with. "was another GitHub
  account's name" means the handle was first seen here on another account
  (`auth: sign-in refused, the handle was another account's`; a label or
  comment from it logs `fleet: trigger ignored, the handle was another
  account's`). Once you are sure the old owner is gone, stop the console
  (`sudo docker compose stop console` in `/opt/<prefix>`), delete the
  handle's entries under `githubAccounts`, `slackAccounts`, `people` and `databases` in
  `/var/lib/<prefix>/console/state.json`, start it again, and delete the
  `<prefix>/users/<handle>/` secrets. Leaving any of them hands the new
  account the old one's token or databases. The login page
  saying nobody can sign in means the client secret is missing: the console
  logs `console: GitHub sign-in` with `available: false` at start. Locked out
  altogether: console/README.md, "Sign-in", has the way back.
- **A new console has no GitHub App.** It logs `console: no GitHub App and no gh token` and offers `/setup/github`
  (console/README.md, "Setting up the GitHub App from the console"). The console logs `githubSetup: manifest started`,
  `App created from the manifest` or `App details saved`, `installation saved` or `App not installed on the repo yet`,
  and after the restart `console: GitHub App from the setup page`. `manifest conversion refused` means the code was used
  or older than an hour: start again. No Restart button on step 3: the start's `githubSetup: restart from the page`
  line has `offered: false`, so neither systemd (`INVOCATION_ID`) nor `WOODSHED_SUPERVISED=1` said something
  starts the console again. A click logs `githubSetup: restart asked` and the process exits with code 75; a console that
  stays down after it has a unit without `Restart=on-failure` (or a container with no restart policy).
- **Sign-in fails and every poll logs `spawn gh ENOENT` or `gh is not installed on the console`.** The console's
  machine has no `gh`, which every GitHub call goes through, the App's included: it logs `console: gh not installed,
  GitHub calls will fail` at start, and `auth: sign-in failed` and `console: github poll failed` name it. Install it
  (https://cli.github.com) and restart. The console image has it; the local provider's host needs it.
- **The console does not start, logging `WOODSHED_REQUIRE_SIGN_IN needs
  the GitHub App`.** The base box always requires sign-in, and sign-in needs
  the App: check `WOODSHED_GITHUB_APP_ID` in `compose.yml`.
- **New session says to save a Claude token, or a private session fails at
  start.** No token is saved for that login, or the session API refused: the
  session's log has `could not get the owner's settings from the console`, and
  the console's has `sessionApi: settings handed out` or the reason it did not.
  `AccessDeniedException` on `create-secret` means the base box role lacks the
  `PeoplesOwnSecrets` statement (an apply is due). A teammate's private session
  is invisible by design: nobody else can see it in the console.
- **A session fails at start with `could not get the owner's settings` (or the
  session's databases) and `status 000`, after `Empty reply from server` or
  `Couldn't connect to server`.** The console was away for longer than the
  session waits: its calls to the console (`consoleCall` in `session/entrypoint.sh`,
  and `githubToken.sh`) try again for about 40 s on anything but a 4xx. A
  redeploy stops the console for a few seconds: it logs `console: stopping` with
  the signal, then `console: stopped` with its seconds, and `requests still open
  at the stop, cut off` when some had not answered in 7 s. Check the
  `woodshed-cloud-redeploy-console` SSM commands (`aws ssm list-command-invocations
  --details --instance-id <base_box_instance_id>`) and the deploy workflow's runs
  at that time. No `console: stopping` before the new console's `console: listening`
  means it was killed, not stopped: a crash, an out-of-memory kill or the box
  rebooting. A status other than 000 is the console's own answer, given after it.
- **`woodshed login` or `woodshed status` fails.** The CLI's own message says which step (cli/README.md): `answered
  404` is a console from before the command line could sign in, or a hosting proxy that does not pass `/api/cli/*`
  through. The console logs `cliSignIn: sign-in started` with the computer's name, then `sign-in approved` or `denied`
  and `token made`; `refused, a browser's call` is a call with an Origin header (a page, never the CLI). `status`
  exiting 2 with `ended` is a token revoked on My settings' Command line row (`cliSignIn: token revoked` with `by`),
  expired after 90 days, one whose person left People (`refused, the token's person is no longer a member`), or one
  whose person lost write access to the repo (`refused, write access gone`, which ends all their sign-ins): sign in
  again. `Too many sign-ins from this address are waiting` is 5 codes from one address still holding their places: a
  code holds one until its CLI collects it, it is denied, or its 10 minutes pass, so an approved code not yet collected
  counts (`cliSignIn: sign-in refused, too many waiting` with `scope: 'client'` and `lastFrom`); the same refusal for many people
  at once, all with one `lastFrom`, is a proxy in front that reaches the console from an address `WOODSHED_TRUSTED_PROXIES`
  does not list (loopback is trusted by default), so its `X-Forwarded-For` is not read. The token is in the macOS
  Keychain or libsecret, else in the file `woodshed status --json` names (`credentialsFile`; on Windows, sealed with
  DPAPI, or a plain file when `store` is `file`); never print it. On Windows `login` refusing with `could not be made a
  folder only you can open` says why: the SIDs still allowed on `%LOCALAPPDATA%\woodshed` besides the person's own,
  SYSTEM's and Administrators', or that it could not be made theirs.
- **`woodshed setup` or `woodshed sign-in push` did not save a Grok Build or OpenCode sign-in.** The message says why
  (cli/README.md, "Start here with `woodshed setup`", step 4): `is not a Grok Build sign-in` (or OpenCode) is the file
  failing `checkSignIn` on the computer, and nothing was sent; `is not there` is no file where the agent keeps it
  (`$GROK_AUTH_PATH`, `$GROK_HOME/auth.json` or `~/.grok/auth.json`; `$XDG_DATA_HOME/opencode/auth.json` or
  `~/.local/share/opencode/auth.json`); `saved already` is one the console has, replaced only with `--replace` (setup
  asks, or `--grok-sign-in=replace`); `does not run Grok Build sessions` is a console whose `/api/cli/me` lists no such
  agent. A send logs `cliSessions: call` with the login and `path: '/api/my/agent-auth/<agent>'`, then `userSettings:
  <Product> sign-in saved` (`apiKey` true or false, never the value). `answered 403` or `404` with `a console from
  before` is a console whose `cliSessions.mjs` does not list the route (`cliSessions: refused, not a route the command
  line may call`); `refused it (409):` is the console's own check, as My settings' Save; a 502 is the secret store, which
  the console logs as `console: My Woodshed change failed`. `its answer repeated part of the sign-in, so it is not
  shown` is an answer, from the console or something in front of it, that held part of what was sent: the command never
  prints it, so read the console's (or the proxy's) own log for why. Setup that asked and got a yes goes on after a
  failed save (`saveFailed: true`); with `--grok-sign-in` or `--opencode-sign-in` it stops there.
- **`woodshed settings` skips or refuses an item.** The list says why (cli/README.md, "Settings"). The console logs
  `cliSettings: pushed` or `cliSettings: refused`. A 404 from `/api/cli/settings` means the console has nowhere to keep
  Claude homes or predates the command.
- **`woodshed tunnel` exits 255.** Its stderr says why (cli/README.md, "The tunnel into a session"): `refused (401)`
  is a sign-in revoked or expired, or its person's write access gone (`woodshed login` again), `refused (404)` a session that is not that person's own,
  `refused (409)` one not running (resume it) or one that has seen production data, which never gets a pipe. The
  console logs `execPipe: refused` with `why`, `execPipe: session unreachable` when statusd's port did not answer, and
  for a pipe that opened, `execPipe: closed` with `why` (`ended`, `the token was revoked`, `the token ended`, `the
  session is being locked down`, `not running`). A pipe cut while the session ran on, with `why: 'ended'`, is the
  computer's side or the network going; one cut when the session paused is the idle pause, which a pipe does not hold
  off. In the session, statusd logs `statusd: exec opened` and `exec closed` with the exit code.
- **`woodshed session connect` does not open, or drops.** It is the same path as the tunnel, a websocket to the
  session's ttyd (console/README.md, "A terminal from the command line"), and the same lines with `kind: 'term'` or
  `'shell'`: `execPipe: refused` with `why` (`no terminal` is a session image from before the Terminal tab, for
  `--shell`), `refused by the session` with ttyd's status, `closed` with `why`. A terminal that opens and closes at
  once with 1008 is ttyd refusing the console's first message: a ttyd other than 1.7.7's protocol. A drop says
  `connecting again` and tries for a minute while the session runs; one that says the session is paused or stopped
  needs `session connect` again, which resumes it.
- **`woodshed session` fails, or a start it waits on never ends.** Each command's message says what the console
  answered (cli/README.md, "Sessions"): exit 3 with `does not reach this` is a route its token may not call
  (`cliSessions: refused, not a route the command line may call`; the list is in `console/cliSessions.mjs`), and
  `answered 404` a console from before it, or a hosting proxy that does not pass the session routes through with a
  `wsc_` token. Exit 2 with `no longer have write access` is GitHub saying the person lost write access to the repo
  (`cliSignIn: refused, write access gone`), which ends all their command line sign-ins. The console logs `cliSessions: call` with the login, the token's id and the path for each write, then
  what the page's own call would: `fleet: starting session`, `fleet: session extended`, `fleet: session limits
  changed`. A wait that stays at `Waiting in line` is the person's limit (`fleet: private session waits in line, at the
  limit`); otherwise it reads the same start steps as the page's checklist, above. Ctrl-C stops the wait, not the
  session. `extend` refused with `Extend is offered in the last 15 min` is the console's rule: `session get` says when
  it pauses. `session read` refused with `seen production data` is a tainted session, whose
  conversation stays on the console (`cliSessions: refused, a tainted session's conversation`); `send` with exit 3 is the Chat
  tab's own refusal: a session that cannot send safely (`console: message from the page refused, the session cannot
  send safely`), or a message that went into the agent's box as a prompt came up. While the agent works, or has a
  question or approval on screen, it is held instead (`Held`, `fleet: message held until the agent is at its prompt`).
- **`woodshed config set` is refused.** Exit 3 with `Valid:` is a value the console's own check refused (the same as
  My settings'); with `On My settings:` a step only the page does first (save a Claude token or Codex sign-in, connect
  GitHub); `is a secret` is a key it never sends. The console logs `cliSessions: call` with the path, then the page's
  own line (`userSettings: terminal changed`, `reviews of my pull requests`, `own token for shared sessions`, `own
  Codex sign-in for reviews`, `git identity changed`). `answered 404` or `does not let the command line change` is a
  console from before `GET /api/cli/config` (cli/README.md, "Your choices on My settings").
- **Hand off refused, or the new session does not know what the old one did.** The console logs `fleet: session handed
  off` with both ids, the agents, `conversation` and how many `entries` went (console/README.md, "My Woodshed"). `hand-off
  refused, the conversation not read` is statusd not answering `/transcript`: nothing was stopped. `it was stopped meanwhile: nothing
  was handed off` is a Stop pressed while the conversation was read, which went ahead as an ordinary stop. `checkpoint failed,
  the session keeps running` is its push refused (often a branch moved on remotely): it runs on with its work committed
  in its checkout; pull and push there, then hand off again. A production call refused with `being handed off` is a
  lockdown asked for mid-hand-off, which the two never share. `hand-off stopped the
  session, the new one did not start` gives why; the old one is stopped with its work pushed, and Resume reopens it. A
  new session with no `handoff.md` in `/tmp/uploads` was handed off with the conversation left behind, or its
  attachments were not fetched (`WARNING: attachments not fetched` in its log).
- **`woodshed-session` in a session refuses, or the session it started is missing.** It says why (console/README.md,
  "Sessions that start sessions"): `only a My Woodshed session can` is no `/tmp/woodshed-start-token` (a shared session,
  a question, review or QA run, a tainted one, or an image from before it; the session's log says `Session starts on`
  when it got one), `its start token is not one the console knows` a token from a run that stopped, and `no longer has
  write access to the repo on GitHub` its person's write access gone while they stay on People. The console
  logs `sessionStarts: session started` or `start refused` with `why`, and for `start checks` the `status` New session's
  own checks answered with, then the start's usual `fleet: session created` with `startedFrom`. A message between two sessions logs
  `sessionStarts: message` with its `outcome`: `queued` is held until the other is at its prompt (it works, waits in
  line or is paused), as Chat's held messages are; a `send --wait` that says `it did not take up what was sent` saw the
  other neither work nor hold it for 90 s. `woodshed-session agent …` is a helper agent beside the session's own: the console logs `sessionStarts: agent asked
  for`, then the + Another agent lines below, with the same refusals. A session that reads **asked a question** sent
  `reply --question` (`fleet: session asked a question`) and is not answered yet: a message to it, or its working again,
  clears it (`fleet: question answered` with `why`).
- **A private session starts without its MCP logins, or Resume opens a blank
  claude.** The session's log says `Claude home restored`, `No Claude home
  saved yet` or `WARNING: Claude home not restored` with the status. Every 5
  minutes when the home changed, and at stop, statusd logs `statusd: Claude
  home saved` or `Claude home not saved` with the reason and `why` (`periodic`
  or `stop`), and the console logs `sessionApi: Claude home saved` with the bytes
  and `periodic`, then, at stop only, `homes: copied` to the owner's, or
  `sessionApi: owner's Claude home not updated` (the session's own is still
  kept). After the stop's save, statusd makes no periodic one. `sessionApi:
  Claude home handed out` says with `own` whether a resume got its own home or
  the owner's.
  A 413 means it went over 200 MB. A home nobody saved answers 404 only while
  the console's role has `s3:ListBucket` on the bucket; without it, S3 says 403.
- **A setting changed in one private session does not reach the others.**
  Every 20 seconds statusd logs `statusd: shared Claude settings synced` with
  what it sent and wrote, when anything moved, or `shared Claude settings not
  synced` with the reason; the console logs `claudeSettings: changed` with the
  version. At start the session's log has `settings: version …`, or `WARNING:
  shared Claude settings not pulled`. A change landing on disk but not in
  claude is one it reads only at start (console/README.md, "Your Claude settings").
  `sessionApi: shared Claude settings refused` means the copy went over 5 MB,
  almost always something large in `skills/`.
- **A plugin or a Codex setting from another session or the person's computer is missing.** Plugins are installed as a
  session starts, never while it runs: its log says `Plugins from your other sessions installed` with the counts, and
  `WARNING: a plugin from your other sessions was not installed` (a marketplace that is a folder, a pinned ref or a URL a
  session does not add), `a plugin's marketplace could not be added` or `could not be installed` with claude's error. A
  plugin already offered once is not installed again (`~/.claude/woodshed-default-plugins.json`): one uninstalled in a
  session stays so. Codex's `config.toml` keeps each side's trusted folders, and the start adds the checkout's
  (`codex's config.toml could not be written` stops it); `[projects]`, providers, entries with a credential or a home
  path are never carried from a computer (`woodshed settings plan` names each). The rules are in
  `~/.codex/AGENTS.override.md`, with the person's `AGENTS.md` after them.
- **My Woodshed's Pull requests group is empty or stale.** It is GitHub's
  search, asked with the console's App token at most once a minute per person;
  a failure logs `console: pull requests not readable` and keeps the last list.
  Remove My Woodshed logs `console: My Woodshed removed` with how many sessions
  it stopped and took off the list.
- **Someone cannot open a shared app, or a share link says it expired.** Only a My Woodshed session's owner shares
  its app (console/README.md, "Sharing the app"). A member sees the app only while the owner's **Members of this
  console** switch is on and they are on the People list. A link answers 403 `expired or was turned off` when it ran
  out, was revoked, was made for another session, or the session stopped since: a new link is needed, and a stopped
  session's shares are dropped at the console's next tick. The console logs `appShares: link opened`, `link refused`
  (no id: the token is never logged), `link issued`, `link revoked`, `members changed` and `shares ended` (with `why`
  when the session was no longer active). A link opened but the page keeps asking to sign in means the browser
  dropped the `__Host-woodshed_view` cookie: it needs https, like the app's own cookie below.
- **A session app keeps bouncing to the console, or says "That sign-in link has
  expired".** The app's name trades a one-time code for its own cookie; the
  code lasts a minute and works once, so a slow or replayed redirect lands on
  the expired page, and opening the app again fixes it. The console logs
  `app: sending to the console to sign in`, `auth: app sign-in code issued`,
  `auth: app signed in` or `auth: app sign-in code refused` (with `sameApp`
  false for a code made for another session). A loop with no `app signed in`
  means the browser dropped the `__Host-woodshed_app` cookie: it needs https,
  so the app must be opened by its `https://` name. A websocket or API call
  refused with 401 (`app: websocket refused, not signed in`) means the page was
  loaded before signing in: reload it.
- **A session never starts, or stops at once.** The console shows the task's
  stop reason. An empty secret shows as `ResourceInitializationError`. A
  missing image shows as `CannotPullContainerError`. Otherwise read the
  session's log stream: the entrypoint logs each step (`[woodshed …]`).
- **A session fails at once with `the session image has no checkout and the console named no repo`.** The image was
  built with no repo (install.sh's `woodshed-session:generic`) and the session got no `PROJECT_REPO`, which the console sets for
  every session on a repo an admin added (`fleet.mjs`, `clonedAtStart`): a console older than its image does not. Its log otherwise starts `Cloning the
  project's repo (repo: <repo>, image: none)`, then `Project repo cloned` with its seconds; the installs run after
  claude starts (`/tmp/woodshed-deps`).
- **install.sh stops with `port 7690, which the console needs, is taken by …`.** Something else listens where the
  console would: often a console left running from another install or `WOODSHED_HOME`. The message names the process
  and its pid, from `lsof -nP -iTCP:<port> -sTCP:LISTEN` (`ss -ltnp` on Linux); `this machine will not say by what`
  means neither could see it, such as another user's process. The install's own console is never in the way: it is
  told by `WOODSHED_STATE_DIR` in its environment (or its `bin/woodshed` launcher), and stopped and started again.
  A Tailscale `serve` listener on the same port does not count.
- **Claude in a session says there is no Docker, or `docker` is not found or refused.** On the local provider every
  session runs its own Docker where the machine has Sysbox, and otherwise uses the machine's on one person's console;
  on a console others sign in to, the machine's only with `WOODSHED_SESSION_DOCKER=1`, and `0` turns both off
  (providers/local/README.md, "Docker in a session"). The console logs `local: sessions'
  Docker` at start (`off: true` when it is off), then at the first session `launcher: sessions get their own Docker` with `own: true`, or `own:
  false` with `why` (`no sysbox-runc runtime: install Sysbox`, or `the session image has no Docker daemon`: rebuild it)
  and what they get `instead`; a no is asked again ten minutes later. Each session logs `launcher: session given its
  own Docker` or `launcher: session given this machine's Docker`. With their own, the session's log says `Own Docker
  ready`, or `WARNING: own Docker did not start` with the end of `/tmp/woodshed-dockerd.log` (in the session), and
  `echo $WOODSHED_SESSION_DOCKER` says `own`. With the machine's, `launcher: sessions get this machine's Docker` gives the socket's
  `group`, a start that fails with `its socket could not be given to the session` gives docker's reason, and in the
  session's Terminal `echo $WOODSHED_SESSION_DOCKER $DOCKER_HOST` says `1 unix:///var/run/docker.sock`, `id` lists the
  socket's group, and `ls -l /var/run/docker.sock` shows the group that must match. `docker: command not found` is an
  image built before the CLI was in it: rebuild it (`WOODSHED_REBUILD=1`). A question from Slack and AWS sessions never
  get either.
- **A tool in a session cannot reach a container it started on `127.0.0.1:<port>`, or a dev server fails with
  `EADDRINUSE`.** `session/dockerPorts.mjs` forwards each port the machine's containers publish to the same port on the
  session's 127.0.0.1: `/tmp/woodshed-docker-ports.log` has `dockerPorts: port forwarded` with the container, `port
  not forwarded` with `why` (something in the session already listens on it, or it is one of the session's own), and
  `forward ended` when the container went. A dev server refused its port because a container on the machine (often
  another session's stack) publishes it and the forward holds it: stop that container or move one of them. Nothing
  forwarded on Linux for a port published on `127.0.0.1` alone: the forward reaches the machine through the gateway,
  so that port must be published on every address.
- **Containers from an ended session are still running.** Containers a session starts with the machine's Docker
  carry no label of Woodshed's and outlive it: `docker ps` lists them, and `docker rm -f` or `docker compose -p
  <project> down` removes them. Claude names a stack after its session id, so the id in a name says whose it was.
- **A session takes a minute and a half to start.** The image has lost its
  SOCI index, so Fargate pulls it in full: `describe-tasks` shows about 85
  seconds between `pullStartedAt` and `pullStoppedAt`, against under 10 with
  the index. `aws ecr describe-images --repository-name <prefix>-session`
  lists an `application/vnd.amazon.soci.index.v2+json` artifact pushed with
  each build; when it is missing, adding it (`session/addSociIndex.sh`) failed in the deploy workflow's session job.
- **A starting session's checklist stays on one step.** The console logs
  `fleet: machine ready` once the task has an address, `fleet: start step`
  with the step and its seconds for `pullStarted` (from ECS) and each step the
  session reports, and `fleet:
  session running` with the whole start's seconds. No `start step` lines at
  all means the session's image predates the steps (it shows "Pulling the
  session image" until claude opens on AWS, "Booting the container" on the
  local provider, whose steps are its `words` in `providers/local/index.mjs`) or its `/progress` calls do not reach
  port 7691. A step whose call was lost is marked done by the next one. A
  console restarted mid-start (an image build) has no task for the session:
  its next tick finds the task by the session id and logs `fleet: lost start
  found again`.
- **Every step of a starting session's checklist is done, and Connecting to the session keeps counting.** claude is
  open, but the console has not reached the session: it turns to running only once its launcher has answered with the
  session's address and statusd answers there. 30 s after claude opened the console logs `fleet: the agent is open but
  the console has not reached the session`, once for the start: `address: false` with `launching: true` is a launcher
  whose start call has not come back (no `fleet: machine ready` either), and `address: true` gives the statusd read's
  error in `message`. It stays there until the start timeout fails it.
- **A private session runs its agent in tmux though its owner picked Herdr, or its TUI tab is blank.** The pick is
  My settings' Agent terminal (`userSettings: terminal changed` in the console's log), handed to the person's private
  sessions in the `/settings` answer: the session's log says `Owner's settings fetched` with `terminal`, then `Herdr
  started` with hc's version, or `WARNING: Herdr did not start, the agent runs in tmux` with `hc`'s last line
  (`/tmp/woodshed-herdr.log` in the session has the rest), and `Claude started` gives the `terminal` it used. A
  session started before the pick keeps its terminal. In the session's Terminal, `hc ls` lists the `claude` terminal,
  `hc get claude --json` its `status` (the agent's own word, which statusd logs as `source: 'herdr'`) and `hc read
  claude` its screen; the TUI tab is ttyd running `hc attach claude`. A Chat message that Herdr refused logs `statusd:
  Herdr did not send the message` with `why` (`prompt-open`, a question, approval or menu on screen, with `kind`;
  `blocked`, hc's own refusal; `status_mismatch`, claude's record working, blocked or in error; `not-at-prompt`, its
  screen not at the prompt). Shared sessions, questions, reviews and QA runs use tmux whatever the pick.
- **`woodshed session new --herdr --parent` left the session's agent with no parent, or its agent sat unstarted for
  minutes.** The console logs `fleet: session created` (or `resuming a private session`) with `herdrParent`, and the
  session's log `Herdr started` with `made by: its parent`, then `Agent's terminal made by its parent` with the
  `parent`, or after 5 minutes `WARNING: no parent made the agent's terminal` (the command line never made it: it was
  stopped, or not in a Herdr terminal) and the session made its own. Meanwhile statusd logs `capture-pane failed`: the
  terminal is not there yet. The command line exits 1 saying the terminal was already there when the session did not
  wait (a running one, an image from before it, or a wait run out): hc cannot give a running terminal a parent.
  `hc get woodshed-<id>/claude --json` on the laptop shows `parent` and `die_with_parent`.
- **The app inside a session will not start or log in.** That is about the repo's own app, and its installation
  says what to check: `.woodshed/install/README.md` in the repo. The env files get the databases through the project
  file's env file overrides, from each engine's variables (`PGHOST`, `PGPASSWORD`, `MONGODB_URI`; docs/reference.md, "Databases"):
  quote a password there, since an app that reads them with a stricter parser than dotenv can take a `#` for a
  comment.
- **Sessions on one repo do not start, saying `<repo>'s project file asks for a Mongo database, and this console only
  runs Postgres`, or New session shows that repo's Needs setup card.** That repo's own project file names an engine
  the installation does not host: add it to `databases` in Terraform (or the local provider's `WOODSHED_LOCAL_DB_*` and
  session env), or take that database out of the project file. Each repo is checked on its own (`console/databaseGate.mjs`),
  so the others still start; Console settings' Repos card says Needs setup or Ready on each. The console reads each
  repo's default branch's file and logs `console: project databases not hosted` with the `project`, `needs` and
  `hosted`, then `fleet: session refused, its project is not ready` for each start it refused (`fleet: trigger
  refused, its project is not ready` for a label or comment, which gets the reason and its first fix on its issue).
  An embedding program's `projectReadiness` hook answers first: `console: project not ready` with `from: 'program'`
  and its reason, or `console: project readiness not read` when the hook threw (nothing is blocked then). A session
  started from a branch whose own file differs stops at start with `the project file's databases need mongo, which
  this installation does not host`. On a local install made with no repository, the fix is `Run WOODSHED_REPO=<repo>
  bash install.sh again on this machine`: that builds the repo's own image and starts its databases
  (providers/local/README.md, "Setting it up"). The console logs `console: databases` at start with the `engines` it makes and the ones
  sessions are `hosted` on; a session in an installation with none logs `No databases to fetch`. A db-admin run logs
  `Started` with its `databases`, and refuses a project database whose engine it has no flags for.
- **Every copy waits five minutes and fails with `there is no database template`, the log saying `Waiting for the
  template` with `waitingFor`.** That engine's template has no ready marker: Postgres's is the template's comment,
  Mongo's a collection, each written last by a `template` run. One built before the engines were separate (Mongo's
  marker stood for both) or a template run that failed midway leaves one without: run the `db_template_command`
  output once. `WARNING: the templates were built from different commits` means one engine's swap failed after
  another's; the next `template` run builds them again.
- **The console stops at start with `WOODSHED_DATABASES is not set`, `names no database for it to make` or
  `there is no WOODSHED_ECS_DB_ADMIN_TASK_DEFINITION`.** The base box's stack predates the setting, or was
  written by hand: `terraform apply`, which writes it from `databases`, and sets
  `WOODSHED_ECS_DB_ADMIN_TASK_DEFINITION` only when there is a database. A console image built before the apply
  stops here, so the apply goes first.
- **A shared session fails at start with `the session's databases were not
  ready` or `could not get the session's databases`.** The console logs
  `databases: task started` with `action: clone`, then `databases: task
  finished` with the db-admin task's result; the task's own log says why. `there
  is no database template` means it waited five minutes for one: run the
  `db_template_command` output, or look at the end of the deploy workflow's session job. A
  private session's log says `the console sent no database user` instead, and
  the console logs `sessionApi: the owner's databases are not ready`: My
  settings shows why, and **Try again** reruns the task.
- **A user can connect to a database it does not own.** `SELECT datname FROM pg_database WHERE has_database_privilege('public', datname, 'CONNECT')`
  as any user lists the open ones; `postgres` and `rdsadmin` stay open by design. Every db-admin run closes the rest and
  logs `Closed databases to other users` with `closed`, or `WARNING: some databases are still open to every user`
  with their names (an owner root is not a member of), or `WARNING: upkeep failed` with `engine: postgres` when the
  sweep failed. A `__test` made since the last run is open until the next one.
- **An ended session's databases are still there.** A stopped shared session
  keeps them while it is resumable (`kept` in `state.json`): until 3 days after
  its pull request merged or closed, 14 days after it stopped with its pull
  request still open, 7 days after it stopped with none (the Console settings
  page's numbers), or
  Delete now. Then the console logs `fleet: kept session cleaned up` with why,
  drops them on its tick (`databases: task started` with `action: remove`) and
  tries a failed drop again after 10 minutes: `databases: task finished` with
  `ok: false` says why. `fleet: a kept session's pull request closed` says when
  the 3 days started; `fleet: retention check failed` is GitHub not answering,
  tried again 15 minutes later. The password goes with them, so a leftover `sessions/<id>/database`
  secret means the drop has not worked yet. The Console settings page's
  **Sessions holding data** lists a drop that keeps failing under Stalled, with
  **Drop again** (`heldData: stalled data cleaned`, then `databases: drop asked
  from the console`). A saved Claude home whose delete failed logs
  `fleet: Claude home not deleted yet, tried again later` and is retried every
  10 minutes; one with no session at all shows there too, with **Delete**.
  `heldData: the Claude homes could not be listed` means the console's role
  lost `s3:ListBucket` on the homes bucket, and the page says so.
- **An ended session is still on the list, or one vanished.** A deleted shared session leaves the list the Console
  settings page's days after its delete, or at once with Remove in its ⋯ menu: the console logs `fleet: deleted
  session taken off the list` with `why`. One whose Claude home is still being deleted waits for it.
- **The Woodshed card on Console settings is missing, never counts, or Update fails.** No card means the console runs
  from no git clone (the AWS console image has none): the console logs `woodshedUpdate: not a git clone`. Otherwise it
  logs `woodshedUpdate: following` with the clone, `upstream` (null for a detached checkout: check out `main`) and
  remote, then `woodshedUpdate: checked` every hour, or `check failed` with git's error (a remote that wants a password
  fails rather than asks). No Update button means nothing restarts the console: `bin/woodshed` sets
  `WOODSHED_SUPERVISED=1`, and systemd `INVOCATION_ID`. A failed update logs `woodshedUpdate: update failed` with
  the `step` and `wentBack`: `starts` is the new code failing its start check (`the new code cannot start`, with its
  error line), `image` the build, whose whole output is `woodshed-update.log` in the state folder. Update refused with
  `Could not fetch` or `commits of its own` is the last check's fetch failing, or a clone with commits the branch
  lacks. A console that stays down after `updated, restarting` either has a supervisor that did not start it again, or
  new code that failed after its start check (its output says which): `git -C <clone> reset --keep <from>` goes back,
  then start it by hand.
- **A setting on the Console settings page did not take.** The console logs
  `settings: changed` with the key, the old and new value and who changed it,
  and `slack: channel changed` for the channel; a value out of range is
  refused with its range and nothing of that card is kept. The new value is
  read on the next tick, about 10 seconds later. With nothing saved a setting is
  its environment value (`WOODSHED_MAX_SESSIONS`, `_IDLE_HOURS`,
  `_LIFETIME_HOURS`) or the page's default.
- **A session waits in the queue with `AWS has no room for another session`.**
  The account's Fargate vCPU quota is used up: `aws service-quotas
  get-service-quota --service-code fargate --quota-code L-3032A538` shows it.
  The console logs `fleet: AWS has no room, session back in the queue` and
  tries again every minute. Stop a session, or ask AWS for more.
- **A My Woodshed session stays Waiting.** Its owner has as many sessions
  with a Fargate task as the Console settings limit allows: the console logs
  `fleet: private session waits in line, at the limit` with `running`,
  `limit` and how many were `ahead`, then `fleet: starting session` when a
  slot frees up. A Done or Needs you session still holds its task until the
  idle pause.
- **A session fails at start with `.woodshed/project.yaml: …`, or shows Set up app instead of Start app.** The project file
  (docs/reference.md, "The project file") does not parse: the error names the field (`is missing app`, `has envfiles, which is not a field`), or says
  `not read as YAML (line N: …)` for YAML that `woodshed/shared/yamlLite.mjs` does not read. A field that can be none
  may be left out; a misspelt one never is read as none. The same file broken on a branch makes `readyGate` refuse `gh pr create` with `Not opened:
  .woodshed/project.yaml: …`. statusd logs `statusd: project file not read, no app` and `statusd: app start skipped,
  the project has no app`; Set up app logs `fleet: app setup asked` with `sent`, and statusd `statusd: the project file has
  an app now` once claude wrote one, or `project file not read again, still no app` with the reason. The session log's `Project file read (from: …)` says whether it read the checkout's
  copy (`checkout`), the default branch's (`default branch`) or none. To see what it read, `cd` into the session's checkout and run
  `node /opt/woodshed/shared/project.mjs get app`.
- **A session's dependencies are missing or old, or `/tmp/woodshed-deps` says `failed` or `skipped`.** A Grok Build or OpenCode session runs none of the branch's installs by itself, since they could read its owner's sign-in: the file says `skipped: …` with each changed install's command and dir, the log `Dependencies not refreshed: this <Product> session runs none of the branch's installs by itself`, and the agent runs them. Otherwise, at start the session's log
  says `Dependency files changed since the image was built, reinstalling` with the dir for each install it ran again,
  then `Dependencies ready` or `ERROR: the install failed`. An install runs again when its `files` differ from the
  image's record of them, `/work/.woodshed-deps/<dir>/built-from` (each file's sha256): compare it with
  `sha256sum` of those files in the checkout. A file the install needs but its `files` do not name never reinstalls:
  add it to the project file. An image build that fails with `deps: <dir>'s files in the build context are not the
  cloned commit's` was given woodshed-deps/ from another commit than `BUILD_SHA`; `deps: the install in <dir> made no
  <output>` means the project file's `output` is not what the command makes.
- **A session's app has no table its branch's code expects.** The copy is of
  the template as the last session image built it; the branch's migrations run
  only when Claude runs the database's `migrate` command, which the project's setup notes
  (its `setup`) should ask for before the app.
- **A viewer answers `refused: open this from the console`.** The browser said
  another site sent the request, e.g. a link clicked in Slack. Open it from the
  console's tabs, or type the URL.
- **Open app shows "This session's app is not running", or Start app stays on Starting.**
  The frontend is not answering on the project file's `app.frontendPort` in the session. Its start log is
  `/tmp/woodshed-app.log` in the session's terminal; the project file's `app.logs`
  there say which server is down. The console logs `fleet: app start asked`, and
  statusd `statusd: app start finished` with the script's exit code. A page that
  loads but never comes to life means the app's dev server refused the name: it must allow `*.<domain>` (the
  installation's `.woodshed/install/README.md` says where).
- **Open app on a port (`https://<name>:7701/`, a console with `WOODSHED_APP_PORTS`) does not load, or says no app is on
  the port.** The console logs `appPorts: listening` at start (`appPorts: could not listen` with the port when
  something else holds it), `appPorts: port lent` when a session's app gets one, and `appPorts: no port free for the
  session's app` when all are held. `no session's app is on this port` is a port lent to nobody, or to a session that
  stopped: open the app from the console again. A page that never loads from another device means the proxy does not
  serve that port: `tailscale serve status` must list it (providers/local/README.md, "From your other devices, with
  Tailscale"). A console that will not start, saying `WOODSHED_APP_PORTS is for one person's console`, has sign-in
  required or a host past loopback beside it: app ports are for a console nobody signs in to.
- **Open app answers with a certificate error on a local install, or on AWS with no `domain`.** With no wildcard certificate, Caddy gets one per
  app name on demand, after asking the console (providers/local/README.md, "Session apps without a wildcard
  certificate"). No `tls: ask listening` at start means `WOODSHED_TLS_ASK_PORT` is not set. `tls: certificate
  asked` with `allowed: false, why: 'unknown'` for the app's name means it is not `<id>.<WOODSHED_APP_DOMAIN>` of a
  session on the list (refusals log at most once a minute, with `refused`), and `why: 'not loopback'` that something
  other than Caddy on this machine asked, or a proxy sits in front of the port. No `tls:` line at all means Caddy never
  asked: `curl -s -w '%{http_code}' 'http://127.0.0.1:<port>/tls-ask?domain=<name>'` from the machine, then Caddy's own
  log for `tls.on_demand` and the issuer's answer (a Let's Encrypt rate limit on `sslip.io` is shared with everyone).
- **Resume, or a `/woodshed` comment, did not pick a shared session up where it
  was.** The console logs `fleet: trigger routed` with `action: resume`, then
  `fleet: resuming a shared session` with `claudeSession` (false when statusd
  never saw a conversation) and `databases: a resumed session keeps its
  databases`. At its previous stop statusd logged `statusd: Claude home saved`
  or `Claude home not saved`; at start the session's log says `Claude home
  restored` or `No Claude home saved yet`. A session cleaned up is no longer
  resumable: the comment starts a new session on the branch instead.
- **A review asked for changes and the session did nothing.** The console logs
  `slack: pull request feedback for its session`, then `fleet: review feedback
  typed in` for a running session or `fleet: resuming a shared session` with
  `why: 'review feedback'` for a paused one. A My Woodshed session's pull request is watched (`slack: pull request
  watched for its session`): `fleet: review feedback typed in` has `owner: true`, the pass logs `slack: watched pull
  request passed its review and suites`, and a stopped one is never resumed (`fleet: review feedback dropped, the My
  Woodshed session is not running`, then `no longer waiting` with `its session ended`). Each verdict, and each commit's
  failed or skipped suite, is handed over once. A verdict on an older commit
  than the pull request's head is not. An APPROVE is handed over too, once per pull request
  (`slack: approved, holding the post for the session to read the notes`), and the Slack post waits 5 minutes
  after it when the session heard it (`heard: true`); a private or deleted session's is posted at once.
- **The Artifact tool fails with `Invalid bearer token` or a 401.** It calls
  `api.anthropic.com` itself, never the proxy, so it works only in a private
  session, whose claude holds its owner's token. The session's log says
  `claude runs on the owner's own Claude token, directly`; in its Terminal
  `echo $WOODSHED_CLAUDE_AUTH` says `own`. A private session that says `plan`
  instead got no token in the `/settings` answer: a console older than the
  session image. In a shared session or on the team key, the Artifact tool
  cannot work: write the page to a file.
- **`/remote-control` says `Remote Control requires a full-scope login token`.** The owner's setup-token is inference-only.
  In a private session type `/woodshed:remote-control` in claude, or use the session's ⋯ menu, Sign in for Remote Control,
  which types it (the console logs `fleet: Claude login started` with `where`, statusd `statusd: Claude login started in
  claude`, or `in the terminal` for an image from before the command, where it types `woodshed-login` at the Terminal
  tab). claude shows the link and takes the code in the chat; `woodshed-login code` then stops claude when its turn ends,
  reopens the conversation with `--resume` and the flags in `/tmp/woodshed-claude-flags`, and types `/remote-control`.
  `/tmp/woodshed-login.log` says each step (`signed in`, `claude reopened`, `/remote-control typed in`, or why it
  stopped); a refused code says `The code was not accepted` with claude's reason. `woodshed-login` alone does it by hand
  in the Terminal tab (it is `claude auth login --claudeai`), then restart claude. The login is that session's alone: Anthropic rotates the refresh token at each use, so a copy in a
  second container fails with `invalid_grant` (measured), and the entrypoint drops `claudeAiOauth` from every restored
  home (`dropClaudeLogin`; `Claude login from the restored home dropped` in the log). `session/bin/claude` runs without
  the token while the session holds a login; `claude auth logout` puts the token back. Shared sessions cannot: they hold
  no login.
- **claude in a session says `Please run /login`, or an Anthropic call fails
  with a 401, 403 or 502 from the console.** Every shared session reaches
  Anthropic through the console's proxy (console/README.md, "The Anthropic proxy"),
  and so does a private session started from an older image. The console
  logs `anthropicProxy:` with the reason: `refused, no active session has that
  token` (a stopped session, or a call made with something other than
  `SESSION_TOKEN`), `refused, the session runs on no Claude plan` (claude sent
  a bearer in a team-key session), `no Claude token saved for the plan`, `no
  team key saved`, `credential not read` (Secrets Manager) or `Anthropic not
  reached`. The session's log says `claude runs on the team key, through the
  console` or `claude runs on a Claude plan, through the console`, and in its
  Terminal `echo $WOODSHED_CLAUDE_AUTH` says `key` or `plan`; `command -v
  claude` must be `session/bin/claude`, which sets the proxy's variables for
  claude alone, so `echo $ANTHROPIC_BASE_URL` there is empty by design. A
  backend call reaching the console (`refused, no active session has that
  token`, from a process other than claude) means something gave it claude's
  variables: claude hides them from what it runs through `CLAUDE_ENV_FILE`.
  Each session's first call on each route logs `anthropicProxy: first call`
  with `via` (`teamKey` or `plan`), the `plan` and the `caller`: anything but
  `claude-cli` there (the backend's SDK says `Anthropic`) is something other
  than claude spending the team key or a plan.
- **A shared session ran on the team key though its starter's switch is on.**
  The console decides at each launch and logs `fleet: whose Claude the session
  runs on` with `plan`. `fleet: the starter's Claude token is not saved` or
  `could not be read` mean it fell back to the team key; the switch also has no
  effect for someone with no token saved (`userSettings: own token for shared
  sessions` logs each change). A console that makes no shared databases (no
  db-admin, or a project with no Postgres or Mongo) still decides it: the session
  asks `/settings` for the plan alone, and the console logs `sessionApi: settings
  handed out` with `database: null`. A session image from before that never asks,
  and stays on the team key. The session's own log says `Runs on the
  starter's Claude plan` when it does; `sessionApi: the starter's Claude token is
  gone` means it was removed between the launch and the session asking.
- **An assignee got no Slack message.** Messages go only to the assignee of a shared session, when it starts asking
  (`needs-you`) or its pull request gave up, and only to someone linked on People. A session's "Needs a human:" comment
  counts only when the console's own App wrote it: the console logs `console: GitHub App identity read` with the
  App's `slug` at start, then `webhooks: a session asked for a person`, or `a Needs a human comment not from the App,
  ignored` for anyone else's, or `kept for a retry, the App login not read` while GitHub does not answer. The console logs `pings: assignee told`
  with `why` and `sent`, or `pings: skipped, the assignee has no Slack link`, and `slack: direct message sent` or
  `slack: call refused` for `chat.postMessage` (`channel_not_found` is a member ID Slack does not know). A message that
  arrives but cannot be read in Slack means the app's App Home has the Messages Tab off.
- **A session's pull request never reached Slack.** It is posted only once it passed the gates in the repo's project
  file's `pullRequests` (docs/reference.md, "The project file"; the installation's own are described in its
  `.woodshed/install/README.md`): the `review`'s verdict is APPROVE and every job of each suite (named from its `jobs`)
  passed on its head commit. A last commit without a suite's `rerun` tag, or a draft, may skip it, as the workflow
  decides. A pull request that touches only paths the suite workflow's `on.pull_request` filters leave out never starts
  it; the console reads them from the workflow on the default branch and logs `slack: a suite does not run for these
  paths, not waiting for it` with the `suites`, or `slack: a suite's path filters not read, waiting for it` with the
  error when the workflow is missing or its `on:` section does not parse. With no `pullRequests`, the console logs
  `slack: no review or suite configured, waiting for the pull request to be out of draft with its checks passing`.
  `projectFile: read` says whether the file was found and has `pullRequests`; `projectFile: not readable`, then `slack:
  pull request check failed` with `the project file could not be read`, means every pull request waits until it can
  be read (tried again each minute). At start the console
  logs `console: Slack posts` with `available: false` when it has no channel,
  and `slack: channel changed` with who set it.
  Then `slack: pull request waiting for its review and suites`, `slack: pull request older than the session, not posted`, and in the
  end `slack: pull request no longer waiting` with why: `posted`, `closed`,
  `not approved and green in time` (7 days, on the Console settings page), or
  `Slack did not take it` after the refusal above. After
  `posted`, the session stops with `posted to Slack`. `slack: pull
  request check failed` is GitHub or Slack failing; it is checked again a minute
  later.
- **An approved, green pull request's brief has not gone out, or says `QA: not run`.** It waits for the `qa` check on
  the head commit: `slack: approved and green, waiting for the QA check` with the `check` and `waitMinutes`, then
  `slack: the QA check did not finish in time, the brief says it was not run` once the Console setting's wait ran out.
  No `qa.label` on the pull request means no wait (`not run (no <label> label)`), and no `qa` in the project file
  `not run (not configured)`. `slack: decision brief written on the pull request`
  gives the comment's id, whether it was `updated` in place, and what the brief said (`mergeRisk`, `qa`, `riskAreas`,
  `decisions`, `notGreen`, `canMerge`). The brief is a reply in the thread of the `PR title - PR link` post:
  `slack: decision brief replied in the thread` with `replied`, or `slack: decision brief not replied` with the error. The assignee's mention after it logs `slack: assignee mentioned in the thread` with `tagged`. `<check> not posted` with that `mergeRisk` check on the commit means it was not the
  review's: another app, an older commit, or a run that is not `review.workflow` on this commit (`slack: a merge risk check not
  from the review's workflow, ignored` with the run's `path` and `sameCommit`).
- **A question in Slack gets no 👀 and no answer.** First, the Slack card on Console settings: its Questions row says
  when the bot was last mentioned and whether a signing secret is saved. With its switch off, the Webhook events page
  lists each mention as `Ignored: Slack questions are switched off on Console settings`.
  Otherwise, the Lambda's log has
  `webhooks: Slack mention queued` for each mention it took, or `Slack event
  ignored` with the event type (a bot, an edit, another workspace). Nothing at
  all means Slack is not sending: the app's Event Subscriptions must be on, with
  the `slack_events_url` output and the `app_mention` bot event, and the bot
  must be in the channel. The console then logs `webhooks: Slack mention
  received`, `asks: new question` or `asks: follow-up typed in`, and the Webhook
  events tab shows each as `mention`. `asks: mention refused` with a reason
  means the asker is not a full member of the workspace (a guest, a bot, another
  organization), or Slack would not say who they are: `slack: call refused` for
  `users.info` then says why, `missing_scope` meaning the token lacks
  `users:read`. `Slack questions are off`
  there means a console with no Secrets Manager or session API (a dev box): it
  logs `console: Slack questions` with `available: false` at start.
- **People, Secrets & webhooks, Webhook events or Console settings say `only an admin can do this`.** The
  person's Admin switch on People is off: the console logs `console: admin call refused` with the path, and
  `members: admin changed` with who turned a switch. Their avatar menu has no Console group. With no admin left,
  console/README.md, "Sign-in", has the way back.
- **The People page says "Not linked" for someone who has a Slack account.**
  The console logs `slackPeople: no Slack user for the email` at their
  sign-in, and before it `slack: call refused` for `users.lookupByEmail`:
  `missing_scope` means the bot lacks `users:read.email` (console/README.md, "Who is who
  on Slack"), `users_not_found` that their GitHub emails are not their Slack
  one. Link them by hand on the People page. Matching runs at most once a day
  for each person, at sign-in.
- **A question's session failed at "Getting its databases", or made a
  `woodshed/task-…` branch.** Its log has no `mode: ask`: the container never
  got `SESSION_MODE=ask` and ran a coding session's start. A variable the fleet
  sets is missing from `PER_SESSION_ENV` (see Rules).
- **The QA label on a pull request started no QA session.** Only a project whose file says
  `pullRequests.qa.runner: woodshed` starts one, and a label that is not its QA label is dropped with no log line.
  `fleet: QA not started` gives the `reason` (no write access, QA already running, not open) and `why` (`label` or
  `review`). `fleet: QA waiting for the review` means the review has not approved the head: the review's approval
  starts it, and `webhooks: QA after a review failed` says why one did not. A started one logs `fleet: QA session
  started` with its `base` and `why`.
- **A QA comment stays at Running.** The session's terminal shows the run (`[qa …]` lines). `fleet: QA finished`
  with the `conclusion` means the report arrived; without it, `sessionApi: a QA report refused` gives `why`, and
  the terminal's last line `Report sent to the console (status: …)` the reply. A session that stopped first (idle or
  lifetime) never sent one: label the pull request again. An approval its review held for it goes out on the next tick,
  saying QA did not finish: the console logs `fleet: held approval released, QA stopped without a report` with the
  `reason`, then `fleet: held approval released` with the verdict.
- **A QA comment has no recording, or its link or still is broken.** The session's terminal says `Video sent to the
  console (… KB, status: …)` for each page, or `Video not sent` with why (over 25 MB, past 5), then `Still sent to the
  console (status: …)` or `No still sent` with why; no video line at all means the browser wrote none (`ls .qa/video` in
  the checkout, and `qaBrowser: the browser did not close` or `The browser did not close in` in the run's output means
  it was cut short). A `409` is a second recording sent while one was on its way, or one after the report. The console
  logs `fleet: QA video saved` and `fleet: QA poster saved`, or `sessionApi: a QA video not saved` with the store's
  error. A comment with no recording line though the videos were saved means the console has no public address for it
  (`fleet: comment names no console address`): a public repo's project file says `consoleLinks: false`, which leaves
  the recordings out too unless it also says `pullRequests.qa.recordings: public`. A public video's link that says it is
  no longer kept, though its run is within 14 days, names another secret than its run's, or a run started before the
  project file said `public`. Recordings are kept 14 days (`qaRecordings: old recordings deleted`):
  after that the link says so and the still shows as broken. On AWS they are in the homes bucket under `_qa/`
  (`aws s3 ls s3://<prefix>-homes-<account id>/_qa/`), on a local install in the state folder's `qa-recordings/`.
- **A QA session finished but its pull request has no QA check.** `fleet: QA finished` says `checkPosted: false`, and
  `fleet: QA check failed` gives GitHub's reply: a 403 means the installation has not accepted the App's Checks: write.
  `fleet: QA check skipped, not the pull request's commit` means the report named a commit that was neither the one the
  session started on nor the pull request's head: the pull request's code can send the report, so it gets no check.
- **A question in Slack asked for an issue and none was opened.** The ask session's `issue.sh` prints the console's reason, and the
  console logs `asks: issue opened` with the session, `repo`, `number` and `asker`, or `asks: issue refused` with `why`: the person
  who last mentioned the bot is not linked to GitHub on People (`slackAccounts`), has no write access to the repo, the repo is
  not one of Console settings' Repos, or GitHub refused the App
  (`Issues: write` not accepted on that installation). The session's own token never writes: only the console's App files it
  (`POST /issues`, `console/asks.mjs` `openIssue`), and the console posts the issue's link in the thread (`asks: issue link not posted` when Slack refused). Never for a tainted session, and asks are never tainted.
- **A question ignores the thread it was asked in.** The console logs `asks: thread read` with the `messages` and `chars` given, or `asks: thread not read` with Slack's error: `missing_scope` means the app lacks `channels:history` (reinstall it); a private channel gets `missing_scope` on purpose, since the app has no `groups:history`. Guests and other organizations' messages are left out on purpose.
- **A question got 👀 and no answer.** Open the session from the link in the
  thread. The session's log says `mode: ask`; the console logs `asks: answer
  posted` with `posted: false` when Slack refused the reply (`slack: call
  refused` says why), and `asks: question left unanswered` when it stopped or
  failed first, which the thread is told. `sessionApi: no read-only token for the
  session` means the console has no GitHub App.
- **The Review tab says GitHub has no branch yet, or did not answer.** The
  first is the session not having pushed: it pushes when it commits and when it
  stops. The second logs `console: review not readable` with gh's error; a 401
  or 403 there is the console's App token.
- **Stop app leaves the app up, or the app says `API down` or `frontend down`.**
  The project file's `app.stop` stops what the project's own script knows of, often only
  the servers it started: servers Claude ran some other way (`npm run dev` by hand) keep
  answering, and statusd logs `statusd: app stop finished` with
  `frontendStillUp` or `backendStillUp`. Stop them from the terminal. A half-up
  app is a server that crashed: its logs are the project file's `app.logs` in the session, and the app's own
  status command says which port is free.
- **A session sits at Needs you on "Read outside the working directories" (Allow this read …?).** Auto mode asks once,
  at claude's first file read outside the repo and `/tmp/uploads`. Woodshed's own files there (the environment notes,
  `/tmp/woodshed-deps`, the docker ports' log, an ask's answer) are `Read` rules in `session/claudeHooks.json`
  (session/README.md, "Why permissions are off"), so a session asking about one of them is an image from before the
  rules, or a path Woodshed names that has none: add it there, where `entrypoint.test.mjs` checks them. Any other path
  is the project's own, such as an app log under `~/.cache` its notes point at: answer it, or have the notes keep it in
  the repo. Its option 2, "No, and block", writes `permissions.blockReadsOutsideWorkingDirectories` to the owner's
  `~/.claude/settings.json`, which `settingsSync.mjs` carries to every private session of theirs: those refuse such
  reads from then on, until it is taken out of that file.
- **A session says Waiting for input while Claude is working, or the reverse.**
  statusd logs `statusd: claude state changed` with `source`: `hook` is
  Claude's own hooks, `interrupt` an Esc read from the transcript, `silent` a
  prompt or a tool result with nothing after it for 5 minutes, and `pane` means no hook has
  fired. `cat /tmp/woodshed-claude-state.json` in the session shows the last
  hook. A `Stop` with a background agent still running reads as working; a
  background shell does not. Stuck on `pane` means claude was started without `--settings
  …/claudeHooks.json` (an older image), or the hook fails: run
  `echo '{"hook_event_name":"Stop"}' | node /opt/woodshed/session/hookState.mjs`.
- **A pasted or dropped file is not typed into the terminal, or a picture does
  not open.** The toast says the console's answer. statusd logs `statusd: file
  uploaded` with the pane (`typed: null` for an agent in Herdr, whose path the
  page types itself, as a paste); the console logs `console: statusd unreachable` when
  the session did not answer. A picture answers 404 for a path outside the
  repo, `/tmp/uploads` and the scratchpad, or one that is not png, jpg, gif or
  webp after its symlinks. A session started from an image before
  `terminalFiles.mjs` answers 404 for all three routes: start a new one.
- **Scrolling back in a terminal shows part of claude's answer twice, or the wheel does not scroll.** claude runs
  inline (`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` in `session/bin/claude`), and Claude Code's inline renderer prints
  its last answer again when the terminal gets narrower (anthropics/claude-code#84247): a phone and a desktop on one
  session, a rail opened or a window made smaller. It is in tmux's history and the browser's both; nothing here can
  take it out. For the wheel: in the terminal frame's console, `document.title` starts with the pane's state from
  `tmux.conf` (`claude (main screen)`): `main screen` scrolls in the browser, anything else through tmux. A person's
  own tmux lines that set `set-titles-string`, `status-position top` or `terminal-overrides` leave it to tmux, or leave
  the browser's scrollback empty. A `tmux display -p -t claude '#{alternate_on}'` of 1 means claude or codex is full
  screen after all, as an image from before inline mode runs it.
- **The phone's message box says Not sent, or claude never got it.** The
  console logs `console: message typed in from the page` with the length, and
  statusd `statusd: text sent to claude`; a file from **📎** logs `statusd:
  file uploaded` with `typed: null`. The mic is hidden where the browser has no
  speech recognition, and says why in a toast when the site may not use the
  microphone. A terminal whose connection dropped logs `[terminal] websocket
  closed` with the code in its frame's console, and reconnects by itself.
- **+ Another agent fails, or the agent switch is missing.** The switch shows only to the owner of a running My
  Woodshed session whose statusd reports `agents`. Older images omit it where extra agents are unavailable. A Claude
  agent beside Grok Build or OpenCode needs the owner's saved Claude token. From the
  command line it is `woodshed session agents|agent <id>`, which the console logs as `cliSessions: call` with the path,
  then the same lines below; `session connect <id> --agent agent-N` refused with 400 is a console from before it. A start
  logs `console: another agent asked for`, then in the session `agents: agent started` with its id, agent, model and
  mode, or the dialog says why: 409 `at most 3 agents`, `seen production data`, `started before it could start another
  claude` (no `/tmp/woodshed-agent-claude-flags`: an image from before) or `codex is not set up` (no
  `/tmp/woodshed-codex-ready`: configureCodex failed, `WARNING: codex not set up` in the session's log). A Codex agent
  beside claude logs `statusd: Codex agent beside claude set up` with `own` (the console sent the owner's sign-in with
  the start: `console: another agent asked for` with `ownCodex`); the console refuses the team key with `openaiProxy:
  refused, not a Codex session` until the agent started (`fleet: another agent allowed in the session`), and again from
  the moment the session's lockdown starts (`fleet: other agents' access dropped at the lockdown`). Its state changes log `agents: agent state changed`; in
  the session, `tmux ls` lists `agent-2` and the rest (`hc ls` where the session runs in Herdr: `agents: agent started`
  says which `terminal`), `cat /tmp/woodshed-agent-2-state.json` its last hook, and its TUI is `tmux attach -t =agent-2`
  (`hc attach agent-2`). A Chat that shows another agent's conversation means its record was not told apart:
  claude's by its `--session-id` or the transcript its hooks name, codex's by the rollout its process holds open
  (`ls -l /proc/<codex pid>/fd`).
- **Grok Build or OpenCode was picked to review a pull request and did not, or its review says it wrote no verdict.**
  The console logs `fleet: review runs other than the author chose` with `why`: `Grok Build left out: …` or `OpenCode
  left out: …` names what was missing (the switch for reviews off on that card, no sign-in saved, a Grok login whose
  `expires_at` passed, OpenCode sign-ins with no Anthropic or OpenAI API key: a login is never used). That line is for a
  saved choice that named the agent. With no choice saved, a sign-in that cannot run is simply not in the default: the
  Reviews card says why, and there is no such line. A Grok Build or OpenCode sign-in already saved when the default grew
  to every reviewer, or found in the secret store afterwards without a save on My settings (saving a different one of
  those sign-ins first does not cover an uncached one), stays out of it until that
  person sets reviews back to the default (`userSettings: previous review default kept` at the console's first start
  after, or `sign-ins follow the secret store` with `reviewDefault: legacy` when refresh finds one, then `reviews of my
  pull requests` with `accepted: true`). There is no team key
  to fall back on. One that started logs `reviewAgentProxy: first call on the author's <Product> sign-in` with `via` at its
  first model call, or `reviewAgentProxy: refused` with why (the session's pane says it too, `Grok Build: @<login>…`), and
  `upstream not reached` when xAI, Anthropic or OpenAI did not answer. `reviewAgentProxy: refused, a body a review's
  agent does not send` with `field` (and `why`: `not JSON`, `compressed`, `too large`, `a field not allowed`) is the
  proxy's body scope (console/README.md, the review agents): only the fields each agent was measured to send pass, never
  one that names what the author's account holds (`previous_response_id`, a `file_id`, a vector store, a container). The
  same field in every review after an agent update is one the new version sends: run `reviewInImage.mjs` on the new
  image (with `IN_IMAGE_GROK_VIA=login` for a Grok login), read the fields it prints, and list the new one in
  `console/reviewAgentScope.mjs` if it names nothing. So is one that comes only with one kind of sign-in: a `grok
  login`'s model list says `api_backend: responses`, so grok makes its turns on `/v1/responses` (the review's `first
  call` line says `via: 'login'`; the refusal has no `via`). There, `field: 'tools[].type'` is its `x_search` tool, from
  a session image before `review.sh` ran it with `--disallowed-tools x_search`. `field: 'input[].id'` is an id on a
  reasoning item from a console before it took those off (reviewAgentScope.mjs, `withoutReasoningIds`), or, on a console
  that does, an id on another item (a `function_call` or a message), which grok 1.0.92 was measured not to send: measure
  the new version before passing it. In the session, `.review/logs/grok.jsonl` or `opencode.jsonl` is the agent's own
  output, and `REVIEW_OPENCODE_PROVIDER` the provider OpenCode was pointed at.
- **Chat's Send says `Not sent: this session started before Chat could send safely`.** Its statusd predates the
  guarded send (its `/status` has no `safeSend`), and would type blind, Enter and all, into whatever is on screen: the
  console logs `console: message from the page refused, the session cannot send safely`. Type in the TUI tab, or start
  a new session. Messages the console sends itself (Slack follow-ups, review feedback) still go to such a session, one
  right after each status read that says it is idle.
- **A stopped session has no Chat tab, or its Chat is older than where the session stopped.** Chat shows a stopped
  session's conversation only when the session kept one (console/README.md, "A stopped session's conversation"): its
  record has `conversationSavedAt`. At its stop statusd logged `statusd: conversation kept` with `why` and the entries,
  or `conversation not kept` with the console's answer (`not kept by the console, none sent again` after a 404 or 409); the console logged `sessionApi: conversation kept`, or `conversation
  refused, the session has seen production data`. None is kept for a question from Slack, a QA run, a review, a tainted
  session, an image from before it, or a console with no home store (`this console keeps no Claude homes`). A task that
  ended without its checkpoint (a crash) shows the periodic copy, up to 5 minutes older. `console: saved conversation
  not read` with the store's error is the 502 the page shows; a 404 is a copy gone from the store, such as after Forget
  my Claude home.
- **Chat's Needs you line offers only the TUI tab, for a prompt it should read.** statusd's `GET /prompt` answered 503
  `pane-unread`: statusd logs `statusd: prompt not read, the pane could not be read` with tmux's error. A send refused as
  busy (`why: 'typing'`) right after a session's lockdown is the reopen of claude holding the pane until the new claude
  works (`session/paneLock.mjs`); the console holds the message and sends it then, and statusd logs `the reopened claude
  was not seen working, the pane let go of anyway` when that took over 30 s.
- **The Chat tab's Send answers, Approve or Deny says `Not answered: …`.** statusd types an answer only once the agent's
  pane shows that same prompt (`session/panePrompt.mjs`): the console logs `console: answer typed in from the page`
  with the picks' numbers or the decision, and statusd `statusd: answer typed` with the arrow keys it took, or `statusd:
  answer refused` with `why` (`no-picker`: answered or cancelled already; `other-question`: the picker was moved on in
  the TUI tab; `other-options`, `other-approval`: the screen changed; `not-moved`: the highlight did not follow) and
  `typed`, how many questions it had answered before it stopped. `TMUX= tmux capture-pane -p -t claude` in the session
  shows what it read. A Claude Code or codex that draws its picker otherwise reads as `no-picker` for every answer:
  capture its pane into `shared/__fixtures__/` and fix the reader.
- **Files attached to New session are missing in the session.** The console
  logs `attachments: staged`, `claimed` and `handed out`; the session's log says
  `Attachments fetched` or `WARNING: attachments not fetched` with the status.
  They are under the console's state folder, `attachments/sessions/<id>/`,
  until the session's Remove, and staged ones under `attachments/staged/<login>/`
  for a day.
- **A session's card has no pull request chip, or an old one.** The console
  logs `prChips: read` with how many it asked for and found whenever some are due, or
  `console: pull request chips failed` with gh's error. A chip only shows
  once statusd has reported the session's PR URL.
- **A pull request's chip shows ✓ while Woodshed's review or QA is still running, or says `review` or `QA` with none
  running.** The word and its ring come from the console's own sessions, not GitHub: a review or QA session on that
  repo and number that is queued, starting, running or stopping (Reviews and QA on the rail's Everyone). A review the
  repo runs as a GitHub workflow instead shows as a check that is still running.
- **A session opened several pull requests and its card shows one.** A merged or closed one is hidden once a newer
  one came after it (Details lists every one). Otherwise statusd did not report it: it reports the pull request of
  the branch checked out and those of the checkout's other local branches (`prUrls`), from the session's own repo
  alone. In the session, `curl -s -H "Authorization: Bearer $SESSION_TOKEN" localhost:7682/status` shows `prUrls`;
  none there is an image from before it, which reports only the branch checked out. `statusd: pull requests of the
  other branches not read` gives gh's error. One opened from a second clone, or on another repo, is found only when
  claude opened it with `gh pr create` (claude's PostToolUse hook records it in `/tmp/woodshed-opened-pulls.json`,
  `session/openedPulls.mjs`; codex has no hooks), and the console keeps it only for a private session, on a project its owner may start sessions on: its
  chip names that repo (`woodshed-cloud #151`).
- **A pull request's chip or Slack post lags by minutes after a change.**
  With pull request webhooks arriving, a change is read within seconds: the
  console logs `pullWebhooks: pull request marked due` with the numbers, what
  changed and `by` (the chip, the Slack post or retention). Between them it
  reads each pull request only every 5 minutes. `pullWebhooks: pull request
  polling changed` with `webhooks: false` means none came for half an hour, and
  it is back to every minute. If that keeps happening, the App is not
  subscribed to **Pull request review** and **Workflow run**: the webhook card
  on the Secrets & webhooks tab lists what is missing.
- **The CPU and memory are missing from the pane bar's meter.** statusd reads the container's cgroup
  (`session/usage.mjs`); a session from an image before it reports no `usage`.
  CPU shows `—` until two status reads 2 s apart. On a narrow bar the meter shows only while something runs high.
- **A private session's Plan reading is missing or old.** It shows, in the pane bar's meter, once Claude has answered: in the session's
  Terminal, `cat ~/.claude/woodshed-usage/claude.json` is what the status line saved. No file means Claude Code sent no
  `rate_limits` (a session not on a Pro, Max or Ultra plan, or none answered yet), or the status line is not
  `session/statusline.sh`. A Grok Build session reads `~/.grok/logs/unified.jsonl` (`billing: fetched credits config`, `session/grokPlanUsage.mjs`) instead, and an image from before that reader has none. statusd logs `statusd: plan usage not read` with the error once per reason. The meter shows
  the newest reading of all your private sessions, its age past 30 minutes in its tooltip, and none from an image before
  `session/planUsage.mjs`.
- **The Review tab is blank, or says `no review for this session`.** The tab frames
  the shed's page (`/review?session=claude-<id>`, README.md, "Review"). Its calls
  are `/reviews/claude-<id>/...` through `console/reviewProxy.mjs`; the console
  logs `console: statusd unreachable for a review call` or `review request
  refused, cross-origin`, and statusd `review: worktree review ensured` (with
  `created`) and `review: gh account checked` (`person` false means gh is the
  App, so the session is read-only). `nothing to review` is a checkout equal to
  the default branch. A write refused with `cannot write to GitHub as you` is a shared
  session, or an owner who has not connected GitHub: `review: GitHub write
  refused`. The shed's own log lines (`review.worktree_prepared`, an analysis
  started or failed, `claude was stopped` after its 10 minutes, 3 for an answer)
  are in statusd's log, and the page shows claude's reason. It runs on the
  session's own Claude: a private session whose owner's plan is out of usage
  fails there too. A comment, verdict, rename or merge that fails shows
  `gh`'s reason in the page: they go with the session's token, so `Connect
  GitHub` on My settings must have been done before the session started. A
  session from an image before `session/reviewShed/` 404s for the page. Its state
  is under `/tmp/woodshed-reviews`.
- **The Diff tab says it could not read the diff, or misses a change.** statusd logs `statusd: diff read` with the
  file count, `aheadBy`, `uncommitted`, `bytes`, `tooLarge` (files shown with counts only) and `baseFetched`, or `statusd: diff not read` with the
  reason; the console logs `console: statusd unreachable` with `path: '/diff'`. `baseFetched: false` means the default branch
  could not be fetched, so the diff is against the copy of it the checkout already had. A file `.gitignore` names never
  shows. A session from an image before `session/sessionDiff.mjs` answers 404.
- **The App log tab is empty.** statusd's `GET /applog` reads
  `/tmp/woodshed-app.log` and the project file's `app.logs` in the session; the tab says `Nothing logged yet` until Start app ran.
- **New session does not offer Grok Build or OpenCode, or a session of one fails at start.** Each is offered
  only to someone whose own sign-in for it is saved on My settings (`/api/my`'s `agents`), and only for a My Woodshed
  session: a shared session, a question, QA or a review never runs one (`fleet: session refused, its agent needs an
  owner's own sign-in`). The console logs `userSettings: <Product> sign-in saved` or `removed`; at start
  `sessionApi: <Product> sign-in handed out`, or `no <Product> sign-in for the owner` with a 409, and the session's log
  says `could not get the owner's settings`. None of them gets the console's MCP servers (`mcpRelay: refused` with `a
  <Product> session gets no MCP servers`), and Grok Build runs no MCP server at all, a repo's own included: the image's
  `/etc/grok/requirements.toml` locks them down (`grok inspect` in the session lists each as `BLOCKED`), and runs only the
  session's own hooks from it. A Grok session that fails at start with `the repo's <file> points outside the checkout` is a
  branch whose rules file (`AGENTS.md`, `CLAUDE.md`, a rules folder) is a symlink out of the repo, which Grok would read into
  its first request: make it a file, or a link inside the repo.
- **New session's Codex models are old, or say `codex's built-in list`.** The line under the menus says why. The console
  logs `codexModels: catalog read` with `source` (`own` or `team`) and how many `models`, `OpenAI refused the catalog`
  with the `status` (a 401 is a sign-in OpenAI no longer takes), `catalog not read`, `own sign-in expired, not read`
  (a Codex session refreshes it at its stop) or `credential not read`. It tries again a minute after a failure.
- **New session's Grok Build Model is a box to type in, not a menu.** The console has no list of the person's models:
  the line under the menus says why. It logs `grokModels: catalog read` with `source` (`login` or `key`) and how many
  `models`, `xAI refused the catalog` with the `status` (a 401 is a sign-in xAI no longer takes), `catalog not read`
  (with `timed out`, `the answer is not JSON` or `the catalog is too large`), `the catalog listed no models` (a key with
  only image or video models), `own login expired, not read` (a Grok session refreshes it at its stop) or `credential
  not read`. It tries again a minute after a failure, and at once after the sign-in is saved again.
- **The Analytics page leaves a repo out, or counts no merge risk.** The page names the repo GitHub did not answer for,
  and the console logs `analytics: pull requests not read` with the project and GitHub's error; it reads each repo again
  after 5 minutes; its `message` is gh's own error (`gh: HTTP 502`). A pull request's merge risk is the review's `merge
  risk: <tier>` label, else its `mergeRisk` check's tier (asked apart, for the newest 100 with no label: `analytics:
  merge risk checks not read, the labels only` when that failed), else the tier its review session reported: one no
  review has seen says `not reviewed` (console/README.md, "Analytics"). A person with no sessions though they used Woodshed started them before their sessions were kept in
  `usageKept`, which only sessions leaving the list since then are.
- **The `/` list in New session is empty.** The console logs `console: skills
  read` with the count, or `console: skills not readable` with gh's error.
- **A pin or rename does not stick.** The page says `Not saved` with the
  console's answer. Pins are per person under `viewPrefs` in
  `state.json`, and a rename logs `fleet: session renamed`. A pin on a session
  you can no longer see is left out of what the page gets.
- **The Terminal tab is greyed out, or says `no terminal for that session`.**
  The session started from an image without the shell's ttyd (the console then
  has no `shellPort` for it), or the session is not running. Inside a session,
  `/tmp/ttyd-shell.log` is its log. A connection that hangs means the sessions'
  security group lacks the `shell` rule for 7684 (an apply is due).
- **A TUI or Terminal tab stays blank, or keeps saying `Reconnecting…` or `Press ⏎ to reconnect`.** Both tabs are the
  console's terminal page (console/README.md, "The terminal page"), and the session's ttyd only the connection. The
  frame's console logs `[terminal] websocket closed` with the code each time it drops. The console logs `terminal:
  first message refused` with why when what the browser sent first was no terminal's size, and `terminal: websocket
  dropped` when the session's side went. In the session, `/tmp/ttyd.log` (`/tmp/ttyd-shell.log` for the Terminal tab)
  says when each websocket opened and closed.
- **Open ▾ has no Redis, or Redis answers `not found` or `the Redis viewer is not running`.**
  No Redis means the project file's env never mentions `REDIS_URL`, so the session started none: its log says
  `Redis not started`, and statusd reports `redis: false`. `not found` means the session started from an image without
  redis-commander; `the Redis viewer is not running` that it died: `/tmp/redis-commander.log` in the session's terminal.
  Its Postgres and Mongo are the same, with `/tmp/pgweb.log` and
  `/tmp/mongo-express.log`; a session started from an image before every session
  had its own databases runs them only when private. Open ▾ offers the ones statusd reports (`viewers`, the engines
  whose viewers the entrypoint started: its log says `Database viewers started`, with `db: from the environment` for
  databases the console did not make). No Postgres or Mongo there on a session whose environment names its databases
  means an image from before its entrypoint started their viewers: start a new session on a rebuilt image.
- **Editor ↗ is missing.** It shows only while the session's statusd reports `editor: true`: the checkout's project file
  says `editor: true` and the image has openvscode-server. The deploy workflow's session job logs `stageDeps:
  editor true` or `false` from the built commit's project file, and the build logs `editor left out` for `false`; statusd answers `the project file turns the editor
  off` (and logs `statusd: editor refused, the project file turns it off`) when the checkout's says `false`.
- **Editor ↗ answers `not found` or `the editor is not running`, or VS Code says it cannot reconnect.** It is at
  `https://<id>.<app domain>/__woodshed/code/`, and signs in the way the app does (see the app's symptoms above).
  `no editor for that session` means the viewer cannot open the session itself (an app shared with them opens the
  app, not the editor; the console logs `editor: refused, the viewer cannot open the session or it is not running`),
  or it is not running. A JSON `not found` from statusd means a session from an image before the editor. statusd
  starts the editor on the first request and logs `statusd: editor starting`, then `editor started` with its seconds,
  `editor did not come up`, or `no editor in this image`; `/tmp/openvscode-server.log` in the session's terminal is
  the editor's own log. A workbench that loads but cannot connect means its websocket was refused: the console logs
  `editor: websocket from another origin refused`, `editor: websocket refused, not signed in`, or `editor: websocket
  dropped` when statusd or the editor closed it.
- **`woodshed-db.mjs` stops, or a tool's connection drops.** The script prints
  the console's reason (`pg refused (401)`: the token expired or was replaced;
  make a new one). The console logs `tunnel: opened`, `tunnel: closed` with
  seconds and bytes, `tunnel: refused, no valid token`, `tunnel: closing open
  tunnels` with why, and `tunnel: database unreachable` when it cannot reach
  RDS or Mongo. psql saying `server does not support SSL` means it reached
  something other than RDS: check `WOODSHED_TUNNEL_POSTGRES` in
  `compose.yml`.
- **Restore a dump fails, or is missing from My settings.** It shows only with own databases ready and a tunnel
  address: the console logs `dbRestore: ready` with `kinds` (`postgres`, `mongo`) at start. Then `dbRestore: dump
  refused` with `detail` (`plain SQL`, `not a dump`, `made by pg_dump 17 or newer`, `unreadable`, or `no address`),
  `upload not finished` (`cut off`: the browser stopped sending, or Cancel), `restore started`, then `restored into the
  copy` or `restore failed` with the `step` (`copy`, `restore`, `count`). The tools' own error is on the page only,
  never in the log, since it can quote a row. A Mongo restore failing with `not authorized on woodshed_<login>__restore`
  means the user has no restore roles yet: the db-admin task's log says `Restore roles checked` with `granted` on each
  run, and the next run gives them. `dbRestore: apply failed` with `step` says where Apply stopped; `aside` is a
  session's app that kept connecting through three tries, and the database is as it was. A failed rename back, a
  console restarted during Apply, or a Mongo Apply cut short can leave the person's data in `woodshed_<login>__previous`:
  the next Apply puts it back first (`dbRestore: the database was found under its old name`, or the Mongo backup step
  copying it back, which it does only when `__previous` holds `_woodshed_backup_complete`). Do not Reset my data then:
  it drops `__previous` with the rest.
  **Open in the database viewer** says `start a new session` when the running session's pgweb is locked (an image
  from before its bookmarks), and the viewer's `database does not exist` on `restored-copy` means no copy is ready.
  In the session, `ls /tmp/woodshed-pgweb-bookmarks` shows the bookmarks and `/tmp/pgweb.log` pgweb's start.
  A restore that fails with `it was stopped for using more memory than the console has` was killed by the kernel:
  `sudo dmesg | grep -i oom` on the base box shows it. The console's container has 512 MB (`mem_limit` in
  `providers/aws/terraform/baseBoxStack.sh.tftpl`), and mongorestore is held to about 150 MB for ordinary documents; very large
  documents (several MB each) can still pass it.
  For a Mongo copy it opens `/mongo-copy/<id>/`: a 404 is a session from before that viewer, and in the session
  `/tmp/mongo-express-copy.log` is its log. The Ready card's `The default branch has N migrations` comes from GitHub; with no
  line about it, the console logged `dbRestore: the default branch's migrations not read` with GitHub's answer.
- **S3 files are gone.** Expected: localstack's free edition keeps nothing
  across restarts, and `<prefix>-up` restarts it.
- **Mongo or the session list is empty after a box change.** The data volume
  did not mount. `findmnt /var/lib/<prefix>`, then the first boot's log
  in `/var/log/cloud-init-output.log`.
- **A change to `baseBoxStack.sh.tftpl` did not reach the box.** The
  `<prefix>-configure-base-box` association runs it after the apply, on
  its own: `aws ssm describe-association-executions` (providers/aws/README.md has the full
  command) shows the last run, and `aws ssm list-command-invocations --details
  --instance-id <base_box_instance_id>` its output. A new box's first run waits
  up to 15 minutes for Docker and the data volume.

## Testing env changes without AWS or Claude

Run the session image locally with `--entrypoint bash`. Source the entrypoint
without its final `case`, call `writeEnvFiles`, `startRedisIfUsed`, then run the
project file's `app.start` against your own databases
(`PGHOST=host.docker.internal`, and the like). Mount the worktree's start
script over the image's copy: a real session pulls the default branch first,
and the image's copy may be older. Then check the app answers, with one
authenticated call. The installation's `.woodshed/install/README.md` may name
the calls for its app.

## Running a session start in the real image

`node woodshed/providers/aws/bin/askInImage.mjs <image> [question]` runs a question from Slack in the
session image (the `session` entry of Terraform's `ecr_repositories` output, with `:latest`; `docker login` to ECR
first) on the dev box. The fleet builds the session's env,
`sessionOverrides` filters it as ECS does, and the task definition's variables are added, its secrets with dummy values.
The console's real session API and Anthropic proxy answer the container from the host, with `gh auth token` and
`ANTHROPIC_API_KEY` from the environment. It prints the container's log, whether any secret is left in claude's
environment, and the answer, and exits 1 without an answer. To try a start change before the image is built, build the
image from the worktree and pass its tag. For another kind of session, copy it: change the `createSession` call and what
the stand-in session API serves.
`providers/aws/bin/qaInImage.mjs <image> <pull request number>` is that copy for a QA session: it keeps the report
instead of writing the pull request's comment and check.
`providers/aws/bin/agentInImage.mjs <image> <grok|opencode> [entrypoint.sh]` is the copy for a private session on
Grok Build or OpenCode: it serves a made-up sign-in for the agent, and passes when the agent runs in the
session's pane with its first message (its provider then refuses the made-up key, which says the key reached it). An
image with no checkout clones `REPO` (default this repo) at start. In a Woodshed session, whose Docker is the machine's,
`IN_IMAGE_CONSOLE_HOST` is this container's own address (`hostname -I`), not `host.docker.internal`.
`providers/aws/bin/reviewInImage.mjs <image> [pull request number]` is the copy for a review that Grok Build and
OpenCode run on its author's own sign-in: made-up sign-ins held by the real `reviewAgentProxy.mjs`, which forwards to a
recording stand-in upstream on this computer (`modelStandIn.mjs`), never xAI, Anthropic or OpenAI
(`IN_IMAGE_OPENCODE_PROVIDER=openai` for OpenCode on OpenAI); the review's report is kept, never posted. It prints each
body's field names, never a value, and passes when each reached the proxy with the session's token alone, the proxy
swapped in the made-up sign-in, each took a turn after its tool call, and the proxy's body scope refused none.
These two and `agentsInImage.mjs` hand the container no GitHub login of yours: a placeholder (the review check puts a
stand-in `gh` in the container that checks the pull request out by git from its public pull ref), or for a private repo
`IN_IMAGE_GH_TOKEN`, a fine-grained token that can only read it.
`providers/aws/bin/agentsInImage.mjs <image>` is the copy for the agents a private session's owner starts beside its own
(`session/agents.mjs`): it copies the checkout's `session/` and `shared/` over the image's, runs a private claude start,
then starts a claude and a codex through statusd's `/agents` and opens the TUI tab's ttyd for each, and prints PASSED or
FAILED. `IN_IMAGE_TERMINAL=herdr` runs it with the owner's Agent terminal set to Herdr.
`providers/aws/bin/herdrParentInImage.mjs <image> [entrypoint.sh]` is the copy for a private session started with
`woodshed session new --herdr --parent`: it runs the whole start under ECS's init (`--init`) and waits for the agent's
terminal, which a terminal in this computer's Herdr makes once the machine is added with `--via 'docker exec -i
woodshed-herdr-parent-in-image sh -c'` (cli/hc.mjs, `startAgentTerminal`).
`providers/aws/bin/envSourcesInImage.mjs <image>` is the copy for a console whose embedding program gives an env
file's installation values from a source of its own (`envSources`): a private claude start against the real repo
settings, with typed values kept for two env files and a made-up source on for one. It prints the console's
`repoSettings: handed out` line, the container's log and the names (never a value) in each written file, and passes when
the sourced file names the source's variables and not the typed ones. `IN_IMAGE_NETWORK` puts the container on a Docker
network, where this computer is itself a container on one.

## Checking a console page change in a browser

`node woodshed/console/bin/devConsole.mjs [port]` runs the console on loopback (default 7690) with
three made-up sessions and no AWS, GitHub, Docker or sign-in. Open `http://localhost:<port>/s/aaaa1111` in the
Playwright browser. The rail folds its stopped zones, so run
`localStorage['woodshed-rail-zones']='{"ended":false,"stopped":false,"merged":false}'` and reload to see the
cards. Pull request chips show without their state or checks, since polling GitHub is off. New session's Work on lists made-up open
pull requests, from a stand-in `gh` that answers that read and each repo's default branch (`console/bin/devGh.mjs`), so
`woodshed session new` against it gets as far as the launcher. `/s/dddd4444` is running,
for the pane bar's buttons, but has no container: it cannot show a live terminal, and the app and database links go
nowhere. `/s/5a5a5a5a` is starting, for the start checklist in the local provider's words, until the start timeout
fails it. `/s/c0ffee11` is running with a live TUI where ttyd and tmux are on the PATH (as in a Woodshed
session): `devTerminalSession.mjs` runs them on `session/tmux.conf` over a made-up conversation, for find, copy, links
and scrolling back, with a second ttyd on a shell for its Terminal tab. `/s/beadfeed?tab=review` is running with a Review tab that works: `devReviewSession.mjs` answers it with
the shed's real review page over a made-up change it commits to a scratch repo, with an analysis already written. Its
chat and Re-review run `claude` when one is on the PATH. Its terminal, Diff and app go nowhere. `/s/abbaabba` is running on a project with two apps behind the real statusd,
whose checkout has three branches with a pull request each (one checked out, one pushed and left, one in a git
worktree) behind a stand-in `gh`: its card shows a chip for each (`devAppsSession.mjs`). Add a session to
`devConsole.mjs` to cover another state.
`/s/c0de5e55` (codex) and `/s/c1a0de00` (claude) open on a Chat tab that works: the real statusd over a private tmux,
whose pane runs a stand-in agent (`devChatAgent.mjs`) writing the agents' real record formats. `/s/c1a0de02` is that
claude started from a Claude home holding an earlier session's conversation, as a private session started while another
runs is: its Chat stays empty until it is sent a message. `/s/62000c0d` (Grok Build) and `/s/0c0de0c0` (OpenCode) open
on a Chat tab that works the same way: the real statusd over a stand-in agent (`devChatAgent.mjs`) writing Grok Build's
`updates.jsonl` and OpenCode's SQLite database. `/s/a6e1a6e1` is @local's own session on the stand-in codex, whose
agent switch starts stand-in claudes and codexes beside it (`session/agents.mjs`), each with a Chat and a TUI tab that
work. `/s/c1a0dea1` runs the
real `claude` instead, in a clone of this checkout with no remote and with its TUI tab live, on this machine's Claude
credential, with `DEV_CONSOLE_REAL_CLAUDE=1`. It spends that credential's usage, and its session can run commands as
this machine, so it is never behind Start app's console, which Open app and app shares reach with no sign-in:
`devConsoleApp.sh` starts none, and `DEV_CONSOLE_SESSION_APP=1` refuses one. Run it as a console of its own on a port
nothing forwards, such as `DEV_CONSOLE_REAL_CLAUDE=1 node console/bin/devConsole.mjs 7700`, from this machine's own
browser (the Playwright one, in a session). Every made-up session's statusd listens on loopback with a token made for the
run. With
`DEV_CONSOLE_REAL_CLAUDE_MODE=default` it runs in default permission mode, as a session New session starts in "default"
does, and asks before it runs a command or edits a file, for the Chat tab's approvals. `/s/c0dea1ed` is the real
`codex` the same way, once `codex login` has signed this machine in (`DEV_CONSOLE_REAL_CODEX`); with
`DEV_CONSOLE_REAL_CODEX_MODE=plan` it runs with plan mode's read-only sandbox and asks before it writes, for the Chat
tab's approvals.
`DEV_CONSOLE_HOST_REPOS=1` starts it as an embedding program would, with a made-up `repos` hook
(`scripts/devHostConsole.mjs`): Console settings' Repos card then lists `acme/api`, `acme/web` and `acme/lib`, asks for no
name, and refuses any other typed repo with a link to give the App access, as a hosted console does. Each repo's settings page
then ends with two made-up groups of the program's own (the `repoPage` hook, drawn with `console/settingsMarkup.mjs`),
whose forms post nowhere. With `DEV_CONSOLE_REPO_SETTINGS=1` too, its made-up `envSources` hook gives
`example-org/example-repo`'s env files a source called Vault: on for `api/.env`, off for `web/.env.local`, none for
`worker/.env`, for the switch in an env file's installation layer. Its launcher keeps a made-up machine from an older image for `/s/fa11ed01`, whose page then
offers Resume on the latest image (`keptMachine`, providers/README.md). With
`DEV_CONSOLE_BLOCKED_REPO=acme/api` its made-up `projectReadiness` hook says that repo's image is not built, for the
Needs setup card on New session and the Repos card; with `WOODSHED_PROJECTS` naming the three, the default can be the
blocked one. The dev console has no sign-in, so everyone is an admin: to see the card as anyone else, answer `/api/me`
with `admin: false` from the Playwright browser (`page.route`).
`DEV_CONSOLE_REPO_SETTINGS=1` gives it a local secret store and two made-up repos, `example-org/example-repo` and
`example-org/example-tools`, whose project files its stand-in `gh` answers (three env files on the first, one on the second), so My settings' Repo settings card saves:
env file values, instructions and Your files, each per repo. The first's file names a Deploy workflow link, which the
avatar menu shows over the installation's `WOODSHED_ACTIONS_WORKFLOWS` (Run infrastructure).
`DEV_CONSOLE_REVIEWER=none|made|installed` gives it a made-up GitHub App and reviewer App, lent as a host lends its own
(`scripts/devReviewerConsole.mjs`), for `woodshed review enable` and `status` from a checkout of
`example-org/example-repo`: no reviewer App, one not installed there, or one installed. Its default branch's project
file, from the stand-in `gh`, has no review.
`DEV_CONSOLE_REVIEW_ON=1` (with `DEV_CONSOLE_REVIEWER=installed`, and `DEV_CONSOLE_REPO_SETTINGS=1` for a secret store
that keeps a made-up Claude token and Codex key) turns review on in `example-org/example-repo`'s default branch, and
gives @local three open pull requests there from the stand-in `gh`, for `woodshed review pulls|start` and `woodshed
setup`'s reviews. A review started on one queues and never runs: no session image runs here. @local needs Sessions from
GitHub on People (on for everyone on a hosted console) for a review to use their own sign-ins. `DEV_CONSOLE_REVIEW_ON=default`
gives the repo a project file that names no review, for the console's default review.
`DEV_CONSOLE_REVIEW_PR=1` makes `/s/beadfeed` @local's own My Woodshed session whose branch has a made-up open pull
request, #26701, answered by a stand-in `gh` (`console/bin/devReviewGh.mjs`), for `woodshed review beadfeed` and the
review's comment, verdict, rename and merge, and a made-up review by Claude Code and Codex for the AI reviews tab (cli/README.md, "Reviewing a session on this terminal").
`DEV_CONSOLE_WEBHOOKS=1` names a webhook receiver (which never listens, since polling is off), so the Console
settings page shows its GitHub webhooks switch (Slack's needs a console that answers Slack questions), and the
Webhook events page lists made-up deliveries: acted on, ignored, skipped and failed.
`/analytics` shows 90 days of made-up history (`devAnalytics.mjs`): sessions in `usageKept` and the pull requests the
stand-in `gh` answers the page's search with, through Woodshed and without, with merge risk tiers.
`DEV_CONSOLE_PEOPLE=1` gives the People page four made-up members, with their switches every way, and two people asking
to join.
A Woodshed session on this repo has it as its app: **Start app** runs `scripts/devConsoleApp.sh`, which serves it on
7690 with `DEV_CONSOLE_SESSION_APP=1` so it also answers under the session's app name, behind **Open app**.

When a change needs data the console gets from somewhere a session cannot reach (GitHub's pull request state and
checks, a running container, the Slack or review APIs), do not stop at "not proven". Fake that input: add a session to
`devConsole.mjs` that carries the fields the page reads, or serve a stub for the call, and check the page against it.
Say in the PR which parts were faked.
