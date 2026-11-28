// Analytics' daily buckets (analytics.js): one bucket per local calendar date from the window's first date to its last,
// stepped by date (never by 24 hours, which skips or repeats a date across a daylight-saving change), and a count of
// items into them by the local date of each. Loaded before analytics.js, and by the tests.
(function (root) {
  'use strict';
  const key = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

  /** @returns {{start: string, key: string, a: number, b: number}[]}  `start`: that date's local midnight, ISO */
  function dayBuckets(sinceIso, untilIso) {
    const first = new Date(sinceIso);
    const last = new Date(untilIso);
    const out = [];
    for (let i = 0; i < 400; i++) {
      const d = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i);
      if (d > last) break;
      out.push({ start: d.toISOString(), key: key(d), a: 0, b: 0 });
    }
    return out;
  }

  /**
   * @param {object[]} items
   * @param {(item: object) => string} atOf  when it happened, ISO
   * @param {(item: object) => string} keyOf  which series it counts in ('a' and 'b', or an agent's id)
   */
  function dayCounts(items, atOf, keyOf, sinceIso, untilIso) {
    const buckets = dayBuckets(sinceIso, untilIso);
    const byKey = new Map(buckets.map((b) => [b.key, b]));
    for (const item of items) {
      const bucket = byKey.get(key(new Date(atOf(item))));
      if (bucket) { const k = keyOf(item); bucket[k] = (bucket[k] ?? 0) + 1; }
    }
    return buckets;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { dayBuckets, dayCounts };
  else root.WoodshedAnalyticsDays = { dayBuckets, dayCounts };
}(typeof window !== 'undefined' ? window : globalThis));
