# Sessions: one Fargate task each, from one task definition. The console on the
# base box runs and stops them; nothing else can.

resource "aws_ecr_repository" "images" {
  for_each = toset(["session", "console"])

  name                 = "woodshed-cloud-${each.key}"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
}

resource "aws_ecr_lifecycle_policy" "images" {
  for_each = aws_ecr_repository.images

  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 5 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 5 }
      action       = { type = "expire" }
    }]
  })
}

resource "aws_ecs_cluster" "main" {
  name = "woodshed-cloud"
}

resource "aws_cloudwatch_log_group" "sessions" {
  name              = "/woodshed-cloud/sessions"
  retention_in_days = 14
}

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Pulls the image, writes logs and reads the secrets at start. There is no task
# role at all, so code running in a session has no AWS credentials.
resource "aws_iam_role" "session_execution" {
  name               = "woodshed-cloud-session-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "session_execution" {
  role       = aws_iam_role.session_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "session_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [for k, s in aws_secretsmanager_secret.session : s.arn if k != "anthropic_api_key"]
  }
}

resource "aws_iam_role_policy" "session_secrets" {
  name   = "read-session-secrets"
  role   = aws_iam_role.session_execution.id
  policy = data.aws_iam_policy_document.session_secrets.json
}

locals {
  # Each engine's server only when the installation hosts it, in the names its engine reads (shared/databases/): a
  # session given none asks the console for none.
  session_services = merge(
    local.postgres ? {
      PGHOST = aws_db_instance.postgres[0].address
      PGPORT = "5432"
      # RDS Postgres 16 refuses unencrypted connections, and an app's development config may set no SSL;
      # node-postgres falls back to this. The server is verified against the RDS CA bundle the image adds, through
      # NODE_EXTRA_CA_CERTS for Node and PGSSLROOTCERT for libpq (session/Dockerfile).
      PGSSLMODE     = "verify-full"
      PGSSLROOTCERT = "/etc/ssl/certs/rds-global-bundle.pem"
    } : {},
    # Mongo's URI is made from this and the session's database user (shared/databases/mongo.mjs).
    local.mongo ? { WOODSHED_MONGO_HOST = "${local.base_box_private_ip}:27017" } : {},
    # A session holds no long-lived GitHub token: it fetches hour-long ones from the console.
    { WOODSHED_CONSOLE_URL = "http://${local.base_box_private_ip}:7691" },
  )
  # The installation's shared services, each in its own variable, and the list of those variables, which the
  # entrypoint requires when the project uses them and the db-admin task passes to the seed.
  shared_service_urls = { for name, s in var.shared_services : s.variable => "http://${local.base_box_private_ip}:${s.port}" }
  shared_service_env  = merge(local.shared_service_urls, { WOODSHED_SERVICES = join(" ", sort(keys(local.shared_service_urls))) })
  # The install secrets' variables, which an ask session unsets (runAsk in session/entrypoint.sh).
  install_secret_env = { WOODSHED_INSTALL_SECRETS = join(" ", sort(values(var.install_secrets))) }
  # No Anthropic key: a session reaches Anthropic through the console's proxy, which adds it (console/anthropicProxy.mjs).
  # A task secret is in the environment of the container's PID 1 for the whole session, where its terminal reads it.
  session_secrets = merge(
    { for name, key in local.env_file_keys : upper(key) => aws_secretsmanager_secret.session[key].arn },
    # Each under the variable the installation names for it: the entrypoint renames nothing.
    { for env_name, key in local.install_secret_keys : env_name => aws_secretsmanager_secret.session[key].arn },
  )
  # A session holds no database user or password from here: its entrypoint asks the console's session API for the
  # databases the console made for it, a shared session's own or a private session's owner's.
  session_container = {
    name      = "session"
    image     = "${aws_ecr_repository.images["session"].repository_url}:latest"
    essential = true
    command   = ["session"]
    # statusd is the entrypoint's last exec and never reaps the children claude leaves, so a long session piled up
    # dead processes. ECS's init (tini) runs as PID 1 instead, reaps them and passes the stop signal on to statusd.
    linuxParameters = { initProcessEnabled = true }
    portMappings = [
      { containerPort = 7681, protocol = "tcp" },
      { containerPort = 7682, protocol = "tcp" },
      { containerPort = 7684, protocol = "tcp" },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.sessions.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "session"
      }
    }
  }
}

resource "aws_ecs_task_definition" "session" {
  family                   = "woodshed-cloud-session"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 2048
  memory                   = 8192
  execution_role_arn       = aws_iam_role.session_execution.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  # The image alone is about 8 GB, and node_modules and .next grow inside it.
  ephemeral_storage {
    size_in_gib = 50
  }

  container_definitions = jsonencode([merge(local.session_container, {
    environment = [for k, v in merge(local.session_services, local.shared_service_env, local.install_secret_env) : { name = k, value = v }]
    secrets     = [for k, v in local.session_secrets : { name = k, valueFrom = v }]
  })])
}

# The db-admin task (session/dbAdmin.mjs): the only thing that reads the databases' root passwords. It builds the
# database template from master, and makes every other database user and database as a copy of it. The console runs
# it for each person's databases and each shared session's; the deploy workflow's session job builds the template through the
# base box (github.tf), or the db_template_command output does. All of it exists only with a database in var.databases.
locals {
  # Each database's host, as dbAdmin.mjs's flags: a database the installation does not run has none.
  db_admin_hosts = concat(
    flatten([for db in aws_db_instance.postgres : [
      "--pg-host", db.address, "--pg-root-user", db.username, "--pg-ca", "/etc/ssl/certs/rds-global-bundle.pem",
    ]]),
    local.mongo ? ["--mongo-host", "${local.base_box_private_ip}:27017"] : [],
  )
}

resource "aws_iam_role" "db_admin_execution" {
  count = local.db_admin ? 1 : 0

  name               = "woodshed-cloud-db-admin-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "db_admin_execution" {
  count = local.db_admin ? 1 : 0

  role       = aws_iam_role.db_admin_execution[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "db_admin_execution" {
  count = local.db_admin ? 1 : 0

  statement {
    sid     = "TheRootPasswords"
    actions = ["secretsmanager:GetSecretValue"]
    resources = concat(
      [for db in aws_db_instance.postgres : db.master_user_secret[0].secret_arn],
      [for s in aws_secretsmanager_secret.mongo_root : s.arn],
      # Seeding writes the env files the seed reads (database_env_secrets), as a session does.
      [for name in var.database_env_secrets : aws_secretsmanager_secret.session[local.env_file_keys[name]].arn],
    )
  }
}

resource "aws_iam_role_policy" "db_admin_execution" {
  count = local.db_admin ? 1 : 0

  name   = "read-root-passwords"
  role   = aws_iam_role.db_admin_execution[0].id
  policy = data.aws_iam_policy_document.db_admin_execution[0].json
}

# What the task's own code may do: read each database user's password, and the base env files for the seed.
resource "aws_iam_role" "db_admin_task" {
  count = local.db_admin ? 1 : 0

  name               = "woodshed-cloud-db-admin"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "db_admin_task" {
  count = local.db_admin ? 1 : 0

  statement {
    sid     = "DatabasePasswords"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      "arn:aws:secretsmanager:${var.region}:${local.account_id}:secret:woodshed-cloud/users/*/database-??????",
      "arn:aws:secretsmanager:${var.region}:${local.account_id}:secret:woodshed-cloud/sessions/*/database-??????",
    ]
  }

  # Read here, not given as a task secret: a run's overrides could replace a variable, but not this.
  statement {
    sid       = "TheSeedsEnvFiles"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [for name in var.database_env_secrets : aws_secretsmanager_secret.session[local.env_file_keys[name]].arn]
  }
}

resource "aws_iam_role_policy" "db_admin_task" {
  count = local.db_admin ? 1 : 0

  name   = "database-passwords"
  role   = aws_iam_role.db_admin_task[0].id
  policy = data.aws_iam_policy_document.db_admin_task[0].json
}

resource "aws_ecs_task_definition" "db_admin" {
  count = local.db_admin ? 1 : 0

  family                   = "woodshed-cloud-db-admin"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 2048
  memory                   = 8192
  execution_role_arn       = aws_iam_role.db_admin_execution[0].arn
  task_role_arn            = aws_iam_role.db_admin_task[0].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  ephemeral_storage {
    size_in_gib = 50
  }

  container_definitions = jsonencode([{
    name      = "db-admin"
    image     = "${aws_ecr_repository.images["session"].repository_url}:latest"
    essential = true
    # A run may override the command and the environment, never this: the hosts the root passwords go to are fixed
    # here, and a run adds only `setup`, `reset <owner>` or `drop <login>` after the `--`. env drops what Node or the
    # loader would act on before dbAdmin.mjs runs, and dbAdmin.mjs then refuses any variable it does not expect.
    # The hosts and the secrets keep the order they had when both databases were always there, so an installation
    # with both gets no new revision from this.
    entryPoint = concat(
      [
        "env", "-u", "NODE_OPTIONS", "-u", "NODE_TLS_REJECT_UNAUTHORIZED", "-u", "LD_PRELOAD", "-u", "LD_LIBRARY_PATH", "-u", "OPENSSL_CONF",
        "node", "/opt/woodshed/session/dbAdmin.mjs",
        "--region", var.region,
      ],
      local.db_admin_hosts,
      [
        "--secret-prefix", "woodshed-cloud/",
        "--repo", "/work/${split("/", var.github_repo)[1]}",
        "--",
      ],
    )
    environment = [for k, v in local.shared_service_env : { name = k, value = v }]
    secrets = concat(
      [for db in aws_db_instance.postgres : { name = "PG_ROOT_PASSWORD", valueFrom = "${db.master_user_secret[0].secret_arn}:password::" }],
      [for s in aws_secretsmanager_secret.mongo_root : { name = "MONGO_ROOT_PASSWORD", valueFrom = s.arn }],
    )
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.sessions.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "db-admin"
      }
    }
  }])
}

# The addresses from before the databases were optional, so an installation from then keeps its db-admin task.
moved {
  from = aws_iam_role.db_admin_execution
  to   = aws_iam_role.db_admin_execution[0]
}

moved {
  from = aws_iam_role_policy_attachment.db_admin_execution
  to   = aws_iam_role_policy_attachment.db_admin_execution[0]
}

moved {
  from = aws_iam_role_policy.db_admin_execution
  to   = aws_iam_role_policy.db_admin_execution[0]
}

moved {
  from = aws_iam_role.db_admin_task
  to   = aws_iam_role.db_admin_task[0]
}

moved {
  from = aws_iam_role_policy.db_admin_task
  to   = aws_iam_role_policy.db_admin_task[0]
}

moved {
  from = aws_ecs_task_definition.db_admin
  to   = aws_ecs_task_definition.db_admin[0]
}
