import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPaneLock, reopenUnderLock } from './paneLock.mjs';

// A clock and sleep of the test's own: each sleep moves the clock, and lets what else is waiting run.
function fakeTime(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms) => { t += ms; await new Promise((r) => setImmediate(r)); },
  };
}

test('one thing at a time takes the pane, and only its own release lets it go', () => {
  const lock = createPaneLock();
  assert.equal(lock.take('send'), true);
  assert.equal(lock.take('login'), false, 'refused at once: the console holds a message refused so');
  lock.release('login');
  assert.equal(lock.busy, true, 'another\'s release does not free it');
  lock.release('send');
  assert.equal(lock.take('login'), true);
});

test('the lockdown reopen waits for a message going in, keeps the pane while claude restarts, and frees it once the new claude works', async () => {
  const lock = createPaneLock();
  const time = fakeTime();
  const events = [];
  // A Chat message is going in when the reopen starts: it finishes first.
  assert.equal(lock.take('send'), true);
  let hook = { state: 'done', at: time.now() - 60_000 };
  let restarted = false;
  const reopening = reopenUnderLock({
    lock, sleep: time.sleep, now: time.now,
    restart: async () => { events.push('restart'); restarted = true; },
    hookState: async () => hook,
  });
  await time.sleep(0);
  assert.equal(restarted, false, 'not while the message is going in');
  events.push('message in');
  lock.release('send');
  for (let i = 0; i < 5 && !restarted; i++) await time.sleep(200);
  assert.deepEqual(events, ['message in', 'restart']);

  // While claude restarts, a message sent from Chat is refused as busy: nothing typed into the restarting pane.
  assert.equal(lock.take('send'), false);
  assert.equal(lock.holder, 'reopen');
  await time.sleep(500);
  assert.equal(lock.take('send'), false, 'still drawing: the new claude has not taken its message');

  // The new claude takes the lockdown's message: the pane is free, and the console's next try goes in.
  hook = { state: 'working', at: time.now() };
  assert.equal(await reopening, true);
  assert.equal(lock.busy, false);
  assert.equal(lock.take('send'), true);
});

test('the old claude\'s last working state does not free the pane: only a hook since the restart', async () => {
  const lock = createPaneLock();
  const time = fakeTime();
  // The turn was still running when the reopen gave up waiting for it: its hook says working, from before.
  const stale = { state: 'working', at: time.now() - 1_000 };
  let freedAt = null;
  const reopening = reopenUnderLock({
    lock, sleep: time.sleep, now: time.now, readyMs: 30_000,
    restart: async () => {}, hookState: async () => stale,
  }).then((ready) => { freedAt = time.now(); return ready; });
  await time.sleep(0);
  assert.equal(lock.take('send'), false, 'held, though the stale hook says working');
  assert.equal(await reopening, false, 'never seen working since the restart');
  assert.ok(freedAt - 1_000_000 >= 30_000, 'freed only after readyMs');
  assert.equal(lock.busy, false);
});

test('a restart that throws still frees the pane', async () => {
  const lock = createPaneLock();
  const time = fakeTime();
  await assert.rejects(reopenUnderLock({ lock, sleep: time.sleep, now: time.now, restart: async () => { throw new Error('tmux gone'); }, hookState: async () => null }), /tmux gone/);
  assert.equal(lock.busy, false);
});
