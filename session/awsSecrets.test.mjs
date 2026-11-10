import { test } from 'node:test';
import assert from 'node:assert/strict';

import { signRequest } from './awsSecrets.mjs';

const EXAMPLE = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };

test('signRequest matches the get-vanilla case from AWS\'s Signature Version 4 test suite', () => {
  const headers = signRequest({
    method: 'GET', host: 'example.amazonaws.com', path: '/', region: 'us-east-1', service: 'service', headers: {}, body: '',
    credentials: EXAMPLE, date: new Date('2015-08-30T12:36:00Z'),
  });
  assert.equal(headers['x-amz-date'], '20150830T123600Z');
  assert.equal(headers.Authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, '
    + 'SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
});

test('signRequest signs a task role\'s session token and the JSON API\'s headers', () => {
  const headers = signRequest({
    method: 'POST', host: 'secretsmanager.us-east-1.amazonaws.com', path: '/', region: 'us-east-1', service: 'secretsmanager',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'secretsmanager.GetSecretValue' },
    body: '{"SecretId":"woodshed-cloud/shared-database"}', credentials: { ...EXAMPLE, sessionToken: 'TOKEN' }, date: new Date('2015-08-30T12:36:00Z'),
  });
  assert.equal(headers['x-amz-security-token'], 'TOKEN');
  assert.equal(headers.host, undefined, 'https sets host itself');
  assert.match(headers.Authorization, /SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target, Signature=[0-9a-f]{64}$/);
});
