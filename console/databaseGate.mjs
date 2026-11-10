// Whether this installation hosts every database engine the project file's `databases` name, read from the default
// branch's project file (projectFile.mjs). When it does not, no session that would get databases starts: New session,
// My settings and the API say why, and a label or /woodshed comment gets the reason on its issue (fleet.mjs). A
// session started anyway, from a branch whose own file differs, stops at start with the same reason
// (session/entrypoint.sh, requireDatabases).
import { notHostedReason } from '../shared/databases/index.mjs';

/**
 * @param {{projectDatabases: () => Promise<{engine: string}[]|null>, hosted: string[]}} deps  `projectDatabases` null
 *   when the file could not be read, which refuses nothing; `hosted` the engines the installation hosts
 */
export function createDatabaseGate({ projectDatabases, hosted }) {
  let last = null;

  /** @returns {Promise<string|null>}  why no session can start here, or null */
  async function refusal() {
    const databases = await projectDatabases();
    const reason = databases === null ? null : notHostedReason({ project: { databases }, hosted });
    if (reason !== last) {
      if (reason) console.warn('console: project databases not hosted', { needs: databases.map((d) => d.engine), hosted });
      else if (databases === null) console.warn('console: project file not read, its databases not checked', { hosted });
      else console.log('console: project databases hosted again', { hosted });
    }
    last = reason;
    return reason;
  }

  return {
    refusal,
    /** @returns {string|null}  the last answer, for a page that cannot wait for a read */
    last: () => last,
  };
}
