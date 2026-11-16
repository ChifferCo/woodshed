import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import scroll from './public/terminalScroll.cjs';

test('only a pane on the main screen, as tmux.conf titles it, scrolls in the browser', () => {
  assert.equal(scroll.scrollsItself('claude (main screen) | tmux attach -t claude (0123abcd)'), true, 'as ttyd shows it');
  assert.equal(scroll.scrollsItself('shell (main screen)'), true);
  for (const title of ['claude (alternate screen) | ttyd', 'claude (copy mode) | ttyd', 'shell (panes) | ttyd',
    'tmux attach -t claude (0123abcd)', '✳ Claude Code', '', undefined]) {
    assert.equal(scroll.scrollsItself(title), false, `${title}: tmux's, as before`);
  }
});

test('the view moves in the browser\'s history, and past its top tmux\'s copy mode opens where it would have gone', () => {
  const buf = { viewportY: 120, baseY: 200 }; // 80 lines up from the screen
  assert.deepEqual(scroll.plan(buf, -20), { own: -20 });
  assert.deepEqual(scroll.plan(buf, 30), { own: 30 }, 'down is always the browser\'s');
  assert.deepEqual(scroll.plan(buf, -120), { own: -120 }, 'to the very top');
  assert.deepEqual(scroll.plan(buf, -125), { tmux: -205 }, '200 lines held, and 5 more');
  assert.deepEqual(scroll.plan({ viewportY: 0, baseY: 0 }, -3), { tmux: -3 }, 'nothing held yet: tmux\'s alone');
});

test('the session\'s tmux.conf gives the browser a scrollback and the title this reads', () => {
  const conf = fs.readFileSync(new URL('../session/tmux.conf', import.meta.url), 'utf8');
  const titles = conf.match(/^set -g set-titles-string "(.*)"$/m)?.[1] ?? '';
  // The title's main-screen branch, as tmux would expand it for `claude`.
  assert.equal(scroll.scrollsItself(`claude (${titles.match(/,(main screen),/)?.[1]}) | ttyd`), true);
  assert.match(conf, /^set -g set-titles on$/m);
  assert.match(conf, /^set -ga terminal-overrides ",xterm\*:smcup@:rmcup@:indn@"$/m, 'not on its alternate screen, a line at a time');
  assert.match(conf, /^set -g status-position bottom$/m, 'a scroll region from the first row, which xterm.js keeps');
  assert.match(conf, /^set -g history-limit 50000$/m, 'for every pane, set before the first');
});
