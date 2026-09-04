/**
 * Abandoned cart, or a payment that already failed?
 *
 * Both agents were firing at the same person for one event. A customer whose
 * card is declined and who then closes the tab produces a `payment.failed` from
 * Razorpay AND an abandoned-cart webhook from the merchant's own app, because
 * the merchant's app cannot see the decline — all it knows is that a checkout
 * closed with no completed order.
 *
 * So the person got a message explaining their card was expired, and then a
 * second message offering ₹200 off a cart they had been actively trying to pay
 * for. The second one also teaches customers that letting a payment fail is how
 * you get money off.
 */

import { describe, expect, it } from 'vitest';

import {
  CART_AFTER_FAILURE_HOURS,
  shouldSuppressCart,
} from '../../src/core/guards/cart-suppression.js';

const NOW = new Date('2026-09-10T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

const decide = (over: { hasLiveCase?: boolean; mostRecentCaseAt?: Date | null } = {}) =>
  shouldSuppressCart({
    now: NOW,
    hasLiveCase: over.hasLiveCase ?? false,
    mostRecentCaseAt: over.mostRecentCaseAt ?? null,
  });

describe('a real abandoned cart is left alone', () => {
  it('sends when the customer has never attempted a payment', () => {
    expect(decide().suppress).toBe(false);
  });

  it('sends when the last attempt is well outside the window', () => {
    // A genuinely new basket weeks later is a new basket.
    expect(decide({ mostRecentCaseAt: hoursAgo(24 * 30) }).suppress).toBe(false);
  });

  it('sends just past the window', () => {
    expect(decide({ mostRecentCaseAt: hoursAgo(CART_AFTER_FAILURE_HOURS + 1) }).suppress).toBe(
      false,
    );
  });
});

describe('a cart that is really a failed payment is declined', () => {
  it('declines whenever a case is still being recovered, however old', () => {
    /*
     * No time window on this one, deliberately. A live case means the
     * failed-payment ladder is mid-flight with this person right now, and a
     * discount email landing in the middle of that is the collision the whole
     * guard exists to stop — whether the failure was twenty minutes or three
     * days ago.
     */
    const r = decide({ hasLiveCase: true, mostRecentCaseAt: hoursAgo(24 * 3) });
    expect(r.suppress).toBe(true);
    if (r.suppress) expect(r.reason).toContain('being recovered right now');
  });

  it('declines a checkout closed minutes after the decline', () => {
    // The exact scenario: card declined, customer closes the tab, the
    // merchant's app reports an abandoned cart.
    const r = decide({ mostRecentCaseAt: hoursAgo(0.25) });
    expect(r.suppress).toBe(true);
    if (r.suppress) expect(r.reason).toContain('in the last hour');
  });

  it('declines right up to the edge of the window', () => {
    const r = decide({ mostRecentCaseAt: hoursAgo(CART_AFTER_FAILURE_HOURS) });
    expect(r.suppress).toBe(true);
    // The boundary belongs to the customer: at exactly the limit we still do
    // not send them a second message.
    if (r.suppress) expect(r.reason).toContain('24h ago');
  });

  it('says how long ago, so the reason survives into the console', () => {
    const r = decide({ mostRecentCaseAt: hoursAgo(5) });
    if (r.suppress) {
      expect(r.reason).toContain('5h ago');
      expect(r.reason).toContain('not an abandoned cart');
    }
  });
});

describe('the two conditions are independent', () => {
  it('a live case wins even with no recent case timestamp', () => {
    expect(decide({ hasLiveCase: true, mostRecentCaseAt: null }).suppress).toBe(true);
  });

  it('a recent case wins even with nothing live', () => {
    expect(decide({ hasLiveCase: false, mostRecentCaseAt: hoursAgo(2) }).suppress).toBe(true);
  });
});
