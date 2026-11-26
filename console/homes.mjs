// Each person's saved Claude home: what their private sessions keep across stops (MCP logins, memory, settings,
// transcripts for Resume), as one gzipped tar in a private S3 bucket that only the console's role reaches. Each
// private session also keeps its own, for its Resume: the owner's is whichever of their sessions stopped last, so two
// of them would otherwise overwrite each other's conversation. A shared session keeps one of its own, for its next
// run, under a name no GitHub login can have:
//
//   s3://<bucket>/<login>/claude-home.tar.gz                        what their next new session starts from
//   s3://<bucket>/<login>/sessions/<session id>/claude-home.tar.gz  that session's, for its Resume
//   s3://<bucket>/_sessions/<session id>/claude-home.tar.gz
//   s3://<bucket>/<login>/sessions/<session id>/conversation.json   that session's conversation, as its Chat draws it
//   s3://<bucket>/_sessions/<session id>/conversation.json
//
// A session streams it in on stop and out on start, through the session API (sessionApi.mjs). The archive
// passes through the console without being held whole in memory.
//
// The conversation beside a session's home is the one its Chat shows while it is stopped or paused
// (shared/savedConversation.mjs): small JSON, written whole, and deleted with the home (each store's `remove`).

import { Transform } from 'node:stream';

import logins from './public/logins.cjs';

const { loginKey } = logins;

export const MAX_HOME_BYTES = 200 * 1024 * 1024;

/** @returns {string}  the name a shared session's home is kept under; GitHub logins never start with `_` */
export function sharedHomeName(id) {
  return `_sessions/${id}`;
}

/** @returns {string}  a private session's own home, beside its owner's */
export function privateSessionHomeName(login, id) {
  return `${login}/sessions/${id}`;
}

/** @returns {string}  where a session's own home is kept, private or shared */
export function sessionHomeName(session) {
  return session.owner ? privateSessionHomeName(session.owner, session.id) : sharedHomeName(session.id);
}

/** @returns {string}  the key of the conversation kept beside a home (putText, getText), by the home's name */
export function conversationKey(homeName) {
  return `${loginKey(homeName)}/conversation.json`;
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
