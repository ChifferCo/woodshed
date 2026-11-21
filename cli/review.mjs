// `woodshed review`: ask a console to turn on Woodshed's review (and QA) for a repo, and follow the request, as the person
// signed in with `woodshed login`. The console applies an approved request with its own GitHub App and Anthropic key
// (console/reviewSetup.mjs): this command line never holds either, nor an admin's token. It reaches only the routes
// console/cliReviewSetup.mjs lists.
//
//   woodshed review enable [--qa] [--qa-runner actions|woodshed] [--ref <commit>] [--no-wait] <owner/repo>
//   woodshed review status [--wait] <id>
//   woodshed review list
//
// Exit codes, as every command's: 0 applied, 2 waiting on a person (an approval, or one that expired with nobody
// deciding), 3 refused (by an approver, withdrawn, or by the console's rules), 1 failed or anything else.
//
// In a session, an agent asks with the session API's POST /review-setup and its SESSION_TOKEN instead (console/README.md,
// "Turning on a repo's review"): no session is handed a command line token.

// How often the wait reads the requests while one waits for an approver (more slowly once it has waited a while: a
// request waits up to 24 hours), and while it is applied.
const PENDING_POLL_MS = 5000;
const PENDING_SLOW_POLL_MS = 30_000;
const SLOW_AFTER_MS = 10 * 60_000;
const APPLYING_POLL_MS = 2000;
// How long the wait keeps trying through a console it cannot reach before it gives up, leaving the request as it is.
const UNREACHABLE_GIVE_UP_MS = 120_000;

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const ID_RE = /^[0-9a-f]{12}$/;
const STATUSES = new Set(['pending', 'applying', 'applied', 'refused', 'failed']);

export const REVIEW_USAGE = `Usage: woodshed review <command> [--console <url>] [--json]

Commands:
  enable [options] <owner/repo>   ask the console to turn on Woodshed's review for a repo; an admin of the repo
                                  approves it on the page this prints, and the console applies it with its own
                                  GitHub App and Anthropic key. Waits until it is applied, refused, failed or expired
      --qa                        QA too, in the repo's CI, when a pull request gets the woodshed-qa label
      --qa-runner actions|woodshed   where QA runs: the repo's CI, or a Woodshed session (implies --qa)
      --ref <commit>              pin an older commit of Woodshed's workflows that Woodshed's main has (default: main)
      --no-wait                   print the request and its approval page, and return at once (exit 2)
  status [--wait] <id>            one request: its status, each step, and, for those who can write to the repo, what
                                  approving it would change. --wait waits as enable does
  list                            the requests you asked for, newest first

A request waits 24 hours for an approver, then expires. Ctrl-C stops the wait, not the request.

Exit codes: 0 applied, 2 waiting on a person (an approval) or expired, 3 refused, 1 failed or anything else.`;

// What a console says reaches a terminal: never a control character or a direction override, which could move the
// cursor, retitle the window or make one name read as another.
// eslint-disable-next-line no-control-regex
const UNPRINTABLE_RE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
function printable(text, most = 300) {
  if (text === null || text === undefined) return null;
  return String(text).replace(UNPRINTABLE_RE, ' ').slice(0, most);
}

/** @returns {boolean}  a request that nobody decided within its time: the console refuses it as expired */
export function isExpired(request) {
  return request.status === 'refused' && request.decidedBy === 'console';
}

/** @returns {'pending'|'applying'|'applied'|'refused'|'expired'|'failed'}  the request's outcome, as this command says it */
export function outcomeOf(request) {
  return isExpired(request) ? 'expired' : request.status;
}

/** @returns {number}  the exit code a request's state gives, from `EXIT` */
export function exitFor(request, EXIT) {
  const outcome = outcomeOf(request);
  if (outcome === 'applied') return EXIT.done;
  if (outcome === 'refused') return EXIT.refused;
  if (outcome === 'failed') return EXIT.failed;
  // pending, applying and expired: a person still has something to do (approve it, or ask again for one).
  return EXIT.waiting;
}

/**
 * The approval page, on the console this command line signed in to. The console's own `url` is taken only when it is
 * that console's page for this request (a hosted console adds its query); otherwise it is built here from the id alone,
 * so what is printed is never another site's address.
 * @returns {string|null}
 */
export function approvalPage(origin, id, given) {
  if (!ID_RE.test(String(id))) return null;
  try {
    const url = new URL(String(given ?? ''));
    if (url.origin === origin && url.pathname === `/review-setup/${id}` && !url.hash && !url.username && !url.password) return url.href;
  } catch {
    // Not an address: built below.
  }
  return new URL(`/review-setup/${id}`, origin).href;
}

/** The fields printed of a request, with the console's text made printable. */
export function requestSummary(r, { origin }) {
  const steps = Array.isArray(r.steps) ? r.steps : [];
  return {
    id: r.id,
    repo: printable(r.repo, 140),
    qa: printable(r.qa, 20),
    ref: printable(r.ref, 60),
    status: printable(r.status, 20),
    outcome: outcomeOf(r),
    why: printable(r.why),
    url: approvalPage(origin, r.id, r.url),
    createdAt: printable(r.createdAt, 40),
    expiresAt: printable(r.expiresAt, 40),
    decidedAt: printable(r.decidedAt, 40),
    decidedBy: printable(r.decidedBy, 60),
    steps: steps.map((s) => ({ key: printable(s?.key, 40), what: printable(s?.what, 200), state: printable(s?.state, 20), note: printable(s?.note) })),
  };
}

// The plan, as the page shows it to someone who can write to the repo: what approving it would change. The files'
// text is in --json; a terminal gets one line a step.
function planSummary(plan) {
  if (!plan || typeof plan !== 'object') return null;
  return {
    branch: printable(plan.branch, 200),
    blockers: (Array.isArray(plan.blockers) ? plan.blockers : []).map((b) => printable(b)),
    setsKey: Boolean(plan.setsKey),
    steps: (Array.isArray(plan.steps) ? plan.steps : []).map((s) => ({
      key: printable(s?.key, 40), what: printable(s?.what, 200), change: Boolean(s?.change),
      missing: (Array.isArray(s?.missing) ? s.missing : []).map((m) => printable(m, 60)), path: printable(s?.path, 200), text: typeof s?.text === 'string' ? s.text : null,
    })),
  };
}

function qaWords(qa) {
  if (qa === 'actions') return ', with QA in its CI';
  if (qa === 'woodshed') return ', with QA as a Woodshed session';
  return '';
}

/**
 * @param {{origin: string|null, rest: string[]}} args  `rest`: what follows `review` on the command line
 * @param {object} deps  from woodshed.mjs: `call`, `token`, `say`, `emit`, `json`, `sleep`, `now`, `EXIT`, `fail`,
 *   `stdout`, `stderr`
 * @returns {Promise<number>}  the exit code
 */
export async function reviewCommand({ origin, rest }, deps) {
  const { EXIT, stdout } = deps;
  const [sub, ...words] = rest;
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    stdout.write(`${REVIEW_USAGE}\n`);
    return sub ? EXIT.done : EXIT.failed;
  }
  const { call, token, say, emit, json, sleep, now, fail, stderr } = deps;

  function options(allowed) {
    const out = { positional: [] };
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const [name, inline] = word.startsWith('--') && word.includes('=') ? [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)] : [word, null];
      if (!word.startsWith('-')) out.positional.push(word);
      else if (!allowed[name]) throw fail(`unknown option ${word} for review ${sub}\n\n${REVIEW_USAGE}`);
      else if (allowed[name] === 'flag') out[name] = true;
      else {
        const value = inline ?? words[++i];
        if (value === undefined || value === '') throw fail(`${name} needs a value`);
        out[name] = value;
      }
    }
    return out;
  }

  if (!token) {
    if (json) emit({ event: 'error', status: 'signed-out', error: `not signed in to ${origin}` });
    else stderr.write(`woodshed: not signed in to ${origin}. Run: woodshed login --console ${origin}\n`);
    return EXIT.waiting;
  }

  // An answer that is not the console's to this command: a sign-in that ended, or a console from before it.
  async function notAnswered(status, body) {
    if (status === 401) {
      const me = await call(origin, '/api/cli/me', { token }).catch(() => null);
      if (me?.status === 200) return fail(`${origin} does not let the command line turn on a repo's review: it is from before woodshed review`);
      return fail(`The sign-in to ${origin} ended: it was revoked, or it expired. Run: woodshed login --console ${origin}`, { code: EXIT.waiting, status: 'signed-out' });
    }
    const said = printable(body?.error);
    if (status === 403 || status === 404 || status === 429) return fail(said ?? `${origin} refused it (${status})`, { code: EXIT.refused, status: 'refused' });
    if (status >= 500) return fail(`${origin} answered ${status}${said ? `: ${said}` : ': the console failed. Try again, or ask whoever runs it to look at its log'}`);
    return fail(said ?? `${origin} answered ${status}: it is not a Woodshed console, or one from before woodshed review`);
  }

  async function getOne(id) {
    const got = await call(origin, `/api/review-setup/${id}`, { token });
    // None of that id, or none this person may read: the console says which it is no more than the page does.
    if (got.status === 404 && got.body?.error === 'no such request') throw fail(`no request ${id} that you can see on ${origin}: woodshed review list shows yours`);
    if (got.status !== 200 || !got.body || got.body.id !== id) throw await notAnswered(got.status, got.body);
    return got.body;
  }

  function printRequest(r, { plan = null, canApprove = null } = {}) {
    const s = requestSummary(r, { origin });
    say(`Request ${s.id}: turn on Woodshed's review for ${s.repo}${qaWords(r.qa)}`);
    say(`  Status:   ${s.outcome}${s.why ? `: ${s.why}` : ''}`);
    say(`  Approve:  ${s.url}`);
    if (s.ref) say(`  Pinned:   Woodshed ${s.ref.slice(0, 12)}`);
    if (s.outcome === 'pending') say(`  Expires:  ${s.expiresAt}`);
    if (s.decidedBy && s.outcome !== 'pending') say(`  Decided:  ${s.decidedAt} by ${s.decidedBy === 'console' ? 'the console' : `@${s.decidedBy}`}`);
    for (const step of s.steps) say(`  ${(step.state ?? '').padEnd(7)} ${step.what}${step.note ? ` (${step.note})` : ''}`);
    if (plan) {
      say(`  Approving it would, on ${plan.branch ?? 'the default branch'}:`);
      for (const step of plan.steps) say(`    ${step.change ? 'change' : 'keep  '}  ${step.what}${step.missing.length ? ` (the App lacks ${step.missing.join(', ')})` : ''}`);
    }
    if (canApprove && s.outcome === 'pending') say(canApprove.ok ? '  You can approve it on its page.' : `  ${printable(canApprove.why) ?? 'An admin of the repo approves it on its page.'}`);
  }

  // Waits until the request is decided, saying each change. While it waits for an approver it reads the list (no
  // GitHub call at the console); once approved, the request itself, for each step as it is done.
  async function wait(first) {
    let last = first;
    let unreachableSince = null;
    let seenSteps = 0;
    const since = now();
    // Each step once, as it is done (or kept, or failed), in order.
    const showSteps = (r) => {
      const steps = Array.isArray(r.steps) ? r.steps : [];
      for (const step of steps.slice(seenSteps)) {
        if (step?.state !== 'done' && step?.state !== 'failed' && step?.state !== 'kept') break;
        if (json) emit({ event: 'step', id: r.id, key: printable(step.key, 40), what: printable(step.what, 200), state: printable(step.state, 20), note: printable(step.note) });
        else say(`  ${printable(step.state, 20).padEnd(7)} ${printable(step.what, 200)}${step.note ? ` (${printable(step.note)})` : ''}`);
        seenSteps += 1;
      }
    };
    for (;;) {
      if (!['pending', 'applying'].includes(last.status)) break;
      await sleep(last.status !== 'pending' ? APPLYING_POLL_MS : now() - since < SLOW_AFTER_MS ? PENDING_POLL_MS : PENDING_SLOW_POLL_MS);
      let next;
      try {
        if (last.status === 'pending') {
          const listed = await call(origin, '/api/review-setup', { token });
          if (listed.status !== 200 || !Array.isArray(listed.body?.requests)) throw await notAnswered(listed.status, listed.body);
          next = listed.body.requests.find((r) => r?.id === last.id);
          if (!next) throw fail(`${origin} no longer lists request ${last.id}`);
        } else {
          next = await getOne(last.id);
        }
        unreachableSince = null;
      } catch (err) {
        if (!err.unreachable) throw err;
        unreachableSince ??= now();
        if (now() - unreachableSince >= UNREACHABLE_GIVE_UP_MS) {
          throw fail(`${err.message}. The request is unchanged by this: woodshed review status ${last.id} --wait follows it again`);
        }
        if (!json) stderr.write(`woodshed: ${err.message}; trying again\n`);
        continue;
      }
      if (!STATUSES.has(next.status)) throw fail(`${origin} answered a status this command does not know: ${printable(next.status, 20)}`);
      if (next.status !== last.status) {
        if (json) emit({ event: 'status', ...requestSummary(next, { origin }) });
        if (next.status === 'applying') say('Approved. Applying…');
      }
      showSteps(next);
      last = next;
    }
    // The end: read once more, for the steps and why, as much as the console shows this person.
    let end = last;
    try {
      end = await getOne(last.id);
    } catch {
      // What the list said is enough to end on.
    }
    showSteps(end);
    const s = requestSummary(end, { origin });
    if (json) emit({ event: 'done', ...s });
    else if (s.outcome === 'applied') say(`Applied: Woodshed's review is on for ${s.repo}${qaWords(end.qa)}. It runs on the next pull request.`);
    else if (s.outcome === 'expired') say(`Expired: nobody approved it within 24 hours. Ask again with woodshed review enable ${s.repo}.`);
    else if (s.outcome === 'refused') say(`Refused: ${s.why ?? 'by an approver'}.`);
    else {
      say(`Failed: ${s.why ?? 'at one of its steps'}`);
      say(`See ${s.url}`);
    }
    return exitFor(end, EXIT);
  }

  if (sub === 'enable') {
    const opts = options({ '--qa': 'flag', '--qa-runner': 'value', '--ref': 'value', '--no-wait': 'flag' });
    const [repo, extra] = opts.positional;
    if (!repo) throw fail(`review enable needs a repo: woodshed review enable <owner/repo>\n\n${REVIEW_USAGE}`);
    if (extra) throw fail(`unexpected ${extra}`);
    if (!REPO_RE.test(repo)) throw fail(`${repo} is not owner/repo`);
    const runner = opts['--qa-runner'] ?? null;
    if (runner !== null && runner !== 'actions' && runner !== 'woodshed') throw fail('--qa-runner is actions or woodshed');
    const body = { repo, ...(opts['--qa'] ? { qa: true } : {}), ...(runner ? { qaRunner: runner } : {}), ...(opts['--ref'] ? { ref: opts['--ref'] } : {}) };
    const made = await call(origin, '/api/review-setup', { method: 'POST', token, body });
    if ((made.status !== 201 && made.status !== 200) || !made.body || !ID_RE.test(String(made.body.id))) throw await notAnswered(made.status, made.body);
    const request = made.body;
    const s = requestSummary(request, { origin });
    if (json) emit({ event: 'requested', created: made.status === 201, ...s });
    say(made.status === 201 ? `Asked ${origin} to turn on Woodshed's review for ${s.repo}${qaWords(request.qa)}.` : `A request for ${s.repo} already waits: ${s.id}.`);
    if (request.status === 'pending') {
      say(`An admin of ${s.repo} approves it at:`);
      say(`  ${s.url}`);
    }
    if (opts['--no-wait']) {
      say(`Not waiting. Follow it with: woodshed review status ${s.id} --wait`);
      return exitFor(request, EXIT);
    }
    say('Waiting for the approval… (Ctrl-C stops waiting; the request stays)');
    return wait(request);
  }

  if (sub === 'status') {
    const opts = options({ '--wait': 'flag' });
    const [id, extra] = opts.positional;
    if (!id) throw fail(`review status needs a request's id: woodshed review list shows them\n\n${REVIEW_USAGE}`);
    if (extra) throw fail(`unexpected ${extra}`);
    if (!ID_RE.test(id)) throw fail(`${id} is not a request's id (12 hex digits)`);
    const r = await getOne(id);
    const plan = planSummary(r.plan);
    const canApprove = r.canApprove && typeof r.canApprove === 'object' ? { ok: Boolean(r.canApprove.ok), why: printable(r.canApprove.why) } : null;
    if (json) emit({ ...requestSummary(r, { origin }), ...(plan ? { plan } : {}), ...(canApprove ? { canApprove } : {}) });
    else printRequest(r, { plan, canApprove });
    if (opts['--wait'] && ['pending', 'applying'].includes(r.status)) {
      say('Waiting… (Ctrl-C stops waiting; the request stays)');
      return wait(r);
    }
    return exitFor(r, EXIT);
  }

  if (sub === 'list') {
    const opts = options({});
    if (opts.positional.length) throw fail(`unexpected ${opts.positional[0]}`);
    const listed = await call(origin, '/api/review-setup', { token });
    if (listed.status !== 200 || !Array.isArray(listed.body?.requests)) throw await notAnswered(listed.status, listed.body);
    const rows = listed.body.requests.filter((r) => r && ID_RE.test(String(r.id))).map((r) => requestSummary(r, { origin }));
    if (json) {
      emit({ console: origin, requests: rows });
      return EXIT.done;
    }
    if (!rows.length) {
      say(`You have asked ${origin} for no review yet. Ask with: woodshed review enable <owner/repo>`);
      return EXIT.done;
    }
    const table = [['ID', 'STATUS', 'QA', 'ASKED', 'REPO'], ...rows.map((r) => [r.id, r.outcome, r.qa ?? '', (r.createdAt ?? '').slice(0, 16).replace('T', ' '), r.repo])];
    const widths = table[0].map((_, i) => Math.max(...table.map((row) => String(row[i]).length)));
    for (const row of table) say(row.map((cell, i) => (i === row.length - 1 ? cell : String(cell).padEnd(widths[i] + 2))).join('').trimEnd());
    return EXIT.done;
  }

  throw fail(`unknown command review ${sub}\n\n${REVIEW_USAGE}`);
}
