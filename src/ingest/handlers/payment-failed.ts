/**
 * `payment.failed` — the main event.
 *
 * This is where the whole brain finally runs against real data:
 *
 *   normalize  raw entity           -> closed ErrorTuple
 *   context    attempts + downtime  -> what the diagnosis needs to know
 *   diagnose   tuple + context      -> cause class, attended?, rails, deadline
 *   resolve    diagnosis            -> the ladder that applies
 *   persist    all of it            -> one case, one ledger entry, stamped policy
 *
 * The handler is deliberately dumb: it sequences those steps and writes the
 * result. Every judgement it appears to make was actually made in `core`, where
 * it is pure and testable without a database.
 */

import { assignCohort, isHoldoutEligible } from '../../core/cohort.js';
import { normalizeFailure } from '../../core/taxonomy/normalize.js';
import { type AttemptRecord, diagnose } from '../../core/taxonomy/diagnose.js';
import { matchInputFrom, resolvePolicy } from '../../core/policy/resolve.js';
import { POLICY_TABLE } from '../../core/policy/index.js';
import type { CaseType, Cohort, PaymentMethod } from '../../core/case/types.js';

import type { Database } from '../../db/client.js';
import {
  appendEvent,
  createCase,
  findActiveDowntime,
  listAttemptsForOrder,
  recordAttempt,
  transitionCase,
  upsertCustomer,
} from '../../db/repos/index.js';
import type { RazorpayPaymentEntity } from '../../adapters/razorpay/types.js';

/**
 * The seam between ingest and the durable engine.
 *
 * An interface rather than a direct Inngest import, so the whole pipeline stays
 * testable without a workflow engine running — the ingest tests omit it and
 * assert on the returned result, exactly as they did before.
 *
 * It is optional, but omitting it in production means a case is diagnosed,
 * stamped with a ladder, and then nothing ever runs it. That was the actual
 * state of this system: `publishCaseDiagnosed` existed with zero callers, so
 * every ladder was fully built and never started.
 */
export interface WorkflowPublisher {
  caseDiagnosed(data: {
    caseId: string;
    merchantId: string;
    causeClass: string;
    policyId: string;
    policyVersion: number;
    cohort: 'treatment' | 'holdout';
    attended: boolean;
  }): Promise<unknown>;

  caseResolved(data: {
    caseId: string;
    merchantId: string;
    outcome: 'recovered' | 'aborted' | 'lost';
    reason: string;
  }): Promise<unknown>;
}

export interface HandlerContext {
  db: Database;
  merchantId: string;
  /** Injected so the whole pipeline is deterministic under test. */
  now: Date;
  /** Merchant holdout share, in basis points. */
  holdoutBasisPoints: number;
  holdoutEnabled: boolean;
  /** Starts and stops ladders. Omitted in tests; required in production. */
  publish?: WorkflowPublisher;
}

export interface PaymentFailedResult {
  caseId: string;
  created: boolean;
  causeClass: string;
  policyId: string;
  policyVersion: number;
  attended: boolean;
  cohort: Cohort;
  aborted: boolean;
  customerId: string | null;
  unrecognisedReason: boolean;
}

export async function handlePaymentFailed(
  ctx: HandlerContext,
  entity: RazorpayPaymentEntity,
): Promise<PaymentFailedResult> {
  const { db, merchantId, now } = ctx;

  // 1 ── Normalise. Never throws: an unrecognised reason becomes
  //      `unknown_reason` and is flagged, because a payload we could not parse
  //      is still money at risk.
  const failure = normalizeFailure(entity);

  // 2 ── Resolve the customer to ONE row, so the frequency cap is real.
  const customerId = await upsertCustomer(db, {
    merchantId,
    email: failure.customerEmail,
    phone: failure.customerContact,
  });

  // 3 ── Record the attempt, then read the history back WITHOUT it. The caps
  //      ask "how many times has this already failed", not "including the one
  //      we are handling right now".
  if (failure.paymentId) {
    await recordAttempt(db, {
      merchantId,
      rzpOrderId: failure.orderId,
      rzpPaymentId: failure.paymentId,
      method: failure.tuple.method,
      errorReason: failure.tuple.errorReason,
      errorSource: failure.tuple.errorSource,
      bank: failure.tuple.bank,
      succeeded: false,
      amountPaise: failure.amount,
      attemptedAt: failure.createdAt ?? now,
    });
  }

  const priorRows = failure.orderId
    ? await listAttemptsForOrder(db, merchantId, failure.orderId)
    : [];

  const priorAttempts: AttemptRecord[] = priorRows
    .filter((r) => r.rzpPaymentId !== failure.paymentId)
    .map((r) => ({
      at: r.attemptedAt,
      method: r.method as PaymentMethod,
      errorReason: r.errorReason,
    }));

  const activeDowntime = await findActiveDowntime(db);

  // 4 ── Diagnose. Pure: everything it needs was gathered above.
  const caseType: CaseType = failure.subscriptionId ? 'subscription_failure' : 'payment_failure';
  const hasMandate = failure.subscriptionId != null;

  const diagnosis = diagnose(failure.tuple, {
    now,
    caseType,
    amount: failure.amount,
    hasMandate,
    activeDowntime,
    priorAttempts,
  });

  // 5 ── Resolve the ladder. `matchInputFrom` reads the cause class from the
  //      DIAGNOSIS, so a decline reclassified by a live outage gets the outage
  //      ladder rather than the one its raw appearance would have chosen.
  const matchInput = matchInputFrom(failure.tuple, diagnosis, failure.amount);
  const resolved = resolvePolicy(POLICY_TABLE, matchInput);

  const cohort = assignCohort({
    merchantId,
    // Keyed on the order so a replay lands in the same bucket every time.
    caseId: failure.orderId ?? failure.paymentId ?? 'unknown',
    holdoutBasisPoints: ctx.holdoutBasisPoints,
    holdoutEnabled: ctx.holdoutEnabled,
    eligible:
      resolved.row.holdoutEligible &&
      isHoldoutEligible({
        contactsCustomer: diagnosis.contactCustomer,
        alertsMerchant: diagnosis.alertMerchant,
      }),
  });

  // 6 ── Persist. `createCase` is idempotent on the live-order index, so twenty
  //      concurrent deliveries produce one case.
  const created = await createCase(db, {
    merchantId,
    customerId,
    type: diagnosis.caseType,
    amountAtRiskPaise: failure.amount,
    currency: failure.currency,
    rzpOrderId: failure.orderId,
    rzpPaymentId: failure.paymentId,
    rzpInvoiceId: failure.invoiceId,
    rzpSubscriptionId: failure.subscriptionId,
    errorCode: failure.tuple.errorCode,
    errorSource: failure.tuple.errorSource,
    errorStep: failure.tuple.errorStep,
    errorReason: failure.tuple.errorReason,
    rawErrorReason: failure.rawReason,
    method: failure.tuple.method,
    bank: failure.tuple.bank,
    network: failure.tuple.network,
    causeClass: diagnosis.causeClass,
    confidence: diagnosis.confidence,
    diagnosisRationale: diagnosis.rationale,
    attended: diagnosis.attended,
    policyId: resolved.row.id,
    policyVersion: resolved.row.version,
    cohort,
    deadlineAt: diagnosis.deadlineAt,
  });

  await appendEvent(db, {
    caseId: created.id,
    merchantId,
    kind: 'diagnosed',
    actor: 'ingest',
    payload: {
      causeClass: diagnosis.causeClass,
      confidence: diagnosis.confidence,
      matchedRuleId: diagnosis.matchedRuleId,
      attended: diagnosis.attended,
      sameInstrumentRetry: diagnosis.sameInstrumentRetry,
      suggestedRails: diagnosis.suggestedRails,
      downtimeGated: diagnosis.downtimeGated,
      policyId: resolved.row.id,
      policyVersion: resolved.row.version,
      policySpecificity: resolved.specificity,
      rationale: diagnosis.rationale,
      unrecognisedReason: failure.unrecognisedReason,
    },
  });

  const base = {
    caseId: created.id,
    created: created.created,
    causeClass: diagnosis.causeClass,
    policyId: resolved.row.id,
    policyVersion: resolved.row.version,
    attended: diagnosis.attended,
    cohort,
    customerId,
    unrecognisedReason: failure.unrecognisedReason,
  };

  // 7 ── Terminal classes close immediately. `order_already_paid` must never
  //      reach a ladder, and aborting here means nothing is ever queued.
  if (diagnosis.shouldAbort) {
    await transitionCase(db, created.id, 'aborted', 'already_paid', { actor: 'ingest' });
    return { ...base, aborted: true };
  }

  // Stage 4 stops here: the case is detected, diagnosed, and has a ladder
  // stamped on it. Nothing executes until Stage 6; nothing is sent until 7.
  await transitionCase(db, created.id, 'diagnosed', 'diagnosed', { actor: 'ingest' });

  return { ...base, aborted: false };
}
