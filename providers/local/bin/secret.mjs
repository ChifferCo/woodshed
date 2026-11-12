// The local provider's secret store from a shell. The folder and its key are WOODSHED_LOCAL_SECRETS_DIR and
// WOODSHED_LOCAL_SECRETS_KEY_FILE, as the console's, and `list` shows the Secrets page's, those for
// WOODSHED_INSTALL_SECRET_PAIRS among them.
//   new-key <file>   writes a new key, readable by its owner only, and never over one that is there
//   put <name>       saves the value on stdin, so it is never on a command line or in a shell's history:
//                    `printf %s "$VALUE" | node secret.mjs put db-root/postgres`
//   list             which of the Secrets page's secrets have a value, never a value
import { text } from 'node:stream/consumers';

import { installSecrets } from '../../../console/config.mjs';
import { secretSpecs } from '../../../console/secrets.mjs';
import { isMain } from '../../../shared/isMain.mjs';
import { readKey, writeNewKey } from '../secretKey.mjs';
import { createSecretStore } from '../secretStore.mjs';

const USAGE = 'usage: secret.mjs new-key <file> | secret.mjs put <name> < value | secret.mjs list';

/** @returns {Promise<string>}  what to print */
export async function runSecretCommand({ argv, env, stdin }) {
  const [command, name, ...rest] = argv;
  if (command === 'new-key' && name && !rest.length) {
    try {
      writeNewKey(name);
    } catch (err) {
      if (err.code === 'EEXIST') throw new Error(`${name} is there already: a new key would leave every secret sealed with it unreadable`);
      throw err;
    }
    return `new key in ${name}: keep a copy apart from the secrets folder, since losing it loses every secret`;
  }
  const dir = env.WOODSHED_LOCAL_SECRETS_DIR;
  if (!dir) throw new Error('set WOODSHED_LOCAL_SECRETS_DIR to the console\'s secrets folder');
  if (!env.WOODSHED_LOCAL_SECRETS_KEY_FILE) throw new Error('set WOODSHED_LOCAL_SECRETS_KEY_FILE to the key its files are sealed with');
  const store = createSecretStore({ dir, specs: secretSpecs({ installSecrets: installSecrets(env) }), key: readKey({ file: env.WOODSHED_LOCAL_SECRETS_KEY_FILE, secretsDir: dir }) });
  if (command === 'list' && !name) return (await store.list()).map((s) => `${s.set ? 'set  ' : 'unset'} ${s.name}`).join('\n');
  if (command !== 'put' || !name || rest.length) throw new Error(USAGE);
  const value = (await text(stdin)).replace(/\r?\n$/, '');
  if (!value) throw new Error(`no value on stdin for ${name}`);
  await store.save(name, value, 'set with secret.mjs');
  return `${name} saved (${Buffer.byteLength(value)} bytes)`;
}

if (isMain(import.meta.url)) {
  runSecretCommand({ argv: process.argv.slice(2), env: process.env, stdin: process.stdin })
    .then((out) => console.log(out))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
