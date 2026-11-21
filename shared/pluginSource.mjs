// A Claude plugin's marketplace as the shared settings carry it (session/settingsSync.mjs's plugin items): only what a
// session can add again, never what claude recorded whole. A folder's path is the computer's, and a URL can hold a
// sign-in, so neither ever leaves the home it was recorded in: such a source goes as its kind alone.

const REPO_RE = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;
const KIND_RE = /^[a-z][a-z-]{0,19}$/;

/**
 * @param {unknown} source  known_marketplaces.json's `source` for the marketplace
 * @returns {{source: 'github', repo: string}|{source: 'git'|'url', url: string}|{source: string}|null}  a GitHub repo, or a
 *   git or marketplace.json URL over https with no sign-in, query, ref or path; any other kind as its name alone
 */
export function carriedSource(source) {
  if (!source || typeof source !== 'object') return null;
  if (source.source === 'github' && typeof source.repo === 'string' && REPO_RE.test(source.repo) && !source.ref && !source.path) {
    return { source: 'github', repo: source.repo };
  }
  if ((source.source === 'git' || source.source === 'url') && typeof source.url === 'string' && !source.ref && !source.path && !/\s/.test(source.url)) {
    let url = null;
    try {
      url = new URL(source.url);
    } catch {}
    if (url && url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) return { source: source.source, url: url.href };
  }
  return { source: typeof source.source === 'string' && KIND_RE.test(source.source) ? source.source : 'other' };
}

/** Whether a value is one carriedSource gives (or null): what the console takes for a plugin's item. */
export function isCarriedSource(value) {
  if (value === null) return true;
  return JSON.stringify(carriedSource(value)) === JSON.stringify(value);
}

/** @returns {string|null}  what `claude plugin marketplace add` takes for a carried source, null when a session cannot add it */
export function marketplaceArg(source) {
  const carried = carriedSource(source);
  return carried?.repo ?? carried?.url ?? null;
}
