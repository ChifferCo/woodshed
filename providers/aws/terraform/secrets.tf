# The secrets exist here; their values are set on the console's Secrets page,
# so they never pass through Terraform state or a command line. A session task
# will not start until every one has a value.

locals {
  # A secret's resource key is its name with dashes made underscores, and its name the other way round.
  env_file_keys = { for name, path in var.env_files : name => replace(name, "-", "_") }
  # Each install secret's variable and its resource key, keyed like the rest: a `registry-token` secret is
  # session["registry_token"], whatever variable it reaches sessions in.
  install_secret_keys = { for name, env_name in var.install_secrets : env_name => replace(name, "-", "_") }

  secrets = merge(
    { anthropic_api_key = "Dedicated Anthropic API key for sessions, with its own spend limit" },
    { for name, path in var.env_files : replace(name, "-", "_") => "The whole base ${path} for sessions; the shared services' addresses are appended to it" },
    { for name, env_name in var.install_secrets : replace(name, "-", "_") => "Read by the repo's dependency installs, in ${env_name}: when a session runs an install again, and in claude's terminal" },
  )
}

resource "aws_secretsmanager_secret" "session" {
  for_each = local.secrets

  name        = "${local.p}/${replace(each.key, "_", "-")}"
  description = each.value
  # Gone at once on destroy, so a later apply can create the same names again.
  recovery_window_in_days = 0
}

# Not in local.secrets: the session execution role reads every one of those, and this key must stay on the base
# box. Sessions get installation tokens from the console instead (console/sessionApi.mjs).
resource "aws_secretsmanager_secret" "github_app_key" {
  name                    = "${local.p}/github-app-key"
  description             = "The Woodshed GitHub App's private key (.pem). Only the console reads it, to mint installation tokens"
  recovery_window_in_days = 0
}

# Console only, like the App key: it signs people in, and sign-in stays off until it has a value.
resource "aws_secretsmanager_secret" "github_app_client_secret" {
  name                    = "${local.p}/github-app-client-secret"
  description             = "The Woodshed GitHub App's client secret. The console signs people in with GitHub through it"
  recovery_window_in_days = 0
}

# Console only: the bot that posts each pull request a session opens (console/slack.mjs).
resource "aws_secretsmanager_secret" "slack_bot_token" {
  name                    = "${local.p}/slack-bot-token"
  description             = "A Slack bot token (xoxb-...) with chat:write, reactions:write, users:read and users:read.email. The console posts each session's new pull request, and each answer to a question, with it"
  recovery_window_in_days = 0
}

# Mongo's root, made once on the base box (<name_prefix>-mongo-root in baseBoxStack.sh.tftpl), which may write it
# but never read it. Outside the console's <name_prefix>/ prefix, like RDS's own master secret: only the db-admin
# task's execution role reads either. Only with mongo in var.databases.
resource "aws_secretsmanager_secret" "mongo_root" {
  count = local.mongo ? 1 : 0

  name                    = "${local.p}-root/mongo"
  description             = "Mongo's root password. Only the db-admin task reads it"
  recovery_window_in_days = 0
}

moved {
  from = aws_secretsmanager_secret.mongo_root
  to   = aws_secretsmanager_secret.mongo_root[0]
}
