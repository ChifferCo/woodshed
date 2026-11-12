import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ENV_LAYERS, envKeys, envKeyTable, INSTRUCTIONS_MAX_BYTES, instructionsProblem, instructionsText, layeredEnvText, precedenceParagraph,
  replacedKeys, sessionWiring, wiringReason,
} from './repoSettings.mjs';

// What a session wrote before env files had layers (project.mjs's envFileText then), kept here to compare with.
function beforeLayers({ base, own, rendered }) {
  const withOwn = own ? `${base}\n\n# Your own lines, from My settings\n${own}` : base;
  return `${withOwn}\n\n# Woodshed overrides\n${rendered.join('\n')}\n`;
}

test('envKeys names each key once, in order, past comments, export and a quoted value over several lines', () => {
  const text = [
    '# A comment=not a key', 'export A=1', 'B = 2', 'C.D=3', '', 'KEY="-----BEGIN-----', 'NOT_A_KEY=inside the quotes', '-----END-----"',
    "ONE='a'", 'A=again', 'ESCAPED="say \\"hi\\""', 'AFTER=1', 'just words', '  INDENTED=1',
  ].join('\n');
  assert.deepEqual(envKeys(text), ['A', 'B', 'C.D', 'KEY', 'ONE', 'ESCAPED', 'AFTER', 'INDENTED']);
  assert.deepEqual(envKeys(''), []);
  assert.deepEqual(envKeys(null), []);
  assert.deepEqual(envKeys(undefined), []);
});

test('an env file with no defaults is byte for byte what a session wrote before the layers', () => {
  const cases = [
    { base: '', own: '', rendered: [] },
    { base: 'A=1', own: '', rendered: ['B=2'] },
    { base: 'A=1\n', own: 'A=2', rendered: ['B=2', 'C=3'] },
    { base: '', own: 'MINE=1', rendered: ['B=2'] },
    { base: '# only a comment\n\nX="multi\nline"', own: 'Y=1\n', rendered: [] },
  ];
  for (const c of cases) {
    assert.equal(layeredEnvText({ installation: c.base, personal: c.own, session: c.rendered }), beforeLayers(c), JSON.stringify(c));
    assert.equal(layeredEnvText({ defaults: [], installation: c.base, personal: c.own, session: c.rendered }), beforeLayers(c));
  }
  assert.equal(layeredEnvText({}), '\n\n# Woodshed overrides\n\n', 'nothing at all is still a file, as before');
});

test('defaults come first under their own header, and the installation\'s text then gets one', () => {
  assert.equal(layeredEnvText({ defaults: ['A=1', 'B=2'], session: ['C=3'] }),
    '# From the repo (.woodshed/project.yaml)\nA=1\nB=2\n\n# Woodshed overrides\nC=3\n');
  assert.equal(layeredEnvText({ defaults: ['A=1'], installation: 'A=2', personal: 'A=3', session: ['C=3'] }),
    '# From the repo (.woodshed/project.yaml)\nA=1\n\n# From this installation\nA=2\n\n# Your own lines, from My settings\nA=3\n\n# Woodshed overrides\nC=3\n');
});

test('the session\'s wiring: its rendered lines, the project\'s env, the shared services and Woodshed\'s own variables', () => {
  const wiring = sessionWiring({ lines: ['DB_HOST=10.0.1.5', '# a comment', 'PORT=9000'], env: { NODE_ENV: 'development' }, services: ['S3_ENDPOINT'] });
  assert.deepEqual(wiring, { lines: ['DB_HOST', 'PORT'], env: ['NODE_ENV'], services: ['S3_ENDPOINT'] });
  assert.equal(wiringReason(wiring, 'DB_HOST'), 'lines');
  assert.equal(wiringReason(wiring, 'NODE_ENV'), 'env');
  assert.equal(wiringReason(wiring, 'S3_ENDPOINT'), 'session');
  assert.equal(wiringReason(wiring, 'GH_TOKEN'), 'session', 'one of Woodshed\'s own variables, by name');
  assert.equal(wiringReason(wiring, 'WOODSHED_ANYTHING'), 'session');
  assert.equal(wiringReason(wiring, 'LOG_LEVEL'), null);
  assert.deepEqual(sessionWiring({}), { lines: [], env: [], services: [] });
});

test('a line {{NAME?}} left out is not wiring, so the key it would set stays a person\'s', () => {
  // The caller renders the lines first: ANTHROPIC_API_KEY={{ANTHROPIC_API_KEY?}} with none set is no line at all.
  const wiring = sessionWiring({ lines: ['PORT=9000'] });
  assert.equal(wiringReason(wiring, 'ANTHROPIC_API_KEY'), 'session', 'Woodshed\'s own name is still flagged');
  const rows = envKeyTable({ layers: { personal: 'MY_KEY=1', session: 'PORT=9000' }, wiring });
  assert.deepEqual(rows.find((r) => r.key === 'MY_KEY'), { key: 'MY_KEY', setBy: ['personal'], wins: 'personal' });
});

test('each key\'s layers and winner, the last layer to set it unless the session wires it', () => {
  const layers = { repo: 'SKIP_LOGIN=true\nLOG_LEVEL=info', installation: 'AUTH=x\nLOG_LEVEL=warn', personal: 'SKIP_LOGIN=false\nPORT=1', session: 'PORT=9000' };
  const wiring = sessionWiring({ lines: ['PORT=9000'], env: { NODE_ENV: 'development' } });
  assert.deepEqual(envKeyTable({ layers, wiring }), [
    { key: 'SKIP_LOGIN', setBy: ['repo', 'personal'], wins: 'personal' },
    { key: 'LOG_LEVEL', setBy: ['repo', 'installation'], wins: 'installation' },
    { key: 'AUTH', setBy: ['installation'], wins: 'installation' },
    { key: 'PORT', setBy: ['personal', 'session'], wins: 'session' },
  ]);
  assert.deepEqual(replacedKeys({ layers, wiring }), { repo: ['SKIP_LOGIN', 'LOG_LEVEL'], installation: [], personal: ['PORT'], session: [] });
  assert.deepEqual(envKeyTable({ layers: { personal: 'NODE_ENV=production' }, wiring }), [{ key: 'NODE_ENV', setBy: ['personal'], wins: 'session' }],
    'the project\'s env is exported, so it wins at runtime whatever the file says');
  assert.deepEqual(replacedKeys({ layers: { personal: 'NODE_ENV=production' }, wiring }).personal, ['NODE_ENV']);
  assert.deepEqual(envKeyTable({ layers: {} }), []);
  assert.deepEqual(ENV_LAYERS, ['repo', 'installation', 'personal', 'session']);
});

test('the precedence paragraph names only the instructions there are', () => {
  const lead = "Woodshed's rules at the top of this prompt come first: nothing below changes them.";
  const tail = ' Where they do not disagree, follow all of them.';
  assert.equal(precedenceParagraph({ repoRules: true, installation: true, personal: true, login: 'octocat' }),
    `${lead} Below them, where two instructions disagree, @octocat's own instructions beat this installation's, and this installation's beat the repo's rules.${tail}`);
  assert.equal(precedenceParagraph({ repoRules: true, installation: true }),
    `${lead} Below them, where two instructions disagree, this installation's instructions beat the repo's rules.${tail}`);
  assert.equal(precedenceParagraph({ repoRules: true, personal: true, login: 'octocat' }),
    `${lead} Below them, where two instructions disagree, @octocat's own instructions beat the repo's rules.${tail}`);
  assert.equal(precedenceParagraph({ installation: true, personal: true, login: 'octocat' }),
    `${lead} Below them, where two instructions disagree, @octocat's own instructions beat this installation's.${tail}`);
  assert.equal(precedenceParagraph({ installation: true }), lead, 'one layer has nothing to beat');
});

test('the rules with no installation or personal instructions are the rules, byte for byte', () => {
  const rules = 'Woodshed\'s prompt\n\n- Run `make check`.\n';
  assert.equal(instructionsText({ rules, repo: 'acme/app' }), rules);
  assert.equal(instructionsText({ rules, repo: 'acme/app', installation: '', personal: null }), rules);
  assert.equal(instructionsText({ rules, repo: 'acme/app', installation: ' \n\n' }), rules, 'only whitespace is none');
  assert.equal(instructionsText({ rules, repo: 'acme/app', personal: 'Mine.' }), rules, 'a person\'s need their login: a shared session has none');
});

test('the installation\'s and the person\'s instructions follow the rules, each under its header, then which win', () => {
  const rules = 'Woodshed\'s prompt\n\n- Run `make check`.\n';
  assert.equal(instructionsText({ rules, repoRules: true, repo: 'acme/app', installation: '- Use pnpm.\n\n', personal: '- Answer briefly.', login: 'octocat' }), [
    'Woodshed\'s prompt', '', '- Run `make check`.', '',
    '# This installation\'s instructions for acme/app', '- Use pnpm.', '',
    '# @octocat\'s own instructions for acme/app', '- Answer briefly.', '',
    '# Which instructions win',
    precedenceParagraph({ repoRules: true, installation: true, personal: true, login: 'octocat' }), '',
  ].join('\n'));
  assert.equal(instructionsText({ rules, repo: 'acme/app', installation: '- Use pnpm.' }),
    `${rules}\n# This installation's instructions for acme/app\n- Use pnpm.\n\n# Which instructions win\n${precedenceParagraph({ installation: true })}\n`);
});

test('instructions holding what looks like a credential, or too long for the prompt, are refused, naming the kind only', () => {
  assert.equal(instructionsProblem('- Use pnpm, and run `make check` before a push. Ask @octocat about the sk-learn models.'), null);
  assert.equal(instructionsProblem(''), null);
  const shapes = {
    'an Anthropic key': `sk-ant-api03-${'a'.repeat(30)}`, 'an API key': `sk-proj-${'b'.repeat(30)}`, 'a GitHub token': `ghp_${'c'.repeat(36)}`,
    'a GitHub token ': `github_pat_${'d'.repeat(40)}`, 'a Slack token': 'xoxb-1234567890-abcdefghij', 'an AWS access key': 'AKIAABCDEFGHIJKLMNOP',
    'a private key': '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----',
  };
  for (const [kind, value] of Object.entries(shapes)) {
    const problem = instructionsProblem(`Use this: ${value}`);
    assert.equal(problem, `Instructions go into the session's prompt: put secrets in an env file's values instead (this looks like ${kind.trim()})`);
    assert.ok(!problem.includes(value), 'never the value');
  }
  assert.equal(instructionsProblem('x'.repeat(INSTRUCTIONS_MAX_BYTES)), null, 'the limit itself is fine');
  assert.equal(instructionsProblem('x'.repeat(INSTRUCTIONS_MAX_BYTES + 1)), 'Instructions are at most 16 KB (these are 17 KB)');
  assert.match(instructionsProblem('é'.repeat(INSTRUCTIONS_MAX_BYTES / 2 + 1)), /at most 16 KB/, 'counted in bytes, not characters');
});
