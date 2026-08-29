/**
 * Which merchant the UI is looking at.
 *
 * Held in a cookie rather than a URL segment: every page and every API route
 * needs it, and threading `/m/[slug]/...` through the whole app would rewrite
 * every link for a value that changes about twice a day.
 *
 * The rule that matters: **an unrecognised or missing selection falls back to
 * the first merchant, never to "all merchants"**. A dashboard that silently
 * aggregates two accounts would show one number for a live business and a
 * sandbox, and a recovery started from that view would be ambiguous about whose
 * customers it was about to message.
 */

import { cookies } from 'next/headers';
import { sql } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { merchants } from '../db/schema/tenancy.js';

export const MERCHANT_COOKIE = 'vyavas_merchant';

export interface MerchantOption {
  id: string;
  slug: string;
  name: string;
  /** off | dry_run | live — shown on the switcher so the mode is never a guess. */
  mode: 'off' | 'dry_run' | 'live';
  /** True when this account's keys move real money. */
  isLive: boolean;
}

export interface MerchantSelection {
  current: MerchantOption;
  all: MerchantOption[];
}

/** Every merchant, ordered stably, with the mode each is running in. */
export async function listMerchants(db: Database): Promise<MerchantOption[]> {
  const rows = await db
    .select()
    .from(merchants)
    .where(sql`${merchants.deletedAt} is null`)
    .orderBy(merchants.createdAt);

  return rows.map((m) => ({
    id: m.id,
    slug: m.slug,
    name: m.name,
    mode: !m.executionEnabled ? ('off' as const) : m.dryRun ? ('dry_run' as const) : ('live' as const),
    // Read from the routing rather than from the key: what makes an account
    // dangerous is whether its messages reach real people, and a live key with
    // everything diverted is safer than a test key with nothing diverted.
    isLive: m.whatsappRedirectTo === null || m.emailRedirectTo === null,
  }));
}

/**
 * The selected merchant, resolved from the cookie.
 *
 * Returns null only when there are no merchants at all — the caller renders the
 * empty state for that.
 */
export async function selectMerchant(db: Database): Promise<MerchantSelection | null> {
  const all = await listMerchants(db);
  if (all.length === 0) return null;

  const jar = await cookies();
  const slug = jar.get(MERCHANT_COOKIE)?.value;

  const current = all.find((m) => m.slug === slug) ?? all[0]!;
  return { current, all };
}

/**
 * The selected merchant for an API route.
 *
 * Same resolution, no `all` list. Routes that mutate — starting a recovery,
 * changing the send mode — must use this rather than "the first merchant", or a
 * click on the Sandbox page would change the live account's settings.
 */
export async function currentMerchantId(db: Database): Promise<string | null> {
  const selection = await selectMerchant(db);
  return selection?.current.id ?? null;
}
