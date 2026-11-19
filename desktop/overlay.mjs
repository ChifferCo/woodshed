// The taskbar overlay on Windows: the count of sessions that need you, drawn on the button, since Windows has no badge
// count (app.setBadgeCount does nothing there). Kept free of Electron so `node --test` checks it.

// Each image in badges/ and what it shows: 1 to 9, then 9+.
export const BADGE_LABELS = Object.freeze({
  'badge-1': '1', 'badge-2': '2', 'badge-3': '3', 'badge-4': '4', 'badge-5': '5',
  'badge-6': '6', 'badge-7': '7', 'badge-8': '8', 'badge-9': '9', 'badge-9plus': '9+',
});

/**
 * @param {number} count  sessions that need you
 * @returns {{image: string, description: string}|null}  the overlay's image in badges/ and its words, which screen
 *   readers say; null to take the overlay off
 */
export function overlayFor(count) {
  const n = Math.floor(Number(count));
  if (!Number.isFinite(n) || n <= 0) return null;
  return {
    image: n > 9 ? 'badge-9plus.png' : `badge-${n}.png`,
    description: n === 1 ? '1 session needs you' : `${n} sessions need you`,
  };
}
