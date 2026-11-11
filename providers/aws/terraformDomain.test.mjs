import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../../console/config.mjs';

// No test here runs terraform, so these read the Terraform as text, as terraformProjects.test.mjs does. The PR that made
// the domain optional rendered the template both ways with terraform and checked the configuration with validate.
const DIR = path.join(import.meta.dirname, 'terraform');
const read = (file) => fs.readFileSync(path.join(DIR, file), 'utf8');

test('the domain is optional: with none, the console is named on sslip.io from the base box\'s address', () => {
  assert.match(read('variables.tf'), /variable "domain" \{[^}]*default {5}= ""/);
  const dns = read('dns.tf');
  assert.match(dns, /own_domain {5}= var\.domain != ""/);
  assert.match(dns, /console_domain = local\.own_domain \? var\.domain : "woodshed\.\$\{replace\(aws_eip\.base_box\.public_ip, "\.", "-"\)\}\.sslip\.io"/);
  assert.match(read('outputs.tf'), /value = "https:\/\/\$\{local\.console_domain\}"/);
  assert.match(read('baseBox.tf'), / {4}domain {13}= local\.console_domain\n {4}own_domain {9}= local\.own_domain\n/);
});

test('the zone and its records exist only with a domain, and an installation that has them keeps them where they are', () => {
  const dns = read('dns.tf');
  const resources = [['aws_route53_zone', 'console'], ['aws_route53_record', 'console'], ['aws_route53_record', 'session_apps'], ['aws_route53_record', 'console_caa']];
  for (const [type, name] of resources) {
    assert.match(dns, new RegExp(`resource "${type}" "${name}" \\{\\n {2}count = local\\.own_domain \\? 1 : 0\\n`), `${type}.${name} is counted`);
    // Without the move, a plan would destroy the zone and make one with new nameservers the parent does not name.
    assert.match(dns, new RegExp(`moved \\{\\n {2}from = ${type}\\.${name}\\n {2}to {3}= ${type}\\.${name}\\[0\\]\\n\\}`), `${type}.${name} is moved, not replaced`);
  }
  // The box's Route 53 rights exist only with the zone they name.
  const box = read('baseBox.tf');
  for (const sid of ['AnswerTheCertificateChallenge', 'ReadTheConsoleZone', 'FindTheConsoleZone']) {
    assert.match(box, new RegExp(`dynamic "statement" \\{\\n {4}for_each = aws_route53_zone\\.console\\n {4}content \\{\\n {6}sid {7}= "${sid}"`), sid);
  }
});

test('with no domain, Caddy gets each name\'s certificate on demand, asking the console first, on the port the console listens on', () => {
  const stack = read('baseBoxStack.sh.tftpl');
  assert.match(stack, /%\{ if !own_domain ~\}\n[^%]*on_demand_tls \{\n\t\task http:\/\/127\.0\.0\.1:7692\/tls-ask\n\t\}\n%\{ endif ~\}/);
  assert.match(stack, /%\{ else ~\}\n\t\t# [^\n]*\n\t\ton_demand\n%\{ endif ~\}/);
  assert.match(stack, /%\{ if !own_domain ~\}\n {6}#[^\n]*\n {6}- WOODSHED_CLOUD_TLS_ASK_PORT=7692\n%\{ endif ~\}/);
  assert.equal(loadConfig({ GH_TOKEN: 'x', WOODSHED_CLOUD_TLS_ASK_PORT: '7692' }).tlsAskPort, 7692);
  // The console's other ports on the box: its own, and the session API's.
  assert.doesNotMatch(stack, /:7692:|7692:7692/, 'nothing else on the box takes 7692');
});
