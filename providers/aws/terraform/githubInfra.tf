# Lets the installation's deploy workflow (providers/aws/README.md, "The deploy workflow") plan and apply this stack,
# through GitHub OIDC like github.tf. Each role trusts one GitHub environment, not the branch, for the reason github.tf gives.
# The plan role only reads and needs no approval; the infra role is an administrator of this account (which
# holds nothing but Woodshed Cloud), so its environment requires a reviewer on every run. That reviewer, not
# IAM, is what keeps a merge from changing AWS unseen.

locals {
  github_infra_roles = {
    plan  = "woodshed-cloud-plan"
    infra = "woodshed-cloud-infra"
  }
  state_lock_key = "woodshed-cloud/terraform.tfstate.tflock"
}

data "aws_iam_policy_document" "github_infra_assume" {
  for_each = local.github_infra_roles

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
      values   = ["repo:${var.github_repo}:environment:${each.value}"]
    }
  }
}

resource "aws_iam_role" "github_infra" {
  for_each = local.github_infra_roles

  name                 = "woodshed-cloud-github-${each.key}"
  assume_role_policy   = data.aws_iam_policy_document.github_infra_assume[each.key].json
  max_session_duration = 3600
}

resource "aws_iam_role_policy_attachment" "github_plan_read" {
  role       = aws_iam_role.github_infra["plan"].name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

resource "aws_iam_role_policy_attachment" "github_infra_admin" {
  role       = aws_iam_role.github_infra["infra"].name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

data "aws_iam_policy_document" "github_plan" {
  # A plan takes the state lock, which use_lockfile keeps as an object beside the state.
  statement {
    sid       = "TakeTheStateLock"
    actions   = ["s3:PutObject", "s3:DeleteObject"]
    resources = ["arn:aws:s3:::woodshed-cloud-tfstate-${local.account_id}/${local.state_lock_key}"]
  }

  # ReadOnlyAccess reads object contents and log events, which a plan never needs: people's Claude homes
  # (their tokens among them) and the session logs. The plan role needs no reviewer, so it gets neither.
  statement {
    sid    = "NotPeoplesData"
    effect = "Deny"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "logs:GetLogEvents",
      "logs:FilterLogEvents",
      "logs:StartQuery",
      "logs:StartLiveTail",
    ]
    not_resources = ["arn:aws:s3:::woodshed-cloud-tfstate-${local.account_id}/*"]
  }
}

resource "aws_iam_role_policy" "github_plan" {
  name   = "plan-woodshed-cloud"
  role   = aws_iam_role.github_infra["plan"].id
  policy = data.aws_iam_policy_document.github_plan.json
}
