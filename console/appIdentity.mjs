// Who the console's GitHub App is on GitHub: its slug, and the login its comments and pushes carry (`<slug>[bot]`).
// Read from GitHub once and kept, since an App's slug only changes when someone renames it; a failed read is tried
// again on the next ask. Each installation names its App itself (/setup/github makes it), so nothing may assume one.

/**
 * @param {{appApi: {app: () => Promise<{slug: string}>}|null}} opts  without an App, there is no identity
 * @returns {{available: boolean, login: () => Promise<string|null>, known: () => {slug: string, login: string}|null}}
 *   `available` is whether there is an App at all; `login` reads GitHub if it has to, null when it could not;
 *   `known` answers at once, with what is kept so far
 */
export function createAppIdentity({ appApi }) {
  let kept = null;
  let reading = null;

  async function read() {
    const { slug } = await appApi.app();
    if (!slug) throw new Error('GitHub named no slug for the App');
    kept = { slug, login: `${slug}[bot]` };
    console.log('console: GitHub App identity read', { slug });
    return kept;
  }

  async function login() {
    if (!appApi) return null;
    if (kept) return kept.login;
    reading ??= read().finally(() => { reading = null; });
    try {
      return (await reading).login;
    } catch (err) {
      console.warn('console: GitHub App identity not read', { message: String(err?.message ?? err).split('\n')[0] });
      return null;
    }
  }

  return { available: Boolean(appApi), login, known: () => kept };
}
