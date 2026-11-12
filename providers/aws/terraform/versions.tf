terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    # Zips the webhooks Lambda (webhooks.tf).
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
    }
  }

  # Bucket, key and region come from the installation's backend.hcl (example.backend.hcl), given to `terraform init -backend-config`.
  # use_lockfile keeps the lock in the bucket itself, so there is no DynamoDB table.
  backend "s3" {}
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      project = local.p
    }
  }
}
