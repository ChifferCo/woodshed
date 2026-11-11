output "console_url" {
  value = "https://${var.domain}"
}

output "base_box_instance_id" {
  description = "For `aws ssm start-session --target <id>`."
  value       = aws_instance.base_box.id
}

output "data_volume_id" {
  description = "Mongo, console and Caddy data, kept across box restarts, resizes and replacements."
  value       = aws_ebs_volume.data.id
}

output "ecr_repositories" {
  value = { for k, r in aws_ecr_repository.images : k => r.repository_url }
}

output "github_images_role_arn" {
  description = "The WOODSHED_CLOUD_AWS_ROLE_ARN repository variable, for the deploy workflow's image jobs."
  value       = aws_iam_role.github_images.arn
}

output "github_plan_role_arn" {
  description = "The WOODSHED_CLOUD_PLAN_ROLE_ARN repository variable, for the deploy workflow's plan job."
  value       = aws_iam_role.github_infra["plan"].arn
}

output "github_infra_role_arn" {
  description = "The WOODSHED_CLOUD_INFRA_ROLE_ARN repository variable, for the deploy workflow's apply job."
  value       = aws_iam_role.github_infra["infra"].arn
}

output "redeploy_console_document" {
  description = "The SSM document the deploy workflow's console job runs on the base box after a console build."
  value       = aws_ssm_document.redeploy_console.name
}

locals {
  db_admin_run = join(" ", [
    "aws ecs run-task --region ${var.region} --cluster ${aws_ecs_cluster.main.name}",
    "--task-definition ${join("", aws_ecs_task_definition.db_admin[*].family)} --launch-type FARGATE",
    "--network-configuration 'awsvpcConfiguration={subnets=[${join(",", aws_subnet.public[*].id)}],securityGroups=[${aws_security_group.sessions.id}],assignPublicIp=ENABLED}'",
  ])
}

output "db_template_command" {
  description = "Builds the database template every session's databases are copied from, from the session image's default branch, as a one-off task. Once before the first session; after that the deploy workflow's session job runs it after each session image. null with no databases."
  value       = local.db_admin ? "${local.db_admin_run} --overrides '{\"containerOverrides\":[{\"name\":\"db-admin\",\"command\":[\"template\"]}]}'" : null
}

output "refresh_db_template_document" {
  description = "The SSM document the deploy workflow's session job runs on the base box after a session build, to build the database template again. null with no databases."
  value       = one(aws_ssm_document.refresh_db_template[*].name)
}

output "github_webhook_url" {
  description = "Where GitHub posts webhooks. The console's Secrets page sets it on the GitHub App."
  value       = "${trimsuffix(aws_lambda_function_url.webhooks.function_url, "/")}/github"
}

output "slack_events_url" {
  description = "The Request URL for the Slack app's Event Subscriptions (the app_mention bot event)."
  value       = "${trimsuffix(aws_lambda_function_url.webhooks.function_url, "/")}/slack"
}

output "dns_nameservers" {
  description = "Delegate var.domain to these: an NS record for each, where the parent domain's DNS is hosted."
  value       = aws_route53_zone.console.name_servers
}
