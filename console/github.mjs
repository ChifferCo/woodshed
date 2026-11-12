// GitHub, through the `gh` CLI. Webhooks reach the console through a queue
// (webhookDispatch.mjs); this poll finds what they miss, and is all there is
// where no queue is set up, such as on a dev box.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { reduceChecks } from './prChips.mjs';
import { parseCommand } from './sessions.mjs';

const execFileAsync = promisify(execFile);
const WRITE_ROLES = new Set(['admin', 'maintain', 'write']);
const SEEN_COMMENTS_KEPT = 500;
const PAGE_SIZE = 100;
// The events endpoint always answers with the newest page; a busy repo fills one in seconds.
const MAX_EVENT_PAGES = 10;
const MAX_CHECK_RUN_PAGES = 5;
const MAX_PULL_FILE_PAGES = 3;
const MAX_COMMENT_PAGES = 5;

const GH_INSTALL = 'https://cli.github.com';

/**
 * Node's `spawn gh ENOENT` says nothing to whoever reads it on the sign-in or poll log line; this says what to do.
 * @returns {Error}  `err` itself unless it is gh missing from the PATH
 */
export function explainGhError(err) {
  if (err?.code !== 'ENOENT') return err;
  return Object.assign(new Error(`gh is not installed on the console, so it cannot call GitHub (${GH_INSTALL})`), { code: 'ENOENT', cause: err });
}

/**
 * Every GitHub call the console makes goes through `gh`, App or not, so a console without it starts and then fails
 * each one. Said once at start, with a warning rather than a refusal: a console still being set up, or the dev console,
 * has no GitHub to call yet, and its pages are how it gets one.
 * @returns {Promise<boolean>}  whether `gh` ran
 */
export async function checkGh({ run = execFileAsync, warn = console.warn } = {}) {
  try {
    await run('gh', ['--version']);
    return true;
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    warn('console: gh not installed, GitHub calls will fail', { install: GH_INSTALL });
    return false;
  }
}

async function ghApiWith(args, token, run) {
  const env = token ? { ...process.env, GH_TOKEN: await token() } : process.env;
  const { stdout } = await run('gh', ['api', ...args], { maxBuffer: 16 * 1024 * 1024, env }).catch((err) => {
    throw explainGhError(err);
  });
  return stdout.trim() ? JSON.parse(stdout) : null;
}

/** @returns {object|null}  the JSON a failed `gh api graphql` printed, when it printed any */
export function partialGraphql(err) {
  try {
    return JSON.parse(String(err?.stdout ?? ''));
  } catch {
    return null;
  }
}

const LATEST_CHECKS = `commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
    ... on CheckRun { status conclusion } ... on StatusContext { state } } } } } } }`;
const PR_STATUS_FIELDS = `number title state isDraft reviewDecision mergeQueueEntry { position } ${LATEST_CHECKS}`;
// The rail's pull request rows: each one's checks and age too, as the shed's rows show them.
const PULL_ROW_FIELDS = `number title isDraft headRefName updatedAt ${LATEST_CHECKS}`;
const PULLS_FOR_QUERY = `query($mine: String!, $review: String!) {
  mine: search(query: $mine, type: ISSUE, first: 10) { nodes { ... on PullRequest { ${PULL_ROW_FIELDS} } } }
  review: search(query: $review, type: ISSUE, first: 10) { nodes { ... on PullRequest { ${PULL_ROW_FIELDS} } } }
}`;

const ISSUE_PROJECT_ITEMS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) { projectItems(first: 20) { nodes {
    id
    status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
    project { id title field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } } }
  } } } }
}`;
const SET_PROJECT_STATUS_MUTATION = `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(input: {projectId: $project, itemId: $item, fieldId: $field, value: {singleSelectOptionId: $option}}) {
    projectV2Item { id }
  }
}`;

/**
 * @param {object} node  a pull request from PULLS_FOR_QUERY
 * @param {'yours'|'review'} why
 * @returns {{number: number, title: string, branch: string, why: string, updatedAt: string|null, draft: boolean,
 *            checks: {pass: number, fail: number, pending: number, total: number}|null}}  one row of the rail's list
 */
export function pullRow(node, why) {
  const checks = reduceChecks(node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes);
  return {
    number: node.number, title: node.title, branch: node.headRefName, why,
    updatedAt: node.updatedAt ?? null, draft: Boolean(node.isDraft), checks: checks.total ? checks : null,
  };
}
const SKILL_DESCRIPTION_CHARS = 140;
// The repo's skills and commands on its default branch, two folders deep, in one call.
const TREE_TWO_DEEP = 'entries { name object { ... on Blob { text } ... on Tree { entries { name object { ... on Blob { text } } } } } }';
const SKILLS_QUERY = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
  skills: object(expression: "HEAD:.claude/skills") { ... on Tree { ${TREE_TWO_DEEP} } }
  commands: object(expression: "HEAD:.claude/commands") { ... on Tree { ${TREE_TWO_DEEP} } }
} }`;

// A front matter's description, on one line or folded over the indented lines after `description: >`.
function frontMatterDescription(text) {
  const head = /^---\n([\s\S]*?)\n---/.exec(text)?.[1];
  if (!head) return null;
  const lines = head.split('\n');
  const at = lines.findIndex((l) => /^description:/.test(l));
  if (at < 0) return null;
  const inline = lines[at].replace(/^description:\s*/, '').trim();
  if (inline && !/^[>|][-+]?$/.test(inline)) return inline.replace(/^["']|["']$/g, '');
  const folded = [];
  for (const line of lines.slice(at + 1)) {
    if (!/^\s/.test(line)) break;
    folded.push(line.trim());
  }
  return folded.join(' ') || null;
}

function shortDescription(text) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  return one.length > SKILL_DESCRIPTION_CHARS ? `${one.slice(0, SKILL_DESCRIPTION_CHARS - 1)}…` : one;
}

/**
 * @param {object} repository  the answer to SKILLS_QUERY
 * @returns {{name: string, desc: string}[]}  each skill (`.claude/skills/<name>/SKILL.md`) and command
 *   (`.claude/commands/<folder>/<name>.md`, as `<folder>:<name>`), by name
 */
export function skillsFrom(repository) {
  const out = [];
  for (const dir of repository?.skills?.entries ?? []) {
    const file = dir.object?.entries?.find((e) => e.name === 'SKILL.md');
    if (!file?.object?.text) continue;
    out.push({ name: dir.name, desc: shortDescription(frontMatterDescription(file.object.text)) });
  }
  for (const dir of repository?.commands?.entries ?? []) {
    for (const file of dir.object?.entries ?? []) {
      if (!file.name.endsWith('.md') || !file.object?.text) continue;
      const text = file.object.text;
      const first = text.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean);
      out.push({ name: `${dir.name}:${file.name.slice(0, -3)}`, desc: shortDescription(frontMatterDescription(text) ?? first) });
    }
  }
  return out.filter((s) => /^[a-z0-9:-]{1,64}$/i.test(s.name)).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * @param {{permission?: string, role_name?: string}} answer  from the collaborators permission endpoint
 * @returns {boolean}
 */
export function canWrite(answer) {
  return WRITE_ROLES.has(answer?.role_name) || WRITE_ROLES.has(answer?.permission);
}

/**
 * @param {object[]} events  repo issue events, newest first as GitHub returns them
 * @param {{label: string, afterId: number}} opts
 * @returns {{id: number, number: number, title: string, kind: 'issue'|'pr', login: string, at: string}[]}  oldest first
 */
export function labelTriggers(events, { label, afterId }) {
  return events
    .filter((e) => e.event === 'labeled' && e.label?.name === label && e.id > afterId && e.issue)
    .sort((a, b) => a.id - b.id)
    .map((e) => ({
      id: e.id,
      number: e.issue.number,
      title: e.issue.title,
      kind: e.issue.pull_request ? 'pr' : 'issue',
      login: e.actor?.login,
      at: e.created_at,
    }));
}

/**
 * @param {object[]} comments  repo issue comments, oldest update first
 * @param {{seen: Set<number>, notBefore: string}} opts  `notBefore` drops comments
 *   written before the console first ran, so a restart never replays history
 * @returns {{id: number, number: number, login: string, text: string}[]}
 */
export function commandTriggers(comments, { seen, notBefore }) {
  const triggers = [];
  for (const c of comments) {
    if (seen.has(c.id) || c.created_at < notBefore) continue;
    const command = parseCommand(c.body);
    if (!command) continue;
    const number = Number(c.issue_url?.split('/').pop());
    if (!number) continue;
    triggers.push({ id: c.id, number, login: c.user?.login, text: command.text });
  }
  return triggers;
}

/**
 * @param {{repo: string|(() => string), token?: () => Promise<string>, run?: Function}} opts  `token` is the GitHub App's; without it,
 *   `gh` uses its own login or GH_TOKEN. `run` stands in for execFile in tests
 */
export function createGitHub({ repo: repoOrGetter, token, run = execFileAsync }) {
  const ghApi = (args) => ghApiWith(args, token, run);
  // A getter follows the console's default repo, which a console that started with none gets when an admin adds one.
  const currentRepo = typeof repoOrGetter === 'function' ? repoOrGetter : () => repoOrGetter;
  const branches = new Map();
  return {
    get repo() { return currentRepo(); },
    async defaultBranch() {
      const repo = currentRepo();
      if (!branches.has(repo)) {
        const branch = (await ghApi([`repos/${repo}`]))?.default_branch;
        if (!branch) throw new Error(`GitHub did not name ${repo}'s default branch`);
        branches.set(repo, branch);
      }
      return branches.get(repo);
    },
    /** @returns {Promise<string|null>}  a file on the repo's default branch, null when it has none */
    async defaultBranchFile(filePath) {
      try {
        const file = await ghApi([`repos/${currentRepo()}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}`]);
        return file?.content ? Buffer.from(file.content, 'base64').toString('utf8') : null;
      } catch (err) {
        if (/HTTP 404/.test(`${err?.stderr ?? ''}${err?.message ?? ''}`)) return null;
        throw err;
      }
    },
    /** @returns {Promise<string|null>}  the repo's .woodshed/project.yaml on its default branch, null when it has none */
    projectFile() {
      return this.defaultBranchFile('.woodshed/project.yaml');
    },
    compare(base, head) {
      return ghApi([`repos/${currentRepo()}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`]);
    },
    pageSize: PAGE_SIZE,
    async latestEventId() {
      const events = await ghApi([`repos/${currentRepo()}/issues/events?per_page=1`]);
      return events?.[0]?.id ?? 0;
    },
    /**
     * @param {number} afterId
     * @returns {Promise<{events: object[], complete: boolean}>}  newest first, back to `afterId`;
     *   `complete` is false when even the last page read was newer than `afterId`
     */
    async issueEventsSince(afterId) {
      const events = [];
      for (let page = 1; page <= MAX_EVENT_PAGES; page++) {
        const batch = (await ghApi([`repos/${currentRepo()}/issues/events?per_page=${PAGE_SIZE}&page=${page}`])) ?? [];
        events.push(...batch);
        if (batch.length < PAGE_SIZE || batch.some((e) => e.id <= afterId)) return { events, complete: true };
      }
      return { events, complete: false };
    },
    commentsSince(since) {
      return ghApi([`repos/${currentRepo()}/issues/comments?since=${encodeURIComponent(since)}&sort=updated&direction=asc&per_page=${PAGE_SIZE}`]);
    },
    async canWrite(login) {
      try {
        return canWrite(await ghApi([`repos/${currentRepo()}/collaborators/${encodeURIComponent(login)}/permission`]));
      } catch (err) {
        // A 404 is what a non-collaborator, or a bot, gets. Anything else is GitHub or gh failing.
        if (!/HTTP 404/.test(`${err?.stderr ?? ''}${err?.message ?? ''}`)) throw err;
        console.log('github: not a collaborator', { login });
        return false;
      }
    },
    /** @returns {Promise<{id: number, login: string, name: string|null}>}  the account that holds the handle now */
    user(login) {
      return ghApi([`users/${encodeURIComponent(login)}`]);
    },
    issue(number) {
      return ghApi([`repos/${currentRepo()}/issues/${number}`]);
    },
    /**
     * The folder's tree, not its contents: the contents API stops at 1,000 entries, and a tree lists 100,000.
     * @returns {Promise<string[]>}  the names of the files in a folder on the default branch
     */
    async fileNames(folder) {
      const branch = await this.defaultBranch();
      const tree = await ghApi([`repos/${currentRepo()}/git/trees/${encodeURIComponent(`${branch}:${folder}`)}`]);
      if (tree?.truncated) console.warn('github: folder listing cut short', { folder, entries: tree.tree?.length });
      return (tree?.tree ?? []).filter((e) => e.type === 'blob').map((e) => e.path);
    },
    async addAssignees(number, logins) {
      await ghApi(['--method', 'POST', `repos/${currentRepo()}/issues/${Number(number)}/assignees`, ...logins.flatMap((l) => ['-f', `assignees[]=${l}`])]);
    },
    async removeAssignees(number, logins) {
      await ghApi(['--method', 'DELETE', `repos/${currentRepo()}/issues/${Number(number)}/assignees`, ...logins.flatMap((l) => ['-f', `assignees[]=${l}`])]);
    },
    /** @returns {Promise<object[]>}  the issue's cards on project boards, each with its board's Status field and value */
    async issueProjectItems(number) {
      const [owner, name] = currentRepo().split('/');
      const answer = await ghApi(['graphql', '-f', `query=${ISSUE_PROJECT_ITEMS_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${Number(number)}`]);
      return answer?.data?.repository?.issue?.projectItems?.nodes ?? [];
    },
    /** @param {{projectId: string, itemId: string, fieldId: string, optionId: string}} move */
    async setProjectStatus({ projectId, itemId, fieldId, optionId }) {
      await ghApi(['graphql', '-f', `query=${SET_PROJECT_STATUS_MUTATION}`, '-f', `project=${projectId}`, '-f', `item=${itemId}`,
        '-f', `field=${fieldId}`, '-f', `option=${optionId}`]);
    },
    pull(number) {
      return ghApi([`repos/${currentRepo()}/pulls/${number}`]);
    },
    /** @returns {Promise<string[]|null>}  the pull request's file paths, or null when there are more than we read */
    async pullFiles(number) {
      const files = [];
      for (let page = 1; page <= MAX_PULL_FILE_PAGES; page++) {
        const batch = (await ghApi([`repos/${currentRepo()}/pulls/${number}/files?per_page=${PAGE_SIZE}&page=${page}`])) ?? [];
        files.push(...batch.map((f) => f.filename));
        if (batch.length < PAGE_SIZE) return files;
      }
      return null;
    },
    reviews(number) {
      return ghApi([`repos/${currentRepo()}/pulls/${number}/reviews?per_page=${PAGE_SIZE}`]);
    },
    /** @returns {Promise<object[]>}  the commit's latest run of each check */
    async checkRuns(sha) {
      const runs = [];
      for (let page = 1; page <= MAX_CHECK_RUN_PAGES; page++) {
        const batch = (await ghApi([`repos/${currentRepo()}/commits/${sha}/check-runs?filter=latest&per_page=${PAGE_SIZE}&page=${page}`]))?.check_runs ?? [];
        runs.push(...batch);
        if (batch.length < PAGE_SIZE) break;
      }
      return runs;
    },
    /**
     * @param {string} login
     * @returns {Promise<{number: number, title: string, branch: string, why: 'yours'|'review'}[]>}  open pull requests on
     *   the repo that are theirs, then those waiting on their review, newest first; `branch` finds a session on it
     */
    async openPullsFor(login) {
      const q = (qualifier) => `repo:${currentRepo()} is:pr is:open ${qualifier}:${login} sort:updated-desc`;
      const answer = await ghApi(['graphql', '-f', `query=${PULLS_FOR_QUERY}`, '-f', `mine=${q('author')}`, '-f', `review=${q('review-requested')}`]);
      const mine = answer?.data?.mine?.nodes ?? [];
      const review = answer?.data?.review?.nodes ?? [];
      const seen = new Set();
      return [...mine.map((i) => ({ i, why: 'yours' })), ...review.map((i) => ({ i, why: 'review' }))]
        .filter(({ i }) => i?.number && !seen.has(i.number) && seen.add(i.number))
        .map(({ i, why }) => pullRow(i, why));
    },
    /**
     * @param {number[]} numbers  at most 50
     * @returns {Promise<object[]>}  each pull request that exists, with its state, review and latest checks
     */
    async pullStatuses(numbers) {
      const [owner, name] = currentRepo().split('/');
      const fields = numbers.map((n) => `pr${Number(n)}: pullRequest(number: ${Number(n)}) { ${PR_STATUS_FIELDS} }`).join('\n');
      const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`;
      let answer;
      try {
        answer = await ghApi(['graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`]);
      } catch (err) {
        // gh exits 1 when one number has no pull request, and still prints the rest of the answer.
        answer = partialGraphql(err);
        if (!answer?.data?.repository) throw err;
        console.warn('github: some pull requests not found', { asked: numbers.length, missing: answer.errors?.length ?? null });
      }
      return Object.values(answer?.data?.repository ?? {}).filter(Boolean);
    },
    async skills() {
      const [owner, name] = currentRepo().split('/');
      const answer = await ghApi(['graphql', '-f', `query=${SKILLS_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`]);
      return skillsFrom(answer?.data?.repository);
    },
    /** @returns {Promise<{path: string, head_sha: string}>}  an Actions workflow run: `path` is its workflow file */
    workflowRun(runId) {
      return ghApi([`repos/${currentRepo()}/actions/runs/${Number(runId)}`]);
    },
    /** @returns {Promise<object[]>}  the issue or pull request's comments, oldest first, up to the pages we read */
    async issueComments(number) {
      const comments = [];
      for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
        const batch = (await ghApi([`repos/${currentRepo()}/issues/${number}/comments?per_page=${PAGE_SIZE}&page=${page}`])) ?? [];
        comments.push(...batch);
        if (batch.length < PAGE_SIZE) break;
      }
      return comments;
    },
    async updateComment(commentId, body) {
      const updated = await ghApi(['--method', 'PATCH', `repos/${currentRepo()}/issues/comments/${commentId}`, '-f', `body=${body}`]);
      return updated?.id ?? null;
    },
    /**
     * Posts a finished check run on a commit, as the console's App. An installation that has not accepted the App's
     * Checks write permission answers 403, which throws.
     * @param {{sha: string, name: string, conclusion: 'success'|'failure'|'neutral', title: string, summary: string,
     *          detailsUrl?: string|null, externalId?: string|null}} check
     * @returns {Promise<string|null>}  the check's page
     */
    async createCheckRun({ sha, name, conclusion, title, summary, detailsUrl = null, externalId = null }) {
      const fields = ['-f', `name=${name}`, '-f', `head_sha=${sha}`, '-f', 'status=completed', '-f', `conclusion=${conclusion}`,
        '-f', `output[title]=${title}`, '-f', `output[summary]=${summary.slice(0, 60_000)}`];
      if (detailsUrl) fields.push('-f', `details_url=${detailsUrl}`);
      if (externalId) fields.push('-f', `external_id=${externalId}`);
      const created = await ghApi(['--method', 'POST', `repos/${repo}/check-runs`, ...fields]);
      return created?.html_url ?? null;
    },
    async comment(number, body) {
      const created = await ghApi(['--method', 'POST', `repos/${currentRepo()}/issues/${number}/comments`, '-f', `body=${body}`]);
      return created?.id ?? null;
    },
    /** @returns {Promise<true>}  once GitHub took the label off; a label that was not there answers 404 and throws */
    async removeLabel(number, label) {
      await ghApi(['--method', 'DELETE', `repos/${currentRepo()}/issues/${number}/labels/${encodeURIComponent(label)}`]);
      return true;
    },
    reactToIssue(number, content = 'eyes') {
      return ghApi(['--method', 'POST', `repos/${currentRepo()}/issues/${number}/reactions`, '-f', `content=${content}`]);
    },
    reactToComment(commentId, content = 'eyes') {
      return ghApi(['--method', 'POST', `repos/${currentRepo()}/issues/comments/${commentId}/reactions`, '-f', `content=${content}`]);
    },
  };
}

/**
 * @param {number[]} seen
 * @param {number[]} added
 * @returns {number[]}  the most recent ids, bounded
 */
export function rememberSeen(seen, added) {
  return [...seen, ...added].slice(-SEEN_COMMENTS_KEPT);
}
