/**
 * The guards.
 *
 * Pure, so the whole space is testable without a workflow engine. The property
 * that matters most is the abort/defer split — getting it backwards either
 * messages someone who already paid, or throws away a recoverable case because
 * we happened to look at 11pm.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_QUIET_HOURS,
  isQuietHour,
  localHour,
  nextAllowedTime,
  quietHoursDelayMs,
} from '@core/guards/quiet-hours.js';
import {
  type PreconditionFacts,
  evaluatePreconditions,
  selectChannel,
} from '@core/guards/preconditions.js';
import type { Precondition } from '@core/policy/schema.js';

const IST = 'Asia/Kolkata';

/** 2026-08-27 14:10 UTC is 19:40 IST — inside the working day. */
const AFTERNOON = new Date('2026-08-27T14:10:00.000Z');
/** 18:30 UTC is 00:00 IST — the middle of the night. */
const MIDNIGHT_IST = new Date('2026-08-27T18:30:00.000Z');
/** 16:00 UTC is 21:30 IST — just inside quiet hours. */
const LATE_IST = new Date('2026-08-27T16:00:00.000Z');

describe('localHour', () => {
  it('converts to the merchant zone', () => {
    expect(localHour(AFTERNOON, IST)).toBe(19);
    expect(localHour(MIDNIGHT_IST, IST)).toBe(0);
    expect(localHour(AFTERNOON, 'UTC')).toBe(14);
  });

  it('falls back to UTC on a bad zone rather than throwing', () => {
    // A malformed timezone in one merchant's settings must not take the
    // workflow down for every other tenant.
    expect(localHour(AFTERNOON, 'Not/AZone')).toBe(14);
  });
});

describe('isQuietHour', () => {
  it('handles a window that wraps midnight', () => {
    // 21 → 8 is the normal case, and the one a naive
    // `hour >= start && hour < end` gets exactly backwards.
    expect(isQuietHour(LATE_IST, IST, DEFAULT_QUIET_HOURS)).toBe(true); // 21:30
    expect(isQuietHour(MIDNIGHT_IST, IST, DEFAULT_QUIET_HOURS)).toBe(true); // 00:00
    expect(isQuietHour(AFTERNOON, IST, DEFAULT_QUIET_HOURS)).toBe(false); // 19:40
  });

  it('handles a window that does not wrap', () => {
    const lunch = { start: 12, end: 14 };
    expect(isQuietHour(new Date('2026-08-27T07:00:00Z'), IST, lunch)).toBe(true); // 12:30
    expect(isQuietHour(AFTERNOON, IST, lunch)).toBe(false);
  });

  it('treats a zero-width window as silencing nothing', () => {
    expect(isQuietHour(MIDNIGHT_IST, IST, { start: 9, end: 9 })).toBe(false);
  });
});

describe('nextAllowedTime', () => {
  it('returns the instant unchanged when it is already fine', () => {
    expect(nextAllowedTime(AFTERNOON, IST, DEFAULT_QUIET_HOURS).getTime()).toBe(
      AFTERNOON.getTime(),
    );
  });

  it('walks forward out of the window', () => {
    const out = nextAllowedTime(MIDNIGHT_IST, IST, DEFAULT_QUIET_HOURS);
    expect(out.getTime()).toBeGreaterThan(MIDNIGHT_IST.getTime());
    expect(isQuietHour(out, IST, DEFAULT_QUIET_HOURS)).toBe(false);
    expect(localHour(out, IST)).toBe(8);
  });

  it('escapes from the very start of the window', () => {
    const out = nextAllowedTime(LATE_IST, IST, DEFAULT_QUIET_HOURS);
    expect(isQuietHour(out, IST, DEFAULT_QUIET_HOURS)).toBe(false);
    // ~10.5 hours of waiting from 21:30 to 08:00.
    expect(out.getTime() - LATE_IST.getTime()).toBeGreaterThan(9 * 3600_000);
  });

  it('always terminates, even on a window that never opens', () => {
    const out = nextAllowedTime(AFTERNOON, IST, { start: 0, end: 24 });
    expect(out).toBeInstanceOf(Date);
  });

  it('reports zero delay outside quiet hours', () => {
    expect(quietHoursDelayMs(AFTERNOON, IST, DEFAULT_QUIET_HOURS)).toBe(0);
    expect(quietHoursDelayMs(MIDNIGHT_IST, IST, DEFAULT_QUIET_HOURS)).toBeGreaterThan(0);
  });
});

// ─── preconditions ───────────────────────────────────────────────────────────

const ALL: Precondition[] = [
  'order_unpaid',
  'no_live_attempt',
  'consent_ok',
  'not_quiet_hours',
  'within_frequency_cap',
  'merchant_budget_available',
  'channel_deliverable',
];

function facts(over: Partial<PreconditionFacts> = {}): PreconditionFacts {
  return {
    now: AFTERNOON,
    orderPaid: false,
    paymentLinkPaid: false,
    deadlinePassed: false,
    customerOptedOut: false,
    eligibleChannels: ['whatsapp', 'email'],
    lastAttemptAt: null,
    liveAttemptWindowMinutes: 3,
    recentMessageCount: 0,
    frequencyCap: 2,
    oldestMessageInWindowAt: null,
    minutesSinceLastTouch: null,
    minGapMinutes: 360,
    // Defaults describe an ORDINARY outbound rung — a follow-up, well after the
    // failure. The live-customer exemption is opted into explicitly by the
    // tests that are about it, so every other test keeps meaning what it says.
    isFirstTouch: false,
    minutesSinceFailure: 60,
    liveCustomerWindowMinutes: 15,
    timeZone: IST,
    quietHours: DEFAULT_QUIET_HOURS,
    merchantBudgetRemaining: 100,
    mandateActive: null,
    executionEnabled: true,
    ...over,
  };
}

describe('evaluatePreconditions — the happy path', () => {
  it('proceeds when everything is in order', () => {
    const r = evaluatePreconditions(ALL, facts());
    expect(r.disposition).toBe('proceed');
    expect(r.failed).toBeNull();
  });
});

describe('aborts — the reason will never stop being true', () => {
  it('aborts when the order has been paid', () => {
    const r = evaluatePreconditions(ALL, facts({ orderPaid: true }));
    expect(r.disposition).toBe('abort');
    expect(r.reason).toContain('paid');
  });

  it('aborts on a paid order EVEN IF the policy forgot to require the check', () => {
    // Not opt-out-able. Messaging someone who has already paid is the mistake
    // that ends the merchant relationship, so noticing it cannot be a policy
    // author's choice.
    const r = evaluatePreconditions([], facts({ orderPaid: true }));
    expect(r.disposition).toBe('abort');
  });

  it('aborts once the deadline has passed', () => {
    expect(evaluatePreconditions(ALL, facts({ deadlinePassed: true })).disposition).toBe('abort');
  });

  it('aborts for an opted-out customer, whatever else is true', () => {
    const r = evaluatePreconditions([], facts({ customerOptedOut: true }));
    expect(r.disposition).toBe('abort');
    expect(r.failed).toBe('consent_ok');
  });

  it('aborts when the mandate is gone', () => {
    const r = evaluatePreconditions(['mandate_active'], facts({ mandateActive: false }));
    expect(r.disposition).toBe('abort');
    expect(r.reason).toContain('not permitted');
  });

  it('aborts when there is no reachable channel', () => {
    // No amount of waiting produces a phone number we never had.
    const r = evaluatePreconditions(ALL, facts({ eligibleChannels: [] }));
    expect(r.disposition).toBe('abort');
    expect(r.failed).toBe('channel_deliverable');
  });

  it('PAUSES rather than aborting when the merchant has paused the agent', () => {
    /*
     * The distinction this test exists to pin.
     *
     * A paused merchant used to produce an abort, and an abort is terminal —
     * so pausing an account destroyed every case in flight and switching back
     * recovered none of them. It must be its own disposition, or the ladder
     * cannot tell "park this" from "this is over".
     */
    const r = evaluatePreconditions([], facts({ executionEnabled: false }));
    expect(r.disposition).toBe('paused');
    expect(r.failed).toBe('execution_paused');
    // No retryAt: a pause ends when a person ends it, not at a time we can name.
    expect(r.retryAt).toBeNull();
  });

  it('puts the pause ahead of everything else, including a paid order', () => {
    // Ordered above the paid checks on purpose. Those two reach the ledger and
    // mark a case recovered, and a paused agent should not be writing outcomes.
    // The webhook and the reconciliation sweep still catch the payment.
    const r = evaluatePreconditions(ALL, facts({ executionEnabled: false, orderPaid: true }));
    expect(r.disposition).toBe('paused');
    expect(r.failed).toBe('execution_paused');
  });
});

describe('defers — the reason is about right now', () => {
  it('defers past a live payment attempt', () => {
    const r = evaluatePreconditions(
      ALL,
      facts({ lastAttemptAt: new Date(AFTERNOON.getTime() - 60_000) }),
    );
    // Deferred, never aborted: someone mid-retry is the MOST recoverable
    // customer there is.
    expect(r.disposition).toBe('defer');
    expect(r.failed).toBe('no_live_attempt');
    expect(r.retryAt!.getTime()).toBeGreaterThan(AFTERNOON.getTime());
  });

  it('proceeds once the live-attempt window has passed', () => {
    const r = evaluatePreconditions(
      ALL,
      facts({ lastAttemptAt: new Date(AFTERNOON.getTime() - 10 * 60_000) }),
    );
    expect(r.disposition).toBe('proceed');
  });

  it('defers at the frequency cap', () => {
    const r = evaluatePreconditions(ALL, facts({ recentMessageCount: 2, frequencyCap: 2 }));
    expect(r.disposition).toBe('defer');
    expect(r.reason).toContain('cap 2');
  });

  /*
   * The window is rolling, so the moment a slot frees is knowable exactly: 24h
   * after the oldest message still inside it. It used to be guessed as a flat
   * hour, and the guess is what lost a real case — the ladder gives a deferred
   * rung a bounded number of retries, so an under-estimate makes it exhaust its
   * patience and abandon the case before the gate would ever have opened.
   */
  it('names the exact instant the cap clears, not an hour from now', () => {
    // Oldest of the two touches was 21h ago, so three more hours to wait.
    const oldest = new Date(AFTERNOON.getTime() - 21 * 3600_000);
    const r = evaluatePreconditions(
      ALL,
      facts({ recentMessageCount: 2, frequencyCap: 2, oldestMessageInWindowAt: oldest }),
    );

    expect(r.disposition).toBe('defer');
    const waitMinutes = (r.retryAt!.getTime() - AFTERNOON.getTime()) / 60_000;
    // Three hours, plus the one minute of margin that stops us waking early.
    expect(waitMinutes).toBeCloseTo(181, 0);
  });

  it('waits past the naive one-hour guess when the window says so', () => {
    const oldest = new Date(AFTERNOON.getTime() - 2 * 3600_000);
    const r = evaluatePreconditions(
      ALL,
      facts({ recentMessageCount: 2, frequencyCap: 2, oldestMessageInWindowAt: oldest }),
    );
    // 22 hours out — the old flat hour would have given up twenty-one hours early.
    expect(r.retryAt!.getTime() - AFTERNOON.getTime()).toBeGreaterThan(21 * 3600_000);
  });

  it('falls back to an hour when there is no timestamp to reason from', () => {
    const r = evaluatePreconditions(
      ALL,
      facts({ recentMessageCount: 2, frequencyCap: 2, oldestMessageInWindowAt: null }),
    );
    expect(r.retryAt!.getTime() - AFTERNOON.getTime()).toBe(3600_000);
  });

  it('defers on an exhausted merchant budget, and waits longer', () => {
    const r = evaluatePreconditions(ALL, facts({ merchantBudgetRemaining: 0 }));
    expect(r.disposition).toBe('defer');
    // Budgets reset daily; an hourly retry would just burn workflow steps.
    expect(r.retryAt!.getTime() - AFTERNOON.getTime()).toBeGreaterThan(3600_000);
  });

  it('defers inside quiet hours to the moment they end', () => {
    const r = evaluatePreconditions(ALL, facts({ now: MIDNIGHT_IST }));
    expect(r.disposition).toBe('defer');
    expect(r.failed).toBe('not_quiet_hours');
    expect(localHour(r.retryAt!, IST)).toBe(8);
  });

  it('ignores quiet hours when the policy does not require the check', () => {
    const r = evaluatePreconditions(['order_unpaid'], facts({ now: MIDNIGHT_IST }));
    expect(r.disposition).toBe('proceed');
  });
});

describe('ordering', () => {
  it('reports the abort even when a defer condition also holds', () => {
    // A case that should stop must never be deferred into a future where it
    // might still fire.
    const r = evaluatePreconditions(
      ALL,
      facts({ orderPaid: true, now: MIDNIGHT_IST, recentMessageCount: 99 }),
    );
    expect(r.disposition).toBe('abort');
  });

  it('never returns a retryAt on an abort', () => {
    for (const over of [
      { orderPaid: true },
      { customerOptedOut: true },
      { deadlinePassed: true },
      { executionEnabled: false },
    ]) {
      expect(evaluatePreconditions(ALL, facts(over)).retryAt).toBeNull();
    }
  });

  it('always returns a retryAt on a defer', () => {
    for (const over of [
      { lastAttemptAt: new Date(AFTERNOON.getTime() - 1000) },
      { recentMessageCount: 5 },
      { merchantBudgetRemaining: 0 },
      { now: MIDNIGHT_IST },
    ]) {
      const r = evaluatePreconditions(ALL, facts(over));
      expect(r.disposition, JSON.stringify(over)).toBe('defer');
      expect(r.retryAt).not.toBeNull();
      expect(r.retryAt!.getTime()).toBeGreaterThan(facts(over).now.getTime());
    }
  });
});

describe('selectChannel', () => {
  it('takes the first preferred channel the customer can receive on', () => {
    expect(selectChannel(['whatsapp', 'email'], ['email'])).toBe('email');
    expect(selectChannel(['whatsapp', 'email'], ['whatsapp', 'email'])).toBe('whatsapp');
  });

  it('returns null when nothing matches', () => {
    expect(selectChannel(['whatsapp'], ['email'])).toBeNull();
    expect(selectChannel(['whatsapp'], [])).toBeNull();
  });

  it('respects preference order, not eligibility order', () => {
    expect(selectChannel(['email', 'whatsapp'], ['whatsapp', 'email'])).toBe('email');
  });
});

/**
 * The cool-off floor.
 *
 * The frequency cap counts messages over 24 hours and cannot express "not twice
 * in five minutes" — under a cap of 2, a second message ninety seconds after
 * the first is permitted, and a customer with two live cases receives both.
 */
describe('minGapMinutes — the floor the cap cannot express', () => {
  it('defers a second message inside the cool-off, even with cap headroom', () => {
    const r = evaluatePreconditions(
      ALL,
      // Well inside a cap of 2, and five minutes since we last spoke.
      facts({ recentMessageCount: 1, frequencyCap: 2, minutesSinceLastTouch: 5, minGapMinutes: 360 }),
    );

    expect(r.disposition).toBe('defer');
    expect(r.reason).toContain('cool-off');
    // Defer, not abort: the case is fine, only the timing is wrong.
    expect(r.retryAt).not.toBeNull();
  });

  it('proceeds once the gap has passed', () => {
    const r = evaluatePreconditions(ALL, facts({ minutesSinceLastTouch: 400, minGapMinutes: 360 }));
    expect(r.disposition).toBe('proceed');
  });

  it('never blocks a first touch', () => {
    expect(evaluatePreconditions(ALL, facts({ minutesSinceLastTouch: null })).disposition).toBe(
      'proceed',
    );
  });

  it('applies even when the policy does not list a frequency precondition', () => {
    // A safety limit, so a ladder cannot opt out of it by omission — the same
    // reasoning as `order_unpaid`. A policy may tighten a safety limit and may
    // never loosen one.
    const r = evaluatePreconditions([], facts({ minutesSinceLastTouch: 2, minGapMinutes: 360 }));
    expect(r.disposition).toBe('defer');
    expect(r.reason).toContain('cool-off');
  });

  it('retries just after the gap expires, not immediately', () => {
    const r = evaluatePreconditions(ALL, facts({ minutesSinceLastTouch: 350, minGapMinutes: 360 }));
    // 10 minutes left, so retrying now would just busy-wait against the floor.
    expect(r.retryAt!.getTime() - AFTERNOON.getTime()).toBe(10 * 60_000);
  });
});

/**
 * The live-customer window.
 *
 * A card fails at 22:47. The customer is on the checkout page, holding their
 * phone, looking at the error. Quiet hours exist to stop us waking people up —
 * not to stop us answering someone who acted ninety seconds ago.
 */
describe('the live-customer window', () => {
  const atNight = { now: LATE_IST, timeZone: IST, quietHours: DEFAULT_QUIET_HOURS };

  it('lets the first touch through during quiet hours', () => {
    const r = evaluatePreconditions(
      ALL,
      facts({ ...atNight, isFirstTouch: true, minutesSinceFailure: 1, liveCustomerWindowMinutes: 15 }),
    );
    expect(r.disposition).toBe('proceed');
  });

  it('still defers a follow-up during quiet hours', () => {
    // The exemption is about answering someone who is present, not about
    // being allowed to message at night.
    const r = evaluatePreconditions(
      ALL,
      facts({ ...atNight, isFirstTouch: false, minutesSinceFailure: 1 }),
    );
    expect(r.disposition).toBe('defer');
    expect(r.failed).toBe('not_quiet_hours');
  });

  it('lets a first touch long after the failure through on EMAIL only', () => {
    /*
     * Past the live-customer window the person has put the phone down, so the
     * WhatsApp exemption is over — but a payment that failed at 01:30 used to
     * produce nothing at all until 08:00, by which time the intent is gone.
     *
     * Email is the resolution: it waits in an inbox rather than lighting up a
     * phone, so the harm quiet hours exist to prevent does not apply to it.
     */
    const r = evaluatePreconditions(
      ALL,
      facts({ ...atNight, isFirstTouch: true, minutesSinceFailure: 90, liveCustomerWindowMinutes: 15 }),
    );
    expect(r.disposition).toBe('proceed');
    expect(r.restrictToChannels).toEqual(['email']);
  });

  it('still defers overnight when the customer has no email', () => {
    // The exemption is a channel decision, not an hour decision. With nothing
    // safe to send on, the rung waits for morning exactly as it always did.
    const r = evaluatePreconditions(
      ALL,
      facts({
        ...atNight,
        isFirstTouch: true,
        minutesSinceFailure: 90,
        eligibleChannels: ['whatsapp'],
      }),
    );
    expect(r.disposition).toBe('defer');
    expect(r.failed).toBe('not_quiet_hours');
  });

  it('does NOT extend the overnight exemption to a follow-up', () => {
    // The narrowing that keeps this from becoming "email whenever we like".
    // A second touch is a campaign, and a campaign waits for morning.
    const r = evaluatePreconditions(
      ALL,
      facts({ ...atNight, isFirstTouch: false, minutesSinceFailure: 90 }),
    );
    expect(r.disposition).toBe('defer');
    expect(r.failed).toBe('not_quiet_hours');
  });

  it('narrows nothing outside quiet hours', () => {
    // The restriction must be scoped to the branch that needs it — a daytime
    // rung keeps every channel the policy asked for.
    const r = evaluatePreconditions(ALL, facts({ isFirstTouch: true, minutesSinceFailure: 90 }));
    expect(r.disposition).toBe('proceed');
    expect(r.restrictToChannels).toBeNull();
  });

  it('does not exempt anything else', () => {
    // Opted out is opted out, however live the customer is.
    const r = evaluatePreconditions(
      ALL,
      facts({ ...atNight, isFirstTouch: true, minutesSinceFailure: 0, customerOptedOut: true }),
    );
    expect(r.disposition).toBe('abort');
  });
});
