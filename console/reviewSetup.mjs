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
const WRITER_ROLES = new Set(['admin', 'write']);
const FAILED_ELSEWHERE = 'it failed at one of its steps: those who can write to the repo see which on its page';
// GitHub's clock and the console's, for telling the console's key from one the repo set after it.
const KEY_CLOCK_SLACK_MS = 60_000;

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

  async function publicGet(path) {
    const res = await fetchImpl(`${GITHUB_API}${path}`, { headers: { accept: GITHUB_HEADERS.accept, 'x-github-api-version': GITHUB_HEADERS['x-github-api-version'] } });
    return { status: res.status, ok: res.ok, body: await res.json().catch(() => ({})) };
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
    /** @returns {Promise<string|null>}  a public repo's commit for `ref`, read with no token; null when it has none */
    async publicCommit(repo, ref) {
      const res = await publicGet(`/repos/${repo}/commits/${encodeURIComponent(ref)}`);
      if (res.status === 404 || res.status === 422) return null;
      if (!res.ok || !/^[0-9a-f]{40}$/.test(String(res.body.sha ?? ''))) throw new Error(`GitHub did not give ${repo}@${ref}'s commit: HTTP ${res.status}`);
      return res.body.sha;
    },
    /** @returns {Promise<string>}  how `head` stands to `base` in a public repo: `identical`, `behind`, `ahead` or `diverged` */
    async publicCompare(repo, base, head) {
      const res = await publicGet(`/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
      if (!res.ok) throw new Error(`GitHub did not compare ${repo}'s ${base} with ${head}: HTTP ${res.status}`);
      return String(res.body.status ?? '');
    },
  };
}

/** @returns {string}  what approving would do, as a hash: the steps, each file whole, and whether the key is set */
export function planDigest(plan) {
  const shown = { branch: plan.branch, setsKey: Boolean(plan.setsKey), steps: plan.steps.map((s) => [s.key, s.change, s.path ?? null, s.text ?? null]) };
  return crypto.createHash('sha256').update(JSON.stringify(shown)).digest('hex').slice(0, 32);
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

  /**
   * What the one who asked may read: never a credential. Each step and why one failed (the repo's branch, its commits,
   * GitHub's answers) only with `detail`, for someone who can write to the repo.
   */
  function statusOf(request, { detail = false } = {}) {
    const why = request.status === 'failed' && !detail ? FAILED_ELSEWHERE : request.why ?? null;
    return {
      id: request.id, repo: request.repo, qa: request.qa, ref: request.ref, status: request.status, why,
      createdAt: request.createdAt, expiresAt: request.expiresAt, decidedAt: request.decidedAt ?? null, decidedBy: request.decidedBy ?? null,
      steps: detail ? request.steps ?? [] : [], url: link(request.id),
    };
  }

  /** A session's view of its own request: the detail when the person it is (its owner, or whoever started it) can write to the repo. */
  async function sessionStatus(request) {
    const person = request.by.person;
    const detail = typeof person === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(person) && WRITER_ROLES.has(await repoRole(request.repo, person).catch(() => null));
    return statusOf(request, { detail });
  }

  // The commit of Woodshed's workflows the repo will run, next to the key: Woodshed's main as it is now, or a ref the
  // asker gave, resolved to its commit and taken only when main has it. A branch anyone could push, or a fork's commit
  // (which GitHub also answers for under Woodshed's name), is refused, and the page shows the commit, never a name.
  async function pin(ref) {
    let main;
    let sha;
    try {
      main = await github.publicCommit(WOODSHED_REPO, 'main');
      if (!main) throw new Error('no main');
      if (!ref) return main;
      sha = await github.publicCommit(WOODSHED_REPO, ref);
      if (sha === main) return sha;
      if (sha && ['behind', 'identical'].includes(await github.publicCompare(WOODSHED_REPO, main, sha))) return sha;
    } catch (err) {
      console.warn('reviewSetup: Woodshed\'s commit not read', { ref, message: firstLine(err) });
      throw shown(`Woodshed's commit could not be read from GitHub to pin the workflows to: try again (${firstLine(err)})`, 502);
    }
    console.log('reviewSetup: ref refused, not on Woodshed\'s main', { ref, sha: sha ?? null });
    throw shown(`${ref} is not a commit of Woodshed's main: pin a commit main has, or leave ref out for main as it is now`, 400);
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
    // Pinned first, so nothing waits between the checks below and keeping the request: two asks at once make one.
    const ref = await pin(options.ref);
    const mine = state.reviewSetups.filter((r) => fresh(r) && same(r));
    const again = mine.find((r) => r.repo === options.repo && r.qa === options.qa && r.ref === ref);
    if (again) return { request: again, created: false };
    if (mine.length >= MAX_PENDING_EACH) throw shown(`${mine.length} of your requests already wait for approval: withdraw one first`, 429);
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
    plan.repoId = String(repoAnswer.body.id ?? '');

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
    // CI's QA workflow as the repo has it now: one a request for review alone leaves where it is.
    const ciQa = qa === 'actions' ? null : await file(QA_WORKFLOW);
    if (qa === 'woodshed') {
      // A repo moved to the session runner still has CI's QA workflow, which would run QA a second time on the label.
      const old = ciQa;
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
      // Written blind, the setting's default permission could change: it waits for a read.
      else plan.blockers.push(`GitHub did not give ${repo}'s Actions setting (${gitHubReason(answer)}): load this page again.`);
    }
    const canApprove = workflowAccess?.can_approve_pull_request_reviews === true;
    step('approvals', canApprove ? 'GitHub Actions may already create and approve pull requests' : 'Let GitHub Actions create and approve pull requests',
      { change: !canApprove, level: workflowAccess?.default_workflow_permissions ?? null, known: Boolean(workflowAccess) });
    let consoleKey = false;
    if (readable.secrets) {
      const answer = await gh.call('GET', `/repos/${repo}/actions/secrets/${SECRET_NAME}`);
      plan.keySet = answer.ok ? true : answer.status === 404 ? false : null;
      // The key there is the console's while GitHub says it was last changed no later than when a request here set it.
      const setAt = consoleKeySetAt(plan.repoId);
      consoleKey = Boolean(answer.ok && setAt && Date.parse(answer.body.updated_at ?? 0) <= Date.parse(setAt) + KEY_CLOCK_SLACK_MS);
      // Only a key GitHub says is not there is set: one it did not answer for may be the repo's own.
      if (plan.keySet === null) plan.blockers.push(`GitHub did not say whether ${repo} has ${SECRET_NAME} (${gitHubReason(answer)}): load this page again.`);
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
    plan.consoleKey = consoleKey;
    // QA in CI starts the pull request's own app on the runner that then holds the key, so a pull request's code (a
    // session's, say) could read it: the console's key and CI's QA are never in one repo. Not set next to a QA workflow
    // the repo has or this request writes, and no QA workflow written next to the console's key an earlier request set.
    const qaInCi = qa === 'actions' || (qa === 'none' && (ciQa.known === false || Boolean(ciQa.sha)));
    if (qaInCi && plan.setsKey) {
      plan.blockers.push(`QA in ${repo}'s CI runs each pull request's own app next to ${SECRET_NAME}, so the console's key is not set where it runs: set the repo's own ${SECRET_NAME} first, or ask for QA as a Woodshed session, which removes CI's.`);
    } else if (qaInCi && consoleKey) {
      plan.blockers.push(`${SECRET_NAME} in ${repo} is the console's own, set by an earlier request, and QA in CI would run each pull request's own app next to it: replace it with the repo's own key first, or ask for QA as a Woodshed session.`);
    } else if (plan.setsKey && !(await teamKey())) {
      plan.blockers.push('The console has no Anthropic key to set: an admin sets anthropic-api-key on the Secrets page first.');
    }
    plan.digest = planDigest(plan);
    return plan;
  }

  // When the console last set its key on a repo, by GitHub's id for it: kept apart from the requests, which are pruned,
  // and the same whatever spelling of the repo's name a request used, or after a rename.
  function consoleKeySetAt(repoId) {
    return (repoId && state.reviewSetupKeys?.[repoId]) || null;
  }

  /** @returns {Promise<string|null>}  why `login` may not approve a request on the repo, asked before anything is read of it */
  async function notAdmin(request, login) {
    if (!login) return 'Approving needs to know who you are, and this console has no sign-in.';
    if (await repoRole(request.repo, login) === 'admin') return null;
    return `Only an admin of ${request.repo} on GitHub may approve this, and @${login} is not one.`;
  }

  /** @returns {Promise<{ok: boolean, why: string|null}>}  whether `login` may approve, given the plan */
  async function approverCheck(request, plan, login, { consoleAdmin }) {
    const why = await notAdmin(request, login);
    if (why) return { ok: false, why };
    if (plan.setsKey && !consoleAdmin) {
      return { ok: false, why: 'This copies the console\'s own Anthropic key into the repo, where any workflow can read it, so a console admin approves it.' };
    }
    return { ok: true, why: null };
  }

  const isMine = (request, login) => Boolean(login && (request.by.login === login || request.by.person === login));

  // What `login` may do on the repo, as GitHub tells the App: its base permission (`admin`, `write`, `read`; a custom
  // role's `role_name` is not one of these), null when it is not a collaborator, or the App is not there.
  async function repoRole(repo, login) {
    if (!github || !login) return null;
    const installation = await github.installationOf(repo);
    if (!installation) return null;
    const answer = await github.as({ repo, installationId: installation.id, permissions: { metadata: 'read' } })
      .call('GET', `/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`);
    if (answer.status === 404) return null;
    if (!answer.ok) throw new Error(`GitHub did not say what @${login} may do on ${repo}: ${gitHubReason(answer)}`);
    return answer.body.permission ?? null;
  }

  /** @returns {Promise<boolean>}  whether `login` may see the request at all */
  async function canSee(request, login, { consoleAdmin }) {
    return consoleAdmin || isMine(request, login) || WRITER_ROLES.has(await repoRole(request.repo, login));
  }

  // A private session is its owner's: someone else sees whose it is, not its title or id.
  function shownBy(request, login, consoleAdmin) {
    if (!request.by.private || consoleAdmin || request.by.person === login) return { by: request.by, history: request.history };
    return {
      by: { private: true, person: request.by.person },
      history: request.history.map((e) => (e.what === 'asked' && e.by.startsWith('session ') ? { ...e, by: 'a session' } : e)),
    };
  }

  /**
   * The page's view: the request, what approving it would change now, and whether `login` may approve it. Whoever
   * asked sees its status; what the App reads of the repo only those who can write to it, and console admins.
   * @param {{consoleAdmin: boolean}} opts
   * @throws {Error}  `shown` 404, for someone who neither asked, nor can write to the repo, nor is a console admin
   */
  async function view(request, login, { consoleAdmin }) {
    const mine = isMine(request, login);
    const role = consoleAdmin ? null : await repoRole(request.repo, login);
    const writer = WRITER_ROLES.has(role);
    if (!mine && !consoleAdmin && !writer) throw shown('no such request', 404);
    const detail = consoleAdmin || writer;
    const visible = shownBy(request, login, consoleAdmin);
    // A failure's note in the history is GitHub's answer about the repo: the same detail as `why`.
    const history = detail ? visible.history : visible.history.map((e) => (e.what === 'failed' ? { ...e, note: FAILED_ELSEWHERE } : e));
    const out = { ...statusOf(request, { detail }), by: visible.by, history, plan: null, canApprove: { ok: false, why: null }, canRefuse: false, mine };
    out.canRefuse = request.status === 'pending' && (consoleAdmin || mine || role === 'admin');
    if (request.status !== 'pending') return out;
    if (!github) {
      out.canApprove.why = 'This console has no GitHub App of its own to apply it with.';
      return out;
    }
    if (!consoleAdmin && !writer) {
      out.canApprove.why = `What it would change is shown to those who can write to ${request.repo}: an admin of it approves.`;
      return out;
    }
    try {
      const plan = await readPlan(request);
      out.plan = {
        branch: plan.branch, installed: plan.installed, blockers: plan.blockers, setsKey: Boolean(plan.setsKey), digest: plan.digest,
        steps: plan.steps.map(({ key, what, change, missing, path, text }) => ({ key, what, change, missing, path: path ?? null, text: text ?? null })),
      };
      out.canApprove = plan.blockers.length ? { ok: false, why: plan.blockers[0] } : await approverCheck(request, plan, login, { consoleAdmin });
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
        const exists = answer.status === 422 && (answer.body.errors ?? []).some((e) => e?.code === 'already_exists');
        if (!answer.ok && !exists) throw new Error(`GitHub refused the label: ${gitHubReason(answer)}`);
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
        state.reviewSetupKeys = { ...state.reviewSetupKeys, [plan.repoId]: iso() };
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
  async function approve(request, login, { consoleAdmin, digest }) {
    if (!github) throw shown('this console has no GitHub App of its own to apply it with', 404);
    if (request.status !== 'pending' || applying.has(request.id)) throw shown(`it is ${request.status === 'pending' ? 'being applied' : request.status} already`, 409);
    applying.add(request.id);
    try {
      // Nothing of the repo is read for someone who may not approve: what they could learn from a refusal stops here.
      let why;
      try {
        why = await notAdmin(request, login);
      } catch (err) {
        throw shown(`GitHub did not answer: ${firstLine(err)}`, 502);
      }
      if (why) {
        console.log('reviewSetup: approval refused', { id: request.id, login, why });
        throw shown(why, 403);
      }
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
      // What is applied is what the approver was shown: a key removed, a file changed since, and they look again.
      if (digest !== plan.digest) {
        console.log('reviewSetup: approval refused, the plan changed since it was shown', { id: request.id, login });
        throw shown('GitHub has changed since this page showed what approving does: look at it again, then approve.', 409);
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
    const own = isMine(request, login);
    const note = String(reason ?? '').trim().slice(0, 300);
    decide(request, 'refused', `${own ? 'withdrawn' : 'refused'} by @${login ?? 'console'}${note ? `: ${note}` : ''}`, { by: login ?? 'console' });
    save();
    console.log('reviewSetup: refused', { id: request.id, repo: request.repo, by: login, own: Boolean(own) });
    return request;
  }

  /** @returns {object[]}  the requests `login` asked for, every one for a console admin, newest first */
  function list(login, { consoleAdmin }) {
    return state.reviewSetups.map(fresh).filter((r) => consoleAdmin || isMine(r, login)).reverse()
      .map((r) => ({ ...statusOf(r, { detail: consoleAdmin }), by: shownBy(r, login, consoleAdmin).by }));
  }

  return { create, find, view, canSee, approve, refuse, list, statusOf, sessionStatus, available: () => Boolean(github) };
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
 *   GET  /api/review-setup                 {"requests": [...]}: those you asked for (every one, for a console admin),
 *                                          newest first
 *   POST /api/review-setup                 {"repo", "qa"?, "qaRunner"?, "ref"?}  ->  201 the request's status, with
 *                                          `url`, its approval page (200 for the same one already waiting)
 *   GET  /api/review-setup/<id>            the request, what approving it would change now, and `canApprove`: what
 *                                          it would change only to those who can write to the repo and console admins;
 *                                          404 to anyone else who did not ask
 *   POST /api/review-setup/<id>/approve    {"digest"}: the plan's, as the page showed it  ->  the request, `applied` or
 *                                          `failed` with `why`; 409 when GitHub changed since
 *   POST /api/review-setup/<id>/refuse     {"reason"?}  ->  the request, `refused`
 * @param {{reviewSetup: ReturnType<typeof createReviewSetup>}} deps
 * @returns {(req, res, who: {route: object, login: string|null, admin: boolean}) => Promise<void>}  `admin`: a console admin
 */
export function createReviewSetupApi({ reviewSetup }) {
  return async function handle(req, res, { route, login, admin }) {
    try {
      if (!route.id) {
        if (req.method === 'GET') return reply(res, 200, { requests: reviewSetup.list(login, { consoleAdmin: Boolean(admin) }) });
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
      // Someone who did not ask, cannot write to the repo and is not a console admin is told nothing of it.
      if (route.action && !(await reviewSetup.canSee(request, login, { consoleAdmin }))) {
        req.resume();
        return reply(res, 404, { error: 'no such request' });
      }
      if (!route.action && req.method === 'GET') return reply(res, 200, await reviewSetup.view(request, login, { consoleAdmin }));
      if (!route.action || req.method !== 'POST') return reply(res, 405, { error: 'method not allowed' });
      const body = await readBody(req);
      if (route.action === 'approve') {
        const done = await reviewSetup.approve(request, login, { consoleAdmin, digest: body.digest });
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
    return reply(res, 200, await reviewSetup.sessionStatus(request));
  } catch (err) {
    if (err.shown) return reply(res, err.status ?? 400, { error: err.message });
    console.error('reviewSetup: session request failed', { sessionId: session.id, message: firstLine(err) });
    return reply(res, 502, { error: firstLine(err) });
  }
}
