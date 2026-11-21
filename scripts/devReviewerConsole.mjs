// The dev console with a made-up GitHub App and reviewer App, lent as a host lends its own (createInstallation's
// `hostApp`), so `woodshed review enable` and `status` can be tried against it with no GitHub: console/bin/devConsole.mjs
// starts this instead of providers/console.mjs when DEV_CONSOLE_REVIEWER is set.
//
//   DEV_CONSOLE_REVIEWER=none        no reviewer App made yet: the console says an admin makes it
//   DEV_CONSOLE_REVIEWER=made        made, but not installed on example-org/example-repo
//   DEV_CONSOLE_REVIEWER=installed   made and installed there: nothing is missing on the console's side
//
// The reviewer App submits nothing here: no review session runs on the dev console.
import { run } from '../providers/console.mjs';
import { isMain } from '../shared/isMain.mjs';

/** @returns {object}  createInstallation's `hostApp`, with the reviewer App in the state `which` names */
export function devHostApp(which = process.env.DEV_CONSOLE_REVIEWER) {
  const made = which === 'made' || which === 'installed';
  return {
    login: () => 'dev-woodshed[bot]',
    reviewer: {
      login: () => (made ? 'dev-woodshed-reviewer[bot]' : null),
      configured: () => made,
      installedOn: async (repo) => which === 'installed' && repo.toLowerCase() === 'example-org/example-repo',
      view: async () => ({ installUrl: made ? 'https://github.com/apps/dev-woodshed-reviewer/installations/new' : null }),
      submitReview: async () => { throw new Error('the dev console\'s reviewer App submits no review'); },
    },
  };
}

if (isMain(import.meta.url)) run({ hostApp: devHostApp() });
