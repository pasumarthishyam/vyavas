/**
 * Which paused cases are still worth waking.
 *
 * The rule this pins: a message has to be about something the person still
 * remembers doing. Resuming used to be automatic and unconditional, so pausing
 * an account for a week and switching it back on would have messaged everyone
 * who had been waiting, all at once, about checkouts they abandoned days ago.
 */

import { describe, expect, it } from 'vitest';

import {
  RESUME_MAX_AGE_DAYS,
  classifyPausedCase,
  isClosing,
} from '../../src/core/guards/resume.js';

const NOW = new Date('2026-09-10T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const daysAgo = (d: number) => hoursAgo(d * 24);

const classify = (createdAt: Date, deadlineAt: Date | null = null) =>
  classifyPausedCase({ now: NOW, createdAt, deadlineAt });

describe('a fresh case is resumed', () => {
  it('wakes one that failed minutes ago', () => {
    const r = classify(hoursAgo(0.25), new Date(NOW.getTime() + 86_400_000));
    expect(r.disposition).toBe('resume');
    expect(r.ageDays).toBe(0);
  });

  it('wakes one right up to the age limit', () => {
    // Exactly three days is still inside. The comparison is `>`, so the
    // boundary belongs to the customer rather than against them.
    const r = classify(daysAgo(RESUME_MAX_AGE_DAYS), new Date(NOW.getTime() + 86_400_000));
    expect(r.disposition).toBe('resume');
  });

  it('reports the age in whole days, for the operator to read', () => {
    expect(classify(daysAgo(2)).ageDays).toBe(2);
    // Floored, not rounded: 2.9 days is not 3, and rounding it up would put a
    // case in a bucket the comparison below disagrees with.
    expect(classify(hoursAgo(2 * 24 + 22)).ageDays).toBe(2);
  });
});

describe('a stale case is closed, not messaged', () => {
  it('refuses one just past the age limit', () => {
    const r = classify(hoursAgo(RESUME_MAX_AGE_DAYS * 24 + 1), new Date(NOW.getTime() + 86_400_000));
    expect(r.disposition).toBe('too_old');
    expect(r.reason).toContain('too long to message about now');
  });

  it('refuses a week-old case', () => {
    // The scenario the whole rule exists for: paused on Monday, resumed the
    // following Monday.
    const r = classify(daysAgo(7), new Date(NOW.getTime() + 7 * 86_400_000));
    expect(r.disposition).toBe('too_old');
    expect(r.ageDays).toBe(7);
  });

  it('is NOT governed by the deadline, which asks a different question', () => {
    /*
     * A subscription_failure carries a fourteen-day deadline. That is right for
     * a ladder that has been messaging all along, and plainly wrong as a licence
     * to send a FIRST message about a charge that failed a fortnight ago. The
     * two numbers answer different questions and this is where they diverge.
     */
    const deadlineStillOpen = new Date(NOW.getTime() + 7 * 86_400_000);
    expect(classify(daysAgo(6), deadlineStillOpen).disposition).toBe('too_old');
  });
});

describe('a case past its deadline', () => {
  it('is reported as past deadline, not merely old', () => {
    // Checked first, because "the window closed" is the more specific truth and
    // saying "too old" about it would hide why.
    const r = classify(daysAgo(5), hoursAgo(2));
    expect(r.disposition).toBe('past_deadline');
    expect(r.reason).toContain('closed while this was paused');
  });

  it('applies even to a case that is otherwise fresh', () => {
    const r = classify(hoursAgo(1), hoursAgo(0.5));
    expect(r.disposition).toBe('past_deadline');
  });

  it('treats a null deadline as no deadline at all', () => {
    expect(classify(hoursAgo(2), null).disposition).toBe('resume');
  });
});

describe('isClosing', () => {
  it('separates the one disposition that sends from the two that do not', () => {
    expect(isClosing('resume')).toBe(false);
    expect(isClosing('too_old')).toBe(true);
    expect(isClosing('past_deadline')).toBe(true);
  });
});
