import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// skills/woodshed/SKILL.md teaches agents the `woodshed` command line, and its table says which change each command
// arrives in: "main", or the pull request that adds it. An agent trusts it, so it must say what this checkout's CLI does:
// a command marked main that the CLI does not list fails here, and so does one the CLI lists that the skill still says
// is on its way, so the change that adds a command updates its row.
const WOODSHED = path.resolve(import.meta.dirname, '..');
const SKILL = path.join(WOODSHED, 'skills/woodshed/SKILL.md');
const CLI = path.join(WOODSHED, 'cli/woodshed.mjs');

const text = fs.readFileSync(SKILL, 'utf8');
const [, front, body] = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/) ?? [];

function help(...words) {
  try {
    return execFileSync(process.execPath, [CLI, ...words, '--help'], { encoding: 'utf8', env: { ...process.env, WOODSHED_CONSOLE: '' } });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

// The commands `woodshed --help` lists: two spaces, then the command's name at the start of its line.
const top = new Set([...help().matchAll(/^ {2}([a-z]+)\b/gm)].map((m) => m[1]));

// Each row of the skill's command table: `woodshed <command> [<sub>] …` | does | exits | arrives in.
const rows = [...body.matchAll(/^\| `woodshed ([a-z]+)(?: ([a-z]+))?[^`]*` \|.*\| ([^|]+) \|$/gm)]
  .map(([line, command, sub, arrives]) => ({ line, command, sub, arrives: arrives.trim() }));

test('the skill has a name, and a description an agent finds it by', () => {
  assert.ok(front, 'SKILL.md starts with a --- frontmatter block');
  const meta = Object.fromEntries(front.split('\n').map((line) => [line.slice(0, line.indexOf(': ')), line.slice(line.indexOf(': ') + 2)]));
  assert.equal(meta.name, 'woodshed');
  assert.ok(meta.description.length >= 80 && meta.description.length <= 1024, meta.description);
});

test('the skill lists the commands, each marked main or with the pull request that adds it', () => {
  assert.ok(rows.length >= 10, `rows: ${rows.length}`);
  for (const row of rows) assert.match(row.arrives, /^main$|#\d+/, row.line);
  for (const command of ['login', 'status']) assert.ok(rows.some((r) => r.command === command), command);
});

test('a command the skill marks main is one this checkout\'s CLI has', () => {
  for (const row of rows.filter((r) => r.arrives === 'main')) {
    assert.ok(top.has(row.command), `woodshed --help has no ${row.command}: ${row.line}`);
    // A subcommand (session new, settings push) is in that command's own help.
    if (row.sub && !['login', 'logout', 'status', 'tunnel', 'forward', 'open'].includes(row.command)) {
      assert.match(help(row.command), new RegExp(`\\b${row.sub}\\b`), `woodshed ${row.command} --help has no ${row.sub}`);
    }
  }
});

test('a command this checkout\'s CLI has is not still marked as on its way', () => {
  for (const row of rows.filter((r) => r.arrives !== 'main')) {
    assert.ok(!top.has(row.command), `woodshed ${row.command} is in this CLI now: mark its rows in skills/woodshed/SKILL.md "main"`);
  }
});

test('every file of this checkout the skill names is here', () => {
  for (const [, file] of body.matchAll(/`((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:md|mjs|sh|json))`/g)) {
    assert.ok(fs.existsSync(path.join(WOODSHED, file)), file);
  }
});
