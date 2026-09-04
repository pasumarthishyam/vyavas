/**
 * The session token and the password hash.
 *
 * These are the two things standing between a public URL and a console that can
 * message real customers, so the tests are mostly about what must FAIL: a
 * tampered payload, a forged signature, an expired token, a stale epoch, a
 * password that is nearly right.
 */

import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from '../../src/lib/password.js';
import { signSession, verifySession, type SessionPayload } from '../../src/lib/session.js';

const SECRET = 'a'.repeat(32);
const OTHER_SECRET = 'b'.repeat(32);

const payload = (over: Partial<SessionPayload> = {}): SessionPayload => ({
  uid: '11111111-1111-4111-8111-111111111111',
  epoch: '1',
  exp: Math.floor(Date.now() / 1000) + 3600,
  ...over,
});

describe('the session token', () => {
  it('round-trips a payload it signed itself', async () => {
    const p = payload();
    const verdict = await verifySession(await signSession(p, SECRET), SECRET);
    expect(verdict.valid).toBe(true);
    if (verdict.valid) {
      expect(verdict.payload.uid).toBe(p.uid);
      expect(verdict.payload.epoch).toBe('1');
    }
  });

  it('refuses a token signed with a different secret', async () => {
    // Rotating SESSION_SECRET is the documented way to sign everyone out, so
    // this is the behaviour that makes that true.
    const token = await signSession(payload(), OTHER_SECRET);
    const verdict = await verifySession(token, SECRET);
    expect(verdict).toEqual({ valid: false, reason: 'bad_signature' });
  });

  it('refuses a payload edited in place', async () => {
    // The attack this exists to stop: take your own valid token, swap the uid
    // for someone else's, keep the signature. The HMAC covers the payload, so
    // the signature no longer matches.
    const token = await signSession(payload(), SECRET);
    const [body, sig] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify(payload({ uid: '22222222-2222-4222-8222-222222222222' })),
      'utf8',
    ).toString('base64url');

    expect(body).not.toBe(forged);
    const verdict = await verifySession(`${forged}.${sig}`, SECRET);
    expect(verdict).toEqual({ valid: false, reason: 'bad_signature' });
  });

  it('refuses an expired token', async () => {
    const token = await signSession(payload({ exp: Math.floor(Date.now() / 1000) - 1 }), SECRET);
    const verdict = await verifySession(token, SECRET);
    expect(verdict).toEqual({ valid: false, reason: 'expired' });
  });

  it('refuses junk without throwing', async () => {
    // Every one of these is something an endpoint will actually be sent. A
    // throw here would be a 500 that tells an attacker they found an edge.
    for (const junk of ['', 'not-a-token', '.', 'a.', '.b', 'a.b', '!!!.???']) {
      const verdict = await verifySession(junk, SECRET);
      expect(verdict.valid).toBe(false);
    }
    expect((await verifySession(undefined, SECRET)).valid).toBe(false);
    expect((await verifySession(null, SECRET)).valid).toBe(false);
  });

  it('carries the epoch, so a session can be revoked without a session table', async () => {
    const token = await signSession(payload({ epoch: '4' }), SECRET);
    const verdict = await verifySession(token, SECRET);
    expect(verdict.valid).toBe(true);
    // `lib/auth.ts` compares this against the user's current epoch on every
    // request. The token stays cryptographically valid; the comparison is what
    // turns a password change into an immediate sign-out everywhere.
    if (verdict.valid) expect(verdict.payload.epoch).toBe('4');
  });
});

/*
 * These carry an explicit timeout, and the reason is the thing being tested.
 *
 * scrypt here is N = 2^15 over 32MB, which costs ~100ms per hash on an idle
 * machine and several times that when forty test files are competing for cores.
 * Vitest's default 5s budget is not enough for a handful of them under load, and
 * the right response is a longer budget rather than cheaper parameters — the
 * expense IS the defence for a stolen `users` table, and tuning it down to make
 * a test comfortable would quietly halve the work an attacker has to do.
 */
const SCRYPT_BUDGET_MS = 60_000;

describe('password hashing', () => {
  it(
    'accepts the right password and rejects a near miss',
    async () => {
      const stored = await hashPassword('correct horse battery');
      expect(await verifyPassword('correct horse battery', stored)).toBe(true);
      expect(await verifyPassword('correct horse batterY', stored)).toBe(false);
      expect(await verifyPassword('correct horse batter', stored)).toBe(false);
      expect(await verifyPassword('', stored)).toBe(false);
    },
    SCRYPT_BUDGET_MS,
  );

  it(
    'salts, so two identical passwords do not share a hash',
    async () => {
      const a = await hashPassword('correct horse battery');
      const b = await hashPassword('correct horse battery');
      expect(a).not.toBe(b);
      // Both still verify — the salt is stored in the string, not alongside it.
      expect(await verifyPassword('correct horse battery', a)).toBe(true);
      expect(await verifyPassword('correct horse battery', b)).toBe(true);
    },
    SCRYPT_BUDGET_MS,
  );

  it('records the parameters it used, so they can be raised later', async () => {
    const stored = await hashPassword('correct horse battery');
    const [scheme, n, r, p] = stored.split('$');
    expect(scheme).toBe('scrypt');
    // If these ever silently become Node's defaults (N = 16384), the work an
    // attacker has to do halves and nothing else would say so.
    expect(n).toBe('32768');
    expect(r).toBe('8');
    expect(p).toBe('1');
  });

  it('refuses a short password at the point it is set', async () => {
    await expect(hashPassword('short')).rejects.toThrow('at least 12');
  });

  it('returns false on a malformed stored hash rather than throwing', async () => {
    for (const bad of ['', 'garbage', 'scrypt$1$2$3', 'bcrypt$32768$8$1$aa$bb', 'scrypt$x$8$1$aa$bb']) {
      expect(await verifyPassword('correct horse battery', bad)).toBe(false);
    }
  });
});
