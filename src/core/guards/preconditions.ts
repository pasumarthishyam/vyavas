/**
 * The precondition gate.
 *
 * Re-checked immediately before EVERY rung, never once when the ladder starts.
 * A case sleeps for hours between rungs and the world moves while it does: the
 * customer pays through another channel, opts out, or starts a fresh attempt.
 *
 * The distinction that matters most here is **abort vs defer**, and getting it
 * backwards is expensive in both directions:
 *
 *   ABORT  the reason will never stop being true, or acting would be wrong
 *          regardless of when. Order paid. Customer opted out. Deadline passed.
 *          Deferring these means eventually messaging someone who already paid.
 *
 *   DEFER  the reason is about *right now*. Quiet hours. A live attempt in
 *          flight. Today's frequency cap. Aborting these throws away a
 *          recoverable case because we happened to look at 11pm.
 *
 * Pure: every fact is passed in. The workflow gathers them; this decides.
 */

import type { Channel } from '../actions/types.js';
import type { Precondition } from '../policy/schema.js';
import { type QuietHours, nextAllowedTime } from './quiet-hours.js';

export interface PreconditionFacts {
  readonly now: Date;

  /** Re-fetched from Razorpay, never read from our own row. */
  readonly orderPaid: boolean;
  readonly deadlinePassed: boolean;

  readonly customerOptedOut: boolean;
  /** Channels the customer has consented to AND which are deliverable. */
  readonly eligibleChannels: readonly Channel[];

  /** Most recent payment attempt on this order, if any. */
  readonly lastAttemptAt: Date | null;
  readonly liveAttemptWindowMinutes: number;

  /** Real (unsuppressed) touches in the last 24h, across every case. */
  readonly recentMessageCount: number;
  readonly frequencyCap: number;

  readonly timeZone: string;
  readonly quietHours: QuietHours;

  /** Customer messages the merchant has left in today's budget. */
  readonly merchantBudgetRemaining: number;
  /** Null when the case is attended and no mandate is involved. */
  readonly mandateActive: boolean | null;

  /** Merchant kill switch. False means nothing fires, whatever the ladder says. */
  readonly executionEnabled: boolean;
}

export type Disposition = 'proceed' | 'defer' | 'abort';

export interface GateResult {
  readonly disposition: Disposition;
  readonly failed: Precondition | 'execution_disabled' | null;
  readonly reason: string;
  /** Set when deferring: the earliest instant worth trying again. */
  readonly retryAt: Date | null;
}

const proceed: GateResult = {
  disposition: 'proceed',
  failed: null,
  reason: 'all preconditions met',
  retryAt: null,
};

const abort = (failed: GateResult['failed'], reason: string): GateResult => ({
  disposition: 'abort',
  failed,
  reason,
  retryAt: null,
});

const defer = (failed: GateResult['failed'], reason: string, retryAt: Date): GateResult => ({
  disposition: 'defer',
  failed,
  reason,
  retryAt,
});

const MINUTE = 60_000;
const HOUR = 3_600_000;

/**
 * Evaluate the gate.
 *
 * Order is deliberate: the aborts are checked first, so a case that should stop
 * never gets deferred into a future where it might still fire. `order_unpaid`
 * leads because it is the one whose failure mode ends the merchant relationship.
 */
export function evaluatePreconditions(
  required: readonly Precondition[],
  facts: PreconditionFacts,
): GateResult {
  // The kill switch outranks every ladder and is not a precondition a policy
  // can opt out of.
  if (!facts.executionEnabled) {
    return abort('execution_disabled', 'merchant execution is switched off');
  }

  // ── aborts ──

  // Checked unconditionally, even if the policy forgot to list it. Messaging
  // someone who has already paid is the mistake that ends the relationship, and
  // it must not be possible to opt out of noticing.
  if (facts.orderPaid) {
    return abort('order_unpaid', 'the order has been paid — nothing is at risk');
  }

  if (facts.deadlinePassed) {
    return abort('order_unpaid', 'the deadline has passed — this case is closed');
  }

  if (facts.customerOptedOut) {
    return abort('consent_ok', 'the customer has opted out');
  }

  if (required.includes('mandate_active') && facts.mandateActive === false) {
    return abort(
      'mandate_active',
      'the mandate is no longer active — re-presenting would fail and is not permitted',
    );
  }

  // No reachable channel is terminal for a customer-facing rung: no amount of
  // waiting produces a phone number we never had.
  if (required.includes('channel_deliverable') && facts.eligibleChannels.length === 0) {
    return abort('channel_deliverable', 'no consented, deliverable channel for this customer');
  }

  // ── defers ──

  // Someone mid-retry on another card must not be interrupted. Retry just past
  // the window rather than immediately, or we would busy-wait against it.
  if (required.includes('no_live_attempt') && facts.lastAttemptAt) {
    const windowMs = facts.liveAttemptWindowMinutes * MINUTE;
    const elapsed = facts.now.getTime() - facts.lastAttemptAt.getTime();
    if (elapsed < windowMs) {
      return defer(
        'no_live_attempt',
        'the customer attempted a payment moments ago — do not interrupt',
        new Date(facts.lastAttemptAt.getTime() + windowMs + MINUTE),
      );
    }
  }

  if (required.includes('within_frequency_cap') && facts.recentMessageCount >= facts.frequencyCap) {
    // The cap is a rolling 24h window, so an hour from now is the soonest it is
    // worth asking again.
    return defer(
      'within_frequency_cap',
      `already ${facts.recentMessageCount} message(s) in 24h (cap ${facts.frequencyCap})`,
      new Date(facts.now.getTime() + HOUR),
    );
  }

  if (required.includes('merchant_budget_available') && facts.merchantBudgetRemaining <= 0) {
    // Budgets reset daily; retrying inside the hour just burns workflow steps.
    return defer(
      'merchant_budget_available',
      "the merchant's daily message budget is exhausted",
      new Date(facts.now.getTime() + 6 * HOUR),
    );
  }

  // Last, because it is the cheapest to satisfy by waiting and the least
  // informative to report — a case deferred for quiet hours is otherwise fine.
  if (required.includes('not_quiet_hours')) {
    const allowed = nextAllowedTime(facts.now, facts.timeZone, facts.quietHours);
    if (allowed.getTime() > facts.now.getTime()) {
      return defer('not_quiet_hours', 'inside the merchant quiet-hours window', allowed);
    }
  }

  return proceed;
}

/**
 * The channel a rung actually uses.
 *
 * The policy lists channels in preference order; this returns the first the
 * customer can actually receive on. Returns null when none match, which the
 * gate has usually already turned into an abort.
 */
export function selectChannel(
  preferred: readonly Channel[],
  eligible: readonly Channel[],
): Channel | null {
  for (const c of preferred) if (eligible.includes(c)) return c;
  return null;
}
