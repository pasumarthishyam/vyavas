/**
 * Quiet hours.
 *
 * Nobody gets a payment message at 2am. That is obvious right up until a case
 * detected at 8pm has a six-hour rung, and nothing in the ladder knows what time
 * it will be when that rung fires.
 *
 * Pure: the current time and the merchant's zone are arguments. That is what
 * lets "9:04pm IST on a Sunday" be a table row rather than a staging
 * environment, and it is why this lives in core rather than in the workflow.
 *
 * Windows wrap midnight (21 → 8), which is the normal case and the one a naive
 * `hour >= start && hour < end` check gets exactly backwards.
 */

export interface QuietHours {
  /** Local hour the window opens, 0-23. */
  readonly start: number;
  /** Local hour it closes, 0-23. */
  readonly end: number;
}

export const DEFAULT_QUIET_HOURS: QuietHours = { start: 21, end: 8 };

/**
 * The local hour in an IANA zone.
 *
 * `Intl` rather than a date library: it is built in, pure, and already knows
 * every zone. Falls back to UTC on an unrecognised zone rather than throwing —
 * a bad timezone string in one merchant's settings must not take down the
 * workflow for everyone.
 */
export function localHour(instant: Date, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: 'numeric',
      hour12: false,
    }).formatToParts(instant);
    const hour = parts.find((p) => p.type === 'hour')?.value;
    const n = hour === undefined ? NaN : Number(hour);
    // Some locales render midnight as 24.
    return Number.isFinite(n) ? n % 24 : instant.getUTCHours();
  } catch {
    return instant.getUTCHours();
  }
}

export function isQuietHour(instant: Date, timeZone: string, window: QuietHours): boolean {
  const { start, end } = window;
  if (start === end) return false; // a zero-width window silences nothing
  const hour = localHour(instant, timeZone);
  // A window that wraps midnight (21 → 8) is the common case; the naive
  // `hour >= start && hour < end` gets it exactly backwards.
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}

/**
 * The next instant outside the quiet window.
 *
 * Returns `instant` unchanged when it is already fine, so a caller can apply it
 * unconditionally. Walks forward in whole hours because a message at 08:00 and
 * one at 08:37 are indistinguishable to a customer, and hour alignment makes
 * the deferred time predictable in the audit log.
 */
export function nextAllowedTime(instant: Date, timeZone: string, window: QuietHours): Date {
  if (!isQuietHour(instant, timeZone, window)) return instant;

  const HOUR = 3_600_000;
  let candidate = new Date(instant.getTime());

  // 25 steps covers any wrapping window plus a DST shift; a `while` here would
  // spin forever on a pathological zone.
  for (let i = 0; i < 25; i++) {
    candidate = new Date(candidate.getTime() + HOUR);
    if (!isQuietHour(candidate, timeZone, window)) {
      // Land on the hour boundary rather than carrying the original minutes.
      const minutes = Number(
        new Intl.DateTimeFormat('en-GB', { timeZone, minute: 'numeric' }).format(candidate),
      );
      const aligned = new Date(candidate.getTime() - (Number.isFinite(minutes) ? minutes : 0) * 60_000);
      return aligned.getTime() > instant.getTime() ? aligned : candidate;
    }
  }

  return candidate;
}

/** How long a rung would have to wait. Zero when it may fire now. */
export function quietHoursDelayMs(
  instant: Date,
  timeZone: string,
  window: QuietHours,
): number {
  return nextAllowedTime(instant, timeZone, window).getTime() - instant.getTime();
}
