// Names and ports Woodshed keeps for itself in every session, which a repo's project file and an installation's
// settings cannot take: the console refuses them in its settings (console/config.mjs), and `project.mjs check` in a
// project file.

// The variables Woodshed itself gives a session (session/entrypoint.sh, its Environment), besides every WOODSHED_ one:
// an install secret cannot arrive in one of them. providers/aws/terraform/variables.tf, install_secrets, repeats it.
export const SESSION_VARIABLES = Object.freeze([
  'SESSION_ID', 'SESSION_TOKEN', 'TERMINAL_TOKEN', 'SESSION_URL', 'SESSION_KIND', 'SESSION_MODE', 'STARTED_BY', 'ISSUE', 'PR',
  'BRANCH', 'PROMPT', 'ASKED_BY', 'AGENT', 'MODEL', 'EFFORT', 'PERMISSION_MODE', 'RESUME_SESSION', 'ATTACHMENTS', 'REVIEW_ONLY',
  'REPO_DIR', 'GH_TOKEN', 'ANTHROPIC_API_KEY', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSSLMODE',
  'PGSSLROOTCERT', 'PG_URL', 'MONGODB_URI', 'HOME', 'PATH',
]);

/** @returns {boolean}  whether a session's variable of this name is Woodshed's own */
export function isSessionVariable(name) {
  return name.startsWith('WOODSHED_') || SESSION_VARIABLES.includes(name);
}

// The console's own secrets (console/secrets.mjs, secretSpecs), which no session is handed: an env file or install
// secret of one of these names would be. Terraform's install_secrets repeats it.
export const CONSOLE_SECRETS = Object.freeze([
  'anthropic-api-key', 'openai-api-key', 'github-app-key', 'github-app-client-secret', 'github-webhook-secret', 'slack-bot-token',
  'slack-signing-secret',
]);

// What listens inside a session besides the app (session/entrypoint.sh, statusd.mjs; the database viewers are each
// engine's `viewers`): the app's ports cannot be these.
export const SESSION_PORTS = Object.freeze({
  6379: 'Redis', 7681: "claude's terminal (ttyd)", 7682: 'statusd', 7683: 'redis-commander', 7684: 'the shell terminal (ttyd)',
  7688: 'the editor (openvscode-server)',
});
