// An HTTPS front for the console's /chatgpt route, on 127.0.0.1, for a review whose Codex runs on its author's ChatGPT
// login (session/review.sh, REVIEW_CODEX_AUTH=chatgpt). codex will only talk to a ChatGPT backend over https (its
// workspace routing refuses any other origin), and a session reaches the console over plain http on the session API's
// port. So codex is pointed here, trusting only the certificate review.sh made for this run (CODEX_CA_CERTIFICATE), and
// each call goes on to the console as it came, where the proxy (console/openaiProxy.mjs) swaps the session's token for
// the author's login. Nothing here holds more than the session's own token, which the calls already carry.
//
//   node chatgptRelay.mjs <cert.pem> <key.pem> <console url>   prints the port it listens on, then serves until killed

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { isMain } from '../shared/isMain.mjs';

// The connection's own headers: never passed on.
const HOP_HEADERS = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'upgrade', 'transfer-encoding']);

/**
 * @param {{cert: string|Buffer, key: string|Buffer, consoleUrl: string}} opts
 * @returns {https.Server}  not yet listening
 */
export function createRelay({ cert, key, consoleUrl }) {
  const target = new URL(consoleUrl);
  const transport = target.protocol === 'https:' ? https : http;
  const base = target.pathname.replace(/\/$/, '');
  return https.createServer({ cert, key }, (req, res) => {
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) if (!HOP_HEADERS.has(name)) headers[name] = value;
    headers.host = target.host;
    const out = transport.request({
      protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, method: req.method,
      path: `${base}/chatgpt${req.url}`, headers,
    }, (answer) => {
      const back = { ...answer.headers };
      delete back.connection;
      delete back['transfer-encoding'];
      res.writeHead(answer.statusCode, back);
      answer.pipe(res);
    });
    out.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `the console was not reached: ${err.message}` } }));
      } else res.destroy();
    });
    // codex cancels a turn by closing its request: the call to the console goes with it.
    res.on('close', () => { if (!res.writableFinished) out.destroy(); });
    req.pipe(out);
  });
}

if (isMain(import.meta.url)) {
  const [certFile, keyFile, consoleUrl] = process.argv.slice(2);
  if (!certFile || !keyFile || !consoleUrl) {
    console.error('usage: chatgptRelay.mjs <cert.pem> <key.pem> <console url>');
    process.exit(2);
  }
  const relay = createRelay({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile), consoleUrl });
  relay.listen(0, '127.0.0.1', () => { process.stdout.write(`${relay.address().port}\n`); });
}
