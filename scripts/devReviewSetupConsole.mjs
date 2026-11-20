// The dev console's console on a made-up GitHub for turning on a repo's review (console/reviewSetup.mjs,
// console/bin/devReviewSetup.mjs), so a request can be asked for, approved and applied with no GitHub and no App:
// console/bin/devConsole.mjs starts this instead of providers/console.mjs when DEV_CONSOLE_REVIEW_SETUP=1.
//
// Its repos, which the made-up App reaches:
//   example-org/example-repo   the App has every permission the review setup needs, and the dev console's `local`
//                              is an admin: a request there can be approved and applied
//   example-org/manifest-app   the App has only what the console's own manifest asks for: the page says what it lacks
//   example-org/read-only      `local` may only write to it: the page says only an admin of the repo approves
// The console's Anthropic key is a made-up one, saved in its local secret store before it starts. What the made-up
// GitHub holds is lost when the console stops.
import crypto from 'node:crypto';

import { ALL_PERMISSIONS, MANIFEST_PERMISSIONS, fakeGitHub } from '../console/bin/devReviewSetup.mjs';
import { appGitHub } from '../console/reviewSetup.mjs';
import { secretSpecs } from '../console/secrets.mjs';
import { run } from '../providers/console.mjs';
import { readKey } from '../providers/local/secretKey.mjs';
import { createSecretStore } from '../providers/local/secretStore.mjs';
import { isMain } from '../shared/isMain.mjs';

/** The made-up GitHub, and its App, in appGitHub's shape. */
export function devReviewSetupGitHub(login = process.env.WOODSHED_LOCAL_LOGIN || 'local') {
  const github = fakeGitHub({
    'example-org/example-repo': { admins: [login], permissions: ALL_PERMISSIONS },
    'example-org/manifest-app': { admins: [login], permissions: MANIFEST_PERMISSIONS },
    'example-org/read-only': { writers: [login], permissions: ALL_PERMISSIONS },
  });
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  return { github, app: appGitHub({ appId: 'dev', privateKey, fetchImpl: github.fetch }) };
}

if (isMain(import.meta.url)) {
  const dir = process.env.WOODSHED_LOCAL_SECRETS_DIR;
  const keyFile = process.env.WOODSHED_LOCAL_SECRETS_KEY_FILE;
  if (!dir || !keyFile) throw new Error('devReviewSetupConsole needs the dev console\'s local secret store');
  const store = createSecretStore({ dir, specs: secretSpecs(), key: readKey({ file: keyFile, secretsDir: dir }) });
  await store.write('anthropic-api-key', `sk-ant-dev-made-up-${crypto.randomBytes(6).toString('hex')}`);
  const { github, app } = devReviewSetupGitHub();
  // What it changed, as GitHub would hold it, when the console stops: never the key's value, which is sealed.
  process.on('exit', () => {
    for (const [name, repo] of Object.entries(github.repos)) {
      console.log('devReviewSetup: made-up GitHub', {
        repo: name, files: [...repo.files.keys()], labels: [...repo.labels], workflow: repo.workflow, secrets: [...repo.secrets.keys()],
      });
    }
  });
  run({ reviewSetupGitHub: app });
}
