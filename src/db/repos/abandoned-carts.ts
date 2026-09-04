/**
 * The abandoned-cart agent's own repo.
 *
 * Everything here is scoped to `abandoned_carts`, keyed by the MERCHANT'S OWN
 * cart id — see the header comment on `db/schema/abandoned-cart.ts` for why
 * there is no case underneath any of it.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { abandonedCarts } from '../schema/abandoned-cart.js';

export interface CreateAbandonedCartInput {
  merchantId: string;
  externalCartId: string;
  customerName: string | null;
  customerEmail: string;
  customerPhone: string | null;
  amountPaise: number;
}

/** Idempotent on `(merchantId, externalCartId)` — a retried webhook call returns the existing row. */
export async function createAbandonedCart(
  db: Database,
  input: CreateAbandonedCartInput,
): Promise<{ id: string; created: boolean }> {
  const inserted = await db
    .insert(abandonedCarts)
    .values({
      merchantId: input.merchantId,
      externalCartId: input.externalCartId,
      customerName: input.customerName,
      customerEmail: input.customerEmail,
      customerPhone: input.customerPhone,
      amountPaise: input.amountPaise,
    })
    .onConflictDoNothing({ target: [abandonedCarts.merchantId, abandonedCarts.externalCartId] })
    .returning({ id: abandonedCarts.id });

  const row = inserted.at(0);
  if (row) return { id: row.id, created: true };

  const existing = await getAbandonedCartByExternalId(db, input.merchantId, input.externalCartId);
  if (!existing) {
    throw new Error(
      `abandoned_carts insert conflicted but no row for (${input.merchantId}, ${input.externalCartId}) was found`,
    );
  }
  return { id: existing.id, created: false };
}

export async function getAbandonedCartByExternalId(
  db: Database,
  merchantId: string,
  externalCartId: string,
) {
  const rows = await db
    .select()
    .from(abandonedCarts)
    .where(and(eq(abandonedCarts.merchantId, merchantId), eq(abandonedCarts.externalCartId, externalCartId)))
    .limit(1);
  return rows.at(0) ?? null;
}

export async function getAbandonedCart(db: Database, id: string) {
  const rows = await db.select().from(abandonedCarts).where(eq(abandonedCarts.id, id)).limit(1);
  return rows.at(0) ?? null;
}

/**
 * The cart a Razorpay payment link belongs to.
 *
 * Lets an inbound `payment_link.paid` close a cart the moment it arrives,
 * instead of waiting up to fifteen minutes for the confirmation sweep to ask
 * Razorpay the same question.
 */
export async function getAbandonedCartByPaymentLinkId(
  db: Database,
  merchantId: string,
  paymentLinkId: string,
) {
  const rows = await db
    .select()
    .from(abandonedCarts)
    .where(and(eq(abandonedCarts.merchantId, merchantId), eq(abandonedCarts.paymentLinkId, paymentLinkId)))
    .limit(1);
  return rows.at(0) ?? null;
}

export async function recordCartFailure(db: Database, id: string, reason: string): Promise<void> {
  await db
    .update(abandonedCarts)
    .set({ status: 'failed', failureReason: reason.slice(0, 2000), updatedAt: sql`now()` })
    .where(eq(abandonedCarts.id, id));
}

/** What the send path did with this cart's one email. `sent` is the only one that reached anybody. */
export type CartEmailStatus =
  | 'sent'
  | 'suppressed'
  | 'refused'
  | 'failed'
  | 'no_channel'
  | 'not_composed';

/**
 * The link was created; here is what then happened to the email.
 *
 * Was `recordCartEmailSent`, and it stamped `emailSentAt` and nothing else no
 * matter what the send returned — which is how a cart whose email was
 * suppressed by a dry run, refused by the frequency cap or rejected by the
 * provider still showed up on the console as "emailed". The row's `status`
 * stays `emailed` because that is the CART's lifecycle (a link is live and
 * something has to sweep it for payment, see `listPendingAbandonedCarts`); the
 * delivery truth lives in `emailStatus`/`emailDetail`, and `emailSentAt` is now
 * only ever set when an email genuinely left.
 */
export async function recordCartLinkIssued(
  db: Database,
  id: string,
  input: {
    customerId: string | null;
    discountAmountPaise: number;
    paymentLinkId: string;
    paymentLinkUrl: string;
    paymentLinkAmountPaise: number;
    paymentLinkExpiresAt: Date;
    emailStatus: CartEmailStatus;
    emailDetail: string | null;
  },
): Promise<void> {
  await db
    .update(abandonedCarts)
    .set({
      status: 'emailed',
      customerId: input.customerId,
      discountAmountPaise: input.discountAmountPaise,
      paymentLinkId: input.paymentLinkId,
      paymentLinkUrl: input.paymentLinkUrl,
      paymentLinkAmountPaise: input.paymentLinkAmountPaise,
      paymentLinkExpiresAt: input.paymentLinkExpiresAt,
      emailStatus: input.emailStatus,
      emailDetail: input.emailDetail?.slice(0, 2000) ?? null,
      ...(input.emailStatus === 'sent' ? { emailSentAt: sql`now()` } : {}),
      updatedAt: sql`now()`,
    })
    .where(eq(abandonedCarts.id, id));
}

/**
 * This cart was a payment failure in disguise, and we declined to act on it.
 *
 * A distinct status rather than `failed`, because nothing failed — the decision
 * was correct. It is also the single most useful number this agent produces:
 * how often the merchant's own app reports a "cart" that is really a decline,
 * which is a signal about THEIR integration, not about ours.
 *
 * `customerId` is stamped even though no email goes out, so the console can
 * still show who it was about and the row joins to the case that won.
 */
export async function markCartSuppressed(
  db: Database,
  id: string,
  customerId: string | null,
  reason: string,
): Promise<void> {
  await db
    .update(abandonedCarts)
    .set({
      status: 'suppressed',
      customerId,
      emailStatus: 'suppressed',
      emailDetail: reason.slice(0, 2000),
      updatedAt: sql`now()`,
    })
    .where(eq(abandonedCarts.id, id));
}

export async function markCartRecovered(db: Database, id: string): Promise<void> {
  await db
    .update(abandonedCarts)
    .set({ status: 'recovered', paymentConfirmedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(abandonedCarts.id, id));
}

export async function markCartExpired(db: Database, id: string): Promise<void> {
  await db
    .update(abandonedCarts)
    .set({ status: 'expired', updatedAt: sql`now()` })
    .where(eq(abandonedCarts.id, id));
}

/** Emailed, linked, not yet resolved — what the confirmation sweep scans, across every merchant. */
export async function listPendingAbandonedCarts(db: Database, limit = 200) {
  return db
    .select()
    .from(abandonedCarts)
    .where(
      and(
        eq(abandonedCarts.status, 'emailed'),
        sql`${abandonedCarts.paymentLinkId} is not null`,
        isNull(abandonedCarts.paymentConfirmedAt),
      ),
    )
    .limit(limit);
}

/** Same scan, scoped to one merchant — what the dashboard's manual "Sync now" uses. */
export async function listPendingAbandonedCartsForMerchant(db: Database, merchantId: string) {
  return db
    .select()
    .from(abandonedCarts)
    .where(
      and(
        eq(abandonedCarts.merchantId, merchantId),
        eq(abandonedCarts.status, 'emailed'),
        sql`${abandonedCarts.paymentLinkId} is not null`,
        isNull(abandonedCarts.paymentConfirmedAt),
      ),
    );
}

export async function listRecentAbandonedCarts(db: Database, merchantId: string, limit = 50) {
  return db
    .select()
    .from(abandonedCarts)
    .where(eq(abandonedCarts.merchantId, merchantId))
    .orderBy(desc(abandonedCarts.createdAt))
    .limit(limit);
}
