import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

import { parseYaml } from './yamlLite.mjs';

// Each case is a YAML file in __fixtures__/yamlLite/ beside the JSON js-yaml reads it as, so Woodshed's own CI keeps
// yamlLite honest without js-yaml as a dependency: small cases for each construct, and a project file and a workflow
// of the size repos write. A new case is a new .yaml there, with its .json from js-yaml:
//   node -e "const y=require('js-yaml'),fs=require('fs');for(const f of process.argv.slice(1))fs.writeFileSync(f.replace(/yaml$/,'json'),JSON.stringify(y.load(fs.readFileSync(f,'utf8')),null,2)+'\\n')" <case>.yaml
const FIXTURES = path.join(import.meta.dirname, '__fixtures__', 'yamlLite');
const CASES = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.yaml')).sort().map((f) => ({
  name: f.replace(/\.yaml$/, ''), source: fs.readFileSync(path.join(FIXTURES, f), 'utf8'),
  expected: JSON.parse(fs.readFileSync(path.join(FIXTURES, f.replace(/\.yaml$/, '.json')), 'utf8')),
}));

test('the fixtures cover every construct, the real-sized files and the CRLF one', () => {
  assert.ok(CASES.length >= 18, `${CASES.length} cases`);
  assert.ok(CASES.some((c) => c.source.startsWith('\uFEFF') && c.source.includes('\r\n')), 'the CRLF and byte order mark case kept its bytes');
  for (const name of ['project-file', 'workflow']) assert.ok(CASES.some((c) => c.name === name), name);
});

for (const { name, source, expected } of CASES) {
  test(`reads ${name} as js-yaml does`, () => assert.deepEqual(parseYaml(source), expected));
}

// Woodshed has no dependencies, so the fixtures' JSON is compared with js-yaml itself only where a node_modules above
// this folder or NODE_PATH has it: that catches a .json written by hand.
const jsYaml = (() => {
  try {
    return createRequire(import.meta.url)('js-yaml');
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') return null;
    throw err;
  }
})();

test('each fixture\'s JSON is what js-yaml reads', { skip: !jsYaml && 'js-yaml is not reachable from here or NODE_PATH' }, () => {
  for (const { name, source, expected } of CASES) assert.deepEqual(jsYaml.load(source), expected, name);
});

const REFUSED = {
  'an anchor': ['a: &x 1\n', /line 1: .*anchor/],
  'an alias': ['a: 1\nb: *a\n', /line 2: .*alias/],
  'a tag': ['a: !!str 1\n', /line 1: .*tag/],
  'a ? key': ['? a\n: 1\n', /line 1: `\?` keys/],
  'a repeated key': ['a: 1\nb: 2\na: 3\n', /line 3: the key "a" is repeated/],
  'a __proto__ key': ['__proto__:\n  app: x\n', /line 1: the key __proto__ is not read/],
  'a __proto__ key in flow': ['{"__proto__": {"app": 1}}', /line 1: the key __proto__ is not read/],
  'a plain value over two lines': ['a: one\n  two\n', /line 2: a value continues/],
  'a plain value with `: `': ['a: b: c\n', /line 1: a plain value cannot contain/],
  'tabs for indentation': ['a:\n\tb: 1\n', /line 2: indent with spaces/],
  'an unclosed quote': ['a: "x\n', /line 1: the double quote is not closed/],
  'an unclosed flow list': ['a: [1, 2\n', /line 1: `\[` is not closed/],
  'unclosed JSON': ['{ not json', /line 1: /],
  'a second document': ['a: 1\n---\nb: 2\n', /line 2: only one document/],
  'a list item among keys': ['a: 1\n- b\n', /line 2: a list item where a key was expected/],
  'a key indented too far': ['a: 1\n  b: 2\n', /line 2: /],
  'block text less indented than its first line': ['a: |\n    x\n  y\n', /line 3: block text is less indented/],
};

for (const [name, [source, error]] of Object.entries(REFUSED)) {
  test(`refuses ${name}, naming its line`, () => assert.throws(() => parseYaml(source), error));
}
