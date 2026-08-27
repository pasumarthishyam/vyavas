/**
 * Operational tables: webhook dedupe, the live downtime feed, merchant alerts.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { merchants } from './tenancy.js';
import { alertSeverityEnum, downtimeSeverityEnum, paymentMethodEnum } from './enums.js';

/**
 * Webhook dedupe.
 *
 * Razorpay delivers at-least-once and retries on timeout, so the same event
 * WILL arrive twice. The primary key on the provider's event id, combined with
 * `ON CONFLICT DO NOTHING`, is what makes reprocessing a no-op instead of a
 * second recovery case.
 */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    /** Razorpay's `x-razorpay-event-id`. The dedupe key. */
    eventId: text('event_id').primaryKey(),
    merchantId: uuid('merchant_id').references(() => merchants.id, { onDelete: 'cascade' }),

    /** `payment.failed`, `order.paid`, `payment.downtime.resolved`, … */
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),

    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    processingError: text('processing_error'),
    attempts: integer('attempts').notNull().default(0),
  },
  (t) => [
    index('webhook_events_type_idx').on(t.eventType, t.receivedAt),
    // The redrive queue: anything received but never successfully processed.
    index('webhook_events_unprocessed_idx')
      .on(t.receivedAt)
      .where(sql`processed_at is null`),
  ],
);

/**
 * The live downtime feed, from Razorpay's Payment Downtime API and its
 * `payment.downtime.*` webhooks.
 *
 * This table is why we do not guess "retry in 2-3 hours". A case parks until
 * the matching row is resolved, then strikes — and "your bank is back online"
 * is a different message from "please try again".
 *
 * Global, not per-merchant: an HDFC outage is an HDFC outage for everyone.
 */
export const downtimeWindows = pgTable(
  'downtime_windows',
  {
    id: text('id').primaryKey(), // Razorpay's downtime id
    method: paymentMethodEnum('method').notNull(),
    /** NULL means the outage spans all banks for that method. */
    bank: text('bank'),
    network: text('network'),
    issuer: text('issuer'),
    psp: text('psp'),

    severity: downtimeSeverityEnum('severity').notNull().default('medium'),
    /** Razorpay's own status string, preserved verbatim. */
    status: text('status').notNull(),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // "Is anything down right now for this bank and method?" — read on every
    // diagnosis, so it must be an index scan over open rows only.
    index('downtime_open_idx')
      .on(t.method, t.bank)
      .where(sql`resolved_at is null`),
    index('downtime_started_idx').on(t.startedAt),
  ],
);

/**
 * Merchant breakage alerts.
 *
 * Diagnostic, never prescriptive. We state what broke, when it started, and
 * what the normal rate is. Which payment methods a merchant offers is their
 * commercial decision — turning one off could cost far more than the outage,
 * and it is not ours to recommend.
 */
export const merchantAlerts = pgTable(
  'merchant_alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),

    severity: alertSeverityEnum('severity').notNull(),
    /** Stable key for the condition, e.g. `bank_not_enabled:ICIC:netbanking`. */
    signal: text('signal').notNull(),
    title: text('title').notNull(),
    detail: text('detail'),

    affectedCases: integer('affected_cases').notNull().default(0),
    amountAtRiskPaise: bigint('amount_at_risk_paise', { mode: 'number' }).notNull().default(0),
    /** Normal failure rate for this method, in basis points. Context, not advice. */
    baselineRateBps: integer('baseline_rate_bps'),

    onsetAt: timestamp('onset_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One open alert per condition per merchant. A config fault that is still
    // broken accumulates into the existing row rather than paging repeatedly.
    uniqueIndex('merchant_alerts_open_signal_key')
      .on(t.merchantId, t.signal)
      .where(sql`resolved_at is null`),
    index('merchant_alerts_merchant_idx').on(t.merchantId, t.createdAt),
  ],
);
