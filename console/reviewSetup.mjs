// Turning on Woodshed's review, and QA, for a repo: asked for by a session or a person, approved by an admin of the repo,
// and applied by the console with its own GitHub App and its own Anthropic key. It does what scripts/enable-review.sh
// does with a person's gh, without anyone holding an admin token or the key: the one who asks gets an approval link and
// the request's status, never a credential.
//
// A request names the repo, whether QA comes too (in the repo's CI, `actions`, or as a Woodshed session, `woodshed`),
// and the commit of Woodshed's workflows to pin, resolved from Woodshed's main when it is asked for, so the approval
// page shows the exact files. Approving it:
//
//   1. writes .github/workflows/woodshed-review.yml (and woodshed-qa.yml for QA in CI) to the default branch, as one
//      commit each, as the script does: a branch rule that refuses the App's commits fails the request, saying so;
//   2. creates the woodshed-qa label, for QA;
//   3. lets GitHub Actions create and approve pull requests, keeping the repo's default workflow permissions;
//   4. sets ANTHROPIC_API_KEY as an Actions secret from the console's anthropic-api-key, sealed to the repo's public
//      key (sealedBox.mjs), unless the repo has one already, which is left as it is.
//
// Each step needs a permission of the App's installation on the repo (STEP_NEEDS). They are read from GitHub before
// anything is asked of the approver: one missing is named on the page and blocks the approval. Nothing falls back to a
// person's token. The approver must be an admin of the repo on GitHub, and an admin of the console as well when the
// console's own Anthropic key would be copied into the repo, where every workflow can read it.
//
// Requests are kept in state.json under `reviewSetups`, the newest KEPT, each with its history: who asked, who decided,
// and each step's outcome. One not decided within REQUEST_TTL_MS is refused as expired.

import crypto from 'node:crypto';

import { appJwt } from './githubApp.mjs';
import { sealedBox } from './sealedBox.mjs';
import { linkQueryString } from './sessions.mjs';

export const WOODSHED_REPO = 'ChifferCo/woodshed';
export const REQUEST_TTL_MS = 24 * 60 * 60_000;
const KEPT = 200;
// Pending requests one session or person may have at once: enough for a few repos, not a flood of approval links.
const MAX_PENDING_EACH = 5;
const GITHUB_API = 'https://api.github.com';
const GITHUB_HEADERS = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' };
const TOKEN_MARGIN_MS = 5 * 60_000;
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const REF_RE = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const ID_RE = /^[0-9a-f]{12}$/;

export const REVIEW_WORKFLOW = '.github/workflows/woodshed-review.yml';
export const QA_WORKFLOW = '.github/workflows/woodshed-qa.yml';
export const QA_LABEL = { name: 'woodshed-qa', color: '0e8a16', description: 'Run Woodshed QA' };
export const SECRET_NAME = 'ANTHROPIC_API_KEY';

// What each step needs of the App's installation, as GitHub names its permissions.
export const STEP_NEEDS = {
  'review-workflow': { contents: 'write', workflows: 'write' },
  'qa-workflow': { contents: 'write', workflows: 'write' },
  'qa-workflow-removed': { contents: 'write', workflows: 'write' },
  'qa-label': { issues: 'write' },
  approvals: { administration: 'write' },
  secret: { secrets: 'write' },
};
// The names GitHub's App settings page shows them by.
const PERMISSION_NAMES = {
  contents: 'Contents', workflows: 'Workflows', issues: 'Issues', administration: 'Administration', secrets: 'Secrets', metadata: 'Metadata',
};

export const STATUSES = ['pending', 'applying', 'applied', 'refused', 'failed'];

const shown = (message, status = 400) => Object.assign(new Error(message), { shown: true, status });
const firstLine = (err) => String(err?.message ?? err).split('\n')[0].slice(0, 300);

/** @returns {string}  the workflow that calls Woodshed's review, as enable-review.sh writes it */
export function reviewWorkflow(ref) {
  return `name: Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
jobs:
  review:
    permissions: { contents: write, pull-requests: write, issues: read, id-token: write, checks: write }
    uses: ${WOODSHED_REPO}/.github/workflows/review.yml@${ref}
    secrets:
      ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
`;
}

/** @returns {string}  the workflow that runs QA in the repo's CI on the woodshed-qa label, as enable-review.sh writes it */
export function qaWorkflow(ref) {
  return `name: QA
on:
  pull_request:
    types: [labeled]
jobs:
  qa:
    if: github.event.label.name == 'woodshed-qa'
    runs-on: ubuntu-latest
    permissions: { contents: read, pull-requests: write, issues: write, checks: write }
    steps:
      - uses: actions/checkout@v4
        with: { ref: '\${{ github.head_ref }}', fetch-depth: 50 }
      - id: app
        uses: ${WOODSHED_REPO}/.github/actions/qa/app-url@${ref}
      - id: plan
        uses: ${WOODSHED_REPO}/.github/actions/qa/plan@${ref}
        with: { anthropic-api-key: '\${{ secrets.ANTHROPIC_API_KEY }}', app-url: '\${{ steps.app.outputs.url }}' }
      - id: start
        if: steps.plan.outputs.should-run == 'true'
        env:
          START: \${{ steps.app.outputs.start }}
          URL: \${{ steps.app.outputs.url }}
        run: |
          # Start the app the way the project file says, then wait for it.
          if [ -z "$START" ]; then echo "::error::no app.start in .woodshed/project.yaml"; exit 1; fi
          bash -c "$START" > app.log 2>&1 &
          for i in $(seq 60); do curl -sf "$URL" >/dev/null && exit 0; sleep 2; done
          echo "the app did not come up at $URL"; cat app.log; exit 1
      - if: steps.plan.outputs.should-run == 'true'
        timeout-minutes: 15
        uses: ${WOODSHED_REPO}/.github/actions/qa/test@${ref}
        with: { anthropic-api-key: '\${{ secrets.ANTHROPIC_API_KEY }}' }
      - if: \${{ !cancelled() }}
        uses: ${WOODSHED_REPO}/.github/actions/qa/report@${ref}
        with:
          not-covered: \${{ steps.start.outcome == 'failure' && 'the app did not start' || '' }}
`;
}

/**
 * @param {object} body  `{repo, qa?: boolean, qaRunner?: 'actions'|'woodshed', ref?: string}`, as the script's flags:
 *   a `qaRunner` alone asks for QA too
 * @returns {{repo: string, qa: 'none'|'actions'|'woodshed', ref: string|null}}
 * @throws {Error}  `shown`, saying what is wrong
 */
export function parseRequest(body) {
  const repo = String(body?.repo ?? '').trim();
  if (!REPO_RE.test(repo)) throw shown('repo must be owner/name');
  const runner = body?.qaRunner ?? null;
  if (runner !== null && runner !== 'actions' && runner !== 'woodshed') throw shown('qaRunner must be actions or woodshed');
  if (body?.qa != null && typeof body.qa !== 'boolean') throw shown('qa must be true or false');
  const qa = runner ?? (body?.qa ? 'actions' : 'none');
  const ref = body?.ref == null || body.ref === '' ? null : String(body.ref);
  if (ref !== null && !REF_RE.test(ref)) throw shown('ref must be a commit, tag or branch of Woodshed');
  return { repo, qa, ref };
}

function granted(permissions, name, level) {
  const has = permissions?.[name];
  return has === 'write' || (level === 'read' && has === 'read');
}

/** @returns {string[]}  what the installation lacks of `needs`, in the words of GitHub's App settings: `Workflows: write` */
export function missingPermissions(permissions, needs) {
  return Object.entries(needs).filter(([name, level]) => !granted(permissions, name, level))
    .map(([name, level]) => `${PERMISSION_NAMES[name] ?? name}: ${level}`);
}

/**
 * GitHub as the console's App sees it: where the App is installed, and calls made with a token of that installation,
 * narrowed to the repo and the permissions asked for.
 * @param {{appId: string, privateKey: string|(() => string|null), fetchImpl?: typeof fetch, now?: () => number}} opts
 */
export function appGitHub({ appId, privateKey, fetchImpl = fetch, now = Date.now }) {
  const tokens = new Map();
  const key = () => {
    const value = typeof privateKey === 'function' ? privateKey() : privateKey;
    if (!value) throw shown('the console has no GitHub App key yet: upload it on the Secrets page', 503);
    return value;
  };

  async function send(authorization, method, path, body) {
    const res = await fetchImpl(`${GITHUB_API}${path}`, {
      method, headers: { authorization, ...GITHUB_HEADERS }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let answer = {};
    try {
      answer = text ? JSON.parse(text) : {};
    } catch {
      answer = {};
    }
    return { status: res.status, ok: res.ok, body: answer };
  }

  const appCall = (method, path, body) => send(`Bearer ${appJwt({ appId, privateKey: key(), nowMs: now() })}`, method, path, body);

  async function tokenFor({ repo, installationId, permissions }) {
    const cacheKey = `${installationId}\n${repo}\n${JSON.stringify(Object.entries(permissions).sort())}`;
    const kept = tokens.get(cacheKey);
    if (kept && kept.expiresAt - now() > TOKEN_MARGIN_MS) return kept.token;
    const answer = await appCall('POST', `/app/installations/${encodeURIComponent(installationId)}/access_tokens`, { repositories: [repo.split('/')[1]], permissions });
    if (!answer.ok) throw new Error(`GitHub refused the App a token for ${repo}: HTTP ${answer.status} ${String(answer.body.message ?? '').slice(0, 200)}`);
    tokens.set(cacheKey, { token: answer.body.token, expiresAt: Date.parse(answer.body.expires_at) || now() + 30 * 60_000 });
    return answer.body.token;
  }

  return {
    /** @returns {Promise<{id: string, permissions: Record<string, string>}|null>}  null when the App is not on the repo */
    async installationOf(repo) {
      const answer = await appCall('GET', `/repos/${repo}/installation`);
      if (answer.status === 404) return null;
      if (!answer.ok) throw new Error(`GitHub did not say where the App is installed: HTTP ${answer.status} ${String(answer.body.message ?? '').slice(0, 200)}`);
      return { id: String(answer.body.id), permissions: answer.body.permissions ?? {} };
    },
    /** @returns {{call: (method: string, path: string, body?: object) => Promise<{status: number, ok: boolean, body: object}>}} */
    as(scope) {
      return { call: async (method, path, body) => send(`Bearer ${await tokenFor(scope)}`, method, path, body) };
    },
    /** A public repo's commit, read with no token: Woodshed's own main, to pin the workflows to. */
    async publicCommit(repo, ref) {
      const res = await fetchImpl(`${GITHUB_API}/repos/${repo}/commits/${encodeURIComponent(ref)}`, { headers: { accept: GITHUB_HEADERS.accept, 'x-github-api-version': GITHUB_HEADERS['x-github-api-version'] } });
      const answer = await res.json().catch(() => ({}));
      if (!res.ok || !/^[0-9a-f]{40}$/.test(String(answer.sha ?? ''))) throw new Error(`GitHub did not give ${repo}@${ref}'s commit: HTTP ${res.status}`);
      return answer.sha;
    },
  };
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function gitHubReason(answer) {
  return `HTTP ${answer.status}${answer.body?.message ? ` ${String(answer.body.message).slice(0, 200)}` : ''}`;
}

/**
 * @param {{store: {state: object, save: () => void}, github: ReturnType<typeof appGitHub>|null,
 *          teamKey: () => Promise<string|null>, publicUrl: string, linkQuery?: object|null,
 *          newId?: () => string, now?: () => number}} deps
 *   `github` is null on a console with no App of its own (one that borrows its host's), which can apply nothing;
 *   `teamKey` is the console's Anthropic key (anthropicProxy.mjs teamCredential), read only to seal it
 */
export function createReviewSetup({ store, github, teamKey, publicUrl, linkQuery = null, newId = () => crypto.randomBytes(6).toString('hex'), now = Date.now }) {
  const { state } = store;
  state.reviewSetups ??= [];
  const applying = new Set();

  const iso = (ms = now()) => new Date(ms).toISOString();

  function save() {
    // The newest KEPT, pending ones always kept.
    if (state.reviewSetups.length > KEPT) {
      const extra = state.reviewSetups.length - KEPT;
      let dropped = 0;
      state.reviewSetups = state.reviewSetups.filter((r) => (dropped < extra && r.status !== 'pending' && r.status !== 'applying' ? (dropped += 1, false) : true));
    }
    store.save();
  }

  function decide(request, status, why, { by }) {
    request.status = status;
    request.why = why;
    request.decidedAt = iso();
    request.decidedBy = by;
    request.history.push({ at: request.decidedAt, what: status, by, note: why });
  }

  // A console that stopped mid-apply left a request applying: some steps may be done, and nothing will finish it.
  for (const request of state.reviewSetups) {
    if (request.status !== 'applying') continue;
    decide(request, 'failed', 'the console stopped while applying it: the steps marked done were done, approve a new request to finish', { by: 'console' });
    console.warn('reviewSetup: left applying by a stop, failed', { id: request.id, repo: request.repo });
  }

  // A pending request past its time is refused, the first time anything reads it.
  function fresh(request) {
    if (request?.status === 'pending' && Date.parse(request.expiresAt) <= now()) {
      decide(request, 'refused', 'expired: nobody approved it within 24 hours', { by: 'console' });
      console.log('reviewSetup: expired', { id: request.id, repo: request.repo });
      save();
    }
    return request;
  }

  function find(id) {
    if (!ID_RE.test(String(id ?? ''))) return null;
    return fresh(state.reviewSetups.find((r) => r.id === id) ?? null);
  }

  function link(id) {
    const query = linkQueryString(linkQuery);
    return `${publicUrl}/review-setup/${id}${query ? `?${query}` : ''}`;
  }

  /** What the one who asked may read: never a credential, and nothing the plan read from GitHub. */
  function statusOf(request) {
    return {
      id: request.id, repo: request.repo, qa: request.qa, ref: request.ref, status: request.status, why: request.why ?? null,
      createdAt: request.createdAt, expiresAt: request.expiresAt, decidedAt: request.decidedAt ?? null, decidedBy: request.decidedBy ?? null,
      steps: request.steps ?? [], url: link(request.id),
    };
  }

  // A ref the asker gave is used as it is, as the script's --ref; otherwise Woodshed's main, as a commit.
  async function pin(ref) {
    if (ref) return ref;
    try {
      return await github.publicCommit(WOODSHED_REPO, 'main');
    } catch (err) {
      console.warn('reviewSetup: Woodshed\'s main not read', { message: firstLine(err) });
      throw shown(`Woodshed's main commit could not be read from GitHub to pin the workflows to: give a ref (${firstLine(err)})`, 502);
    }
  }

  /**
   * @param {{repo: string, qa: string, ref: string|null}} options  from parseRequest
   * @param {{session?: object, login?: string|null}} who  the session that asks (by its SESSION_TOKEN), or a person
   * @returns {Promise<{request: object, created: boolean}>}
   */
  async function create(options, { session = null, login = null }) {
    if (!github) throw shown('this console has no GitHub App of its own to apply it with', 404);
    if (session && (session.kind === 'ask' || session.qa || session.review)) {
      throw shown('a question, a QA run or a review cannot ask for changes to a repo: they run code their pull request wrote', 403);
    }
    if (session?.taintedAt) throw shown('a session that has read production data asks for nothing that outlives it', 403);
    const by = session
      ? { session: session.id, title: String(session.title ?? '').slice(0, 120), person: session.owner ?? session.startedBy ?? null, private: Boolean(session.owner) }
      : { login: login ?? null };
    const same = (r) => r.status === 'pending' && (session ? r.by.session === session.id : !r.by.session && r.by.login === by.login);
    const mine = state.reviewSetups.filter((r) => fresh(r) && same(r));
    const again = mine.find((r) => r.repo === options.repo && r.qa === options.qa && (!options.ref || r.ref === options.ref));
    if (again) return { request: again, created: false };
    if (mine.length >= MAX_PENDING_EACH) throw shown(`${mine.length} of your requests already wait for approval: withdraw one first`, 429);
    const ref = await pin(options.ref);
    const request = {
      id: newId(), kind: 'review', repo: options.repo, qa: options.qa, ref, status: 'pending', by,
      createdAt: iso(), expiresAt: iso(now() + REQUEST_TTL_MS), steps: [], history: [],
    };
    request.history.push({ at: request.createdAt, what: 'asked', by: session ? `session ${session.id}` : (login ?? 'console') });
    state.reviewSetups.push(request);
    save();
    console.log('reviewSetup: request made', { id: request.id, repo: request.repo, qa: request.qa, ref, session: by.session ?? null, login: by.login ?? by.person ?? null });
    return { request, created: true };
  }

  // What the App's installation may do, and what the repo has now: read fresh each time, so the page and the apply
  // see GitHub as it is. A read the installation may not make is `unknown`, and its step stays blocked anyway.
  async function readPlan(request) {
    const { repo, qa, ref } = request;
    const plan = { repo, branch: null, installed: false, permissions: {}, steps: [], blockers: [], keySet: null };
    const installation = await github.installationOf(repo);
    if (!installation) {
      plan.blockers.push(`The console's GitHub App is not installed on ${repo}, or cannot see it: install it on the repo, then load this page again.`);
      return plan;
    }
    plan.installed = true;
    plan.installationId = installation.id;
    plan.permissions = installation.permissions;
    const readable = { metadata: 'read' };
    for (const name of ['contents', 'administration', 'secrets', 'issues']) if (granted(installation.permissions, name, 'read')) readable[name] = 'read';
    const gh = github.as({ repo, installationId: installation.id, permissions: readable });
    const repoAnswer = await gh.call('GET', `/repos/${repo}`);
    if (!repoAnswer.ok) throw new Error(`GitHub did not answer for ${repo}: ${gitHubReason(repoAnswer)}`);
    plan.branch = repoAnswer.body.default_branch;

    async function file(path) {
      if (!readable.contents) return { known: false };
      const answer = await gh.call('GET', `/repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(plan.branch)}`);
      if (answer.status === 404) return { known: true, sha: null, text: null };
      if (!answer.ok) throw new Error(`GitHub did not give ${path}: ${gitHubReason(answer)}`);
      return { known: true, sha: answer.body.sha, text: Buffer.from(answer.body.content ?? '', 'base64').toString('utf8') };
    }

    const step = (key, what, extra = {}) => {
      const missing = missingPermissions(installation.permissions, STEP_NEEDS[key]);
      plan.steps.push({ key, what, change: true, missing, ...extra });
    };
    const writeStep = async (key, path, text) => {
      const current = await file(path);
      const change = !current.known || current.text !== text;
      step(key, current.known && current.sha ? (change ? `Replace ${path} on ${plan.branch}` : `${path} on ${plan.branch} is already this`) : `Add ${path} on ${plan.branch}`,
        { path, text, sha: current.sha ?? null, change, known: current.known });
    };
    await writeStep('review-workflow', REVIEW_WORKFLOW, reviewWorkflow(ref));
    if (qa === 'actions') await writeStep('qa-workflow', QA_WORKFLOW, qaWorkflow(ref));
    if (qa === 'woodshed') {
      // A repo moved to the session runner still has CI's QA workflow, which would run QA a second time on the label.
      const old = await file(QA_WORKFLOW);
      if (!old.known || old.sha) step('qa-workflow-removed', `Remove ${QA_WORKFLOW} from ${plan.branch}, so QA runs only as a session`, { path: QA_WORKFLOW, sha: old.sha ?? null, change: true, known: old.known });
    }
    if (qa !== 'none') {
      const label = await gh.call('GET', `/repos/${repo}/labels/${encodeURIComponent(QA_LABEL.name)}`);
      const exists = label.ok;
      step('qa-label', exists ? `The ${QA_LABEL.name} label is already there` : `Create the ${QA_LABEL.name} label`, { change: !exists });
    }
    let workflowAccess = null;
    if (readable.administration) {
      const answer = await gh.call('GET', `/repos/${repo}/actions/permissions/workflow`);
      if (answer.ok) workflowAccess = answer.body;
    }
    const canApprove = workflowAccess?.can_approve_pull_request_reviews === true;
    step('approvals', canApprove ? 'GitHub Actions may already create and approve pull requests' : 'Let GitHub Actions create and approve pull requests',
      { change: !canApprove, level: workflowAccess?.default_workflow_permissions ?? null, known: Boolean(workflowAccess) });
    if (readable.secrets) {
      const answer = await gh.call('GET', `/repos/${repo}/actions/secrets/${SECRET_NAME}`);
      plan.keySet = answer.ok ? true : answer.status === 404 ? false : null;
    }
    step('secret', plan.keySet ? `${SECRET_NAME} is already set on ${repo}, and is left as it is` : `Set ${SECRET_NAME} on ${repo} from the console's Anthropic key`,
      { change: plan.keySet !== true });

    // Only a step that changes something needs its permissions.
    for (const s of plan.steps) if (!s.change) s.missing = [];
    const missing = [...new Set(plan.steps.flatMap((s) => s.missing))];
    if (missing.length) {
      plan.blockers.push(`The console's GitHub App may not ${missing.length > 1 ? 'do all of this' : 'do this'} on ${repo}: it lacks ${missing.join(', ')}. Add ${missing.length > 1 ? 'them' : 'it'} in the App's settings on GitHub (Permissions & events), then accept the change on its installation for ${repo.split('/')[0]}.`);
    }
    plan.setsKey = plan.steps.some((s) => s.key === 'secret' && s.change);
    if (plan.setsKey && !(await teamKey())) plan.blockers.push('The console has no Anthropic key to set: an admin sets anthropic-api-key on the Secrets page first.');
    return plan;
  }

  /** @returns {Promise<{ok: boolean, why: string|null}>}  whether `login` may approve, given the plan */
  async function approverCheck(request, plan, login, { consoleAdmin }) {
    if (!login) return { ok: false, why: 'Approving needs to know who you are, and this console has no sign-in.' };
    if (!plan.installed) return { ok: false, why: plan.blockers[0] };
    const gh = github.as({ repo: request.repo, installationId: plan.installationId, permissions: { metadata: 'read' } });
    const answer = await gh.call('GET', `/repos/${request.repo}/collaborators/${encodeURIComponent(login)}/permission`);
    const admin = answer.ok && (answer.body.role_name === 'admin' || answer.body.permission === 'admin');
    if (!admin) {
      if (!answer.ok && answer.status !== 404) throw new Error(`GitHub did not say what @${login} may do on ${request.repo}: ${gitHubReason(answer)}`);
      return { ok: false, why: `Only an admin of ${request.repo} on GitHub may approve this, and @${login} is not one.` };
    }
    if (plan.setsKey && !consoleAdmin) {
      return { ok: false, why: 'This copies the console\'s own Anthropic key into the repo, where any workflow can read it, so a console admin approves it.' };
    }
    return { ok: true, why: null };
  }

  /**
   * The page's view: the request, what approving it would change now, and whether `login` may approve it.
   * @param {{consoleAdmin: boolean}} opts
   */
  async function view(request, login, { consoleAdmin }) {
    const mine = Boolean(login && (request.by.login === login || request.by.person === login));
    const out = { ...statusOf(request), by: request.by, history: request.history, plan: null, canApprove: { ok: false, why: null }, canRefuse: false, mine };
    out.canRefuse = request.status === 'pending' && (consoleAdmin || mine);
    if (request.status !== 'pending') return out;
    if (!github) {
      out.canApprove.why = 'This console has no GitHub App of its own to apply it with.';
      return out;
    }
    try {
      const plan = await readPlan(request);
      out.plan = {
        branch: plan.branch, installed: plan.installed, blockers: plan.blockers, setsKey: Boolean(plan.setsKey),
        steps: plan.steps.map(({ key, what, change, missing, path, text }) => ({ key, what, change, missing, path: path ?? null, text: text ?? null })),
      };
      out.canApprove = plan.blockers.length ? { ok: false, why: plan.blockers[0] } : await approverCheck(request, plan, login, { consoleAdmin });
      if (!out.canRefuse && out.canApprove.ok) out.canRefuse = true;
    } catch (err) {
      console.warn('reviewSetup: plan not read', { id: request.id, repo: request.repo, message: firstLine(err) });
      out.canApprove.why = `GitHub did not answer: ${firstLine(err)}`;
    }
    return out;
  }

  // Each step, with a token narrowed to what the changing steps need.
  async function run(request, plan, by) {
    const needs = { metadata: 'read' };
    for (const s of plan.steps.filter((x) => x.change)) {
      for (const [name, level] of Object.entries(STEP_NEEDS[s.key])) if (needs[name] !== 'write') needs[name] = level;
    }
    const gh = github.as({ repo: request.repo, installationId: plan.installationId, permissions: needs });
    const message = (subject) => `${subject}\n\nApproved by @${by} on the Woodshed console (request ${request.id}).`;
    const actions = {
      'review-workflow': (s) => putFile(gh, request, plan, s, message('ci: enable Woodshed review')),
      'qa-workflow': (s) => putFile(gh, request, plan, s, message('ci: enable Woodshed qa')),
      'qa-workflow-removed': async (s) => {
        const answer = await gh.call('DELETE', `/repos/${request.repo}/contents/${encodePath(s.path)}`, { message: message('ci: QA moves to a Woodshed session'), sha: s.sha, branch: plan.branch });
        if (!answer.ok) throw new Error(`GitHub refused removing ${s.path}: ${gitHubReason(answer)}`);
        return answer.body.commit?.sha ? `commit ${answer.body.commit.sha.slice(0, 7)}` : null;
      },
      'qa-label': async () => {
        const answer = await gh.call('POST', `/repos/${request.repo}/labels`, QA_LABEL);
        if (!answer.ok && answer.status !== 422) throw new Error(`GitHub refused the label: ${gitHubReason(answer)}`);
        return null;
      },
      approvals: async (s) => {
        const answer = await gh.call('PUT', `/repos/${request.repo}/actions/permissions/workflow`, { default_workflow_permissions: s.level ?? 'read', can_approve_pull_request_reviews: true });
        if (!answer.ok) throw new Error(`GitHub refused the Actions setting: ${gitHubReason(answer)}`);
        return null;
      },
      secret: async () => {
        const value = await teamKey();
        if (!value) throw new Error('the console has no Anthropic key');
        const publicKey = await gh.call('GET', `/repos/${request.repo}/actions/secrets/public-key`);
        if (!publicKey.ok) throw new Error(`GitHub did not give the repo's public key: ${gitHubReason(publicKey)}`);
        const sealed = sealedBox(value, Buffer.from(String(publicKey.body.key ?? ''), 'base64')).toString('base64');
        const answer = await gh.call('PUT', `/repos/${request.repo}/actions/secrets/${SECRET_NAME}`, { encrypted_value: sealed, key_id: publicKey.body.key_id });
        if (!answer.ok) throw new Error(`GitHub refused the secret: ${gitHubReason(answer)}`);
        console.log('reviewSetup: Anthropic key set as an Actions secret', { id: request.id, repo: request.repo, name: SECRET_NAME });
        return null;
      },
    };
    request.steps = plan.steps.map((s) => ({ key: s.key, what: s.what, state: s.change ? 'next' : 'kept', note: null }));
    for (const [i, s] of plan.steps.entries()) {
      if (!s.change) continue;
      const row = request.steps[i];
      try {
        row.note = await actions[s.key](s);
        row.state = 'done';
        console.log('reviewSetup: step done', { id: request.id, repo: request.repo, step: s.key });
        save();
      } catch (err) {
        row.state = 'failed';
        row.note = firstLine(err);
        console.warn('reviewSetup: step failed', { id: request.id, repo: request.repo, step: s.key, message: row.note });
        return { ok: false, why: `${s.what}: ${row.note}` };
      }
    }
    return { ok: true };
  }

  async function putFile(gh, request, plan, s, message) {
    const body = { message, content: Buffer.from(s.text).toString('base64'), branch: plan.branch, ...(s.sha ? { sha: s.sha } : {}) };
    const answer = await gh.call('PUT', `/repos/${request.repo}/contents/${encodePath(s.path)}`, body);
    if (!answer.ok) {
      const hint = answer.status === 409 || answer.status === 403 ? ` (a rule on ${plan.branch} may refuse the App's commits)` : '';
      throw new Error(`GitHub refused writing ${s.path} on ${plan.branch}: ${gitHubReason(answer)}${hint}`);
    }
    return answer.body.commit?.sha ? `commit ${answer.body.commit.sha.slice(0, 7)}` : null;
  }

  /**
   * @param {{consoleAdmin: boolean}} opts
   * @returns {Promise<object>}  the request after it was applied, or failed
   * @throws {Error}  `shown` with a status, when it may not be approved now
   */
  async function approve(request, login, { consoleAdmin }) {
    if (!github) throw shown('this console has no GitHub App of its own to apply it with', 404);
    if (request.status !== 'pending' || applying.has(request.id)) throw shown(`it is ${request.status === 'pending' ? 'being applied' : request.status} already`, 409);
    applying.add(request.id);
    try {
      let plan;
      try {
        plan = await readPlan(request);
      } catch (err) {
        throw shown(`GitHub did not answer: ${firstLine(err)}`, 502);
      }
      if (plan.blockers.length) {
        console.log('reviewSetup: approval refused', { id: request.id, login, why: plan.blockers[0] });
        throw shown(plan.blockers.join(' '), 409);
      }
      const check = await approverCheck(request, plan, login, { consoleAdmin });
      if (!check.ok) {
        console.log('reviewSetup: approval refused', { id: request.id, login, why: check.why });
        throw shown(check.why, 403);
      }
      request.status = 'applying';
      request.history.push({ at: iso(), what: 'approved', by: login });
      save();
      console.log('reviewSetup: approved', { id: request.id, repo: request.repo, by: login, steps: plan.steps.filter((s) => s.change).map((s) => s.key) });
      const result = await run(request, plan, login);
      if (result.ok) {
        decide(request, 'applied', null, { by: login });
        console.log('reviewSetup: applied', { id: request.id, repo: request.repo, by: login });
      } else {
        decide(request, 'failed', result.why, { by: login });
        console.warn('reviewSetup: failed', { id: request.id, repo: request.repo, why: result.why });
      }
      save();
      return request;
    } finally {
      applying.delete(request.id);
    }
  }

  /** Refused by an approver, or withdrawn by whoever asked. */
  function refuse(request, login, reason) {
    if (request.status !== 'pending' || applying.has(request.id)) throw shown(`it is ${request.status === 'pending' ? 'being applied' : request.status} already`, 409);
    const own = login && (request.by.login === login || request.by.person === login);
    const note = String(reason ?? '').trim().slice(0, 300);
    decide(request, 'refused', `${own ? 'withdrawn' : 'refused'} by @${login ?? 'console'}${note ? `: ${note}` : ''}`, { by: login ?? 'console' });
    save();
    console.log('reviewSetup: refused', { id: request.id, repo: request.repo, by: login, own: Boolean(own) });
    return request;
  }

  /** @returns {object[]}  the requests, newest first, for the page's list */
  function list() {
    return state.reviewSetups.map(fresh).slice().reverse().map((r) => ({ ...statusOf(r), by: r.by }));
  }

  return { create, find, view, approve, refuse, list, statusOf, available: () => Boolean(github) };
}

const API_RE = /^\/api\/review-setup(?:\/([0-9a-f]{12})(?:\/(approve|refuse))?)?$/;
export const REVIEW_SETUP_PAGE_RE = /^\/review-setup\/[0-9a-f]{12}$/;

/** @returns {{id: string|null, action: 'approve'|'refuse'|null}|null}  the review setup API route a path names */
export function reviewSetupRoute(pathname) {
  const m = API_RE.exec(pathname);
  return m ? { id: m[1] ?? null, action: m[2] ?? null } : null;
}

function reply(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit = 4096) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw shown('body too large', 413);
  }
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    throw shown('body must be JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw shown('body must be a JSON object');
  return body;
}

/**
 * The signed-in API. The server has already checked the host, and for a POST the origin and `x-woodshed`.
 *
 *   GET  /api/review-setup                 {"requests": [...]}: every request, newest first
 *   POST /api/review-setup                 {"repo", "qa"?, "qaRunner"?, "ref"?}  ->  201 the request's status, with
 *                                          `url`, its approval page (200 for the same one already waiting)
 *   GET  /api/review-setup/<id>            the request, what approving it would change now, and `canApprove`
 *   POST /api/review-setup/<id>/approve    applies it  ->  the request, `applied` or `failed` with `why`
 *   POST /api/review-setup/<id>/refuse     {"reason"?}  ->  the request, `refused`
 * @param {{reviewSetup: ReturnType<typeof createReviewSetup>}} deps
 * @returns {(req, res, who: {route: object, login: string|null, admin: boolean}) => Promise<void>}  `admin`: a console admin
 */
export function createReviewSetupApi({ reviewSetup }) {
  return async function handle(req, res, { route, login, admin }) {
    try {
      if (!route.id) {
        if (req.method === 'GET') return reply(res, 200, { requests: reviewSetup.list() });
        if (req.method !== 'POST') return reply(res, 405, { error: 'method not allowed' });
        const { request, created } = await reviewSetup.create(parseRequest(await readBody(req)), { login });
        return reply(res, created ? 201 : 200, reviewSetup.statusOf(request));
      }
      const request = reviewSetup.find(route.id);
      if (!request) {
        req.resume();
        return reply(res, 404, { error: 'no such request' });
      }
      const consoleAdmin = Boolean(admin);
      if (!route.action && req.method === 'GET') return reply(res, 200, await reviewSetup.view(request, login, { consoleAdmin }));
      if (!route.action || req.method !== 'POST') return reply(res, 405, { error: 'method not allowed' });
      const body = await readBody(req);
      if (route.action === 'approve') {
        const done = await reviewSetup.approve(request, login, { consoleAdmin });
        return reply(res, 200, await reviewSetup.view(done, login, { consoleAdmin }));
      }
      const view = await reviewSetup.view(request, login, { consoleAdmin });
      if (!view.canRefuse) return reply(res, 403, { error: 'only whoever asked, an admin of the repo or a console admin may refuse it' });
      reviewSetup.refuse(request, login, body.reason);
      return reply(res, 200, await reviewSetup.view(request, login, { consoleAdmin }));
    } catch (err) {
      if (err.shown) return reply(res, err.status ?? 400, { error: err.message });
      console.error('reviewSetup: request failed', { route, message: firstLine(err) });
      return reply(res, 502, { error: `GitHub did not answer: ${firstLine(err)}` });
    }
  };
}

/**
 * The session API's two routes, for something in a session to ask and then follow its request; the session never reads
 * another session's:
 *
 *   POST /review-setup         {"repo", "qa"?, "qaRunner"?, "ref"?}  ->  201 {"id", "status", "url", ...}
 *   POST /review-setup/status  {"id"}  ->  {"id", "status": "pending"|"applying"|"applied"|"refused"|"failed", "why", "steps"}
 */
export async function sessionReviewSetupReply(req, res, session, reviewSetup, pathname) {
  if (!reviewSetup) {
    req.resume();
    return reply(res, 404, { error: 'this console cannot turn on a repo\'s review: it has no GitHub App of its own' });
  }
  try {
    const body = await readBody(req);
    if (pathname === '/review-setup') {
      const { request, created } = await reviewSetup.create(parseRequest(body), { session });
      return reply(res, created ? 201 : 200, reviewSetup.statusOf(request));
    }
    const request = reviewSetup.find(body.id);
    if (!request || request.by.session !== session.id) return reply(res, 404, { error: 'no such request of this session\'s' });
    return reply(res, 200, reviewSetup.statusOf(request));
  } catch (err) {
    if (err.shown) return reply(res, err.status ?? 400, { error: err.message });
    console.error('reviewSetup: session request failed', { sessionId: session.id, message: firstLine(err) });
    return reply(res, 502, { error: firstLine(err) });
  }
}
