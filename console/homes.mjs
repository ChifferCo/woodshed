// Each person's saved Claude home: what their private sessions keep across stops (MCP logins, memory, settings,
// transcripts for Resume), as one gzipped tar in a private S3 bucket that only the console's role reaches. Each
// private session also keeps its own, for its Resume: the owner's is whichever of their sessions stopped last, so two
// of them would otherwise overwrite each other's conversation. A shared session keeps one of its own, for its next
// run, under a name no GitHub login can have:
//
//   s3://<bucket>/<login>/claude-home.tar.gz                        what their next new session starts from
//   s3://<bucket>/<login>/sessions/<session id>/claude-home.tar.gz  that session's, for its Resume
//   s3://<bucket>/_sessions/<session id>/claude-home.tar.gz
//
// A session streams it in on stop and out on start, through the session API (sessionApi.mjs). The archive
// passes through the console without being held whole in memory.

import { Transform } from 'node:stream';


export const MAX_HOME_BYTES = 200 * 1024 * 1024;

/** @returns {string}  the name a shared session's home is kept under; GitHub logins never start with `_` */
export function sharedHomeName(id) {
  return `_sessions/${id}`;
}

/** @returns {string}  a private session's own home, beside its owner's */
export function privateSessionHomeName(login, id) {
  return `${login}/sessions/${id}`;
}

/** @returns {Transform}  a pass-through that fails once more than `max` bytes went by */
export function byteLimit(max) {
  let seen = 0;
  return new Transform({
    transform(chunk, _encoding, done) {
      seen += chunk.length;
      if (seen > max) return done(Object.assign(new Error(`the Claude home is over ${Math.round(max / 1024 / 1024)} MB`), { shown: true }));
      return done(null, chunk);
    },
  });
}
