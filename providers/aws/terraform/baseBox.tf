# The always-on box: the console behind Caddy, plus Mongo (with mongo in var.databases) and the installation's
# shared services (var.shared_services) for every session. No SSH; a shell is `aws ssm start-session`.

data "aws_caller_identity" "current" {}

data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "base_box" {
  name               = "${local.p}-base-box"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "base_box_ssm" {
  role       = aws_iam_role.base_box.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

locals {
  account_id = data.aws_caller_identity.current.account_id
  # The console may act only on tasks of this one cluster, from these task definitions.
  task_arns = "arn:aws:ecs:${var.region}:${local.account_id}:task/${aws_ecs_cluster.main.name}/*"
  console_task_families = concat([aws_ecs_task_definition.session.family], aws_ecs_task_definition.db_admin[*].family)
}

data "aws_iam_policy_document" "base_box" {
  statement {
    sid       = "RunSessions"
    actions   = ["ecs:RunTask"]
    resources = [for f in local.console_task_families : "arn:aws:ecs:${var.region}:${local.account_id}:task-definition/${f}:*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.main.arn]
    }
    # RunTask supports no condition key for subnets or security groups, so IAM cannot pin a task's
    # network. The account holding nothing but Woodshed is what keeps sessions off other networks.
    # Running the db-admin task gives the console no root password: a run can change its command and environment,
    # and dbAdmin.mjs takes neither a host nor any code from them (ecs.tf).
  }

  # Caddy's certificate for var.domain: the DNS challenge writes and removes one TXT record in that zone. With no domain
  # there is no zone, and Caddy proves each name over HTTPS instead, so the box gets no Route 53 access at all.
  dynamic "statement" {
    for_each = aws_route53_zone.console
    content {
      sid       = "AnswerTheCertificateChallenge"
      actions   = ["route53:ChangeResourceRecordSets"]
      resources = [statement.value.arn]
      condition {
        test     = "ForAllValues:StringEquals"
        variable = "route53:ChangeResourceRecordSetsRecordTypes"
        values   = ["TXT"]
      }
      condition {
        test     = "ForAllValues:StringEquals"
        variable = "route53:ChangeResourceRecordSetsNormalizedRecordNames"
        values   = ["_acme-challenge.${var.domain}"]
      }
    }
  }

  dynamic "statement" {
    for_each = aws_route53_zone.console
    content {
      sid       = "ReadTheConsoleZone"
      actions   = ["route53:ListResourceRecordSets"]
      resources = [statement.value.arn]
    }
  }

  # Route 53 gives these no resource-level permissions. Caddy finds the zone by name and waits on its change.
  dynamic "statement" {
    for_each = aws_route53_zone.console
    content {
      sid       = "FindTheConsoleZone"
      actions   = ["route53:ListHostedZonesByName", "route53:ListHostedZones", "route53:GetChange"]
      resources = ["*"]
    }
  }

  # run-task's --propagate-tags copies the task definition's tags onto the task, which needs TagResource.
  statement {
    sid       = "TagSessionsAsTheyStart"
    actions   = ["ecs:TagResource"]
    resources = [local.task_arns]
    condition {
      test     = "StringEquals"
      variable = "ecs:CreateAction"
      values   = ["RunTask"]
    }
  }

  statement {
    sid       = "FindSessions"
    actions   = ["ecs:ListTasks"]
    resources = ["*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.main.arn]
    }
  }

  statement {
    sid       = "WatchAndStopSessions"
    actions   = ["ecs:DescribeTasks", "ecs:StopTask"]
    resources = [local.task_arns]
  }

  statement {
    sid       = "PassTheExecutionRole"
    actions   = ["iam:PassRole"]
    resources = concat([aws_iam_role.session_execution.arn], aws_iam_role.db_admin_execution[*].arn, aws_iam_role.db_admin_task[*].arn)
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }

  statement {
    sid       = "ReadSessionLogs"
    actions   = ["logs:GetLogEvents", "logs:FilterLogEvents"]
    resources = ["${aws_cloudwatch_log_group.sessions.arn}:*"]
  }

  # The Secrets page: these secrets and no others. Reading a session secret gives the console nothing a session
  # terminal does not; the App key and the webhook secret are the console's own.
  statement {
    sid     = "ConsoleSecrets"
    actions = ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"]
    resources = concat(
      [for s in aws_secretsmanager_secret.session : s.arn],
      [
        aws_secretsmanager_secret.github_app_key.arn, aws_secretsmanager_secret.github_webhook.arn,
        aws_secretsmanager_secret.github_app_client_secret.arn, aws_secretsmanager_secret.slack_bot_token.arn,
        aws_secretsmanager_secret.slack_signing.arn,
      ],
    )
  }

  # My settings: each person's own secrets, which the console makes, reads and deletes itself
  # (console/userSettings.mjs). Only a private session of the same person is ever handed one. And each shared
  # session's database password (console/databases.mjs), handed to that session alone and deleted with its databases.
  statement {
    sid = "PeoplesAndSessionsOwnSecrets"
    actions = [
      "secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret", "secretsmanager:DeleteSecret", "secretsmanager:TagResource",
    ]
    resources = [
      "arn:aws:secretsmanager:${var.region}:${local.account_id}:secret:${local.p}/users/*",
      "arn:aws:secretsmanager:${var.region}:${local.account_id}:secret:${local.p}/sessions/*",
    ]
  }

  # Each person's saved Claude home (providers/aws/homeStore.mjs): read, written and deleted by login, or by `_sessions/<id>` for a
  # shared session's.
  statement {
    sid       = "PeoplesClaudeHomes"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"]
    resources = ["${aws_s3_bucket.homes.arn}/*"]
  }

  # Without it, S3 answers a home nobody saved yet with 403 rather than 404. The Console settings page also lists the
  # shared sessions' homes with it, to find one left behind.
  statement {
    sid       = "TellAMissingHome"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.homes.arn]
  }

  # The page's one list call (providers/aws/secretStore.mjs). ListSecrets has no resource-level permissions, so this is every
  # secret's name and dates, never a value: the account holds nothing but Woodshed.
  statement {
    sid       = "ListTheSecrets"
    actions   = ["secretsmanager:ListSecrets"]
    resources = ["*"]
  }

  # Mongo's root user is made on the box, once (<name_prefix>-mongo-root); its password is written here, never read.
  dynamic "statement" {
    for_each = aws_secretsmanager_secret.mongo_root
    content {
      sid       = "SaveMongosRootPassword"
      actions   = ["secretsmanager:PutSecretValue"]
      resources = [statement.value.arn]
    }
  }

  statement {
    sid       = "FindTheWebhookUrl"
    actions   = ["lambda:GetFunctionUrlConfig"]
    resources = [aws_lambda_function.webhooks.arn]
  }

  statement {
    sid = "ReadGitHubWebhooks"
    actions = [
      "sqs:GetQueueUrl", "sqs:GetQueueAttributes", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility",
    ]
    resources = [aws_sqs_queue.webhooks.arn]
  }

  statement {
    sid       = "PullTheConsoleImage"
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
    resources = [aws_ecr_repository.images["console"].arn]
  }

  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "base_box" {
  name   = "${local.p}-console"
  role   = aws_iam_role.base_box.id
  policy = data.aws_iam_policy_document.base_box.json
}

resource "aws_iam_instance_profile" "base_box" {
  name = "${local.p}-base-box"
  role = aws_iam_role.base_box.name
}

# Allocated before the instance, because the console's own URL is its address.
resource "aws_eip" "base_box" {
  domain = "vpc"

  tags = { Name = "${local.p}-console" }
}

# The box's size from what it runs (baseBoxStack.sh.tftpl's mem_limits): the console's 512 MB and Caddy's 128 MB fit
# 2 GB with the OS, Docker and Caddy's build on the box; Mongo's 1 GB or a shared service's 768 MB does not.
locals {
  base_box_needs_4gb      = local.mongo || length(var.shared_services) > 0
  base_box_instance_type  = coalesce(var.base_box_instance_type, local.base_box_needs_4gb ? "t3.medium" : "t3.small")
  base_box_min_memory_mib = local.base_box_needs_4gb ? 4096 : 2048
}

data "aws_ec2_instance_type" "base_box" {
  instance_type = local.base_box_instance_type
}

resource "aws_instance" "base_box" {
  ami                    = data.aws_ssm_parameter.al2023.value
  instance_type          = local.base_box_instance_type
  subnet_id              = aws_subnet.public[0].id
  private_ip             = local.base_box_private_ip
  vpc_security_group_ids = [aws_security_group.base_box.id]
  iam_instance_profile   = aws_iam_instance_profile.base_box.name

  root_block_device {
    volume_size = 30
    volume_type = "gp3"
    encrypted   = true
  }

  # Hop limit 1: only the host's own network, where the console runs, reaches the instance role.
  # The bridged containers sessions can talk to cannot.
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  user_data = templatefile("${path.module}/baseBox.sh.tftpl", { data_volume_id = aws_ebs_volume.data.id, name_prefix = local.p })

  # A new AMI or a changed first boot must not replace the box on the next apply. What runs on the box
  # comes from the configure_base_box association below, which a change reaches without a replacement.
  lifecycle {
    ignore_changes = [ami, user_data]

    precondition {
      condition     = contains(data.aws_ec2_instance_type.base_box.supported_architectures, "x86_64")
      error_message = "base_box_instance_type must be x86, like the console and session images (not Graviton)."
    }
    precondition {
      condition     = data.aws_ec2_instance_type.base_box.memory_size >= local.base_box_min_memory_mib
      error_message = "base_box_instance_type has too little memory for what the box runs: ${local.base_box_needs_4gb ? "Mongo or a shared service needs 4 GB (t3.medium)" : "the console and Caddy need 2 GB (t3.small)"}."
    }
  }

  tags = { Name = "${local.p}-base-box" }
}

# What the installation does not run (var.databases) reaches the stack script as "" or false, and the script leaves
# its service and settings out.
locals {
  # The console's WOODSHED_PROJECTS (console/projects.mjs), with installationId only where a project names one,
  # since the console refuses a null. "" with no projects leaves the variable out of compose.yml.
  projects_json = length(var.projects) == 0 ? "" : "[${join(",", [for p in var.projects : p.installation_id == null
    ? jsonencode({ name = p.name, repo = p.repo, default = p.default })
  : jsonencode({ name = p.name, repo = p.repo, default = p.default, installationId = p.installation_id })])}]"

  base_box_stack = templatefile("${path.module}/baseBoxStack.sh.tftpl", {
    name_prefix        = local.p
    region             = var.region
    public_ip          = aws_eip.base_box.public_ip
    domain             = local.console_domain
    own_domain         = local.own_domain
    private_ip         = local.base_box_private_ip
    console_image      = "${aws_ecr_repository.images["console"].repository_url}:latest"
    registry           = split("/", aws_ecr_repository.images["console"].repository_url)[0]
    github_app_id      = var.github_app_id
    github_app_install = var.github_app_installation_id
    repo               = var.sessions_on_github_repo ? var.github_repo : ""
    projects           = local.projects_json
    services           = var.shared_services
    env_files          = join(",", [for name, path in var.env_files : "${name}=${path}"])
    db_env_secrets     = join(",", var.database_env_secrets)
    install_secrets    = join(",", [for name, env_name in var.install_secrets : "${name}=${env_name}"])
    max_sessions       = var.max_sessions
    console_name       = var.console_name
    workflow_links     = join(",", [for label, file in var.console_workflow_links : "${label}=${file}"])
    homes_bucket       = aws_s3_bucket.homes.bucket
    cluster            = aws_ecs_cluster.main.name
    task_definition    = aws_ecs_task_definition.session.family
    databases          = join(",", var.databases)
    db_admin_task      = join("", aws_ecs_task_definition.db_admin[*].family)
    db_host            = join("", aws_db_instance.postgres[*].address)
    mongo              = local.mongo
    mongo_root_secret  = join("", aws_secretsmanager_secret.mongo_root[*].arn)
    subnets            = join(",", aws_subnet.public[*].id)
    session_sg         = aws_security_group.sessions.id
    log_group          = aws_cloudwatch_log_group.sessions.name
    webhook_queue      = aws_sqs_queue.webhooks.name
    webhook_function   = aws_lambda_function.webhooks.function_name
  })
}

# The base box's stack as an SSM document. The script travels base64-encoded, so none of its quoting
# meets SSM's parameter handling.
resource "aws_ssm_document" "configure_base_box" {
  name            = "${local.p}-configure-base-box"
  document_type   = "Command"
  document_format = "JSON"
  content = jsonencode({
    schemaVersion = "2.2"
    description   = "Write the Woodshed base box's stack config and (re)start the stack"
    mainSteps = [{
      action = "aws:runShellScript"
      name   = "configureBaseBox"
      inputs = {
        timeoutSeconds = "1800"
        runCommand = [
          "set -euo pipefail",
          "echo ${base64encode(local.base_box_stack)} | base64 -d > /root/${local.p}-stack.sh",
          "bash /root/${local.p}-stack.sh",
        ]
      }
    }]
  })
}

# Runs the document on the box when it is created, and again whenever the document changes: pinning
# the version makes a new one an update to the association, which SSM applies at once.
resource "aws_ssm_association" "configure_base_box" {
  name             = aws_ssm_document.configure_base_box.name
  association_name = "${local.p}-configure-base-box"
  document_version = aws_ssm_document.configure_base_box.latest_version

  targets {
    key    = "InstanceIds"
    values = [aws_instance.base_box.id]
  }

  # A new box's first run waits for its data volume, which is attached after the instance exists.
  depends_on = [aws_volume_attachment.data]
}

resource "aws_eip_association" "base_box" {
  instance_id   = aws_instance.base_box.id
  allocation_id = aws_eip.base_box.id
}

# Mongo, the console's session list and Caddy's certificate live here, not on
# the root disk, so they outlive the box: a replacement box mounts the same
# volume. Losing the console's state would leave running sessions the console
# can't stop, while Fargate keeps billing for them.
resource "aws_ebs_volume" "data" {
  availability_zone = aws_subnet.public[0].availability_zone
  size              = 20
  type              = "gp3"
  encrypted         = true

  tags = { Name = "${local.p}-data" }
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.base_box.id
  # Stops the old box before detaching on a replacement, so Mongo is never cut off mid-write.
  stop_instance_before_detaching = true
}
