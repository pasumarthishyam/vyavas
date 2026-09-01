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
}

/** Live cases with a phone on file — the pool this agent can act on at all. */
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

  return rows.map((r) => ({
    id: r.id,
    causeClass: r.causeClass,
    errorReason: r.errorReason,
    amountPaise: num(r.amount),
    state: r.state,
    customerName: r.customerName,
    customerPhone: r.customerPhone,
    createdAt: r.createdAt,
    callCount: Number(r.callCount ?? 0),
  }));
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
