// The edit `woodshed review enable` makes to a repo's .woodshed/project.yaml: its pull requests reviewed in a Woodshed
// session (pullRequests.review.runner: woodshed), and with --qa tested in one (pullRequests.qa.runner: woodshed). It
// changes those lines and nothing else: every other line, comment and the order of the file stay as they were, and the
// result is read back to prove the rest of the project reads the same.
//
// `author` and `commentAuthor` are not written: with the session runner the console fills them in with its reviewer
// App's and its own App's logins (console/reviewLogins.mjs), so renaming either App needs no change here. Moving from
// the Actions runner drops the lines that belonged to it (`workflow`, and the `author` and `commentAuthor` of the
// workflow's bot), which would otherwise be trusted in place of the console's Apps. The workflow file itself is left
// alone: nothing here writes or removes a GitHub workflow.

import { parseProject } from '../shared/project.mjs';
import { parseYaml, stripComment } from '../shared/yamlLite.mjs';

export const DEFAULT_HEADING = '## Woodshed review';
export const DEFAULT_RERUN = '[woodshed-review]';
export const QA_DEFAULTS = Object.freeze({ check: 'QA', label: 'woodshed-qa', heading: '## QA' });

const KEY_RE = (key) => new RegExp(`^( *)${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(?=\\s|$)(.*)$`);
const isFiller = (line) => /^\s*(#.*)?$/.test(line);
const indentOf = (line) => /^ */.exec(line)[0].length;

/** A scalar as YAML writes it: plain when it is a plain word, else single-quoted. */
export function yamlScalar(value) {
  const text = String(value);
  return /^[A-Za-z0-9][A-Za-z0-9_.\-/]*$/.test(text) && !/^(true|false|null|yes|no|on|off|~)$/i.test(text) && !/^[0-9.]+$/.test(text)
    ? text : `'${text.replace(/'/g, "''")}'`;
}

function unitOf(lines) {
  const indents = lines.filter((l) => !isFiller(l)).map(indentOf).filter((n) => n > 0);
  return indents.length ? Math.min(...indents) : 2;
}

/**
 * Where a key's block ends: the first line after it that is content at its indent or less. Comments and blank lines
 * just before that belong to what follows, unless they are indented under the key.
 */
function blockEnd(lines, at, indent, end) {
  let j = at + 1;
  while (j < end && (isFiller(lines[j]) || indentOf(lines[j]) > indent)) j += 1;
  while (j > at + 1 && isFiller(lines[j - 1]) && (lines[j - 1].trim() === '' || indentOf(lines[j - 1]) <= indent)) j -= 1;
  return j;
}

// In a block scalar, even an indented comment is part of the value. A dedented comment ends the value.
function blockScalarEnd(lines, at, indent, end) {
  let j = at + 1;
  while (j < end && (!lines[j].trim() || indentOf(lines[j]) > indent)) j += 1;
  while (j > at + 1 && !lines[j - 1].trim()) j -= 1;
  return j;
}

/** @returns {{at: number, end: number, indent: number, value: string, comment: string, blockScalar: boolean}|null} */
function findKey(lines, start, end, indent, key) {
  const re = KEY_RE(key);
  for (let i = start; i < end; i += 1) {
    if (isFiller(lines[i])) continue;
    const m = re.exec(lines[i]);
    if (m && m[1].length === indent) {
      const raw = stripComment(m[2]);
      const value = raw.trim();
      const comment = raw.length < m[2].length ? m[2].slice(raw.trimEnd().length) : '';
      const blockScalar = /^[|>]/.test(value);
      const endOfKey = blockScalar ? blockScalarEnd(lines, i, indent, end) : blockEnd(lines, i, indent, end);
      return { at: i, end: endOfKey, indent, value, comment, blockScalar };
    }
  }
  return null;
}

// The indent of a block's keys: its first content line's, else one step in.
function childIndent(lines, block, unit) {
  for (let i = block.at + 1; i < block.end; i += 1) if (!isFiller(lines[i])) return indentOf(lines[i]);
  return block.indent + unit;
}

/**
 * The text with pullRequests.review (and with `qa`, pullRequests.qa) run in Woodshed sessions.
 * @param {string|null} text  the project file, or null for none yet
 * @param {{qa?: boolean, rerun?: string|null, everyCommit?: boolean}} [options]  `rerun`: the tag a commit's message
 *   carries to be reviewed (default DEFAULT_RERUN, or the file's own); `everyCommit` reviews each commit, with no tag
 * @returns {{text: string, changes: string[], created: boolean}}  `changes` says each change in words; none when the file
 *   already says it
 * @throws {Error}  when the file does not read as a project, or is written in a way this does not edit (inline)
 */
export function enableReview(text, { qa = false, rerun = null, everyCommit = false } = {}) {
  const created = text === null || text === undefined;
  const source = created ? 'version: 1\n' : String(text);
  let before;
  try {
    before = parseProject(parseYaml(source));
  } catch (err) {
    throw new Error(`.woodshed/project.yaml does not read as a project file, so it was not changed: ${err.message}`);
  }
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const unit = unitOf(lines);
  const changes = [];

  // A mapping key under `parent`, made a block when it is missing or written as none.
  function ensureBlock(parent, key, comment = null) {
    const start = parent ? parent.at + 1 : 0;
    const end = parent ? parent.end : lines.length;
    const indent = parent ? childIndent(lines, parent, unit) : 0;
    const found = findKey(lines, start, end, indent, key);
    if (found) {
      if (found.value === '') return found;
      if (!/^(null|~|\{\s*\})$/.test(found.value)) throw new Error(`${key} is written inline (${found.value.slice(0, 40)}): write it as a block, one key a line, and run this again`);
      lines[found.at] = `${' '.repeat(indent)}${key}:${found.comment}`;
      return findKey(lines, start, parent ? parent.end : lines.length, indent, key);
    }
    let at = parent ? blockEnd(lines, parent.at, parent.indent, lines.length) : lines.length;
    const added = [...(comment ? [`${' '.repeat(indent)}# ${comment}`] : []), `${' '.repeat(indent)}${key}:`];
    if (!parent && lines.length && lines.at(-1).trim() !== '') added.unshift('');
    lines.splice(at, 0, ...added);
    at += added.length - 1;
    return { at, end: at + 1, indent, value: '' };
  }

  // Replace a scalar under `block`, preserving its header comment, or add a line at the end of the block.
  function setKey(block, key, value) {
    const indent = childIndent(lines, block, unit);
    const found = findKey(lines, block.at + 1, block.end, indent, key);
    const written = yamlScalar(value);
    if (found) {
      const oldLines = found.blockScalar ? found.end - found.at : 1;
      lines.splice(found.at, oldLines, `${' '.repeat(indent)}${key}: ${written}${found.comment}`);
      return;
    }
    lines.splice(block.end, 0, `${' '.repeat(indent)}${key}: ${written}`);
  }

  function removeKey(block, key, { keepComment = false } = {}) {
    const indent = childIndent(lines, block, unit);
    const found = findKey(lines, block.at + 1, block.end, indent, key);
    if (!found) return false;
    const kept = keepComment && found.comment ? [`${' '.repeat(indent)}${found.comment.trimStart()}`] : [];
    lines.splice(found.at, found.end - found.at, ...kept);
    return true;
  }

  const refind = (path) => {
    let block = null;
    for (const key of path) {
      const start = block ? block.at + 1 : 0;
      const end = block ? block.end : lines.length;
      const indent = block ? childIndent(lines, block, unit) : 0;
      block = findKey(lines, start, end, indent, key);
      if (!block) return null;
    }
    return block;
  };

  const was = before.pullRequests?.review ?? null;
  ensureBlock(null, 'pullRequests');
  ensureBlock(refind(['pullRequests']), 'review', was ? null : 'Each pull request reviewed in a Woodshed session; the console posts the verdict as its reviewer App.');
  const review = () => refind(['pullRequests', 'review']);
  if (was?.runner !== 'woodshed') {
    setKey(review(), 'runner', 'woodshed');
    changes.push(was ? `pullRequests.review.runner: woodshed, from ${was.runner}` : 'pullRequests.review with runner: woodshed');
    if (was) {
      for (const key of ['workflow', 'author', 'commentAuthor']) {
        if (removeKey(review(), key)) changes.push(`pullRequests.review.${key} taken out: it was the Actions review's, and the console fills in its own Apps`);
      }
    }
  }
  if (!was?.heading) {
    setKey(review(), 'heading', DEFAULT_HEADING);
    if (was) changes.push(`pullRequests.review.heading: ${DEFAULT_HEADING}`);
  }
  if (everyCommit) {
    if (removeKey(review(), 'rerun', { keepComment: true })) changes.push('pullRequests.review.rerun taken out: each new commit is reviewed');
  } else {
    const tag = rerun ?? was?.rerun ?? DEFAULT_RERUN;
    if (tag !== was?.rerun) {
      setKey(review(), 'rerun', tag);
      changes.push(`pullRequests.review.rerun: ${tag}${was?.rerun ? `, from ${was.rerun}` : ''}`);
    }
  }

  if (qa) {
    const wasQa = before.pullRequests?.qa ?? null;
    ensureBlock(refind(['pullRequests']), 'qa', wasQa ? null : 'Tested in a Woodshed session once the review approves, when the label goes on a pull request.');
    const qaBlock = () => refind(['pullRequests', 'qa']);
    if (!wasQa) {
      for (const [key, value] of [['runner', 'woodshed'], ['check', QA_DEFAULTS.check], ['label', QA_DEFAULTS.label], ['heading', QA_DEFAULTS.heading]]) setKey(qaBlock(), key, value);
      changes.push(`pullRequests.qa with runner: woodshed, label ${QA_DEFAULTS.label}`);
    } else if (wasQa.runner !== 'woodshed') {
      setKey(qaBlock(), 'runner', 'woodshed');
      changes.push(`pullRequests.qa.runner: woodshed, from ${wasQa.runner}`);
      if (removeKey(qaBlock(), 'author')) changes.push('pullRequests.qa.author taken out: a QA session reports in the console\'s check, not a bot\'s comment');
    }
  }

  const out = `${lines.join(eol)}${eol}`;
  // Read back: the review is on, and nothing else of the project reads otherwise.
  let after;
  try {
    after = parseProject(parseYaml(out));
  } catch (err) {
    throw new Error(`the edit did not read back as a project file, so nothing was written: ${err.message}`);
  }
  const { pullRequests: gatesBefore, ...restBefore } = before;
  const { pullRequests: gatesAfter, ...restAfter } = after;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (gatesAfter?.review?.runner !== 'woodshed' || (qa && gatesAfter?.qa?.runner !== 'woodshed') || !same(restBefore, restAfter)
    || !same(gatesBefore?.suites ?? [], gatesAfter.suites) || !same(gatesBefore?.mergeRisk ?? null, gatesAfter.mergeRisk) || !same(gatesBefore?.runsOn ?? null, gatesAfter.runsOn ?? null)
    || (!qa && !same(gatesBefore?.qa ?? null, gatesAfter.qa))) {
    throw new Error('the edit changed more than the review, so nothing was written: edit .woodshed/project.yaml by hand (project.reference.yaml, pullRequests.review)');
  }
  if (created) changes.unshift('.woodshed/project.yaml made, with version: 1');
  return { text: changes.length ? out : source, changes, created };
}
