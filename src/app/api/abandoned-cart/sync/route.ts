import { NextResponse } from 'next/server';

import { getDb } from '../../../../db/client';
import { listPendingAbandonedCartsForMerchant, markCartExpired, markCartRecovered } from '../../../../db/repos/abandoned-carts';
import { currentMerchantId } from '../../../../lib/merchant-context';
import { razorpayForMerchant } from '../../../../workflows/merchant-clients';
import { fetchPaymentLink } from '../../../../adapters/razorpay/resources';

/**
 * Check every emailed-but-unconfirmed cart against Razorpay directly.
 *
 * Same reasoning as `/api/voice-agent/sync`: this agent's payment links are
 * never resolved by the shared `payment_link.paid` webhook (there is no
 * original order id for it to match), so something has to ask Razorpay. This
 * is the on-demand version the dashboard's "Sync now" button calls; the
 * Inngest cron (`sweep-abandoned-carts`) is the same check running on a
 * schedule across every merchant.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(): Promise<NextResponse> {
  const db = getDb();
  const merchantId = await currentMerchantId(db);
  if (!merchantId) {
    return NextResponse.json({ ok: false, reason: 'no merchant' }, { status: 404 });
  }

  const razorpay = await razorpayForMerchant(db, merchantId);
  if (!razorpay) {
    return NextResponse.json({ ok: false, reason: 'no payment provider configured' }, { status: 502 });
  }

  const pending = await listPendingAbandonedCartsForMerchant(db, merchantId);

  let recovered = 0;
  let expired = 0;
  const errors: string[] = [];

  for (const row of pending) {
    try {
      if (!row.paymentLinkId) continue;
      const link = await fetchPaymentLink(razorpay, row.paymentLinkId);

      if (link.status === 'paid') {
        await markCartRecovered(db, row.id);
        recovered++;
        continue;
      }

      if (row.paymentLinkExpiresAt && row.paymentLinkExpiresAt.getTime() < Date.now()) {
        await markCartExpired(db, row.id);
        expired++;
      }
    } catch (e) {
      errors.push(`${row.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return NextResponse.json({ ok: true, checked: pending.length, recovered, expired, errors });
}
