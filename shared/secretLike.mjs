// What looks like a credential, for what a person's computer or My settings hands their sessions (cli/settings.mjs,
// shared/dotfiles.mjs): by a variable's or header's name, and by the shape of a known kind of key. A match is named by
// its kind or its name, never printed.

export const SECRET_VARIABLE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH|COOKIE|SESSION)(_|$)/i;
export const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key|api-key)$|(token|secret|key|auth)/i;

// What a file's content can hold that is a credential, by kind: the plan names the kind, never the match.
export const SECRET_CONTENT = [
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['a GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/],
  ['an Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['an OpenAI API key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ['a Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['an AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a live Stripe key', /\b[rs]k_live_[A-Za-z0-9]{16,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  // Woodshed's own: a computer's command line sign-in (cliSignIn.mjs), and the database tunnel's (dbTunnel.mjs).
  ['a Woodshed command line token', /\bwsc_[0-9a-f]{64}\b/],
  ['a Woodshed database tunnel token', /\bwt_[0-9a-f]{64}\b/],
];

/** @returns {string|null}  the kind of credential the text holds, null for none */
export function secretContent(text, kinds = SECRET_CONTENT) {
  return kinds.find(([, re]) => re.test(text))?.[0] ?? null;
}

/**
 * A credential in a line of shell (an alias, a git alias's `!` command): a key of a known kind, a variable named like a
 * credential given a literal value, a header or option that carries one, a URL with a sign-in, or a credential helper.
 * @returns {string|null}  what it is, by kind or name, never the value
 */
export function shellCredential(text) {
  const kind = secretContent(text);
  if (kind) return kind;
  // NAME=value as a word of its own (after a space, a quote, `!` or `;`), not NAME=$OTHER or an option's --name=value.
  for (const [, name] of text.matchAll(/(?<![A-Za-z0-9_.-])([A-Za-z_][A-Za-z0-9_]*)=['"]?(?![$'"\s])/g)) {
    if (SECRET_VARIABLE.test(name)) return `a value for ${name}`;
  }
  // A header's value read from a variable ("Authorization: Bearer $TOKEN") is none.
  const header = /(?:-H|--header)[\s=]*['"]?\s*(authorization|proxy-authorization|x-api-key|api-key|cookie)\s*:\s*(?!(?:(?:bearer|basic|token)\s+)?\$)(?![\s'"])/i.exec(text);
  if (header) return `the ${header[1]} header`;
  const option = /--(token|password|passwd|api-?key|secret|auth)(?:=|\s+)['"]?(?![$\s'"-])/i.exec(text);
  if (option) return `a --${option[1]} value`;
  if (/[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"]+:[^\s/@'"]+@/i.test(text)) return 'a URL with a sign-in';
  // curl -u name:password, --user=name:password: a literal password, not one read from a variable. Only curl's and
  // wget's: docker's -u 1000:1000 or --user root:root is a user and a group.
  if (/\b(?:curl|wget)\b[^|;&]*\s(?:-u|--user|--http-user)(?:\s+|=)['"]?[^\s'"$:]+:(?![$\s'"])/.test(text)) return 'a --user sign-in';
  if (/credential[.-]helper/i.test(text)) return 'a credential helper';
  return null;
}
