/**
 * The dashboard's date-range parsing.
 *
 * One resolver so every card on the Overview page agrees on the same window —
 * the bug this exists to prevent is a "Written off" tile computed against a
 * different range than the hero figure above it, which reads as the dashboard
 * disagreeing with itself.
 *
 * Two shapes come in from the URL: a preset day count (`?days=45`) or an
 * explicit calendar range (`?from=2026-07-01&to=2026-07-15`). An explicit
 * range wins when both are present, since it is the more specific request.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DateRange {
  /** Inclusive. */
  from: Date;
  /** Exclusive. */
  to: Date;
}

export const PRESET_DAYS = [15, 30, 45, 90] as const;
export type PresetDays = (typeof PRESET_DAYS)[number];
export const DEFAULT_PRESET_DAYS: PresetDays = 30;

export interface ResolvedRange {
  range: DateRange;
  /** The active preset, or null when an explicit custom range is active. */
  preset: PresetDays | null;
  /** yyyy-mm-dd, set only when a custom range is active — seeds the date inputs. */
  customFrom: string | null;
  customTo: string | null;
  label: string;
}

function isPresetDays(n: number): n is PresetDays {
  return (PRESET_DAYS as readonly number[]).includes(n);
}

function parseISODate(s: string | undefined): Date | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** yyyy-mm-dd for `<input type="date">`, in the server's local calendar. */
export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** The trailing N-day window ending now. */
export function lastNDays(days: number): DateRange {
  const to = new Date();
  return { from: new Date(to.getTime() - days * DAY_MS), to };
}

function formatCustomLabel(from: Date, to: Date): string {
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
  return `${from.toLocaleDateString('en-IN', opts)} – ${to.toLocaleDateString('en-IN', opts)}, ${to.getFullYear()}`;
}

export function resolveDateRange(params: {
  days?: string;
  from?: string;
  to?: string;
}): ResolvedRange {
  const from = parseISODate(params.from);
  const toDay = parseISODate(params.to);

  if (from && toDay && toDay.getTime() >= from.getTime()) {
    // `to` is a calendar day picked in a date input; make it an exclusive
    // bound at the start of the day after, so that day's cases are included.
    const to = new Date(toDay.getTime() + DAY_MS);
    return {
      range: { from, to },
      preset: null,
      customFrom: toISODate(from),
      customTo: toISODate(toDay),
      label: formatCustomLabel(from, toDay),
    };
  }

  const requested = Number(params.days);
  const days = isPresetDays(requested) ? requested : DEFAULT_PRESET_DAYS;
  return {
    range: lastNDays(days),
    preset: days,
    customFrom: null,
    customTo: null,
    label: `Last ${days} days`,
  };
}

/** The preceding window of equal length, for trend deltas. */
export function priorRange(range: DateRange): DateRange {
  const span = range.to.getTime() - range.from.getTime();
  return { from: new Date(range.from.getTime() - span), to: range.from };
}

/** Whole calendar days spanned, for building a dense daily series. */
export function rangeSpanDays(range: DateRange): number {
  return Math.max(1, Math.round((range.to.getTime() - range.from.getTime()) / DAY_MS));
}
