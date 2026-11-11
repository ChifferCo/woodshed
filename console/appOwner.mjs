// Who may sign in to a console that has no repo yet. Sign-in otherwise asks for write access to the default project's
// repo (auth.mjs); with none to ask about, it is whoever owns the account the console's GitHub App is installed on: that
// user, or an admin of that organization. Once an admin adds a repo on the Console settings page, write access to it is
// asked again, as before.

// An org's membership is read with a token narrowed to its members, which the App must be granted: GitHub refuses the
// token (422) or the read (403) when it is not.
const NOT_GRANTED = new Set([403, 422]);

/**
 * @param {{appApi: {installationAccount: (id: string) => Promise<{login: string, type: string}>,
 *          orgMembership: (id: string, org: string, login: string) => Promise<{role: string, state: string}|null>},
 *          installationId: string|null}} deps
 * @returns {(login: string) => Promise<boolean>}  whether `login` owns the App's installation
 * @throws {Error}  when GitHub could not say, with what to change when the App may not read the org's members
 */
export function appOwnerCheck({ appApi, installationId }) {
  let account = null;
  return async (login) => {
    if (!installationId) throw new Error('the console has no GitHub App installation to ask about');
    account ??= await appApi.installationAccount(installationId);
    const wanted = String(login).toLowerCase();
    if (account.type !== 'Organization') {
      const owner = account.login.toLowerCase() === wanted;
      console.log('appOwner: owner checked', { login, account: account.login, type: account.type, owner });
      return owner;
    }
    let membership;
    try {
      membership = await appApi.orgMembership(installationId, account.login, login);
    } catch (err) {
      if (NOT_GRANTED.has(err?.status)) {
        console.warn('appOwner: the App may not read the org\'s members', { org: account.login, status: err.status });
        // Said on the login page: whoever is setting the console up is the one who can fix it.
        throw Object.assign(new Error(`The console has no repo yet, so it lets in admins of ${account.login}, but its GitHub App may not read ${account.login}'s members. Give the App Organization permissions, Members: read, accept the change on its installation, then sign in again.`), { shown: true });
      }
      throw err;
    }
    const owner = membership?.role === 'admin' && membership?.state === 'active';
    console.log('appOwner: owner checked', { login, account: account.login, type: account.type, role: membership?.role ?? null, owner });
    return owner;
  };
}
