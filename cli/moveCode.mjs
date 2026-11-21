// `woodshed move`'s code side: the work in a checkout, frozen into one commit and pushed to a branch of its own, so a
// session can check it out. The person's branch, index and working tree are never touched: the commit is built in a
// temporary index (GIT_INDEX_FILE), from everything git sees, untracked files included and ignored ones left out, and
// pushed by its hash.
//
// A file that looks like a secret, by its name or its content, refuses the move: it would reach GitHub, and the session.
// What is said of one is its path, line and kind, never the value. Ignored files such as `.env` never go; `woodshed
// settings push --own-files` is how a person's own env files reach their sessions.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GIT_MS = 60_000;
const PUSH_MS = 180_000;
// Larger files are not read for secrets: a key or a token is in a small file, and a big one is data.
const SCAN_BYTES = 2 * 1024 * 1024;

/**
 * Runs git in a folder. Never through a shell; GIT_TERMINAL_PROMPT=0 so a push with no credential fails rather than
 * waits on a prompt nobody sees.
 * @returns {(args: string[], opts?: {cwd?: string, env?: object, timeoutMs?: number}) => Promise<{code: number|null, stdout: string, stderr: string}>}
 */
export function gitRunner({ bin = 'git', env = process.env } = {}) {
  return (args, { cwd, env: extra = {}, timeoutMs = GIT_MS } = {}) => new Promise((resolve) => {
    execFile(bin, args, {
      cwd, env: { ...env, GIT_TERMINAL_PROMPT: '0', ...extra }, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8',
    }, (err, stdout, stderr) => {
      const code = !err ? 0 : Number.isInteger(err.code) ? err.code : null;
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
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
  return {
    root, subdir: subdir === '' ? '' : subdir, remote, repo,
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
 * What would be frozen in a checkout, and what refuses it: the files the commit adds or changes over HEAD (untracked
 * ones included, ignored ones never), each looked at for secrets, and the env files git ignores, which stay here.
 * The index used is a temporary one; the person's is left as it is.
 * @returns {Promise<{files: {path: string, status: string}[], secrets: {path: string, line: number|null, kind: string}[],
 *          ignoredEnv: string[], tree: string, index: string}>}  `index`: the temporary index, which the caller removes
 */
export async function survey(git, checkout, { tempDir = os.tmpdir(), tag = 'move' } = {}) {
  const { root, head } = checkout;
  const index = path.join(fs.mkdtempSync(path.join(tempDir, `woodshed-${tag}-`)), 'index');
  const env = { GIT_INDEX_FILE: index };
  const step = async (args) => {
    const out = await git(args, { cwd: root, env });
    if (out.code !== 0) throw new Error(`git ${args[0]} failed in ${root}: ${lastLine(out)}`);
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
  const secrets = [];
  for (const file of files) {
    if (file.status === 'D') continue;
    const byName = secretName(file.path);
    if (byName) {
      secrets.push({ path: file.path, line: null, kind: byName });
      continue;
    }
    let text;
    try {
      const where = path.join(root, file.path);
      const stat = fs.lstatSync(where);
      if (!stat.isFile() || stat.size > SCAN_BYTES) continue;
      text = fs.readFileSync(where, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) continue;
    const before = head && file.status !== 'A' ? (await git(['show', `${head}:${file.path}`], { cwd: root })).stdout : '';
    for (const hit of secretsIn(text, before)) secrets.push({ path: file.path, ...hit });
  }
  // Ignored env files are named so the person knows they stay, and how theirs reach a session.
  const ignored = await git(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ':(glob)**/.env', ':(glob)**/.env.*'], { cwd: root });
  const ignoredEnv = ignored.code === 0 ? ignored.stdout.split('\0').filter(Boolean).slice(0, 50) : [];
  return { files, secrets, ignoredEnv, tree, index };
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
  const out = await git(['push', '--porcelain', checkout.remote, `${commit}:refs/heads/${branch}`], { cwd: checkout.root, timeoutMs: PUSH_MS });
  if (out.code === 0) return { ok: true };
  const rejected = out.stdout.split('\n').find((l) => l.startsWith('!'));
  return { ok: false, error: rejected ? rejected.split('\t').at(-1).trim() || lastLine(out) : lastLine(out) };
}

/** @returns {Promise<boolean>}  whether the branch is gone from the remote */
export async function deleteBranch(git, checkout, branch) {
  const out = await git(['push', '--porcelain', checkout.remote, '--delete', `refs/heads/${branch}`], { cwd: checkout.root, timeoutMs: PUSH_MS });
  return out.code === 0;
}
