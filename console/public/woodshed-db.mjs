// Your own Woodshed databases, on your computer. My settings gives you the command that runs this:
//
//   WOODSHED_TOKEN=wt_... node woodshed-db.mjs https://woodshed.example.com
//
// It prints your connection strings, then listens on localhost for each database the installation runs (Postgres on
// 15432, Mongo on 37017; --pg-port and --mongo-port pick others) and carries each connection your tool makes to the
// console, which passes it on to your database (console/dbTunnel.mjs). Plain Node 18.3 or later, nothing to install. Ctrl-C stops it.

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { parseArgs } from 'node:util';

const PROTOCOL = 'woodshed-tunnel';

function fail(message) {
  console.error(`woodshed-db: ${message}`);
  process.exit(1);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { 'pg-port': { type: 'string', default: '15432' }, 'mongo-port': { type: 'string', default: '37017' } },
});
if (!positionals[0]) fail('usage: WOODSHED_TOKEN=wt_... node woodshed-db.mjs <console URL> [--pg-port 15432] [--mongo-port 37017]');
const consoleUrl = new URL(positionals[0]);
const token = process.env.WOODSHED_TOKEN;
if (!token) fail('set WOODSHED_TOKEN to the token My settings made for you');
const authorization = `Bearer ${token}`;
const client = consoleUrl.protocol === 'https:' ? https : http;

async function connectionDetails() {
  let res;
  try {
    res = await fetch(new URL('/api/tunnel/connection', consoleUrl), { headers: { authorization } });
  } catch (err) {
    fail(`the console did not answer: ${err.cause?.message ?? err.message}`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) fail(body.error ?? `the console answered ${res.status}`);
  return body;
}

// One request per connection: the console answers 101, and from then on the socket is the database's.
function carry(kind, local) {
  local.pause();
  const req = client.request({
    hostname: consoleUrl.hostname,
    port: consoleUrl.port || (consoleUrl.protocol === 'https:' ? 443 : 80),
    path: `/api/tunnel/${kind}`,
    headers: { connection: 'Upgrade', upgrade: PROTOCOL, authorization },
    agent: false,
  });
  req.on('upgrade', (res, remote, head) => {
    if (head.length) local.write(head);
    remote.pipe(local);
    local.pipe(remote);
    local.resume();
    remote.on('error', () => local.destroy());
    remote.on('close', () => local.destroy());
    local.on('close', () => remote.destroy());
  });
  req.on('response', (res) => {
    let text = '';
    res.on('data', (chunk) => { text += chunk; });
    res.on('end', () => {
      console.error(`woodshed-db: ${kind} refused (${res.statusCode}): ${text.trim() || 'no reason given'}`);
      local.destroy();
    });
  });
  req.on('error', (err) => {
    console.error(`woodshed-db: ${kind}: the console did not answer: ${err.message}`);
    local.destroy();
  });
  local.on('error', () => req.destroy());
  req.end();
}

function listen(kind, port, flag) {
  return new Promise((resolve) => {
    const server = net.createServer((local) => carry(kind, local));
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') fail(`port ${port} is in use on this computer: pick another with ${flag} <port>`);
      fail(`could not listen on ${port}: ${err.message}`);
    });
    server.listen(Number(port), '127.0.0.1', resolve);
  });
}

// `kinds`: the databases the installation runs, each with its own port here.
const { user, password, database, kinds } = await connectionDetails();
const pgPort = values['pg-port'];
const mongoPort = values['mongo-port'];
if (kinds.includes('postgres')) await listen('pg', pgPort, '--pg-port');
if (kinds.includes('mongo')) await listen('mongo', mongoPort, '--mongo-port');
const secret = encodeURIComponent(password);
// RDS refuses connections without TLS; it is RDS's own, end to end, and its name is not localhost, hence require.
if (kinds.includes('postgres')) console.log(`Postgres  postgres://${user}:${secret}@localhost:${pgPort}/${database}?sslmode=require`);
if (kinds.includes('mongo')) console.log(`Mongo     mongodb://${user}:${secret}@localhost:${mongoPort}/${database}?authSource=${database}&directConnection=true`);
console.log('\nOpen while this runs. Ctrl-C stops it. The token lasts 12 hours; make a new one on My settings after that.');
