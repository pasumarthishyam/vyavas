/**
 * The policy row schema.
 *
 * A policy row is a *ladder*: what we do, in what order, at what offsets from
 * detection, on what channels, with what caps. The table is authored as YAML so
 * it can be read and tuned by people who are not going to open a TypeScript
 * file — but every row is validated by this schema before it can ever be
 * resolved, and malformed rows fail the build rather than degrading at runtime.
 *
 * Two things deliberately do NOT live here:
 *
 *   - Message copy. Rungs carry an *intent*; the words are generated later
 *     inside an approved template. Keeping them apart is what stops a failure
 *     ladder drifting into marketing language.
 *   - Whether an action is permitted at all. That is the cause-class traits'
 *     job, and compile.ts cross-checks every row against them. A policy may
 *     tighten a safety limit; it may never loosen one.
 */

import { z } from 'zod';

import {
  ALTERNATE_RAILS,
  CASE_TYPES,
  ERROR_SOURCES,
  ERROR_STEPS,
  PAYMENT_METHODS,
} from '../case/types.js';
import { CHANNELS, MESSAGE_INTENTS } from '../actions/types.js';
import { AMOUNT_BANDS } from '../money.js';
import { CAUSE_CLASSES } from '../taxonomy/cause-class.js';
import { isDuration } from './duration.js';

/** z.enum wants a mutable non-empty tuple; our vocabularies are readonly consts. */
const enumOf = <T extends string>(values: readonly T[]) =>
  z.enum(values as unknown as [T, ...T[]]);

const duration = z
  .string()
  .refine(isDuration, { message: "Expected a duration like '0m', '4m', '6h', '3d'" });

// ─── match ───────────────────────────────────────────────────────────────────

/**
 * Every field is optional. An omitted field means "do not constrain on this",
 * which is what lets a table hold both `card_expired on HDFC cards` and
 * `anything in the instrument_dead class` without them fighting — specificity
 * decides, not declaration order.
 */
export const matchSchema = z
  .object({
    errorReason: z.string().min(1).optional(),
    errorSource: z.array(enumOf(ERROR_SOURCES)).nonempty().optional(),
    errorStep: z.array(enumOf(ERROR_STEPS)).nonempty().optional(),
    method: z.array(enumOf(PAYMENT_METHODS)).nonempty().optional(),
    bank: z.array(z.string().min(1)).nonempty().optional(),
    causeClass: z.array(enumOf(CAUSE_CLASSES)).nonempty().optional(),
    caseType: z.array(enumOf(CASE_TYPES)).nonempty().optional(),
    amountBand: z.array(enumOf(AMOUNT_BANDS)).nonempty().optional(),
    attended: z.boolean().optional(),
  })
  .strict();

export type PolicyMatch = z.infer<typeof matchSchema>;

// ─── ladder rungs ────────────────────────────────────────────────────────────

const rungBase = {
  /** Offset from case detection, not from the previous rung. */
  at: duration,
  /** Free-text note explaining why this rung exists. Shows in the audit trail. */
  note: z.string().optional(),
};

export const nudgeRungSchema = z
  .object({
    ...rungBase,
    action: z.literal('nudge'),
    /** Ordered by preference; the channel layer takes the first eligible one. */
    channels: z.array(enumOf(CHANNELS)).nonempty(),
    intent: enumOf(MESSAGE_INTENTS),
    /** Omit to inherit the rails the diagnosis already worked out. */
    suggest: z.array(enumOf(ALTERNATE_RAILS)).optional(),
    attachPaymentLink: z.boolean().default(true),
  })
  .strict();

export const retryDebitRungSchema = z
  .object({
    ...rungBase,
    action: z.literal('retry_debit'),
  })
  .strict();

export const preDebitNoticeRungSchema = z
  .object({
    ...rungBase,
    action: z.literal('send_pre_debit_notice'),
    channels: z.array(enumOf(CHANNELS)).nonempty(),
    /** RBI requires notice ahead of an e-mandate debit. */
    leadTime: duration,
  })
  .strict();

export const awaitDowntimeRungSchema = z
  .object({
    ...rungBase,
    action: z.literal('await_downtime_resolution'),
    /** Fall through to the next rung if the bank has not recovered by then. */
    timeout: duration,
  })
  .strict();

export const merchantAlertRungSchema = z
  .object({
    ...rungBase,
    action: z.literal('merchant_alert'),
    severity: z.enum(['info', 'warning', 'critical']),
    /** Only fire once this many similar cases have accumulated. */
    minAffectedCases: z.number().int().min(1).default(1),
  })
  .strict();

export const escalateRungSchema = z
  .object({
    ...rungBase,
    action: z.literal('escalate_to_human'),
    queue: z.enum(['merchant_review', 'risk_review', 'ar_collections']),
  })
  .strict();

export const ladderRungSchema = z.discriminatedUnion('action', [
  nudgeRungSchema,
  retryDebitRungSchema,
  preDebitNoticeRungSchema,
  awaitDowntimeRungSchema,
  merchantAlertRungSchema,
  escalateRungSchema,
]);

export type LadderRung = z.infer<typeof ladderRungSchema>;
export type NudgeRung = z.infer<typeof nudgeRungSchema>;

// ─── preconditions and abort conditions ──────────────────────────────────────

/**
 * Gates re-checked immediately before EVERY rung fires — not once when the
 * ladder starts. The world changes while a case sleeps for six hours.
 */
export const PRECONDITIONS = [
  /** Re-fetch the order from Razorpay. Never trust local state before sending. */
  'order_unpaid',
  /** Do not interrupt someone who is mid-retry right now. */
  'no_live_attempt',
  'consent_ok',
  'not_quiet_hours',
  'within_frequency_cap',
  'merchant_budget_available',
  'channel_deliverable',
  'mandate_active',
] as const;
export type Precondition = (typeof PRECONDITIONS)[number];

/** Events that stop the ladder dead wherever it is. */
export const ABORT_CONDITIONS = [
  'order_paid',
  'payment_link_paid',
  'customer_optout',
  'subscription_cancelled',
  'invoice_cancelled',
  'merchant_disconnected',
  'deadline_passed',
] as const;
export type AbortCondition = (typeof ABORT_CONDITIONS)[number];

// ─── the row ─────────────────────────────────────────────────────────────────

export const policyRowSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/, 'ids are dot-separated lowercase, e.g. card_expired.attended'),
    /**
     * Bumped whenever a row's behaviour changes. Stamped onto every case at
     * resolution and never re-read, so a case that started under v3 finishes
     * under v3 even if the table is edited mid-flight.
     */
    version: z.number().int().min(1),
    description: z.string().min(10),

    match: matchSchema,
    ladder: z.array(ladderRungSchema),

    preconditions: z.array(enumOf(PRECONDITIONS)).default([]),
    abortOn: z.array(enumOf(ABORT_CONDITIONS)).default([]),

    /** Hard cap on customer touches. May be lower than the class allows, never higher. */
    maxMessages: z.number().int().min(0),
    /** Excluded from holdout — e.g. anything carrying a merchant breakage alert. */
    holdoutEligible: z.boolean().default(true),
    /**
     * Set on the single row that must match when nothing else does. Exactly one
     * row in the table carries it, and compile.ts refuses a table without one.
     */
    catchAll: z.boolean().default(false),
  })
  .strict();

export type PolicyRow = z.infer<typeof policyRowSchema>;

export const policyTableSchema = z.array(policyRowSchema).min(1);
