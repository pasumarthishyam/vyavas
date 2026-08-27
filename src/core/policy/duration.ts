/**
 * Ladder offsets.
 *
 * Rungs are written as human durations (`4m`, `6h`, `3d`) because the policy
 * table is meant to be read and argued about by people who are not holding a
 * calculator. They are always offsets from **case detection**, never from the
 * previous rung — cumulative offsets are what you actually reason about when
 * asking "how long after the failure does this customer hear from us?", and
 * relative offsets make that question require arithmetic.
 */

const DURATION_RE = /^(\d+)(s|m|h|d)$/;

const UNIT_MS = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
} as const;

export type DurationUnit = keyof typeof UNIT_MS;

export class DurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DurationError';
  }
}

/** `"6h"` -> 21600000. Throws on anything it cannot read exactly. */
export function parseDuration(input: string): number {
  const m = DURATION_RE.exec(input.trim());
  if (!m) {
    throw new DurationError(
      `Cannot read duration '${input}'. Expected <integer><s|m|h|d>, e.g. '0m', '4m', '6h', '3d'.`,
    );
  }
  const [, rawValue, rawUnit] = m;
  const value = Number(rawValue);
  const unit = rawUnit as DurationUnit;
  if (!Number.isSafeInteger(value)) {
    throw new DurationError(`Duration '${input}' is out of range.`);
  }
  return value * UNIT_MS[unit];
}

export function isDuration(input: string): boolean {
  return DURATION_RE.test(input.trim());
}

/** Milliseconds -> the most readable exact unit. Round-trips with parseDuration. */
export function formatDuration(ms: number): string {
  if (!Number.isSafeInteger(ms) || ms < 0) {
    throw new DurationError(`Cannot format ${ms} as a duration.`);
  }
  for (const unit of ['d', 'h', 'm', 's'] as const) {
    const size = UNIT_MS[unit];
    if (ms >= size && ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${ms / UNIT_MS.s}s`;
}

export function durationToMinutes(ms: number): number {
  return ms / UNIT_MS.m;
}
