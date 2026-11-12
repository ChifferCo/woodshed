// Woodshed's own updates, for someone who runs it from a git clone: `install.sh` makes one in ~/.woodshed/src, and a
// server set up by docs/self-host.md runs the console from one. Every hour (and on Check now) the console fetches the
// branch its clone follows and counts the commits it lacks; the Console settings page's Woodshed card lists them, and
// the avatar menu counts them for admins. Update pulls them, builds the session image again when the code it is made
// from changed (install.sh, WOODSHED_BUILD_ONLY), and exits with RESTART_EXIT_CODE, so whatever runs the console
// (install.sh's bin/woodshed, a systemd unit with Restart=on-failure) starts it again on the new code.
//
// A console with no clone, such as the AWS console image, has no card. One that nothing would start again has no Update
// button: the card says the commands instead.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { RESTART_EXIT_CODE } from './githubAppSetup.mjs';

const execFileAsync = promisify(execFile);

export const CHECK_EVERY_MS = 60 * 60_000;
const COMMITS_SHOWN = 30;
// Long enough for the page's last answer to reach the browser before the process ends.
const RESTART_DELAY_MS = 1_000;
// The folders the session image is built from (session/Dockerfile copies them): a change in one means a new image.
const IMAGE_PATHS = ['session', 'shared'];
const LOG_LINES_KEPT = 200;
// The console's own code: its clone is this folder's, unless WOODSHED_CLOUD_CHECKOUT names another.
const OWN_DIR = path.resolve(import.meta.dirname, '..');

const firstLine = (text) => String(text ?? '').trim().split('\n')[0].trim();
const errorText = (err) => firstLine(err?.stderr) || firstLine(err?.message) || String(err);
const short = (sha) => String(sha ?? '').slice(0, 7);

/** @returns {string}  a remote's URL as the page shows it: no user name or token in it */
export function shownRemote(url) {
  const text = String(url ?? '').trim();
  try {
    const parsed = new URL(text);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return text;
  }
}

/** @returns {{sha: string, title: string, author: string, date: string}[]}  `git log`'s lines, as the card lists them */
export function commitRows(text) {
  return String(text ?? '').split('\n').filter(Boolean).map((line) => {
    const [sha, title, author, date] = line.split('\x1f');
    return { sha: short(sha), title, author, date };
  });
}

/**
 * @param {{config: {checkout?: string|null, stateDir: string, launcher: {kind: string, image: string}},
 *          store: {state: object, save: () => void}, supervisor: 'setting'|'systemd'|null,
 *          repo?: () => string|null, token?: (() => Promise<string>)|null, run?: Function, now?: () => number,
 *          spawnImpl?: Function, exit?: (code: number) => void, ownDir?: string}} deps
 *   `repo` is the default project's, whose session image is built; `token` reads it for install.sh (gh's own login
 *   without). `config.checkout` (WOODSHED_CLOUD_CHECKOUT) is the Woodshed folder to follow, the console's own without
 */
export function createWoodshedUpdate({
  config, store, supervisor, repo = () => null, token = null, run = execFileAsync, spawnImpl = spawn, now = Date.now,
  exit = (code) => process.exit(code), ownDir = OWN_DIR,
}) {
  const sourceDir = path.resolve(config.checkout || ownDir);
  const logFile = path.join(config.stateDir, 'woodshed-update.log');
  // Never a password prompt: a remote that asks for one fails instead.
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  let top = null;
  let upstream = null;
  let remoteUrl = null;
  let found = null;
  let compared = null;
  let checkError = null;
  let checkedAt = null;
  let checking = null;
  let job = null;

  const git = async (args) => (await run('git', ['-C', top ?? sourceDir, ...args], { env: gitEnv, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();

  // The clone and the branch it follows, read once: neither changes while the console runs.
  async function find() {
    found ??= (async () => {
      try {
        top = await git(['rev-parse', '--show-toplevel']);
      } catch {
        console.log('woodshedUpdate: not a git clone, no updates to follow', { dir: sourceDir });
        return false;
      }
      try {
        upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
        remoteUrl = shownRemote(await git(['remote', 'get-url', upstream.split('/')[0]]));
      } catch {
        upstream = null;
      }
      console.log('woodshedUpdate: following', { clone: top, upstream, remote: remoteUrl, supervisor });
      return true;
    })();
    return found;
  }

  async function compare() {
    try {
      await git(['fetch', '--quiet', upstream.split('/')[0]]);
      const behindBy = Number(await git(['rev-list', '--count', 'HEAD..@{upstream}']));
      const aheadBy = Number(await git(['rev-list', '--count', '@{upstream}..HEAD']));
      const log = behindBy ? await git(['log', `-${COMMITS_SHOWN}`, '--format=%H%x1f%s%x1f%an%x1f%cI', 'HEAD..@{upstream}']) : '';
      compared = { head: short(await git(['rev-parse', 'HEAD'])), behindBy, aheadBy, commits: commitRows(log) };
      checkError = null;
      console.log('woodshedUpdate: checked', { head: compared.head, upstream, behindBy, aheadBy });
    } catch (err) {
      checkError = `Could not fetch ${upstream} from ${remoteUrl}: ${errorText(err)}`;
      console.warn('woodshedUpdate: check failed', { upstream, message: errorText(err) });
    }
    checkedAt = new Date(now()).toISOString();
  }

  /** Fetches the branch the clone follows, and counts what it lacks; one at a time. */
  async function check() {
    if (!(await find()) || !upstream || job?.state === 'running') return;
    checking ??= compare().finally(() => { checking = null; });
    await checking;
  }

  function step(key) {
    return job.steps.find((s) => s.key === key);
  }

  function begin(key) {
    const s = step(key);
    s.state = 'now';
    s.startedAt = now();
  }

  function finish(key, detail = null) {
    const s = step(key);
    s.state = 'done';
    s.seconds = Math.round((now() - s.startedAt) / 1000);
    s.detail = detail;
  }

  function appendLog(text) {
    job.log = `${job.log}${text}`.split('\n').slice(-LOG_LINES_KEPT).join('\n');
  }

  // install.sh from the new code builds the session image, tagged as the console runs it. Its output goes to the log
  // file, and its last lines to the page.
  async function buildImage() {
    const env = {
      ...gitEnv, WOODSHED_BUILD_ONLY: '1', WOODSHED_IMAGE: config.launcher.image,
      // install.sh keeps the repository's clone and the build's context in its home: the install's own, beside the state.
      WOODSHED_HOME: fs.existsSync(path.join(path.dirname(config.stateDir), 'stack.env')) ? path.dirname(config.stateDir) : path.join(config.stateDir, 'image-build'),
      ...(repo() ? { WOODSHED_REPO: repo() } : {}),
      ...(token ? { GH_TOKEN: await token() } : {}),
    };
    await new Promise((resolve, reject) => {
      const child = spawnImpl('bash', [path.join(sourceDir, 'install.sh')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      const out = fs.createWriteStream(logFile, { flags: 'a' });
      const take = (chunk) => { out.write(chunk); appendLog(String(chunk)); };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      child.on('error', reject);
      child.on('close', (code) => {
        out.end();
        if (code === 0) resolve();
        else reject(new Error(`install.sh stopped with code ${code}: ${firstLine(job.log.trim().split('\n').at(-1))}`));
      });
    });
  }

  async function runUpdate(by) {
    let from = null;
    let pulled = false;
    try {
      begin('pull');
      // Edited or staged files the pull could clash with; files git does not track are left alone.
      const changed = await git(['diff', '--name-only', 'HEAD']);
      if (changed) throw new Error(`the clone has changes of its own (${changed.split('\n').slice(0, 3).join(', ')}): commit or drop them, or update it by hand`);
      from = await git(['rev-parse', 'HEAD']);
      await git(['merge', '--ff-only', '--quiet', '@{upstream}']);
      pulled = true;
      const to = await git(['rev-parse', 'HEAD']);
      job.to = short(to);
      finish('pull', `${short(from)} → ${short(to)}`);
      const imagePaths = IMAGE_PATHS.map((p) => path.relative(top, path.join(sourceDir, p)) || '.');
      const imageChanged = await git(['diff', '--quiet', from, to, '--', ...imagePaths]).then(() => false, () => true);
      if (imageChanged && config.launcher.kind === 'docker') {
        begin('image');
        await buildImage();
        finish('image', config.launcher.image);
      } else {
        // Nothing it is built from changed, or this console's sessions do not run in docker here.
        Object.assign(step('image'), { state: 'done', seconds: null, detail: imageChanged ? 'not built by this console' : 'unchanged' });
      }
      begin('restart');
      store.state.woodshedUpdate = { from: short(from), to: short(to), by, at: new Date(now()).toISOString(), imageBuilt: imageChanged && config.launcher.kind === 'docker' };
      store.save();
      console.log('woodshedUpdate: updated, restarting', { by, from: short(from), to: short(to), imageBuilt: store.state.woodshedUpdate.imageBuilt, exitCode: RESTART_EXIT_CODE });
      job.state = 'restarting';
      setTimeout(() => exit(RESTART_EXIT_CODE), RESTART_DELAY_MS);
    } catch (err) {
      const failed = job.steps.find((s) => s.state === 'now');
      if (failed) Object.assign(failed, { state: 'failed', detail: errorText(err) });
      // The new code never ran: the clone goes back to where it was, so the next start is the code that worked.
      if (pulled) await git(['reset', '--keep', from]).catch((resetErr) => console.error('woodshedUpdate: could not go back', { from: short(from), message: errorText(resetErr) }));
      job.state = 'failed';
      job.error = errorText(err);
      console.warn('woodshedUpdate: update failed', { by, step: failed?.key ?? null, from: short(from), wentBack: pulled, message: job.error });
    }
  }

  /**
   * Pulls the new commits, builds the session image when it changed, and restarts the console. Answers at once; the
   * page follows the steps.
   * @param {{by: string}} args
   */
  async function update({ by }) {
    const refuse = (message) => { throw Object.assign(new Error(message), { shown: true }); };
    if (!(await find())) refuse('This console does not run from a git clone, so it cannot update itself.');
    if (!upstream) refuse('The clone follows no branch: check one out that tracks the remote, such as main.');
    if (!supervisor) refuse('Nothing would start this console again after the update: run it with install.sh\'s bin/woodshed or a systemd unit, or update it by hand.');
    if (job?.state === 'running' || job?.state === 'restarting') refuse('An update is already running.');
    await check();
    if (!compared?.behindBy) refuse(checkError ?? 'Already up to date.');
    job = {
      state: 'running', by, startedAt: new Date(now()).toISOString(), from: compared.head, to: null, error: null, log: '',
      steps: [
        { key: 'pull', state: 'next' },
        { key: 'image', state: 'next' },
        { key: 'restart', state: 'next' },
      ],
    };
    console.log('woodshedUpdate: update started', { by, from: compared.head, behindBy: compared.behindBy, upstream });
    runUpdate(by);
    return view();
  }

  /** What the Woodshed card shows; null on a console with no clone. */
  async function view() {
    if (!(await find())) return null;
    const lines = job?.log.trim().split('\n').filter(Boolean) ?? [];
    return {
      clone: top, upstream, remote: remoteUrl, supervisor, checkedAt, error: checkError,
      ...(compared ?? {}),
      more: compared ? Math.max(0, compared.behindBy - compared.commits.length) : 0,
      job: job && { ...job, log: undefined, logTail: lines.slice(-3) },
      last: store.state.woodshedUpdate ?? null,
    };
  }

  /** @returns {number}  how many commits the clone lacks, as last checked: 0 when unknown */
  function behindBy() {
    return compared?.behindBy ?? 0;
  }

  return { check, update, view, behindBy };
}
