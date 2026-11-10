# GitHub webhooks. GitHub posts to a Lambda Function URL, which checks the
# signature and queues a small message; the console long-polls the queue. The
# console still takes no inbound connections, and the Function URL gives GitHub
# a valid certificate without a domain. The code is ../webhooks/index.mjs.

resource "aws_secretsmanager_secret" "github_webhook" {
  name        = "woodshed-cloud/github-webhook-secret"
  description = "The secret GitHub signs webhooks with; the console's Secrets page makes it and sets it on the GitHub App"
  # Gone at once on destroy, so a later apply can create the same name again.
  recovery_window_in_days = 0
}

# Slack signs its events with the app's signing secret; set on the console's Secrets page.
resource "aws_secretsmanager_secret" "slack_signing" {
  name                    = "woodshed-cloud/slack-signing-secret"
  description             = "The Slack app's signing secret. The webhooks Lambda checks each Slack event with it"
  recovery_window_in_days = 0
}

# A message the console fails on three times lands here, so one bad event never loops.
resource "aws_sqs_queue" "webhooks_dead" {
  name                      = "woodshed-cloud-webhooks-dead"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "webhooks" {
  name = "woodshed-cloud-webhooks"
  # A label older than a day is stale; the fallback poll would have started it long before.
  message_retention_seconds = 86400
  # Longer than starting a session takes, so a message is not handed out twice while it is handled.
  visibility_timeout_seconds = 120
  receive_wait_time_seconds  = 20
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.webhooks_dead.arn
    maxReceiveCount     = 3
  })
}

data "archive_file" "webhooks" {
  type        = "zip"
  source_file = "${path.module}/../webhooks/index.mjs"
  output_path = "${path.module}/.build/webhooks.zip"
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "webhooks" {
  name               = "woodshed-cloud-webhooks"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_cloudwatch_log_group" "webhooks" {
  name              = "/aws/lambda/woodshed-cloud-webhooks"
  retention_in_days = 14
}

data "aws_iam_policy_document" "webhooks" {
  statement {
    sid       = "QueueForTheConsole"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.webhooks.arn]
  }

  statement {
    sid       = "ReadTheSigningSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.github_webhook.arn, aws_secretsmanager_secret.slack_signing.arn]
  }

  statement {
    sid       = "WriteItsLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.webhooks.arn}:*"]
  }
}

resource "aws_iam_role_policy" "webhooks" {
  name   = "woodshed-cloud-webhooks"
  role   = aws_iam_role.webhooks.id
  policy = data.aws_iam_policy_document.webhooks.json
}

# No reserved concurrency: the account's limit is 10, the minimum AWS lets stay unreserved, so that
# limit is the cap. An unsigned request is refused before any AWS call, in a few milliseconds.
resource "aws_lambda_function" "webhooks" {
  function_name    = "woodshed-cloud-webhooks"
  role             = aws_iam_role.webhooks.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.webhooks.output_path
  source_code_hash = data.archive_file.webhooks.output_base64sha256
  memory_size      = 128
  timeout          = 10

  environment {
    variables = {
      QUEUE_URL         = aws_sqs_queue.webhooks.url
      WEBHOOK_SECRET_ID = aws_secretsmanager_secret.github_webhook.arn
      SLACK_SECRET_ID   = aws_secretsmanager_secret.slack_signing.arn
    }
  }

  depends_on = [aws_cloudwatch_log_group.webhooks, aws_iam_role_policy.webhooks]
}

# Public by design: GitHub and Slack cannot sign in to AWS. The function checks their signatures itself.
resource "aws_lambda_function_url" "webhooks" {
  function_name      = aws_lambda_function.webhooks.function_name
  authorization_type = "NONE"
}

# A public Function URL needs both permissions since AWS's October 2025 change; the second is
# limited to calls that come through the URL.
resource "aws_lambda_permission" "webhooks_url" {
  statement_id           = "PublicFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.webhooks.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "webhooks_invoke" {
  statement_id             = "PublicInvokeThroughUrl"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.webhooks.function_name
  principal                = "*"
  invoked_via_function_url = true
}
