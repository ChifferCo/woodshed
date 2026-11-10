// Whether this module is the one node was started with. Node gives a module its real path, but process.argv[1] the path
// it was called by, so a script run through a symlink would otherwise think it was imported and do nothing, exiting 0.
// The session image once kept its old path as one, and the db-admin task ran through it.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export function isMain(moduleUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return moduleUrl === pathToFileURL(fs.realpathSync(entry)).href;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}
