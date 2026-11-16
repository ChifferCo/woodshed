// A throwaway helper for testing the review session end to end. Do not merge.

/**
 * The items on one page, pages counted from 1.
 * @param {{items: unknown[], page: number, size: number}} args
 * @returns {unknown[]}
 */
export function pageOf({ items, page, size }) {
  const start = (page - 1) * size;
  return items.slice(start, start + size);
}
