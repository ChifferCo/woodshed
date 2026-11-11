# The AWS provider

Woodshed on AWS: the console on one always-on EC2 machine (the base box), each session a Fargate task, and the
secrets, Claude homes, webhooks and databases in AWS services, all in an AWS account of its own. `index.mjs` is what
it hands the console; Terraform in `terraform/` builds the rest. An installation keeps its values for it in its
own repo, such as in `.woodshed/install/aws/`.

| Part | File | In AWS |
| --- | --- | --- |
| Session containers | `ecsLauncher.mjs` | Fargate tasks in the `woodshed-cloud` ECS cluster |
| Secrets | `secretStore.mjs` | Secrets Manager, under `woodshed-cloud/` |
| Saved Claude homes | `homeStore.mjs` | A private S3 bucket only the console's role reaches |
| Each session's own databases | `dbAdminRunner.mjs` | Those `databases` names: RDS Postgres, and the base box's Mongo, copied by a db-admin Fargate task. None of them, and no task, for `[]` |
| GitHub and Slack webhooks | `webhooks/` (a Lambda), `webhookQueue.mjs`, `webhookUrl.mjs` | A Lambda Function URL that checks each delivery and queues it in SQS, which the console long-polls |
| The machine | `terraform/` | The base box (EC2), its data disk, the network, DNS and the IAM roles |

The console picks this provider with `WOODSHED_PROVIDER=aws`, or `WOODSHED_CLOUD_LAUNCHER=ecs`. The base box sets
those and every other setting from Terraform's outputs, so there is nothing to set by hand; `console/README.md` lists
them. A setting only the local provider serves stops a console started here.

## Setting it up

`terraform plan` must only ever create resources the first time. If it wants to change or destroy anything, stop.
Keep the account for Woodshed alone: "How it is built", below, says why.

1. Once, the state bucket (versioned, private). Its name is yours to pick, such as
   `woodshed-cloud-tfstate-<account id>`:

   ```bash
   bucket=<your state bucket>
   aws s3api create-bucket --bucket "$bucket" --region us-east-1
   aws s3api put-bucket-versioning --bucket "$bucket" --versioning-configuration Status=Enabled
   aws s3api put-public-access-block --bucket "$bucket" \
     --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
   ```

2. The installation's `terraform.tfvars`: its values for the code in `providers/aws/terraform/`, none of them
   secret: the console's domain, the repository, the budget email, the GitHub App's IDs, the `databases` engines it hosts, and with
   Postgres the name and master user RDS starts with (nothing else uses them, and a change replaces RDS). The code has no default
   for the ones that name an installation, so each installation writes its own, from
   `providers/aws/terraform/example.tfvars`, and keeps it in its own repo. Its `backend.hcl` names where the state
   lives (`example.backend.hcl`). Check both in, such as at `.woodshed/install/aws/`.

   The App comes first: in the org's settings, Developer settings, GitHub Apps,
   create one with the webhook off and repository permissions Contents, Issues
   and Pull requests and Actions (read and write), and Metadata, Checks and
   Commit statuses (read), installable only on
   this account. Install it on this repo only. The App ID is on its settings
   page; the installation ID ends the installation page's URL.

3. From `providers/aws/terraform/`: `terraform init -backend-config=<your backend.hcl>`, then
   `terraform plan -var-file=<your terraform.tfvars> -out=woodshed.tfplan`, read it, and
   `terraform apply woodshed.tfplan`. With them at `.woodshed/install/aws/`, those are
   `../../../../.woodshed/install/aws/backend.hcl` and `../../../../.woodshed/install/aws/terraform.tfvars`, and the
   infra workflow runs the same.
4. Create the `woodshed-cloud-images` GitHub environment with deployment
   branches limited to the default branch. Set the repository variables
   `WOODSHED_CLOUD_AWS_ROLE_ARN` (the `github_images_role_arn` output) and
   `WOODSHED_CLOUD_BASE_BOX_ID` (the `base_box_instance_id` output), plus
   `WOODSHED_CLOUD_AWS_REGION` if not us-east-1.

   For infrastructure changes, and before the apply that makes their roles
   (a workflow naming an environment that does not exist creates it, with no
   reviewers), create `woodshed-cloud-plan` (deployment
   branches limited to the default branch) and `woodshed-cloud-infra` (the default branch only, with
   required reviewers, and administrators may not bypass them; the merger may
   approve their own deploy). Set
   `WOODSHED_CLOUD_PLAN_ROLE_ARN` and `WOODSHED_CLOUD_INFRA_ROLE_ARN` to the
   `github_plan_role_arn` and `github_infra_role_arn` outputs.
5. Run the "Woodshed Cloud images" workflow with `both`. The console job ends
   by starting the stack on the base box over SSM. Its first start at boot
   fails until the console image exists, and this is what starts it.
6. Open `https://<domain>` once its NS records are in place (`dig <domain>`
   answers the Elastic IP). Before that, `https://<Elastic IP>` works with Caddy's own
   certificate: accept the browser's warning for that one address. Do not
   install Caddy's root certificate: it is not limited to this site, and its key
   lives on the base box.
7. On the Secrets & webhooks tab, set the four session secrets (a session will
   not start until all have a value) and upload the GitHub App's key: generate
   one on the App's settings page, upload it, then delete the `.pem`.
8. With a database in `databases`, build the database template once with the `db_template_command` output:
   step 5's session build tried, before the secrets were set. Every session's
   databases are copied from it, so a session started before it waits five
   minutes for one, then fails. After this, each session build makes it again.
9. Webhooks: on the same tab, **Set up webhook** and follow its three steps.
   The console finds the queue by name, so nothing restarts.

## Using it day to day

| What | How | Running sessions |
| --- | --- | --- |
| The console | Run "Woodshed Cloud images" with `console` | Carry on; the console restarts and picks them back up. Open terminals need a reload |
| The session image | Run it with `session`, or wait: it is also rebuilt from the default branch every morning at 07:00 UTC | Keep their image; only new sessions get the new one |
| Infrastructure | Merge: "Woodshed Cloud infra" plans it and applies once a reviewer approves ("Changing the infrastructure", below) | Depends on the change; the plan says. Replacing the base box restarts Mongo |

What survives a restart or a resized or replaced base box: Mongo, the console's
list of sessions and Caddy's certificate, all on the data disk. What does not:
what a shared service keeps in its container, such as files in a fake S3, which has no volume.

### Changing the infrastructure

Merge. The "Woodshed Cloud infra"
workflow runs when a change under `providers/aws/terraform/`, `providers/aws/webhooks/` or the installation's values in
`.woodshed/install/aws/` reaches the default branch
(or by hand, to catch drift), puts the plan in its run summary with anything
it destroys or replaces listed first, and waits for a reviewer on the
`woodshed-cloud-infra` environment. Approving applies that saved plan and
nothing else; Terraform refuses it if the state changed since, and then a
re-run plans again. Rejecting leaves AWS as it was, behind the default branch, until the
next run. The plan role reads everything in the account except object
contents and log events (people's Claude homes, the session logs), and takes
the state lock. The infra role is an administrator of the account, which is
why its environment needs a reviewer, and why that environment must never be
given to a Claude workflow.

Updating the console: run the workflow with `console`. After the push it runs
the `woodshed-cloud-redeploy-console` SSM document on the base box, which pulls
the new image and recreates only the console container. Running sessions carry
on; open terminal tabs need a reload. The GitHub role can run that one
document on that one instance and nothing else.

Changing the base box's stack (`baseBoxStack.sh.tftpl`: the compose file,
the Caddyfile, the helper scripts and units): `terraform apply` is all it
takes. The stack is an SSM document, `woodshed-cloud-configure-base-box`, and
an association of the same name runs it on the box whenever it changes. It
applies the new config with the images already there (`woodshed-cloud-up
--no-pull`), so it never deploys a console image by the way. The run is
asynchronous: check it after the apply with

```bash
aws ssm describe-association-executions --association-id "$(aws ssm list-associations \
  --association-filter-list key=AssociationName,value=woodshed-cloud-configure-base-box \
  --query 'Associations[0].AssociationId' --output text)" --max-results 1
```

Adding a repo sessions start on: an admin can do it on the console's Console settings page (Repos), once the GitHub App is
installed on the repo, with no apply. To keep it in the installation's configuration instead, add it to `projects` in the installation's tfvars (`example.tfvars` shows the
shape), with the current repo as the default, and install the GitHub App on it. The plan changes only the
`woodshed-cloud-configure-base-box` document and its association: the console gets `WOODSHED_CLOUD_PROJECTS` and
restarts, and its sessions carry on. Every project uses the one session image, task definition and databases for now.
With `projects` empty, the default, the compose file has no such line.

Terraform ignores changes to `baseBox.sh.tftpl` (first boot only), so an apply
never replaces the box by surprise. `terraform apply -replace=aws_instance.base_box`
does: the new box mounts the same data volume, so Mongo and the console's
sessions survive, and the association sets up its stack.

## Costs

- **Idle:** about $55 a month. The base box is about $30, RDS about $14, the
  disks about $4, the Elastic IP $3.60, the secrets $2 and the DNS zone $0.50.
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
`woodshed-cloud*` and tagged `project = woodshed-cloud`. Keep it in an account
that holds nothing else: the security below relies on that.

| Piece | What |
| --- | --- |
| Network | Its own VPC, two public subnets, no NAT. Security groups: 443 to the base box from anywhere, and 80, which only redirects to HTTPS; Mongo (with `mongo` in `databases`) and each of `shared_services` from sessions only; ttyd and statusd on sessions from the base box only; Postgres from both (with `postgres`) |
| RDS | With `postgres` in `databases`: Postgres 16 `db.t4g.micro`, 20 GB, backups off. RDS keeps the master (root) password in its own Secrets Manager secret, which only the db-admin task reads |
| Base box | EC2 `t3.medium` (x86, like the session image) with an Elastic IP, SSM and no SSH. `baseBox.sh.tftpl` (first boot) installs Docker and mounts the data volume; `baseBoxStack.sh.tftpl`, applied by an SSM association, runs Mongo (with `mongo` in `databases`), the installation's `shared_services`, the console and Caddy from `/opt/woodshed-cloud/compose.yml`, each service's `files` from `/opt/woodshed-cloud/services/`. Caddy is built on the box with the Route 53 DNS provider: it gets `domain`'s Let's Encrypt certificate through a TXT record in the zone, so Let's Encrypt never connects to the box. The bare IP keeps `tls internal` |
| Data volume | A 20 GB EBS volume at `/var/lib/woodshed-cloud` holding Mongo, the console's session list and Caddy's certificate, so they survive restarts, resizes (`base_box_instance_type`) and a replaced box. `terraform destroy` removes it with the rest. Localstack's S3 files are not kept: the free edition has no persistence |
| Sessions | ECS cluster and one Fargate task definition for shared and private sessions, 2 vCPU / 8 GB / 50 GB disk. Secrets come from Secrets Manager through the task definition, all but the Anthropic key, which only the console's proxy holds; a run passes only the per-session values, and the databases come from the session API. No task role, so session code has no AWS credentials. A second, `woodshed-cloud-db-admin`, is the db-admin task, with a database in `databases`: the root passwords of those it runs through its execution role, and a task role that reads the database users' passwords |
| Images | ECR `woodshed-cloud-session` and `woodshed-cloud-console`, built with `.github/workflows/woodshed-cloud-image.yml`, by hand or (the session image alone) every morning, through GitHub OIDC (the default branch only). Pick `console`, `session` or `both`: they build in separate jobs, and a console build restarts the console on the base box. The session image gets a SOCI index (`session/addSociIndex.sh`), so Fargate starts a session in seconds and fetches files as they are read instead of pulling the whole image first, and then the database template is built again from it |
| Budget | $150 a month for the whole account, alerts at 80% and 100% |
| DNS | Route 53 zone for `domain` (such as `woodshed.example.com`) with an A record for the Elastic IP. The parent domain's DNS, wherever it is, delegates the name with NS records holding the `dns_nameservers` output; until it does, nothing resolves it. A recreated zone (after a `destroy`, or a new `domain`) gets new nameservers, so those NS records must be changed to match. A CAA record lets only Let's Encrypt and ZeroSSL (Caddy's fallback) issue for the name |
| Webhooks | Lambda `woodshed-cloud-webhooks` behind a public Function URL, queue `woodshed-cloud-webhooks` with a dead-letter queue. The Lambda can only send to that queue and read `woodshed-cloud/github-webhook-secret`; the base box role can only read and delete from it |

The base box's role can run tasks of those two task definitions, in that one
cluster, passing only their roles; stop and describe them; read
the GitHub App's key and the session logs; and pull the console image.
Nothing else in the account. IAM cannot pin the network a task runs in:
`RunTask` has no condition key for subnets or security groups. What keeps
sessions off other networks is that this account holds nothing but Woodshed
Cloud, so do not apply this into an account that has other workloads. Only the console and Caddy, on the
host's network, can reach the role: the IMDS hop limit is 1, so the containers
sessions talk to (Mongo and the shared services) cannot. The base box reads no
database password, and writes Mongo's root password once without being able to
read it back.

The image workflow's AWS role trusts the `woodshed-cloud-images` GitHub
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
- **GitHub OIDC:** how the image workflow gets short-lived AWS credentials
  without any AWS keys stored in GitHub.
