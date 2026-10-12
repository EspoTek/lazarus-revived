/*
 * Hybrid encryption, the same shape the original Lazarus used:
 *
 *   - An RSA-OAEP key pair is generated when the user sets a passphrase.
 *   - The PUBLIC key is stored in the clear, so entries can be encrypted and
 *     saved at any time, even while the store is locked.
 *   - The PRIVATE key is wrapped with an AES-GCM key derived from the
 *     passphrase (PBKDF2-SHA256). Reading an entry needs the passphrase.
 *   - Each entry gets a fresh AES-GCM-256 key; that key is wrapped with the
 *     RSA public key and stored next to the ciphertext.
 *
 * Classic script: exposes globalThis.LazarusCrypto, plus module.exports for Node.
 */
(function (root) {
  'use strict';

  const subtle = root.crypto.subtle;
  const PBKDF2_ITERATIONS = 310000;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function b64(bytes) {
    let s = '';
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < u8.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  function unb64(s) {
    const bin = atob(s);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  function randomBytes(n) {
    const u8 = new Uint8Array(n);
    root.crypto.getRandomValues(u8);
    return u8;
  }

  async function deriveKek(passphrase, salt) {
    const base = await subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function wrapPrivateKey(privateKey, passphrase) {
    const pkcs8 = await subtle.exportKey('pkcs8', privateKey);
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const kek = await deriveKek(passphrase, salt);
    const data = await subtle.encrypt({ name: 'AES-GCM', iv }, kek, pkcs8);
    return { salt: b64(salt), iv: b64(iv), data: b64(data), iterations: PBKDF2_ITERATIONS };
  }

  // Creates a new key pair protected by `passphrase`.
  // Returns { publicJwk, wrappedPrivate } for storage.
  async function setupPassphrase(passphrase) {
    const pair = await subtle.generateKey(
      { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['wrapKey', 'unwrapKey']
    );
    const publicJwk = await subtle.exportKey('jwk', pair.publicKey);
    const wrappedPrivate = await wrapPrivateKey(pair.privateKey, passphrase);
    return { publicJwk, wrappedPrivate };
  }

  // Throws (OperationError) if the passphrase is wrong.
  async function unlockPrivateKey(passphrase, wrappedPrivate) {
    const kek = await deriveKek(passphrase, unb64(wrappedPrivate.salt));
    const pkcs8 = await subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(wrappedPrivate.iv) },
      kek,
      unb64(wrappedPrivate.data)
    );
    return subtle.importKey('pkcs8', pkcs8, { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['unwrapKey']);
  }

  // Re-wrap an unlocked private key under a new passphrase.
  async function rewrapPrivateKey(privateKey, newPassphrase) {
    return wrapPrivateKey(privateKey, newPassphrase);
  }

  async function exportPrivateJwk(privateKey) {
    return subtle.exportKey('jwk', privateKey);
  }

  async function importPrivateJwk(jwk) {
    return subtle.importKey('jwk', jwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['unwrapKey']);
  }

  async function importPublicJwk(jwk) {
    return subtle.importKey('jwk', jwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['wrapKey']);
  }

  // Encrypt a string with a fresh AES key wrapped to the RSA public key.
  async function encryptString(publicJwk, plaintext) {
    const pub = await importPublicJwk(publicJwk);
    const dek = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const iv = randomBytes(12);
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, dek, enc.encode(plaintext));
    const wrappedDek = await subtle.wrapKey('raw', dek, pub, { name: 'RSA-OAEP' });
    return { k: b64(wrappedDek), iv: b64(iv), ct: b64(ct) };
  }

  async function decryptString(privateKey, blob) {
    const dek = await subtle.unwrapKey(
      'raw', unb64(blob.k), privateKey, { name: 'RSA-OAEP' },
      { name: 'AES-GCM', length: 256 }, false, ['decrypt']
    );
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv) }, dek, unb64(blob.ct));
    return dec.decode(pt);
  }

  const api = {
    setupPassphrase,
    unlockPrivateKey,
    rewrapPrivateKey,
    exportPrivateJwk,
    importPrivateJwk,
    encryptString,
    decryptString
  };

  root.LazarusCrypto = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
