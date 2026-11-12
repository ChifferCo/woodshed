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
| Database viewers | `pgweb` and `mongo-express` inside each session, on its own databases (a private session's pgweb also on its restored copy, through bookmarks in `/tmp/woodshed-pgweb-bookmarks`, and a second mongo-express on its Mongo copy at `/mongo-copy/<id>/`), at `/pg/<id>/` and `/mongo/<id>/` | In the session, `/tmp/pgweb.log` and `/tmp/mongo-express.log` |
| Claude homes | S3 `<prefix>-homes-<account id>`, `<login>/claude-home.tar.gz`: each person's `~/.claude` between their private sessions (the last to stop), `<login>/sessions/<id>/claude-home.tar.gz`: one private session's own, for its Resume, and `_sessions/<id>/claude-home.tar.gz`: a kept shared session's, between its runs, and `<login>/claude-settings.json`: the settings every private session of theirs keeps in step with. Only the console's role reaches it | `aws s3 ls s3://<prefix>-homes-<account id>/` (names and sizes; never download someone's) |
| Images | ECR `<prefix>-session`, `<prefix>-console` | `aws ecr describe-images --repository-name …` |
| Terraform state | S3 `<prefix>-tfstate-<account id>` (or the tfvars' `tfstate_bucket`), see `.woodshed/install/aws/backend.hcl` | Created by hand, so `terraform destroy` leaves it |
| Webhooks | Lambda `<prefix>-webhooks` (URL: the `github_webhook_url` output), queue `<prefix>-webhooks` and `-dead`. The console's Webhook events tab lists what it did with each message | `aws logs tail /aws/lambda/<prefix>-webhooks`, `aws sqs get-queue-attributes --queue-url <url> --attribute-names All` |

## The secrets

| Secret | Used by | What breaks when it is wrong |
| --- | --- | --- |
| `anthropic-api-key` | The console only: its Anthropic proxy adds it to claude's calls in every session not on a Claude plan, and the console's Haiku call that names a My Woodshed session started with no name reads it through the proxy. An app in a session uses whatever key its own env files hold (or the owner's own line) instead, directly. Write-only on the Secrets tab. Never in a session: not in the task definition, and the session holds its `SESSION_TOKEN` in its place | claude says `the console has no Anthropic key` (the proxy's 503) or stops with a 401 from Anthropic. The console logs `anthropicProxy: team key read` with `set`, and `anthropicProxy: credential not read` when Secrets Manager failed. A private session named after its prompt's first line means the naming failed: the console logs `autoName: Anthropic refused` with the status, `autoName: failed`, or `autoName: no team Anthropic key`. Spend-capped by its Anthropic workspace |
| `openai-api-key` | The console only: its OpenAI proxy (`console/openaiProxy.mjs`) adds it to the calls of private Codex sessions with no sign-in of their own. Write-only on the Secrets tab. Never in a session, which holds its `SESSION_TOKEN` in its place | codex says `the console has no OpenAI key` (the proxy's 503). The console logs `openaiProxy: team key read` with `set`, `openaiProxy: refused, not a Codex session`, and `credential not read` when Secrets Manager failed |
| `github-app-key` | The console only, to mint installation tokens for itself and for sessions. Read straight from Secrets Manager, never written to disk, and write-only on the Secrets tab. Never in a session | With no value the console logs `no GitHub App key yet` at start and skips polling until one is uploaded. Otherwise it logs `GitHub refused an installation token` with GitHub's reason. A session's `gh` says `could not get a GitHub token`: check `sessionApi:` lines in the console's log, then that port 7691 is open from the sessions' security group |
| `slack-bot-token` | The console only, to post each pull request a session opens to its project's channel on the Console settings page (or the Slack card's), and to answer questions from Slack in their threads. Write-only on the Secrets tab. Never in a session | The console logs `slack: no bot token yet, nothing sent`, or `slack: call refused` with the method and Slack's error: `not_in_channel` means the bot was not invited, `invalid_auth` a wrong token, `channel_not_found` a name where the ID belongs, `missing_scope` a scope console/README.md's "Questions from Slack" lists (`app_mentions:read`, `chat:write`, `reactions:write`, `users:read`, `users:read.email`) and the app lacks. |
| `slack-signing-secret` | The webhooks Lambda only, to check each Slack event (`/slack`). Set on the Secrets tab, write-only there | Every mention is refused: the Lambda logs `webhooks: bad or missing Slack signature`, and Slack's Event Subscriptions page says the Request URL failed. With no value at all the Lambda fails the read, and Slack sees a 502 |
| `github-app-client-secret` | The console only, to sign people in with GitHub. Write-only on the Secrets tab. Never in a session | The base box's console always requires sign-in, so with no value or a wrong one nobody gets in: GitHub refuses each sign-in code and the console logs `auth: GitHub refused the sign-in code`. console/README.md, "Sign-in", sets it from a shell |
| Each env file's secret (the project file's `envFiles` with a `secret`, such as `api-env`) | The app inside a session, whatever it reads from that file: the entrypoint writes it whole, then the project file's lines | The app does not boot, or its login fails. What each file must hold is the installation's: its `.woodshed/install/README.md` |
| `users/<login>/claude-token` | The Claude plan of one person's My Woodshed sessions, and the shared sessions they start while their switch for it is on. Made by the console on My settings, never by Terraform; write-only there. Handed to that person's private sessions alone, in the `/settings` answer, for claude to call Anthropic with directly (the Artifact tool needs a real token). Never handed to a shared session: the console's Anthropic proxy adds it to the calls of a shared session whose `plan` is that login and who started it | The session's log says `could not get the owner's settings` and it fails. The console logs `sessionApi: no Claude token for the owner`, or `anthropicProxy: no Claude token saved for the plan` when it was removed mid-session from a shared session's starter. A running private session keeps the token it started with until it stops. claude asks to log in when the token was revoked: save a new one |
| `users/<login>/codex-auth` | One person's Codex sign-in from My settings: an OpenAI API key, or `~/.codex/auth.json`. Handed to their private Codex sessions alone, in the `/settings` answer; a session writes a refreshed ChatGPT login back at stop (`POST /codex-auth`) since OpenAI rotates it | The console logs `sessionApi: Codex sign-in decided` with `own`, and `Codex sign-in kept` or `refused` at stop; statusd logs `statusd: Codex sign-in sent back` with the status. codex asking to log in means the saved login expired or a session never stopped cleanly to save the rotated one: save a new one |
| `users/<login>/<env secret>`, `users/<login>/tmux-conf` | One person's own lines for the env files and tmux config, from My settings, written after the shared env file secrets and the image's `tmux.conf` in their private sessions only. Readable by them there, since their sessions hold the same text | A bad line breaks only that person's sessions: the session's log says `Owner's settings fetched` with `own lines in: ...`; **Clear mine** on My settings fixes it. The rules above apply to these too: no production credentials |
| `users/<login>/github` | One person's GitHub App user token from Connect GitHub (JSON: the token, its expiry, the refresh token), for their private sessions' git and `gh`. Made and rotated by the console (`githubUser.mjs`); never in a session | Their next push fails with `GitHub no longer accepts @<login>'s authorization`: the console logs `githubUser: GitHub refused the refresh, disconnecting`. Connect GitHub again on My settings. A session whose project file says `githubAccess: repo` gets it scoped to that project's repo (`githubUser: scoped token made`); `githubUser: GitHub refused a scoped token` or `no scoped token, the console has no client secret`, then `sessionApi: no scoped owner token for the session's project`, means it pushes as the App instead |
| `sessions/<id>/database`, `users/<login>/database` | The password of each database's own user: `woodshed__<id>` for that shared session and the viewers inside it, deleted with its databases; `woodshed_<login>` for that person's private sessions and the viewers inside them. Made by the console. Not on the Secrets tab | See the database symptoms below |
| RDS's own master secret, `<prefix>-root/mongo` | Each only where the installation runs that database (`databases` in Terraform). Root, for the db-admin task alone, through its execution role. Not the console, not the base box (which writes Mongo's once and cannot read it back), not a session | The db-admin task's log (`/<prefix>/sessions`, stream `db-admin/...`) fails at its first connection. A Mongo root password that could not be saved is in `/root/<prefix>-mongo-root` on the base box: put it in the secret, then delete the file |
| Each install secret (`install_secrets` in Terraform, such as `registry-token`) | The repo's dependency installs: the image build's (a line of the build's `install_env` secret, which the deploy workflow's session job writes from a repo secret) and a session's, only when a branch changed an install's files since the image was built. A session gets it in the variable `install_secrets` names, which claude's terminal has too; an ask session unsets each variable `WOODSHED_INSTALL_SECRETS` lists | `/tmp/woodshed-deps` says `failed: \`<command>\` in <dir>. Are the install secrets (<variables>) right?`, the log has `ERROR: the install failed` with the dir, and Claude asks for help. The image build logs `deps: install secrets in <variables>`, or `deps: no install secrets` when it got no `install_env`. In a session's Terminal, `[ -n "$<variable>" ] && echo set` |

The entrypoint adds the session's databases, Mongo, Redis (when the project uses it), the shared services, port and
URL on top of each env file's secret
(`writeEnvFiles` in `session/entrypoint.sh`), so those never belong in the
secrets.

## By symptom

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
- **A label or `/woodshed` comment does nothing.** A label on a pull request
  never starts a session (console/README.md, "How sessions start"): the console logs
  `fleet: trigger routed` with `action: ignore`. Otherwise `docker compose logs
  console` on the base box. Check it has no `GitHub refused an installation
  token` lines, and that the person is a collaborator with write access: the console ignores
  anyone else.
- **A shared session is Unassigned, or has the wrong person.** The console logs `fleet: session starts unassigned, its
  starter cannot be assigned` when the label or comment came from someone with Can be assigned off (People page), and `fleet:
  session assigned` with `from`, `to`, `by` and `how` (`label`, `comment`, `console`, `take it`, `hand over`, `unassign`) on every
  change. Someone who can be assigned commenting on an unassigned session takes it; a later comment on an assigned one does not move it.
  `members: can be assigned changed` and `members: sessions from GitHub changed` say who turned a switch. Assign answers 409
  `only someone who can be assigned sessions can assign one` or `@x cannot be assigned sessions`. A private session and a
  question from Slack cannot be assigned.
- **A label or /woodshed comment got a "can't start Woodshed sessions from GitHub yet" reply.** Their Sessions from
  GitHub is off on People: the console logs `fleet: trigger ignored, no sessions from GitHub`, and `fleet: label removal
  failed` when GitHub kept the label. The same person sees no Everyone tab, and a shared session's link answers 404 for them.
- **An issue's assignee or project status did not follow its session.** The console logs `issueTracking: issue marked
  in progress` with the boards `moved` and `skipped` (`no In progress status`, `already in progress`), and
  `issueTracking: assignee put on the issue`, `taken off the issue` or `already on the issue`. `fleet: issue in progress
  failed` or `fleet: issue assignee failed` with `Resource not accessible by integration` means the GitHub App lacks
  the org's Projects write or the repo's Issues write permission, or the org has not accepted it yet.
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
- **The app inside a session will not start or log in.** That is about the repo's own app, and its installation
  says what to check: `.woodshed/install/README.md` in the repo. The env files get the databases through the project
  file's lines, from each engine's variables (`PGHOST`, `PGPASSWORD`, `MONGODB_URI`; docs/reference.md, "Databases"):
  quote a password there, since an app that reads them with a stricter parser than dotenv can take a `#` for a
  comment.
- **No session starts, saying `the project file's databases need mongo, which this installation does not host`.**
  The project file's `databases` name an engine the installation does not host: add it to `databases` in Terraform
  (or the local provider's `WOODSHED_LOCAL_DB_*` and session env), or take that database out of the project file. The
  console reads the default branch's file and logs `console: project databases not hosted` with `needs` and `hosted`,
  then `fleet: session refused, its databases are not hosted` for each start it refused (`fleet: trigger refused` for a
  label or comment, which gets the reason on its issue). A session started from a branch whose own file differs stops
  at start with the same words. The console logs `console: databases` at start with the `engines` it makes and the ones
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
- **A session's dependencies are missing or old, or `/tmp/woodshed-deps` says `failed`.** At start the session's log
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
  `why: 'review feedback'` for a paused one. Each verdict, and each commit's
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
  sessions` logs each change), nor on a console that makes no shared databases
  (the docker launcher), whose sessions never ask the session API. The session's own log says `Runs on the
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
- **A question in Slack gets no 👀 and no answer.** The Lambda's log has
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
  `fleet: QA label ignored` gives the `reason` (no write access, QA already running, not open). A started one logs
  `fleet: QA session started` with its `base`.
- **A QA comment stays at Running.** The session's terminal shows the run (`[qa …]` lines). `fleet: QA finished`
  with the `conclusion` means the report arrived; without it, `sessionApi: a QA report refused` gives `why`, and
  the terminal's last line `Report sent to the console (status: …)` the reply. A session that stopped first (idle or
  lifetime) never sent one: label the pull request again.
- **A QA session finished but its pull request has no QA check.** `fleet: QA finished` says `checkPosted: false`, and
  `fleet: QA check failed` gives GitHub's reply: a 403 means the installation has not accepted the App's Checks: write.
  `fleet: QA check skipped, not the pull request's commit` means the report named a commit that was neither the one the
  session started on nor the pull request's head: the pull request's code can send the report, so it gets no check.
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
  uploaded` with the pane; the console logs `console: statusd unreachable` when
  the session did not answer. A picture answers 404 for a path outside the
  repo, `/tmp/uploads` and the scratchpad, or one that is not png, jpg, gif or
  webp after its symlinks. A session started from an image before
  `terminalFiles.mjs` answers 404 for all three routes: start a new one.
- **The phone's message box says Not sent, or claude never got it.** The
  console logs `console: message typed in from the page` with the length, and
  statusd `statusd: text sent to claude`; a file from **📎** logs `statusd:
  file uploaded` with `typed: null`. The mic is hidden where the browser has no
  speech recognition, and says why in a toast when the site may not use the
  microphone. A terminal that reconnected by itself logs `terminal:
  reconnecting` in the browser's console.
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
- **A pull request's chip or Slack post lags by minutes after a change.**
  With pull request webhooks arriving, a change is read within seconds: the
  console logs `pullWebhooks: pull request marked due` with the numbers, what
  changed and `by` (the chip, the Slack post or retention). Between them it
  reads each pull request only every 5 minutes. `pullWebhooks: pull request
  polling changed` with `webhooks: false` means none came for half an hour, and
  it is back to every minute. If that keeps happening, the App is not
  subscribed to **Pull request review** and **Workflow run**: the webhook card
  on the Secrets & webhooks tab lists what is missing.
- **The CPU and memory badge is missing.** statusd reads the container's cgroup
  (`session/usage.mjs`); a session from an image before it reports no `usage`.
  CPU shows `—` until two status reads 2 s apart.
- **A private session's Plan chip is missing or old.** It shows once Claude has answered: in the session's
  Terminal, `cat ~/.claude/woodshed-usage/claude.json` is what the status line saved. No file means Claude Code sent no
  `rate_limits` (a session not on a Pro, Max or Ultra plan, or none answered yet), or the status line is not
  `session/statusline.sh`. statusd logs `statusd: plan usage not read` with the error once per reason. The chip shows
  the newest reading of all your private sessions, its age past 30 minutes, and none from an image before
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
- **New session's Codex models are old, or say `codex's built-in list`.** The line under the menus says why. The console
  logs `codexModels: catalog read` with `source` (`own` or `team`) and how many `models`, `OpenAI refused the catalog`
  with the `status` (a 401 is a sign-in OpenAI no longer takes), `catalog not read`, `own sign-in expired, not read`
  (a Codex session refreshes it at its stop) or `credential not read`. It tries again a minute after a failure.
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
- **Data ▾ has no Redis, or Redis answers `not found` or `the Redis viewer is not running`.**
  No Redis means the project file's env never mentions `REDIS_URL`, so the session started none: its log says
  `Redis not started`, and statusd reports `redis: false`. `not found` means the session started from an image without
  redis-commander; `the Redis viewer is not running` that it died: `/tmp/redis-commander.log` in the session's terminal.
  Its Postgres and Mongo are the same, with `/tmp/pgweb.log` and
  `/tmp/mongo-express.log`; a session started from an image before every session
  had its own databases runs them only when private.
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

## Checking a console page change in a browser

`node woodshed/console/bin/devConsole.mjs [port]` runs the console on loopback (default 7690) with
three made-up sessions and no AWS, GitHub, Docker or sign-in. Open `http://localhost:<port>/s/aaaa1111` in the
Playwright browser. The rail folds its stopped zones, so run
`localStorage['woodshed-rail-zones']='{"ended":false,"stopped":false,"merged":false}'` and reload to see the
cards. Pull request chips show without their state or checks, since polling GitHub is off. `/s/dddd4444` is running,
for the pane bar's buttons, but has no container: it cannot show a live terminal, and the app and database links go
nowhere. `/s/5a5a5a5a` is starting, for the start checklist in the local provider's words, until the start timeout
fails it. `/s/beadfeed?tab=review` is running with a Review tab that works: `devReviewSession.mjs` answers it with
the shed's real review page over a made-up change it commits to a scratch repo, with an analysis already written. Its
chat and Re-review run `claude` when one is on the PATH. Its terminal, Diff and app go nowhere. Add a session to
`devConsole.mjs` to cover another state.
A Woodshed session on this repo has it as its app: **Start app** runs `scripts/devConsoleApp.sh`, which serves it on
7690 with `DEV_CONSOLE_SESSION_APP=1` so it also answers under the session's app name, behind **Open app**.

When a change needs data the console gets from somewhere a session cannot reach (GitHub's pull request state and
checks, a running container, the Slack or review APIs), do not stop at "not proven". Fake that input: add a session to
`devConsole.mjs` that carries the fields the page reads, or serve a stub for the call, and check the page against it.
Say in the PR which parts were faked.
