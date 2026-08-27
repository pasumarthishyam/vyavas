/**
 * Customers, and the consent state that governs every message.
 *
 * The opt-out columns are not metadata — they are the gate the frequency lock
 * and every channel check read before a single message goes out. A customer who
 * has opted out must be unreachable by construction, not by remembering to
 * check.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { merchants } from './tenancy.js';

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),

    /** The merchant's own id for this person, when they give us one. */
    externalRef: text('external_ref'),
    rzpCustomerId: text('rzp_customer_id'),

    email: text('email'),
    /** E.164. Normalised on write so `+919876543210` and `9876543210` are one person. */
    phone: text('phone'),
    name: text('name'),
    /** BCP-47. Drives which language Claude writes the message in. */
    locale: text('locale').notNull().default('en-IN'),

    // ── consent, per channel ──
    whatsappOptIn: boolean('whatsapp_opt_in').notNull().default(false),
    smsOptIn: boolean('sms_opt_in').notNull().default(false),
    emailOptIn: boolean('email_opt_in').notNull().default(false),

    /**
     * A global stop. Set once, honoured everywhere, never expires. Checked as a
     * precondition before every rung and as an abort condition on every case.
     */
    optedOutAt: timestamp('opted_out_at', { withTimezone: true }),
    optOutReason: text('opt_out_reason'),

    /** Marks a number/address the provider told us is undeliverable. */
    phoneUndeliverableAt: timestamp('phone_undeliverable_at', { withTimezone: true }),
    emailUndeliverableAt: timestamp('email_undeliverable_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One row per contact per merchant. Duplicates here would defeat the
    // cross-case frequency cap, which is keyed on customer id — the same person
    // stored twice gets messaged twice.
    uniqueIndex('customers_merchant_phone_key')
      .on(t.merchantId, t.phone)
      .where(sql`phone is not null`),
    uniqueIndex('customers_merchant_email_key')
      .on(t.merchantId, t.email)
      .where(sql`email is not null`),
    uniqueIndex('customers_merchant_external_key')
      .on(t.merchantId, t.externalRef)
      .where(sql`external_ref is not null`),
    index('customers_merchant_idx').on(t.merchantId),
  ],
);
