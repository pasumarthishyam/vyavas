/**
 * Reload the diagnosis facts a running ladder needs.
 *
 * The diagnosis was computed once, at ingest, and its conclusions were written
 * to the case. The workflow needs two of them back — the permitted rails and
 * whether same-instrument retry survived the attempt history — because a rung's
 * `suggest` list must be filtered through them before it becomes a message.
 *
 * Read from the ledger rather than recomputed: re-running `diagnose()` now
 * would use TODAY's attempt history and downtime feed, and could quietly
 * re-authorise something the original diagnosis ruled out. The case is executed
 * under the diagnosis it was given, exactly like the policy version stamped
 * beside it.
 */

import { and, desc, eq } from 'drizzle-orm';

import type { AlternateRail } from '../core/case/types.js';
import type { GateFailure } from '../core/guards/preconditions.js';
import type { Database } from '../db/client.js';
import { appendEvent, transitionCase } from '../db/repos/cases.js';
import { caseEvents, recoveryCases } from '../db/schema/cases.js';

export interface CaseRunContext {
  createdAt: Date;
  /**
   * The point past which this case is closed regardless.
   *
   * The ladder needs it to know how long a deferred rung is worth waiting for.
   * Without it the workflow has no way to distinguish "wait three hours for the
   * frequency cap to clear" from "wait past the end of the case", and it
   * guessed — which is how a recoverable case was abandoned an hour before its
   * gate would have opened.
   */
  deadlineAt: Date | null;
  rails: AlternateRail[];
  sameInstrumentRetry: boolean;
}

export async function loadCaseForRun(
  db: Database,
  caseId: string,
): Promise<CaseRunContext | null> {
  const rows = await db
    .select({ createdAt: recoveryCases.createdAt, deadlineAt: recoveryCases.deadlineAt })
    .from(recoveryCases)
    .where(eq(recoveryCases.id, caseId))
    .limit(1);

  const row = rows.at(0);
  if (!row) return null;

  // The most recent `diagnosed` entry. There can be several when an order
  // failed repeatedly, and the latest is the one the ladder is running under.
  const events = await db
    .select({ payload: caseEvents.payload })
    .from(caseEvents)
    .where(and(eq(caseEvents.caseId, caseId), eq(caseEvents.kind, 'diagnosed')))
    .orderBy(desc(caseEvents.occurredAt))
    .limit(1);

  const payload = (events.at(0)?.payload ?? {}) as Record<string, unknown>;
  const rails = Array.isArray(payload.suggestedRails)
    ? (payload.suggestedRails as AlternateRail[])
    : [];

  return {
    createdAt: row.createdAt,
    deadlineAt: row.deadlineAt,
    rails,
    // Defaults to FALSE when the ledger does not say. The conservative
    // direction: never re-present an instrument we cannot confirm is safe to
    // re-present.
    sameInstrumentRetry: payload.sameInstrumentRetry === true,
  };
}

// ─── how a ladder ends ───────────────────────────────────────────────────────

export type LadderCloseOutcome = 'recovered' | 'lost' | 'aborted' | 'unchanged';

export interface CloseFromGateInput {
  caseId: string;
  merchantId: string;
  /** Which gate condition stopped the ladder. */
  failed: GateFailure | null;
  note: string;
  /** What Razorpay says arrived, when the gate is closing this because it did. */
  paidAmountPaise: number | null;
  /**
   * Razorpay confirmed the payment, rather than being unreachable.
   *
   * `isOrderPaid` answers "paid" when it cannot reach Razorpay, so that the
   * ladder stays silent rather than messaging someone who may have paid. That
   * is the right call for sending and the wrong one for the ledger: without
   * this flag every Razorpay outage would close a batch of live cases as
   * recovered and book revenue that never arrived.
   */
  paidConfirmed: boolean;
}

/**
 * End a case the gate has aborted, in the state that is actually true.
 *
 * This used to be one line — `transitionCase(caseId, 'aborted', 'already_paid')`
 * — applied to every abort the gate could produce, and it was wrong in three
 * different directions at once:
 *
 *   - A case whose money had ARRIVED was recorded as `aborted` with no
 *     recovered amount, so a successful recovery was invisible on the
 *     dashboard and counted against the treatment in any comparison.
 *   - A case that ran out of runway was also `aborted/already_paid`, which is
 *     the opposite of true. `lost` is what the deadline sweep calls it, so the
 *     same case ended up in different states depending on which of the two got
 *     there first.
 *   - A customer who opted out was recorded as having paid.
 *
 * The distinction is only available because the gate now names these outcomes
 * separately rather than collapsing them into `order_unpaid`.
 *
 * A lost transition race returns `unchanged` and is not an error: the webhook
 * closing the case a moment earlier is the ordinary case, not an exception.
 */
export async function closeCaseFromGate(
  db: Database,
  input: CloseFromGateInput,
): Promise<{ outcome: LadderCloseOutcome; reason: string }> {
  const { caseId, merchantId, failed, note, paidAmountPaise, paidConfirmed } = input;

  if ((failed === 'order_paid' || failed === 'payment_link_paid') && !paidConfirmed) {
    // We stopped because we BELIEVE it is paid, not because we know. Razorpay
    // was unreachable and `isOrderPaid` failed closed. Stopping is right;
    // recording a recovery is not, so this takes the old, conservative path and
    // books nothing.
    const moved = await transitionCase(db, caseId, 'aborted', 'already_paid', {
      actor: 'workflow',
    });
    return { outcome: moved.ok ? 'aborted' : 'unchanged', reason: 'assumed_paid_unconfirmed' };
  }

  if (failed === 'order_paid' || failed === 'payment_link_paid') {
    // The webhook normally gets here first and this is a no-op. It is the
    // backstop for a delivery that never arrived — which for a payment link was
    // every delivery, because the link's own order never matched a case.
    await appendEvent(db, {
      caseId,
      merchantId,
      kind: 'payment_received',
      actor: 'workflow',
      payload: {
        via: failed === 'payment_link_paid' ? 'payment_link' : 'order',
        detectedBy: 'gate',
        amountPaise: paidAmountPaise,
        note,
      },
    });

    const moved = await transitionCase(db, caseId, 'recovered', 'payment_received', {
      // Undefined rather than null when unknown: `transitionCase` skips the
      // column entirely, and the dashboard falls back to the amount at risk.
      // Writing a null would look like a deliberate zero.
      recoveredAmountPaise: paidAmountPaise ?? undefined,
      actor: 'workflow',
    });

    return { outcome: moved.ok ? 'recovered' : 'unchanged', reason: 'payment_received' };
  }

  if (failed === 'deadline_passed') {
    // `lost`, not `aborted`: we tried and ran out of runway. The same call the
    // deadline sweep makes, so whichever arrives first leaves the same record.
    const moved = await transitionCase(db, caseId, 'lost', 'deadline_passed', {
      actor: 'workflow',
    });
    return { outcome: moved.ok ? 'lost' : 'unchanged', reason: 'deadline_passed' };
  }

  const reason = failed === 'consent_ok' ? 'customer_opted_out' : 'manual_abort';
  const moved = await transitionCase(db, caseId, 'aborted', reason, { actor: 'workflow' });
  return { outcome: moved.ok ? 'aborted' : 'unchanged', reason };
}
