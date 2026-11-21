import { test } from 'node:test';
import assert from 'node:assert/strict';

import { listeningPorts, portNumber, SESSION_PORTS } from './listeningPorts.mjs';

// As the kernel writes them, trimmed of the columns after `st`.
const TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:1E1A 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1001 1
   1: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1002 1
   2: 0100007F:1435 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 1003 1
   3: 0200A8C0:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1004 1
   4: 0100007F:1E02 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1005 1
`;
const TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue
   0: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000
   1: 00000000000000000000000000000000:0BB9 00000000000000000000000000000000:0000 0A 00000000:00000000
   2: 0000000000000000FFFF00000100007F:2328 00000000000000000000000000000000:0000 0A 00000000:00000000
   3: 00000000000000000000000000000000:1435 00000000000000000000000000000000:0000 0A 00000000:00000000
   4: 80FE0000000000000102030405060708:0FA0 00000000000000000000000000000000:0000 0A 00000000:00000000
`;

test('the ports listened on where localhost reaches them, each once, in order', () => {
  // 7706 on any address, 5173 on 127.0.0.1 and on :: (once), 8080 on ::1, 3001 on ::, 9000 on ::ffff:127.0.0.1.
  assert.deepEqual(listeningPorts(TCP + TCP6), [3001, 5173, 7706, 8080, 9000]);
});

test('a connection is not a listener, an address localhost does not reach is not forwarded, nor the session\'s own', () => {
  const ports = listeningPorts(TCP);
  assert.equal(ports.includes(3000), false, '192.168.0.2 only');
  assert.equal(ports.includes(7682), false, 'statusd-like ports are the session\'s own');
  assert.deepEqual(listeningPorts(TCP, { skip: [] }).includes(7682), true);
  assert.ok(SESSION_PORTS.includes(7682));
  assert.deepEqual(listeningPorts(''), []);
  assert.deepEqual(listeningPorts('garbage\nmore garbage'), []);
});

test('a port number is 1 to 65535, written in digits', () => {
  assert.equal(portNumber('5173'), 5173);
  assert.equal(portNumber('0'), null);
  assert.equal(portNumber('65536'), null);
  assert.equal(portNumber('51a3'), null);
  assert.equal(portNumber(undefined), null);
});
