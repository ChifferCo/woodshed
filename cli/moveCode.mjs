// `woodshed move`'s code side: the work in a checkout, frozen into one commit and pushed to a branch of its own, so a
// session can check it out. The person's branch, index and working tree are never touched: the commit is built in a
// temporary index (GIT_INDEX_FILE), from everything git sees, untracked files included and ignored ones left out, and
// pushed by its hash.
//
// A file that looks like a secret, by its name or its content, refuses the move: it would reach GitHub, and the session.
// What is said of one is its path, line and kind, never the value. Ignored files such as `.env` never go; `woodshed
// settings push --own-files` is how a person's own env files reach their sessions.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GIT_MS = 60_000;
const PUSH_MS = 180_000;
// A text file larger than this cannot be looked through for secrets, and refuses the move: a log can hold a token.
const SCAN_BYTES = 20 * 1024 * 1024;

/**
 * Runs git in a folder. Never through a shell; GIT_TERMINAL_PROMPT=0 so a push with no credential fails rather than
 * waits on a prompt nobody sees. `input` is piped to it; `raw` keeps its output as bytes; `limit` stops reading after
 * that many bytes.
 * @returns {(args: string[], opts?: {cwd?: string, env?: object, timeoutMs?: number, input?: string, raw?: boolean}) => Promise<{code: number|null, stdout: string|Buffer, stderr: string}>}
 */
export function gitRunner({ bin = 'git', env = process.env } = {}) {
  return (args, { cwd, env: extra = {}, timeoutMs = GIT_MS, input = null, raw = false, limit = null } = {}) => new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env: { ...env, GIT_TERMINAL_PROMPT: '0', ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    let read = 0;
    child.stdout.on('data', (d) => {
      out.push(d);
      read += d.length;
      // Only the first bytes were asked for: the rest is not read.
      if (limit !== null && read >= limit) child.kill('SIGTERM');
    });
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout: raw ? Buffer.alloc(0) : '', stderr: String(e.message) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const bytes = Buffer.concat(out);
      resolve({ code, stdout: raw ? bytes : bytes.toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? undefined);
  });
}

const lastLine = (out) => `${out.stderr}\n${out.stdout}`.trim().split('\n').filter(Boolean).at(-1) ?? `git exited ${out.code}`;

/**
 * The GitHub repo a remote's URL names, as owner/name, or null for one that is not GitHub's.
 * @returns {string|null}
 */
export function githubRepo(url) {
  const text = String(url ?? '').trim();
  const match = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(text);
  return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * The checkout a folder is in: its top, the folder's place under it, the remote its branch pushes to and the GitHub
 * repo that remote is.
 * @returns {Promise<{root: string, subdir: string, remote: string, repo: string, head: string|null, branch: string|null}|{error: string}>}
 */
export async function checkoutOf(git, cwd) {
  const top = await git(['rev-parse', '--show-toplevel'], { cwd });
  if (top.code !== 0) return { error: `${cwd} is not in a git checkout` };
  const root = top.stdout.trim();
  // hc says where a terminal is as the OS resolves it (/private/tmp on macOS), and git may say it otherwise.
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  const subdir = path.relative(real(root), real(cwd)).split(path.sep).join('/');
  if (subdir.startsWith('..')) return { error: `${cwd} is not in a git checkout` };
  const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: root });
  const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: root });
  const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd: root });
  const remotes = (await git(['remote'], { cwd: root })).stdout.split('\n').filter(Boolean);
  const fromUpstream = upstream.code === 0 ? remotes.find((r) => upstream.stdout.trim().startsWith(`${r}/`)) : null;
  const remote = fromUpstream ?? (remotes.includes('origin') ? 'origin' : remotes[0]);
  if (!remote) return { error: `${root} has no remote to push to` };
  // As configured, before git's own url.*.insteadOf rewriting, which is git's business when it pushes.
  const url = (await git(['config', '--get', `remote.${remote}.pushurl`], { cwd: root })).stdout.trim()
    || (await git(['config', '--get', `remote.${remote}.url`], { cwd: root })).stdout.trim();
  const repo = githubRepo(url);
  if (!repo) return { error: `${root}'s remote ${remote} is not a GitHub repo (${url.replace(/\/\/[^@/]*@/, '//')})` };
  // A remote that pushes to several places (two pushurls) would send the work to each: only one is the repo checked.
  const pushes = (await git(['remote', 'get-url', '--push', '--all', remote], { cwd: root })).stdout.split('\n').filter(Boolean);
  if (pushes.length > 1) return { error: `${root}'s remote ${remote} pushes to ${pushes.length} places, and the move pushes to one: give it one pushurl` };
  // Where git really pushes, after its url.*.pushInsteadOf rewriting, is that repo on GitHub, or a folder on this
  // computer (a local mirror, which publishes nothing). Anywhere else, the work would go somewhere not checked.
  const pushTo = pushes[0] ?? url;
  const local = /^(file:\/\/|\/|\.\.?\/)/.test(pushTo);
  if (!local && githubRepo(pushTo)?.toLowerCase() !== repo.toLowerCase()) {
    return { error: `${root}'s remote ${remote} is ${repo}, but git pushes it to ${pushTo.replace(/\/\/[^@/]*@/, '//')} (a url rewrite): the move pushes only to the repo it checked` };
  }
  return {
    root, subdir: subdir === '' ? '' : subdir, remote, repo, pushUrl: pushTo,
    head: head.code === 0 ? head.stdout.trim() : null, branch: branch.code === 0 ? branch.stdout.trim() : null,
  };
}

// File names that hold secrets, whatever is in them. An example, sample or template of an env file is not one.
const SECRET_NAMES = [
  [/(^|\/)\.env(\.(?!example$|sample$|template$|dist$|defaults$)[^/]+)?$/i, 'an env file'],
  [/\.(pem|key|p12|pfx|jks|keystore|ppk|asc|gpg|kdbx)$/i, 'a key file'],
  [/(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, 'an SSH private key'],
  [/(^|\/)(\.netrc|\.pgpass|\.htpasswd|\.git-credentials|\.dockercfg|credentials|credentials\.json|client_secret[^/]*\.json|service[-_]account[^/]*\.json)$/i, 'a credentials file'],
  [/(^|\/)secrets?\.(json|ya?ml|toml|env)$/i, 'a secrets file'],
  [/\.tfstate(\.backup)?$/i, 'Terraform state'],
];

// Secrets by their shape. Each is named by its kind; the match itself is never printed.
const SECRET_CONTENT = [
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/, 'a private key'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, 'an AWS access key'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'a GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{50,}\b/, 'a GitHub token'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, 'an Anthropic key'],
  [/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{40,}/, 'an OpenAI key'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\b[rs]k_live_[A-Za-z0-9]{20,}/, 'a Stripe key'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'a Google API key'],
  [/\bwsc_[0-9a-f]{64}\b/, 'a Woodshed command line token'],
  [/:_authToken=(?!\$\{)[^\s'"]{8,}/, 'an npm token'],
];

/** @returns {string|null}  why a path's name alone makes it a secret */
export function secretName(file) {
  return SECRET_NAMES.find(([re]) => re.test(file))?.[1] ?? null;
}

/**
 * The secrets in a file's text that its earlier text (the commit it changes) did not already hold.
 * @returns {{line: number, kind: string}[]}
 */
export function secretsIn(text, before = '') {
  const found = [];
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const [re, kind] of SECRET_CONTENT) {
      const match = re.exec(lines[i]);
      if (match && !String(before).includes(match[0])) found.push({ line: i + 1, kind });
    }
  }
  return found;
}

/**
 * What would be frozen in a checkout, and what refuses it. The files the commit adds or changes over HEAD (untracked
 * ones included, ignored ones never) are listed; what is looked through for secrets is every file the push would send
 * that the remote does not hold: the snapshot's, and those of commits here not pushed yet, which a later commit may
 * have taken a secret out of while it stays in history. Each is read as git stores it, after its filters. A text file
 * too large to read through refuses the move. The index used is a temporary one; the person's is left as it is.
 * @returns {Promise<{files: {path: string, status: string}[], secrets: {path: string, line: number|null, kind: string}[],
 *          ignoredEnv: string[], tree: string, index: string}>}  `index`: the temporary index, which the caller removes
 */
export async function survey(git, checkout, { tempDir = os.tmpdir(), tag = 'move', scanBytes = SCAN_BYTES } = {}) {
  const { root, head, remote } = checkout;
  const index = path.join(fs.mkdtempSync(path.join(tempDir, `woodshed-${tag}-`)), 'index');
  const env = { GIT_INDEX_FILE: index };
  const step = async (args, opts = {}) => {
    const out = await git(args, { cwd: root, env, ...opts });
    if (out.code !== 0) throw new Error(`git ${args[0]} failed in ${root}: ${lastLine({ ...out, stdout: String(out.stdout) })}`);
    return out.stdout;
  };
  await step(head ? ['read-tree', head] : ['read-tree', '--empty']);
  await step(['add', '-A', '--', '.']);
  const tree = (await step(['write-tree'])).trim();
  const diff = head ? await step(['diff', '--cached', '--name-status', '--no-renames', '-z', head]) : await step(['ls-files', '-z', '--cached']);
  const words = diff.split('\0').filter(Boolean);
  const files = [];
  if (head) for (let i = 0; i + 1 < words.length; i += 2) files.push({ status: words[i], path: words[i + 1] });
  else for (const word of words) files.push({ status: 'A', path: word });

  // The objects the push sends: reachable from the snapshot and HEAD, and from no ref the remote has now. Its refs are
  // asked of it (ls-remote), not taken from this checkout's tracking refs, which can outlive a branch deleted there.
  // The push's own destination, which a remote may have apart from where it fetches from.
  const there = await git(['ls-remote', '--heads', checkout.pushUrl ?? remote], { cwd: root, timeoutMs: 120_000 });
  if (there.code !== 0) throw new Error(`git could not read ${remote}'s branches, so what the push would add cannot be checked: ${lastLine(there)}`);
  const remoteHeads = new Map(there.stdout.split('\n').filter(Boolean).map((l) => l.split('\t')).map(([sha, ref]) => [ref, sha]));
  // Those of them this checkout has, asked in one call.
  const shas = [...new Set(remoteHeads.values())];
  const have = shas.length ? (await git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], { cwd: root, input: `${shas.join('\n')}\n` })).stdout : '';
  const known = have.split('\n').map((l) => l.split(' ')).filter(([, type]) => type === 'commit').map(([sha]) => sha);
  const listed = await step(['rev-list', '--objects', ...(head ? [head] : []), tree, ...(known.length ? ['--not', ...known] : [])], { timeoutMs: 180_000 });
  const pathOf = new Map();
  for (const line of listed.split('\n')) {
    const [sha, ...rest] = line.split(' ');
    if (sha && rest.length) pathOf.set(sha, rest.join(' '));
  }
  const kinds = await step(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { input: `${[...pathOf.keys()].join('\n')}\n` });
  const blobs = kinds.split('\n').map((l) => l.split(' ')).filter(([, type]) => type === 'blob').map(([sha, , size]) => ({ sha, size: Number(size), path: pathOf.get(sha) }));
  // A secret the remote's copy of a file already held is not the move's doing: its branch's, as the remote has it now.
  const upstreamRef = (await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd: root })).stdout.trim();
  const upstreamSha = remoteHeads.get(`refs/heads/${upstreamRef.slice(remote.length + 1)}`) ?? remoteHeads.get(`refs/heads/${checkout.branch}`) ?? null;
  const upstream = upstreamSha && known.includes(upstreamSha) ? upstreamSha : '';
  const secrets = [];
  for (const blob of blobs) {
    const byName = secretName(blob.path);
    if (byName) {
      secrets.push({ path: blob.path, line: null, kind: byName });
      continue;
    }
    const start = (await git(['cat-file', 'blob', blob.sha], { cwd: root, raw: true, limit: 8000 })).stdout;
    // UTF-16 text has NULs in it too: read as such, not skipped as binary.
    const utf16 = utf16Of(start);
    if (!utf16 && start.subarray(0, 8000).includes(0)) continue;
    if (blob.size > scanBytes) {
      secrets.push({ path: blob.path, line: null, kind: `text too large to check for secrets (${Math.max(1, Math.round(blob.size / 1048576))} MB)` });
      continue;
    }
    const bytes = blob.size <= start.length ? start : (await git(['cat-file', 'blob', blob.sha], { cwd: root, raw: true })).stdout;
    const text = utf16 ? decodeUtf16(bytes, utf16) : bytes.toString('utf8');
    const before = upstream ? (await git(['show', `${upstream}:${blob.path}`], { cwd: root })).stdout : '';
    for (const hit of secretsIn(text, before)) secrets.push({ path: blob.path, ...hit });
  }
  // The messages of the commits the push sends are published with them: a token pasted into one is found too.
  if (head) {
    const log = await step(['log', '--format=%H%x00%B%x00', head, ...(known.length ? ['--not', ...known] : [])], { timeoutMs: 120_000 });
    const parts = log.split('\0');
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const sha = parts[i].trim();
      for (const hit of secretsIn(parts[i + 1])) secrets.push({ path: `the message of commit ${sha.slice(0, 12)}`, line: hit.line, kind: hit.kind });
    }
  }
  // Ignored env files are named so the person knows they stay, and how theirs reach a session.
  const ignored = await git(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ':(glob)**/.env', ':(glob)**/.env.*'], { cwd: root });
  const ignoredEnv = ignored.code === 0 ? ignored.stdout.split('\0').filter(Boolean).slice(0, 50) : [];
  const unique = [...new Map(secrets.map((x) => [`${x.path}:${x.line}:${x.kind}`, x])).values()];
  return { files, secrets: unique, ignoredEnv, tree, index };
}

// 'le' or 'be' for text in UTF-16 (a byte-order mark, or every other byte NUL as in ASCII text), else null.
function utf16Of(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'be';
  const n = Math.min(bytes.length, 8000) & ~1;
  if (n < 4) return null;
  let odd = 0;
  let even = 0;
  for (let i = 0; i < n; i += 2) {
    if (bytes[i] === 0) even += 1;
    if (bytes[i + 1] === 0) odd += 1;
  }
  if (odd > n * 0.4 && even === 0) return 'le';
  if (even > n * 0.4 && odd === 0) return 'be';
  return null;
}

function decodeUtf16(bytes, order) {
  const copy = Buffer.from(bytes.subarray(0, bytes.length & ~1));
  if (order === 'be') copy.swap16();
  return copy.toString('utf16le').replace(/^\ufeff/, '');
}

/**
 * The frozen commit: the surveyed tree on top of HEAD, or HEAD itself when nothing changed.
 * @returns {Promise<string>}  its hash
 */
export async function freeze(git, checkout, { tree, message }) {
  const { root, head } = checkout;
  if (head) {
    const headTree = (await git(['rev-parse', `${head}^{tree}`], { cwd: root })).stdout.trim();
    if (headTree === tree) return head;
  }
  const out = await git(['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', message], { cwd: root });
  if (out.code !== 0) throw new Error(`git commit-tree failed in ${checkout.root}: ${lastLine(out)}`);
  return out.stdout.trim();
}

/**
 * Pushes a commit to a new branch. A branch already there is never overwritten: a move's id is new each time.
 * @returns {Promise<{ok: true}|{ok: false, error: string}>}
 */
export async function pushBranch(git, checkout, { commit, branch }) {
  // To the one URL the survey asked (the remote's push URL, rewrites applied), and with no tags following the branch.
  const out = await git(['push', '--porcelain', '--no-follow-tags', checkout.pushUrl ?? checkout.remote, `${commit}:refs/heads/${branch}`], { cwd: checkout.root, timeoutMs: PUSH_MS });
  if (out.code === 0) return { ok: true };
  const rejected = out.stdout.split('\n').find((l) => l.startsWith('!'));
  return { ok: false, error: rejected ? rejected.split('\t').at(-1).trim() || lastLine(out) : lastLine(out) };
}

/** @returns {Promise<boolean>}  whether the branch is gone from the remote */
export async function deleteBranch(git, checkout, branch) {
  const out = await git(['push', '--porcelain', checkout.pushUrl ?? checkout.remote, '--delete', `refs/heads/${branch}`], { cwd: checkout.root, timeoutMs: PUSH_MS });
  return out.code === 0;
}
