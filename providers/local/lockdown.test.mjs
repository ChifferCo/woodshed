import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hostsPointedAt, lockedTargets } from './lockdown.mjs';

test('a locked-down session reaches the console, its egress proxy, its databases and the shared services, each by name', () => {
  const { routes, names } = lockedTargets({
    WOODSHED_CONSOLE_URL: 'http://host.docker.internal:7691', PGHOST: 'postgres', PGPORT: '5432', WOODSHED_MONGO_HOST: 'mongo:27017',
    WOODSHED_SERVICES: 'S3_ENDPOINT REDIS_URL', S3_ENDPOINT: 'http://s3:4566', REDIS_URL: 'redis://127.0.0.1:6379',
  }, { egressUrl: 'http://host.docker.internal:7693' });
  assert.deepEqual(routes.map((r) => `${r.listen}->${r.host}:${r.port}`), ['7691->host.docker.internal:7691', '7693->host.docker.internal:7693', '5432->postgres:5432', '27017->mongo:27017', '4566->s3:4566']);
  assert.deepEqual(names, ['host.docker.internal', 'postgres', 'mongo', 's3'], 'its own Redis on loopback needs nothing carried');
});

test('a destination given by its address, two on one port, or one on the session\'s own ports cannot be carried', () => {
  assert.throws(() => lockedTargets({ WOODSHED_CONSOLE_URL: 'http://172.17.0.1:7691' }), /given by its address/);
  assert.throws(() => lockedTargets({ WOODSHED_CONSOLE_URL: 'http://a:5432', PGHOST: 'b' }), /both on port 5432/);
  assert.throws(() => lockedTargets({ WOODSHED_CONSOLE_URL: 'http://a:7682' }), /carries in to the session/);
});

test('the destinations\' names point at the gateway, every other line as it was', () => {
  const text = '127.0.0.1\tlocalhost\n172.17.0.1\thost.docker.internal\n172.17.0.5\tabc123\n# note\n';
  assert.equal(hostsPointedAt(text, ['host.docker.internal', 'postgres'], '172.30.0.2'),
    '127.0.0.1\tlocalhost\n172.17.0.5\tabc123\n# note\n172.30.0.2\thost.docker.internal postgres\t# the session\'s gateway (Woodshed lockdown)\n');
});
