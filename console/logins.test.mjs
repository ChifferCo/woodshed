import test from 'node:test';
import assert from 'node:assert/strict';
import logins from './public/logins.cjs';

const { loginKey, sameLogin, findLogin, uniqueLogins } = logins;

test('one handle in two spellings is one login', () => {
  assert.equal(loginKey('Octocat'), 'octocat');
  assert.equal(sameLogin('Octocat', 'octocat'), true);
  assert.equal(sameLogin('Octocat', 'other'), false);
  assert.equal(sameLogin(null, null), false, 'nobody is not somebody');
});

test('findLogin gives the spelling the list has, and uniqueLogins keeps the first spelling', () => {
  assert.equal(findLogin(['Octocat', 'anh'], 'octocat'), 'Octocat');
  assert.equal(findLogin(['anh'], 'octocat'), null);
  assert.equal(findLogin(['anh'], null), null);
  assert.deepEqual(uniqueLogins(['octocat', 'Octocat', null, 'anh']), ['octocat', 'anh']);
});
