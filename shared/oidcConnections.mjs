// The clouds a private session may sign in to as its owner, with no key of its own: the console is an OpenID Connect
// issuer (console/oidcIssuer.mjs), each cloud is told once to trust it, and a session trades a short-lived token from
// the console for that cloud's own credentials (session/cloudSignIn.mjs). This is the list of those clouds, which the
// installation sets in WOODSHED_OIDC_CONNECTIONS as JSON (Terraform's `oidc_connections` on AWS):
//
//   [{"name": "aws-dev", "type": "aws", "roleArn": "arn:aws:iam::123456789012:role/woodshed-dev", "region": "us-east-1"},
//    {"name": "azure", "type": "azure", "clientId": "<uuid>", "tenantId": "<uuid>", "subscriptionId": "<uuid>"},
//    {"name": "gcp", "type": "gcp", "provider": "projects/123/locations/global/workloadIdentityPools/woodshed/providers/console",
//     "serviceAccount": "woodshed@my-project.iam.gserviceaccount.com"},
//    {"name": "vault", "type": "token", "audience": "vault"}]
//
// Nothing here is a secret: a role, a client id and a provider name only say where to sign in. Who may sign in, and to
// what, is the cloud's own trust policy, which matches the token's `sub` (subjectFor). Every value is checked against a
// narrow pattern because the session writes them into config files and its environment.

export const CONNECTION_TYPES = Object.freeze(['aws', 'azure', 'gcp', 'token']);

const NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;
// What any value may hold: enough for an ARN, a URL-like audience or an email, and nothing a shell or an INI file reads.
const SAFE_RE = /^[A-Za-z0-9._:/@+=,-]{1,300}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ROLE_ARN_RE = /^arn:aws[a-z-]*:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]{1,512}$/;
const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;
const GCP_PROVIDER_RE = /^projects\/\d+\/locations\/global\/workloadIdentityPools\/[a-z0-9-]{4,32}\/providers\/[a-z0-9-]{4,32}$/;
const EMAIL_RE = /^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9.-]{1,253}$/;

const FIELDS = {
  aws: { required: ['roleArn'], optional: ['region'] },
  azure: { required: ['clientId', 'tenantId'], optional: ['subscriptionId'] },
  gcp: { required: ['provider'], optional: ['serviceAccount'] },
  token: { required: ['audience'], optional: [] },
};

const CHECKS = {
  roleArn: [ROLE_ARN_RE, 'an IAM role ARN, arn:aws:iam::<account>:role/<name>'],
  region: [REGION_RE, 'an AWS region, as us-east-1'],
  clientId: [UUID_RE, 'the app registration\'s or managed identity\'s client ID, a UUID'],
  tenantId: [UUID_RE, 'the Entra tenant ID, a UUID'],
  subscriptionId: [UUID_RE, 'the Azure subscription ID, a UUID'],
  provider: [GCP_PROVIDER_RE, 'projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>'],
  serviceAccount: [EMAIL_RE, 'a service account\'s email'],
  audience: [SAFE_RE, 'letters, digits and . _ : / @ + = , - only'],
};

/** The audience each cloud asks for when its own docs' defaults are kept. */
export function defaultAudience(connection) {
  if (connection.type === 'aws') return 'sts.amazonaws.com';
  if (connection.type === 'azure') return 'api://AzureADTokenExchange';
  if (connection.type === 'gcp') return `https://iam.googleapis.com/${connection.provider}`;
  return null;
}

function refuse(message) {
  throw new Error(`WOODSHED_OIDC_CONNECTIONS: ${message}`);
}

/**
 * @param {unknown} raw  the parsed JSON
 * @returns {{name: string, type: string, audience: string, roleArn?: string, region?: string, clientId?: string,
 *            tenantId?: string, provider?: string, serviceAccount?: string}[]}
 * @throws {Error}  naming the connection and field that is wrong
 */
export function parseConnections(raw) {
  if (!Array.isArray(raw)) refuse('must be a JSON list of connections, as [{"name": "aws-dev", "type": "aws", "roleArn": "..."}]');
  const seen = new Set();
  return raw.map((item, i) => {
    const at = `connection ${i + 1}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) refuse(`${at} must be an object`);
    if (typeof item.name !== 'string' || !NAME_RE.test(item.name)) refuse(`${at}'s name must be lowercase letters, digits and dashes, starting with a letter`);
    const where = `${item.name}`;
    if (seen.has(item.name)) refuse(`${where} is named twice`);
    seen.add(item.name);
    if (!CONNECTION_TYPES.includes(item.type)) refuse(`${where}'s type must be one of ${CONNECTION_TYPES.join(', ')}`);
    const { required, optional } = FIELDS[item.type];
    const allowed = new Set(['name', 'type', 'audience', ...required, ...optional]);
    for (const key of Object.keys(item)) if (!allowed.has(key)) refuse(`${where} has ${key}, which a ${item.type} connection does not take`);
    const out = { name: item.name, type: item.type };
    for (const key of [...required, ...optional, 'audience']) {
      const value = item[key];
      if (value === undefined || value === null || value === '') {
        if (required.includes(key)) refuse(`${where} is missing ${key}`);
        continue;
      }
      const [re, what] = CHECKS[key];
      if (typeof value !== 'string' || !re.test(value) || !SAFE_RE.test(value)) refuse(`${where}'s ${key} must be ${what}`);
      out[key] = value;
    }
    out.audience = out.audience ?? defaultAudience(out);
    return out;
  });
}

/**
 * @param {string|undefined} text  WOODSHED_OIDC_CONNECTIONS
 * @returns {ReturnType<typeof parseConnections>}  none when unset
 */
export function connectionsFrom(text) {
  if (!text || !text.trim()) return [];
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    refuse(`is not JSON (${err.message})`);
  }
  return parseConnections(raw);
}

/**
 * Who a token says the session is: the one claim every cloud's trust policy can match exactly (AWS and Azure match
 * only the issuer, the audience and this). Lowercase, since GitHub logins are not case-sensitive and a policy's match is.
 * @param {{owner?: string|null}} session
 * @returns {string|null}  `private:<login>`, or null for a session that gets no token
 */
export function subjectFor(session) {
  const owner = typeof session?.owner === 'string' ? session.owner.toLowerCase() : '';
  return /^[a-z0-9-]{1,39}$/.test(owner) ? `private:${owner}` : null;
}
