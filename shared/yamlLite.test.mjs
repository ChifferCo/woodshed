import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { parseYaml } from './yamlLite.mjs';

const READ = {
  'mappings, nested by indentation': ['a: 1\nb:\n  c: x\n  d:\n    e: true\n', { a: 1, b: { c: 'x', d: { e: true } } }],
  'lists, under a key at its indent or further in': ['a:\n- 1\n- 2\nb:\n  - x\n', { a: [1, 2], b: ['x'] }],
  'list items that are mappings': ['- name: a\n  port: 1\n-   name: b\n    port: 2\n', [{ name: 'a', port: 1 }, { name: 'b', port: 2 }]],
  'a list in a list, and an item on the next line': ['- - a\n  - b\n-\n  c: 1\n', [['a', 'b'], { c: 1 }]],
  'comments, not inside quotes or a word': ['# top\na: x # end\nb: "x # y"\nc: a#b\n\n  # indented\n', { a: 'x', b: 'x # y', c: 'a#b' }],
  'a quote inside a plain value, before a comment': ["a: rock 'n roll # c\nb: say \"hi # c\n", { a: "rock 'n roll", b: 'say "hi' }],
  'plain values keep their quotes and colons when they cannot start or end a key':
    ['- DB="{{X}}"\n- http://localhost:9000\n- ~/.cache/{{CHECKOUT}}/a.log\n', ['DB="{{X}}"', 'http://localhost:9000', '~/.cache/{{CHECKOUT}}/a.log']],
  'null, booleans and numbers as YAML 1.2 core reads them':
    ['a:\nb: ~\nc: null\nd: false\ne: -12\nf: 1.5e3\ng: "9000"\nh: yes\ni: 0x1F\nj: 012\n', { a: null, b: null, c: null, d: false, e: -12, f: 1500, g: '9000', h: 'yes', i: 31, j: 12 }],
  'quoted values with their escapes': ['a: "t\\tn\\n\\u00e9\\"q"\nb: \'it\'\'s\'\n"c d": 1\n', { a: 't\tn\né"q', b: "it's", 'c d': 1 }],
  'literal block text, clipped, stripped and kept':
    ['a: |\n  one\n    two\n\nb: |-\n  x\nc: |+\n  y\n\nd: 1\n', { a: 'one\n  two\n', b: 'x', c: 'y\n\n', d: 1 }],
  'block text as a list item': ['- |\n  one\n  two\n- >-\n  x\n  y\n', ['one\ntwo\n', 'x y']],
  'folded block text': ['a: >\n  one\n  two\n\n  three\n    kept\n  four\nb: >-\n  x\n  y\n', { a: 'one two\nthree\n  kept\nfour\n', b: 'x y' }],
  'one-line flow, which JSON is': ['{"a":[1,"b",{"c":null}],"d":true}', { a: [1, 'b', { c: null }], d: true }],
  'flow under keys, with plain values': ['a: [x, y z, ]\nb: {k: v, n: 2}\nc: []\n', { a: ['x', 'y z'], b: { k: 'v', n: 2 }, c: [] }],
  'a document marker at the top, CRLF and a byte order mark': ['\uFEFF---\r\na: 1\r\n', { a: 1 }],
  'an empty document': ['# nothing\n', null],
};

for (const [name, [source, expected]] of Object.entries(READ)) {
  test(`reads ${name}`, () => assert.deepEqual(parseYaml(source), expected));
}

// Woodshed has no dependencies, so js-yaml is compared with only where a node_modules above this folder or NODE_PATH has
// it. A repo that has it elsewhere runs this file with NODE_PATH pointing there. Where it is not, the cases above still run.
const jsYaml = (() => {
  try {
    return createRequire(import.meta.url)('js-yaml');
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') return null;
    throw err;
  }
})();

test('reads each case as js-yaml does', { skip: !jsYaml && 'js-yaml is not reachable from here or NODE_PATH' }, () => {
  const sources = Object.values(READ).map(([source]) => source);
  for (const source of sources) assert.deepEqual(parseYaml(source), jsYaml.load(source), source);
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
