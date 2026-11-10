// yamlLite: the part of YAML a hand-written config file uses, so Woodshed Cloud can read YAML without a dependency.
//
// Read: mappings and sequences by indentation, `- key: value` items, comments, plain, 'single' and "double" quoted
// scalars, `|` and `>` block text with `-` and `+` chomping, one-line flow `[a, b]` and `{a: 1}` (so JSON reads too),
// null, booleans and numbers as YAML 1.2's core schema has them.
// Refused, with the line: anchors, aliases, tags, `?` keys, directives, more than one document, a plain value over more
// than one line, a repeated key and `__proto__`. A file that needs those is not a config file this reads.

const INDICATORS = new Set(['&', '*', '!', '%', '@', '`']);

function failAt(num, message) {
  throw new Error(`line ${num}: ${message}`);
}

// Where a quoted scalar can start: the line's start, after `- `, `: ` or a flow `[`, `{` or `,`. Elsewhere a quote is
// part of a plain value, as in `A="x"` or `rock 'n roll`.
const QUOTE_OPENS = /^(\s*|(-\s+)+|.*:\s+|.*[[{,]\s*)$/;

// `#` starts a comment at the start of a line or after a space, outside quotes.
function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === '"') {
      if (c === '\\') i++;
      else if (c === '"') quote = null;
    } else if (quote === "'") {
      if (c === "'" && text[i + 1] === "'") i++;
      else if (c === "'") quote = null;
    } else if ((c === '"' || c === "'") && QUOTE_OPENS.test(text.slice(0, i))) {
      quote = c;
    } else if (c === '#' && (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\t')) {
      return text.slice(0, i);
    }
  }
  return text;
}

function resolvePlain(text) {
  if (text === '' || text === '~' || /^(null|Null|NULL)$/.test(text)) return null;
  if (/^(true|True|TRUE)$/.test(text)) return true;
  if (/^(false|False|FALSE)$/.test(text)) return false;
  if (/^0x[0-9a-fA-F]+$/.test(text)) return parseInt(text.slice(2), 16);
  if (/^0o[0-7]+$/.test(text)) return parseInt(text.slice(2), 8);
  if (/^[-+]?\.(inf|Inf|INF)$/.test(text)) return text.startsWith('-') ? -Infinity : Infinity;
  if (/^\.(nan|NaN|NAN)$/.test(text)) return NaN;
  if (/^[-+]?[0-9]+$/.test(text) || /^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(text)) return Number(text);
  return text;
}

const ESCAPES = { '0': '\0', a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\' };

/** A quoted scalar starting at `start`: its value and the index after its closing quote. */
function readQuoted(text, start, num) {
  const quote = text[start];
  let value = '';
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") {
      if (c !== "'") value += c;
      else if (text[i + 1] === "'") value += text[++i];
      else return { value, end: i + 1 };
    } else if (c === '"') {
      return { value, end: i + 1 };
    } else if (c !== '\\') {
      value += c;
    } else {
      const e = text[++i];
      if (e in ESCAPES) value += ESCAPES[e];
      else if (e === 'x' || e === 'u' || e === 'U') {
        const size = { x: 2, u: 4, U: 8 }[e];
        const hex = text.slice(i + 1, i + 1 + size);
        if (!new RegExp(`^[0-9a-fA-F]{${size}}$`).test(hex)) failAt(num, `\\${e} needs ${size} hex digits`);
        value += String.fromCodePoint(parseInt(hex, 16));
        i += size;
      } else failAt(num, `unknown escape \\${e ?? ''}`);
    }
  }
  return failAt(num, `the ${quote === '"' ? 'double' : 'single'} quote is not closed on its line`);
}

// `__proto__` would set the object's prototype rather than a key, so a field could come from it unseen.
function setKey(out, key, value, num) {
  if (key === '__proto__') failAt(num, 'the key __proto__ is not read');
  if (Object.hasOwn(out, key)) failAt(num, `the key ${JSON.stringify(String(key))} is repeated`);
  out[key] = value;
}

function checkPlainStart(text, num) {
  if (INDICATORS.has(text[0])) failAt(num, `\`${text[0]}\` starts an anchor, alias, tag or reserved value, which this does not read: quote the value`);
}

/** One-line flow `[...]` and `{...}`, nested, with quoted and plain scalars. */
function readFlow(text, num) {
  let i = 0;
  const space = () => { while (text[i] === ' ' || text[i] === '\t') i++; };
  function plain(stops) {
    const start = i;
    while (i < text.length && !stops.includes(text[i]) && !(text[i] === ':' && /[\s,[\]{}]|^$/.test(text[i + 1] ?? ''))) i++;
    const raw = text.slice(start, i).trim();
    checkPlainStart(raw, num);
    return raw;
  }
  function scalar(stops) {
    if (text[i] === '"' || text[i] === "'") {
      const { value, end } = readQuoted(text, i, num);
      i = end;
      return value;
    }
    return resolvePlain(plain(stops));
  }
  function value() {
    space();
    if (text[i] === '[') return list();
    if (text[i] === '{') return map();
    return scalar(',]}');
  }
  function list() {
    const out = [];
    i++;
    for (space(); text[i] !== ']'; space()) {
      if (i >= text.length) failAt(num, '`[` is not closed on its line');
      out.push(value());
      space();
      if (text[i] === ',') i++;
      else if (i >= text.length) failAt(num, '`[` is not closed on its line');
      else if (text[i] !== ']') failAt(num, 'expected `,` or `]` in a flow list');
    }
    i++;
    return out;
  }
  function map() {
    const out = {};
    i++;
    for (space(); text[i] !== '}'; space()) {
      if (i >= text.length) failAt(num, '`{` is not closed on its line');
      const key = text[i] === '"' || text[i] === "'" ? scalar('') : plain(',:}');
      space();
      if (text[i] !== ':') failAt(num, `expected \`:\` after ${JSON.stringify(String(key))} in a flow mapping`);
      i++;
      setKey(out, key, value(), num);
      space();
      if (text[i] === ',') i++;
      else if (i >= text.length) failAt(num, '`{` is not closed on its line');
      else if (text[i] !== '}') failAt(num, 'expected `,` or `}` in a flow mapping');
    }
    i++;
    return out;
  }
  const result = value();
  space();
  if (i < text.length) failAt(num, `unexpected \`${text.slice(i, i + 10)}\` after the value`);
  return result;
}

function inlineValue(text, num) {
  if (text[0] === '[' || text[0] === '{') return readFlow(text, num);
  if (text[0] === '"' || text[0] === "'") {
    const { value, end } = readQuoted(text, 0, num);
    if (text.slice(end).trim()) failAt(num, `unexpected \`${text.slice(end).trim()}\` after the quoted value`);
    return value;
  }
  checkPlainStart(text, num);
  if (/^[|>]/.test(text)) failAt(num, 'block text (`|` or `>`) starts its text on the next line');
  if (/^[?] /.test(text)) failAt(num, '`?` keys are not read');
  if (/:(\s|$)/.test(text)) failAt(num, 'a plain value cannot contain `: `: quote it, or use `>` block text');
  return resolvePlain(text);
}

/** `key: rest` or `key:`; null when the line is not a key. */
function splitKey(text, num) {
  if (text[0] === '"' || text[0] === "'") {
    const { value, end } = readQuoted(text, 0, num);
    const after = text.slice(end).match(/^\s*:(\s+|$)/);
    return after ? { key: value, rest: text.slice(end + after[0].length).trim() } : null;
  }
  if (text[0] === '[' || text[0] === '{') return null;
  const colon = text.search(/:(\s|$)/);
  if (colon < 0) return null;
  const key = text.slice(0, colon).trim();
  if (key === '?' || key.startsWith('? ')) failAt(num, '`?` keys are not read');
  checkPlainStart(key, num);
  return { key, rest: text.slice(colon + 1).trim() };
}

const isItem = (text) => text === '-' || text.startsWith('- ');

/**
 * @param {string} source
 * @returns {unknown}  the document; null for an empty one
 * @throws {Error}  `line N: …` for what it cannot read
 */
export function parseYaml(source) {
  const lines = source.replace(/^﻿/, '').split('\n').map((rawLine, i) => {
    const raw = rawLine.replace(/\r$/, '');
    const indent = raw.match(/^ */)[0].length;
    return { num: i + 1, raw, indent, text: stripComment(raw.slice(indent).replace(/^\t+/, '')).trimEnd() };
  });
  let pos = 0;
  let sawDocument = false;

  function peek() {
    while (pos < lines.length) {
      const line = lines[pos];
      if (line.text === '') { pos++; continue; }
      if (/^ *\t/.test(line.raw)) failAt(line.num, 'indent with spaces, not tabs');
      if (line.indent === 0 && /^(---|\.\.\.)(\s|$)/.test(line.text)) {
        if (line.text.startsWith('...') || sawDocument || line.text.slice(3).trim()) failAt(line.num, 'only one document, with nothing after `---`, is read');
        pos++;
        continue;
      }
      if (line.indent === 0 && line.text.startsWith('%')) failAt(line.num, 'directives are not read');
      sawDocument = true;
      return line;
    }
    return null;
  }

  function blockText(parentIndent, header, num) {
    const chomp = header[1] ?? '';
    if (header.length > 2 || !['', '-', '+'].includes(chomp)) failAt(num, `\`${header}\`: block text takes \`${header[0]}\`, \`${header[0]}-\` or \`${header[0]}+\``);
    const body = [];
    let contentIndent = null;
    while (pos < lines.length) {
      const { raw, indent, num: n } = lines[pos];
      if (raw.trim() === '') { body.push(''); pos++; continue; }
      if (indent <= parentIndent) break;
      contentIndent ??= indent;
      if (indent < contentIndent) failAt(n, 'block text is less indented than its first line');
      body.push(raw.slice(contentIndent));
      pos++;
    }
    let trailing = 0;
    while (body.length && body.at(-1) === '') { body.pop(); trailing++; }
    let text;
    if (header[0] === '|') {
      text = body.join('\n');
    } else {
      text = '';
      let breaks = 0;
      let prevMore = false;
      for (const line of body) {
        if (line === '') { breaks++; continue; }
        const more = /^\s/.test(line);
        if (text) text += breaks === 0 ? (more || prevMore ? '\n' : ' ') : '\n'.repeat(more || prevMore ? breaks + 1 : breaks);
        text += line;
        breaks = 0;
        prevMore = more;
      }
    }
    if (!text || chomp === '-') return text;
    return chomp === '+' ? `${text}\n${'\n'.repeat(trailing)}` : `${text}\n`;
  }

  function sequence(indent) {
    const out = [];
    for (let line = peek(); line && line.indent === indent && isItem(line.text); line = peek()) {
      const rest = line.text.slice(1);
      const text = rest.trimStart();
      if (!text) {
        pos++;
        out.push(node(indent));
      } else {
        // The item's own text becomes a line of its own, indented where it starts, so `- key: value` and the keys
        // under it read as one mapping.
        lines[pos] = { ...line, indent: indent + 1 + (rest.length - text.length), text };
        out.push(node(indent));
      }
    }
    const after = peek();
    if (after && after.indent > indent) failAt(after.num, 'unexpected indentation in a list');
    return out;
  }

  function mapping(indent) {
    const out = {};
    for (let line = peek(); line && line.indent === indent; line = peek()) {
      if (isItem(line.text)) failAt(line.num, 'a list item where a key was expected');
      const pair = splitKey(line.text, line.num);
      if (!pair) failAt(line.num, 'expected `key: value`');
      if (Object.hasOwn(out, pair.key)) failAt(line.num, `the key ${JSON.stringify(pair.key)} is repeated`);
      pos++;
      let value;
      if (/^[|>]/.test(pair.rest)) {
        value = blockText(indent, pair.rest, line.num);
      } else if (pair.rest) {
        value = inlineValue(pair.rest, line.num);
        const after = peek();
        if (after && after.indent > indent) failAt(after.num, 'a value continues on this line: put it on one line, or use `|` or `>` block text');
      } else {
        const next = peek();
        value = next && next.indent === indent && isItem(next.text) ? sequence(indent) : node(indent);
      }
      setKey(out, pair.key, value, line.num);
    }
    const after = peek();
    if (after && after.indent > indent) failAt(after.num, 'unexpected indentation');
    return out;
  }

  function node(parentIndent) {
    const line = peek();
    if (!line || line.indent <= parentIndent) return null;
    if (isItem(line.text)) return sequence(line.indent);
    if (/^[|>]/.test(line.text)) {
      pos++;
      return blockText(parentIndent, line.text, line.num);
    }
    if (splitKey(line.text, line.num)) return mapping(line.indent);
    pos++;
    const value = inlineValue(line.text, line.num);
    const after = peek();
    if (after && after.indent > parentIndent) failAt(after.num, 'a value continues on this line: put it on one line, or use `|` or `>` block text');
    return value;
  }

  const document = node(-1);
  const extra = peek();
  if (extra) failAt(extra.num, 'unexpected text after the document');
  return document;
}
