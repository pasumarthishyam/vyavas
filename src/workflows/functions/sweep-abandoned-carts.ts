/**
 * The abandoned-cart confirmation sweep.
 *
 * Same shape as `sweep-deadlines.ts`, for the same underlying reason: this
 * agent's payment links are never resolved by the shared `payment_link.paid`
 * webhook (there is no original order id for it to match back to — see the
 * header comment on `db/schema/abandoned-cart.ts`), so something has to ask
 * Razorpay directly, on a schedule, across every merchant. The dashboard's
 * "Sync now" button (`/api/abandoned-cart/sync`) is the same check scoped to
 * one merchant, for immediate feedback while testing; this is the backstop
 * that runs whether or not anyone has that page open.
 */

import { inngest } from '../client.js';
import { getDb } from '../../db/client.js';
import { listPendingAbandonedCarts, markCartExpired, markCartRecovered } from '../../db/repos/abandoned-carts.js';
import { razorpayForMerchant } from '../merchant-clients.js';
import { fetchPaymentLink } from '../../adapters/razorpay/resources.js';

interface SweepSteps {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

export const sweepAbandonedCarts = inngest.createFunction(
  {
    id: 'sweep-abandoned-carts',
    triggers: [{ cron: '*/15 * * * *' }],
    // Same reasoning as sweep-deadlines: one run at a time, so two concurrent
    // sweeps cannot both act on the same pending row.
    concurrency: [{ limit: 1 }],
  },
  async ({ step }: { step: SweepSteps }) => {
    const db = getDb();

    const result = await step.run('reconcile-pending', async () => {
      const pending = await listPendingAbandonedCarts(db, 200);

      let recovered = 0;
      let expired = 0;
      const errors: string[] = [];

      // Grouped by merchant so a Razorpay client is built once per merchant
      // per sweep rather than once per row.
      const razorpayCache = new Map<string, Awaited<ReturnType<typeof razorpayForMerchant>>>();

      for (const row of pending) {
        try {
          if (!row.paymentLinkId) continue;

          let razorpay = razorpayCache.get(row.merchantId);
          if (razorpay === undefined) {
            razorpay = await razorpayForMerchant(db, row.merchantId);
            razorpayCache.set(row.merchantId, razorpay);
          }
          if (!razorpay) continue;

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

      return { examined: pending.length, recovered, expired, errors };
    });

    return result;
  },
);
