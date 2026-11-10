// The secret store a person picks on the dashboard, for a console started with no secrets settings: the Secrets page,
// My settings and every session's secrets read and write through this, and what it is backed by can change while the
// console runs. The choice is kept in `<stateDir>/secrets-manager.json`, so the console comes back on it.
//
//   local  sealed files in `<stateDir>/secrets`, with the key in `<stateDir>/secrets.key` (made on first use)
//   aws    Secrets Manager under a prefix, through the AWS CLI and whatever credentials it finds
//
// Until one is chosen, a read finds nothing and a write says to choose one.
import fs from 'node:fs';
import path from 'node:path';

import { awsCli } from '../aws/ecsLauncher.mjs';
import { createSecretStore as createAwsStore } from '../aws/secretStore.mjs';
import { readKey, writeNewKey } from './secretKey.mjs';
import { createSecretStore as createLocalStore } from './secretStore.mjs';

export const DEFAULT_AWS_PREFIX = 'woodshed-cloud/';
const PREFIX_RE = /^[A-Za-z0-9/_+=.@-]{0,100}$/;

function shown(message) {
  return Object.assign(new Error(message), { shown: true });
}

function firstLine(err) {
  return String(err?.stderr ?? err?.message ?? err).trim().split('\n')[0].slice(0, 300);
}

/**
 * @param {{stateDir: string, specs: object[], aws?: typeof awsCli}} opts  `specs` is secretSpecs()'s; `aws` is the CLI, which tests replace
 */
export function createSecretSlot({ stateDir, specs, aws = awsCli }) {
  const choiceFile = path.join(stateDir, 'secrets-manager.json');
  const localDir = path.join(stateDir, 'secrets');
  const keyFile = path.join(stateDir, 'secrets.key');
  let choice = null;
  let backend = null;

  function localBackend() {
    if (!fs.existsSync(keyFile)) {
      writeNewKey(keyFile);
      console.log('secrets: key made for the local secret store', { keyFile });
    }
    const store = createLocalStore({ dir: localDir, specs, key: readKey({ file: keyFile, secretsDir: localDir }) });
    store.sealPlainFiles().catch((err) => console.error('secrets: plain files not sealed', { message: err.message }));
    return store;
  }

  function open(next) {
    if (next.kind === 'local') return localBackend();
    return createAwsStore({ prefix: next.prefix, aws, specs });
  }

  /** @returns {{kind: 'local'}|{kind: 'aws', prefix: string}}  the choice as it is kept, or throws a refusal */
  function parseChoice({ kind, prefix }) {
    if (kind === 'local') return { kind };
    if (kind !== 'aws') throw shown('choose local or aws');
    const text = String(prefix ?? DEFAULT_AWS_PREFIX).trim();
    if (!PREFIX_RE.test(text)) throw shown('the prefix may hold letters, digits and / _ + = . @ - only');
    return { kind, prefix: text };
  }

  try {
    choice = JSON.parse(fs.readFileSync(choiceFile, 'utf8'));
    backend = open(choice);
    console.log('secrets: store chosen on the dashboard', { kind: choice.kind });
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('secrets: the chosen store is not usable', { message: firstLine(err) });
    choice = null;
    backend = null;
  }

  /**
   * Switches the store. AWS is asked to list first, so a missing CLI or credentials are said now, not at the first save.
   * Secrets already in the old store stay there.
   */
  async function configure(request) {
    const next = parseChoice(request ?? {});
    let opened;
    try {
      opened = open(next);
      if (next.kind === 'aws') await opened.list();
    } catch (err) {
      console.warn('secrets: the chosen store could not be opened', { kind: next.kind, message: firstLine(err) });
      throw shown(next.kind === 'aws' ? `AWS Secrets Manager could not be reached: ${firstLine(err)}` : firstLine(err));
    }
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(choiceFile, JSON.stringify(next), { mode: 0o600 });
    choice = next;
    backend = opened;
    console.log('secrets: store chosen on the dashboard', { kind: next.kind });
    return describe();
  }

  /** @returns {{kind: 'local'|'aws'|null, prefix: string|null, dir: string|null}} */
  function describe() {
    return { kind: choice?.kind ?? null, prefix: choice?.prefix ?? null, dir: choice?.kind === 'local' ? localDir : null, defaultPrefix: DEFAULT_AWS_PREFIX };
  }

  function needed() {
    return shown('this console has no secrets manager yet: choose one on the Secrets page');
  }

  async function write(name, value) {
    if (!backend) throw needed();
    // Nothing made the secret ahead, as Terraform does in AWS: a first write creates it.
    if (choice.kind === 'aws') return backend.save(name, value, `Woodshed: ${name}`);
    return backend.write(name, value);
  }

  async function save(name, value, description) {
    if (!backend) throw needed();
    return backend.save(name, value, description);
  }

  return {
    configure, describe,
    configured: () => backend !== null,
    list: async () => (backend ? backend.list() : []),
    read: async (name) => (backend ? backend.read(name) : null),
    write, save,
    remove: async (name) => { if (backend) await backend.remove(name); },
  };
}
