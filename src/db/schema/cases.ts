/**
 * The RecoveryCase, its append-only ledger, its actions, and the payment
 * attempts that feed diagnosis.
 *
 * Two structural decisions worth knowing:
 *
 *  1. `case_events` is append-only. Never updated, never deleted. It is the
 *     audit trail a merchant's compliance team will ask for, and the input to
 *     the incrementality ledger we intend to invoice on.
 *
 *  2. The partial unique index on live cases is the duplicate-case guard. Two
 *     failed attempts on one order must produce ONE case, or the customer gets
 *     two ladders and twice the messages.
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

import { customers } from './customers.js';
import { merchants } from './tenancy.js';
import {
  actionKindEnum,
  actionStatusEnum,
  caseStateEnum,
  caseTypeEnum,
  causeClassEnum,
  cohortEnum,
  errorSourceEnum,
  errorStepEnum,
  paymentMethodEnum,
} from './enums.js';

/** States in which a case is still live. Mirrors core's non-terminal set. */
export const LIVE_STATES_SQL = sql`state in ('detected','diagnosed','executing','paused')`;

export const recoveryCases = pgTable(
  'recovery_cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),

    type: caseTypeEnum('type').notNull(),
    state: caseStateEnum('state').notNull().default('detected'),

    /** ALWAYS integer paise. Never rupees, never a float. */
    amountAtRiskPaise: bigint('amount_at_risk_paise', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('INR'),

    rzpOrderId: text('rzp_order_id'),
    rzpPaymentId: text('rzp_payment_id'),
    rzpInvoiceId: text('rzp_invoice_id'),
    rzpSubscriptionId: text('rzp_subscription_id'),
    rzpPaymentLinkId: text('rzp_payment_link_id'),
    /**
     * The short URL, stored rather than re-fetched.
     *
     * A ladder consults this on every rung; fetching the link from Razorpay
     * each time would add a round trip to the one code path that must stay
     * fast, for a value that never changes once created.
     */
    rzpPaymentLinkUrl: text('rzp_payment_link_url'),

    // ── the diagnosis tuple, never collapsed ──
    errorCode: text('error_code'),
    errorSource: errorSourceEnum('error_source'),
    errorStep: errorStepEnum('error_step'),
    errorReason: text('error_reason'),
    method: paymentMethodEnum('method').notNull().default('unknown'),
    bank: text('bank'),
    network: text('network'),
    /** The original string when Razorpay sent a code we do not know. */
    rawErrorReason: text('raw_error_reason'),

    causeClass: causeClassEnum('cause_class'),
    confidence: text('confidence'),
    /** Rationale lines from diagnose(), for the audit log and the merchant UI. */
    diagnosisRationale: jsonb('diagnosis_rationale'),

    /**
     * Attended = no mandate; recovery means bringing a human back to a payment
     * surface. Unattended = a mandate exists and the debit may be re-presented.
     * Under RBI rules there is no third option, so this is NOT NULL.
     */
    attended: boolean('attended').notNull().default(true),

    mandateId: text('mandate_id'),

    /**
     * Stamped at resolution and never re-read. A case that started under v3
     * finishes under v3, even if the table is edited mid-flight.
     */
    policyId: text('policy_id'),
    policyVersion: integer('policy_version'),

    cohort: cohortEnum('cohort').notNull().default('treatment'),

    /** How far through the ladder we are. Part of every idempotency key. */
    currentRung: smallint('current_rung').notNull().default(0),
    messagesSent: smallint('messages_sent').notNull().default(0),

    /**
     * How many times this case has been resumed after a pause.
     *
     * Two jobs, and the second is the load-bearing one.
     *
     * It makes the Inngest run key unique per resume. `run-ladder` is declared
     * `idempotency: 'event.data.runKey'`, which is what stops a duplicate
     * `case/diagnosed` starting a second ladder and doubling every message.
     * Republishing the SAME key to resume would be silently swallowed by that
     * guard, and the case would sit in `executing` with no run behind it —
     * paused forever, with the console showing it as running.
     *
     * And incrementing it is the CLAIM. The resume path is
     * `UPDATE … SET resume_count = resume_count + 1 WHERE state = 'paused'`,
     * so of the two things that can resume a case (a person switching the
     * account back to live, and the sweep that catches what that missed)
     * exactly one wins the row. Without it both would publish, and Inngest
     * would start two ladders on one case.
     */
    resumeCount: smallint('resume_count').notNull().default(0),

    deadlineAt: timestamp('deadline_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    recoveredAmountPaise: bigint('recovered_amount_paise', { mode: 'number' }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // THE DUPLICATE-CASE GUARD. One live case per order, enforced by the
    // database rather than by application care.
    uniqueIndex('recovery_cases_live_order_key')
      .on(t.merchantId, t.rzpOrderId)
      .where(sql`${LIVE_STATES_SQL} and rzp_order_id is not null`),
    uniqueIndex('recovery_cases_live_invoice_key')
      .on(t.merchantId, t.rzpInvoiceId)
      .where(sql`${LIVE_STATES_SQL} and rzp_invoice_id is not null`),

    index('recovery_cases_merchant_state_idx').on(t.merchantId, t.state),
    index('recovery_cases_customer_idx').on(t.customerId),
    // Sweeping for expired cases only ever looks at live ones.
    index('recovery_cases_deadline_idx').on(t.deadlineAt).where(LIVE_STATES_SQL),
    index('recovery_cases_dashboard_idx').on(t.merchantId, t.causeClass, t.createdAt),
    index('recovery_cases_payment_idx').on(t.rzpPaymentId),
  ],
);

/**
 * Append-only. Every state change, every decision, every input.
 *
 * There is deliberately no `updatedAt` and nothing ever writes to a row twice.
 */
export const caseEvents = pgTable(
  'case_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => recoveryCases.id, { onDelete: 'cascade' }),
    merchantId: uuid('merchant_id').notNull(),

    /** e.g. detected · diagnosed · policy_resolved · rung_fired · aborted */
    kind: text('kind').notNull(),
    fromState: caseStateEnum('from_state'),
    toState: caseStateEnum('to_state'),
    reason: text('reason'),

    /** Who or what decided this: 'workflow' | 'webhook' | 'merchant:<id>' | 'system'. */
    actor: text('actor').notNull().default('system'),
    payload: jsonb('payload'),

    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('case_events_case_idx').on(t.caseId, t.occurredAt),
    index('case_events_merchant_idx').on(t.merchantId, t.occurredAt),
  ],
);

/**
 * Every action the agent planned, and what became of it.
 *
 * Holdout cases write rows here with status `suppressed` — a complete record of
 * what would have happened, with nothing sent. That record is what makes the
 * incrementality number honest rather than a claim.
 */
export const caseActions = pgTable(
  'case_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => recoveryCases.id, { onDelete: 'cascade' }),
    merchantId: uuid('merchant_id').notNull(),

    rung: smallint('rung').notNull(),
    kind: actionKindEnum('kind').notNull(),
    status: actionStatusEnum('status').notNull().default('planned'),

    /** `${caseId}:${rung}:${kind}` — two attempts at one rung collapse to one row. */
    idempotencyKey: text('idempotency_key').notNull(),

    /** Why an action did not fire: 'holdout' | 'dry_run' | 'quiet_hours' | … */
    skipReason: text('skip_reason'),
    params: jsonb('params'),
    result: jsonb('result'),
    error: text('error'),

    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // THE ANTI-DOUBLE-EXECUTION GUARD. A workflow retry after a deploy must not
    // fire the same rung twice.
    uniqueIndex('case_actions_idempotency_key').on(t.idempotencyKey),
    index('case_actions_case_idx').on(t.caseId, t.rung),
    index('case_actions_merchant_idx').on(t.merchantId, t.createdAt),
  ],
);

/**
 * Prior payment attempts on an order.
 *
 * Feeds `DiagnoseContext.priorAttempts`, which is what withdraws
 * same-instrument retry before a third wrong OTP locks the customer's card at
 * the issuer.
 */
export const paymentAttempts = pgTable(
  'payment_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),
    caseId: uuid('case_id').references(() => recoveryCases.id, { onDelete: 'set null' }),

    rzpOrderId: text('rzp_order_id'),
    rzpPaymentId: text('rzp_payment_id').notNull(),

    method: paymentMethodEnum('method').notNull().default('unknown'),
    errorReason: text('error_reason'),
    errorSource: errorSourceEnum('error_source'),
    bank: text('bank'),
    succeeded: boolean('succeeded').notNull().default(false),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),

    attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payment_attempts_payment_key').on(t.merchantId, t.rzpPaymentId),
    index('payment_attempts_order_idx').on(t.merchantId, t.rzpOrderId, t.attemptedAt),
    // "Has this customer tried in the last three minutes?" — the live-attempt lock.
    index('payment_attempts_recent_idx').on(t.merchantId, t.attemptedAt),
  ],
);
