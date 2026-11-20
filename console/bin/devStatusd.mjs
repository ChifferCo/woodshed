// A made-up session's statusd, as the dev console starts one (devChatSession.mjs, devAppsSession.mjs): on loopback
// alone (STATUSD_HOST), and ready once it says it listens. One that exits, fails to spawn or says nothing in time is a
// failed start, with the end of what it wrote, rather than a dev console that waits on it for ever.

const READY_MS = 15_000;

/**
 * @param {import('node:child_process').ChildProcess} child  statusd, spawned with stdout and stderr piped
 * @param {{ms?: number}} [opts]
 * @returns {Promise<void>}  resolves on `statusd: listening`; rejects with why it did not start
 */
export function statusdReady(child, { ms = READY_MS } = {}) {
  return new Promise((resolve, reject) => {
    let said = '';
    const keep = (chunk) => { said = (said + String(chunk)).slice(-2000); };
    const done = (err) => {
      clearTimeout(timer);
      child.stdout.off('data', onOut);
      child.stderr.off('data', keep);
      child.off('exit', onExit);
      child.off('error', onError);
      if (err) reject(err);
      else resolve();
    };
    const lastLines = () => said.trim().split('\n').slice(-5).join('\n');
    const onOut = (chunk) => {
      keep(chunk);
      if (said.includes('statusd: listening')) done();
    };
    const onExit = (code, signal) => done(new Error(`statusd exited before it listened (${signal ?? `code ${code}`})${said ? `:\n${lastLines()}` : ''}`));
    const onError = (err) => done(new Error(`statusd did not start: ${err.message}`));
    const timer = setTimeout(() => done(new Error(`statusd did not listen within ${ms / 1000} s${said ? `:\n${lastLines()}` : ''}`)), ms);
    child.stdout.on('data', onOut);
    child.stderr.on('data', keep);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}
