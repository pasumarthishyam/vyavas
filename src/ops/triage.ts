/**
 * Triage for failure reasons the taxonomy does not know.
 *
 * A Razorpay reason we have no descriptor for lands on `unknown_reason` with
 * `confidence: 'low'`, and the original string is preserved in
 * `raw_error_reason`. That is the correct SAFE behaviour: the case still gets a
 * cautious ladder and nothing indefensible happens.
 *
 * It is also completely silent. A new code that starts costing money on Monday
 * looks exactly like a quiet week until somebody goes looking, and nobody goes
 * looking.
 *
 * This job groups the unknowns, samples them, asks Claude what each one looks
 * like, and writes a PROPOSAL. Nothing is applied. Accepting a proposal means a
 * person hand-writes the rule into `codes.ts` with a golden fixture, like every
 * other entry in the taxonomy — see `db/schema/queues.ts` for why that boundary
 * is not negotiable.
 */

import { sql } from 'drizzle-orm';

import type { CauseClass } from '../core/taxonomy/cause-class.js';
import type { Database } from '../db/client.js';
import { upsertProposal } from '../db/repos/proposals.js';
import { type TriageFacts, type UnknownSample, triageUnknownReason } from '../adapters/claude/index.js';

/**
 * Below this many occurrences, there is nothing to reason from.
 *
 * A model asked to classify a string it has seen twice will produce a confident
 * paragraph anyway, and a reviewer will read it. Two is not a pattern; leaving
 * the reason untriaged until it recurs is the honest answer.
 */
const MIN_OCCURRENCES = 3;
/** Enough to show the shape of the tuple space without paying for a hundred rows. */
const SAMPLES_PER_REASON = 25;

/** Postgres returns rows differently through postgres.js and PGlite. */
function rowsOf(result: unknown): Record<string, unknown>[] {
  const list = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
  return list as Record<string, unknown>[];
}

export interface UnknownGroup {
  rawErrorReason: string;
  occurrences: number;
  distinctMerchants: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  eventuallyPaidCount: number;
}

/**
 * Unknown reasons worth triaging, most frequent first.
 *
 * Deliberately restricted to cases the taxonomy actually failed on
 * (`error_reason = 'unknown_reason'`) rather than everything with low
 * confidence. A known-but-ambiguous reason is a disambiguation-rule question,
 * which is a different and much more delicate change than adding a descriptor.
 */
export async function findUnknownReasons(
  db: Database,
  opts: { sinceDays?: number; limit?: number } = {},
): Promise<UnknownGroup[]> {
  const sinceDays = opts.sinceDays ?? 30;

  const result = await db.execute(sql`
    select
      raw_error_reason                                             as reason,
      count(*)::int                                                as occurrences,
      count(distinct merchant_id)::int                             as merchants,
      min(created_at)                                              as first_seen,
      max(created_at)                                              as last_seen,
      count(*) filter (where state = 'recovered')::int             as eventually_paid
    from recovery_cases
    where error_reason = 'unknown_reason'
      and raw_error_reason is not null
      and raw_error_reason <> ''
      and created_at > now() - make_interval(days => ${sinceDays}::int)
    group by raw_error_reason
    having count(*) >= ${MIN_OCCURRENCES}
    order by count(*) desc
    limit ${opts.limit ?? 20}
  `);

  return rowsOf(result).map((r) => ({
    rawErrorReason: String(r.reason),
    occurrences: Number(r.occurrences ?? 0),
    distinctMerchants: Number(r.merchants ?? 0),
    firstSeenAt: new Date(r.first_seen as string),
    lastSeenAt: new Date(r.last_seen as string),
    eventuallyPaidCount: Number(r.eventually_paid ?? 0),
  }));
}

/** The observed tuples behind one unknown reason. */
export async function sampleUnknownReason(
  db: Database,
  rawErrorReason: string,
  limit = SAMPLES_PER_REASON,
): Promise<UnknownSample[]> {
  const result = await db.execute(sql`
    select
      raw_error_reason, error_code, error_source, error_step,
      method, bank, network,
      state = 'recovered' as eventually_paid
    from recovery_cases
    where error_reason = 'unknown_reason'
      and raw_error_reason = ${rawErrorReason}
    order by created_at desc
    limit ${limit}
  `);

  return rowsOf(result).map((r) => ({
    rawErrorReason: (r.raw_error_reason as string | null) ?? null,
    errorCode: (r.error_code as string | null) ?? null,
    errorSource: (r.error_source as string | null) ?? null,
    errorStep: (r.error_step as string | null) ?? null,
    method: String(r.method ?? 'unknown'),
    bank: (r.bank as string | null) ?? null,
    network: (r.network as string | null) ?? null,
    // Razorpay's own description is not persisted on the case; the tuple is
    // what we kept. Named here so the prompt's field list stays honest about
    // what is absent rather than silently omitting it.
    description: null,
    eventuallyPaid: r.eventually_paid === true,
  }));
}

export interface TriageOutcome {
  rawErrorReason: string;
  occurrences: number;
  status: 'proposed' | 'failed';
  proposalId: string | null;
  proposedCauseClass: CauseClass | null;
  confidence: string | null;
  error: string | null;
}

/**
 * Run the triage over every unknown reason worth looking at.
 *
 * One reason failing does not stop the others: a rate limit halfway through a
 * batch should cost that reason's proposal, not the whole run.
 */
export async function runTriage(
  db: Database,
  opts: { sinceDays?: number; limit?: number } = {},
): Promise<TriageOutcome[]> {
  const groups = await findUnknownReasons(db, opts);
  const outcomes: TriageOutcome[] = [];

  for (const group of groups) {
    const samples = await sampleUnknownReason(db, group.rawErrorReason);

    const facts: TriageFacts = {
      rawErrorReason: group.rawErrorReason,
      occurrences: group.occurrences,
      distinctMerchants: group.distinctMerchants,
      firstSeenAt: group.firstSeenAt,
      lastSeenAt: group.lastSeenAt,
      currentCauseClass: 'unknown_reason (no descriptor — falls through to the cautious ladder)',
      samples,
      eventuallyPaidCount: group.eventuallyPaidCount,
    };

    const proposed = await triageUnknownReason(facts);

    if (!proposed.ok) {
      outcomes.push({
        rawErrorReason: group.rawErrorReason,
        occurrences: group.occurrences,
        status: 'failed',
        proposalId: null,
        proposedCauseClass: null,
        confidence: null,
        error: `${proposed.error.failure}: ${proposed.error.detail}`,
      });
      continue;
    }

    const p = proposed.value;
    const id = await upsertProposal(db, {
      rawErrorReason: group.rawErrorReason,
      proposedCauseClass: p.proposedCauseClass as CauseClass,
      confidence: p.confidence,
      reasoning: p.reasoning,
      proposedRuleId: p.proposedRuleId,
      disambiguationNote: p.disambiguationNote,
      sameInstrumentRetrySafe: p.sameInstrumentRetrySafe,
      reviewerShouldVerify: p.reviewerShouldVerify,
      occurrences: group.occurrences,
      distinctMerchants: group.distinctMerchants,
      eventuallyPaidCount: group.eventuallyPaidCount,
      firstSeenAt: group.firstSeenAt,
      lastSeenAt: group.lastSeenAt,
      evidence: samples,
    });

    outcomes.push({
      rawErrorReason: group.rawErrorReason,
      occurrences: group.occurrences,
      status: 'proposed',
      proposalId: id,
      proposedCauseClass: p.proposedCauseClass as CauseClass,
      confidence: p.confidence,
      error: null,
    });
  }

  return outcomes;
}
