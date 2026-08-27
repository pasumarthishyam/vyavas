import { describe, expect, it } from 'vitest';
import {
  DurationError,
  durationToMinutes,
  formatDuration,
  isDuration,
  parseDuration,
} from '@core/policy/duration.js';
import { constrainedDimensions, MATCH_WEIGHTS, MAX_NON_REASON_WEIGHT } from '@core/policy/specificity.js';

describe('parseDuration', () => {
  it('reads every unit', () => {
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('4m')).toBe(240_000);
    expect(parseDuration('6h')).toBe(21_600_000);
    expect(parseDuration('3d')).toBe(259_200_000);
  });

  it('accepts zero', () => {
    expect(parseDuration('0m')).toBe(0);
  });

  it('tolerates surrounding whitespace from YAML', () => {
    expect(parseDuration('  6h  ')).toBe(21_600_000);
  });

  it('refuses anything it cannot read exactly', () => {
    // A ladder offset that silently defaults would fire at the wrong time for
    // real customers, so ambiguity is a build failure rather than a guess.
    for (const bad of ['soon', '6', 'h', '6hh', '6 h', '-4m', '1.5h', '', '6H', '4M']) {
      expect(() => parseDuration(bad), bad).toThrow(DurationError);
    }
  });

  it('reports what it expected', () => {
    expect(() => parseDuration('soon')).toThrow(/Expected <integer>/);
  });
});

describe('isDuration', () => {
  it('agrees with parseDuration', () => {
    for (const good of ['0m', '4m', '26h', '3d', '30s']) expect(isDuration(good)).toBe(true);
    for (const bad of ['soon', '6', '1.5h', '']) expect(isDuration(bad)).toBe(false);
  });
});

describe('formatDuration', () => {
  it('picks the most readable exact unit', () => {
    expect(formatDuration(259_200_000)).toBe('3d');
    expect(formatDuration(21_600_000)).toBe('6h');
    expect(formatDuration(240_000)).toBe('4m');
    expect(formatDuration(30_000)).toBe('30s');
  });

  it('does not lie about a value that has no whole unit', () => {
    // 26 hours is not a whole number of days, so it stays in hours.
    expect(formatDuration(93_600_000)).toBe('26h');
    expect(formatDuration(90_000)).toBe('90s');
  });

  it('round-trips with parseDuration', () => {
    for (const d of ['0m', '30s', '4m', '26h', '3d']) {
      expect(parseDuration(formatDuration(parseDuration(d)))).toBe(parseDuration(d));
    }
  });

  it('refuses negative or fractional milliseconds', () => {
    expect(() => formatDuration(-1)).toThrow(DurationError);
    expect(() => formatDuration(1.5)).toThrow(DurationError);
  });

  it('formats zero', () => {
    expect(formatDuration(0)).toBe('0s');
  });
});

describe('durationToMinutes', () => {
  it('converts for the class-floor comparison', () => {
    expect(durationToMinutes(parseDuration('3h'))).toBe(180);
    expect(durationToMinutes(parseDuration('0m'))).toBe(0);
    expect(durationToMinutes(parseDuration('25m'))).toBe(25);
  });
});

describe('specificity weights', () => {
  it('keeps errorReason above everything else combined', () => {
    // The ordering has to stay legible: a row naming the exact failure reason
    // always beats a row generalising about the class, no matter how many
    // secondary dimensions the generalising row piles on.
    expect(MATCH_WEIGHTS.errorReason).toBeGreaterThan(MAX_NON_REASON_WEIGHT);
  });

  it('reports which dimensions a row constrains', () => {
    expect(constrainedDimensions({ errorReason: 'card_expired', attended: true })).toEqual([
      'errorReason',
      'attended',
    ]);
    expect(constrainedDimensions({})).toEqual([]);
  });
});
