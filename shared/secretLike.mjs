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

/** The text with each key of a known kind in it put as `[redacted]`, for a name or a line that is printed. */
export function redact(text) {
  return SECRET_CONTENT.reduce((out, [, re]) => out.replace(new RegExp(re.source, 'g'), '[redacted]'), String(text));
}

function skipWhitespace(text, start) {
  while (/\s/.test(text[start] ?? '')) start++;
  return start;
}

/** A credential-bearing shell header option, by name alone. */
function literalHeader(text) {
  const name = /authorization|proxy-authorization|x-api-key|api-key|cookie/iy;
  const scheme = /(?:bearer|basic|token)(?=\s)/iy;
  for (const option of text.matchAll(/--header|-h/gi)) {
    let start = option.index + option[0].length;
    while (/[\s=]/.test(text[start] ?? '')) start++;
    if (text[start] === '"' || text[start] === "'") start++;
    name.lastIndex = skipWhitespace(text, start);
    const header = name.exec(text);
    if (!header) continue;
    const colon = skipWhitespace(text, name.lastIndex);
    if (text[colon] !== ':') continue;
    const value = skipWhitespace(text, colon + 1);
    if (!text[value] || /[$'"]/.test(text[value])) continue;
    scheme.lastIndex = value;
    if (scheme.test(text) && text[skipWhitespace(text, scheme.lastIndex)] === '$') continue;
    return header[0];
  }
  return null;
}

function urlHasSignIn(text) {
  for (const { index } of text.matchAll(/:\/\//g)) {
    // The scheme can end in numbers or punctuation, but must contain a letter.
    let before = index - 1;
    while (/[0-9+.-]/.test(text[before] ?? '')) before--;
    if (!/[a-z]/i.test(text[before] ?? '')) continue;
    const start = index + 3;
    let colon = start;
    while (/[^\s/:@'"]/.test(text[colon] ?? '')) colon++;
    if (colon === start || text[colon] !== ':') continue;
    let end = colon + 1;
    while (/[^\s/@'"]/.test(text[end] ?? '')) end++;
    if (end > colon + 1 && text[end] === '@') return true;
  }
  return false;
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
  const header = literalHeader(text);
  if (header) return `the ${header} header`;
  // curl requires a bearer argument, even if its first character is a dash.
  if (/--oauth2-bearer(?:=|\s+)['"]?(?![$\s'"])/i.test(text)) return 'a --oauth2-bearer value';
  const option = /--(token|password|passwd|api-?key|secret|auth)(?:=|\s+)['"]?(?![$\s'"-])/i.exec(text);
  if (option) return `a --${option[1]} value`;
  if (urlHasSignIn(text)) return 'a URL with a sign-in';
  // curl -u name:password, --user=name:password: a literal password, not one read from a variable. Only curl's and
  // wget's: docker's -u 1000:1000 or --user root:root is a user and a group.
  if (/\b(?:curl|wget)\b[^|;&]*\s(?:-u|--user|--http-user)(?:\s+|=)['"]?[^\s'"$:]+:(?![$\s'"])/.test(text)) return 'a --user sign-in';
  if (/credential[.-]helper/i.test(text)) return 'a credential helper';
  return null;
}
