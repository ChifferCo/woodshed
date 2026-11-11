// GitHub's webhook events, made into the messages the console's dispatch takes (webhookDispatch.mjs), for a caller
// that receives them itself and hands each to an installation (installation.mjs, dispatchWebhook).
//
// The same as the AWS provider's webhooks Lambda makes them (providers/aws/webhooks/index.mjs, toMessage): Terraform
// zips that one file alone, so it cannot import this, and the console may not import a provider. githubEvents.test.mjs
// runs both over the same events and fails when they differ.

// The console sends at most 8000 characters to a session; the rest of a longer comment is on GitHub.
const MAX_COMMENT_CHARS = 8000;
// A cheap first cut, so ordinary comments are not queued; the console parses the command itself.
const COMMAND_PREFIX = /^\s*\/woodshed\b/i;
// A session asking for a person (session/readyGate.mjs, prompt.md): the console messages its assignee. Only the App's
// own comments count, since a session comments as the App and anyone could type the words; the console checks that,
// against its App's login (console/appIdentity.mjs), because each installation names its App itself.
const NEEDS_HUMAN_PREFIX = /^\s*Needs a human:/i;
// What can change a pull request's chip, its review or its checks: the console reads the pull request again when it
// is one a session opened. A workflow run lists the pull requests of its branch.
const PULL_ACTIONS = new Set(['closed', 'reopened', 'synchronize', 'edited', 'ready_for_review', 'converted_to_draft', 'enqueued', 'dequeued']);
const REVIEW_ACTIONS = new Set(['submitted', 'dismissed']);
const MAX_PULLS_PER_RUN = 10;

/**
 * @param {string} event  `X-GitHub-Event`
 * @param {object} payload
 * @param {{deliveryId: string, receivedAt: string}} meta
 * @returns {object|null}  the message for the console, or null when it acts on nothing in this event
 */
export function toMessage(event, payload, { deliveryId, receivedAt }) {
  // The repo each event is about: one App can be installed on several repos, and the console acts on its projects'.
  const base = { source: 'github', deliveryId, receivedAt, login: payload?.sender?.login ?? null, repo: payload?.repository?.full_name ?? null };
  if ((event === 'issues' || event === 'pull_request') && payload?.action === 'labeled') {
    const target = event === 'issues' ? payload.issue : payload.pull_request;
    if (!target?.number || !payload.label?.name) return null;
    const kind = event === 'pull_request' || target.pull_request ? 'pr' : 'issue';
    return { ...base, type: 'label', number: target.number, kind, title: target.title ?? '', label: payload.label.name };
  }
  const pulls = changedPulls(event, payload);
  if (pulls) return { ...base, type: 'pr', kind: 'pr', number: pulls.numbers[0], numbers: pulls.numbers, what: pulls.what };
  if (event === 'issue_comment' && payload?.action === 'created') {
    const comment = payload.comment;
    if (!comment?.id || !payload.issue?.number) return null;
    if (NEEDS_HUMAN_PREFIX.test(comment.body ?? '')) {
      return {
        ...base, login: comment.user?.login ?? base.login, type: 'needsHuman', number: payload.issue.number, commentId: comment.id,
        url: comment.html_url ?? null, body: comment.body.slice(0, MAX_COMMENT_CHARS),
      };
    }
    if (!COMMAND_PREFIX.test(comment.body ?? '')) return null;
    return {
      ...base, type: 'comment', number: payload.issue.number, commentId: comment.id,
      createdAt: comment.created_at, body: comment.body.slice(0, MAX_COMMENT_CHARS),
    };
  }
  return null;
}

/** @returns {{numbers: number[], what: string}|null}  the pull requests an event changed, and a short name for it */
function changedPulls(event, payload) {
  const action = payload?.action;
  if (event === 'pull_request' && PULL_ACTIONS.has(action) && payload.pull_request?.number) {
    return { numbers: [payload.pull_request.number], what: `pull request ${action}` };
  }
  if (event === 'pull_request_review' && REVIEW_ACTIONS.has(action) && payload.pull_request?.number) {
    return { numbers: [payload.pull_request.number], what: `review ${action}` };
  }
  if (event === 'workflow_run' && action === 'completed') {
    const numbers = (payload.workflow_run?.pull_requests ?? []).map((p) => p?.number).filter(Number.isInteger).slice(0, MAX_PULLS_PER_RUN);
    if (numbers.length) return { numbers, what: `${String(payload.workflow_run.name ?? 'workflow').slice(0, 60)} ${payload.workflow_run.conclusion ?? 'completed'}` };
  }
  return null;
}
