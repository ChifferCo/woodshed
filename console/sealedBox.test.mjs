import { test } from 'node:test';
import assert from 'node:assert/strict';

import { blake2b, openSealedBox, sealedBox, x25519PublicKey } from './sealedBox.mjs';

const bytes = (n) => Buffer.from(Array.from({ length: n }, (_, i) => i));

test('BLAKE2b with a 24-byte output is Python hashlib.blake2b(digest_size=24)\'s', () => {
  assert.equal(blake2b(Buffer.alloc(0), 24).toString('hex'), 'ab3b5331a7135ed50d0f182d026e60abdb3646fd51bcf8a3');
  assert.equal(blake2b(Buffer.from('abc'), 24).toString('hex'), '56a17e38cc371a46b12c32f18e0c61de2a84e9c2555b114e');
  assert.equal(blake2b(bytes(64), 24).toString('hex'), 'aa054507b4916837a6d2b35b1ce7c525facdb7868ed55a8a');
  assert.equal(blake2b(bytes(200), 24).toString('hex'), 'e9183c766451ac26ddd03b280b4b6000802b4b7230c78bb3', 'over one block');
});

test('a sealed box with a fixed ephemeral key is the one tweetnacl makes, and opens again', () => {
  const recipientSecret = Buffer.alloc(32, 7);
  const recipient = x25519PublicKey(recipientSecret);
  assert.equal(recipient.toString('base64'), 'E75P6uryBMf9M1j8nAByGIHRdCeBKCJ+xnTzf3/pe20=', 'tweetnacl\'s scalarMult.base');
  const sealed = sealedBox('sk-ant-api03-example', recipient, { ephemeralSecretKey: Buffer.alloc(32, 9) });
  // epk || nacl.box(message, blake2b24(epk || pk), pk, esk), from tweetnacl 1.0.3.
  assert.equal(sealed.toString('base64'), 'V9tLNZ8jrl4Ubk4lEgVnBHIlBjSMFQwUdT0Mkz0E1CHU3WIeYk44fnlT2Yt4r+e1UPreWpvrE/Fow/NsX4wGb9vqOjk=');
  assert.equal(openSealedBox(sealed, recipient, recipientSecret).toString(), 'sk-ant-api03-example');
});

test('each seal uses a new ephemeral key, a long value survives, and a changed byte does not open', () => {
  const recipientSecret = Buffer.alloc(32, 3);
  const recipient = x25519PublicKey(recipientSecret);
  const value = 'k'.repeat(300);
  const a = sealedBox(value, recipient);
  const b = sealedBox(value, recipient);
  assert.notDeepEqual(a, b);
  assert.equal(a.length, 32 + 16 + 300);
  assert.equal(openSealedBox(a, recipient, recipientSecret).toString(), value);
  a[a.length - 1] ^= 1;
  assert.equal(openSealedBox(a, recipient, recipientSecret), null);
  assert.throws(() => sealedBox('x', Buffer.alloc(31)), /32 bytes/);
});
