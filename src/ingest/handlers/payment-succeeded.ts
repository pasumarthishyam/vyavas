/**
 * Success events: `order.paid`, `payment.captured`, `payment_link.paid`,
 * `invoice.paid`, `subscription.charged`.
 *
 * These are the most important events in the system after `payment.failed`,
 * and for one reason: they are the kill switch. Every second a case stays open
 * after the money has arrived is a second in which a workflow might wake up and
 * message someone who already paid.
 *
 * So this handler does the minimum possible and does it fast: find the live
 * case, close it, record what came in. No diagnosis, no policy, no branching.
 */

import {
  appendEvent,
  findLiveCaseForOrder,
  recordAttempt,
  transitionCase,
} from '../../db/repos/index.js';
import { normalizeFailure } from '../../core/taxonomy/normalize.js';
import type { RazorpayPaymentEntity } from '../../adapters/razorpay/types.js';
import type { HandlerContext } from './payment-failed.js';

export interface RecoveredResult {
  caseId: string | null;
  closed: boolean;
  reason: 'recovered' | 'no_live_case' | 'already_terminal';
  recoveredAmountPaise: number;
}

/**
 * Close the live case for an order because the money arrived.
 *
 * Attribution is deliberately NOT decided here. Whether this counts as an
 * incremental recovery depends on the cohort and on what the ladder actually
 * did, and that comparison belongs in the measurement layer (Stage 8) with the
 * full ledger in front of it. Recording the fact and the timestamp is enough
 * for now — and the ledger is append-only, so nothing is lost by waiting.
 */
export async function handlePaymentSucceeded(
  ctx: HandlerContext,
  entity: RazorpayPaymentEntity,
  opts: { orderId?: string | null } = {},
): Promise<RecoveredResult> {
  const { db, merchantId, now } = ctx;

  const parsed = normalizeFailure(entity);
  const orderId = opts.orderId ?? parsed.orderId;

  // A successful attempt is still an attempt. It matters for the live-attempt
  // lock, which asks "is this customer mid-payment right now?" — and someone
  // who just succeeded very much was.
  if (parsed.paymentId) {
    await recordAttempt(db, {
      merchantId,
      rzpOrderId: orderId,
      rzpPaymentId: parsed.paymentId,
      method: parsed.tuple.method,
      errorReason: null,
      errorSource: null,
      bank: parsed.tuple.bank,
      succeeded: true,
      amountPaise: parsed.amount,
      attemptedAt: parsed.createdAt ?? now,
    });
  }

  if (!orderId) {
    return {
      caseId: null,
      closed: false,
      reason: 'no_live_case',
      recoveredAmountPaise: parsed.amount,
    };
  }

  const live = await findLiveCaseForOrder(db, merchantId, orderId);
  if (!live) {
    // Ordinary and expected: most payments succeed first time and never had a
    // case. Not an error, and not worth a log line at warning level.
    return {
      caseId: null,
      closed: false,
      reason: 'no_live_case',
      recoveredAmountPaise: parsed.amount,
    };
  }

  await appendEvent(db, {
    caseId: live.id,
    merchantId,
    kind: 'payment_received',
    actor: 'ingest',
    payload: {
      rzpPaymentId: parsed.paymentId,
      amountPaise: parsed.amount,
      method: parsed.tuple.method,
      cohort: live.cohort,
      // Kept for the incrementality report: recovery time is the headline
      // metric, and it can only be computed from these two timestamps.
      detectedAt: live.createdAt,
    },
  });

  const moved = await transitionCase(db, live.id, 'recovered', 'payment_received', {
    recoveredAmountPaise: parsed.amount,
    actor: 'ingest',
  });

  return {
    caseId: live.id,
    closed: moved.ok,
    reason: moved.ok ? 'recovered' : 'already_terminal',
    recoveredAmountPaise: parsed.amount,
  };
}

/**
 * The customer cancelled or opted out mid-ladder.
 *
 * Aborts rather than marking lost: `lost` means we tried and the deadline
 * passed, `aborted` means we stopped deliberately. Keeping them apart matters
 * because the incrementality report must not count a case we abandoned as one
 * the treatment failed to recover.
 */
export async function handleCaseAborted(
  ctx: HandlerContext,
  orderId: string,
  reason: 'customer_opted_out' | 'subscription_cancelled' | 'invoice_cancelled',
): Promise<{ caseId: string | null; closed: boolean }> {
  const live = await findLiveCaseForOrder(ctx.db, ctx.merchantId, orderId);
  if (!live) return { caseId: null, closed: false };

  const machineReason = reason === 'customer_opted_out' ? 'customer_opted_out' : 'manual_abort';
  const moved = await transitionCase(ctx.db, live.id, 'aborted', machineReason, {
    actor: 'ingest',
  });

  await appendEvent(ctx.db, {
    caseId: live.id,
    merchantId: ctx.merchantId,
    kind: 'aborted',
    reason,
    actor: 'ingest',
  });

  return { caseId: live.id, closed: moved.ok };
}
