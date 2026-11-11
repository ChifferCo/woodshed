# The console's own name. The parent domain's DNS is elsewhere, so this zone answers only once the parent
# delegates the name to it: NS records for it there, holding `dns_nameservers`. A recreated zone gets new
# nameservers, and the parent's NS records must then be changed to match, or the name stops resolving.

resource "aws_route53_zone" "console" {
  name    = var.domain
  comment = "Woodshed console"
}

resource "aws_route53_record" "console" {
  zone_id = aws_route53_zone.console.zone_id
  name    = var.domain
  type    = "A"
  ttl     = 300
  records = [aws_eip.base_box.public_ip]
}

# Each session's app at <id>.<domain>, through the console (console/appProxy.mjs).
resource "aws_route53_record" "session_apps" {
  zone_id = aws_route53_zone.console.zone_id
  name    = "*.${var.domain}"
  type    = "A"
  ttl     = 300
  records = [aws_eip.base_box.public_ip]
}

# Only the CAs Caddy uses may issue for the name: Let's Encrypt, and ZeroSSL (Sectigo) if Let's Encrypt fails.
resource "aws_route53_record" "console_caa" {
  zone_id = aws_route53_zone.console.zone_id
  name    = var.domain
  type    = "CAA"
  ttl     = 3600
  records = ["0 issue \"letsencrypt.org\"", "0 issue \"sectigo.com\""]
}
