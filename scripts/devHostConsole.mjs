// The dev console's console as an embedding program would run it, with a made-up repos hook (console/README.md,
// "Embedding the console"), so Console settings' Repos card can be tried as on a hosted console: the program's list with
// its links to give access, Add repo and Remove going to the program, its refusal with a link, and no name field.
// console/bin/devConsole.mjs starts this instead of providers/console.mjs when DEV_CONSOLE_HOST_REPOS=1. Nothing here
// calls GitHub: the account, its repos and its links are made up, and what is added lasts until the console stops.
// DEV_CONSOLE_BLOCKED_REPO=<owner/name> also gives that repo a made-up blocker through the projectReadiness hook. Each
// repo's settings page gets made-up groups of the program's own through the repoPage hook (settingsMarkup.mjs): their
// forms post nowhere here. Its envSources hook gives the env files of example-org/example-repo (DEV_CONSOLE_REPO_SETTINGS=1)
// a made-up source, "Vault": on for api/.env, off for web/.env.local, none for worker/.env. Its launcher keeps a made-up machine for /s/fa11ed01, made from an older image (a launcher's
// keptMachine, providers/README.md), for its page's Resume on the latest image: the start that follows is the docker
// launcher's own, told `latestImage`, which it logs.
import { run } from '../providers/console.mjs';
import { isMain } from '../shared/isMain.mjs';
import { actions, button, figures, form, group, howTo, html, labelled, note, pill, row, sub, textArea, textField, valueBox } from '../console/settingsMarkup.mjs';

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
    group({ id: 'host-usage', label: 'Usage', note: `What ${repo}'s sessions ran on this month. Made up.` },
      figures([{ label: 'Sessions', value: '42', sub: '6 running now' }, { label: 'Session-hours', value: '318' }, { label: 'Charged', value: '$114.48', sub: '$0.36 an hour' }, { label: 'Dumps kept', value: '2', sub: '1 applied' }])),
    group({ id: 'host-session-data', label: 'Session data', note: 'What the databases of each new session start with.' },
      row({ id: 'data-postgres', title: 'Postgres', value: 'app.dump was not applied · new sessions start from the seed', pill: pill('Failed', 'bad') },
        note('pg_restore: error: unsupported version (1.16) in file header', { error: true }), sub('Nothing was lost.')),
      row({ id: 'data-mongo', title: 'Mongo', value: 'Starts from the seed', pill: pill('From the seed') }),
      row({ id: 'data-tokens', title: 'Data tokens', value: '1 live', pill: pill('1 live') },
        howTo('Send a dump from a job', valueBox(`curl -X PUT --upload-file app.dump https://example.com/api/repos/${repo}/data/postgres`)))),
  ]}`;
}

// The made-up source's env files, by key: the variables "Vault" holds for each, and whether sessions get them.
const VAULT = {
  'api-env': { on: true, path: 'acme/dev/api', text: 'API_URL=https://api.dev.example\nAPI_TOKEN=made-up-token\nQUEUE_URL=https://queue.dev.example\n' },
  'web-env-local': { on: false, path: '', text: '' },
};

/**
 * An envSources hook in the shape createInstallation takes: a made-up secret manager, "Vault", that sets one env file's
 * installation values in place of the typed ones and is off for another. Its controls are drawn with
 * settingsMarkup.mjs inside the file's installation layer, and their forms post nowhere.
 */
export function devEnvSources() {
  const named = (text) => text.split('\n').filter(Boolean).map((l) => l.split('=')[0]);
  const controls = (name, key, { on, path }) => html`${[
    on ? note(`On: sessions get this file's values from ${path}, read at each session's start.`, { ok: true })
      : sub('Off: sessions get the values typed here. Name a path in Vault, then turn it on.'),
    form({ action: `/dev/host/${encodeURIComponent(name)}/vault/${key}` },
      labelled('Path in Vault', textField({ name: 'path', value: path, placeholder: 'acme/dev/web', mono: true })),
      actions(button(on ? 'Save' : 'Turn on', { kind: 'primary' }), on ? button('Turn off', { name: 'off', value: '1' }) : null)),
    sub('Made up: the forms post nowhere.'),
  ]}`;
  return {
    async view({ name, keys }) {
      return Object.fromEntries(keys.filter((key) => VAULT[key]).map((key) => [key, {
        label: 'Vault', on: VAULT[key].on, keys: named(VAULT[key].text), markup: controls(name, key, VAULT[key]),
      }]));
    },
    async forSession() {
      return Object.fromEntries(Object.entries(VAULT).filter(([, file]) => file.on).map(([key, file]) => [key, file.text]));
    },
  };
}

/** The provider's launcher, keeping a made-up outdated machine for `outdated`'s sessions until one resumes on the latest image. */
export function devKeptMachines(provider, outdated = ['fa11ed01']) {
  const kept = new Set(outdated);
  const { launcher } = provider;
  return {
    ...provider,
    launcher: Object.assign(Object.create(launcher), {
      async keptMachine(sessionId) {
        return kept.has(sessionId) ? { outdated: true } : null;
      },
      async start(sessionId, env, options = {}) {
        if (options.latestImage && kept.delete(sessionId)) console.log('devKeptMachines: outdated machine left, a new one made', { sessionId });
        return launcher.start(sessionId, env);
      },
    }),
  };
}

if (isMain(import.meta.url)) run({ repos: devHostRepos(), projectReadiness: devReadiness(), repoPage: devRepoPage(), envSources: devEnvSources(), withProvider: devKeptMachines });
