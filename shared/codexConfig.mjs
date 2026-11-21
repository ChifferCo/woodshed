// codex's ~/.codex/config.toml, which a person's sessions and computer keep in step (settingsSync.mjs), read as TOML
// statements rather than parsed: the sync only ever leaves some out and puts some back, so each statement's text stays
// as it was written, comments and all.
//
// Each side keeps some entries its own: they are never part of what is synced, and a write keeps the ones already there.
//   - its trusted folders, `[projects."<path>"]`: a path on a computer means nothing in a session, and a session trusts
//     its own checkout as it starts (`node codexConfig.mjs trust`);
//   - any entry holding a credential (credentialOf): an MCP server's key stays in the session or on the computer it was
//     typed in, never in the shared copy, which the person's computer and their other sessions read. The console refuses
//     a copy holding one.
//
//   node codexConfig.mjs trust <config.toml> <dir>   adds `[projects."<dir>"] trust_level = "trusted"` unless it is there

import fs from 'node:fs';
import { isMain } from './isMain.mjs';
import { redact, SECRET_HEADER, SECRET_VARIABLE, secretContent, shellCredential } from './secretLike.mjs';

export const CODEX_CONFIG = '.codex/config.toml';
// Tables keyed by a name the person picks: a statement in one belongs to its entry (mcp_servers.github), and an entry
// is kept or left out whole, so none is left half there.
const NAMED_MAPS = new Set(['mcp_servers', 'model_providers', 'profiles', 'projects']);

const BARE = /^[A-Za-z0-9_-]+$/;

/** A key's parts as TOML writes them: bare where it can be, quoted otherwise. */
export function keyText(parts) {
  return parts.map((p) => (BARE.test(p) ? p : JSON.stringify(p))).join('.');
}

function decodeBasic(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    // An escape JSON has not (\e, \x): what is between the quotes is near enough for a name.
    return raw.slice(1, -1);
  }
}

/**
 * The statements of a TOML document, in order: blank lines and comments, table headers, and key/value pairs, each with
 * its text whole (a multi-line array or string included), so joining them gives the document back.
 * @param {string} text
 * @returns {{kind: 'blank'|'header'|'kv', text: string, table: string[], key?: string[], value?: string, array?: boolean}[]|null}
 *   `table`: a header's own path, or the table a pair is in ([] for the top). null when it is not TOML this reads
 */
export function readToml(text) {
  const out = [];
  let i = 0;
  let table = [];
  const n = text.length;
  const lineEnd = (from) => {
    const at = text.indexOf('\n', from);
    return at === -1 ? n : at + 1;
  };
  const space = () => {
    while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
  };
  function key() {
    const parts = [];
    for (;;) {
      space();
      if (text[i] === '"') {
        const m = /^"(?:[^"\\\n]|\\.)*"/.exec(text.slice(i));
        if (!m) return null;
        parts.push(decodeBasic(m[0]));
        i += m[0].length;
      } else if (text[i] === "'") {
        const end = text.indexOf("'", i + 1);
        if (end === -1 || text.slice(i, end).includes('\n')) return null;
        parts.push(text.slice(i + 1, end));
        i = end + 1;
      } else {
        const m = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
        if (!m) return null;
        parts.push(m[0]);
        i += m[0].length;
      }
      space();
      if (text[i] !== '.') return parts;
      i++;
    }
  }
  // The rest of a line once something ended: only a comment may follow.
  function endOfLine() {
    space();
    if (i < n && text[i] === '#') i = lineEnd(i);
    else if (i < n && text[i] === '\r' && text[i + 1] === '\n') i += 2;
    else if (i < n && text[i] === '\n') i++;
    else if (i < n) return false;
    return true;
  }
  while (i < n) {
    const start = i;
    space();
    if (i >= n || text[i] === '\n' || text[i] === '\r' || text[i] === '#') {
      i = lineEnd(i);
      out.push({ kind: 'blank', text: text.slice(start, i), table });
      continue;
    }
    if (text[i] === '[') {
      const array = text[i + 1] === '[';
      i += array ? 2 : 1;
      const parts = key();
      if (!parts) return null;
      if (text.slice(i, i + (array ? 2 : 1)) !== (array ? ']]' : ']')) return null;
      i += array ? 2 : 1;
      if (!endOfLine()) return null;
      table = parts;
      out.push({ kind: 'header', text: text.slice(start, i), table, array });
      continue;
    }
    const parts = key();
    if (!parts || text[i] !== '=') return null;
    i++;
    const valueStart = i;
    // Where the comment after the value starts, as the scan found it: a `#` inside a string is not one.
    let commentAt = null;
    let depth = 0;
    for (;;) {
      if (i >= n) {
        if (depth) return null;
        break;
      }
      const c = text[i];
      if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
        const quote = text.slice(i, i + 3);
        let j = i + 3;
        while (j < n && !text.startsWith(quote, j)) j += quote === '"""' && text[j] === '\\' ? 2 : 1;
        if (j >= n) return null;
        // Up to two quotes of the string's own may come right before its end ("""a""""" is `a""`).
        i = j + 3;
        for (let extra = 0; extra < 2 && text[i] === quote[0]; extra++) i++;
      } else if (c === '"') {
        const m = /^"(?:[^"\\\n]|\\.)*"/.exec(text.slice(i));
        if (!m) return null;
        i += m[0].length;
      } else if (c === "'") {
        const end = text.indexOf("'", i + 1);
        if (end === -1 || text.slice(i, end).includes('\n')) return null;
        i = end + 1;
      } else if (c === '#') {
        if (depth === 0) commentAt = i;
        i = lineEnd(i) - 1;
        if (text[i] !== '\n') i = n;
      } else if (c === '[' || c === '{') {
        depth++;
        i++;
      } else if (c === ']' || c === '}') {
        depth--;
        if (depth < 0) return null;
        i++;
      } else if (c === '\n' && depth === 0) {
        i++;
        break;
      } else i++;
    }
    const raw = text.slice(valueStart, commentAt ?? i).replace(/\r?\n$/, '');
    const value = raw.trim();
    out.push({ kind: 'kv', text: text.slice(start, i), table, key: parts, value });
  }
  return out;
}

/** The whole path a statement names: a header's table, or a pair's table and key. */
export function pathOf(statement) {
  return statement.kind === 'kv' ? [...statement.table, ...statement.key] : statement.table;
}

/**
 * What a statement belongs to, as a string: an entry of a named table (mcp_servers.github), or else the statement's own
 * path. A blank line belongs to nothing.
 */
export function unitOf(statement) {
  if (statement.kind === 'blank') return null;
  const full = pathOf(statement);
  return keyText(NAMED_MAPS.has(full[0]) && full.length > 1 ? full.slice(0, 2) : full);
}


export const textOf = (statements) => statements.map((s) => s.text).join('');

/** Without an empty line at the start or right after another, which taking entries out of the middle leaves. */
export function tidy(statements) {
  const out = [];
  for (const s of statements) {
    const empty = s.kind === 'blank' && !s.text.trim();
    if (empty && (!out.length || (out.at(-1).kind === 'blank' && !out.at(-1).text.trim()))) continue;
    out.push(s);
  }
  return out;
}

/**
 * Statements of another document put into this one: each pair under its own table (its header made when this has
 * none), a top-level pair before the first header, and a table with its header after the rest.
 * @param {string} base
 * @param {ReturnType<typeof readToml>} own  whole entries (a header and the pairs under it, or pairs alone)
 * @returns {string}
 */
export function compose(base, own) {
  const ends = (s) => (!s || s.endsWith('\n') ? s : `${s}\n`);
  const entries = own.filter((s) => s.kind !== 'blank');
  if (!entries.length) return base;
  const statements = readToml(base);
  if (!statements) return `${ends(base)}${textOf(entries.map((s) => ({ text: ends(s.text) })))}`;
  const has = new Set(statements.filter((s) => s.kind === 'header' && !s.array).map((s) => s.table.join('\0')));
  // What goes in after each table already here, by its path; '' is the top.
  const into = new Map();
  let tail = '';
  let header = null;
  for (const s of entries) {
    if (s.kind === 'header') {
      header = s.table.join('\0');
      tail += `\n${ends(s.text)}`;
    } else if (header !== null && header === s.table.join('\0')) tail += ends(s.text);
    else {
      header = null;
      const key = s.table.join('\0');
      if (key === '' || has.has(key)) into.set(key, (into.get(key) ?? '') + ends(s.text));
      else {
        tail += `\n[${keyText(s.table)}]\n${ends(s.text)}`;
        has.add(key);
        header = key;
      }
    }
  }
  // Each table's pairs go after its last pair (or its header), before the blank lines that end it.
  const after = new Map();
  let current = '';
  let last = -1;
  const mark = () => {
    if (current === null || !into.has(current)) return;
    after.set(last, into.get(current));
    into.delete(current);
  };
  statements.forEach((s, j) => {
    if (s.kind === 'header') {
      mark();
      current = s.array ? null : s.table.join('\0');
      last = j;
    } else if (s.kind === 'kv') last = j;
  });
  mark();
  let out = after.get(-1) ?? '';
  statements.forEach((s, j) => {
    out += s.text;
    if (after.has(j)) out = ends(out) + after.get(j);
  });
  return tail ? `${ends(out)}${out.trim() ? tail : tail.replace(/^\n/, '')}` : out;
}

const STRING_RE = /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'[^'\n]*'/g;

function said(raw) {
  if (raw.startsWith('"""') || raw.startsWith("'''")) return raw.slice(3, -3);
  return raw.startsWith('"') ? decodeBasic(raw) : raw.slice(1, -1);
}

/** The string literals in a pair's value, each with its text as written and what it says. */
export function stringsOf(value) {
  return [...value.matchAll(STRING_RE)].map(([raw]) => ({ raw, said: said(raw) }));
}

/** The `key = "value"` pairs of an inline table in a pair's value: { Authorization = "Bearer …" }. */
export function inlinePairs(value) {
  const re = /(?:^|[{,])\s*(?:([A-Za-z0-9_-]+)|"((?:[^"\\\n]|\\.)*)"|'([^'\n]*)')\s*=\s*("(?:[^"\\\n]|\\.)*"|'[^'\n]*')/g;
  return [...value.matchAll(re)].map((m) => ({ key: m[1] ?? m[2] ?? m[3], raw: m[4], said: said(m[4]) }));
}

/**
 * `base` with whole entries of another document in place of its own of the same names (unitOf): what a computer keeps
 * of its own config.toml when it takes the shared one.
 */
export function withEntries(base, own) {
  const names = new Set(own.map(unitOf).filter(Boolean));
  if (!names.size) return base;
  const statements = readToml(base);
  return compose(statements ? textOf(statements.filter((s) => !names.has(unitOf(s)))) : base, own);
}

// Tables whose values codex takes as they are (mcp_servers.x.env, shell_environment_policy.set, http_headers): a value
// for a key named like a credential is one, whatever it looks like.
const LITERAL_TABLES = new Set(['env', 'set', 'http_headers']);
// Keys and tables whose values name an environment variable rather than hold a value (env_key, bearer_token_env_var,
// env_http_headers): `OPENAI_API_KEY` there is a name.
const namesVariable = (key, table) => /(^env_key|_env_var)$/.test(key) || table === 'env_http_headers';
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
// A value that is only a variable's name ("${GITHUB_TOKEN}"), which holds no secret, whatever codex makes of it.
const REFERENCE = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/;
// One of codex's own words (preferred_auth_method = "chatgpt", a credentials store = "file"), not a credential.
const WORD = /^[a-z][a-z0-9_-]{0,24}$/;
// A header that carries a credential, wherever in an inline table it is ({ http_headers = { Authorization = … } }).
const CREDENTIAL_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key|api-key)$/i;

/** Each entry's program (`command`), by its unitOf: what its `args` are given to. */
export function commandsOf(statements) {
  const commands = new Map();
  for (const s of statements) {
    if (s.kind !== 'kv' || pathOf(s).at(-1) !== 'command') continue;
    const [program] = stringsOf(s.value);
    if (program) commands.set(unitOf(s), program.said);
  }
  return commands;
}

/**
 * What in one of config.toml's statements is a credential, named (a key's shape in the name redacted), never shown:
 * null for none.
 * @param {ReturnType<typeof readToml>[number]} statement
 * @param {Map<string, string>} [commands]  commandsOf the file: an entry's `args` are read after its program
 * @returns {string|null}
 */
export function credentialOf(statement, commands = null) {
  const found = findCredential(statement, commands);
  return found === null ? null : redact(found);
}

function findCredential(statement, commands) {
  // A comment or a table's name can hold a key's shape too.
  if (statement.kind !== 'kv') return secretContent(statement.text) ? `holds what looks like ${secretContent(statement.text)}` : null;
  const at = pathOf(statement);
  const name = keyText(at);
  const last = at.at(-1);
  const table = at.at(-2);
  const kind = secretContent(statement.text);
  if (kind) return `holds what looks like ${kind}`;
  const strings = stringsOf(statement.value);
  if (/^(experimental_)?bearer_token$/.test(last) && strings.length) return `sets ${name}`;
  // An inline table's pairs, at any depth: its values are an MCP server's env or headers, which codex takes as they are,
  // so no word of codex's own passes here.
  for (const pair of inlinePairs(statement.value)) {
    if (!pair.said.trim() || REFERENCE.test(pair.said) || (namesVariable(pair.key, last) && ENV_NAME.test(pair.said))) continue;
    if (SECRET_VARIABLE.test(pair.key) || CREDENTIAL_HEADER.test(pair.key) || (last === 'http_headers' && SECRET_HEADER.test(pair.key))) return `sets ${name}.${keyText([pair.key])}`;
  }
  const single = strings.length === 1 && statement.value.trim() === strings[0].raw ? strings[0].said : null;
  if (single !== null && single.trim() && !REFERENCE.test(single)) {
    if (LITERAL_TABLES.has(table) && (SECRET_VARIABLE.test(last) || (table === 'http_headers' && SECRET_HEADER.test(last)))) return `sets ${name}`;
    if (SECRET_VARIABLE.test(last) && !WORD.test(single) && !(namesVariable(last, table) && ENV_NAME.test(single))) return `sets ${name}`;
  }
  // A program's arguments, read as its command line: `--api-key abc`, `-H "Authorization: …"`, `TOKEN=abc`.
  if (strings.length > 1 || last === 'args') {
    const program = last === 'args' ? commands?.get(unitOf(statement)) : null;
    const words = [...(program ? [program] : []), ...strings.map((s) => s.said)];
    const argv = shellCredential(words.map((w) => (/\s/.test(w) ? `"${w}"` : w)).join(' '));
    if (argv) return `${name} passes ${argv}`;
  }
  for (const { said: text } of strings) {
    let url = null;
    try {
      url = new URL(text);
    } catch {}
    if (url && (url.username || url.password)) return `${name}'s URL carries a sign-in`;
    const param = url && [...url.searchParams].find(([k, v]) => SECRET_VARIABLE.test(k) && v && !/^\$/.test(v));
    if (param) return `${name}'s URL carries ${param[0]}`;
  }
  return null;
}

/** The entries (unitOf) a side keeps its own: its trusted folders, and each that holds a credential. */
export function ownUnits(statements) {
  const own = new Set();
  const commands = commandsOf(statements);
  for (const s of statements) {
    if (s.kind !== 'blank' && (pathOf(s)[0] === 'projects' || credentialOf(s, commands))) own.add(unitOf(s));
  }
  return own;
}

// The entry a blank line belongs to: the one whose table it is under.
const tableUnit = (statement) => (statement.table.length ? unitOf({ kind: 'header', table: statement.table }) : null);

/** config.toml as the sync carries it: without this side's own entries. The text as it is when it does not read. */
export function sharedPart(text) {
  const statements = readToml(text);
  if (!statements) return text;
  const own = ownUnits(statements);
  // A blank line under an own entry's table goes with it, and the end is one newline: what a write here adds and this
  // takes away again leaves the same text, so the sync never sees a change that is not one.
  // A comment holding a key's shape is not sent either.
  const kept = textOf(tidy(statements.filter((s) => !own.has(s.kind === 'blank' ? tableUnit(s) : unitOf(s)) && !(s.kind === 'blank' && credentialOf(s)))));
  return kept.trim() ? `${kept.replace(/\s+$/, '')}\n` : '';
}

/** The shared config.toml written here, with this side's own entries kept in place of any of the same names. */
export function withOwnEntries(shared, local) {
  const statements = (local === null ? [] : readToml(local)) ?? [];
  const own = ownUnits(statements);
  return withEntries(sharedPart(shared), statements.filter((s) => s.kind !== 'blank' && own.has(unitOf(s))));
}

/** Whether a config.toml's text holds a credential, for the console to refuse it: what it is, or null. */
export function configCredential(text) {
  const statements = readToml(text);
  // What the console cannot read it cannot vouch for: a session holds such a file back, and a computer skips it.
  if (!statements) return 'is not TOML the console reads';
  const commands = commandsOf(statements);
  for (const s of statements) {
    const credential = credentialOf(s, commands);
    if (credential) return credential;
  }
  return null;
}

/** config.toml with `dir` trusted, as a session's checkout is. */
export function withTrusted(text, dir) {
  const statements = readToml(text) ?? [];
  const has = statements.some((s) => s.kind === 'kv' && keyText(pathOf(s)) === keyText(['projects', dir, 'trust_level']));
  if (has) return text;
  return compose(text, readToml(`[${keyText(['projects', dir])}]\ntrust_level = "trusted"\n`));
}

if (isMain(import.meta.url) && process.argv[2] === 'trust') {
  const [, , , file, dir] = process.argv;
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  fs.writeFileSync(file, withTrusted(text, dir), { mode: 0o600 });
}
