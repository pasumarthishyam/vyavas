/**
 * The abandoned-cart discount guard.
 *
 * What matters here: it never returns more than ₹200, and it never discounts
 * away more than half the cart.
 */

import { describe, expect, it } from 'vitest';

import { paise } from '@core/money.js';
import { CART_DISCOUNT_PAISE, proposeCartDiscount } from '@core/guards/cart-discount.js';

describe('proposeCartDiscount', () => {
  it('offers the flat ₹200 on an ordinary cart', () => {
    const d = proposeCartDiscount(paise(500_000)); // Rs 5,000
    expect(d.amountPaise).toBe(CART_DISCOUNT_PAISE);
  });

  it('caps the discount at 30% of the cart on a small cart', () => {
    const d = proposeCartDiscount(paise(30_000)); // Rs 300 — 30% is Rs 90, below the flat Rs 200
    expect(d.amountPaise).toBe(paise(9_000));
  });

  it('applies the flat amount once the cart is large enough to carry it', () => {
    // Rs 700: 30% is Rs 210, so the flat Rs 200 is the binding number again.
    // The boundary moved when the fraction did — under half it was Rs 400.
    expect(proposeCartDiscount(paise(70_000)).amountPaise).toBe(CART_DISCOUNT_PAISE);
  });

  it('never exceeds the flat amount, whatever the cart size', () => {
    const d = proposeCartDiscount(paise(50_000_000)); // Rs 5,00,000
    expect(d.amountPaise).toBeLessThanOrEqual(CART_DISCOUNT_PAISE);
  });

  it('returns zero for a non-positive cart amount', () => {
    expect(proposeCartDiscount(paise(0)).amountPaise).toBe(paise(0));
  });
});
