// The dev console's console as an embedding program would run it, with a made-up repos hook (console/README.md,
// "Embedding the console"), so Console settings' Repos card can be tried as on a hosted console: the program's list with
// its links to give access, Add repo and Remove going to the program, its refusal with a link, and no name field.
// console/bin/devConsole.mjs starts this instead of providers/console.mjs when DEV_CONSOLE_HOST_REPOS=1. Nothing here
// calls GitHub: the account, its repos and its links are made up, and what is added lasts until the console stops.
// DEV_CONSOLE_BLOCKED_REPO=<owner/name> also gives that repo a made-up blocker through the projectReadiness hook.
import { run } from '../providers/console.mjs';
import { isMain } from '../shared/isMain.mjs';

const ACCOUNT = 'acme';
const GRANT = { account: ACCOUNT, href: `https://github.com/organizations/${ACCOUNT}/settings/installations/1` };
const INSTALL = 'https://github.com/apps/example-app/installations/new';
// What the made-up App reaches. Any other repo on the account is refused with the link to give it access; a repo on
// another account with the link to install the App there.
const REACHABLE = [
  { repo: `${ACCOUNT}/api`, private: true },
  { repo: `${ACCOUNT}/web`, private: false },
  { repo: `${ACCOUNT}/lib`, private: false },
];

const refusal = (message, link) => Object.assign(new Error(message), { shown: true, link });

/** A repos hook in the shape createInstallation takes, over a list kept in memory. */
export function devHostRepos() {
  const kept = new Map();
  return {
    names: false,
    async list() {
      return { repos: REACHABLE.filter((r) => !kept.has(r.repo.toLowerCase())), grant: [GRANT], install: INSTALL };
    },
    async add({ repo, by }) {
      const wanted = repo.toLowerCase();
      const found = REACHABLE.find((r) => r.repo === wanted);
      if (!found) {
        if (wanted.split('/')[0] === ACCOUNT) {
          throw refusal(`The App is installed on ${ACCOUNT}, but may not reach ${repo}, or the repo does not exist. Give it access to the repo on GitHub, then add it again.`,
            { href: GRANT.href, text: `Give the App access on ${ACCOUNT}` });
        }
        throw refusal(`The App is not installed on ${repo.split('/')[0]}, or ${repo} does not exist. Install the App on it, then add it again.`,
          { href: INSTALL, text: 'Install the App' });
      }
      const project = { name: found.repo.split('/')[1], repo: found.repo };
      kept.set(wanted, project);
      console.log('devHostRepos: repo kept', { repo: found.repo, by });
      return project;
    },
    async remove({ repo, by }) {
      kept.delete(repo.toLowerCase());
      console.log('devHostRepos: repo dropped', { repo, by });
    },
  };
}

/**
 * A projectReadiness hook in the shape createInstallation takes: DEV_CONSOLE_BLOCKED_REPO=acme/api says that repo's
 * session image is not built, as a hosting program would when an install secret has no value, so New session's and
 * Console settings' Needs setup card can be tried. No repo is blocked without it.
 */
export function devReadiness(blocked = process.env.DEV_CONSOLE_BLOCKED_REPO || '') {
  if (!blocked) return null;
  return async ({ name, repo }) => (repo.toLowerCase() !== blocked.toLowerCase() ? null : {
    reason: `${repo}'s session image is not built: its install secret NPM_TOKEN has no value.`,
    fix: [
      { text: `Give NPM_TOKEN a value in ${repo}'s settings.`, href: `/console-settings/repos/${encodeURIComponent(name)}`, label: 'Open its settings' },
      { text: 'Build the session image again. It takes a few minutes.', href: 'https://example.com/acme/builds', label: 'Open the builds' },
    ],
    ask: { who: ['ana-admin', 'bo-admin'] },
  });
}

if (isMain(import.meta.url)) run({ repos: devHostRepos(), projectReadiness: devReadiness() });
