# The console's own name. The parent domain's DNS is elsewhere, so this zone answers only once the parent
# delegates the name to it: NS records for it there, holding `dns_nameservers`. A recreated zone gets new
# nameservers, and the parent's NS records must then be changed to match, or the name stops resolving.
#
# With no domain there is no zone: the console is named on sslip.io, which answers every name with an IP in it with that
# IP, so woodshed.203-0-113-10.sslip.io and every name under it reach the base box. Let's Encrypt counts certificates
# for all of sslip.io, everyone's, against one weekly limit; Caddy falls back to ZeroSSL when it refuses.

locals {
  own_domain     = var.domain != ""
  console_domain = local.own_domain ? var.domain : "woodshed.${replace(aws_eip.base_box.public_ip, ".", "-")}.sslip.io"
}

# The zone and its records were made without count before the domain could be left out: an installation that has one
# keeps them, with the same nameservers, rather than a new zone the parent's NS records do not name.
moved {
  from = aws_route53_zone.console
  to   = aws_route53_zone.console[0]
}

moved {
  from = aws_route53_record.console
  to   = aws_route53_record.console[0]
}

moved {
  from = aws_route53_record.session_apps
  to   = aws_route53_record.session_apps[0]
}

moved {
  from = aws_route53_record.console_caa
  to   = aws_route53_record.console_caa[0]
}

resource "aws_route53_zone" "console" {
  count = local.own_domain ? 1 : 0

  name    = var.domain
  comment = "Woodshed console"
}

resource "aws_route53_record" "console" {
  count = local.own_domain ? 1 : 0

  zone_id = aws_route53_zone.console[0].zone_id
  name    = var.domain
  type    = "A"
  ttl     = 300
  records = [aws_eip.base_box.public_ip]
}

# Each session's app at <id>.<domain>, through the console (console/appProxy.mjs).
resource "aws_route53_record" "session_apps" {
  count = local.own_domain ? 1 : 0

  zone_id = aws_route53_zone.console[0].zone_id
  name    = "*.${var.domain}"
  type    = "A"
  ttl     = 300
  records = [aws_eip.base_box.public_ip]
}

# Only the CAs Caddy uses may issue for the name: Let's Encrypt, and ZeroSSL (Sectigo) if Let's Encrypt fails.
resource "aws_route53_record" "console_caa" {
  count = local.own_domain ? 1 : 0

  zone_id = aws_route53_zone.console[0].zone_id
  name    = var.domain
  type    = "CAA"
  ttl     = 3600
  records = ["0 issue \"letsencrypt.org\"", "0 issue \"sectigo.com\""]
}
