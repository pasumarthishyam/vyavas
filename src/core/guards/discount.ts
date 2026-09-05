/**
 * The discount guardrail.
 *
 * The one rule this file exists to enforce: the model never computes a
 * discount. It calls `proposeDiscount`, reads back what it returns, and says
 * that number — or refuses, if what came back is a refusal. There is no path
 * from a live conversation to a number this function did not produce, which is
 * what makes "the AI can offer up to ₹500" a guarantee rather than a prompt
 * asking the model to behave.
 *
 * Pure, like `preconditions.ts` — no DB, no network, fully testable without a
 * call ever happening. The caller (the tool-call webhook handler) is
 * responsible for knowing what tier this call has already offered; this
 * function only ever answers the question "given that, is one more tier
 * allowed, and how much is it."
 */

import type { Paise } from '../money.js';
import { paise } from '../money.js';
import type { CauseClass } from '../taxonomy/cause-class.js';

/** ₹200, then ₹500. Index 0 is tier 1. */
export const DISCOUNT_TIERS_PAISE: readonly Paise[] = [paise(20_000), paise(50_000)];

/**
 * The hard ceiling, checked unconditionally.
 *
 * Independent of `DISCOUNT_TIERS_PAISE` on purpose — the same discipline as
 * the cool-off floor in `preconditions.ts`: a policy (or a future edit to the
 * tier list) may tighten this, it may never loosen it. If someone edits the
 * tiers above and gets the second value wrong, this still holds.
 */
export const DISCOUNT_MAX_PAISE: Paise = paise(50_000);

/**
 * Never discount away more than 30% of the order.
 *
 * Was 50%, which was set to stop a small order plus the ₹500 ceiling putting
 * the payable amount at or below zero — a correctness floor rather than a
 * commercial judgement. 30% is the commercial judgement: on a ₹1,000 order tier
 * 2 is now capped to ₹300 rather than ₹500, and the margin the recovery is
 * meant to protect survives the recovery.
 *
 * The same fraction applies in `cart-discount.ts`. Two guards, one number, on
 * purpose — an operator should not have to remember which agent discounts
 * harder.
 */
const MAX_DISCOUNT_FRACTION = 0.3;

/**
 * Classes where a discount is never the right move — never incentivize a
 * fraud-flagged case, there's nothing to discount on one that's already
 * paid, and it isn't the customer's fault (or problem) on a merchant-config
 * failure.
 */
const INELIGIBLE_CAUSE_CLASSES: ReadonlySet<CauseClass> = new Set(['risk', 'terminal_noop', 'merchant_config']);

export interface DiscountRequest {
  readonly orderAmountPaise: Paise;
  /** Which tier the model is asking for. 1 first, always — never 2 cold. */
  readonly requestedTier: 1 | 2;
  /** The highest tier already approved on THIS call. 0 if none yet. */
  readonly alreadyOfferedTier: 0 | 1 | 2;
  readonly causeClass: CauseClass | null;
}

export type DiscountDecision =
  | { readonly approved: true; readonly amountPaise: Paise; readonly tier: 1 | 2 }
  | { readonly approved: false; readonly reason: string };

export function proposeDiscount(req: DiscountRequest): DiscountDecision {
  const { orderAmountPaise, requestedTier, alreadyOfferedTier, causeClass } = req;

  if (causeClass !== null && INELIGIBLE_CAUSE_CLASSES.has(causeClass)) {
    return { approved: false, reason: `no discount for cause class '${causeClass}'` };
  }

  if (orderAmountPaise <= 0) {
    return { approved: false, reason: 'order amount is not positive' };
  }

  // Tier 2 is reachable only after tier 1 was already granted on this call —
  // the model cannot skip straight to the ceiling by asking for it first.
  if (requestedTier === 2 && alreadyOfferedTier < 1) {
    return { approved: false, reason: 'tier 2 requires tier 1 to have been offered first' };
  }

  // Never offer the same or a lower tier twice — one discount per call.
  if (requestedTier <= alreadyOfferedTier) {
    return { approved: false, reason: `tier ${requestedTier} was already offered on this call` };
  }

  const tierAmount = DISCOUNT_TIERS_PAISE[requestedTier - 1];
  if (tierAmount === undefined) {
    return { approved: false, reason: `no such tier: ${requestedTier}` };
  }

  const ceiling = paise(Math.min(DISCOUNT_MAX_PAISE, Math.floor(orderAmountPaise * MAX_DISCOUNT_FRACTION)));
  const amountPaise = paise(Math.min(tierAmount, ceiling));

  if (amountPaise <= 0) {
    return { approved: false, reason: 'order amount too small to discount' };
  }

  return { approved: true, amountPaise, tier: requestedTier };
}
