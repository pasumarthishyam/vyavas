/**
 * One case, in full.
 *
 * The detail view is the merchant's window into a decision the agent made on
 * their behalf, so it shows the whole chain: the raw tuple, the cause class it
 * resolved to, the rationale in plain language, and — crucially — **the ladder
 * that would run**.
 *
 * That last part is what makes Stage 5 shippable on its own. A merchant can see
 * exactly what we would have said, to whom, and when, before granting write
 * access to anything.
 */

import { asc, eq } from 'drizzle-orm';

import type { Database } from '../client.js';
import { paiseFromColumn } from '../util.js';
import { caseActions, caseEvents, recoveryCases } from '../schema/cases.js';
import { customers } from '../schema/customers.js';
import { POLICY_TABLE } from '../../core/policy/index.js';
import type { PolicyRow } from '../../core/policy/schema.js';

export interface CaseEventRow {
  id: string;
  kind: string;
  fromState: string | null;
  toState: string | null;
  reason: string | null;
  actor: string;
  payload: Record<string, unknown> | null;
  occurredAt: Date;
}

export interface CaseDetail {
  id: string;
  merchantId: string;
  state: string;
  type: string;
  amountPaise: number;
  currency: string;

  rzpOrderId: string | null;
  rzpPaymentId: string | null;

  errorCode: string | null;
  errorSource: string | null;
  errorStep: string | null;
  errorReason: string | null;
  rawErrorReason: string | null;
  method: string;
  bank: string | null;
  network: string | null;

  causeClass: string | null;
  confidence: string | null;
  rationale: string[];
  attended: boolean;
  cohort: string;

  policyId: string | null;
  policyVersion: number | null;
  /** The resolved ladder, if the stamped policy still exists in the table. */
  policy: PolicyRow | null;

  createdAt: Date;
  deadlineAt: Date | null;
  resolvedAt: Date | null;
  recoveredAmountPaise: number | null;

  customerContact: string | null;
  customerLocale: string | null;
  customerOptedOut: boolean;

  events: CaseEventRow[];
  plannedActions: number;
}

export async function getCaseDetail(db: Database, caseId: string): Promise<CaseDetail | null> {
  const rows = await db
    .select({
      c: recoveryCases,
      phone: customers.phone,
      email: customers.email,
      locale: customers.locale,
      optedOutAt: customers.optedOutAt,
    })
    .from(recoveryCases)
    .leftJoin(customers, eq(customers.id, recoveryCases.customerId))
    .where(eq(recoveryCases.id, caseId))
    .limit(1);

  const row = rows.at(0);
  if (!row) return null;
  const c = row.c;

  const events = await db
    .select()
    .from(caseEvents)
    .where(eq(caseEvents.caseId, caseId))
    .orderBy(asc(caseEvents.occurredAt));

  const actions = await db.select().from(caseActions).where(eq(caseActions.caseId, caseId));

  // The policy is looked up by the id STAMPED on the case, not re-resolved.
  // A case that started under one ladder finishes under it, even if the table
  // has since been edited — so the detail view has to show the same thing.
  const policy = c.policyId ? (POLICY_TABLE.find((p) => p.id === c.policyId) ?? null) : null;

  return {
    id: c.id,
    merchantId: c.merchantId,
    state: c.state,
    type: c.type,
    amountPaise: paiseFromColumn(c.amountAtRiskPaise),
    currency: c.currency,
    rzpOrderId: c.rzpOrderId,
    rzpPaymentId: c.rzpPaymentId,
    errorCode: c.errorCode,
    errorSource: c.errorSource,
    errorStep: c.errorStep,
    errorReason: c.errorReason,
    rawErrorReason: c.rawErrorReason,
    method: c.method,
    bank: c.bank,
    network: c.network,
    causeClass: c.causeClass,
    confidence: c.confidence,
    rationale: Array.isArray(c.diagnosisRationale) ? (c.diagnosisRationale as string[]) : [],
    attended: c.attended,
    cohort: c.cohort,
    policyId: c.policyId,
    policyVersion: c.policyVersion,
    policy,
    createdAt: c.createdAt,
    deadlineAt: c.deadlineAt,
    resolvedAt: c.resolvedAt,
    recoveredAmountPaise:
      c.recoveredAmountPaise == null ? null : paiseFromColumn(c.recoveredAmountPaise),
    customerContact: maskContact(row.phone, row.email),
    customerLocale: row.locale,
    customerOptedOut: row.optedOutAt != null,
    events: events.map((e) => ({
      id: e.id,
      kind: e.kind,
      fromState: e.fromState,
      toState: e.toState,
      reason: e.reason,
      actor: e.actor,
      payload: (e.payload as Record<string, unknown> | null) ?? null,
      occurredAt: e.occurredAt,
    })),
    plannedActions: actions.length,
  };
}

function maskContact(phone: string | null, email: string | null): string | null {
  if (phone) return `${phone.slice(0, 3)}•••••${phone.slice(-4)}`;
  if (email) {
    const [user, domain] = email.split('@');
    if (!user || !domain) return null;
    return `${user.slice(0, 2)}•••@${domain}`;
  }
  return null;
}
