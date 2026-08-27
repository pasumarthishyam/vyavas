/**
 * Tenancy: merchants and their Razorpay connections.
 *
 * Multi-tenant from the first migration, because retrofitting `merchant_id`
 * onto a live schema is the kind of change that takes a weekend and loses data.
 * A platform running this for 10,000 sub-merchants is the same shape as one
 * merchant running it for themselves.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { connectionModeEnum, connectionScopeEnum, connectionStatusEnum } from './enums.js';

export const merchants = pgTable(
  'merchants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),

    /** IANA zone. Drives quiet hours; India is a single zone but platforms are not. */
    timezone: text('timezone').notNull().default('Asia/Kolkata'),

    // ── the bounded-autonomy dials ──

    /** Master switch. When false nothing is sent, whatever any ladder says. */
    executionEnabled: boolean('execution_enabled').notNull().default(false),
    /** Plan and log every action, send nothing. The default for a new merchant. */
    dryRun: boolean('dry_run').notNull().default(true),

    /** Holdout share in basis points. 500 = 5%. */
    holdoutBasisPoints: integer('holdout_basis_points').notNull().default(500),
    holdoutEnabled: boolean('holdout_enabled').notNull().default(true),

    /** Customer touches per customer per rolling 24h, ACROSS ALL CASES. */
    frequencyCapPerDay: smallint('frequency_cap_per_day').notNull().default(2),
    /** Minutes since the last payment attempt before we may interrupt. */
    liveAttemptLockMinutes: smallint('live_attempt_lock_minutes').notNull().default(3),

    /** Quiet hours in merchant-local time. No customer contact inside this window. */
    quietHoursStart: smallint('quiet_hours_start').notNull().default(21),
    quietHoursEnd: smallint('quiet_hours_end').notNull().default(8),

    /** Daily ceiling on customer messages for the whole account. Paise-free integer. */
    dailyMessageBudget: integer('daily_message_budget').notNull().default(1000),
    /** Ceiling on money the agent may re-present per day, in paise. */
    dailyDebitBudgetPaise: bigint('daily_debit_budget_paise', { mode: 'number' })
      .notNull()
      .default(0),

    /** Commission on proven-incremental recovery, in basis points. */
    commissionBasisPoints: integer('commission_basis_points').notNull().default(1500),

    settings: jsonb('settings').notNull().default(sql`'{}'::jsonb`),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('merchants_slug_key').on(t.slug)],
);

export const razorpayConnections = pgTable(
  'razorpay_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),

    mode: connectionModeEnum('mode').notNull(),
    scope: connectionScopeEnum('scope').notNull().default('read_only'),
    status: connectionStatusEnum('status').notNull().default('active'),

    /** Razorpay merchant id (`acc_…` for partner sub-merchants). */
    rzpAccountId: text('rzp_account_id'),
    keyId: text('key_id').notNull(),

    /**
     * Encrypted at the application layer before it ever reaches this column.
     * Nothing here is stored in plaintext, and no card data is stored at all —
     * under the RBI tokenisation mandate we hold Razorpay tokens, never PANs.
     */
    keySecretEnc: text('key_secret_enc').notNull(),
    webhookSecretEnc: text('webhook_secret_enc'),
    oauthRefreshTokenEnc: text('oauth_refresh_token_enc'),
    oauthAccessTokenEnc: text('oauth_access_token_enc'),
    oauthExpiresAt: timestamp('oauth_expires_at', { withTimezone: true }),

    backfilledThrough: timestamp('backfilled_through', { withTimezone: true }),
    lastEventAt: timestamp('last_event_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One active connection per merchant per mode. Two live connections would
    // double-process every webhook.
    uniqueIndex('rzp_conn_merchant_mode_key')
      .on(t.merchantId, t.mode)
      .where(sql`status = 'active'`),
    index('rzp_conn_account_idx').on(t.rzpAccountId),
  ],
);
