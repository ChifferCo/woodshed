import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// The skills in .claude/skills/ send an agent to Woodshed's runbooks rather than copy them, so what they point at must
// stay there: each file they name, each section they quote, and each skill they hand over to. A renamed heading or a
// moved file then fails here instead of leaving an agent to look for it.
const WOODSHED = path.resolve(import.meta.dirname, '..');
const SKILLS = path.join(WOODSHED, '.claude/skills');

const skills = fs.readdirSync(SKILLS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

function read(name) {
  const text = fs.readFileSync(path.join(SKILLS, name, 'SKILL.md'), 'utf8');
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(m, `${name}: SKILL.md starts with a --- frontmatter block`);
  const meta = Object.fromEntries(m[1].split('\n').map((line) => {
    const at = line.indexOf(': ');
    return [line.slice(0, at), line.slice(at + 2)];
  }));
  return { meta, body: m[2] };
}

function headings(file) {
  return fs.readFileSync(path.join(WOODSHED, file), 'utf8').split('\n')
    .filter((line) => /^#{1,4} /.test(line)).map((line) => line.replace(/^#+ /, ''));
}

// A repo path in backticks: a folder and a file with an extension, or a root file, with nothing to fill in (`<repo>`).
const PATH = /`((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:md|mjs|yaml|yml|json|sh))`/g;
// `file`, "Section" and `file`, "Section" and "Other": the sections a skill quotes, each a heading of that file.
const SECTIONS = /`([A-Za-z0-9_./-]+\.md)`,\s+((?:"[^"]+"(?:,\s+|\s+and\s+)?)+)/g;

test('there are skills, each with a name matching its folder and a description to be found by', () => {
  assert.ok(skills.length >= 3, skills.join(', '));
  for (const name of skills) {
    const { meta } = read(name);
    assert.equal(meta.name, name, `${name}: name`);
    assert.ok(meta.description && meta.description.length >= 80 && meta.description.length <= 1024, `${name}: description`);
  }
});

test('every file a skill names is in this checkout', () => {
  for (const name of skills) {
    const { body } = read(name);
    for (const [, file] of body.matchAll(PATH)) {
      if (!file.includes('/') && !fs.existsSync(path.join(WOODSHED, file))) continue; // a file of the person's repo, such as `package-lock.json`
      assert.ok(fs.existsSync(path.join(WOODSHED, file)), `${name} names ${file}`);
    }
  }
});

test('every section a skill quotes is a heading of the file it names', () => {
  let quoted = 0;
  for (const name of skills) {
    const { body } = read(name);
    for (const [, file, list] of body.replace(/\n/g, ' ').matchAll(SECTIONS)) {
      const have = headings(file);
      for (const [, section] of list.matchAll(/"([^"]+)"/g)) {
        quoted += 1;
        assert.ok(have.includes(section), `${name}: ${file} has no heading "${section}"`);
      }
    }
  }
  assert.ok(quoted >= 10, `sections checked: ${quoted}`);
});

test('every skill a skill hands over to exists', () => {
  for (const name of skills) {
    const { body } = read(name);
    for (const [, other] of body.matchAll(/the `([a-z-]+)` skill/g)) assert.ok(skills.includes(other), `${name} hands over to ${other}`);
  }
});
