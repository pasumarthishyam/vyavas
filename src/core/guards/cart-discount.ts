/**
 * The abandoned-cart discount guard.
 *
 * Much smaller than `discount.ts` because there is nothing to negotiate — no
 * call, no model, no tiers. A cart is abandoned, the flat discount applies, and
 * the only judgement left is the same one `discount.ts` already makes: never
 * discount away more than half the order, so a very small cart cannot be
 * pushed to (or below) zero.
 *
 * Pure. No DB, no network — the webhook handler calls this and nothing else
 * decides the number.
 */

import type { Paise } from '../money.js';
import { paise } from '../money.js';

/** Flat ₹200 off. There is only one tier here — nothing to escalate to. */
export const CART_DISCOUNT_PAISE: Paise = paise(20_000);

const MAX_DISCOUNT_FRACTION = 0.5;

export interface CartDiscountDecision {
  readonly amountPaise: Paise;
}

/**
 * The discount for one abandoned cart.
 *
 * `cartAmountPaise <= 0` is refused with ₹0 rather than throwing — a webhook
 * payload is untrusted input, and a caller that sent a bad amount should get a
 * safe answer, not a crashed request.
 */
export function proposeCartDiscount(cartAmountPaise: Paise): CartDiscountDecision {
  if (cartAmountPaise <= 0) return { amountPaise: paise(0) };

  const ceiling = paise(Math.floor(cartAmountPaise * MAX_DISCOUNT_FRACTION));
  return { amountPaise: paise(Math.min(CART_DISCOUNT_PAISE, ceiling)) };
}
