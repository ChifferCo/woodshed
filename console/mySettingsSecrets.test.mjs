// My settings' pasted sign-ins (public/mySettings.js) follow the design system's secret field: masked as they are typed, with Show
// beside Save, and empty and masked again once saved. The page is one closure over the browser's DOM, so this reads its source,
// and the check in a browser (a masked field, Show and Hide, a save that empties it) is in the pull request that made it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./public/mySettings.js', import.meta.url), 'utf8');

test('every sign-in pasted on My settings is a masked field with Show, never a plain text box', () => {
  // The one place a pasted sign-in's field is made: a password field with no browser fill-in.
  const made = source.match(/function pastedSecret\([^)]*\) \{[^}]*\}/s)?.[0] ?? '';
  assert.match(made, /type: 'password'/);
  assert.match(made, /autocomplete: 'new-password'/);
  // A textarea for any `…-auth` field would show a refresh token in clear text until Save.
  assert.doesNotMatch(source, /h\('textarea',[^)]*-auth/s, 'no plain text box for a sign-in');
  assert.doesNotMatch(source, /h\('textarea',\s*\{\s*id: `\$\{id\}-auth`/s);
  // Codex's, and each of the other agents' (Grok Build, OpenCode, Antigravity CLI), come from it, each with its Show.
  assert.match(source, /const codexInput = pastedSecret\('codex-auth'/);
  assert.match(source, /agentInputs = Object\.fromEntries\(A\.OWN_SIGN_IN_AGENTS\.map\(\(id\) => \[id, pastedSecret\(`\$\{id\}-auth`/);
  assert.match(source, /revealButtonFor\(codexInput\)/);
  assert.match(source, /revealButtonFor\(agentInputs\[id\]\)/);
  // And each is masked again, and emptied, once its save went through.
  assert.match(source, /codexInput\.value = ''; codexInput\.type = 'password'/);
  assert.match(source, /agentInputs\[id\]\.value = ''; agentInputs\[id\]\.type = 'password'/);
});
