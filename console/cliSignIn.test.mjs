import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CLI_TOKEN_TTL_MS, createCliSignIn, normalUserCode } from './cliSignIn.mjs';

function signIn({ allowed } = {}) {
  let clock = Date.parse('2026-11-20T10:00:00Z');
  let saves = 0;
  const store = { state: {}, save() { saves += 1; } };
  const cli = createCliSignIn({ store, now: () => clock, allowed });
  return { cli, store, tick: (ms) => { clock += ms; }, saves: () => saves };
}

test('a code waits for the person, says slow down to a CLI that asks too often, and hands its token out once', () => {
  const { cli, store, tick } = signIn();
  const { deviceCode, userCode, interval } = cli.start({ name: 'mia-laptop\u0007', from: '10.0.0.4' });
  assert.equal(interval, 5);
  assert.deepEqual(cli.waiting(userCode.toLowerCase().replace('-', ' ')), { userCode, name: 'mia-laptop', from: '10.0.0.4', createdAt: '2026-11-20T10:00:00.000Z' }, 'typed any way, and the name printable');
  assert.equal(cli.poll(deviceCode).status, 'pending');
  tick(1000);
  assert.equal(cli.poll(deviceCode).status, 'slow_down');
  tick(5000);
  assert.equal(cli.poll(deviceCode).status, 'pending');
  assert.equal(cli.decide({ code: userCode, login: 'mia-dev', approve: true }), true);
  assert.equal(cli.waiting(userCode), null, 'answered: the page no longer offers it');
  const got = cli.poll(deviceCode);
  assert.equal(got.status, 'approved');
  assert.match(got.token, /^wsc_[0-9a-f]{64}$/);
  assert.equal(got.login, 'mia-dev');
  assert.equal(cli.poll(deviceCode).status, 'expired', 'once only');
  assert.ok(!JSON.stringify(store.state).includes(got.token), 'state.json keeps only its hash');
  assert.equal(cli.tokenFor({ authorization: `Bearer ${got.token}` }).login, 'mia-dev');
  tick(CLI_TOKEN_TTL_MS);
  assert.equal(cli.tokenFor({ authorization: `Bearer ${got.token}` }), null, 'it ends after 90 days');
  assert.deepEqual(cli.list('mia-dev'), []);
});

test('a code nobody answers expires, a denied one is refused, and an approval by someone since removed is refused', () => {
  const people = new Set(['mia-dev']);
  const { cli, tick } = signIn({ allowed: (login) => people.has(login) });
  const ignored = cli.start({ name: 'a' });
  tick(10 * 60_000);
  assert.equal(cli.poll(ignored.deviceCode).status, 'expired');
  assert.equal(cli.waiting(ignored.userCode), null);

  const denied = cli.start({ name: 'b' });
  cli.decide({ code: denied.userCode, login: 'mia-dev', approve: false });
  assert.equal(cli.poll(denied.deviceCode).status, 'denied');

  const late = cli.start({ name: 'c' });
  cli.decide({ code: late.userCode, login: 'mia-dev', approve: true });
  people.delete('mia-dev');
  assert.equal(cli.poll(late.deviceCode).status, 'denied');
  assert.equal(cli.poll('not a code').status, 'expired');
});

test('each computer is a sign-in of its own, revoked alone or all together; a person keeps at most 20', () => {
  const { cli, tick } = signIn();
  const make = (login, name) => {
    const { deviceCode, userCode } = cli.start({ name });
    cli.decide({ code: userCode, login, approve: true });
    tick(1000);
    return cli.poll(deviceCode);
  };
  const laptop = make('mia-dev', 'laptop');
  const desktop = make('mia-dev', 'desktop');
  make('sam-ops', 'sam');
  assert.deepEqual(cli.list('mia-dev').map((t) => t.name), ['desktop', 'laptop'], 'newest first');
  assert.equal(cli.revoke('sam-ops', laptop.id), false, 'nobody revokes another person\'s');
  assert.equal(cli.revoke('mia-dev', laptop.id), true);
  assert.equal(cli.tokenFor({ authorization: `Bearer ${laptop.token}` }), null);
  assert.ok(cli.tokenFor({ authorization: `Bearer ${desktop.token}` }));
  const approved = cli.start({ name: 'not collected yet' });
  cli.decide({ code: approved.userCode, login: 'mia-dev', approve: true });
  cli.revokeAll('mia-dev', 'test');
  assert.deepEqual(cli.list('mia-dev'), []);
  assert.equal(cli.poll(approved.deviceCode).status, 'denied', 'an approval not collected yet goes with them');
  assert.equal(cli.list('sam-ops').length, 1);
  for (let i = 0; i < 21; i++) make('ana-k', `box ${i}`);
  const kept = cli.list('ana-k');
  assert.equal(kept.length, 20);
  assert.ok(!kept.some((t) => t.name === 'box 0'), 'the oldest ended');
});

test('a token\'s last use is written down at most once an hour', () => {
  const { cli, tick, saves } = signIn();
  const { deviceCode, userCode } = cli.start({ name: 'x' });
  cli.decide({ code: userCode, login: 'mia-dev', approve: true });
  const { token } = cli.poll(deviceCode);
  const before = saves();
  for (let i = 0; i < 5; i++) cli.tokenFor({ authorization: `Bearer ${token}` });
  assert.equal(saves(), before);
  tick(60 * 60_000);
  cli.tokenFor({ authorization: `Bearer ${token}` });
  assert.equal(saves(), before + 1);
  assert.equal(cli.list('mia-dev')[0].lastUsedAt, '2026-11-20T11:00:00.000Z');
});

test('a code is eight letters with no vowels, typed in any case, with or without its dash', () => {
  assert.equal(normalUserCode('bcdf ghjk'), 'BCDF-GHJK');
  assert.equal(normalUserCode('BCDF-GHJ'), null);
  assert.equal(normalUserCode('ABCD-EFGH'), null, 'never a vowel');
  assert.equal(normalUserCode(null), null);
});
