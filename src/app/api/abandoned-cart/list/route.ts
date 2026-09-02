import { NextResponse } from 'next/server';

import { getDb } from '../../../../db/client';
import { getRecentAbandonedCarts } from '../../../../db/queries/abandoned-cart-agent';
import { currentMerchantId } from '../../../../lib/merchant-context';

/** What the dashboard's cart history table re-fetches after a sync or a test send. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function GET(request: Request): Promise<NextResponse> {
  const db = getDb();
  const merchantId = await currentMerchantId(db);
  if (!merchantId) {
    return NextResponse.json({ ok: false, reason: 'no merchant' }, { status: 404 });
  }

  const url = new URL(request.url);
  const limit = Number(url.searchParams.get('limit') ?? '50');

  const carts = await getRecentAbandonedCarts(db, merchantId, Number.isFinite(limit) ? limit : 50);
  return NextResponse.json({ ok: true, carts });
}
