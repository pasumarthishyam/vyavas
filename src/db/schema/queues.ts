/**
 * The two human-in-the-loop queues.
 *
 * Both exist because the agent produced something it is not allowed to act on
 * by itself, and both are read by a person. Neither is ever consumed by the
 * agent: there is no code path that reads an accepted proposal and changes the
 * taxonomy, and none that reads a recommended action and executes it.
 *
 * That is the whole design. Everything Claude writes in this system lands in
 * one of these two tables or on `merchant_alerts`, and all three are terminal
 * as far as the agent is concerned.
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

import { merchants } from './tenancy.js';
import { recoveryCases } from './cases.js';
import {
  causeClassEnum,
  escalationQueueEnum,
  escalationStatusEnum,
  proposalStatusEnum,
} from './enums.js';

/**
 * Cases the ladder handed to a person.
 *
 * Before this table, `escalate_to_human` built an action, wrote a
 * `case_actions` row, and that was the end of it — no queue, no notification,
 * no UI. `risk.payment_risk_check_failed` escalated to `risk_review` and nobody
 * was ever told.
 *
 * The brief columns are denormalised prose rather than a join, because the
 * queue list has to be readable without opening anything, and because the brief
 * is a point-in-time reading of the case: regenerating it a week later against
 * a mutated ledger would describe a different case than the one a person was
 * asked to look at.
 */
export const escalations = pgTable(
  'escalations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => recoveryCases.id, { onDelete: 'cascade' }),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),

    queue: escalationQueueEnum('queue').notNull(),
    status: escalationStatusEnum('status').notNull().default('open'),
    rung: smallint('rung').notNull().default(0),

    /**
     * `${caseId}:${rung}:escalate_to_human`, from `idempotencyKey()` in core.
     *
     * The SAME key the action row uses, built by the SAME function. A workflow
     * replay after a deploy must not produce a second queue entry for one rung,
     * and a key format that lives in two places is a key format that will
     * disagree — the comment on `messageKey` exists because that already
     * happened once here.
     */
    idempotencyKey: text('idempotency_key').notNull(),

    // ── the brief ──
    headline: text('headline').notNull(),
    whatHappened: text('what_happened'),
    whatWeTried: text('what_we_tried'),
    whatIsBlocking: text('what_is_blocking'),
    /** Advice to the reader. Nothing automated consumes this. */
    recommendedAction: text('recommended_action'),
    briefConfidence: text('brief_confidence'),

    /**
     * `claude` or `fallback`.
     *
     * Recorded because a reader weighs a written brief differently from a
     * generated stub, and because a week of nothing but `fallback` is how you
     * find out the API key expired.
     */
    briefSource: text('brief_source').notNull().default('fallback'),
    /** Why the fallback was used, when it was. */
    briefError: text('brief_error'),

    // ── denormalised so the queue list needs no joins ──
    amountAtRiskPaise: bigint('amount_at_risk_paise', { mode: 'number' }).notNull().default(0),
    causeClass: causeClassEnum('cause_class'),

    assignedTo: text('assigned_to'),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolutionNote: text('resolution_note'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One escalation per rung, ever. Same guard as case_actions and message_log.
    uniqueIndex('escalations_idempotency_key').on(t.idempotencyKey),
    // The queue view: open work for one merchant, oldest first.
    index('escalations_open_idx')
      .on(t.merchantId, t.queue, t.createdAt)
      .where(sql`status in ('open','acknowledged')`),
    index('escalations_case_idx').on(t.caseId),
  ],
);

/**
 * Proposed taxonomy entries for failure reasons we do not know.
 *
 * NOTHING READS THIS BACK. There is deliberately no code path from an accepted
 * proposal to a change in `codes.ts` or `diagnose.ts` — accepting one means a
 * person opens an editor and writes the rule by hand.
 *
 * The taxonomy is the safety ceiling for the entire agent: `sameInstrumentRetry`
 * and `contactCustomer` are derived from the cause class, so a wrong class here
 * would not produce a badly worded message, it would produce a customer's card
 * locked at the issuer after a third automated retry. That is not a decision to
 * automate on a model's confidence score.
 */
export const taxonomyProposals = pgTable(
  'taxonomy_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** The unknown string being classified. The group key for the evidence. */
    rawErrorReason: text('raw_error_reason').notNull(),
    status: proposalStatusEnum('status').notNull().default('pending'),

    proposedCauseClass: causeClassEnum('proposed_cause_class').notNull(),
    confidence: text('confidence').notNull(),
    reasoning: text('reasoning').notNull(),
    proposedRuleId: text('proposed_rule_id').notNull(),
    disambiguationNote: text('disambiguation_note'),
    /** The field with teeth. Asked for explicitly so a reviewer sees it stated. */
    sameInstrumentRetrySafe: boolean('same_instrument_retry_safe').notNull().default(false),
    reviewerShouldVerify: text('reviewer_should_verify'),

    // ── the evidence the proposal was made from ──
    occurrences: integer('occurrences').notNull().default(0),
    distinctMerchants: integer('distinct_merchants').notNull().default(0),
    eventuallyPaidCount: integer('eventually_paid_count').notNull().default(0),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    /** The sampled tuples, stored verbatim so a review can be re-done later. */
    evidence: jsonb('evidence'),

    reviewedBy: text('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewNote: text('review_note'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One PENDING proposal per unknown reason. Re-running the triage job
    // refreshes the open proposal rather than stacking a new one behind it —
    // the same shape as the open-alert-per-condition guard on merchant_alerts.
    uniqueIndex('taxonomy_proposals_pending_key')
      .on(t.rawErrorReason)
      .where(sql`status = 'pending'`),
    index('taxonomy_proposals_status_idx').on(t.status, t.createdAt),
  ],
);
