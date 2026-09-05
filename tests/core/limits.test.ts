/**
 * The bounds on the per-merchant dials.
 *
 * The failure these exist to prevent actually happened: `frequency_cap_per_day`
 * was set to 1000 for testing, which turned the per-customer 24h cap off, and
 * it stayed that way in production for weeks. Nothing in the repository
 * mentioned it and no test could have caught it — as far as every layer of code
 * was concerned the value was simply the value.
 */

import { describe, expect, it } from 'vitest';

import { DIAL_BOUNDS, clampDial, effectiveDials, isDialOutOfBounds } from '../../src/core/limits.js';

describe('clampDial', () => {
  it('brings the exact value that caused the incident back into range', () => {
    // 1000 was the stored cap. What the gate may actually be told is 10.
    expect(clampDial('frequencyCapPerDay', 1000)).toBe(DIAL_BOUNDS.frequencyCapPerDay.max);
    expect(isDialOutOfBounds('frequencyCapPerDay', 1000)).toBe(true);
  });

  it('leaves a sane value exactly as it is', () => {
    expect(clampDial('frequencyCapPerDay', 3)).toBe(3);
    expect(isDialOutOfBounds('frequencyCapPerDay', 3)).toBe(false);
    expect(clampDial('minGapMinutes', 15)).toBe(15);
    expect(clampDial('dailyMessageBudget', 1000)).toBe(1000);
  });

  it('clamps to the EDGE, not to the default', () => {
    // Snapping 1000 down to 3 would be a surprise mid-incident: the operator
    // plainly wanted "as loose as allowed", and that is what they get.
    expect(clampDial('frequencyCapPerDay', 1000)).not.toBe(DIAL_BOUNDS.frequencyCapPerDay.fallback);
  });

  it('permits a deliberate zero cool-off', () => {
    // A sandbox demonstrating the whole ladder in two minutes needs this, and
    // forbidding it would only move the workaround somewhere less visible.
    expect(clampDial('minGapMinutes', 0)).toBe(0);
  });

  it('refuses a cap below one — a cap of zero would send nothing, ever', () => {
    expect(clampDial('frequencyCapPerDay', 0)).toBe(DIAL_BOUNDS.frequencyCapPerDay.min);
    expect(clampDial('frequencyCapPerDay', -5)).toBe(DIAL_BOUNDS.frequencyCapPerDay.min);
  });

  it('falls back rather than propagating a null or a NaN', () => {
    expect(clampDial('frequencyCapPerDay', null)).toBe(DIAL_BOUNDS.frequencyCapPerDay.fallback);
    expect(clampDial('frequencyCapPerDay', undefined)).toBe(DIAL_BOUNDS.frequencyCapPerDay.fallback);
    expect(clampDial('dailyMessageBudget', Number.NaN)).toBe(DIAL_BOUNDS.dailyMessageBudget.fallback);
  });

  it('truncates a fractional value rather than rounding up', () => {
    // A cap of 3.9 is 3 messages. Rounding up would grant one nobody asked for.
    expect(clampDial('frequencyCapPerDay', 3.9)).toBe(3);
  });

  it('bounds the live-customer window, because that one buys a WhatsApp at 3am', () => {
    expect(clampDial('liveCustomerWindowMinutes', 10_000)).toBe(
      DIAL_BOUNDS.liveCustomerWindowMinutes.max,
    );
  });
});

describe('effectiveDials', () => {
  it('clamps every dial in one pass', () => {
    const dials = effectiveDials({
      frequencyCapPerDay: 1000,
      minGapMinutes: 0,
      dailyMessageBudget: 10_000,
      liveAttemptLockMinutes: 3,
      liveCustomerWindowMinutes: 15,
    });

    expect(dials.frequencyCapPerDay).toBe(DIAL_BOUNDS.frequencyCapPerDay.max);
    expect(dials.dailyMessageBudget).toBe(DIAL_BOUNDS.dailyMessageBudget.max);
    // Untouched, because they were already inside their range.
    expect(dials.minGapMinutes).toBe(0);
    expect(dials.liveAttemptLockMinutes).toBe(3);
    expect(dials.liveCustomerWindowMinutes).toBe(15);
  });
});
