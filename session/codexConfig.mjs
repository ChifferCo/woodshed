// codex's ~/.codex/config.toml, which a person's sessions and computer keep in step (settingsSync.mjs), read as TOML
// statements rather than parsed: the sync only ever leaves some out and puts some back, so each statement's text stays
// as it was written, comments and all.
//
// Each side keeps its own trusted folders, `[projects."<path>"]`: a path on a computer means nothing in a session, and a
// session trusts its own checkout as it starts (`node codexConfig.mjs trust`). So they are never part of what is synced,
// and a write keeps the ones already there.
//
//   node codexConfig.mjs trust <config.toml> <dir>   adds `[projects."<dir>"] trust_level = "trusted"` unless it is there

import fs from 'node:fs';
import { isMain } from '../shared/isMain.mjs';

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
    const raw = text.slice(valueStart, i).replace(/\r?\n$/, '');
    const value = raw.replace(/^[ \t]+/, '').replace(/[ \t]*(#[^\n]*)?$/, '');
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

/** Whether a statement is about a folder this side trusts, which each side keeps its own. */
export function isOwnProject(statement) {
  return statement.kind !== 'blank' && pathOf(statement)[0] === 'projects';
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

/** config.toml as the sync carries it: without this side's trusted folders. The text as it is when it does not read. */
export function sharedPart(text) {
  const statements = readToml(text);
  if (!statements) return text;
  // A blank line under a trusted folder's table goes with it, and the end is one newline: what a write here adds and
  // this takes away again leaves the same text, so the sync never sees a change that is not one.
  const kept = textOf(tidy(statements.filter((s) => !isOwnProject(s) && !(s.kind === 'blank' && s.table[0] === 'projects'))));
  return kept.trim() ? `${kept.replace(/\s+$/, '')}\n` : '';
}

/** The shared config.toml written here, with this side's trusted folders kept. */
export function withOwnProjects(shared, local) {
  const statements = local === null ? [] : readToml(local);
  return compose(sharedPart(shared), (statements ?? []).filter(isOwnProject));
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
