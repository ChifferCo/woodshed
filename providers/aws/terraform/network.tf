# Public subnets only: sessions reach GitHub, npm and Anthropic through their
# own public IPs, which saves a NAT gateway.

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, 2)
  # The base box keeps one address, because every session's env points at it.
  base_box_private_ip = cidrhost(aws_subnet.public[0].cidr_block, 10)
}

resource "aws_vpc" "main" {
  cidr_block           = "10.42.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = { Name = "woodshed-cloud" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = { Name = "woodshed-cloud" }
}

# Two subnets in two zones: RDS will not create a subnet group with fewer.
resource "aws_subnet" "public" {
  count = 2

  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index + 1)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = true

  tags = { Name = "woodshed-cloud-public-${count.index + 1}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "woodshed-cloud-public" }
}

resource "aws_route_table_association" "public" {
  count = 2

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# The description predates opening the console to the internet; changing it would replace the group.
resource "aws_security_group" "base_box" {
  name        = "woodshed-cloud-base-box"
  description = "Console over HTTPS from the allowlist; shared services for sessions"
  vpc_id      = aws_vpc.main.id
}

resource "aws_security_group" "sessions" {
  name        = "woodshed-cloud-sessions"
  description = "Session tasks: ttyd and statusd, reachable only from the base box"
  vpc_id      = aws_vpc.main.id
}

resource "aws_security_group" "database" {
  count = local.postgres ? 1 : 0

  name        = "woodshed-cloud-database"
  description = "RDS Postgres, from the base box and sessions only"
  vpc_id      = aws_vpc.main.id
}

moved {
  from = aws_security_group.database
  to   = aws_security_group.database[0]
}

# Open to the internet: the console requires a GitHub sign-in on every route (WOODSHED_REQUIRE_SIGN_IN).
resource "aws_vpc_security_group_ingress_rule" "console_https" {
  security_group_id = aws_security_group.base_box.id
  description       = "Console"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

# Port 80 redirects to HTTPS, for a typed http:// link. With a domain the certificates never need it: they come by DNS.
# On sslip.io (no domain), Caddy may answer a certificate's HTTP challenge on it.
resource "aws_vpc_security_group_ingress_rule" "console_http" {
  security_group_id = aws_security_group.base_box.id
  description       = "Console, redirect to HTTPS"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_ingress_rule" "shared_services" {
  for_each = merge(
    # The console's session API: GitHub installation tokens for sessions (console/sessionApi.mjs).
    { session_api = 7691 },
    local.mongo ? { mongo = 27017 } : {},
    { for name, s in var.shared_services : name => s.port },
  )

  security_group_id            = aws_security_group.base_box.id
  description                  = each.key
  referenced_security_group_id = aws_security_group.sessions.id
  ip_protocol                  = "tcp"
  from_port                    = each.value
  to_port                      = each.value
}

resource "aws_vpc_security_group_ingress_rule" "session_ports" {
  for_each = {
    ttyd    = 7681
    statusd = 7682
    shell   = 7684
  }

  security_group_id            = aws_security_group.sessions.id
  description                  = each.key
  referenced_security_group_id = aws_security_group.base_box.id
  ip_protocol                  = "tcp"
  from_port                    = each.value
  to_port                      = each.value
}

resource "aws_vpc_security_group_ingress_rule" "postgres" {
  for_each = local.postgres ? {
    base_box = aws_security_group.base_box.id
    sessions = aws_security_group.sessions.id
  } : {}

  security_group_id            = aws_security_group.database[0].id
  description                  = "Postgres from ${each.key}"
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_egress_rule" "all" {
  for_each = {
    base_box = aws_security_group.base_box.id
    sessions = aws_security_group.sessions.id
  }

  security_group_id = each.value
  description       = "Outbound: GitHub, npm, Anthropic, AWS APIs"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}
