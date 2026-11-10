// Lifecycle for the `claude -p` children the review feature spawns.
//
// Modelled on server.mjs's ttyd pool pattern (a Map keyed by a logical id, one
// release() reached from both 'exit' and 'error', a log() on every
// transition), with three things that pattern does not need:
//
//  * A concurrency gate. Each `claude` is 380-475 MB measured on this box, and
//    the box routinely runs with a few GB available and swap already full. The
//    review feature must not be the thing that tips it over.
//  * A wall-clock kill. `--max-budget-usd` exists but was measured NOT to abort
//    a run that overshot its cap (it appears to be checked between turns), so
//    it is defence in depth here and the timeout is the actual control.
//  * An on-disk breadcrumb. woodshed.service sets KillMode=process so
//    tmux sessions survive a restart; the same setting means a `claude -p`
//    child survives too — orphaned, unread, still spending. The breadcrumb is
//    how the next boot finds it.

import fs from 'node:fs';
import { spawn } from 'node:child_process';

import {
  writeJobBreadcrumb,
  clearJobBreadcrumb,
  readJobBreadcrumbs,
  listReviewSessions,
} from './store.mjs';

// One analysis at a time, one explain alongside it. Three concurrent `claude`
// processes would be well over a gigabyte on top of the interactive sessions
// the box exists to run.
const MAX_ANALYSIS_JOBS = 1;
const MAX_EXPLAIN_JOBS = 1;
const MAX_QUEUED = 4;

const ANALYSIS_TIMEOUT_MS = 10 * 60_000;
const EXPLAIN_TIMEOUT_MS = 3 * 60_000;

// Below this the box is already in trouble and spawning a ~400 MB model
// process is the wrong thing to do. Surfaced as a 503, not a silent stall.
export const MIN_AVAILABLE_BYTES = 900 * 1024 * 1024;

// Enough for any explain answer's JSON envelope by a wide margin; a bound
// rather than a target.
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;

/** jobId -> job. Ephemeral by design: the artifact on disk is what persists. */
const jobs = new Map();
const queue = [];
let seq = 0;

export function findJob(predicate) {
  for (const job of jobs.values()) {
    if (predicate(job)) return job;
  }
  return null;
}

function activeCount(kind) {
  let n = 0;
  for (const job of jobs.values()) {
    if (job.kind === kind && job.phase === 'running') n += 1;
  }
  return n;
}

/**
 * MemAvailable in bytes.
 *
 * server.mjs owns the /proc/meminfo parser (readMeminfo) and passes it in, so
 * there is one copy of that parsing rather than a near-duplicate here — the
 * same reason removeWorktree and readProcTable are injected.
 */
export function availableBytes(readMeminfo) {
  if (typeof readMeminfo !== 'function') return Infinity;
  try {
    const mem = readMeminfo();
    // Not Linux, or /proc unreadable: do not block on a reading we cannot take.
    return typeof mem?.MemAvailable === 'number' ? mem.MemAvailable : Infinity;
  } catch {
    return Infinity;
  }
}

/**
 * Queue or start a `claude -p` run.
 *
 * @param {{kind: 'analysis'|'explain', session: string, argv: string[], cwd: string,
 *          log: Function, onLine?: Function}} spec
 * @returns {{ok: true, job: object} | {ok: false, status: number, error: string}}
 */
export function startJob({ kind, session, argv, cwd, log, onLine, readMeminfo }) {
  const limit = kind === 'analysis' ? MAX_ANALYSIS_JOBS : MAX_EXPLAIN_JOBS;

  if (availableBytes(readMeminfo) < MIN_AVAILABLE_BYTES) {
    return {
      ok: false,
      status: 503,
      error: 'the box is low on memory — try again once a session or app frees some',
    };
  }

  seq += 1;
  const job = {
    jobId: `${kind}-${session}-${seq}`,
    kind,
    session,
    argv,
    cwd,
    log,
    onLine,
    phase: 'queued',
    startedAt: null,
    queuedAt: Date.now(),
    child: null,
    stdout: '',
    stderr: '',
    toolCalls: 0,
    currentFile: null,
    result: null,
    error: null,
    timedOut: false,
    // Set by cancelJobsForSession, ahead of the phase change that only lands
    // when the child closes. Declared here so the shape is complete.
    cancelled: false,
    done: null,
  };
  job.done = new Promise(function capture(resolve) {
    job.resolve = resolve;
  });
  jobs.set(job.jobId, job);

  if (activeCount(kind) >= limit) {
    if (queue.length >= MAX_QUEUED) {
      jobs.delete(job.jobId);
      return { ok: false, status: 429, error: 'too many reviews queued — try again shortly' };
    }
    queue.push(job);
    log('review.job_queued', { jobId: job.jobId, kind, session, position: queue.length });
    return { ok: true, job };
  }

  launch(job);
  return { ok: true, job };
}

function launch(job) {
  job.phase = 'running';
  job.startedAt = Date.now();

  // A missing cwd surfaces from spawn as `spawn claude ENOENT`, which reads
  // as "claude is not installed" and sent one debugging session to PATH.
  // The usual cause is the session having been killed, which removes its
  // worktree while the review state that names it is still on disk.
  if (!fs.existsSync(job.cwd)) {
    finish(job, { error: `the session's worktree is gone (${job.cwd}); kill the session and launch the review again` });
    return;
  }

  let child;
  try {
    child = spawn('claude', job.argv, {
      cwd: job.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    finish(job, { error: `could not start claude: ${err.message}` });
    return;
  }

  job.child = child;
  job.pid = child.pid;
  // Guarded: this is sync fs work reached from a 'close' handler via
  // finish() -> drain() -> launch(). A throw there is not a rejected promise —
  // it is an uncaught exception with no handler, and the unit restarts on
  // failure. ENOSPC is plausible on a box that writes 130 MB checkouts, and a
  // missing breadcrumb is not worth taking the shed down for.
  try {
    writeJobBreadcrumb({
      session: job.session,
      job: {
        jobId: job.jobId,
        kind: job.kind,
        pid: child.pid,
        startedAt: job.startedAt,
        // Recorded so the next boot can tell this pid apart from a recycled
        // one without trusting the pid alone. See sweepOrphans.
        cwd: job.cwd,
      },
    });
  } catch (err) {
    job.log('review.breadcrumb_failed', { jobId: job.jobId, session: job.session, error: err?.message });
  }
  job.log('review.job_start', {
    jobId: job.jobId, kind: job.kind, session: job.session, pid: child.pid, cwd: job.cwd,
  });

  const timeoutMs = job.kind === 'analysis' ? ANALYSIS_TIMEOUT_MS : EXPLAIN_TIMEOUT_MS;
  job.timer = setTimeout(function onTimeout() {
    job.timedOut = true;
    job.log('review.job_timeout', { jobId: job.jobId, kind: job.kind, session: job.session, ms: timeoutMs });
    child.kill('SIGTERM');
    setTimeout(function hard() {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }, 5_000).unref();
  }, timeoutMs);

  // See exec.mjs: decoding per chunk mangles any multi-byte character that
  // lands on a boundary, and an explain answer is arbitrary prose.
  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');

  let pending = '';
  child.stdout.on('data', function onOut(chunk) {
    // Only the non-streaming path needs the whole of stdout (explain parses it
    // as one JSON document). For a streaming analysis it is the full
    // stream-json transcript — every tool_result, i.e. the text of every file
    // the run read — and nothing reads it back except the exit note, which
    // wants one line. Accumulating it was multiple MB retained per review.
    if (!job.onLine) {
      if (job.stdout.length < MAX_STDOUT_BYTES) job.stdout += chunk;
    } else {
      job.lastStdoutLine = lastLine(String(chunk)) || job.lastStdoutLine;
    }
    if (!job.onLine) return;
    // stream-json is NDJSON; a chunk boundary can land mid-line.
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        // A line that is not JSON is not worth failing the run over; the
        // result line is what matters and it is validated separately.
        continue;
      }
      // Deliberately outside the try: a defect in the reducer must surface,
      // not silently leave the progress strip empty forever.
      job.onLine(job, event);
    }
  });

  child.stderr.on('data', function onErr(chunk) {
    if (job.stderr.length < 32 * 1024) job.stderr += chunk;
  });

  child.on('error', function onSpawnError(err) {
    finish(job, { error: `claude failed to start: ${err.message}` });
  });
  child.on('close', function onClose(code) {
    if (job.timedOut) {
      finish(job, { error: `the run exceeded its ${Math.round(timeoutMs / 60000)} minute limit` });
      return;
    }
    // A non-zero exit is not automatically a failed run. `claude` can exit 1
    // having already emitted a complete, non-error result line — a run that
    // finished the work and then tripped over something on the way out. The
    // caller decides from the output; the exit code only decides when there is
    // no usable output to decide from.
    if (code !== 0) {
      job.exitCode = code;
      const tail = job.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300)
        || lastLine(job.stdout || job.lastStdoutLine || '').slice(0, 300);
      job.exitNote = `claude exited ${code}${tail ? `: ${tail}` : ''}`;
    }
    finish(job, {});
  });
}

// The last non-empty line of stdout, used to explain a non-zero exit when
// stderr is empty — which for stream-json it usually is, because the result
// (including any error) goes to stdout.
function lastLine(text) {
  const lines = String(text || '').trim().split('\n');
  return lines[lines.length - 1] || '';
}

function finish(job, { error }) {
  if (job.phase === 'done' || job.phase === 'failed') return;
  clearTimeout(job.timer);
  job.phase = error ? 'failed' : 'done';
  job.error = error || null;
  job.endedAt = Date.now();
  // Only this job's own breadcrumb, and only when this job actually wrote one
  // — a queued job cancelled before launch never had a pid and must not delete
  // a running sibling's entry.
  if (job.pid) clearJobBreadcrumb(job.session, job.kind);
  job.log('review.job_end', {
    jobId: job.jobId,
    kind: job.kind,
    session: job.session,
    phase: job.phase,
    ms: job.endedAt - (job.startedAt || job.endedAt),
    toolCalls: job.toolCalls,
    exitCode: job.exitCode,
    error: error || undefined,
    exitNote: job.exitNote,
  });
  job.resolve(job);

  // Reaped after a grace period so a poll arriving just after completion still
  // finds the outcome rather than a 404.
  setTimeout(function forget() {
    jobs.delete(job.jobId);
  }, 5 * 60_000).unref();

  drain();
}

function drain() {
  for (let i = 0; i < queue.length; i += 1) {
    const next = queue[i];
    const limit = next.kind === 'analysis' ? MAX_ANALYSIS_JOBS : MAX_EXPLAIN_JOBS;
    if (activeCount(next.kind) >= limit) continue;
    queue.splice(i, 1);
    launch(next);
    return;
  }
}

/** Stop a running job — used when a review session is killed out from under it. */
export function cancelJobsForSession(session, reason = 'the review session was killed') {
  let killed = 0;
  for (const job of jobs.values()) {
    if (job.session !== session) continue;
    if (job.phase === 'running' && job.child) {
      const child = job.child;
      // Marked synchronously, because SIGTERM is not the end of anything.
      // `phase` does not leave 'running' until the child's close handler runs,
      // so every caller that asks "is an analysis already going for this
      // session?" between here and then gets the wrong answer and declines to
      // start the replacement. Not done by moving `phase` itself: that would
      // free a concurrency slot while the child is still alive.
      job.cancelled = true;
      child.kill('SIGTERM');
      // Escalate, the way the timeout path does. A cancelled job keeps its
      // concurrency slot until the child actually closes, and with
      // MAX_ANALYSIS_JOBS at 1 that means a child ignoring SIGTERM leaves the
      // replacement review queued behind a run nobody wants — self-healing
      // only when ANALYSIS_TIMEOUT_MS fires ten minutes later.
      setTimeout(function hard() {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone, which is the normal case.
        }
      }, 5_000).unref();
      killed += 1;
    }
    if (job.phase === 'queued') {
      const at = queue.indexOf(job);
      if (at !== -1) queue.splice(at, 1);
      finish(job, { error: reason });
    }
  }
  return killed;
}

/**
 * Reap `claude -p` children orphaned by a shed restart.
 *
 * KillMode=process means they outlive us. Each recorded pid is verified three
 * times before anything is signalled — the process must still exist, still be
 * named `claude`, still have this review's worktree as its cwd, AND still be a
 * headless `-p` run — because pids are recycled and, since the redesign, the
 * cwd is no longer unique to a review run.
 */
export function sweepOrphans({ log, readProcTable }) {
  let killed = 0;
  const table = readProcTable ? readProcTable() : null;

  for (const session of listReviewSessions()) {
    for (const crumb of readJobBreadcrumbs(session)) {
      if (!crumb.pid) {
        clearJobBreadcrumb(session, crumb.kind);
        continue;
      }

      const alive = table ? table.has(crumb.pid) : processExists(crumb.pid);
      if (!alive) {
        clearJobBreadcrumb(session, crumb.kind);
        continue;
      }
      // Cheap gate first: server.mjs's proc table carries comm, and a recycled
      // pid is overwhelmingly unlikely to also be named `claude`.
      const comm = table ? table.get(crumb.pid)?.comm : null;
      if (table && comm !== 'claude') {
        log('review.orphan_stale_pid', { session, pid: crumb.pid, comm });
        clearJobBreadcrumb(session, crumb.kind);
        continue;
      }
      if (!crumb.cwd || !cwdMatches(crumb.pid, crumb.cwd)) {
        log('review.orphan_stale_pid', { session, pid: crumb.pid, reason: 'cwd' });
        clearJobBreadcrumb(session, crumb.kind);
        continue;
      }
      // THE check that keeps this safe now. See isHeadlessRun.
      if (!isHeadlessRun(crumb.pid)) {
        log('review.orphan_stale_pid', { session, pid: crumb.pid, reason: 'not a -p run' });
        clearJobBreadcrumb(session, crumb.kind);
        continue;
      }

      try {
        process.kill(crumb.pid, 'SIGTERM');
        killed += 1;
        log('review.orphan_killed', { session, pid: crumb.pid, jobId: crumb.jobId, kind: crumb.kind });
      } catch (err) {
        log('review.orphan_kill_failed', { session, pid: crumb.pid, error: err?.message });
      }
      clearJobBreadcrumb(session, crumb.kind);
    }
  }
  return killed;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Part of the identity check, and no longer sufficient on its own.
//
// It used to be: every review run had its cwd set to that review's private
// checkout, "a path nothing else on the box uses". Under the session-backed
// design that is FALSE — the review's analysis and the session's own
// interactive `claude` share a working directory by design, and both are named
// `claude` in /proc. On its own this check would let the boot sweep SIGTERM the
// user's live session. It is kept as a cheap first filter and paired with
// isHeadlessRun below.
function cwdMatches(pid, expected) {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`) === expected;
  } catch {
    return false;
  }
}

// What actually distinguishes a review run from the interactive session sharing
// its cwd: only the review runs pass `-p` and `--output-format`.
//
// Split on NUL and compare WHOLE arguments. A substring search of the raw
// cmdline would match `--permission-mode`, and the prompt is on this argv too —
// kilobytes of it, containing arbitrary pull request content.
//
// Two flags rather than one, because a whole-argv `-p` is not quite impossible
// to forge: the launch form's optional name reaches argv as `-n <name>`, so a
// session named literally `-p` would put that exact entry there. `-n` takes one
// value, so at most one attacker-chosen standalone entry can exist on an
// interactive argv — requiring two distinct flags cannot be satisfied. (The
// prompt cannot help: it is a single argv entry, so a prompt reading
// `-p --output-format` is one entry containing a space, matching neither.)
function isHeadlessRun(pid) {
  let raw;
  try {
    raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
  } catch {
    // Unreadable means unidentifiable, and an unidentifiable process is one we
    // must not signal.
    return false;
  }
  const argv = raw.split('\0');
  return argv.includes('-p') && argv.includes('--output-format');
}
