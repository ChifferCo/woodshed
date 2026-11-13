import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.join(import.meta.dirname, 'enable-review.sh');

// A fake `gh` on PATH that logs every call, answers the reads the script makes, and saves the contents of each file
// it is asked to write (the base64 of -f content=, decoded) so a test can read what the workflow would be.
function fakeGh(t, { secretExists = false, qaWorkflowExists = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enable-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(dir, 'gh.log');
  const written = path.join(dir, 'written');
  fs.mkdirSync(written);
  const script = `#!/usr/bin/env bash
printf '%s\\0' "$@" >> ${log}.nul
echo "$*" >> ${log}
args=("$@")
case "$*" in
  "auth status"*) exit 0 ;;
  "api repos/ChifferCo/woodshed/commits/main --jq .sha") echo deadbeefcafe ; exit 0 ;;
  "repo view "*"defaultBranchRef"*) echo main ; exit 0 ;;
  "secret list"*) ${secretExists ? 'echo "ANTHROPIC_API_KEY  2026-01-01"' : ':'} ; exit 0 ;;
  "secret set"*) exit 0 ;;
  "label create"*) exit 0 ;;
esac
# contents GET for the existing sha. The QA workflow is "there" only when the test says so (switching runners); every
# other file is new, so a 404 (body to stdout, exit 1), like real gh.
if [[ "$*" == api*contents*--jq\\ .sha* && "$*" != *--method* ]]; then
  if [[ ${qaWorkflowExists ? 'true' : 'false'} == true && "$*" == *woodshed-qa.yml* ]]; then
    echo existingsha123 ; exit 0
  fi
  echo '{"message":"Not Found","status":"404"}'
  exit 1
fi
# contents DELETE: record it
[[ "$*" == *--method\\ DELETE*contents* ]] && exit 0
# contents PUT: save the decoded file content under its path
if [[ "$*" == *--method\\ PUT*contents* ]]; then
  p=""; c=""
  for ((i=0; i<\${#args[@]}; i++)); do
    case "\${args[i]}" in
      repos/*/contents/*) p="\${args[i]#*/contents/}" ;;
    esac
    [[ "\${args[i]}" == content=* ]] && c="\${args[i]#content=}"
  done
  mkdir -p "${written}/$(dirname "$p")"
  printf '%s' "$c" | base64 -d > "${written}/$p"
  exit 0
fi
# permissions GET / PUT
[[ "$*" == *actions/permissions/workflow*default_workflow_permissions* && "$*" != *--method* ]] && { echo read; exit 0; }
[[ "$*" == *--method\\ PUT*actions/permissions/workflow* ]] && exit 0
exit 0
`;
  fs.writeFileSync(path.join(bin, 'gh'), script);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  return { dir, bin, log, written };
}

function run(bin, ...args) {
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME },
  });
}

test('it pins to a commit, writes the review workflow, allows approvals, and sets the key when missing', (t) => {
  const { bin, log, written } = fakeGh(t, { secretExists: false });
  const r = run(bin, 'acme/game');
  assert.equal(r.status, 0, r.stderr);

  const review = fs.readFileSync(path.join(written, '.github/workflows/woodshed-review.yml'), 'utf8');
  assert.match(review, /review\.yml@deadbeefcafe/, 'pins the resolved commit, not main');
  assert.match(review, /ANTHROPIC_API_KEY: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/);

  const calls = fs.readFileSync(log, 'utf8');
  assert.match(calls, /commits\/main --jq \.sha/, 'resolves main to a commit');
  assert.match(calls, /can_approve_pull_request_reviews=true/, 'turns on approve');
  assert.match(calls, /secret set ANTHROPIC_API_KEY/, 'sets the key when missing');
  assert.doesNotMatch(calls, /content=\S+ -f branch=main -f sha=/, 'no stale sha on the first write');
});

test('it skips the key when it is already set, and does not add QA without --qa', (t) => {
  const { bin, log, written } = fakeGh(t, { secretExists: true });
  const r = run(bin, 'acme/game');
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /secret set/, 'does not overwrite an existing key');
  assert.ok(!fs.existsSync(path.join(written, '.github/workflows/woodshed-qa.yml')), 'no QA workflow');
});

test('--qa also writes the QA workflow and creates the label', (t) => {
  const { bin, log, written } = fakeGh(t, { secretExists: true });
  const r = run(bin, 'acme/game', '--qa');
  assert.equal(r.status, 0, r.stderr);
  const qa = fs.readFileSync(path.join(written, '.github/workflows/woodshed-qa.yml'), 'utf8');
  assert.match(qa, /qa\/app-url@deadbeefcafe/, 'reads the app from the project file');
  assert.match(qa, /github\.event\.label\.name == 'woodshed-qa'/);
  assert.match(fs.readFileSync(log, 'utf8'), /label create woodshed-qa/);
});

test('a given --ref is used as-is, with no commit lookup', (t) => {
  const { bin, log, written } = fakeGh(t, { secretExists: true });
  const r = run(bin, 'acme/game', '--ref', 'v1.2.3');
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(written, '.github/workflows/woodshed-review.yml'), 'utf8'), /review\.yml@v1\.2\.3/);
  assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /commits\/main/, 'no lookup when --ref is given');
});

test('--qa-runner woodshed writes no QA workflow, makes the label, and prints the console steps', (t) => {
  const { bin, log, written } = fakeGh(t, { secretExists: true });
  const r = run(bin, 'acme/game', '--qa-runner', 'woodshed');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(written, '.github/workflows/woodshed-qa.yml')), 'no CI QA workflow for the session runner');
  assert.match(fs.readFileSync(log, 'utf8'), /label create woodshed-qa/);
  assert.match(r.stdout, /runner: woodshed/, 'tells the user the project-file setting');
  assert.match(r.stdout, /Install the Woodshed GitHub App/);
  // The review workflow is still written: review always runs in CI.
  assert.ok(fs.existsSync(path.join(written, '.github/workflows/woodshed-review.yml')));
});

test('an unknown --qa-runner is rejected', (t) => {
  const { bin } = fakeGh(t, { secretExists: true });
  const r = run(bin, 'acme/game', '--qa-runner', 'lambda');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /must be actions or woodshed/);
});

test('switching to the session runner removes a leftover CI QA workflow, so QA does not run twice', (t) => {
  const { bin, log } = fakeGh(t, { secretExists: true, qaWorkflowExists: true });
  const r = run(bin, 'acme/game', '--qa-runner', 'woodshed');
  assert.equal(r.status, 0, r.stderr);
  const calls = fs.readFileSync(log, 'utf8');
  assert.match(calls, /--method DELETE repos\/acme\/game\/contents\/\.github\/workflows\/woodshed-qa\.yml/, 'deletes the CI QA workflow');
  assert.match(r.stdout, /Removed the CI QA workflow/);
});
