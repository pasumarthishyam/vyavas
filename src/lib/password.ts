/**
 * Password hashing.
 *
 * scrypt, from `node:crypto`. Node only — never import this from anything the
 * Edge middleware reaches.
 *
 * The choice matters more than it looks. A password is low-entropy by nature,
 * so the only real defence for a stolen `users` table is that each guess is
 * expensive. A fast digest (SHA-256, or worse an unsalted one) is brute-forced
 * offline at billions of guesses per second; scrypt is deliberately slow AND
 * memory-hard, which is what defeats the GPU and ASIC arrays that make those
 * numbers possible.
 *
 * The parameters travel with the hash rather than living as constants here, so
 * they can be raised later without invalidating every password already stored:
 * a stored hash says how it was made, and `verifyPassword` reads it back.
 */

import { randomBytes, scrypt, type ScryptOptions, timingSafeEqual } from 'node:crypto';

/**
 * Wrapped by hand rather than with `promisify`.
 *
 * `promisify` picks the first overload of `scrypt`, which is the three-argument
 * one with no options — so the parameters below would be silently dropped and
 * every hash would use Node's defaults (N = 16384) instead of the ones written
 * here and recorded in the stored string. It typechecks, runs, and quietly
 * halves the work an attacker has to do.
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

/**
 * N = 2^15, r = 8, p = 1 — roughly 32MB and ~100ms per hash on a normal
 * machine. The memory figure is the important half: it is what makes parallel
 * cracking expensive rather than merely slow.
 */
const N = 32_768;
const R = 8;
const P = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 16;

/**
 * scrypt's default maxmem (32MB) is not enough for N = 2^15 and it throws.
 * Raised explicitly rather than lowering N, because N is the security
 * parameter and maxmem is only a guard rail against accidental allocation.
 */
const MAX_MEM = 64 * 1024 * 1024;

export async function hashPassword(plaintext: string): Promise<string> {
  if (plaintext.length < 12) {
    // Refused here rather than in the UI, because this function is also what
    // the admin CLI calls and a weak password set from a terminal is exactly
    // as weak as one set from a form.
    throw new Error('Password must be at least 12 characters.');
  }

  const salt = randomBytes(SALT_BYTES);
  const hash = (await scryptAsync(plaintext.normalize('NFKC'), salt, KEY_BYTES, {
    N,
    r: R,
    p: P,
    maxmem: MAX_MEM,
  }));

  return [
    'scrypt',
    N,
    R,
    P,
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join('$');
}

/**
 * Check a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed stored value: a row we
 * cannot parse must fail the login, not crash the endpoint into a 500 that
 * tells an attacker they found something interesting.
 */
export async function verifyPassword(plaintext: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // A hostile or corrupted row must not be able to ask for an allocation that
  // takes the process down.
  if (n > 1 << 20 || r > 32 || p > 16) return false;

  try {
    const salt = Buffer.from(parts[4]!, 'base64url');
    const expected = Buffer.from(parts[5]!, 'base64url');
    const actual = (await scryptAsync(plaintext.normalize('NFKC'), salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: MAX_MEM,
    }));

    // Constant time: a plain === returns as soon as two bytes differ.
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
