import { test } from 'node:test';
import assert from 'node:assert/strict';

import net from 'node:net';

import { parseOutbound, parsePorts, startGateway } from './sessionGateway.mjs';

test('the gateway carries each port to the one place it names, and refuses a list it cannot carry', async (t) => {
  const target = net.createServer((s) => s.end('from the console'));
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  t.after(() => target.close());
  const free = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
  const servers = await startGateway({ routes: [{ listen: free, host: '127.0.0.1', port: target.address().port }] });
  t.after(() => servers.forEach((s) => s.close()));
  const said = await new Promise((resolve, reject) => {
    let text = '';
    net.connect(free, '127.0.0.1').on('data', (d) => { text += d; }).on('end', () => resolve(text)).on('error', reject);
  });
  assert.equal(said, 'from the console');

  assert.deepEqual(parseOutbound('7691=host.docker.internal:7691, 5432=postgres:5432'), [
    { listen: 7691, host: 'host.docker.internal', port: 7691 }, { listen: 5432, host: 'postgres', port: 5432 },
  ]);
  assert.throws(() => parseOutbound('7691=http://x:1'), /not <port>=<host>:<port>/);
  assert.deepEqual(parsePorts('7681,7682'), [7681, 7682]);
  await assert.rejects(startGateway({ routes: [{ listen: 1, host: 'a', port: 1 }, { listen: 1, host: 'b', port: 1 }] }), /carried twice/);
});
