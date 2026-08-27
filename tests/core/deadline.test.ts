import { describe, expect, it } from 'vitest';
import { computeDeadline, hoursUntilDeadline, isPastDeadline } from '@core/case/deadline.js';
import { paise } from '@core/money.js';

const NOW = new Date('2026-08-27T14:10:00.000Z');
const H = 60 * 60 * 1000;
const D = 24 * H;

describe('windows by case type', () => {
  it('gives an attended failure three days', () => {
    const d = computeDeadline({ now: NOW, caseType: 'payment_failure', amount: paise(184300) });
    expect(d.getTime() - NOW.getTime()).toBe(72 * H);
  });

  it('gives a deliberate exit less, because intent decays', () => {
    const d = computeDeadline({ now: NOW, caseType: 'intent_exit', amount: paise(184300) });
    expect(d.getTime() - NOW.getTime()).toBe(48 * H);
  });

  it('gives a subscription the longest attended runway — the relationship is at stake', () => {
    const d = computeDeadline({ now: NOW, caseType: 'subscription_failure', amount: paise(184300) });
    expect(d.getTime() - NOW.getTime()).toBe(14 * D);
  });
});

describe('ticket size', () => {
  it('halves the window for a micro ticket', () => {
    const d = computeDeadline({ now: NOW, caseType: 'payment_failure', amount: paise(19900) });
    expect(d.getTime() - NOW.getTime()).toBe(36 * H);
  });

  it('doubles it for an enterprise ticket', () => {
    const d = computeDeadline({ now: NOW, caseType: 'payment_failure', amount: paise(50000000) });
    expect(d.getTime() - NOW.getTime()).toBe(144 * H);
  });

  it('ignores ticket size for intent decay — a big cart is not abandoned for longer', () => {
    const small = computeDeadline({ now: NOW, caseType: 'intent_exit', amount: paise(19900) });
    const big = computeDeadline({ now: NOW, caseType: 'intent_exit', amount: paise(50000000) });
    expect(small.getTime()).toBe(big.getTime());
  });
});

describe('receivables anchor on the due date, not on now', () => {
  it('counts from the due date', () => {
    const dueAt = new Date('2026-08-20T00:00:00.000Z');
    const d = computeDeadline({
      now: NOW,
      caseType: 'receivable_overdue',
      amount: paise(184300),
      dueAt,
    });
    expect(d.getTime()).toBe(dueAt.getTime() + 30 * D);
  });

  it('does not hand a long-overdue invoice a fresh 30-day runway', () => {
    const dueAt = new Date('2025-01-01T00:00:00.000Z'); // ~20 months overdue
    const d = computeDeadline({
      now: NOW,
      caseType: 'receivable_overdue',
      amount: paise(184300),
      dueAt,
    });
    // Clamped to a single window back from now, not restarted from today.
    expect(d.getTime()).toBeLessThanOrEqual(NOW.getTime() + 2 * H);
  });
});

describe('floor', () => {
  it('never returns a deadline in the past — a case is never born lost', () => {
    const dueAt = new Date('2020-01-01T00:00:00.000Z');
    const d = computeDeadline({
      now: NOW,
      caseType: 'receivable_overdue',
      amount: paise(100),
      dueAt,
    });
    expect(d.getTime()).toBeGreaterThan(NOW.getTime());
  });
});

describe('helpers', () => {
  it('detects a passed deadline', () => {
    expect(isPastDeadline(new Date(NOW.getTime() - 1), NOW)).toBe(true);
    expect(isPastDeadline(new Date(NOW.getTime() + 1), NOW)).toBe(false);
    expect(isPastDeadline(null, NOW)).toBe(false);
  });

  it('reports hours remaining', () => {
    expect(hoursUntilDeadline(new Date(NOW.getTime() + 3 * H), NOW)).toBe(3);
  });
});
