import { NextResponse } from 'next/server';

import { getDb } from '../../../../db/client';
import { currentUser } from '../../../../lib/auth';
import { listMerchantsForUser } from '../../../../lib/merchant-context';

/**
 * The live/paused status of every merchant this user can see.
 *
 * Exists for exactly one reader: the sidebar's account switcher. It renders
 * `mode` and `isLive` from a server-rendered `MerchantSelection` that is only
 * as fresh as the last full navigation — so a merchant paused from another
 * tab, another device, or another teammate's session stayed "Live" in this
 * one until something forced a reload. This is what the switcher polls
 * instead, so the badge is never more than a few seconds stale.
 *
 * Same access rule as everywhere else this data is read: `listMerchantsForUser`
 * joins through `merchant_members`, so this can only ever answer with accounts
 * the signed-in user actually belongs to.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const db = getDb();
  const user = await currentUser(db);
  if (!user) {
    return NextResponse.json({ ok: false, reason: 'not signed in' }, { status: 401 });
  }

  const merchants = await listMerchantsForUser(db, user.id);
  return NextResponse.json({ ok: true, merchants });
}
