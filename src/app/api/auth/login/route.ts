import { NextResponse } from 'next/server';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { getDb } from '../../../../db/client';
import { users } from '../../../../db/schema/auth';
import { verifyPassword } from '../../../../lib/password';
import { requireSessionSecret } from '../../../../lib/env';
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  sessionCookieOptions,
  signSession,
} from '../../../../lib/session';

/**
 * Sign in.
 *
 * Three things here are deliberate and are the parts worth not "simplifying"
 * later:
 *
 *  1. **One error message for every failure.** Unknown email, wrong password
 *     and disabled account all answer "Email or password is incorrect."
 *     Distinguishing them turns this endpoint into a way to enumerate who has
 *     an account.
 *
 *  2. **The password is verified even when the user does not exist.** scrypt
 *     takes ~100ms; skipping it on an unknown email makes that request
 *     measurably faster, and the difference is the same enumeration oracle by
 *     another route. The dummy hash below exists to burn the identical time.
 *
 *  3. **A fresh cookie on every success.** The session is stateless, so signing
 *     in is the only moment the epoch is read; a token issued now is valid
 *     until it expires or the epoch moves.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

/**
 * A real scrypt hash of a value nobody knows, verified against when the email
 * does not exist so the timing of the two paths matches. The parameters must
 * stay in step with `hashPassword` or the timing diverges again.
 */
const DUMMY_HASH =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$' +
  'Ic0lCC5N8P4mDLQ0RCbKQKA3xJ6QW2iSPvxNS5xjJ9E';

const GENERIC = 'Email or password is incorrect.';

export async function POST(request: Request): Promise<NextResponse> {
  let secret: string;
  try {
    secret = requireSessionSecret();
  } catch (e) {
    return NextResponse.json(
      { ok: false, reason: e instanceof Error ? e.message : 'SESSION_SECRET is not set' },
      { status: 503 },
    );
  }

  const body = (await request.json().catch(() => null)) as
    | { email?: unknown; password?: unknown }
    | null;

  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';

  if (email.length === 0 || password.length === 0) {
    return NextResponse.json({ ok: false, reason: GENERIC }, { status: 401 });
  }

  const db = getDb();
  const rows = await db
    .select({
      id: users.id,
      passwordHash: users.passwordHash,
      sessionEpoch: users.sessionEpoch,
    })
    .from(users)
    .where(and(eq(users.email, email), isNull(users.disabledAt)))
    .limit(1);

  const row = rows.at(0);

  // Always hash. See (2) above — an early return here is a timing oracle.
  const matched = await verifyPassword(password, row?.passwordHash ?? DUMMY_HASH);

  if (!row || !matched) {
    return NextResponse.json({ ok: false, reason: GENERIC }, { status: 401 });
  }

  const token = await signSession(
    {
      uid: row.id,
      epoch: row.sessionEpoch,
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    },
    secret,
  );

  await db.update(users).set({ lastLoginAt: sql`now()` }).where(eq(users.id, row.id));

  const response = NextResponse.json({ ok: true });
  response.cookies.set(
    SESSION_COOKIE,
    token,
    // `secure` follows the scheme rather than NODE_ENV: local development runs
    // on http, and a Secure cookie there is simply never sent, which looks
    // exactly like a broken login.
    sessionCookieOptions(new URL(request.url).protocol === 'https:'),
  );
  return response;
}
