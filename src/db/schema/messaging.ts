/**
 * The message log.
 *
 * This table does double duty: it is the record of what we said, and it is the
 * data the cross-case frequency cap reads.
 *
 * That second job is why it is keyed on `customer_id` and not on `case_id`. A
 * customer with a failed payment AND an overdue invoice has two live cases in
 * two independent workflows, and without a shared ledger they would each send
 * politely and the person would receive six messages. The cap has to be global
 * per person, which means the count has to be global per person.
 */

import { sql } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { customers } from './customers.js';
import { merchants } from './tenancy.js';
import { recoveryCases } from './cases.js';
import { channelEnum, messageStatusEnum } from './enums.js';

export const messageLog = pgTable(
  'message_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    caseId: uuid('case_id').references(() => recoveryCases.id, { onDelete: 'set null' }),

    rung: smallint('rung').notNull().default(0),
    channel: channelEnum('channel').notNull(),
    /** From the action allowlist — never free-form. Copy is generated from this. */
    intent: text('intent').notNull(),
    status: messageStatusEnum('status').notNull().default('queued'),

    /** Approved template used, so a compliance review can trace every send. */
    templateId: text('template_id'),
    locale: text('locale'),
    /** The rendered body. Kept for audit; never re-sent from here. */
    body: text('body'),
    providerMessageId: text('provider_message_id'),
    providerResponse: jsonb('provider_response'),
    error: text('error'),

    /**
     * Same key as case_actions. A workflow replay after a deploy must not
     * produce a second message.
     */
    idempotencyKey: text('idempotency_key').notNull(),

    /**
     * Set for holdout and dry-run rows: the message was fully planned and
     * deliberately not sent. Counted for comparison, never for delivery.
     */
    suppressedReason: text('suppressed_reason'),

    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('message_log_idempotency_key').on(t.idempotencyKey),
    // The frequency-cap query: "how many real touches has this person had in the
    // last 24 hours, across every case?" Suppressed rows are excluded from the
    // index so a holdout never eats a treatment customer's budget.
    index('message_log_customer_recent_idx')
      .on(t.customerId, t.sentAt)
      .where(sql`suppressed_reason is null`),
    index('message_log_case_idx').on(t.caseId),
    index('message_log_merchant_idx').on(t.merchantId, t.sentAt),
  ],
);
