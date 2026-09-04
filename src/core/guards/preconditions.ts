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
  /**
   * The RECOVERY LINK this case created has been paid.
   *
   * A separate fact from `orderPaid`, and it has to be. A Razorpay payment link
   * creates its own order when it is paid, so a customer who pays through the
   * link we sent them leaves the ORIGINAL order sitting at `created` forever —
   * `orderPaid` keeps answering "no" and every remaining rung fires at someone
   * who has already paid. The `payment_link_paid` abort condition has been
   * listed on every customer-facing row in the policy table since Stage 2 with
   * nothing behind it; this is that fact.
   */
  readonly paymentLinkPaid: boolean;
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
  /**
   * The OLDEST touch still inside the rolling 24h window. Null when none.
   *
   * This is what makes "when does the cap clear?" a fact rather than a guess.
   * The window is rolling, so the moment a slot frees is exactly 24h after the
   * oldest message in it — knowable to the second, from a row we already have.
   *
   * It matters because the answer decides whether a case lives or dies. The
   * previous code deferred a capped rung by a flat hour, and the ladder gives a
   * deferred rung a bounded number of retries; when the real wait was three
   * hours, the ladder exhausted its patience an hour early, returned
   * `ladder_complete`, and left the case pinned in `executing` with no timer
   * pointing at it and nothing sent. Money on the table, no alert, no trace
   * except four `rung_deferred` rows that all say the same thing.
   */
  readonly oldestMessageInWindowAt: Date | null;

  /**
   * Minutes since this person last actually heard from us. Null = never.
   *
   * The count-based cap cannot express "not twice in five minutes": under a cap
   * of 2, a second message ninety seconds after the first is permitted, and a
   * person with two live cases gets both.
   */
  readonly minutesSinceLastTouch: number | null;
  /** Hard floor on that gap. Deterministic, never a judgement call. */
  readonly minGapMinutes: number;

  /**
   * Is this the FIRST touch on this case?
   *
   * Only the first one can qualify for the live-customer exemption below. A
   * follow-up hours later is an outbound message like any other.
   */
  readonly isFirstTouch: boolean;
  /** Minutes since the payment failed. */
  readonly minutesSinceFailure: number;
  /**
   * How long the customer is assumed to still be on the checkout page.
   *
   * Inside this window a first touch is a RESPONSE to something the person did
   * seconds ago, not an outbound campaign — see the quiet-hours check below.
   */
  readonly liveCustomerWindowMinutes: number;

  readonly timeZone: string;
  readonly quietHours: QuietHours;

  /** Customer messages the merchant has left in today's budget. */
  readonly merchantBudgetRemaining: number;
  /** Null when the case is attended and no mandate is involved. */
  readonly mandateActive: boolean | null;

  /** Merchant kill switch. False means nothing fires, whatever the ladder says. */
  readonly executionEnabled: boolean;
}

/**
 * `paused` is separate from `abort` and from `defer`, and it has to be.
 *
 * An abort is terminal, so treating a paused merchant as an abort destroyed
 * every case in flight the moment someone pressed the switch — that was the
 * behaviour, and turning the account back on recovered none of them.
 *
 * A defer is not right either: a defer names a time to try again, and a pause
 * has no such time. It ends when a person decides it ends, which might be an
 * hour or a month. Parking a durable run on a guessed retry time either wakes
 * it uselessly all week or gives up before the pause is over.
 *
 * So pause is its own answer: park the case in `paused`, end the run, and let
 * the resume path start a fresh one from the same rung.
 */
export type Disposition = 'proceed' | 'defer' | 'abort' | 'paused';

/**
 * Why the gate stopped or delayed a rung.
 *
 * Mostly the name of the precondition that failed, plus four outcomes that are
 * not preconditions at all. The last three used to be reported as
 * `order_unpaid` between them, which made the caller unable to tell "the money
 * arrived" from "we ran out of time" — so the ladder marked BOTH as `aborted`
 * with reason `already_paid`, and a recovered case was recorded as an abort
 * with no recovered amount against it.
 */
export type GateFailure =
  | Precondition
  | 'execution_paused'
  | 'order_paid'
  | 'payment_link_paid'
  | 'deadline_passed';

export interface GateResult {
  readonly disposition: Disposition;
  readonly failed: GateFailure | null;
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

/** No `retryAt`: a pause ends when a person ends it, not at a time we can name. */
const paused: GateResult = {
  disposition: 'paused',
  failed: 'execution_paused',
  reason: 'the merchant has paused this agent',
  retryAt: null,
};

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
  // ── the pause ──
  //
  // Checked first, and it outranks every ladder — a paused agent does nothing,
  // whatever any policy row says. But it is not an abort: the case is parked,
  // not ended, and resuming picks it up at the same rung.
  //
  // Ordered ABOVE the paid checks deliberately. Those two do reach the ledger
  // (they mark a case recovered), and a paused agent should not be writing
  // outcomes. A payment that lands during a pause is picked up by the webhook
  // and by the reconciliation sweep regardless, so nothing is missed by
  // declining to notice it here.
  if (!facts.executionEnabled) return paused;

  // ── aborts ──

  // Checked unconditionally, even if the policy forgot to list it. Messaging
  // someone who has already paid is the mistake that ends the relationship, and
  // it must not be possible to opt out of noticing.
  if (facts.orderPaid) {
    return abort('order_paid', 'the order has been paid — nothing is at risk');
  }

  // Checked unconditionally alongside `orderPaid`, and for the same reason. The
  // customer paid on the link we sent them, which is the ladder working; the
  // original order will never say so.
  if (facts.paymentLinkPaid) {
    return abort('payment_link_paid', 'the recovery link has been paid — nothing is at risk');
  }

  if (facts.deadlinePassed) {
    return abort('deadline_passed', 'the deadline has passed — this case is closed');
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

  // ── the cool-off floor ──
  //
  // Checked UNCONDITIONALLY, like `order_unpaid`, and for the same reason: it
  // is a safety limit, and a policy may tighten a safety limit but never loosen
  // one. A ladder that forgot to list it would otherwise be free to message
  // someone twice in five minutes.
  //
  // Deliberately not a judgement call. A model that is right 99% of the time
  // still double-messages someone once every hundred runs; a comparison does
  // not.
  if (
    facts.minutesSinceLastTouch !== null &&
    facts.minGapMinutes > 0 &&
    facts.minutesSinceLastTouch < facts.minGapMinutes
  ) {
    const waitMs = (facts.minGapMinutes - facts.minutesSinceLastTouch) * MINUTE;
    return defer(
      'within_frequency_cap',
      `messaged ${facts.minutesSinceLastTouch} minute(s) ago — inside the ${facts.minGapMinutes} minute cool-off`,
      new Date(facts.now.getTime() + waitMs),
    );
  }

  if (required.includes('within_frequency_cap') && facts.recentMessageCount >= facts.frequencyCap) {
    // The window is rolling, so a slot frees exactly 24h after the oldest
    // message still in it. Computed, not guessed — the caller sleeps until this
    // instant, and a wrong answer here is a dropped case (see the field's note).
    // The minute of margin keeps us from waking a hair early and re-deferring.
    const clearsAt =
      facts.oldestMessageInWindowAt !== null
        ? new Date(facts.oldestMessageInWindowAt.getTime() + 24 * HOUR + MINUTE)
        : // No timestamp to reason from — fall back to the old behaviour rather
          // than inventing one. This should be unreachable: the count is above
          // the cap, so there is at least one message in the window.
          new Date(facts.now.getTime() + HOUR);

    return defer(
      'within_frequency_cap',
      `already ${facts.recentMessageCount} message(s) in 24h (cap ${facts.frequencyCap})`,
      clearsAt,
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
  //
  // ── the live-customer exemption ──
  //
  // Quiet hours exist to stop us WAKING PEOPLE UP. Someone who tapped Pay
  // ninety seconds ago is awake, holding their phone, looking at an error
  // message. Telling them "your card details didn't go through — UPI will work"
  // is help, and it is a response to something they just did, not an outbound
  // campaign at 22:47.
  //
  // Deferring it to 08:00 does not protect that person from anything; it loses
  // the sale, because intent decays in minutes. `customer_input` is the class
  // whose whole ladder opens at 0m for exactly this reason.
  //
  // Scoped so it cannot become a 3am loophole: FIRST touch only, and only
  // inside a short window after the failure. Every later rung obeys quiet hours
  // normally.
  if (required.includes('not_quiet_hours')) {
    const customerIsLive =
      facts.isFirstTouch && facts.minutesSinceFailure <= facts.liveCustomerWindowMinutes;

    if (!customerIsLive) {
      const allowed = nextAllowedTime(facts.now, facts.timeZone, facts.quietHours);
      if (allowed.getTime() > facts.now.getTime()) {
        return defer('not_quiet_hours', 'inside the merchant quiet-hours window', allowed);
      }
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
