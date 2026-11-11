// The owner's own files from My settings (shared/ownFiles.mjs), written into a private session's checkout at start,
// after the env files. A file is written only where git ignores it and does not track it: these are a person's
// secrets (a `.env.production` for their MCP servers), and a file git would see could reach a commit and a pull request.
//
//   node ownFiles.mjs write <repo dir> <json file>   the JSON is {"<path>": "<text>"}; prints what it wrote and skipped
//
// The JSON file is deleted once read, whatever happens next: it holds the person's secrets.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isMain } from '../shared/isMain.mjs';
import { ownFilePathProblem } from '../shared/ownFiles.mjs';

function git(repoDir, args) {
  try {
    execFileSync('git', ['-C', repoDir, ...args], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** @returns {string|null}  why the file is not written, or null when it may be */
export function skipReason(repoDir, file) {
  const problem = ownFilePathProblem(file);
  if (problem) return 'not a path in the repo';
  // A folder on the way that is a symlink could lead out of the checkout.
  const root = fs.realpathSync(repoDir);
  let dir = path.join(repoDir, path.dirname(file));
  while (!fs.existsSync(dir)) dir = path.dirname(dir);
  const real = fs.realpathSync(dir);
  if (real !== root && !real.startsWith(root + path.sep)) return 'a folder on its path leads out of the repo';
  const target = path.join(repoDir, file);
  // lstat, not existsSync: a symlink to nowhere would still be followed by the write.
  let link = false;
  try {
    link = fs.lstatSync(target).isSymbolicLink();
  } catch {}
  if (link) return 'it is a symlink in the checkout';
  if (git(repoDir, ['ls-files', '--error-unmatch', '--', file])) return 'git tracks it';
  if (!git(repoDir, ['check-ignore', '-q', '--no-index', '--', file])) return 'git does not ignore it';
  return null;
}

/**
 * @param {string} repoDir
 * @param {Record<string, unknown>} files
 * @returns {{written: string[], skipped: {file: string, why: string}[]}}
 */
export function writeOwnFiles(repoDir, files) {
  const written = [];
  const skipped = [];
  for (const [file, text] of Object.entries(files ?? {})) {
    if (typeof text !== 'string') {
      skipped.push({ file, why: 'not text' });
      continue;
    }
    const why = skipReason(repoDir, file);
    if (why) {
      skipped.push({ file, why });
      continue;
    }
    const target = path.join(repoDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Readable by this session's user alone, like the other credentials the start writes.
    fs.writeFileSync(target, text, { mode: 0o600 });
    fs.chmodSync(target, 0o600);
    written.push(file);
  }
  return { written, skipped };
}

/** @returns {string}  the start log's words for it */
export function summary({ written, skipped }) {
  const words = [`written: ${written.length ? written.join(', ') : 'none'}`];
  if (skipped.length) words.push(`skipped: ${skipped.map(({ file, why }) => `${file} (${why})`).join(', ')}`);
  return words.join(', ');
}

if (isMain(import.meta.url)) {
  const [command, repoDir, jsonFile] = process.argv.slice(2);
  if (command !== 'write' || !repoDir || !jsonFile) {
    console.error('usage: node ownFiles.mjs write <repo dir> <json file>');
    process.exit(2);
  }
  let files;
  try {
    files = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  } finally {
    fs.rmSync(jsonFile, { force: true });
  }
  const result = writeOwnFiles(repoDir, files);
  process.stdout.write(summary(result));
  if (result.skipped.length) process.exitCode = 3;
}
