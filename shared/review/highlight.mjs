// Minimal syntax highlighting for the diff viewer.
//
// This has to work with zero dependencies in two places at once: server-side
// under `node --test`, and inside the review page's client script. The page is
// an inlined template literal, so rather than maintaining two copies,
// page.mjs interpolates `tokenizeLine.toString()` into the script it serves.
//
// That inlining imposes a hard constraint: **tokenizeLine must be entirely
// self-contained**. A reference to any module-scope constant survives
// `node --check` (the text parses fine) and then throws ReferenceError in the
// browser. Everything it needs is therefore declared inside its own body, and
// highlight.test.mjs round-trips it through `new Function` to prove it.
//
// What it deliberately does NOT attempt: regex literals, JSX, and template
// interpolation. A `/` is an operator unless followed by `/` or `*`, so a
// regex literal is left as plain code rather than mis-coloured. Wrong colours
// are worse than none — one mis-closed string paints the next forty lines and
// you stop trusting the view.

/**
 * Split a single line of source into coloured spans.
 *
 * @param {string} text  one line, no trailing newline
 * @param {'c'|'h'|'q'|''} dialect  'c' = C-family (slash comments + quotes),
 *   'h' = hash-comment family, 'q' = SQL (double-dash comments, SQL keywords),
 *   '' = no highlighting
 * @returns {Array<{cls: string, text: string}>} spans in source order; `cls`
 *   is 'c' (comment), 's' (string), 'k' (keyword) or '' (plain code)
 */
export function tokenizeLine(text, dialect) {
  if (!text || !dialect) return [{ cls: '', text: text || '' }];

  // Declared inside the function body on purpose — see the note above about
  // `.toString()` inlining. A free variable here would ship a broken page.
  var KEYWORDS =
    /\b(?:abstract|as|async|await|boolean|break|case|catch|class|const|constructor|continue|debugger|declare|default|delete|do|elif|else|enum|export|extends|false|finally|for|from|func|function|get|global|if|implements|import|in|instanceof|interface|is|lambda|let|namespace|new|nil|none|null|of|package|private|protected|public|readonly|return|satisfies|self|set|static|super|switch|this|throw|true|try|type|typeof|undefined|var|void|while|with|yield)\b/g;
  var SQL_KEYWORDS =
    /\b(?:ALTER|AND|AS|BY|CREATE|DELETE|DROP|FROM|GROUP|HAVING|INDEX|INNER|INSERT|INTO|JOIN|LEFT|LIMIT|NOT|NULL|ON|OR|ORDER|SELECT|SET|TABLE|UNION|UPDATE|VALUES|WHERE)\b/gi;

  // The one concession to cross-line state, made without keeping any: a line
  // whose first non-space character is `*` is a JSDoc/block-comment
  // continuation. Measured on this repo, this single rule takes the mis-colour
  // rate on backend TypeScript from 1.05% to 0.15%, because every apostrophe
  // in every doc comment ("don't", "the user's") otherwise opens a string that
  // never closes. It misfires only on a line continuing a multiplication,
  // which is far rarer here than a doc comment.
  if (dialect === 'c' && /^\s*\*/.test(text)) return [{ cls: 'c', text: text }];

  var spans = [];
  var plain = '';

  function flushPlain() {
    if (!plain) return;
    // Keywords are only ever looked for in text the scanner already decided is
    // code, so a keyword inside a string or comment can never be recoloured.
    var re = dialect === 'q' ? SQL_KEYWORDS : KEYWORDS;
    re.lastIndex = 0;
    var at = 0;
    var m = re.exec(plain);
    while (m) {
      if (m.index > at) spans.push({ cls: '', text: plain.slice(at, m.index) });
      spans.push({ cls: 'k', text: m[0] });
      at = m.index + m[0].length;
      m = re.exec(plain);
    }
    if (at < plain.length) spans.push({ cls: '', text: plain.slice(at) });
    plain = '';
  }

  var hashComments = dialect === 'h';
  var sql = dialect === 'q';
  var i = 0;
  while (i < text.length) {
    var ch = text[i];
    var next = i + 1 < text.length ? text[i + 1] : '';

    if (sql && ch === '-' && next === '-') {
      flushPlain();
      spans.push({ cls: 'c', text: text.slice(i) });
      return spans;
    }

    if (hashComments && ch === '#') {
      flushPlain();
      spans.push({ cls: 'c', text: text.slice(i) });
      return spans;
    }

    if (!hashComments && ch === '/' && next === '/') {
      flushPlain();
      spans.push({ cls: 'c', text: text.slice(i) });
      return spans;
    }

    if (!hashComments && ch === '/' && next === '*') {
      flushPlain();
      var close = text.indexOf('*/', i + 2);
      // An unterminated block comment means the rest of THIS line is comment.
      // No state carries to the next line — that is the documented limitation.
      var end = close === -1 ? text.length : close + 2;
      spans.push({ cls: 'c', text: text.slice(i, end) });
      i = end;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      flushPlain();
      var j = i + 1;
      var closed = false;
      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === ch) {
          closed = true;
          j += 1;
          break;
        }
        j += 1;
      }
      // Unterminated: colour to end of line rather than guessing.
      spans.push({ cls: 's', text: text.slice(i, closed ? j : text.length) });
      i = closed ? j : text.length;
      continue;
    }

    plain += ch;
    i += 1;
  }

  flushPlain();
  return spans;
}

/**
 * Map a file path to the tokenizer dialect it should be read with.
 * Unknown extensions get '' (no highlighting), which is the safe default.
 */
export function dialectForPath(filePath) {
  const name = String(filePath || '').toLowerCase();
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  // A dotless name is matched whole, so `Dockerfile` and `.gitignore` resolve.
  const suffix = dot <= 0 ? base.replace(/^\./, '') : base.slice(dot + 1);

  if (C_FAMILY.has(suffix)) return 'c';
  if (HASH_FAMILY.has(suffix)) return 'h';
  if (suffix === 'sql') return 'q';
  return '';
}

const C_FAMILY = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc',
  'css', 'scss', 'less', 'java', 'go', 'rs', 'c', 'h', 'cc', 'cpp', 'hpp',
  'kt', 'swift', 'php', 'cs', 'scala', 'proto',
]);

const HASH_FAMILY = new Set([
  'yml', 'yaml', 'sh', 'bash', 'zsh', 'py', 'rb', 'toml', 'ini', 'cfg',
  'conf', 'env', 'gitignore', 'dockerfile', 'mk', 'tf',
]);
