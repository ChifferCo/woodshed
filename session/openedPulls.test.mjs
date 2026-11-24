import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

// First: it takes the Herdr variables out of this process (test/isolatedEnv.mjs).
import { isolatedEnv } from '../test/isolatedEnv.mjs';
import { MAX_OPENED, pullsOpened, readOpened, recordOpened } from './openedPulls.mjs';

const run = promisify(execFile);
const HOOK = fileURLToPath(new URL('./hookState.mjs', import.meta.url));
const CREATE = ['gh', 'pr', 'create'].join(' ');
const bash = (command, stdout) => ({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr: '' } });
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'opened-')), 'pulls.json');

test('a pull request opened from another clone is the one its output names', () => {
  const url = 'https://github.com/o/cloud/pull/151';
  assert.deepEqual(pullsOpened(bash(`cd /tmp/wc && ${CREATE} --title t --body-file b.md`, `\n${url}\n`)), [url]);
  assert.deepEqual(pullsOpened(bash('gh pr view 151', url)), [], 'another gh call names a pull request it did not open');
  assert.deepEqual(pullsOpened({ ...bash(CREATE, url), hook_event_name: 'PreToolUse' }), []);
  assert.deepEqual(pullsOpened(bash(CREATE, 'could not create')), []);
  assert.deepEqual(pullsOpened(bash(CREATE, `${url}/files ${url}`)), [url]);
});

test('the file keeps each pull request once, the newest kept, and ignores what is not one', () => {
  const file = tmpFile();
  assert.deepEqual(readOpened(file), []);
  const url = (n) => `https://github.com/o/r/pull/${n}`;
  recordOpened([url(1)], file);
  recordOpened([url(1), url(2)], file);
  assert.deepEqual(readOpened(file), [url(1), url(2)]);
  recordOpened(Array.from({ length: 30 }, (_, i) => url(i + 3)), file);
  assert.equal(readOpened(file).length, MAX_OPENED);
  assert.equal(readOpened(file).at(-1), url(32));
  fs.writeFileSync(file, JSON.stringify(['javascript:x', url(9), 7]));
  assert.deepEqual(readOpened(file), [url(9)]);
  fs.writeFileSync(file, 'not json');
  assert.deepEqual(readOpened(file), []);
});

test('claude\'s PostToolUse hook records the pull request and still writes the state', async () => {
  const file = tmpFile();
  const state = path.join(path.dirname(file), 'state.json');
  const url = 'https://github.com/o/cloud/pull/151';
  const child = run('node', [HOOK], { env: { ...isolatedEnv(), WOODSHED_OPENED_PULLS_FILE: file, WOODSHED_CLAUDE_STATE_FILE: state } });
  child.child.stdin.end(JSON.stringify(bash(`${CREATE} --fill`, `${url}\n`)));
  const { stdout } = await child;
  assert.equal(stdout, '', 'a hook prints nothing');
  assert.deepEqual(readOpened(file), [url]);
  assert.equal(JSON.parse(fs.readFileSync(state, 'utf8')).state, 'working');
});
