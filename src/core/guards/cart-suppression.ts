/**
 * Is this actually an abandoned cart, or a payment that already failed?
 *
 * The two agents describe different things and were both firing at the same
 * person for one event.
 *
 *   ABANDONED CART   they put something in a basket, opened checkout, and left
 *                    without ever asking to be charged. Nothing was attempted,
 *                    so nothing failed, and Razorpay has nothing to report —
 *                    which is exactly why the merchant's own app has to tell us.
 *
 *   PAYMENT FAILURE  they DID ask to be charged and it did not work. Razorpay
 *                    reports it, the ladder diagnoses why, and the message that
 *                    follows is about the specific thing that went wrong.
 *
 * A customer whose card is declined and who then closes the tab produces BOTH.
 * The merchant's app sees a checkout closed with no completed order and calls
 * the cart webhook, entirely reasonably — it cannot see the decline. So the
 * person got a message explaining their card was expired, and then a second
 * message offering ₹200 off a cart they had been actively trying to pay for.
 *
 * ── why the failure wins ──
 *
 * Not arbitrary. The failure message is specific and true ("your bank has
 * online payments switched off, here is UPI"); the cart message is generic and
 * guesses at a reason that is already known. And the cart message carries a
 * discount, so sending it after a failure teaches customers that letting a
 * payment fail is how you get money off.
 *
 * Pure. Every fact is passed in, so "what would this decide for a customer
 * whose case recovered nineteen hours ago" is a table row.
 */

const HOUR_MS = 60 * 60 * 1000;

/**
 * How long after a payment attempt a cart is still the same session.
 *
 * Twenty-four hours. Long enough to cover a checkout closed hours after a
 * decline, or a merchant's app that batches its abandonment sweep overnight;
 * short enough that a genuinely new basket next week is treated as one.
 *
 * A LIVE case ignores this window entirely — see below.
 */
export const CART_AFTER_FAILURE_HOURS = 24;

export interface CartSuppressionFacts {
  readonly now: Date;
  /**
   * Does this customer have a recovery case still in flight at this merchant?
   *
   * No time window applies to this one. A live case means the failed-payment
   * agent is mid-ladder with this person right now, and a discount email
   * landing in the middle of that is the collision this guard exists to stop —
   * whether the failure was twenty minutes or three days ago.
   */
  readonly hasLiveCase: boolean;
  /**
   * When this customer's most recent recovery case was opened, live or not.
   * Null when they have never had one.
   */
  readonly mostRecentCaseAt: Date | null;
}

export type CartSuppression =
  | { readonly suppress: false }
  | { readonly suppress: true; readonly reason: string };

export function shouldSuppressCart(facts: CartSuppressionFacts): CartSuppression {
  if (facts.hasLiveCase) {
    return {
      suppress: true,
      reason: 'this customer has a payment failure being recovered right now',
    };
  }

  if (facts.mostRecentCaseAt !== null) {
    const hours = (facts.now.getTime() - facts.mostRecentCaseAt.getTime()) / HOUR_MS;
    if (hours <= CART_AFTER_FAILURE_HOURS) {
      const whole = Math.max(0, Math.floor(hours));
      return {
        suppress: true,
        reason:
          whole === 0
            ? 'this customer attempted a payment in the last hour — that is a failure, not an abandoned cart'
            : `this customer attempted a payment ${whole}h ago — that is a failure, not an abandoned cart`,
      };
    }
  }

  return { suppress: false };
}
