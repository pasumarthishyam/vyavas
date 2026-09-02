import { NextResponse } from 'next/server';

import { getDb } from '../../../../db/client';
import { regenerateAbandonedCartApiKey } from '../../../../db/repos/abandoned-cart-auth';
import { currentMerchantId } from '../../../../lib/merchant-context';

/**
 * Issue (or replace) the key a merchant's own application presents to the
 * abandoned-cart webhook. Dashboard-authenticated — this is a settings action
 * on the current merchant, same as everything else gated by `currentMerchantId`.
 *
 * Replacing an existing key immediately invalidates it: any storefront still
 * calling the webhook with the old value starts getting 401s the moment this
 * runs. Deliberate — a "regenerate" a merchant reaches for is almost always
 * because the old one leaked.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function POST(): Promise<NextResponse> {
  const db = getDb();
  const merchantId = await currentMerchantId(db);
  if (!merchantId) {
    return NextResponse.json({ ok: false, reason: 'no merchant' }, { status: 404 });
  }

  const key = await regenerateAbandonedCartApiKey(db, merchantId);
  return NextResponse.json({ ok: true, apiKey: key });
}
