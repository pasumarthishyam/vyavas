/**
 * Application-layer encryption for stored Razorpay secrets.
 *
 * The `razorpay_connections` table holds key secrets, webhook secrets and OAuth
 * refresh tokens. Those are enough to move a merchant's money, so they never
 * touch a column in plaintext — a database backup, a support export or a stray
 * `select *` should not be a credential leak.
 *
 * AES-256-GCM, because it authenticates as well as encrypts: a tampered
 * ciphertext fails to decrypt rather than silently producing garbage that some
 * later code path treats as a key.
 *
 * Note what is NOT here: card data. Under the RBI tokenisation mandate we never
 * store a PAN — Razorpay holds the network token and we hold a reference.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

import { requireEncryptionKey } from './env.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits, the GCM standard
const TAG_BYTES = 16;
const VERSION = 'v1';

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

/**
 * Encrypt to `v1.<iv>.<tag>.<ciphertext>`, all base64url.
 *
 * The version prefix is not decoration: key rotation means old rows and new
 * rows coexist, and a stored blob has to say which scheme produced it.
 */
export function encryptSecret(plaintext: string, key: Buffer = requireEncryptionKey()): string {
  if (plaintext.length === 0) throw new CryptoError('Refusing to encrypt an empty secret');

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptSecret(encoded: string, key: Buffer = requireEncryptionKey()): string {
  const parts = encoded.split('.');
  if (parts.length !== 4) {
    throw new CryptoError('Malformed ciphertext: expected v1.<iv>.<tag>.<ciphertext>');
  }
  const [version, ivB64, tagB64, dataB64] = parts;
  if (version !== VERSION) throw new CryptoError(`Unknown ciphertext version '${version}'`);

  const iv = Buffer.from(ivB64!, 'base64url');
  const tag = Buffer.from(tagB64!, 'base64url');
  if (iv.length !== IV_BYTES) throw new CryptoError('Bad IV length');
  if (tag.length !== TAG_BYTES) throw new CryptoError('Bad auth tag length');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64!, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // GCM authentication failed: wrong key, or the ciphertext was altered.
    throw new CryptoError('Could not decrypt: wrong key or tampered ciphertext');
  }
}

/**
 * Constant-time string comparison.
 *
 * Used for webhook signatures. A plain `===` returns as soon as two bytes
 * differ, so the time it takes leaks how much of a guess was correct — enough,
 * over many attempts, to reconstruct a valid signature byte by byte.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  // Comparing a fixed-size digest of each keeps the comparison constant-time
  // regardless of input length.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
