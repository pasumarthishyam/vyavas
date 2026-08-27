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
    deadlinePassed: false,
    customerOptedOut: false,
    eligibleChannels: ['whatsapp', 'sms'],
    lastAttemptAt: null,
    liveAttemptWindowMinutes: 3,
    recentMessageCount: 0,
    frequencyCap: 2,
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

  it('aborts when the merchant kill switch is off', () => {
    const r = evaluatePreconditions([], facts({ executionEnabled: false }));
    expect(r.disposition).toBe('abort');
    expect(r.failed).toBe('execution_disabled');
  });

  it('puts the kill switch ahead of everything else', () => {
    const r = evaluatePreconditions(ALL, facts({ executionEnabled: false, orderPaid: true }));
    expect(r.failed).toBe('execution_disabled');
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
    expect(selectChannel(['whatsapp', 'sms'], ['sms', 'email'])).toBe('sms');
    expect(selectChannel(['whatsapp', 'sms'], ['whatsapp', 'sms'])).toBe('whatsapp');
  });

  it('returns null when nothing matches', () => {
    expect(selectChannel(['whatsapp'], ['email'])).toBeNull();
    expect(selectChannel(['whatsapp'], [])).toBeNull();
  });

  it('respects preference order, not eligibility order', () => {
    expect(selectChannel(['email', 'whatsapp'], ['whatsapp', 'email'])).toBe('email');
  });
});
