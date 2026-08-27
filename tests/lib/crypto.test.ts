import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';

import { CryptoError, decryptSecret, encryptSecret, safeEqual } from '@lib/crypto.js';

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a Razorpay key secret', () => {
    const secret = 'LQ5eXqP7gK2mN8vB4rT6wY1z';
    expect(decryptSecret(encryptSecret(secret, KEY), KEY)).toBe(secret);
  });

  it('produces different ciphertext each time', () => {
    // A fresh IV per encryption. Identical ciphertexts would leak that two
    // merchants share a key secret.
    const a = encryptSecret('same-secret', KEY);
    const b = encryptSecret('same-secret', KEY);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, KEY)).toBe(decryptSecret(b, KEY));
  });

  it('carries a version prefix so keys can be rotated', () => {
    // Rotation means old and new rows coexist; a blob has to say which scheme
    // produced it.
    expect(encryptSecret('x', KEY).startsWith('v1.')).toBe(true);
  });

  it('refuses the wrong key rather than returning garbage', () => {
    const blob = encryptSecret('secret', KEY);
    expect(() => decryptSecret(blob, OTHER_KEY)).toThrow(CryptoError);
  });

  it('detects tampering', () => {
    // GCM authenticates as well as encrypts: an altered ciphertext fails to
    // decrypt rather than silently producing bytes some later code treats as
    // a key.
    const blob = encryptSecret('secret-value-here', KEY);
    const parts = blob.split('.');
    const flipped = Buffer.from(parts[3]!, 'base64url');
    flipped[0] = flipped[0]! ^ 0xff;
    parts[3] = flipped.toString('base64url');
    expect(() => decryptSecret(parts.join('.'), KEY)).toThrow(/tampered/);
  });

  it('rejects malformed input', () => {
    expect(() => decryptSecret('not-a-blob', KEY)).toThrow(CryptoError);
    expect(() => decryptSecret('v2.a.b.c', KEY)).toThrow(/version/);
    expect(() => decryptSecret('v1.short.tag.data', KEY)).toThrow(/IV length/);
  });

  it('refuses to encrypt nothing', () => {
    expect(() => encryptSecret('', KEY)).toThrow(CryptoError);
  });

  it('handles unicode and long values', () => {
    const long = 'ठीक है '.repeat(500);
    expect(decryptSecret(encryptSecret(long, KEY), KEY)).toBe(long);
  });
});

describe('safeEqual', () => {
  it('compares equal strings', () => {
    expect(safeEqual('abc123', 'abc123')).toBe(true);
  });

  it('rejects different strings and different lengths', () => {
    expect(safeEqual('abc123', 'abc124')).toBe(false);
    expect(safeEqual('abc', 'abcdef')).toBe(false);
    expect(safeEqual('', 'a')).toBe(false);
  });

  it('handles the empty case', () => {
    expect(safeEqual('', '')).toBe(true);
  });
});
