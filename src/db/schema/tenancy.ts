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

    /**
     * Hard floor between two touches to one person, in minutes.
     *
     * The frequency cap counts messages over a rolling 24h and cannot express
     * "not twice in five minutes" — under a cap of 2, a second message ninety
     * seconds after the first is permitted. This is that missing floor, and it
     * is deterministic on purpose: an agent that is right 99% of the time still
     * double-messages someone once every hundred runs.
     *
     * 15 minutes, NOT hours. The floor applies to every touch, and the policy
     * table deliberately places second touches at 30 and 45 minutes for
     * `customer_input` — the highest-recovery class in the taxonomy, fast
     * precisely because intent decays in minutes. A longer floor would defer
     * those rungs until the ladder had moved past them, quietly converting a
     * two-touch ladder into a one-touch one. This constrains accidents (two
     * live cases for one person firing together) and not design.
     */
    minGapMinutes: smallint('min_gap_minutes').notNull().default(15),

    /**
     * How long after a failure the customer is assumed to still be on the page.
     *
     * A first touch inside this window is a RESPONSE to something the person
     * did seconds ago, not an outbound campaign, so it is exempt from quiet
     * hours. Someone who tapped Pay at 22:47 and watched it fail is awake,
     * holding their phone, looking at an error; telling them "try UPI" is help.
     * Waiting until 08:00 loses the sale. Rung 0 only, and only inside this
     * window — every later rung obeys quiet hours normally.
     */
    liveCustomerWindowMinutes: smallint('live_customer_window_minutes').notNull().default(15),

    /** Daily ceiling on customer messages for the whole account. Paise-free integer. */
    dailyMessageBudget: integer('daily_message_budget').notNull().default(1000),
    /** Ceiling on money the agent may re-present per day, in paise. */
    dailyDebitBudgetPaise: bigint('daily_debit_budget_paise', { mode: 'number' })
      .notNull()
      .default(0),

    /** Commission on proven-incremental recovery, in basis points. */
    commissionBasisPoints: integer('commission_basis_points').notNull().default(1500),

    // ── email, per merchant ──
    //
    // Encrypted like every other stored credential. A merchant sends as
    // themselves from their own verified domain, so the key and the From
    // address travel together and neither belongs in a global env var.
    resendApiKeyEnc: text('resend_api_key_enc'),
    emailFrom: text('email_from'),

    // ── where messages ACTUALLY land ──
    //
    // NULL means the real recipient. Set means every message on that channel
    // goes here instead, whatever the case says — the intended recipient is
    // still recorded in `message_log`, so the ledger stays truthful about who
    // the message was FOR.
    //
    // This is a merchant property rather than an environment flag on purpose.
    // The previous design refused to divert whenever NODE_ENV was 'production',
    // which is correct only if production means real customers — and it stops
    // being correct the moment a sandbox merchant runs on the same deployment
    // as a live one.
    whatsappRedirectTo: text('whatsapp_redirect_to'),
    emailRedirectTo: text('email_redirect_to'),

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
