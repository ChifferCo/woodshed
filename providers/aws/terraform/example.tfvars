# An installation's values for this Terraform, passed with -var-file (providers/aws/README.md, "Setting it up"). Copy it into the
# installation's own repo, such as .woodshed/install/aws/terraform.tfvars, and fill it in: none of these is a secret, and
# those without a comment saying otherwise have no default.
github_repo  = "your-org/your-repo"
budget_email = "you@example.com"

# What every AWS resource, tag, secret and base box path is named after. woodshed for a new installation; one made
# before this setting existed keeps everything it has only with woodshed-cloud.
name_prefix = "woodshed"

# Optional. The console's name, with a Route 53 zone the parent domain must delegate. Left out, the console is
# woodshed.<its IP with dashes>.sslip.io, with nothing to set up in DNS.
# domain = "woodshed.example.com"

# Optional, true unless set. False when github_repo only deploys the installation: the console then starts with no repo,
# and an admin adds the repos sessions work on, on the Console settings page.
# sessions_on_github_repo = false

# The database engines the installation hosts, each on its own: "postgres" (RDS), "mongo" (on the base box), or [] for
# none, which leaves out RDS, Mongo and the db-admin task. Each of the project file's databases needs its engine here.
databases = ["postgres"]
# With postgres: the database RDS starts with and its master user. Nothing else uses them, and a change replaces RDS.
database_name = "yourapp"
database_user = "yourapp_user"
# The env files sessions write, as secret name = path in the repo (the project file's envFiles that have a `secret`),
# and which of them the databases' commands read (each database's envFiles; [], the default, with no databases).
env_files            = { "app-env" = "app/.env" }
database_env_secrets = ["app-env"]
# Optional: secrets the repo's dependency installs read, as secret name = the variable its tools read it from, such
# as a private package registry's token. {} (the default) for none.
# install_secrets = { "registry-token" = "REGISTRY_TOKEN" }
# Containers the base box runs for every session, each reaching it as a URL in its variable ({} for none), such as:
# shared_services = {
#   localstack = {
#     image       = "localstack/localstack:4.14.0"
#     port        = 4566
#     variable    = "S3_ENDPOINT"
#     environment = { SERVICES = "s3" }
#     files       = { "/etc/localstack/init/ready.d/buckets.sh" = "#!/bin/bash\nawslocal s3api create-bucket --bucket app-test\n" }
#   }
# }
shared_services = {}

# The GitHub App's ID (its settings page) and its installation's (the end of the installation page's URL).
github_app_id              = "0000000"
github_app_installation_id = "00000000"

# Optional: more repos sessions start on, each a project (console/README.md, WOODSHED_PROJECTS). The default
# project's repo is github_repo. installation_id only when the App is installed on that repo's account under another
# installation. Every project uses this installation's session image and databases for now. [] (the default) for
# github_repo alone.
# projects = [
#   { name = "app", repo = "your-org/your-repo", default = true },
#   { name = "tools", repo = "your-org/tools" },
# ]

# Optional: what the console calls itself, on its pages, the installed app and its GitHub comments. Default Woodshed.
# console_name = "Acme Woodshed"

# Optional: the console menu's links to the repo's workflows that build the images and apply this Terraform.
# console_workflow_links = {
#   "Build images"       = "woodshed-images.yml"
#   "Run infrastructure" = "woodshed-infra.yml"
# }
