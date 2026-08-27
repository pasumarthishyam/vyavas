/**
 * Webhook dedupe.
 *
 * Razorpay delivers at-least-once and retries on timeout or a non-2xx, so the
 * same event WILL arrive more than once. Without dedupe a retried
 * `payment.failed` creates a second recovery case for the same order, and the
 * customer gets two ladders.
 *
 * `ON CONFLICT DO NOTHING … RETURNING` makes this a single atomic statement: no
 * SELECT-then-INSERT race, no advisory lock needed, and the return value tells
 * you unambiguously whether you are the one who claimed this event.
 */

import { and, eq, isNull, lt, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { webhookEvents } from '../schema/ops.js';

export interface RecordWebhookInput {
  /** Razorpay's `x-razorpay-event-id`. */
  eventId: string;
  eventType: string;
  payload: unknown;
  merchantId?: string | null;
}

export interface RecordWebhookResult {
  /** True only for the caller that actually claimed this event. */
  isNew: boolean;
}

/**
 * Claim a webhook event.
 *
 * Returns `{ isNew: false }` for a duplicate — the caller must then return 200
 * and do nothing else. Returning an error would make Razorpay retry again.
 */
export async function recordWebhook(
  db: Database,
  input: RecordWebhookInput,
): Promise<RecordWebhookResult> {
  const inserted = await db
    .insert(webhookEvents)
    .values({
      eventId: input.eventId,
      eventType: input.eventType,
      payload: input.payload as never,
      merchantId: input.merchantId ?? null,
    })
    .onConflictDoNothing({ target: webhookEvents.eventId })
    .returning({ eventId: webhookEvents.eventId });

  return { isNew: inserted.length > 0 };
}

export async function markWebhookProcessed(db: Database, eventId: string): Promise<void> {
  await db
    .update(webhookEvents)
    .set({ processedAt: sql`now()`, processingError: null })
    .where(eq(webhookEvents.eventId, eventId));
}

export async function markWebhookFailed(
  db: Database,
  eventId: string,
  error: string,
): Promise<void> {
  await db
    .update(webhookEvents)
    .set({
      processingError: error.slice(0, 2000),
      attempts: sql`${webhookEvents.attempts} + 1`,
    })
    .where(eq(webhookEvents.eventId, eventId));
}

/**
 * Events received but never successfully processed.
 *
 * The redrive queue. An event that was claimed and then lost to a crash would
 * otherwise sit forever — dedupe means Razorpay's own retry cannot rescue it,
 * so we have to.
 */
export async function findUnprocessed(db: Database, olderThanSeconds = 300, limit = 100) {
  return db
    .select()
    .from(webhookEvents)
    .where(
      and(
        isNull(webhookEvents.processedAt),
        lt(webhookEvents.receivedAt, sql`now() - make_interval(secs => ${olderThanSeconds})`),
      ),
    )
    .orderBy(webhookEvents.receivedAt)
    .limit(limit);
}
