// A person's own lines for a few of a session's dotfiles, kept on My settings as tmux's are (console/userSettings.mjs)
// and set there or from their computer (`woodshed settings push`, cli/settings.mjs). Their private sessions alone write
// them, after what the image or the session's start wrote (session/entrypoint.sh, fetchOwnerSettings).
//
// Each holds less than the file it is named for, on purpose. A session's git identity and credential helper are its
// start's (the owner's GitHub account, githubToken.sh), its shell's environment is its own, and nothing a person keeps
// on a computer for that computer (a path in its home, a signing key, a credential) is any use in a session or safe in
// one. So:
//
//   gitconfig      the sections and keys GIT_KEYS lists: aliases, colors, and how diff, merge, pull, push and the like
//                  behave. Never [user], [credential], [url], [http], [include], [gpg], a pager or an editor
//   inputrc        readline's own lines; `$include` only of a file under /etc
//   bash-aliases   `alias name=value` lines alone, never an export or a command
//
// dotfileProblem is what the console refuses a save with. fromComputer is what a computer's own file gives, with what was
// left out named: a credential there is left out rather than refused, so the rest still goes.

import path from 'node:path';
import { redact, secretContent, shellCredential } from './secretLike.mjs';

export const DOTFILES = Object.freeze({
  gitconfig: { label: '~/.gitconfig', from: ['.gitconfig'] },
  inputrc: { label: '~/.inputrc', from: ['.inputrc'] },
  // A Mac's shell is zsh: its plain aliases are bash's too.
  'bash-aliases': { label: '~/.bash_aliases', from: ['.bash_aliases', '.bashrc', '.zshrc'] },
});

// `*` for every key of the section. A section with a subsection ([color "diff"]) only where the list says so.
const GIT_KEYS = {
  alias: '*',
  advice: '*',
  color: '*',
  branch: ['sort', 'autosetuprebase', 'autosetupmerge'],
  column: ['ui'],
  commit: ['verbose'],
  core: ['autocrlf', 'whitespace', 'quotepath', 'abbrev', 'safecrlf', 'eol'],
  // Never mnemonicPrefix or noPrefix: the Diff and Review tabs read `git diff`'s a/ and b/.
  diff: ['algorithm', 'colormoved', 'colormovedws', 'renames', 'context', 'indentheuristic', 'submodule'],
  fetch: ['prune', 'prunetags', 'parallel'],
  grep: ['linenumber', 'patterntype'],
  help: ['autocorrect'],
  init: ['defaultbranch'],
  log: ['date', 'decorate', 'abbrevcommit', 'follow'],
  merge: ['conflictstyle', 'ff', 'stat', 'log'],
  pull: ['rebase', 'ff'],
  push: ['default', 'autosetupremote', 'followtags'],
  rebase: ['autosquash', 'autostash', 'updaterefs', 'stat'],
  rerere: ['enabled', 'autoupdate'],
  // Never showUntrackedFiles: the Diff tab and the stop's checkpoint read `git status --porcelain` for new files.
  status: ['short', 'branch', 'submodulesummary', 'showstash'],
  tag: ['sort'],
};
const GIT_SUBSECTIONS = new Set(['color']);

const HEADER_RE = /^\s*\[([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\\n]|\\.)*)")?\]\s*(?:[#;].*)?$/;
const KEY_RE = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*(?:=(.*))?$/;
const COMMENT_RE = /^\s*(?:[#;].*)?$/;

/** A gitconfig's lines as sections and keys, continuations joined. null at a line it cannot read. */
function gitLines(text) {
  const raw = text.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let section = null;
  for (let i = 0; i < raw.length; i++) {
    const number = i + 1;
    let line = raw[i];
    // A comment never goes on to the next line, whatever it ends with: only a value does.
    if (!COMMENT_RE.test(line)) {
      while (/\\$/.test(line) && !/\\\\$/.test(line) && i + 1 < raw.length) line = `${line.slice(0, -1)}${raw[++i]}`;
    }
    if (COMMENT_RE.test(line)) {
      out.push({ number, kind: 'comment', text: line });
      continue;
    }
    const header = HEADER_RE.exec(line);
    if (header) {
      // [section.sub] is the old way to write [section "sub"].
      const [name, ...rest] = header[1].split('.');
      section = { name: name.toLowerCase(), sub: header[2] ?? (rest.length ? rest.join('.') : null), text: line.trim() };
      out.push({ number, kind: 'header', section, text: line });
      continue;
    }
    const kv = KEY_RE.exec(line);
    if (!kv) return { error: `line ${number} is not a section, a key or a comment` };
    // git would not read the file past a quote left open, the start's identity and credential helper with it.
    const syntax = kv[2] === undefined ? null : valueSyntax(kv[2]);
    if (syntax) return { error: `line ${number}: ${syntax}` };
    // A key with no `=` is a boolean that is true: written back the same way, never as `key = `, which is false.
    out.push({ number, kind: 'key', section, key: kv[1].toLowerCase(), value: kv[2] ?? '', bare: kv[2] === undefined, text: line });
  }
  return { lines: out };
}

// A section as a message names it: a subsection's name can be a URL with a token in it ([url "https://<token>@..."]), so
// only the section's own name is ever shown.
/** A git value as git reads it, without a comment after it (outside quotes). */
function beforeComment(value) {
  let open = false;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\\') i++;
    else if (value[i] === '"') open = !open;
    else if (!open && (value[i] === '#' || value[i] === ';')) return value.slice(0, i);
  }
  return value;
}

/** What git would refuse in a value, before any comment: a double quote left open, or an escape it does not know. */
function valueSyntax(value) {
  let open = false;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\\') {
      if (i + 1 >= value.length || !'\\"ntb'.includes(value[i + 1])) return 'an escape git does not read (\\\\, \\", \\n, \\t, \\b)';
      i++;
    } else if (value[i] === '"') open = !open;
    else if (!open && (value[i] === '#' || value[i] === ';')) break;
  }
  return open ? 'a quote is left open' : null;
}

/** An `$include` line of inputrc that names a file a session has: under /etc, once `..` is resolved. */
function systemInclude(line) {
  const m = /^\s*\$include\s+(\S+)\s*$/.exec(line);
  return Boolean(m) && path.posix.normalize(m[1]).startsWith('/etc/');
}

const sectionName = (section) => (section.sub === null ? `[${section.name}]` : `[${section.name} "..."]`);
// As it is written back: a subsection only ever of a section that takes one (GIT_SUBSECTIONS), whose name holds no URL.
const sectionText = (section) => (section.sub === null ? `[${section.name}]` : `[${section.name} "${section.sub}"]`);

function gitSectionAllowed(section) {
  return Boolean(section && GIT_KEYS[section.name] && (section.sub === null || GIT_SUBSECTIONS.has(section.name)));
}

function gitKeyAllowed(section, key) {
  const keys = GIT_KEYS[section.name];
  return keys === '*' || keys.includes(key);
}

/** Why a value an allowed key holds is still not taken, or null: color always, which puts color codes in output tools read. */
function gitValueProblem(section, value) {
  return section.name === 'color' && /^\s*"?always"?\s*$/i.test(beforeComment(value)) ? 'always, which colors output that the session\'s tools read: auto does what you see' : null;
}

// An alias's value: one shell word, quoted or not, with no command substitution, which runs as the file is read, and
// nothing after it, which would too.
const ALIAS_RE = /^\s*alias\s+(?!-)([A-Za-z0-9_.:+@%,-]+)=('[^']*'|"(?:[^"\\`$]|\\.|\$(?![({]))*"|[^\s'"`;&|<>()$\\]+)\s*(?:#.*)?$/;

/** @returns {{name: string, value: string}|null}  a plain alias line's alias */
export function aliasOf(line) {
  const m = ALIAS_RE.exec(line);
  return m ? { name: m[1], value: m[2] } : null;
}

/**
 * Why the console refuses these lines for `key`, naming the line and what is wrong with it, never a value. null when they
 * are fine; empty text always is (it clears them).
 * @param {string} key
 * @param {string} text
 * @returns {string|null}
 */
export function dotfileProblem(key, text) {
  if (!DOTFILES[key]) return `no file called ${key}`;
  // Every line, comments and section names too: what is saved is written whole into the session.
  for (const [i, line] of text.replace(/\r\n/g, '\n').split('\n').entries()) {
    const kind = secretContent(line);
    if (kind) return `line ${i + 1} holds what looks like ${kind}: credentials stay off sessions`;
  }
  if (key === 'gitconfig') {
    const read = gitLines(text);
    if (read.error) return read.error;
    for (const line of read.lines) {
      if (line.kind === 'header' && !gitSectionAllowed(line.section)) {
        return `line ${line.number}: ${sectionName(line.section)} is not one a session takes. Aliases, colors and how diff, merge, pull, push, rebase and the like behave are; your session's git identity and credentials are its own`;
      }
      if (line.kind !== 'key') continue;
      if (!line.section) return `line ${line.number}: ${line.key} is in no section`;
      if (!gitKeyAllowed(line.section, line.key)) return `line ${line.number}: ${line.section.name}.${line.key} is not one a session takes`;
      const credential = shellCredential(line.value);
      if (credential) return `line ${line.number}: ${line.section.name}.${line.key} holds ${credential}: credentials stay off sessions`;
      const value = gitValueProblem(line.section, line.value);
      if (value) return `line ${line.number}: ${line.section.name}.${line.key} is ${value}`;
    }
    return null;
  }
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (const [i, line] of lines.entries()) {
    if (COMMENT_RE.test(line)) continue;
    const credential = shellCredential(line);
    if (credential) return `line ${i + 1} holds ${credential}: credentials stay off sessions`;
    if (key === 'inputrc') {
      if (/^\s*\$include\b/.test(line) && !systemInclude(line)) return `line ${i + 1}: $include of a file a session does not have`;
      continue;
    }
    if (!aliasOf(line)) {
      return /^\s*(export|declare|typeset)\b/.test(line)
        ? `line ${i + 1} sets a variable: only alias lines are taken, since a session's environment is its own`
        : `line ${i + 1} is not an alias line (alias name='value', one to a line, with nothing run as it is read)`;
    }
  }
  return null;
}

/**
 * A computer's own files as the lines for `key`: what a session takes of them, and what was left out, by name.
 * @param {string} key
 * @param {Record<string, string>} files  each of DOTFILES[key].from there is, by its name in the home
 * @param {{home: string}} opts  the computer's home: a value naming a path in it is left out
 * @returns {{text: string, left: string[]}}
 */
export function fromComputer(key, files, { home }) {
  const left = [];
  const leave = (what) => {
    const shown = redact(what);
    if (!left.includes(shown)) left.push(shown);
  };
  const namesHome = (value) => value.includes(`${home}/`) || /(^|[\s'"=:])(~|\$HOME|\$\{HOME\})\//.test(value);
  if (key === 'gitconfig') {
    const read = gitLines(files['.gitconfig'] ?? '');
    if (read.error) return { text: '', left: [`all of it: ${read.error}`] };
    const sections = [];
    let current = null;
    for (const line of read.lines) {
      if (line.kind === 'header') {
        current = gitSectionAllowed(line.section) ? { header: line.section, lines: [] } : null;
        if (current) sections.push(current);
        else leave(sectionName(line.section));
      } else if (line.kind === 'key' && current) {
        const name = `${line.section.name}.${line.key}`;
        const credential = shellCredential(line.value);
        if (!gitKeyAllowed(line.section, line.key)) leave(name);
        else if (credential) leave(`${name} (${credential})`);
        else if (gitValueProblem(line.section, line.value)) leave(`${name} (always)`);
        else if (namesHome(line.value)) leave(`${name} (names a path on this computer)`);
        else current.lines.push(line.bare ? `\t${line.key}` : `\t${line.key} = ${line.value.trim()}`);
      }
    }
    const text = sections.filter((s) => s.lines.length).map((s) => `${sectionText(s.header)}\n${s.lines.join('\n')}\n`).join('');
    return { text, left };
  }
  if (key === 'inputrc') {
    const kept = [];
    for (const line of (files['.inputrc'] ?? '').replace(/\r\n/g, '\n').split('\n')) {
      const credential = shellCredential(line);
      if (credential) leave(`a line holding ${credential}`);
      else if (/^\s*\$include\b/.test(line) && !systemInclude(line)) leave('$include of a file on this computer');
      else kept.push(line);
    }
    const text = kept.join('\n').replace(/\s+$/, '');
    return { text: text ? `${text}\n` : '', left };
  }
  // Aliases, the later file's winning where two name the same one, as the shell that reads both would have it.
  const aliases = new Map();
  let other = 0;
  for (const name of DOTFILES[key].from) {
    for (const line of (files[name] ?? '').replace(/\r\n/g, '\n').split('\n')) {
      if (COMMENT_RE.test(line)) continue;
      const alias = aliasOf(line);
      if (!alias) {
        other += 1;
        continue;
      }
      const credential = secretContent(alias.name) ?? shellCredential(alias.value);
      aliases.delete(alias.name);
      if (credential) leave(`alias ${alias.name} (${credential})`);
      else if (namesHome(alias.value)) leave(`alias ${alias.name} (names a path on this computer)`);
      else aliases.set(alias.name, `alias ${alias.name}=${alias.value}`);
    }
  }
  if (other) leave(`${other} line${other === 1 ? '' : 's'} that ${other === 1 ? 'is' : 'are'} not alias lines`);
  return { text: aliases.size ? `${[...aliases.values()].join('\n')}\n` : '', left };
}
