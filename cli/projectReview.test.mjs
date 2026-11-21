import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseProject } from '../shared/project.mjs';
import { parseYaml } from '../shared/yamlLite.mjs';
import { DEFAULT_HEADING, DEFAULT_RERUN, enableReview, yamlScalar } from './projectReview.mjs';

const read = (text) => parseProject(parseYaml(text));

test('no project file: one with version 1 and the review in a session, which reads back', () => {
  const { text, changes, created } = enableReview(null);
  assert.equal(created, true);
  assert.equal(text, `version: 1

pullRequests:
  # Each pull request reviewed in a Woodshed session; the console posts the verdict as its reviewer App.
  review:
    runner: woodshed
    heading: '${DEFAULT_HEADING}'
    rerun: '${DEFAULT_RERUN}'
`);
  assert.equal(changes[0], '.woodshed/project.yaml made, with version: 1');
  const review = read(text).pullRequests.review;
  assert.deepEqual([review.runner, review.author, review.commentAuthor, review.workflow], ['woodshed', null, null, null], 'the console fills in both Apps\' logins');
});

test('every other line, comment and the order are kept; the block goes at the end of pullRequests', () => {
  const before = `version: 1
# The app, for sessions.
app:
  start: npm start   # the dev server
  stop: npm stop
  frontendPort: 3000
  backendPort: 3001
  logs: {}
  howToProve: open it

pullRequests:
  # Our e2e.
  suites:
    - name: e2e
      workflow: .github/workflows/e2e.yml
      jobs: e2e   # every job

# Kept at the end.
editor: true
`;
  const { text, changes } = enableReview(before, { qa: true });
  const added = text.split('\n').filter((l) => !before.split('\n').includes(l));
  assert.deepEqual(added, [
    '  # Each pull request reviewed in a Woodshed session; the console posts the verdict as its reviewer App.',
    '  review:',
    '    runner: woodshed',
    `    heading: '${DEFAULT_HEADING}'`,
    `    rerun: '${DEFAULT_RERUN}'`,
    '  # Tested in a Woodshed session once the review approves, when the label goes on a pull request.',
    '  qa:',
    '    runner: woodshed',
    '    check: QA',
    '    label: woodshed-qa',
    "    heading: '## QA'",
  ]);
  assert.ok(before.split('\n').every((l) => text.split('\n').includes(l)), 'nothing taken out');
  assert.ok(text.indexOf('  review:') > text.indexOf('jobs: e2e') && text.indexOf('  review:') < text.indexOf('# Kept at the end.'), 'inside pullRequests, before what follows it');
  assert.equal(changes.length, 3);
  const after = read(text);
  assert.equal(after.pullRequests.qa.runner, 'woodshed');
  assert.deepEqual(after.app, read(before).app);
});

test('from the Actions runner: runner set, the workflow\'s bot logins and workflow taken out, its heading and tag kept', () => {
  const before = `version: 1
pullRequests:
  review:
    author: review-bot[bot]   # the workflow's App
    heading: '## Code Review'
    workflow: .github/workflows/review.yml
    rerun: '[review]'
    commentAuthor: review-bot[bot]
  qa:
    check: QA
    label: qa
    heading: '## QA'
    author: qa-bot[bot]
`;
  const { text, changes } = enableReview(before, { qa: true });
  assert.equal(text, `version: 1
pullRequests:
  review:
    heading: '## Code Review'
    rerun: '[review]'
    runner: woodshed
  qa:
    check: QA
    label: qa
    heading: '## QA'
    runner: woodshed
`);
  assert.equal(changes.filter((c) => c.includes('taken out')).length, 4);
});

test('a runner line is changed in place, keeping its comment; the same run twice changes nothing', () => {
  const before = "version: 1\npullRequests:\n  review:\n    runner: actions  # for now\n    heading: '## R'\n    workflow: .github/workflows/r.yml\n    author: r[bot]\n";
  const once = enableReview(before);
  assert.match(once.text, /^ {4}runner: woodshed {2}# for now$/m);
  const twice = enableReview(once.text);
  assert.deepEqual(twice.changes, []);
  assert.equal(twice.text, once.text);
});

test('--rerun and --every-commit', () => {
  const base = "version: 1\npullRequests:\n  review:\n    runner: woodshed\n    heading: '## R'\n    rerun: '[old] # tagged'  # keep this explanation\n";
  assert.match(enableReview(base, { rerun: '[new]' }).text, /rerun: '\[new\]' {2}# keep this explanation/);
  const every = enableReview(base, { everyCommit: true });
  assert.ok(!every.text.includes('rerun'));
  assert.match(every.text, /^ {4}# keep this explanation$/m);
  assert.equal(read(every.text).pullRequests.review.rerun, null);
  assert.equal(enableReview(every.text, { everyCommit: true }).text, every.text);
  assert.equal(enableReview(base).text, base, 'the file\'s own tag is kept');
});

test('--rerun replaces a block scalar and keeps the comments outside its value', () => {
  for (const header of ['|-', '>-']) {
    const before = `version: 1
pullRequests:
  review:
    runner: woodshed
    rerun: ${header} # keep this note
      [old]
    # The heading below stays.
    heading: '## R'
`;
    const { text } = enableReview(before, { rerun: '[new]' });
    assert.equal(text, before.replace(`${header} # keep this note\n      [old]`, "'[new]' # keep this note"));
    assert.equal(read(text).pullRequests.review.rerun, '[new]');
  }
});

test('none written as null, or {}, becomes a block; inline mappings and files that do not read are refused', () => {
  for (const none of ['null', '~', '{}']) assert.equal(read(enableReview(`version: 1\npullRequests: ${none}\n`).text).pullRequests.review.runner, 'woodshed');
  assert.match(enableReview('version: 1\npullRequests: null  # gates come later\n').text, /^pullRequests:  # gates come later$/m, 'its comment kept');
  assert.throws(() => enableReview('version: 1\npullRequests: {review: {runner: woodshed, heading: x}}\n'), /written inline/);
  assert.throws(() => enableReview('version: 1\npullRequest: {}\n'), /does not read as a project file, so it was not changed/);
});

test('four-space indents are kept, and so are CRLF line ends', () => {
  const four = enableReview('version: 1\npullRequests:\n    suites:\n        - name: e2e\n          workflow: .github/workflows/e2e.yml\n          jobs: e2e\n').text;
  assert.match(four, /^ {4}review:\n {8}runner: woodshed$/m);
  const crlf = enableReview('version: 1\r\neditor: true\r\n').text;
  assert.ok(!/[^\r]\n/.test(crlf), 'every line ends in CRLF');
});

test('Woodshed\'s own project file already says it', () => {
  const own = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.woodshed', 'project.yaml'), 'utf8');
  const { changes, text } = enableReview(own, { everyCommit: true, qa: true });
  assert.deepEqual(changes, []);
  assert.equal(text, own);
});

test('scalars are quoted only where YAML needs it', () => {
  assert.equal(yamlScalar('woodshed'), 'woodshed');
  assert.equal(yamlScalar('woodshed-qa'), 'woodshed-qa');
  assert.equal(yamlScalar('## QA'), "'## QA'");
  assert.equal(yamlScalar('[woodshed-review]'), "'[woodshed-review]'");
  assert.equal(yamlScalar("it's"), "'it''s'");
  assert.equal(yamlScalar('true'), "'true'");
});
