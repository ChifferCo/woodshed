// The console's whole state is one JSON file: the sessions and the GitHub
// polling cursors. Every change is written straight away, through a temp file
// and a rename, so a crash leaves either the old file or the new one.

import fs from 'node:fs';
import path from 'node:path';

const EMPTY_STATE = { sessions: [], github: null };

/**
 * @param {string} dir
 * @returns {{state: {sessions: object[], github: object|null}, save: () => void}}
 */
export function openStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'state.json');
  let state = structuredClone(EMPTY_STATE);
  if (fs.existsSync(file)) {
    state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  }
  return {
    state,
    save() {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
  };
}
