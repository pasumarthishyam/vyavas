/**
 * The redrive.
 *
 * Half a dozen comments across the ingest path end with "the redrive sweep is
 * what recovers it". Until now there was no redrive sweep. The sentence was
 * load-bearing — it is the stated reason the webhook endpoint answers 200 on a
 * processing failure rather than letting Razorpay retry — and it was not true,
 * so every event that died mid-processing was lost silently and permanently.
 *
 * The hole is specific and it cannot fix itself. `recordWebhook` CLAIMS an
 * event before processing it, which is what makes an at-least-once delivery
 * safe to receive twice. The cost is that a claim survives the thing that
 * claimed it: if the process dies between the claim and
 * `markWebhookProcessed`, the row sits there marked as seen, dedupe turns
 * Razorpay's own retry into a no-op, and nothing anywhere ever looks at it
 * again.
 *
 * That is not hypothetical. Twenty-seven events accumulated this way in a
 * single afternoon, including a real `payment.failed` for a live merchant —
 * its `payment_attempts` row written, its recovery case never created, and no
 * error recorded because the failure handler's own write died with everything
 * else.
 */

import { eq, sql } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { merchants } from '../db/schema/tenancy.js';
import { webhookEvents } from '../db/schema/ops.js';
import { findUnprocessed, markWebhookFailed } from '../db/repos/webhooks.js';
import type { RazorpayWebhookEnvelope } from '../adapters/razorpay/types.js';
import { type HandlerContext, processClaimedEvent } from './pipeline.js';
import type { WorkflowPublisher } from './handlers/payment-failed.js';

export interface RedriveOptions {
  db: Database;
  /**
   * How long an event must have sat unprocessed before it counts as stranded.
   *
   * Long enough that an invocation still legitimately in flight is never
   * reprocessed underneath itself — the webhook route's own ceiling is 60s, so
   * anything past a few minutes is genuinely abandoned rather than merely slow.
   */
  olderThanSeconds?: number;
  limit?: number;
  /**
   * Give up after this many attempts.
   *
   * A poison event — one that throws every time on a payload we cannot parse —
   * must not be retried forever at the front of the queue, starving the
   * recoverable ones behind it. It stays on disk with its error for someone to
   * look at.
   */
  maxAttempts?: number;
  publish?: WorkflowPublisher;
}

export interface RedriveResult {
  examined: number;
  reprocessed: number;
  failed: number;
  skipped: number;
}

export async function redriveWebhooks(opts: RedriveOptions): Promise<RedriveResult> {
  const { db } = opts;
  const maxAttempts = opts.maxAttempts ?? 5;

  const stranded = await findUnprocessed(db, opts.olderThanSeconds ?? 180, opts.limit ?? 25);

  const result: RedriveResult = {
    examined: stranded.length,
    reprocessed: 0,
    failed: 0,
    skipped: 0,
  };

  for (const event of stranded) {
    if (event.attempts >= maxAttempts) {
      result.skipped += 1;
      continue;
    }

    // Whose is it? The per-merchant endpoint stamps this at claim time. Rows
    // written before that existed carry null, and there is nothing honest to do
    // with them here — guessing a tenant is how one merchant's failure becomes
    // another merchant's customer receiving a message.
    if (!event.merchantId) {
      await markWebhookFailed(
        db,
        event.eventId,
        'cannot redrive: no merchant stamped on this delivery',
      );
      result.skipped += 1;
      continue;
    }

    const [merchant] = await db
      .select()
      .from(merchants)
      .where(eq(merchants.id, event.merchantId))
      .limit(1);

    if (!merchant || merchant.deletedAt) {
      await markWebhookFailed(db, event.eventId, 'cannot redrive: merchant is gone');
      result.skipped += 1;
      continue;
    }

    const ctx: HandlerContext = {
      db,
      merchantId: merchant.id,
      // The instant the delivery ARRIVED, not now. Every downstream decision
      // that reads the clock — the deadline, the live-attempt lock, quiet hours
      // — must see the world as it was when the payment failed, or a redrive
      // an hour later diagnoses a different case than the one that happened.
      now: event.receivedAt,
      holdoutBasisPoints: merchant.holdoutBasisPoints,
      holdoutEnabled: merchant.holdoutEnabled,
      ...(opts.publish ? { publish: opts.publish } : {}),
    };

    const outcome = await processClaimedEvent(
      db,
      ctx,
      event.eventId,
      event.payload as RazorpayWebhookEnvelope,
    );

    if (outcome.outcome === 'error') result.failed += 1;
    else result.reprocessed += 1;
  }

  return result;
}

/**
 * Attribute old rows that predate the merchant stamp.
 *
 * Only ever fills in a null, and only from the account id inside the payload
 * matched against a merchant's own connection — never a "there is one merchant
 * so it must be theirs" guess, which is exactly the shortcut that made the
 * single-endpoint design silently wrong the moment a second merchant existed.
 */
export async function backfillWebhookMerchants(db: Database): Promise<number> {
  const updated = await db
    .update(webhookEvents)
    .set({ merchantId: sql`sub.merchant_id` })
    .from(
      sql`(
        select w.event_id, c.merchant_id
        from webhook_events w
        join razorpay_connections c
          on c.rzp_account_id = w.payload->>'account_id'
         and c.status = 'active'
        where w.merchant_id is null
          and w.payload->>'account_id' is not null
      ) as sub`,
    )
    .where(sql`${webhookEvents.eventId} = sub.event_id`)
    .returning({ eventId: webhookEvents.eventId });

  return updated.length;
}
