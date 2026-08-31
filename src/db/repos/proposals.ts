/**
 * Taxonomy proposals.
 *
 * One PENDING row per unknown reason, enforced by a partial unique index. The
 * triage job runs repeatedly over a growing sample, so re-running it must
 * sharpen the open proposal rather than stack a second one behind it — the same
 * shape as the open-alert-per-condition guard on `merchant_alerts`.
 *
 * A proposal that has been accepted or rejected is never touched again. It is
 * the record of a decision, and a later run producing a different answer is a
 * new proposal, not an edit to the old one.
 */

import { and, desc, eq, sql } from 'drizzle-orm';

import type { CauseClass } from '../../core/taxonomy/cause-class.js';
import type { Database } from '../client.js';
import { taxonomyProposals } from '../schema/queues.js';

export interface UpsertProposalInput {
  rawErrorReason: string;
  proposedCauseClass: CauseClass;
  confidence: string;
  reasoning: string;
  proposedRuleId: string;
  disambiguationNote?: string | null;
  sameInstrumentRetrySafe: boolean;
  reviewerShouldVerify?: string | null;

  occurrences: number;
  distinctMerchants: number;
  eventuallyPaidCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** The sampled tuples, verbatim, so a review can be redone from the evidence. */
  evidence: unknown;
}

/**
 * Record a proposal, or refresh the open one.
 *
 * The conflict target is the partial unique index on `(raw_error_reason) WHERE
 * status = 'pending'`, so an accepted or rejected row for the same reason does
 * not block a fresh proposal — which is the behaviour we want when a rejected
 * classification starts looking different at ten times the sample size.
 */
export async function upsertProposal(db: Database, input: UpsertProposalInput): Promise<string> {
  const values = {
    rawErrorReason: input.rawErrorReason,
    proposedCauseClass: input.proposedCauseClass,
    confidence: input.confidence,
    reasoning: input.reasoning,
    proposedRuleId: input.proposedRuleId,
    disambiguationNote: input.disambiguationNote ?? null,
    sameInstrumentRetrySafe: input.sameInstrumentRetrySafe,
    reviewerShouldVerify: input.reviewerShouldVerify ?? null,
    occurrences: input.occurrences,
    distinctMerchants: input.distinctMerchants,
    eventuallyPaidCount: input.eventuallyPaidCount,
    firstSeenAt: input.firstSeenAt,
    lastSeenAt: input.lastSeenAt,
    evidence: input.evidence as never,
  };

  const rows = await db
    .insert(taxonomyProposals)
    .values(values)
    .onConflictDoUpdate({
      target: taxonomyProposals.rawErrorReason,
      targetWhere: sql`status = 'pending'`,
      set: {
        proposedCauseClass: values.proposedCauseClass,
        confidence: values.confidence,
        reasoning: values.reasoning,
        proposedRuleId: values.proposedRuleId,
        disambiguationNote: values.disambiguationNote,
        sameInstrumentRetrySafe: values.sameInstrumentRetrySafe,
        reviewerShouldVerify: values.reviewerShouldVerify,
        occurrences: values.occurrences,
        distinctMerchants: values.distinctMerchants,
        eventuallyPaidCount: values.eventuallyPaidCount,
        lastSeenAt: values.lastSeenAt,
        evidence: values.evidence,
      },
    })
    .returning({ id: taxonomyProposals.id });

  const id = rows.at(0)?.id;
  if (!id) throw new Error(`Failed to record a proposal for '${input.rawErrorReason}'`);
  return id;
}

export interface PendingProposal {
  id: string;
  rawErrorReason: string;
  proposedCauseClass: CauseClass;
  confidence: string;
  reasoning: string;
  proposedRuleId: string;
  disambiguationNote: string | null;
  sameInstrumentRetrySafe: boolean;
  reviewerShouldVerify: string | null;
  occurrences: number;
  distinctMerchants: number;
  eventuallyPaidCount: number;
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
  createdAt: Date;
}

/** Most-seen first: the reason costing the most money is the one to review. */
export async function listPendingProposals(
  db: Database,
  limit = 50,
): Promise<PendingProposal[]> {
  const rows = await db
    .select()
    .from(taxonomyProposals)
    .where(eq(taxonomyProposals.status, 'pending'))
    .orderBy(desc(taxonomyProposals.occurrences), desc(taxonomyProposals.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    rawErrorReason: r.rawErrorReason,
    proposedCauseClass: r.proposedCauseClass,
    confidence: r.confidence,
    reasoning: r.reasoning,
    proposedRuleId: r.proposedRuleId,
    disambiguationNote: r.disambiguationNote,
    sameInstrumentRetrySafe: r.sameInstrumentRetrySafe,
    reviewerShouldVerify: r.reviewerShouldVerify,
    occurrences: r.occurrences,
    distinctMerchants: r.distinctMerchants,
    eventuallyPaidCount: r.eventuallyPaidCount,
    firstSeenAt: r.firstSeenAt,
    lastSeenAt: r.lastSeenAt,
    createdAt: r.createdAt,
  }));
}

/**
 * Record a human's decision.
 *
 * Accepting changes NOTHING in the taxonomy. It marks that a person read the
 * proposal and intends to write the rule; the rule itself is hand-written into
 * `codes.ts` or `diagnose.ts`, reviewed, and shipped with a golden fixture like
 * every other entry. There is deliberately no code path from here to there.
 */
export async function reviewProposal(
  db: Database,
  id: string,
  decision: 'accepted' | 'rejected',
  reviewedBy: string,
  note: string,
): Promise<boolean> {
  const rows = await db
    .update(taxonomyProposals)
    .set({ status: decision, reviewedBy, reviewNote: note, reviewedAt: sql`now()` })
    .where(and(eq(taxonomyProposals.id, id), eq(taxonomyProposals.status, 'pending')))
    .returning({ id: taxonomyProposals.id });
  return rows.length > 0;
}
