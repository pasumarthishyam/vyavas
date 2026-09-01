/**
 * The discount-calling agent's own tables.
 *
 * Deliberately separate from `recovery_cases`. This agent reads a case for
 * context (amount, customer, cause class) but never writes to
 * `recovery_cases.rzp_payment_link_id/url` — that column is the ladder's "one
 * live link, forever" invariant, and a discounted link created mid-call is a
 * different thing with a different amount. Keeping the two payment links
 * structurally apart means this agent cannot collide with the ladder's
 * idempotency guarantees no matter what it does.
 *
 * A call closes its own case the same way: not by relying on the shared
 * `payment_link.paid` webhook (which resolves by the ORIGINAL order id, and a
 * freshly created link does not share one), but by asking Razorpay directly
 * whether the link it created was paid. See `adapters/vapi/webhook.ts`.
 */

import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, jsonb, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { recoveryCases } from './cases.js';
import { merchants } from './tenancy.js';
import { voiceCallStatusEnum } from './enums.js';

export const voiceCalls = pgTable(
  'voice_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => recoveryCases.id, { onDelete: 'cascade' }),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),

    /** Vapi's own call id. Unique — this is the idempotency guard on every webhook write. */
    vapiCallId: text('vapi_call_id').notNull(),
    customerPhone: text('customer_phone').notNull(),

    status: voiceCallStatusEnum('status').notNull().default('queued'),

    /** 0 = no discount offered yet on this call. Never decreases. */
    discountTierOffered: smallint('discount_tier_offered').notNull().default(0),
    discountAmountPaise: bigint('discount_amount_paise', { mode: 'number' }),
    /**
     * Set true only once `create_payment_link` is actually called — that tool
     * call IS the "customer agreed" signal, there is no separate field the
     * model fills in for it.
     */
    discountAccepted: boolean('discount_accepted').notNull().default(false),

    paymentLinkId: text('payment_link_id'),
    paymentLinkUrl: text('payment_link_url'),
    paymentLinkAmountPaise: bigint('payment_link_amount_paise', { mode: 'number' }),
    /** Set once this agent has independently confirmed the link was paid. */
    paymentConfirmedAt: timestamp('payment_confirmed_at', { withTimezone: true }),

    transcript: jsonb('transcript'),
    recordingUrl: text('recording_url'),
    endedReason: text('ended_reason'),
    durationSeconds: integer('duration_seconds'),

    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('voice_calls_vapi_call_id_key').on(t.vapiCallId),
    index('voice_calls_case_idx').on(t.caseId, t.createdAt),
    index('voice_calls_merchant_idx').on(t.merchantId, t.createdAt),
    // The end-of-call-report handler re-checks payment status for any call
    // that ended without a confirmed payment yet — this is what a follow-up
    // sweep would scan.
    index('voice_calls_unconfirmed_idx')
      .on(t.endedAt)
      .where(sql`status = 'ended' and payment_confirmed_at is null and payment_link_id is not null`),
  ],
);
