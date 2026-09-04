/**
 * Who is making this request.
 *
 * The middleware has already turned away anything without a validly signed
 * token, so by the time a page or an API route calls `currentUser` the
 * signature is known good. What is left is everything a signature cannot tell
 * you, and all three need the database:
 *
 *   - the user still exists
 *   - the user is not disabled
 *   - the token was issued under the CURRENT session epoch
 *
 * That last one is what makes a stateless token revocable. Changing a password
 * bumps the epoch, and every token issued before it stops working on the next
 * request rather than at its own expiry.
 *
 * Node only — imports `node:crypto` through the password module's siblings and
 * reads cookies through `next/headers`.
 */

import { cookies } from 'next/headers';
import { and, eq, isNull, sql } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { merchantMembers, users } from '../db/schema/auth.js';
import { requireSessionSecret } from './env.js';
import { SESSION_COOKIE, verifySession } from './session.js';

export interface CurrentUser {
  id: string;
  email: string;
  name: string | null;
}

/**
 * The signed-in user, or null.
 *
 * Null is not an error here — a caller that requires a user says so by calling
 * `requireUser`, and the layout uses the nullable form to render the shell for
 * the login page.
 */
export async function currentUser(db: Database): Promise<CurrentUser | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  let secret: string;
  try {
    secret = requireSessionSecret();
  } catch {
    // No secret configured means no session can be trusted. Failing closed is
    // the only safe reading: a missing secret must never mean "let everyone in".
    return null;
  }

  const verdict = await verifySession(token, secret);
  if (!verdict.valid) return null;

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      epoch: users.sessionEpoch,
    })
    .from(users)
    .where(and(eq(users.id, verdict.payload.uid), isNull(users.disabledAt)))
    .limit(1);

  const row = rows.at(0);
  if (!row) return null;

  // The revocation check. A token naming a stale epoch is refused even though
  // its signature is perfectly good.
  if (row.epoch !== verdict.payload.epoch) return null;

  return { id: row.id, email: row.email, name: row.name };
}

export class UnauthenticatedError extends Error {
  constructor() {
    super('Not signed in.');
    this.name = 'UnauthenticatedError';
  }
}

export async function requireUser(db: Database): Promise<CurrentUser> {
  const user = await currentUser(db);
  if (!user) throw new UnauthenticatedError();
  return user;
}

/**
 * Is this user allowed to act on this merchant?
 *
 * Every API route that reads or mutates merchant-scoped data goes through this
 * or through `currentMerchantId`, which is built on it. The merchant is chosen
 * by a cookie the browser controls, so "the selected merchant" is a request for
 * access, never a grant of it.
 */
export async function userCanAccessMerchant(
  db: Database,
  userId: string,
  merchantId: string,
): Promise<boolean> {
  const rows = await db
    .select({ role: merchantMembers.role })
    .from(merchantMembers)
    .where(and(eq(merchantMembers.userId, userId), eq(merchantMembers.merchantId, merchantId)))
    .limit(1);
  return rows.length > 0;
}

/** Every merchant id this user may act on. */
export async function merchantIdsFor(db: Database, userId: string): Promise<string[]> {
  const rows = await db
    .select({ merchantId: merchantMembers.merchantId })
    .from(merchantMembers)
    .where(eq(merchantMembers.userId, userId));
  return rows.map((r) => r.merchantId);
}

/**
 * Invalidate every session this user holds.
 *
 * Called after a password change. The epoch is text rather than a number
 * because it only ever needs to CHANGE, never to be compared for order, and a
 * text column cannot overflow or wrap.
 */
export async function bumpSessionEpoch(db: Database, userId: string): Promise<void> {
  await db
    .update(users)
    .set({ sessionEpoch: sql`(${users.sessionEpoch}::bigint + 1)::text`, updatedAt: sql`now()` })
    .where(eq(users.id, userId));
}
