// The reviewer App: a second GitHub App whose only job is submitting the review session's verdict. GitHub never lets a
// pull request's author approve it, Apps included, and a pull request a shared session opens is the console App's. So
// the verdict goes out as this App instead, and the author and the reviewer are never the same identity.
//
// It asks for pull requests (write) and nothing else. Its key is in the secret store, its App ID and slug in the
// console's state, both saved by GitHub's App Manifest flow from the GitHub setup page. It is read at each review, so
// it takes effect without a restart.

import crypto from 'node:crypto';

import { DEFAULT_CONSOLE_NAME } from './config.mjs';
import { createAppApi, createTokenSource } from './githubApp.mjs';
import { manifestPostUrl } from './githubAppSetup.mjs';
import { defaultProject } from './projects.mjs';
import { checkValue, secretSpecs } from './secrets.mjs';

export const REVIEWER_KEY_SECRET = 'github-reviewer-app-key';
const GITHUB = 'https://github.com';
const GITHUB_API = 'https://api.github.com';
const HEADERS = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' };
const PERMISSIONS = { pull_requests: 'write', metadata: 'read' };
// The manifest's code lasts an hour; the state it was started with, 15 minutes.
const STATE_TTL_MS = 15 * 60_000;
const MAX_PENDING = 20;
// GitHub's limit on a review body is 65,536 characters.
const MAX_BODY_CHARS = 60_000;

function refusal(message) {
  return Object.assign(new Error(message), { shown: true });
}

/** @returns {object}  the manifest GitHub makes the reviewer App from: pull requests only, no webhook, no sign-in */
export function reviewerManifest({ publicUrl, repo, consoleName = DEFAULT_CONSOLE_NAME }) {
  const [owner] = repo.split('/');
  return {
    // 34 is GitHub's limit on an App's name.
    name: `${consoleName} reviewer ${owner}`.slice(0, 34),
    url: publicUrl,
    redirect_url: `${publicUrl}/setup/github/reviewer-created`,
    public: false,
    default_permissions: PERMISSIONS,
    default_events: [],
  };
}

/**
 * @param {{store: {state: object, save: () => void}, secrets: {read: Function, save: Function}|null,
 *          config: {publicUrl: string, consoleName?: string}, fetchImpl?: typeof fetch, now?: () => number}} deps
 */
export function createReviewerApp({ store, secrets, config, fetchImpl = fetch, now = Date.now }) {
  const pending = new Map();

  function stored() {
    return store.state.reviewerApp ?? null;
  }

  /** @returns {string|null}  the login its reviews carry, `<slug>[bot]`, which the project file names as review.author */
  function login() {
    return stored()?.slug ? `${stored().slug}[bot]` : null;
  }

  /** @returns {boolean}  a reviewer App was made: reviews go out as it */
  function configured() {
    return Boolean(stored()?.appId);
  }

  async function view() {
    const found = stored();
    return {
      available: Boolean(secrets),
      appId: found?.appId ?? null,
      slug: found?.slug ?? null,
      login: login(),
      installUrl: found?.slug ? `${GITHUB}/apps/${found.slug}/installations/new` : null,
    };
  }

  /**
   * Starts the manifest flow, under the repo owner's organization or the person's own account.
   * @returns {{url: string, manifest: object}}  the page posts `manifest` to `url`
   */
  function startManifest({ ownerType } = {}) {
    if (!secrets) throw refusal('this console has no secret store, so it cannot keep the reviewer App\'s key');
    const state = crypto.randomBytes(24).toString('base64url');
    for (const [key, at] of pending) if (now() - at > STATE_TTL_MS) pending.delete(key);
    if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
    pending.set(state, now());
    const owner = ownerType === 'User' ? 'User' : 'Organization';
    const { repo } = defaultProject(config);
    console.log('reviewerApp: manifest started', { ownerType: owner });
    return { url: manifestPostUrl({ repo, state, ownerType: owner }), manifest: reviewerManifest({ publicUrl: config.publicUrl, repo, consoleName: config.consoleName }) };
  }

  /** GitHub sent the browser back with a code: trade it for the App's ID and key, and keep them. */
  async function completeManifest({ code, state }) {
    if (!secrets) throw refusal('this console has no secret store, so it cannot keep the reviewer App\'s key');
    const startedAt = pending.get(state);
    pending.delete(state);
    if (!startedAt || now() - startedAt > STATE_TTL_MS) throw refusal('this page was not opened from the console\'s Create button, or it took over 15 minutes: start again');
    if (!/^[a-f0-9]{10,64}$/i.test(String(code ?? ''))) throw refusal('GitHub sent no code: start again');
    const res = await fetchImpl(`${GITHUB_API}/app-manifests/${code}/conversions`, { method: 'POST', headers: HEADERS });
    const made = await res.json().catch(() => ({}));
    if (!res.ok || !made.id || !made.pem) {
      console.warn('reviewerApp: manifest conversion refused', { status: res.status });
      throw refusal(`GitHub would not hand over the reviewer App (HTTP ${res.status}): the code is single use and lasts an hour, so start again`);
    }
    const spec = secretSpecs({ envFiles: [] }).find((s) => s.name === REVIEWER_KEY_SECRET);
    await secrets.save(REVIEWER_KEY_SECRET, checkValue(spec, made.pem), 'The Woodshed reviewer App\'s private key (.pem). Only the console reads it, to submit reviews');
    store.state.reviewerApp = { appId: String(made.id), slug: made.slug };
    store.save();
    console.log('reviewerApp: created from the manifest', { appId: made.id, slug: made.slug });
    return { appId: String(made.id), slug: made.slug };
  }

  /**
   * Submits a formal review as the reviewer App, at `sha`, so a push since makes GitHub refuse rather than approve the
   * wrong commit.
   * @param {{repo: string, number: number, event: 'APPROVE'|'REQUEST_CHANGES'|'COMMENT', body: string, sha: string}} args
   * @returns {Promise<number|null>}  the review's id
   */
  async function submitReview({ repo, number, event, body, sha }) {
    const found = stored();
    const privateKey = found?.appId ? await secrets?.read(REVIEWER_KEY_SECRET) : null;
    if (!privateKey) throw new Error('the reviewer App is not set up: its key is not saved');
    const installationId = await createAppApi({ appId: found.appId, privateKey, fetchImpl, now }).installationOf(repo);
    if (!installationId) throw new Error(`the reviewer App is not installed on ${repo}`);
    const { token } = await createTokenSource({
      appId: found.appId, installationId, privateKey, repo, permissions: { pull_requests: 'write' }, label: 'reviewer', fetchImpl, now,
    }).token();
    const res = await fetchImpl(`${GITHUB_API}/repos/${repo}/pulls/${number}/reviews`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, ...HEADERS },
      body: JSON.stringify({ commit_id: sha, event, body: body.slice(0, MAX_BODY_CHARS) }),
    });
    const answer = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`GitHub refused the reviewer App's review: HTTP ${res.status} ${String(answer.message ?? '').slice(0, 200)}`);
    return answer.id ?? null;
  }

  return { configured, login, view, startManifest, completeManifest, submitReview };
}
