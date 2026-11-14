import { test } from 'node:test';
import assert from 'node:assert/strict';

import { connectionsFrom, parseConnections, subjectFor } from './oidcConnections.mjs';

const AWS = { name: 'aws-dev', type: 'aws', roleArn: 'arn:aws:iam::123456789012:role/woodshed-dev', region: 'us-east-1' };
const AZURE = { name: 'azure', type: 'azure', clientId: '11111111-2222-3333-4444-555555555555', tenantId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
const GCP = {
  name: 'gcp', type: 'gcp', provider: 'projects/123456/locations/global/workloadIdentityPools/woodshed/providers/console',
  serviceAccount: 'woodshed@my-project.iam.gserviceaccount.com',
};

test('each cloud gets the audience its own docs default to, unless the connection names one', () => {
  const [aws, azure, gcp, vault] = parseConnections([AWS, AZURE, GCP, { name: 'vault', type: 'token', audience: 'vault' }]);
  assert.equal(aws.audience, 'sts.amazonaws.com');
  assert.equal(azure.audience, 'api://AzureADTokenExchange');
  assert.equal(gcp.audience, 'https://iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/woodshed/providers/console');
  assert.equal(vault.audience, 'vault');
  assert.equal(parseConnections([{ ...AWS, audience: 'woodshed' }])[0].audience, 'woodshed');
});

test('no setting is no connection', () => {
  assert.deepEqual(connectionsFrom(undefined), []);
  assert.deepEqual(connectionsFrom('  '), []);
  assert.deepEqual(connectionsFrom('[]'), []);
});

test('a connection that is wrong is refused, naming it and the field', () => {
  assert.throws(() => connectionsFrom('{nope'), /WOODSHED_OIDC_CONNECTIONS: is not JSON/);
  assert.throws(() => parseConnections({}), /must be a JSON list/);
  assert.throws(() => parseConnections([{ ...AWS, name: 'AWS' }]), /name must be lowercase/);
  assert.throws(() => parseConnections([AWS, AWS]), /aws-dev is named twice/);
  assert.throws(() => parseConnections([{ ...AWS, type: 'oracle' }]), /type must be one of aws, azure, gcp, token/);
  assert.throws(() => parseConnections([{ name: 'aws-dev', type: 'aws' }]), /aws-dev is missing roleArn/);
  assert.throws(() => parseConnections([{ ...AWS, roleArn: 'arn:aws:iam::123:user/me' }]), /aws-dev's roleArn must be an IAM role ARN/);
  assert.throws(() => parseConnections([{ ...AWS, clientId: 'x' }]), /aws-dev has clientId, which a aws connection does not take/);
  assert.throws(() => parseConnections([{ ...AZURE, tenantId: 'common' }]), /azure's tenantId must be the Entra tenant ID/);
  assert.throws(() => parseConnections([{ ...GCP, provider: 'pool/x' }]), /gcp's provider must be projects\//);
  assert.throws(() => parseConnections([{ name: 'vault', type: 'token' }]), /vault is missing audience/);
});

test('nothing a shell or a config file reads can get into a value', () => {
  for (const audience of ['a b', 'a;rm -rf', '$(id)', 'a\nb', 'a"b', "a'b", 'a`b', 'x[profile]']) {
    assert.throws(() => parseConnections([{ name: 'vault', type: 'token', audience }]), /audience must be/, audience);
  }
  assert.throws(() => parseConnections([{ ...AWS, roleArn: `${AWS.roleArn}\n[default]` }]), /roleArn/);
});

test('the subject is the owner, lowercase, and nobody for a shared session', () => {
  assert.equal(subjectFor({ owner: 'Octo-Cat' }), 'private:octo-cat');
  assert.equal(subjectFor({ owner: null }), null);
  assert.equal(subjectFor({}), null);
  assert.equal(subjectFor({ owner: 'bad login' }), null);
});
