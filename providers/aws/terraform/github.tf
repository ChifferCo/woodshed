# Lets the installation's deploy workflow (providers/aws/README.md, "The deploy workflow") push the two images to ECR,
# restart the console after a console build, and build the database template
# again after a session build, through GitHub OIDC, so no AWS keys are stored
# in GitHub. The trust names the
# image jobs' environment, not the branch: issue and comment workflows (a bot
# answering comments among them) also run as the default branch, and an image push runs code on the base box
# and in every session.

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "github_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:environment:woodshed-cloud-images"]
    }
  }
}

resource "aws_iam_role" "github_images" {
  name               = "woodshed-cloud-github-images"
  assume_role_policy = data.aws_iam_policy_document.github_assume.json
}

data "aws_iam_policy_document" "github_images" {
  statement {
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = [for r in aws_ecr_repository.images : r.arn]
  }

  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  # Only the two fixed documents, only on the base box: no arbitrary commands.
  statement {
    sid       = "RedeployTheConsole"
    actions   = ["ssm:SendCommand"]
    resources = concat([aws_ssm_document.redeploy_console.arn], aws_ssm_document.refresh_db_template[*].arn, [aws_instance.base_box.arn])
  }

  # Neither action supports resource-level permissions.
  statement {
    sid       = "WatchTheRedeploy"
    actions   = ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations"]
    resources = ["*"]
  }
}

# Pulls the newest console image and recreates only the console container.
# Sessions keep running; the console picks them back up from its state on start.
resource "aws_ssm_document" "redeploy_console" {
  name            = "woodshed-cloud-redeploy-console"
  document_type   = "Command"
  document_format = "JSON"
  content = jsonencode({
    schemaVersion = "2.2"
    description   = "Pull the newest Woodshed Cloud console image and restart only the console."
    mainSteps = [{
      action = "aws:runShellScript"
      name   = "redeployConsole"
      inputs = {
        timeoutSeconds = "600"
        runCommand = [
          "set -euo pipefail",
          "# The stack has never started (its first boot ran before the console image existed): start all of it.",
          "if [ -z \"$(docker compose -f /opt/woodshed-cloud/compose.yml ps --quiet console)\" ]; then exec /usr/local/bin/woodshed-cloud-up; fi",
          "aws ecr get-login-password --region ${var.region} | docker login --username AWS --password-stdin ${split("/", aws_ecr_repository.images["console"].repository_url)[0]}",
          "cd /opt/woodshed-cloud",
          "# Every build leaves the image before it behind: unused images filled the box's disk until a pull failed with",
          "# no space left on device. Running containers keep theirs; pruning first leaves room for the pull.",
          "docker image prune -af",
          "docker compose pull --quiet console",
          "docker compose up -d console",
          "docker image prune -af",
          "docker compose ps console",
          "df -h /",
        ]
      }
    }]
  })
}

# Runs the db-admin task's `template` from the base box, whose role may already run it, and waits for its exit code:
# every session's databases are then copied from the image just built. Sessions starting meanwhile copy the old
# template, or wait the moment it is swapped. Only with the db-admin task, which exists only with a database.
resource "aws_ssm_document" "refresh_db_template" {
  count = local.db_admin ? 1 : 0

  name            = "woodshed-cloud-refresh-db-template"
  document_type   = "Command"
  document_format = "JSON"
  content = jsonencode({
    schemaVersion = "2.2"
    description   = "Build the Woodshed Cloud database template again, from the newest session image."
    mainSteps = [{
      action = "aws:runShellScript"
      name   = "refreshDbTemplate"
      inputs = {
        timeoutSeconds = "1800"
        runCommand = [
          "set -euo pipefail",
          "task=$(${local.db_admin_run} --started-by db-admin-template --propagate-tags TASK_DEFINITION --overrides '{\"containerOverrides\":[{\"name\":\"db-admin\",\"command\":[\"template\"]}]}' --query 'tasks[0].taskArn' --output text)",
          "echo \"db-admin task $task\"",
          "for _ in $(seq 170); do",
          "  [ \"$(aws ecs describe-tasks --region ${var.region} --cluster ${aws_ecs_cluster.main.name} --tasks \"$task\" --query 'tasks[0].lastStatus' --output text)\" = STOPPED ] && break",
          "  sleep 10",
          "done",
          "code=$(aws ecs describe-tasks --region ${var.region} --cluster ${aws_ecs_cluster.main.name} --tasks \"$task\" --query \"tasks[0].containers[?name=='db-admin'].exitCode | [0]\" --output text)",
          "echo \"db-admin exited with $code; its log is in ${aws_cloudwatch_log_group.sessions.name}, stream db-admin/db-admin/$${task##*/}\"",
          "[ \"$code\" = 0 ]",
        ]
      }
    }]
  })
}

resource "aws_iam_role_policy" "github_images" {
  name   = "push-woodshed-cloud-images"
  role   = aws_iam_role.github_images.id
  policy = data.aws_iam_policy_document.github_images.json
}

moved {
  from = aws_ssm_document.refresh_db_template
  to   = aws_ssm_document.refresh_db_template[0]
}
