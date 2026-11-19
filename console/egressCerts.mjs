// The certificates the egress proxy (egressProxy.mjs) shows a tainted session for GitHub's hosts, so it can read each
// request and check its repo. Made by the `openssl` CLI (the console image has it, with ca-certificates), once, in the
// console's state folder, readable by the console's user alone.
//
// The authority is constrained to GitHub's names (nameConstraints), so a session that trusts it trusts nothing else
// from it: a copy of its key could sign for github.com and no other site. A session trusts it only once tainted
// (session/statusd.mjs, POST /taint), through the variables git, curl, gh and Node read.

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CA_DAYS = 3650;
const LEAF_DAYS = 365;

async function exists(file) {
  return Boolean(await fs.stat(file).catch(() => null));
}

/**
 * @param {{dir: string, hosts: Iterable<string>, openssl?: string}} opts  `hosts` the names the leaves are for
 * @returns {{caPem: () => Promise<string>, leaf: (host: string) => Promise<{key: string, cert: string}>}}
 */
export function createEgressCerts({ dir, hosts, openssl = 'openssl' }) {
  const allowed = new Set(hosts);
  const ca = { key: path.join(dir, 'egress-ca.key'), cert: path.join(dir, 'egress-ca.pem') };
  let ready = null;
  const leaves = new Map();

  async function run(args) {
    await execFileAsync(openssl, args, { timeout: 30_000 });
  }

  async function makeCa() {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    if (await exists(ca.key) && await exists(ca.cert)) return;
    const config = path.join(dir, `egress-ca-${crypto.randomUUID()}.cnf`);
    // Only GitHub's names, so the authority is no use for any other site.
    const names = [...new Set([...allowed].map((h) => h.split('.').slice(-2).join('.')))].map((d) => `permitted;DNS:${d}`).join(',');
    await fs.writeFile(config, [
      '[req]', 'distinguished_name=dn', 'x509_extensions=ext', 'prompt=no',
      '[dn]', 'CN=Woodshed egress proxy (this console only)',
      '[ext]', 'basicConstraints=critical,CA:TRUE,pathlen:0', 'keyUsage=critical,keyCertSign,cRLSign',
      `nameConstraints=critical,${names}`, 'subjectKeyIdentifier=hash',
    ].join('\n'), { mode: 0o600 });
    try {
      await run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', String(CA_DAYS), '-keyout', ca.key, '-out', ca.cert, '-config', config]);
      await fs.chmod(ca.key, 0o600);
    } finally {
      await fs.rm(config, { force: true });
    }
    console.log('egress: certificate authority made', { dir, names });
  }

  async function caReady() {
    ready ??= makeCa().catch((err) => {
      ready = null;
      throw new Error(`the egress proxy's certificate authority could not be made (is openssl installed?): ${String(err?.stderr || err?.message || err).trim().split('\n')[0]}`);
    });
    return ready;
  }

  async function makeLeaf(host) {
    await caReady();
    const id = crypto.randomUUID();
    const files = Object.fromEntries(['key', 'csr', 'cert', 'cnf'].map((ext) => [ext, path.join(dir, `leaf-${id}.${ext}`)]));
    await fs.writeFile(files.cnf, [
      'basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature,keyEncipherment', 'extendedKeyUsage=serverAuth',
      `subjectAltName=DNS:${host}`,
    ].join('\n'), { mode: 0o600 });
    try {
      await run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-keyout', files.key, '-out', files.csr, '-subj', `/CN=${host}`]);
      await run(['x509', '-req', '-sha256', '-in', files.csr, '-CA', ca.cert, '-CAkey', ca.key, '-set_serial', `0x${crypto.randomBytes(12).toString('hex')}`,
        '-days', String(LEAF_DAYS), '-extfile', files.cnf, '-out', files.cert]);
      return { key: await fs.readFile(files.key, 'utf8'), cert: await fs.readFile(files.cert, 'utf8') };
    } finally {
      await Promise.all(Object.values(files).map((f) => fs.rm(f, { force: true })));
    }
  }

  return {
    async caPem() {
      await caReady();
      return fs.readFile(ca.cert, 'utf8');
    },
    /** A key and certificate for one of `hosts`, made once and kept in memory. */
    leaf(host) {
      if (!allowed.has(host)) return Promise.reject(new Error(`no certificate is made for ${host}`));
      if (!leaves.has(host)) leaves.set(host, makeLeaf(host).catch((err) => { leaves.delete(host); throw err; }));
      return leaves.get(host);
    },
  };
}
