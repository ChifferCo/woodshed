# The Postgres every session's database lives on, with postgres in var.databases: the template, each shared session's
# woodshed__<id> and each person's woodshed_<login>, each with a user of its own. The master user is root, and only
# the db-admin task reads its password (ecs.tf). Backups are off on purpose: the data is seeded test data, which the
# db-admin task rebuilds.

locals {
  postgres = contains(var.databases, "postgres")
  mongo    = contains(var.databases, "mongo")
  # The db-admin task makes, copies and drops the databases, so it exists only when one does.
  db_admin = length(var.databases) > 0
  # The default project, as the console names it (console/projects.mjs, defaultProject and projectNameOf): the
  # projects' default, else github_repo's name made plain. Its repo settings are what the seed's env files are written
  # from (session/dbAdmin.mjs, --project), and the only ones the db-admin task may read.
  seed_project = coalesce(
    one([for p in var.projects : p.name if p.default || length(var.projects) == 1]),
    trim(substr(replace(lower(split("/", var.github_repo)[1]), "/[^a-z0-9]+/", "-"), 0, 32), "-"),
    "default",
  )
}

resource "aws_db_subnet_group" "main" {
  count = local.postgres ? 1 : 0

  name       = local.p
  subnet_ids = aws_subnet.public[*].id
}

resource "aws_db_instance" "postgres" {
  count = local.postgres ? 1 : 0

  identifier     = local.p
  engine         = "postgres"
  engine_version = "16"
  instance_class = "db.t4g.micro"

  allocated_storage = 20
  storage_type      = "gp3"
  storage_encrypted = true

  db_name  = var.database_name
  username = var.database_user
  # RDS keeps the password in a Secrets Manager secret of its own, so it never lands in Terraform state.
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.main[0].name
  vpc_security_group_ids = [aws_security_group.database[0].id]
  publicly_accessible    = false

  backup_retention_period    = 0
  skip_final_snapshot        = true
  deletion_protection        = false
  auto_minor_version_upgrade = true
  apply_immediately          = true
}

# The addresses from before the databases were optional, so an installation from then keeps its RDS instance.
moved {
  from = aws_db_subnet_group.main
  to   = aws_db_subnet_group.main[0]
}

moved {
  from = aws_db_instance.postgres
  to   = aws_db_instance.postgres[0]
}
