# Production debugging through woodshed-prod-mcp (console/prodMcp.mjs, README.md "Production access"), only with
# var.prod_mcp. A Fargate task keeps the security groups it started with, so a session that may use production starts
# on a network of its own, before it is ever tainted: subnets with no route out, and a security group that reaches the
# base box (the console's session API and egress proxy, Mongo, the shared services), RDS and the AWS endpoints Fargate
# itself needs, and nothing else. All its traffic to the internet goes through the console's egress proxy, which lets an
# untainted session go anywhere and a tainted one only to its organization's private GitHub repos. The taint is the
# console's to hold: nothing about this network changes when a session is tainted.
#
# Not covered here: the VPC's own DNS resolver, which no security group filters, answers a guarded session too (see
# README.md for what closing it would take).

locals {
  prod_mcp = var.prod_mcp != null
  # Fargate pulls the image (and its SOCI index), writes the log stream and reads the task's secrets through the task's
  # own network interface: with no route out, through these.
  guarded_endpoints = local.prod_mcp ? toset(["ecr.api", "ecr.dkr", "logs", "secretsmanager"]) : toset([])
}

resource "aws_subnet" "guarded" {
  count = local.prod_mcp ? 2 : 0

  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index + 11)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = false

  tags = { Name = "${local.p}-guarded-${count.index + 1}" }
}

# The VPC's own routes and the S3 endpoint's, and no internet gateway.
resource "aws_route_table" "guarded" {
  count = local.prod_mcp ? 1 : 0

  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.p}-guarded" }
}

resource "aws_route_table_association" "guarded" {
  count = local.prod_mcp ? 2 : 0

  subnet_id      = aws_subnet.guarded[count.index].id
  route_table_id = aws_route_table.guarded[0].id
}

resource "aws_security_group" "guarded_sessions" {
  count = local.prod_mcp ? 1 : 0

  name        = "${local.p}-guarded-sessions"
  description = "Sessions that may use production: out only to the base box, RDS and AWS endpoints"
  vpc_id      = aws_vpc.main.id
}

resource "aws_security_group" "endpoints" {
  count = local.prod_mcp ? 1 : 0

  name        = "${local.p}-endpoints"
  description = "VPC interface endpoints for ECR, CloudWatch Logs and Secrets Manager"
  vpc_id      = aws_vpc.main.id
}

# The endpoints' private DNS answers for the whole VPC, so the base box and the other sessions reach them too.
resource "aws_vpc_security_group_ingress_rule" "endpoints" {
  for_each = local.prod_mcp ? {
    guarded  = aws_security_group.guarded_sessions[0].id
    sessions = aws_security_group.sessions.id
    base_box = aws_security_group.base_box.id
  } : {}

  security_group_id            = aws_security_group.endpoints[0].id
  description                  = "HTTPS from ${each.key}"
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

resource "aws_vpc_endpoint" "guarded" {
  for_each = local.guarded_endpoints

  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.guarded[*].id
  security_group_ids  = [aws_security_group.endpoints[0].id]
  private_dns_enabled = true

  tags = { Name = "${local.p}-${each.key}" }
}

# ECR's image layers are in S3: a gateway endpoint, which costs nothing, on the guarded route table alone.
resource "aws_vpc_endpoint" "s3" {
  count = local.prod_mcp ? 1 : 0

  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.guarded[0].id]

  tags = { Name = "${local.p}-s3" }
}

data "aws_ec2_managed_prefix_list" "s3" {
  count = local.prod_mcp ? 1 : 0
  name  = "com.amazonaws.${var.region}.s3"
}

# Out: the base box's ports sessions use (the session API, the egress proxy, Mongo, the shared and project services),
# RDS, the endpoints and S3. Nothing to the internet: no rule for it, and no route.
resource "aws_vpc_security_group_egress_rule" "guarded_to_base_box" {
  for_each = local.prod_mcp ? merge(
    { session_api = [7691, 7691], egress_proxy = [7693, 7693], project_services = [42000, 42099] },
    local.mongo ? { mongo = [27017, 27017] } : {},
    { for name, s in var.shared_services : name => [s.port, s.port] },
  ) : {}

  security_group_id            = aws_security_group.guarded_sessions[0].id
  description                  = each.key
  referenced_security_group_id = aws_security_group.base_box.id
  ip_protocol                  = "tcp"
  from_port                    = each.value[0]
  to_port                      = each.value[1]
}

resource "aws_vpc_security_group_egress_rule" "guarded_to_postgres" {
  count = local.prod_mcp && local.postgres ? 1 : 0

  security_group_id            = aws_security_group.guarded_sessions[0].id
  description                  = "Postgres"
  referenced_security_group_id = aws_security_group.database[0].id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_egress_rule" "guarded_to_endpoints" {
  count = local.prod_mcp ? 1 : 0

  security_group_id            = aws_security_group.guarded_sessions[0].id
  description                  = "ECR, CloudWatch Logs, Secrets Manager"
  referenced_security_group_id = aws_security_group.endpoints[0].id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
}

resource "aws_vpc_security_group_egress_rule" "guarded_to_s3" {
  count = local.prod_mcp ? 1 : 0

  security_group_id = aws_security_group.guarded_sessions[0].id
  description       = "ECR image layers in S3"
  prefix_list_id    = data.aws_ec2_managed_prefix_list.s3[0].id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

# In: the console to the session's ttyd, statusd and shell, as for any session.
resource "aws_vpc_security_group_ingress_rule" "guarded_session_ports" {
  for_each = local.prod_mcp ? { ttyd = 7681, statusd = 7682, shell = 7684 } : {}

  security_group_id            = aws_security_group.guarded_sessions[0].id
  description                  = each.key
  referenced_security_group_id = aws_security_group.base_box.id
  ip_protocol                  = "tcp"
  from_port                    = each.value
  to_port                      = each.value
}

# The base box and RDS take a guarded session as they take any other.
resource "aws_vpc_security_group_ingress_rule" "base_box_from_guarded" {
  for_each = aws_vpc_security_group_egress_rule.guarded_to_base_box

  security_group_id            = aws_security_group.base_box.id
  description                  = "${each.key} from guarded sessions"
  referenced_security_group_id = aws_security_group.guarded_sessions[0].id
  ip_protocol                  = "tcp"
  from_port                    = each.value.from_port
  to_port                      = each.value.to_port
}

resource "aws_vpc_security_group_ingress_rule" "postgres_from_guarded" {
  count = local.prod_mcp && local.postgres ? 1 : 0

  security_group_id            = aws_security_group.database[0].id
  description                  = "Postgres from guarded sessions"
  referenced_security_group_id = aws_security_group.guarded_sessions[0].id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

# The console's OpenID Connect signing key (console/oidcIssuer.mjs), made by the console the first time it is needed.
# Only the console reads it; woodshed-prod-mcp reads the public half from the console's /.well-known/jwks.json.
resource "aws_secretsmanager_secret" "oidc_signing_key" {
  count = local.prod_mcp ? 1 : 0

  name                    = "${local.p}/oidc-signing-key"
  description             = "The console's OpenID Connect signing key, for the tokens its production MCP relay adds. Only the console reads it"
  recovery_window_in_days = 0
}
