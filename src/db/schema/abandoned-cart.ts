/**
 * The abandoned-cart agent's own table.
 *
 * There is no `recovery_cases` row here at all, and there never can be — a
 * `recoveryCase` exists because Razorpay told us a payment failed, and an
 * abandoned cart is the opposite: no payment was ever attempted, so Razorpay
 * has nothing to report. The only way this agent ever learns a cart exists is
 * the merchant's OWN application calling our webhook — see
 * `app/api/abandoned-cart/[slug]/webhook/route.ts`.
 *
 * Same separate-agent discipline as `voice_calls`: this table never touches
 * `recovery_cases.rzp_payment_link_id/url`, and it closes itself by asking
 * Razorpay directly whether the link IT created was paid, not by depending on
 * the shared `payment_link.paid` webhook (which resolves back to a case by an
 * order id that, again, never existed here).
 */

import { sql } from 'drizzle-orm';
import { bigint, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { merchants } from './tenancy.js';
import { customers } from './customers.js';
import { abandonedCartStatusEnum } from './enums.js';

export const abandonedCarts = pgTable(
  'abandoned_carts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),

    /**
     * The merchant's own cart/session id. The idempotency guard — their app is
     * expected to call the webhook exactly once per cart, but a retry or a
     * double-fire must not produce a second email or a second payment link.
     */
    externalCartId: text('external_cart_id').notNull(),

    customerName: text('customer_name'),
    /** Required at the webhook boundary — the only channel this agent uses. */
    customerEmail: text('customer_email').notNull(),
    customerPhone: text('customer_phone'),
    /** Set once `upsertCustomer` resolves this contact to a row — what the send path needs. */
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),

    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),

    status: abandonedCartStatusEnum('status').notNull().default('detected'),

    /** Flat ₹200, capped at half the cart on a small cart. Never negotiated. */
    discountAmountPaise: bigint('discount_amount_paise', { mode: 'number' }),

    paymentLinkId: text('payment_link_id'),
    paymentLinkUrl: text('payment_link_url'),
    paymentLinkAmountPaise: bigint('payment_link_amount_paise', { mode: 'number' }),
    /** 24h from creation — what the email promises. */
    paymentLinkExpiresAt: timestamp('payment_link_expires_at', { withTimezone: true }),
    /** Set once this agent has independently confirmed the link was paid. */
    paymentConfirmedAt: timestamp('payment_confirmed_at', { withTimezone: true }),

    /**
     * Set ONLY when an email actually left for the customer.
     *
     * It used to be stamped whenever the link was created, which is how a cart
     * whose email was suppressed (dry run) or refused (frequency cap) still
     * read as "emailed" on the console. `status` is the CART's lifecycle —
     * link issued, paid, expired — and cannot answer "did anyone receive
     * anything"; these three columns do.
     */
    emailSentAt: timestamp('email_sent_at', { withTimezone: true }),
    /**
     * What the send path actually returned: sent | suppressed | refused |
     * failed | no_channel | not_composed. Null on a cart that never got as far
     * as attempting one.
     */
    emailStatus: text('email_status'),
    /** The why behind a non-`sent` `emailStatus` — 'dry_run', 'frequency_cap', a provider error. */
    emailDetail: text('email_detail'),
    failureReason: text('failure_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The idempotency guard itself: one row per (merchant, their cart id), ever.
    uniqueIndex('abandoned_carts_merchant_external_key').on(t.merchantId, t.externalCartId),
    index('abandoned_carts_merchant_idx').on(t.merchantId, t.createdAt),
    // What the confirmation sweep scans: emailed, linked, not yet resolved.
    index('abandoned_carts_pending_idx')
      .on(t.paymentLinkExpiresAt)
      .where(sql`status = 'emailed' and payment_link_id is not null and payment_confirmed_at is null`),
  ],
);
