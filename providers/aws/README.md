# The AWS provider

Woodshed on AWS: the console on one always-on EC2 machine (the base box), each session a Fargate task, and the
secrets, Claude homes, webhooks and databases in AWS services, all in an AWS account of its own. `index.mjs` is what
it hands the console; Terraform in `terraform/` builds the rest. An installation keeps its values for it in its
own repo, such as in `.woodshed/install/aws/`. `<prefix>` below is its `name_prefix` ("Setting it up", step 2).

| Part | File | In AWS |
| --- | --- | --- |
| Session containers | `ecsLauncher.mjs` | Fargate tasks in the `<prefix>` ECS cluster |
| Secrets | `secretStore.mjs` | Secrets Manager, under `<prefix>/` |
| Saved Claude homes | `homeStore.mjs` | A private S3 bucket only the console's role reaches |
| Each session's own databases | `dbAdminRunner.mjs` | Those `databases` names: RDS Postgres, and the base box's Mongo, copied by a db-admin Fargate task. None of them, and no task, for `[]` |
| GitHub and Slack webhooks | `webhooks/` (a Lambda), `webhookQueue.mjs`, `webhookUrl.mjs` | A Lambda Function URL that checks each delivery and queues it in SQS, which the console long-polls |
| The machine | `terraform/` | The base box (EC2), its data disk, the network, DNS and the IAM roles |

The console picks this provider with `WOODSHED_PROVIDER=aws`, or `WOODSHED_LAUNCHER=ecs`. The base box sets
those and every other setting from Terraform's outputs, so there is nothing to set by hand; `console/README.md` lists
them. A setting only the local provider serves stops a console started here.

## Setting it up

`terraform plan` must only ever create resources the first time. If it wants to change or destroy anything, stop.
Keep the account for Woodshed alone: "How it is built", below, says why.

1. Once, the state bucket (versioned, private). Its name is yours to pick. The deploy workflow's plan role may take
   the state's lock only in `<prefix>-tfstate-<account id>`, at the key `<prefix>/terraform.tfstate`, unless the
   tfvars name another with `tfstate_bucket` and `tfstate_key`:

   ```bash
   bucket=<your state bucket>
   aws s3api create-bucket --bucket "$bucket" --region us-east-1
   aws s3api put-bucket-versioning --bucket "$bucket" --versioning-configuration Status=Enabled
   aws s3api put-public-access-block --bucket "$bucket" \
     --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
   ```

2. The installation's `terraform.tfvars`: its values for the code in `providers/aws/terraform/`, none of them
   secret: the repository that deploys it, the budget email, the GitHub App's IDs, the `databases` engines it hosts, and with
   Postgres the name and master user RDS starts with (nothing else uses them, and a change replaces RDS). The code has no default
   for the ones that name an installation, so each installation writes its own, from
   `providers/aws/terraform/example.tfvars`, and keeps it in its own repo. Its `backend.hcl` names where the state
   lives (`example.backend.hcl`). Check both in, such as at `.woodshed/install/aws/`.

   `name_prefix` names every AWS resource, tag, secret and base box path: `woodshed` for a new installation
   (`woodshed-base-box`, `woodshed/github-app-key`, `/opt/woodshed`). It has no default, and an installation made
   before it existed must set `woodshed-cloud`, the name everything there already has. Any other value plans to make
   all of it again under new names, empty: the secrets, the Claude homes bucket, the images and the database would be
   left behind under the old ones, and the plan role could no longer take the state's lock. Never change it on a live
   installation without a migration: besides the AWS names, the base box keeps its data volume at
   `/var/lib/<prefix>` (in `/etc/fstab`) and its stack at `/opt/<prefix>`, which the stack's unit and scripts are named
   after. At most 20 lowercase letters, digits and single dashes, starting with a letter.

   Two others are optional:

   - `domain`, the console's name. Left out, the console is `https://woodshed.<Elastic IP with dashes>.sslip.io`
     (the `console_url` output): sslip.io answers any name with an IP in it with that IP, so there is no DNS to set
     up, and Caddy gets a certificate for each name the first time it is opened, after asking the console whether it is
     one of its own (on-demand TLS, `console/tlsAsk.mjs`). Let's Encrypt counts every `sslip.io` certificate,
     everyone's, against one weekly limit, and Caddy falls back to ZeroSSL when it refuses; each session app's first
     visit waits a few seconds for its certificate. With a domain, Terraform makes it a Route 53 zone of its own, the
     parent domain delegates it (step 7), and one wildcard certificate covers every session app. Setting one later
     changes the console's address: the GitHub App's Callback URL then needs the new one.
   - `sessions_on_github_repo`, true unless set. `github_repo` is where the deploy workflow runs (the GitHub roles
     trust it) and what the session image is built from; with true it is also the repo sessions work on, the console's
     default. False keeps it to deploying, such as a repo of the installation's own: the console starts with no repo,
     and an admin adds the ones sessions work on, on the Console settings page (Repos). Until the first is added,
     only the owner of the account the GitHub App is installed on can sign in (an admin, for an organization: the App
     then needs Organization permissions, Members: read), and New session says to add a repo. The first repo added
     becomes the default. Sessions on an added repo clone it at start and run in the session image built from
     `github_repo`, so they get none of that repo's installs or secrets (`session/entrypoint.sh`).

   The App comes first: in the org's settings, Developer settings, GitHub Apps,
   create one with the webhook off and repository permissions Contents, Issues
   and Pull requests and Actions (read and write), and Metadata, Checks and
   Commit statuses (read), installable only on
   this account. Install it on this repo only (on the repos sessions will work on, too, with
   `sessions_on_github_repo = false`, and then also give it Organization permissions, Members: read). The App ID is
   on its settings page; the installation ID ends the installation page's URL. Its Callback URL and client secret come
   in step 4, once the console's address is known.

3. From `providers/aws/terraform/`: `terraform init -backend-config=<your backend.hcl>`, then
   `terraform plan -var-file=<your terraform.tfvars> -out=woodshed.tfplan`, read it, and
   `terraform apply woodshed.tfplan`. With them at `.woodshed/install/aws/`, those are
   `../../../../.woodshed/install/aws/backend.hcl` and `../../../../.woodshed/install/aws/terraform.tfvars`, and the
   deploy workflow ("The deploy workflow", below) runs the same.
4. Before the console's first start, give it what sign-in needs: the base box requires sign-in from the start
   (`WOODSHED_REQUIRE_SIGN_IN=1`), and a console without these lets nobody in, so the Secrets & webhooks tab
   cannot be reached to set them. On the App's settings page (General), set **Callback URL** to the `console_url`
   output plus `/auth/callback`, then **Generate a new client secret** and **Generate a private key**. Save the secret
   to a file only you can read, upload both, and delete both files:

   ```bash
   aws secretsmanager put-secret-value --secret-id <prefix>/github-app-client-secret --secret-string file://<secret file>
   aws secretsmanager put-secret-value --secret-id <prefix>/github-app-key --secret-string file://<key>.pem
   ```

   The console reads both at start. Set later, they need `sudo docker compose restart console` in
   `/opt/<prefix>` on the base box (console/README.md, "Sign-in"). **Done when** the console's first start
   (step 6) logs `console: GitHub sign-in` with `available: true`, and no `console: no GitHub App key yet`.
5. Create the three GitHub environments the deploy workflow's roles trust, before its first run (a workflow naming an
   environment that does not exist creates it, with no reviewers): `<prefix>-plan` and `<prefix>-images`,
   each with deployment branches limited to the default branch, and `<prefix>-infra` (the default branch only,
   with required reviewers, and administrators may not bypass them; whoever starts the run may approve it). Set the
   repository variables `WOODSHED_CLOUD_PLAN_ROLE_ARN`, `WOODSHED_CLOUD_INFRA_ROLE_ARN` and
   `WOODSHED_CLOUD_AWS_ROLE_ARN` to the `github_plan_role_arn`, `github_infra_role_arn` and `github_images_role_arn`
   outputs, `WOODSHED_CLOUD_BASE_BOX_ID` to the `base_box_instance_id` output, plus `WOODSHED_CLOUD_AWS_REGION` if not
   us-east-1.
6. Run the deploy workflow. With nothing to apply after step 3, it builds both images. The console job ends
   by starting the stack on the base box over SSM. Its first start at boot
   fails until the console image exists, and this is what starts it.
7. Open the `console_url` output. With a domain, first delegate it: an NS record for it where the parent domain's
   DNS is hosted, holding the `dns_nameservers` output, until `dig <domain>` answers the Elastic IP. With none there
   is nothing to wait for. Before that, `https://<Elastic IP>` works with Caddy's own
   certificate: accept the browser's warning for that one address. Do not
   install Caddy's root certificate: it is not limited to this site, and its key
   lives on the base box.
8. Sign in, then on the Secrets & webhooks tab set the four session secrets (a session will not start until all
   have a value). Each env file the project file names gets its values on Console settings → Repos → the repo →
   Settings, which needs no Terraform.
9. With a database in `databases`, build the database template once with the `db_template_command` output:
   step 6's session job tried, before the secrets were set. Every session's
   databases are copied from it, so a session started before it waits five
   minutes for one, then fails. After this, each session build makes it again.
10. Webhooks: on the same tab, **Set up webhook** and follow its three steps.
   The console finds the queue by name, so nothing restarts.

## The deploy workflow

An installation deploys with one GitHub Actions workflow in its own repo, which plans the infrastructure, applies the
plan once a reviewer approves it, then builds the images. Woodshed does not ship it: each installation writes its own,
because it names where Woodshed comes from (a fork, a pinned commit or this repo's `main`) and where its own
`backend.hcl` and `terraform.tfvars` are. Its jobs, each needing the one before:

| Job | Environment and role | What it does |
| --- | --- | --- |
| resolve | none | Turns the Woodshed ref being deployed into one commit, which every job below checks out, so a merge during the run cannot mix versions |
| check | none | Runs Woodshed's reusable `.github/workflows/project-check.yml` at that commit on the repo's project file, before anything touches AWS |
| plan | `<prefix>-plan`, `WOODSHED_CLOUD_PLAN_ROLE_ARN` | `terraform init` with the installation's `backend.hcl` and `-lockfile=readonly`, then `terraform plan -var-file=<its terraform.tfvars> -out=... -detailed-exitcode`. It writes the plan to the run summary, with anything it destroys or replaces first, and uploads the plan file with `providers/aws/terraform/.build/` (the Lambda zip the plan was made with) |
| apply | `<prefix>-infra`, `WOODSHED_CLOUD_INFRA_ROLE_ARN` | Waits for a reviewer, then applies exactly the uploaded plan. Skipped when the plan has no changes. One at a time (a `concurrency` group, never cancelled) |
| console | `<prefix>-images`, `WOODSHED_CLOUD_AWS_ROLE_ARN` | Builds and pushes the console image, then runs the `<prefix>-redeploy-console` SSM document on the base box (`WOODSHED_CLOUD_BASE_BOX_ID`) |
| session | `<prefix>-images`, `WOODSHED_CLOUD_AWS_ROLE_ARN` | Builds and pushes the session image with the repo checked out in it, adds its SOCI index (`session/addSociIndex.sh`), and builds the database template again when its `paths` changed |

The image jobs run after a successful apply, or when apply was skipped because the plan had no changes, never after a
rejected or failed one: the images could need what it changes. A job whose role variable is unset is skipped. The
workflow's own permissions are `contents: read` and `id-token: write`, the second for GitHub OIDC. Each job checks the
installation's repo out at the root and Woodshed in a `woodshed/` folder inside it, as the session image's `Dockerfile`
expects. When to run
it is the installation's choice: by hand from the default branch, on a schedule so the session image picks up the
repo's newest dependencies, or both. Tagging each image with the Woodshed commit it was built from lets the next run
say what changed since the last deploy.

## Using it day to day

| What | How | Running sessions |
| --- | --- | --- |
| The console | Run the deploy workflow; its console job restarts the console | Carry on; the console restarts and picks them back up. Open terminals need a reload |
| The session image | Run the deploy workflow; its session job builds it from the default branch | Keep their image; only new sessions get the new one |
| Infrastructure | Run the deploy workflow: it plans, and applies once a reviewer approves ("Changing the infrastructure", below) | Depends on the change; the plan says. Replacing the base box restarts Mongo |

What survives a restart or a resized or replaced base box: Mongo, the console's
list of sessions and Caddy's certificate, all on the data disk. What does not:
what a shared service keeps in its container, such as files in a fake S3, which has no volume.

### Changing the infrastructure

Run the deploy workflow after a change to `providers/aws/terraform/`, `providers/aws/webhooks/` or the installation's
values in `.woodshed/install/aws/` (or at any time, to catch drift). Its plan job puts the plan in the run summary with
anything it destroys or replaces listed first, and its apply job waits for a reviewer on the
`<prefix>-infra` environment. Approving applies that saved plan and
nothing else; Terraform refuses it if the state changed since, and then a
re-run plans again. Rejecting leaves AWS as it was, behind the default branch, until the
next run. The plan role reads everything in the account except object
contents and log events (people's Claude homes, the session logs), and takes
the state lock. The infra role is an administrator of the account, which is
why its environment needs a reviewer, and why that environment must never be
given to a Claude workflow.

Updating the console: the deploy workflow's console job does it. After the push it runs
the `<prefix>-redeploy-console` SSM document on the base box, which pulls
the new image and recreates only the console container. Running sessions carry
on; open terminal tabs need a reload. The GitHub role can run that one
document on that one instance and nothing else.

Changing the base box's stack (`baseBoxStack.sh.tftpl`: the compose file,
the Caddyfile, the helper scripts and units): `terraform apply` is all it
takes. The stack is an SSM document, `<prefix>-configure-base-box`, and
an association of the same name runs it on the box whenever it changes. It
applies the new config with the images already there (`<prefix>-up
--no-pull`), so it never deploys a console image by the way. The run is
asynchronous: check it after the apply with

```bash
aws ssm describe-association-executions --association-id "$(aws ssm list-associations \
  --association-filter-list key=AssociationName,value=<prefix>-configure-base-box \
  --query 'Associations[0].AssociationId' --output text)" --max-results 1
```

Adding a repo sessions start on: an admin can do it on the console's Console settings page (Repos), once the GitHub App is
installed on the repo, with no apply. To keep it in the installation's configuration instead, add it to `projects` in the installation's tfvars (`example.tfvars` shows the
shape), with the current repo as the default, and install the GitHub App on it. The plan changes only the
`<prefix>-configure-base-box` document and its association: the console gets `WOODSHED_PROJECTS` and
restarts, and its sessions carry on. Every project uses the one session image, task definition and databases for now.
With `projects` empty, the default, the compose file has no such line.

Naming the console: set `console_name` in the installation's tfvars, such as `"Acme Woodshed"` (default `"Woodshed"`).
Like `projects`, the plan changes only the `<prefix>-configure-base-box` document and its association: the
console gets `WOODSHED_CONSOLE_NAME` and restarts. The pages and the manifest follow at once; an app already
installed from the browser keeps the old name until it is installed again, since the browser keeps the name it was
installed with.

Env files leaving Terraform: an installation set up before Repo settings has `env_files` and `database_env_secrets`
in its tfvars, one Secrets Manager secret for each env file. Those are not read any more, and the plan stops with
`env_files is no longer read` while either is set. Check each file on Console settings → Repos → the repo → Settings
(a console of the release before copied them there at its start; one that skipped it has the values only in those
secrets, read with `aws secretsmanager get-secret-value` into a file and pasted on the page), then delete both from
the tfvars. The next plan destroys `aws_secretsmanager_secret.session["<key>"]` for each env file (its name with
dashes as underscores) and changes the rest in place: a new session task definition without their variables, the
session execution role's, the base box role's and the db-admin roles' policies, and the base box's stack document
without `WOODSHED_ENV_FILES`. The deploy workflow stops at a plan that destroys anything: run it once with
`allow_destroy`. The secrets are deleted at once (no recovery window), so check the page first.

Terraform ignores changes to `baseBox.sh.tftpl` (first boot only), so an apply
never replaces the box by surprise. `terraform apply -replace=aws_instance.base_box`
does: the new box mounts the same data volume, so Mongo and the console's
sessions survive, and the association sets up its stack.

## Costs

- **Idle:** about $26 a month with no databases, up to $56 with both. The base
  box is about $15 (`t3.small`), or $30 (`t3.medium`) with Mongo or a shared
  service on it; RDS about $14 with Postgres; the disks about $4, the Elastic IP
  $3.65, the secrets about $3 and the DNS zone $0.50.
  An installation from before `t3.small` was the default, with no
  `base_box_instance_type` set and neither Mongo nor a shared service, sees its
  box go from `t3.medium` to `t3.small` in its next plan: an update in place
  that stops and starts the box, so the console is down for a minute or two.
  Set `base_box_instance_type = "t3.medium"` to keep it.
- **Per session:** about $0.13 an hour on Fargate, plus the Anthropic usage,
  which its own workspace caps.
- **Budget:** `monthly_budget_usd` ($150), with emails at 80% and 100%.

## Removing it all

`terraform destroy` from `providers/aws/terraform/` removes everything it made, the data disk
and the five secrets included. Then empty and delete the state bucket by hand,
since Terraform did not create it. To remove the account itself, close it from
its root user (Account settings, Close account).

## How it is built

`providers/aws/terraform/` builds the AWS side in an AWS account of its own, everything named
`<prefix>*` and tagged `project = <prefix>`, where `<prefix>` is the `name_prefix` variable. Keep it in an account
that holds nothing else: the security below relies on that.

| Piece | What |
| --- | --- |
| Network | Its own VPC, two public subnets, no NAT. Security groups: 443 to the base box from anywhere, and 80, which only redirects to HTTPS; Mongo (with `mongo` in `databases`) and each of `shared_services` from sessions only; ttyd and statusd on sessions from the base box only; Postgres from both (with `postgres`) |
| RDS | With `postgres` in `databases`: Postgres 16 `db.t4g.micro`, 20 GB, backups off. RDS keeps the master (root) password in its own Secrets Manager secret, which only the db-admin task reads |
| Base box | EC2 `t3.small`, or `t3.medium` with Mongo or a shared service on it (`base_box_instance_type` picks another; one with less memory, or not x86 like the session image, is refused at plan), with an Elastic IP, SSM and no SSH. `baseBox.sh.tftpl` (first boot) installs Docker and mounts the data volume; `baseBoxStack.sh.tftpl`, applied by an SSM association, runs Mongo (with `mongo` in `databases`), the installation's `shared_services`, the console and Caddy from `/opt/<prefix>/compose.yml`, each service's `files` from `/opt/<prefix>/services/`. Caddy is built on the box with the Route 53 DNS provider: it gets `domain`'s Let's Encrypt certificate through a TXT record in the zone, so Let's Encrypt never connects to the box. The bare IP keeps `tls internal` |
| Data volume | A 20 GB EBS volume at `/var/lib/<prefix>` holding Mongo, the console's session list and Caddy's certificate, so they survive restarts, resizes (`base_box_instance_type`) and a replaced box. `terraform destroy` removes it with the rest. Localstack's S3 files are not kept: the free edition has no persistence |
| Sessions | ECS cluster and one Fargate task definition for shared and private sessions, 2 vCPU / 8 GB / 50 GB disk. Secrets come from Secrets Manager through the task definition, all but the Anthropic key, which only the console's proxy holds; a run passes only the per-session values, and the databases come from the session API. No task role, so session code has no AWS credentials. A second, `<prefix>-db-admin`, is the db-admin task, with a database in `databases`: the root passwords of those it runs through its execution role, and a task role that reads the database users' passwords and the seed's env files: the default project's repo settings (`<prefix>/repos/<project>/env/*`, the project its entryPoint's `--project` names) and no other repo's |
| Images | ECR `<prefix>-session` and `<prefix>-console`, built by the installation's deploy workflow ("The deploy workflow", above) through GitHub OIDC, from the default branch only. They build in separate jobs, and a console build restarts the console on the base box. The session image gets a SOCI index (`session/addSociIndex.sh`), so Fargate starts a session in seconds and fetches files as they are read instead of pulling the whole image first, and then the database template is built again from it |
| Budget | $150 a month for the whole account, alerts at 80% and 100% |
| DNS | Route 53 zone for `domain` (such as `woodshed.example.com`) with an A record for the Elastic IP. The parent domain's DNS, wherever it is, delegates the name with NS records holding the `dns_nameservers` output; until it does, nothing resolves it. A recreated zone (after a `destroy`, or a new `domain`) gets new nameservers, so those NS records must be changed to match. A CAA record lets only Let's Encrypt and ZeroSSL (Caddy's fallback) issue for the name |
| Webhooks | Lambda `<prefix>-webhooks` behind a public Function URL, queue `<prefix>-webhooks` with a dead-letter queue. The Lambda can only send to that queue and read `<prefix>/github-webhook-secret`; the base box role can only read and delete from it |

The base box's role can run tasks of those two task definitions, in that one
cluster, passing only their roles; stop and describe them; read
the GitHub App's key and the session logs; and pull the console image.
Nothing else in the account. IAM cannot pin the network a task runs in:
`RunTask` has no condition key for subnets or security groups. What keeps
sessions off other networks is that this account holds nothing but
Woodshed, so do not apply this into an account that has other workloads. Only the console and Caddy, on the
host's network, can reach the role: the IMDS hop limit is 1, so the containers
sessions talk to (Mongo and the shared services) cannot. The base box reads no
database password, and writes Mongo's root password once without being able to
read it back.

The image jobs' AWS role trusts the `<prefix>-images` GitHub
environment, not the branch: workflows triggered by issues and comments also
run as the default branch. Create that environment with deployment branches limited to
the default branch before the first run.

## Words used here

- **Base box:** the one always-on EC2 machine. It runs the console and the
  services sessions share.
- **Fargate:** AWS runs a container without a machine of our own; we pay per
  second while it runs.
- **Terraform state:** the record of what Terraform created, in the S3 bucket
  named in the installation's `backend.hcl`. Without it Terraform can no longer change
  or remove what it made.
- **GitHub OIDC:** how the deploy workflow gets short-lived AWS credentials
  without any AWS keys stored in GitHub.
