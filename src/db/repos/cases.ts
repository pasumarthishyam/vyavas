/**
 * The case repository.
 *
 * Two things here are worth reading carefully:
 *
 *  1. `transitionCase` runs core's state machine BEFORE it writes. The database
 *     is not a second source of truth about what transitions are legal — core
 *     decides, the database records. That is what keeps "a recovered case never
 *     reopens" a single rule rather than two rules that can disagree.
 *
 *  2. `createCase` leans on the partial unique index rather than checking first.
 *     A SELECT-then-INSERT would race between two failed attempts on the same
 *     order arriving milliseconds apart, and the customer would get two ladders.
 */

import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';

import type { CaseState, CaseType, Cohort } from '../../core/case/types.js';
import { transition, type TransitionReason } from '../../core/case/machine.js';
import type { CauseClass } from '../../core/taxonomy/cause-class.js';
import type { Database } from '../client.js';
import { caseEvents, paymentAttempts, recoveryCases } from '../schema/cases.js';

const LIVE_STATES: CaseState[] = ['detected', 'diagnosed', 'executing', 'paused'];

export interface CreateCaseInput {
  merchantId: string;
  customerId: string | null;
  type: CaseType;
  amountAtRiskPaise: number;
  currency?: string;

  rzpOrderId?: string | null;
  rzpPaymentId?: string | null;
  rzpInvoiceId?: string | null;
  rzpSubscriptionId?: string | null;

  errorCode?: string | null;
  errorSource?: string | null;
  errorStep?: string | null;
  errorReason?: string | null;
  rawErrorReason?: string | null;
  method?: string;
  bank?: string | null;
  network?: string | null;

  causeClass?: CauseClass | null;
  confidence?: string | null;
  diagnosisRationale?: readonly string[] | null;
  attended: boolean;
  mandateId?: string | null;

  policyId?: string | null;
  policyVersion?: number | null;
  cohort?: Cohort;
  deadlineAt?: Date | null;
}

/**
 * Create a case, or return the existing live one for this order.
 *
 * Idempotent by construction: the partial unique index on live cases per order
 * makes a duplicate insert a no-op, and we then read back the incumbent.
 */
export async function createCase(
  db: Database,
  input: CreateCaseInput,
): Promise<{ id: string; created: boolean }> {
  const values = {
    merchantId: input.merchantId,
    customerId: input.customerId,
    type: input.type,
    amountAtRiskPaise: input.amountAtRiskPaise,
    currency: input.currency ?? 'INR',
    rzpOrderId: input.rzpOrderId ?? null,
    rzpPaymentId: input.rzpPaymentId ?? null,
    rzpInvoiceId: input.rzpInvoiceId ?? null,
    rzpSubscriptionId: input.rzpSubscriptionId ?? null,
    errorCode: input.errorCode ?? null,
    errorSource: (input.errorSource ?? null) as never,
    errorStep: (input.errorStep ?? null) as never,
    errorReason: input.errorReason ?? null,
    rawErrorReason: input.rawErrorReason ?? null,
    method: (input.method ?? 'unknown') as never,
    bank: input.bank ?? null,
    network: input.network ?? null,
    causeClass: (input.causeClass ?? null) as never,
    confidence: input.confidence ?? null,
    diagnosisRationale: (input.diagnosisRationale ?? null) as never,
    attended: input.attended,
    mandateId: input.mandateId ?? null,
    policyId: input.policyId ?? null,
    policyVersion: input.policyVersion ?? null,
    cohort: input.cohort ?? 'treatment',
    deadlineAt: input.deadlineAt ?? null,
  };

  const inserted = await db
    .insert(recoveryCases)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: recoveryCases.id });

  const row = inserted.at(0);
  if (row) {
    await appendEvent(db, {
      caseId: row.id,
      merchantId: input.merchantId,
      kind: 'detected',
      toState: 'detected',
      actor: 'webhook',
      payload: { amountAtRiskPaise: input.amountAtRiskPaise, errorReason: input.errorReason },
    });
    return { id: row.id, created: true };
  }

  const existing = await findLiveCaseForOrder(db, input.merchantId, input.rzpOrderId ?? null);
  if (!existing) {
    throw new Error(
      'Case insert conflicted but no live case was found. This means a unique index other ' +
        'than the live-order guard rejected the row — inspect the input rather than retrying.',
    );
  }
  return { id: existing.id, created: false };
}

export async function findLiveCaseForOrder(
  db: Database,
  merchantId: string,
  rzpOrderId: string | null,
) {
  if (!rzpOrderId) return null;
  const rows = await db
    .select()
    .from(recoveryCases)
    .where(
      and(
        eq(recoveryCases.merchantId, merchantId),
        eq(recoveryCases.rzpOrderId, rzpOrderId),
        inArray(recoveryCases.state, LIVE_STATES),
      ),
    )
    .limit(1);
  return rows.at(0) ?? null;
}

export async function getCase(db: Database, caseId: string) {
  const rows = await db.select().from(recoveryCases).where(eq(recoveryCases.id, caseId)).limit(1);
  return rows.at(0) ?? null;
}

export interface TransitionResult {
  ok: boolean;
  from: CaseState;
  to: CaseState;
  reason: string;
}

/**
 * Move a case to a new state.
 *
 * Core's state machine validates first; the UPDATE then re-asserts the observed
 * state in its WHERE clause, so a concurrent transition loses rather than
 * silently overwriting. Returns `ok: false` on a lost race — which is an
 * ordinary outcome (two workers seeing one payment), not an error.
 */
export async function transitionCase(
  db: Database,
  caseId: string,
  to: CaseState,
  reason: TransitionReason,
  extra: { recoveredAmountPaise?: number | null; actor?: string } = {},
): Promise<TransitionResult> {
  const current = await getCase(db, caseId);
  if (!current) throw new Error(`Case ${caseId} not found`);

  const check = transition(current.state, to, reason);
  if (!check.ok) {
    return { ok: false, from: current.state, to, reason: check.error.message };
  }

  const isTerminal = to === 'recovered' || to === 'lost' || to === 'aborted';

  const updated = await db
    .update(recoveryCases)
    .set({
      state: to,
      updatedAt: sql`now()`,
      ...(isTerminal ? { resolvedAt: sql`now()` } : {}),
      ...(extra.recoveredAmountPaise != null
        ? { recoveredAmountPaise: extra.recoveredAmountPaise }
        : {}),
    })
    // Optimistic concurrency: only move if the state is still what we read.
    .where(and(eq(recoveryCases.id, caseId), eq(recoveryCases.state, current.state)))
    .returning({ id: recoveryCases.id });

  if (updated.length === 0) {
    return {
      ok: false,
      from: current.state,
      to,
      reason: 'lost a concurrent transition race; another worker moved this case first',
    };
  }

  await appendEvent(db, {
    caseId,
    merchantId: current.merchantId,
    kind: 'state_changed',
    fromState: current.state,
    toState: to,
    reason,
    actor: extra.actor ?? 'workflow',
  });

  return { ok: true, from: current.state, to, reason };
}

export interface AppendEventInput {
  caseId: string;
  merchantId: string;
  kind: string;
  fromState?: CaseState | null;
  toState?: CaseState | null;
  reason?: string | null;
  actor?: string;
  payload?: unknown;
}

/** Append-only. Never updated, never deleted. */
export async function appendEvent(db: Database, input: AppendEventInput): Promise<void> {
  await db.insert(caseEvents).values({
    caseId: input.caseId,
    merchantId: input.merchantId,
    kind: input.kind,
    fromState: (input.fromState ?? null) as never,
    toState: (input.toState ?? null) as never,
    reason: input.reason ?? null,
    actor: input.actor ?? 'system',
    payload: (input.payload ?? null) as never,
  });
}

export async function listCaseEvents(db: Database, caseId: string) {
  return db
    .select()
    .from(caseEvents)
    .where(eq(caseEvents.caseId, caseId))
    .orderBy(caseEvents.occurredAt);
}

/**
 * Prior attempts on an order, for `DiagnoseContext.priorAttempts`.
 *
 * This is what withdraws same-instrument retry before a third wrong OTP costs
 * the customer their card.
 */
export async function listAttemptsForOrder(
  db: Database,
  merchantId: string,
  rzpOrderId: string,
) {
  return db
    .select()
    .from(paymentAttempts)
    .where(
      and(eq(paymentAttempts.merchantId, merchantId), eq(paymentAttempts.rzpOrderId, rzpOrderId)),
    )
    .orderBy(paymentAttempts.attemptedAt);
}

export async function recordAttempt(
  db: Database,
  input: {
    merchantId: string;
    caseId?: string | null;
    rzpOrderId: string | null;
    rzpPaymentId: string;
    method?: string;
    errorReason?: string | null;
    errorSource?: string | null;
    bank?: string | null;
    succeeded?: boolean;
    amountPaise: number;
    attemptedAt: Date;
  },
): Promise<void> {
  await db
    .insert(paymentAttempts)
    .values({
      merchantId: input.merchantId,
      caseId: input.caseId ?? null,
      rzpOrderId: input.rzpOrderId,
      rzpPaymentId: input.rzpPaymentId,
      method: (input.method ?? 'unknown') as never,
      errorReason: input.errorReason ?? null,
      errorSource: (input.errorSource ?? null) as never,
      bank: input.bank ?? null,
      succeeded: input.succeeded ?? false,
      amountPaise: input.amountPaise,
      attemptedAt: input.attemptedAt,
    })
    .onConflictDoNothing({
      target: [paymentAttempts.merchantId, paymentAttempts.rzpPaymentId],
    });
}

/**
 * Has this customer tried to pay in the last few minutes?
 *
 * The live-attempt lock. Messaging someone who is mid-retry on another card is
 * worse than saying nothing.
 */
export async function hasLiveAttempt(
  db: Database,
  merchantId: string,
  rzpOrderId: string,
  withinMinutes: number,
): Promise<boolean> {
  const rows = await db
    .select({ id: paymentAttempts.id })
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.merchantId, merchantId),
        eq(paymentAttempts.rzpOrderId, rzpOrderId),
        sql`${paymentAttempts.attemptedAt} > now() - make_interval(mins => ${withinMinutes})`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Live cases past their deadline.
 *
 * `FOR UPDATE SKIP LOCKED` lets many workers sweep in parallel without two of
 * them claiming the same case — the standard queue-claim pattern, and one
 * Drizzle expresses directly.
 */
export async function claimExpiredCases(db: Database, limit = 100) {
  return db
    .select()
    .from(recoveryCases)
    .where(
      and(
        inArray(recoveryCases.state, LIVE_STATES),
        lt(recoveryCases.deadlineAt, sql`now()`),
        isNull(recoveryCases.resolvedAt),
      ),
    )
    .limit(limit)
    .for('update', { skipLocked: true });
}
