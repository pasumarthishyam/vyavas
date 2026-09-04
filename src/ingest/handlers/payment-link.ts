/**
 * `payment_link.paid` — the money arrived on a recovery link we created.
 *
 * This has its own handler rather than sharing `handlePaymentSucceeded`, and
 * the reason is the bug it exists to fix.
 *
 * A Razorpay payment link creates **its own order** when it is paid. The
 * `order` entity on this webhook is that new order, not the one that originally
 * failed. `handlePaymentSucceeded` resolves a case by order id, so it looked up
 * an order no case has ever carried, found nothing, and returned
 * `no_live_case`. The original order stayed `created` at Razorpay forever, so
 * the `order_unpaid` precondition kept passing too.
 *
 * The consequence was the worst one available: a customer who did exactly what
 * the recovery message asked still received every remaining rung, and the case
 * was eventually closed as `lost`. The product's own success was invisible to
 * it — the `payment_link_paid` abort condition listed on every policy row in
 * the table had no fact behind it, and nothing ever wrote a recovered amount
 * for a link payment.
 *
 * The way back is `reference_id`, which every link in this codebase already
 * sets to the UUID of the row that created it:
 *
 *   ladder            `recovery_cases.id`   (workflows/payment-link.ts)
 *   abandoned cart    `abandoned_carts.id`  (workflows/abandoned-cart.ts)
 *   discount caller   `voice_calls.id`      (api/voice-agent/webhook)
 *
 * Three tables, one field, UUIDs throughout — so a lookup can try each in turn
 * without ambiguity. Everything below is that resolution, plus the fallbacks
 * for a link whose `reference_id` is missing or is not one of ours.
 */

import type { Database } from '../../db/client.js';
import {
  appendEvent,
  findLiveCaseForPaymentLink,
  getCase,
  transitionCase,
} from '../../db/repos/cases.js';
import {
  getAbandonedCart,
  getAbandonedCartByPaymentLinkId,
  markCartRecovered,
} from '../../db/repos/abandoned-carts.js';
import {
  getVoiceCall,
  getVoiceCallByPaymentLinkId,
  markPaymentConfirmedById,
} from '../../db/repos/voice-calls.js';
import type {
  RazorpayPaymentEntity,
  RazorpayPaymentLinkEntity,
} from '../../adapters/razorpay/types.js';
import type { HandlerContext } from './payment-failed.js';

/**
 * Postgres throws `invalid input syntax for type uuid` on a malformed value
 * rather than returning no rows, and that would take down the whole webhook.
 * A `reference_id` is merchant-controllable in general, so it is checked before
 * it is ever used as a key.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PaymentLinkOutcome =
  /** A recovery case was closed as recovered. */
  | 'case_recovered'
  /** The case was found but was already terminal — a replay, or a race. */
  | 'case_already_closed'
  | 'cart_recovered'
  | 'cart_already_closed'
  | 'voice_call_recovered'
  /** Nothing of ours matched. Not an error: the merchant may create their own links. */
  | 'unmatched';

export interface PaymentLinkPaidResult {
  outcome: PaymentLinkOutcome;
  caseId: string | null;
  /** Set when a case moved to `recovered`, so the caller can cancel its ladder. */
  resolvedCaseId: string | null;
  amountPaise: number;
  referenceId: string | null;
  paymentLinkId: string | null;
}

/**
 * What actually arrived.
 *
 * Preference order matters. The `payment` entity is the captured payment and is
 * the most direct statement of what the customer was charged. `amount_paid` on
 * the link is next. The link's own `amount` is last — it is what was ASKED for,
 * which is the same thing on a fully paid link and wrong on a partial one.
 *
 * A discounted link (the voice agent's) is legitimately less than the case's
 * `amount_at_risk_paise`, and recording the amount that arrived rather than the
 * amount at risk is what keeps the recovered figure honest about the discount.
 */
function amountFrom(
  link: RazorpayPaymentLinkEntity | null,
  payment: RazorpayPaymentEntity | null,
): number {
  if (payment && typeof payment.amount === 'number' && payment.amount > 0) return payment.amount;
  if (link && typeof link.amount_paid === 'number' && link.amount_paid > 0) return link.amount_paid;
  if (link && typeof link.amount === 'number' && link.amount > 0) return link.amount;
  return 0;
}

export async function handlePaymentLinkPaid(
  ctx: HandlerContext,
  link: RazorpayPaymentLinkEntity | null,
  payment: RazorpayPaymentEntity | null,
): Promise<PaymentLinkPaidResult> {
  const { db, merchantId } = ctx;

  const referenceId = typeof link?.reference_id === 'string' ? link.reference_id : null;
  const paymentLinkId = typeof link?.id === 'string' ? link.id : null;
  const amountPaise = amountFrom(link, payment);

  const base = { amountPaise, referenceId, paymentLinkId };

  // ── 1. by reference_id, the id of whatever created this link ──
  if (referenceId && UUID.test(referenceId)) {
    const byCase = await getCase(db, referenceId);
    if (byCase && byCase.merchantId === merchantId) {
      return { ...base, ...(await closeCase(ctx, byCase.id, amountPaise, paymentLinkId, referenceId)) };
    }

    const byCart = await getAbandonedCart(db, referenceId);
    if (byCart && byCart.merchantId === merchantId) {
      return { ...base, ...(await closeCart(db, byCart.id, byCart.paymentConfirmedAt)) };
    }

    const byCall = await getVoiceCall(db, referenceId);
    if (byCall && byCall.merchantId === merchantId) {
      return { ...base, ...(await closeVoiceCall(ctx, byCall.id, byCall.caseId, amountPaise, paymentLinkId)) };
    }
  }

  // ── 2. by the link id we stored when we created it ──
  //
  // For a link with no usable reference_id — one created before that field was
  // set, or created by hand in the Razorpay dashboard.
  if (paymentLinkId) {
    const liveCase = await findLiveCaseForPaymentLink(db, merchantId, paymentLinkId);
    if (liveCase) {
      return { ...base, ...(await closeCase(ctx, liveCase.id, amountPaise, paymentLinkId, referenceId)) };
    }

    const cart = await getAbandonedCartByPaymentLinkId(db, merchantId, paymentLinkId);
    if (cart) {
      return { ...base, ...(await closeCart(db, cart.id, cart.paymentConfirmedAt)) };
    }

    const call = await getVoiceCallByPaymentLinkId(db, merchantId, paymentLinkId);
    if (call) {
      return { ...base, ...(await closeVoiceCall(ctx, call.id, call.caseId, amountPaise, paymentLinkId)) };
    }
  }

  // A merchant can create payment links of their own for things this product
  // knows nothing about. Not an error, and not worth failing the delivery over.
  return { ...base, outcome: 'unmatched', caseId: null, resolvedCaseId: null };
}

// ─── the three things a link can belong to ───────────────────────────────────

async function closeCase(
  ctx: HandlerContext,
  caseId: string,
  amountPaise: number,
  paymentLinkId: string | null,
  referenceId: string | null,
): Promise<{ outcome: PaymentLinkOutcome; caseId: string; resolvedCaseId: string | null }> {
  const { db, merchantId } = ctx;

  const existing = await getCase(db, caseId);

  // The ledger entry is written whatever the state, because the payment is a
  // fact about the case even when a race closed it first — an `order.paid`
  // arriving a moment earlier, or a replayed delivery.
  await appendEvent(db, {
    caseId,
    merchantId,
    kind: 'payment_received',
    actor: 'ingest',
    payload: {
      via: 'payment_link',
      paymentLinkId,
      referenceId,
      amountPaise,
      cohort: existing?.cohort,
      // The incrementality report computes recovery time from these two.
      detectedAt: existing?.createdAt,
    },
  });

  const moved = await transitionCase(db, caseId, 'recovered', 'payment_received', {
    // What ARRIVED, not what was at risk. On a discounted link these differ,
    // and the dashboard reads this column in preference to the amount at risk.
    recoveredAmountPaise: amountPaise > 0 ? amountPaise : undefined,
    actor: 'ingest',
  });

  return moved.ok
    ? { outcome: 'case_recovered', caseId, resolvedCaseId: caseId }
    : { outcome: 'case_already_closed', caseId, resolvedCaseId: null };
}

async function closeCart(
  db: Database,
  cartId: string,
  alreadyConfirmedAt: Date | null,
): Promise<{ outcome: PaymentLinkOutcome; caseId: null; resolvedCaseId: null }> {
  if (alreadyConfirmedAt) {
    return { outcome: 'cart_already_closed', caseId: null, resolvedCaseId: null };
  }
  await markCartRecovered(db, cartId);
  return { outcome: 'cart_recovered', caseId: null, resolvedCaseId: null };
}

/**
 * A discount call's link.
 *
 * Closes both halves: the call's own confirmation column and the recovery case
 * it was placed against. `transitionCase` no-ops safely when the case is
 * already terminal, so racing the end-of-call reconciliation is harmless.
 */
async function closeVoiceCall(
  ctx: HandlerContext,
  voiceCallId: string,
  caseId: string,
  amountPaise: number,
  paymentLinkId: string | null,
): Promise<{ outcome: PaymentLinkOutcome; caseId: string; resolvedCaseId: string | null }> {
  const { db, merchantId } = ctx;

  await markPaymentConfirmedById(db, voiceCallId);

  await appendEvent(db, {
    caseId,
    merchantId,
    kind: 'payment_received',
    actor: 'ingest',
    payload: { via: 'voice_payment_link', paymentLinkId, voiceCallId, amountPaise },
  });

  const moved = await transitionCase(db, caseId, 'recovered', 'payment_received', {
    recoveredAmountPaise: amountPaise > 0 ? amountPaise : undefined,
    actor: 'ingest',
  });

  return {
    outcome: 'voice_call_recovered',
    caseId,
    resolvedCaseId: moved.ok ? caseId : null,
  };
}

// ─── the reconciliation sweep's entry point ──────────────────────────────────

/**
 * Close a case whose link a direct Razorpay read has just confirmed paid.
 *
 * The sweep's route in. It takes an amount already in hand rather than a
 * webhook payload, and shares `closeCase` with the webhook path deliberately —
 * both must write the same ledger entry and the same recovered amount, or a
 * case closed by the backstop would look different from one closed by the
 * webhook and the recovered figure would depend on which arrived first.
 */
export async function reconcileCaseLinkPaid(
  ctx: HandlerContext,
  caseId: string,
  paymentLinkId: string,
  amountPaise: number,
): Promise<boolean> {
  const r = await closeCase(ctx, caseId, amountPaise, paymentLinkId, null);
  return r.outcome === 'case_recovered';
}
