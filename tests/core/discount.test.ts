/**
 * The discount guardrail.
 *
 * What matters most here: there is no input combination that produces more
 * than ₹500, and tier 2 is unreachable without tier 1 having happened first
 * on the same call.
 */

import { describe, expect, it } from 'vitest';

import { paise } from '@core/money.js';
import {
  DISCOUNT_MAX_PAISE,
  DISCOUNT_TIERS_PAISE,
  proposeDiscount,
} from '@core/guards/discount.js';

const bigOrder = paise(500_000); // ₹5,000 — comfortably above any ceiling concern

describe('proposeDiscount', () => {
  it('approves tier 1 at ₹200 on a fresh call', () => {
    const d = proposeDiscount({
      orderAmountPaise: bigOrder,
      requestedTier: 1,
      alreadyOfferedTier: 0,
      causeClass: 'instrument_dead',
    });
    expect(d).toEqual({ approved: true, amountPaise: DISCOUNT_TIERS_PAISE[0], tier: 1 });
  });

  it('approves tier 2 at ₹500 only after tier 1 was already granted', () => {
    const d = proposeDiscount({
      orderAmountPaise: bigOrder,
      requestedTier: 2,
      alreadyOfferedTier: 1,
      causeClass: 'instrument_dead',
    });
    expect(d).toEqual({ approved: true, amountPaise: DISCOUNT_TIERS_PAISE[1], tier: 2 });
  });

  it('refuses tier 2 requested cold, without tier 1 first', () => {
    const d = proposeDiscount({
      orderAmountPaise: bigOrder,
      requestedTier: 2,
      alreadyOfferedTier: 0,
      causeClass: 'instrument_dead',
    });
    expect(d.approved).toBe(false);
  });

  it('never approves more than the ₹500 ceiling, whatever is asked', () => {
    // Both tiers, checked directly against the ceiling constant rather than a
    // hardcoded number, so this test still holds if the tiers ever change.
    expect(DISCOUNT_TIERS_PAISE[0]).toBeLessThanOrEqual(DISCOUNT_MAX_PAISE);
    expect(DISCOUNT_TIERS_PAISE[1]).toBeLessThanOrEqual(DISCOUNT_MAX_PAISE);

    const d = proposeDiscount({
      orderAmountPaise: bigOrder,
      requestedTier: 2,
      alreadyOfferedTier: 1,
      causeClass: null,
    });
    expect(d.approved).toBe(true);
    if (d.approved) expect(d.amountPaise).toBeLessThanOrEqual(DISCOUNT_MAX_PAISE);
  });

  it('refuses a second offer at the same or a lower tier', () => {
    const d = proposeDiscount({
      orderAmountPaise: bigOrder,
      requestedTier: 1,
      alreadyOfferedTier: 1,
      causeClass: null,
    });
    expect(d.approved).toBe(false);
  });

  it('caps the discount at 30% of the order amount on a small order', () => {
    const smallOrder = paise(30_000); // ₹300 — 30% of it is ₹90, below tier 1's ₹200
    const d = proposeDiscount({
      orderAmountPaise: smallOrder,
      requestedTier: 1,
      alreadyOfferedTier: 0,
      causeClass: null,
    });
    expect(d.approved).toBe(true);
    if (d.approved) expect(d.amountPaise).toBe(paise(9_000));
  });

  it('caps tier 2 at 30% rather than at its own ₹500', () => {
    // ₹1,000: tier 2 asks for ₹500, the fraction allows ₹300. The tighter of
    // the two wins — that is the whole job of the fraction, and the case that
    // changed when it moved from half to 30%.
    const d = proposeDiscount({
      orderAmountPaise: paise(100_000),
      requestedTier: 2,
      alreadyOfferedTier: 1,
      causeClass: null,
    });
    expect(d.approved).toBe(true);
    if (d.approved) expect(d.amountPaise).toBe(paise(30_000));
  });

  it('refuses ineligible cause classes', () => {
    for (const causeClass of ['risk', 'terminal_noop', 'merchant_config'] as const) {
      const d = proposeDiscount({
        orderAmountPaise: bigOrder,
        requestedTier: 1,
        alreadyOfferedTier: 0,
        causeClass,
      });
      expect(d.approved).toBe(false);
    }
  });

  it('refuses a non-positive order amount', () => {
    const d = proposeDiscount({
      orderAmountPaise: paise(0),
      requestedTier: 1,
      alreadyOfferedTier: 0,
      causeClass: null,
    });
    expect(d.approved).toBe(false);
  });
});
