// A made-up GitHub for turning on a repo's review (reviewSetup.mjs), as a `fetch` that answers the calls its App
// makes, from memory: where the App is installed and with what permissions, the repo's files, labels, Actions setting
// and secrets, who is an admin, and Woodshed's main. It refuses what GitHub refuses: a token with a permission the
// installation was not granted, a workflow file written without Workflows, a call its token's permissions do not cover,
// a write over a file with the wrong sha. reviewSetup.test.mjs drives the review setup through it, and the dev console
// runs on it with DEV_CONSOLE_REVIEW_SETUP=1 (scripts/devReviewSetupConsole.mjs).
//
// Each repo's secrets are sealed to a key pair made here, so a test can open one and see what GitHub would hold.

import crypto from 'node:crypto';

import { openSealedBox, x25519PublicKey } from '../sealedBox.mjs';

export const WOODSHED_MAIN = '7e57c0de'.repeat(5);
/** An older commit main has, tagged v1. */
export const WOODSHED_OLD = '01dc0de0'.repeat(5);
/** A commit main does not have: a branch someone pushed, or a fork's commit GitHub answers for under Woodshed's name. */
export const WOODSHED_OTHER = 'f04cf04c'.repeat(5);
const WOODSHED_REFS = { main: WOODSHED_MAIN, v1: WOODSHED_OLD, 'session-branch': WOODSHED_OTHER, [WOODSHED_MAIN]: WOODSHED_MAIN, [WOODSHED_OLD]: WOODSHED_OLD, [WOODSHED_OTHER]: WOODSHED_OTHER };

/** Every permission the review setup needs: what an App given them all has. */
export const ALL_PERMISSIONS = { metadata: 'read', contents: 'write', workflows: 'write', issues: 'write', administration: 'write', secrets: 'write', pull_requests: 'write' };
/** What an App made from the console's own manifest has (githubAppSetup.mjs): no Workflows, Administration or Secrets. */
export const MANIFEST_PERMISSIONS = {
  metadata: 'read', contents: 'write', issues: 'write', pull_requests: 'write', actions: 'write', checks: 'write', statuses: 'read', organization_projects: 'write',
};

const sha = (text) => crypto.createHash('sha1').update(text).digest('hex');

/**
 * @param {Record<string, {permissions?: object, installed?: boolean, admins?: string[], writers?: string[],
 *   files?: Record<string, string>, labels?: string[], canApprove?: boolean, secrets?: string[], protectedBranch?: boolean}>} repos
 * @returns {{fetch: typeof fetch, repos: Record<string, object>, calls: {method: string, path: string, body: string}[],
 *   openSecret: (repo: string, name: string) => string|null}}
 */
export function fakeGitHub(repos) {
  const state = {};
  let installationIds = 100;
  for (const [name, r] of Object.entries(repos)) {
    const secretKey = crypto.randomBytes(32);
    state[name] = {
      installed: r.installed ?? true, installationId: String(installationIds += 1), permissions: { ...(r.permissions ?? ALL_PERMISSIONS) },
      admins: r.admins ?? [], writers: r.writers ?? [], branch: 'main', protectedBranch: Boolean(r.protectedBranch),
      files: new Map(Object.entries(r.files ?? {}).map(([p, text]) => [p, { sha: sha(text), text }])),
      labels: new Set(r.labels ?? []), workflow: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: Boolean(r.canApprove) },
      secrets: new Map((r.secrets ?? []).map((s) => [s, 'sealed-elsewhere'])), secretKey, publicKey: x25519PublicKey(secretKey),
      commits: 0,
    };
  }
  const tokens = new Map();
  const calls = [];

  const answer = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const notAccessible = () => answer(403, { message: 'Resource not accessible by integration' });
  const allows = (perms, name, level) => perms[name] === 'write' || (level === 'read' && perms[name] === 'read');

  async function handle(method, url, headers, body) {
    const path = url.pathname;
    const auth = String(headers.authorization ?? '');
    let w = /^\/repos\/ChifferCo\/woodshed\/commits\/(.+)$/.exec(path);
    if (w && method === 'GET') {
      const found = WOODSHED_REFS[decodeURIComponent(w[1])];
      return found ? answer(200, { sha: found }) : answer(422, { message: `No commit found for SHA: ${decodeURIComponent(w[1])}` });
    }
    w = /^\/repos\/ChifferCo\/woodshed\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(path);
    if (w && method === 'GET') {
      const status = w[1] === w[2] ? 'identical' : w[1] === WOODSHED_MAIN && w[2] === WOODSHED_OLD ? 'behind' : 'diverged';
      return answer(200, { status });
    }
    let m = /^\/repos\/([^/]+\/[^/]+)\/installation$/.exec(path);
    if (m) {
      if (!auth.startsWith('Bearer ey')) return answer(401, { message: 'A JSON web token could not be decoded' });
      const repo = state[m[1]];
      return repo?.installed ? answer(200, { id: Number(repo.installationId), permissions: repo.permissions }) : answer(404, { message: 'Not Found' });
    }
    m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (m && method === 'POST') {
      const entry = Object.entries(state).find(([, r]) => r.installationId === m[1] && r.installed);
      if (!entry) return answer(404, { message: 'Not Found' });
      const [repoName, repo] = entry;
      for (const [name, level] of Object.entries(body.permissions ?? {})) {
        if (!allows(repo.permissions, name, level)) return answer(422, { message: `The permissions requested are not granted to this installation.` });
      }
      const token = `ghs_fake${crypto.randomBytes(8).toString('hex')}`;
      tokens.set(token, { repo: repoName, permissions: body.permissions ?? repo.permissions });
      return answer(201, { token, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(path);
    if (!m) return answer(404, { message: 'Not Found' });
    const [, repoName, rest = ''] = m;
    const repo = state[repoName];
    const grant = tokens.get(auth.replace(/^Bearer /, ''));
    if (!repo || !grant || grant.repo !== repoName) return answer(404, { message: 'Not Found' });
    const can = (name, level) => allows(grant.permissions, name, level);
    if (rest === '' && method === 'GET') return answer(200, { full_name: repoName, default_branch: repo.branch });
    m = /^\/contents\/(.+)$/.exec(rest);
    if (m) {
      const file = decodeURIComponent(m[1]);
      if (method === 'GET') {
        if (!can('contents', 'read')) return notAccessible();
        const kept = repo.files.get(file);
        return kept ? answer(200, { sha: kept.sha, content: Buffer.from(kept.text).toString('base64'), encoding: 'base64' }) : answer(404, { message: 'Not Found' });
      }
      if (!can('contents', 'write')) return notAccessible();
      if (file.startsWith('.github/workflows/') && !can('workflows', 'write')) {
        return answer(403, { message: `refusing to allow a GitHub App to create or update workflow \`${file}\` without \`workflows\` permission` });
      }
      if (repo.protectedBranch) return answer(409, { message: 'Repository rule violations found' });
      const kept = repo.files.get(file);
      if (kept && body.sha !== kept.sha) return answer(409, { message: `${file} does not match ${body.sha ?? 'no sha'}` });
      if (!kept && method === 'DELETE') return answer(404, { message: 'Not Found' });
      repo.commits += 1;
      const commit = { sha: sha(`${repoName}${repo.commits}`), message: body.message };
      if (method === 'DELETE') repo.files.delete(file);
      else repo.files.set(file, { sha: sha(Buffer.from(body.content, 'base64').toString('utf8')), text: Buffer.from(body.content, 'base64').toString('utf8') });
      return answer(kept ? 200 : 201, { commit });
    }
    m = /^\/labels(?:\/(.+))?$/.exec(rest);
    if (m) {
      if (method === 'GET') return repo.labels.has(decodeURIComponent(m[1])) ? answer(200, { name: decodeURIComponent(m[1]) }) : answer(404, { message: 'Not Found' });
      if (!can('issues', 'write')) return notAccessible();
      if (repo.labels.has(body.name)) return answer(422, { message: 'Validation Failed', errors: [{ code: 'already_exists' }] });
      repo.labels.add(body.name);
      return answer(201, { name: body.name });
    }
    if (rest === '/actions/permissions/workflow') {
      if (!can('administration', method === 'GET' ? 'read' : 'write')) return notAccessible();
      if (method === 'GET') return answer(200, repo.workflow);
      repo.workflow = { default_workflow_permissions: body.default_workflow_permissions, can_approve_pull_request_reviews: body.can_approve_pull_request_reviews };
      return answer(204);
    }
    if (rest === '/actions/secrets/public-key') {
      if (!can('secrets', 'read')) return notAccessible();
      return answer(200, { key_id: `kid-${repoName}`, key: repo.publicKey.toString('base64') });
    }
    m = /^\/actions\/secrets\/([A-Z_]+)$/.exec(rest);
    if (m) {
      if (!can('secrets', method === 'GET' ? 'read' : 'write')) return notAccessible();
      if (method === 'GET') return repo.secrets.has(m[1]) ? answer(200, { name: m[1] }) : answer(404, { message: 'Not Found' });
      if (body.key_id !== `kid-${repoName}`) return answer(422, { message: 'Bad key_id' });
      repo.secrets.set(m[1], body.encrypted_value);
      return answer(201);
    }
    m = /^\/collaborators\/([^/]+)\/permission$/.exec(rest);
    if (m) {
      const login = decodeURIComponent(m[1]);
      if (repo.admins.includes(login)) return answer(200, { permission: 'admin', role_name: 'admin' });
      if (repo.writers.includes(login)) return answer(200, { permission: 'write', role_name: 'write' });
      return answer(404, { message: `${login} is not a user` });
    }
    return answer(404, { message: 'Not Found' });
  }

  async function fakeFetch(input, init = {}) {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const raw = init.body ?? '';
    calls.push({ method, path: url.pathname, body: raw, authorization: String(init.headers?.authorization ?? '') });
    if (url.hostname !== 'api.github.com') throw new Error(`the fake GitHub has no ${url.hostname}`);
    return handle(method, url, init.headers ?? {}, raw ? JSON.parse(raw) : {});
  }

  return {
    fetch: fakeFetch,
    repos: state,
    calls,
    /** @returns {string|null}  what GitHub would hold for the secret, opened with the repo's key */
    openSecret(repoName, name) {
      const repo = state[repoName];
      const sealed = repo?.secrets.get(name);
      if (!sealed || sealed === 'sealed-elsewhere') return null;
      return openSealedBox(Buffer.from(sealed, 'base64'), repo.publicKey, repo.secretKey)?.toString('utf8') ?? null;
    },
  };
}
