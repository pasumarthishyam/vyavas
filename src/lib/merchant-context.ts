/**
 * Which merchant the UI is looking at.
 *
 * Held in a cookie rather than a URL segment: every page and every API route
 * needs it, and threading `/m/[slug]/...` through the whole app would rewrite
 * every link for a value that changes about twice a day.
 *
 * Two rules, and the first one is load-bearing:
 *
 * **The cookie is a REQUEST, never a grant.** It is set by the browser, so it
 * is attacker-controlled by definition. Every function here resolves the signed-
 * in user first and only ever considers merchants that user is a member of; an
 * unrecognised slug falls back to the first merchant they can see, not to the
 * one they asked for. Before authentication existed this file trusted the
 * cookie outright, which was academic only because there was nothing to trust
 * it against.
 *
 * **A missing or unrecognised selection falls back to the first merchant, never
 * to "all merchants".** A dashboard that silently aggregates two accounts would
 * show one number for a live business and a sandbox, and a recovery started
 * from that view would be ambiguous about whose customers it was about to
 * message.
 */

import { cookies } from 'next/headers';
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { merchantMembers } from '../db/schema/auth.js';
import { merchants } from '../db/schema/tenancy.js';
import { currentUser } from './auth.js';

export const MERCHANT_COOKIE = 'vyavas_merchant';

export interface MerchantOption {
  id: string;
  slug: string;
  name: string;
  /** paused | live — shown on the switcher so the mode is never a guess. */
  mode: 'paused' | 'live';
  /** True when this account's keys move real money. */
  isLive: boolean;
}

export interface MerchantSelection {
  current: MerchantOption;
  all: MerchantOption[];
}

/**
 * Every merchant THIS USER may act on, ordered stably, with the mode each is
 * running in.
 *
 * The join to `merchant_members` is the access check. There is deliberately no
 * variant of this function that lists every merchant in the database — a
 * caller that wanted one would be one refactor away from rendering another
 * tenant's cases.
 */
export async function listMerchantsForUser(
  db: Database,
  userId: string,
): Promise<MerchantOption[]> {
  const rows = await db
    .select({
      id: merchants.id,
      slug: merchants.slug,
      name: merchants.name,
      executionEnabled: merchants.executionEnabled,
      whatsappRedirectTo: merchants.whatsappRedirectTo,
      emailRedirectTo: merchants.emailRedirectTo,
    })
    .from(merchants)
    .innerJoin(merchantMembers, eq(merchantMembers.merchantId, merchants.id))
    .where(and(eq(merchantMembers.userId, userId), sql`${merchants.deletedAt} is null`))
    .orderBy(merchants.createdAt);

  return rows.map((m) => ({
    id: m.id,
    slug: m.slug,
    name: m.name,
    mode: m.executionEnabled ? ('live' as const) : ('paused' as const),
    // Read from the routing rather than from the key: what makes an account
    // dangerous is whether its messages reach real people, and a live key with
    // everything diverted is safer than a test key with nothing diverted.
    isLive: m.whatsappRedirectTo === null || m.emailRedirectTo === null,
  }));
}

/**
 * The selected merchant, resolved from the cookie and filtered by membership.
 *
 * Returns null when nobody is signed in, or when the signed-in user is a member
 * of no merchant at all — the caller renders the empty state for that.
 */
export async function selectMerchant(db: Database): Promise<MerchantSelection | null> {
  const user = await currentUser(db);
  if (!user) return null;

  const all = await listMerchantsForUser(db, user.id);
  if (all.length === 0) return null;

  const jar = await cookies();
  const slug = jar.get(MERCHANT_COOKIE)?.value;

  // `all` already excludes anything this user may not see, so a cookie naming
  // someone else's merchant simply does not match and falls through.
  const current = all.find((m) => m.slug === slug) ?? all[0]!;
  return { current, all };
}

/**
 * The selected merchant for an API route.
 *
 * Same resolution, no `all` list. Routes that mutate — starting a recovery,
 * changing the send mode — must use this rather than "the first merchant", or a
 * click on the Sandbox page would change the live account's settings.
 *
 * Null means "not signed in, or no accessible merchant", and every caller
 * already turns that into a 404. The middleware has normally answered 401 long
 * before this is reached; this is the second gate, and it is the one that knows
 * about membership.
 */
export async function currentMerchantId(db: Database): Promise<string | null> {
  const selection = await selectMerchant(db);
  return selection?.current.id ?? null;
}

/**
 * Assert that the signed-in user may act on a specific merchant id.
 *
 * For the routes that take a merchant from somewhere other than the cookie.
 */
export async function assertMerchantAccess(
  db: Database,
  merchantId: string,
): Promise<boolean> {
  const user = await currentUser(db);
  if (!user) return false;
  const rows = await db
    .select({ merchantId: merchantMembers.merchantId })
    .from(merchantMembers)
    .where(
      and(eq(merchantMembers.userId, user.id), inArray(merchantMembers.merchantId, [merchantId])),
    )
    .limit(1);
  return rows.length > 0;
}
