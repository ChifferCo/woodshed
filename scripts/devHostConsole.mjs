// The dev console's console as an embedding program would run it, with a made-up repos hook (console/README.md,
// "Embedding the console"), so Console settings' Repos card can be tried as on a hosted console: the program's list with
// its links to give access, Add repo and Remove going to the program, its refusal with a link, and no name field.
// console/bin/devConsole.mjs starts this instead of providers/console.mjs when DEV_CONSOLE_HOST_REPOS=1. Nothing here
// calls GitHub: the account, its repos and its links are made up, and what is added lasts until the console stops.
// DEV_CONSOLE_BLOCKED_REPO=<owner/name> also gives that repo a made-up blocker through the projectReadiness hook. Each
// repo's settings page gets made-up groups of the program's own through the repoPage hook (settingsMarkup.mjs): their
// forms post nowhere here.
import { run } from '../providers/console.mjs';
import { isMain } from '../shared/isMain.mjs';
import { actions, button, form, group, howTo, html, note, pill, row, sub, textArea, valueBox } from '../console/settingsMarkup.mjs';

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

/** A repos hook in the shape createInstallation takes. The console keeps the changed projects in memory. */
export function devHostRepos() {
  return {
    names: false,
    async list() {
      return { repos: REACHABLE, grant: [GRANT], install: INSTALL, complete: true };
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
      console.log('devHostRepos: repo kept', { repo: found.repo, by });
      return project;
    },
    async remove({ repo, by }) {
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

/**
 * A repoPage hook in the shape createInstallation takes: two groups of a hosting program's own on each repo's settings
 * page, drawn with settingsMarkup.mjs, as a program shows a repo's project file and the data its sessions start from.
 */
export function devRepoPage() {
  return async ({ name, repo }) => html`${[
    group({ id: 'host-project-file', label: 'Project file', note: `How the program installs, runs and tests ${repo}. Made up: the form posts nowhere.` },
      row({ id: 'project-file', title: 'Project file', value: 'A draft the program wrote · not in the repository yet', pill: pill('Drafted', 'work') },
        form({ action: `/dev/host/${encodeURIComponent(name)}/project-file` }, textArea({ name: 'text', value: 'version: 1\napp:\n  start: npm run dev\n', rows: 5 }),
          actions(button('Save', { kind: 'primary' }), button('Save to repo'))))),
    group({ id: 'host-session-data', label: 'Session data', note: 'What the databases of each new session start with.' },
      row({ id: 'data-postgres', title: 'Postgres', value: 'app.dump was not applied · new sessions start from the seed', pill: pill('Failed', 'bad') },
        note('pg_restore: error: unsupported version (1.16) in file header', { error: true }), sub('Nothing was lost.')),
      row({ id: 'data-mongo', title: 'Mongo', value: 'Starts from the seed', pill: pill('From the seed') }),
      row({ id: 'data-tokens', title: 'Data tokens', value: '1 live', pill: pill('1 live') },
        howTo('Send a dump from a job', valueBox(`curl -X PUT --upload-file app.dump https://example.com/api/repos/${repo}/data/postgres`)))),
  ]}`;
}

if (isMain(import.meta.url)) run({ repos: devHostRepos(), projectReadiness: devReadiness(), repoPage: devRepoPage() });
