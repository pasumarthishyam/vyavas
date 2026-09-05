/**
 * Read-side queries for the discount-caller dashboard.
 *
 * Separate from `db/queries/dashboard.ts` on purpose — this agent has its own
 * page and its own idea of what's worth showing, and keeping the query file
 * apart is what keeps that boundary real rather than just organisational.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { recoveryCases } from '../schema/cases.js';
import { customers } from '../schema/customers.js';
import { voiceCalls } from '../schema/voice.js';
import { paiseFromColumn } from '../util.js';
import type { CaseState } from '../../core/case/types.js';
import { RESUME_MAX_AGE_DAYS } from '../../core/guards/resume.js';
import { MAX_CALLS_PER_CASE } from '../../core/guards/call-limit.js';

const num = paiseFromColumn;
const LIVE_STATES: CaseState[] = ['detected', 'diagnosed', 'executing', 'paused'];

export interface CallableCase {
  id: string;
  causeClass: string | null;
  errorReason: string | null;
  amountPaise: number;
  state: string;
  customerName: string | null;
  customerPhone: string | null;
  createdAt: Date;
  /** How many calls have already been placed for this case, most recent first not needed here. */
  callCount: number;
  /** Whole days since the payment failed. Drives the staleness warning. */
  ageDays: number;
  /**
   * Why this case cannot be called right now, or null when it can.
   *
   * Computed here rather than in the page so the list and the button agree, and
   * so the answer is the same one `/api/voice-agent/calls` enforces server-side.
   */
  blockedReason: string | null;
  /**
   * At or past the per-case call ceiling.
   *
   * Deliberately NOT folded into `blockedReason`. Those are hard stops — a
   * paused account, a failure too old to speak about — and this one is a
   * boundary a person is allowed to cross with their eyes open. Collapsing the
   * two would either forbid the override or turn every hard stop into a
   * suggestion. See `core/guards/call-limit.ts`.
   */
  needsCallOverride: boolean;
}

/**
 * Cases with a phone on file that this agent could act on.
 *
 * `paused` is one of the LIVE states, so this used to offer parked cases as
 * callable — a merchant who had switched the agent off was still invited to
 * place a discount call, and the route would have let them. A case is listed
 * with a reason now rather than silently dropped, because an operator looking
 * for a case they know exists should find it and be told why it is unavailable.
 */
export async function getCallableCases(db: Database, merchantId: string, limit = 100): Promise<CallableCase[]> {
  const rows = await db
    .select({
      id: recoveryCases.id,
      causeClass: recoveryCases.causeClass,
      errorReason: recoveryCases.errorReason,
      amount: recoveryCases.amountAtRiskPaise,
      state: recoveryCases.state,
      createdAt: recoveryCases.createdAt,
      customerName: customers.name,
      customerPhone: customers.phone,
      callCount: sql<number>`count(${voiceCalls.id})`,
    })
    .from(recoveryCases)
    .innerJoin(customers, eq(customers.id, recoveryCases.customerId))
    .leftJoin(voiceCalls, eq(voiceCalls.caseId, recoveryCases.id))
    .where(
      and(
        eq(recoveryCases.merchantId, merchantId),
        inArray(recoveryCases.state, LIVE_STATES),
        sql`${customers.phone} is not null`,
      ),
    )
    .groupBy(recoveryCases.id, customers.id)
    .orderBy(desc(recoveryCases.createdAt))
    .limit(limit);

  const now = Date.now();
  return rows.map((r) => {
    const ageDays = Math.max(0, Math.floor((now - r.createdAt.getTime()) / 86_400_000));
    return {
      id: r.id,
      causeClass: r.causeClass,
      errorReason: r.errorReason,
      amountPaise: num(r.amount),
      state: r.state,
      customerName: r.customerName,
      customerPhone: r.customerPhone,
      createdAt: r.createdAt,
      callCount: Number(r.callCount ?? 0),
      ageDays,
      blockedReason:
        r.state === 'paused'
          ? 'the agent is paused for this account'
          : ageDays > RESUME_MAX_AGE_DAYS
            ? `the payment failed ${ageDays} days ago`
            : null,
      needsCallOverride: Number(r.callCount ?? 0) >= MAX_CALLS_PER_CASE,
    };
  });
}

export interface VoiceCallRow {
  id: string;
  caseId: string;
  status: string;
  customerPhone: string;
  discountTierOffered: number;
  discountAmountPaise: number | null;
  paymentLinkUrl: string | null;
  paymentLinkAmountPaise: number | null;
  paymentConfirmedAt: Date | null;
  endedReason: string | null;
  durationSeconds: number | null;
  createdAt: Date;
}

export async function getRecentVoiceCallRows(db: Database, merchantId: string, limit = 50): Promise<VoiceCallRow[]> {
  const rows = await db
    .select()
    .from(voiceCalls)
    .where(eq(voiceCalls.merchantId, merchantId))
    .orderBy(desc(voiceCalls.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    caseId: r.caseId,
    status: r.status,
    customerPhone: r.customerPhone,
    discountTierOffered: r.discountTierOffered,
    discountAmountPaise: r.discountAmountPaise,
    paymentLinkUrl: r.paymentLinkUrl,
    paymentLinkAmountPaise: r.paymentLinkAmountPaise,
    paymentConfirmedAt: r.paymentConfirmedAt,
    endedReason: r.endedReason,
    durationSeconds: r.durationSeconds,
    createdAt: r.createdAt,
  }));
}
