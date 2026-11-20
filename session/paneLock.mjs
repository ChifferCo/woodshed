// One thing at a time types into the agent's pane (statusd.mjs): a message from Chat or the console, the login command,
// or the lockdown's reopen of claude (taint.mjs). A message refused because the pane is taken is answered busy, which
// the console holds and sends again once the agent is back at its prompt (console/fleet.mjs).

/** @returns {{busy: boolean, take: (who: string) => boolean, release: (who: string) => void, waitAndTake: (who: string, opts: {sleep: (ms: number) => Promise<void>}) => Promise<void>}} */
export function createPaneLock() {
  let holder = null;
  return {
    get busy() { return holder !== null; },
    get holder() { return holder; },
    // At once, or not at all: a message is never kept waiting in statusd, the console holds it.
    take(who) {
      if (holder !== null) return false;
      holder = who;
      return true;
    },
    release(who) {
      if (holder === who) holder = null;
    },
    // For the reopen, which must happen: whatever is going in finishes first.
    async waitAndTake(who, { sleep }) {
      while (holder !== null) await sleep(200);
      holder = who;
    },
  };
}

/**
 * claude stopped and started again in its pane with the pane held throughout: from before the old claude is stopped
 * until the new one has taken the message it opens with (a hook after the restart began says it works), or `readyMs`.
 * A message sent meanwhile is refused as busy, never typed into a pane that holds a shell or a claude still drawing.
 * @param {{lock: ReturnType<typeof createPaneLock>, restart: () => Promise<void>,
 *          hookState: () => Promise<{state: string, at: number}|null>, sleep: (ms: number) => Promise<void>,
 *          now?: () => number, readyMs?: number}} opts
 * @returns {Promise<boolean>}  whether the new claude was seen working before readyMs
 */
export async function reopenUnderLock({ lock, restart, hookState, sleep, now = Date.now, readyMs = 30_000 }) {
  await lock.waitAndTake('reopen', { sleep });
  try {
    const startedAt = now();
    await restart();
    while (now() - startedAt < readyMs) {
      const hook = await hookState();
      // The old claude's last state does not count: only a hook written since the restart began.
      if (hook?.state === 'working' && Number(hook.at) >= startedAt) return true;
      await sleep(500);
    }
    return false;
  } finally {
    lock.release('reopen');
  }
}
