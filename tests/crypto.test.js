const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/crypto.js');

test('passphrase setup, encrypt while "locked", unlock, decrypt', async () => {
  const { publicJwk, wrappedPrivate } = await C.setupPassphrase('correct horse');
  // Encrypting needs only the public key.
  const blob = await C.encryptString(publicJwk, 'the quick brown fox 🦊');
  assert.ok(blob.k && blob.iv && blob.ct);

  await assert.rejects(C.unlockPrivateKey('wrong horse', wrappedPrivate), (err) => err.name === 'OperationError');

  const priv = await C.unlockPrivateKey('correct horse', wrappedPrivate);
  assert.equal(await C.decryptString(priv, blob), 'the quick brown fox 🦊');

  // Round-trip through JWK (what chrome.storage.session holds).
  const again = await C.importPrivateJwk(await C.exportPrivateJwk(priv));
  assert.equal(await C.decryptString(again, blob), 'the quick brown fox 🦊');

  // Rewrap under a new passphrase; old entries still decrypt.
  const rewrapped = await C.rewrapPrivateKey(priv, 'new pass');
  await assert.rejects(C.unlockPrivateKey('correct horse', rewrapped));
  const priv2 = await C.unlockPrivateKey('new pass', rewrapped);
  assert.equal(await C.decryptString(priv2, blob), 'the quick brown fox 🦊');
});

test('tampered ciphertext fails loudly', async () => {
  const { publicJwk, wrappedPrivate } = await C.setupPassphrase('pass123');
  const blob = await C.encryptString(publicJwk, 'hello');
  const priv = await C.unlockPrivateKey('pass123', wrappedPrivate);
  const bad = Object.assign({}, blob, { ct: blob.ct.slice(0, -4) + 'AAAA' });
  await assert.rejects(C.decryptString(priv, bad));
});

test('large payload', async () => {
  const { publicJwk, wrappedPrivate } = await C.setupPassphrase('pass123');
  const big = 'x'.repeat(300_000);
  const blob = await C.encryptString(publicJwk, big);
  const priv = await C.unlockPrivateKey('pass123', wrappedPrivate);
  assert.equal((await C.decryptString(priv, blob)).length, 300_000);
});
