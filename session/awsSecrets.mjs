// Secrets Manager for the db-admin task, with its task role's credentials and no SDK: the session image has no
// AWS CLI, and the backend's AWS packages come and go with its own dependencies. Get and Put only.

import crypto from 'node:crypto';
import https from 'node:https';

// ECS serves a task role's credentials here, at the path it puts in AWS_CONTAINER_CREDENTIALS_RELATIVE_URI.
const CREDENTIALS_HOST = 'http://169.254.170.2';

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function hmac(key, text) {
  return crypto.createHmac('sha256', key).update(text).digest();
}

/**
 * Signature Version 4 for one request.
 * @param {{method: string, host: string, path: string, region: string, service: string, headers: Record<string, string>,
 *          body: string, credentials: {accessKeyId: string, secretAccessKey: string, sessionToken?: string},
 *          date: Date}} request  `headers` without host, x-amz-date or the token, which this adds
 * @returns {Record<string, string>}  every header to send, Authorization included
 */
export function signRequest({ method, host, path, region, service, headers, body, credentials, date }) {
  const amzDate = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const all = { ...headers, host, 'x-amz-date': amzDate };
  if (credentials.sessionToken) all['x-amz-security-token'] = credentials.sessionToken;
  const names = Object.keys(all).map((n) => n.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const signedHeaders = names.join(';');
  const canonical = [method, path, '', ...names.map((n) => `${n}:${lower[n]}`), '', signedHeaders, sha256(body)].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = ['aws4_request', service, region, day].reduceRight((k, part) => hmac(k, part), `AWS4${credentials.secretAccessKey}`);
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  const { host: _host, ...sent } = all;
  return { ...sent, Authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

async function taskCredentials() {
  const relative = process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  if (!relative?.startsWith('/')) throw new Error('no task role credentials: AWS_CONTAINER_CREDENTIALS_RELATIVE_URI is not set');
  const res = await fetch(`${CREDENTIALS_HOST}${relative}`);
  if (!res.ok) throw new Error(`task role credentials: HTTP ${res.status}`);
  const body = await res.json();
  return { accessKeyId: body.AccessKeyId, secretAccessKey: body.SecretAccessKey, sessionToken: body.Token };
}

function post(host, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, method: 'POST', path: '/', headers: { ...headers, 'content-length': Buffer.byteLength(body) }, timeout: 30_000 }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('timeout', () => req.destroy(new Error('Secrets Manager did not answer within 30 s')));
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * @param {{region: string, credentials?: () => Promise<object>}} opts
 */
export function secretsClient({ region, credentials = taskCredentials }) {
  const host = `secretsmanager.${region}.amazonaws.com`;

  async function call(action, payload) {
    const body = JSON.stringify(payload);
    const headers = signRequest({
      method: 'POST', host, path: '/', region, service: 'secretsmanager', body, credentials: await credentials(), date: new Date(),
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `secretsmanager.${action}` },
    });
    const { status, text } = await post(host, headers, body);
    const answer = text ? JSON.parse(text) : {};
    if (status === 200) return answer;
    // The error's type names the problem; its message never holds a secret's value.
    const type = String(answer.__type ?? '').split('#').pop();
    throw Object.assign(new Error(`secretsmanager ${action} failed: ${type || `HTTP ${status}`}: ${answer.message ?? answer.Message ?? ''}`), { type });
  }

  return {
    /** @returns {Promise<string|null>}  null for a secret with no value yet */
    async get(name) {
      try {
        return (await call('GetSecretValue', { SecretId: name })).SecretString ?? null;
      } catch (err) {
        if (err.type === 'ResourceNotFoundException') return null;
        throw err;
      }
    },
    async put(name, value) {
      await call('PutSecretValue', { SecretId: name, SecretString: value });
    },
  };
}
