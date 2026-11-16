import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { PS_FORMAT, SESSION_PORTS, createDockerPorts, portsFrom, publishedPorts } from './dockerPorts.mjs';

test('the machine\'s TCP ports are read from docker ps\'s Ports column, each once, and what is only exposed is not', () => {
  assert.deepEqual(publishedPorts('0.0.0.0:54322->5432/tcp, [::]:54322->5432/tcp, 127.0.0.1:54321->8000/tcp'), [54322, 54321]);
  assert.deepEqual(publishedPorts(':::8080->80/tcp, 9000/tcp, 0.0.0.0:5353->53/udp'), [8080]);
  assert.deepEqual(publishedPorts('0.0.0.0:7000-7002->7000-7002/tcp'), [7000, 7001, 7002]);
  assert.deepEqual(publishedPorts(''), []);
  assert.deepEqual(publishedPorts(undefined), []);
});

test('a session\'s own containers are left out: their ports are the console\'s', () => {
  assert.match(PS_FORMAT, /\{\{\.Label "woodshed\.session"\}\}/);
  const ps = [
    'aaaaaaaaaaaaaaaa\t\t127.0.0.1:54321->8000/tcp',
    'bbbbbbbbbbbb\t0a1b2c3d\t127.0.0.1:49153->7681/tcp, 127.0.0.1:49154->7682/tcp',
    'cccccccccccc\t\t',
    '',
  ].join('\n');
  assert.deepEqual([...portsFrom(ps)], [[54321, 'aaaaaaaaaaaa']]);
});

// A port nothing on this machine listens on, found by listening on it and letting go.
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// What `host.docker.internal:<port>` stands for in the test: a server that answers each line with `<tag>:<line>`.
async function upstream(tag) {
  const server = net.createServer((socket) => socket.on('data', (d) => socket.write(`${tag}:${d}`)));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function ask(port, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
    socket.once('data', (d) => { resolve(String(d)); socket.destroy(); });
    socket.once('error', reject);
  });
}

test('each published port is forwarded from 127.0.0.1 here to the machine, and stops being when its container goes', async (t) => {
  const port = await freePort();
  const machine = await upstream('machine');
  t.after(() => machine.close());
  let ps = `aaaaaaaaaaaa\t\t0.0.0.0:${port}->5432/tcp, [::]:${port}->5432/tcp`;
  const logs = [];
  const forwarder = createDockerPorts({
    listContainers: async () => ps,
    target: () => ({ host: '127.0.0.1', port: machine.address().port }),
    log: (message, fields) => logs.push([message, fields]),
  });
  t.after(() => forwarder.close());

  await forwarder.refresh();
  assert.deepEqual(forwarder.forwarded(), [port]);
  assert.equal(await ask(port, 'select 1'), 'machine:select 1');
  assert.deepEqual(logs[0], ['dockerPorts: port forwarded', { port, container: 'aaaaaaaaaaaa', to: `127.0.0.1:${machine.address().port}` }]);

  await forwarder.refresh();
  assert.equal(logs.length, 1, 'a port already forwarded is not again');

  ps = '';
  await forwarder.refresh();
  assert.deepEqual(forwarder.forwarded(), []);
  assert.deepEqual(logs[1], ['dockerPorts: forward ended, the port is no longer published', { port }]);
  await assert.rejects(ask(port, 'x'), /ECONNREFUSED/);
});

test('a port something in the session listens on is left to it, said once, and forwarded once it lets go', async (t) => {
  const port = await freePort();
  const own = net.createServer((s) => s.end('own'));
  await new Promise((resolve) => own.listen(port, '127.0.0.1', resolve));
  const machine = await upstream('machine');
  t.after(() => machine.close());
  const logs = [];
  const forwarder = createDockerPorts({
    listContainers: async () => `aaaaaaaaaaaa\t\t127.0.0.1:${port}->3000/tcp`,
    target: () => ({ host: '127.0.0.1', port: machine.address().port }),
    log: (message, fields) => logs.push([message, fields]),
  });
  t.after(() => forwarder.close());

  await forwarder.refresh();
  await forwarder.refresh();
  assert.deepEqual(forwarder.forwarded(), []);
  assert.deepEqual(logs, [['dockerPorts: port not forwarded', { port, container: 'aaaaaaaaaaaa', why: 'something in the session listens on it' }]]);

  await new Promise((resolve) => own.close(resolve));
  await forwarder.refresh();
  assert.deepEqual(forwarder.forwarded(), [port]);
  assert.equal(await ask(port, 'hi'), 'machine:hi');
});

test('the session\'s own ports are never taken, even before it listens on them', async (t) => {
  assert.ok(SESSION_PORTS.includes(6379) && SESSION_PORTS.includes(7682), 'Redis and statusd');
  const logs = [];
  const forwarder = createDockerPorts({
    listContainers: async () => 'aaaaaaaaaaaa\t\t0.0.0.0:6379->6379/tcp',
    log: (message, fields) => logs.push([message, fields]),
  });
  t.after(() => forwarder.close());
  await forwarder.refresh();
  await forwarder.refresh();
  assert.deepEqual(forwarder.forwarded(), []);
  assert.deepEqual(logs, [['dockerPorts: port not forwarded', { port: 6379, container: 'aaaaaaaaaaaa', why: 'the session uses it' }]]);
});

test('docker not answering is said, and changes nothing', async (t) => {
  const logs = [];
  const forwarder = createDockerPorts({
    listContainers: async () => { throw Object.assign(new Error('exit 1'), { stderr: 'permission denied while trying to connect to the Docker daemon socket\nmore' }); },
    log: (message, fields) => logs.push([message, fields]),
  });
  t.after(() => forwarder.close());
  await forwarder.refresh();
  assert.deepEqual(logs, [['dockerPorts: containers not read', { message: 'permission denied while trying to connect to the Docker daemon socket' }]]);
});

test('a read asked for during another makes one more read after it, not one each', async (t) => {
  let reads = 0;
  let release;
  const forwarder = createDockerPorts({
    listContainers: async () => {
      reads += 1;
      if (reads === 1) await new Promise((resolve) => { release = resolve; });
      return '';
    },
    log: () => {},
  });
  t.after(() => forwarder.close());
  const first = forwarder.refresh();
  forwarder.refresh();
  forwarder.refresh();
  release();
  await first;
  assert.equal(reads, 2);
});
