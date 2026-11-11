import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { parseProject } from '../shared/project.mjs';
import { parseYaml } from '../shared/yamlLite.mjs';
import { reviewSummaryOf, reviewVerdict } from '../console/pullGates.mjs';

// Woodshed's own .woodshed/: nothing reads it while Woodshed is inside another repo, so this is what keeps it right for when
// woodshed/ is a repo of its own.
const WOODSHED = path.resolve(import.meta.dirname, '..');
const DOT = path.join(WOODSHED, '.woodshed');

function selfProject() {
  return parseProject(parseYaml(fs.readFileSync(path.join(DOT, 'project.yaml'), 'utf8')));
}

test('Woodshed\'s project file parses, with no dependencies, databases or app, and its rules file is there', () => {
  const project = selfProject();
  assert.deepEqual([project.dependencies, project.envFiles, project.databases, project.app],
    [{ installs: [] }, [], [], null]);
  assert.equal(project.editor, true);
  assert.equal(project.rules, '.woodshed/rules.md');
  assert.ok(fs.existsSync(path.join(WOODSHED, project.rules)), 'rules is a path from what will be the repo root');
});

test('Woodshed\'s pull requests wait for its Claude review, its Check suite\'s test job and the review\'s Merge risk', () => {
  assert.deepEqual(selfProject().pullRequests, {
    review: {
      author: 'github-actions[bot]', heading: '## Claude review', workflow: '.github/workflows/review.yml',
      rerun: '[woodshed-review]', commentAuthor: 'github-actions[bot]',
    },
    suites: [{ name: 'Check', workflow: '.github/workflows/check.yml', jobs: 'test', rerun: null }],
    qa: null,
    mergeRisk: { check: 'Merge risk' },
  });
});

test('the gates match what Woodshed\'s own workflows post', () => {
  const { review, suites, mergeRisk } = selfProject().pullRequests;
  const reviewYml = fs.readFileSync(path.join(WOODSHED, review.workflow), 'utf8');
  assert.ok(reviewYml.includes(`default: '${review.rerun}'`), 'the rerun tag is the one review.yml looks for');
  assert.ok(reviewYml.includes(reviewSummaryOf(review)), 'the review\'s comment is folded under the heading\'s words');
  assert.ok(reviewYml.includes(`name: "${mergeRisk.check}"`), 'review.yml posts the Merge risk check');
  // The verdict's first line, as review.yml's "Post the verdict" step writes it.
  assert.ok(reviewYml.includes('echo "## Claude review — ${verdict}"'), 'review.yml writes the verdict under the heading');
  const verdict = { user: { login: review.author }, state: 'APPROVED', body: '## Claude review — APPROVE\n\nLooks right.' };
  assert.equal(reviewVerdict([verdict], review), verdict);
  const [suite] = suites;
  const checkYml = parseYaml(fs.readFileSync(path.join(WOODSHED, suite.workflow), 'utf8'));
  assert.ok(checkYml.jobs[suite.jobs], 'check.yml has the suite\'s job');
  assert.equal(checkYml.jobs[suite.jobs].name, undefined, 'the job has no name, so its check run is named for its id');
});
