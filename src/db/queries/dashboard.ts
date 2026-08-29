/**
 * Dashboard aggregations.
 *
 * Every figure a merchant sees is computed here, in one place, so the number on
 * the overview and the number in a drill-down can never disagree.
 *
 * Two rules throughout:
 *
 *  - Money stays integer paise until the very edge. `sum()` over a bigint comes
 *    back from Postgres as a numeric string; every one of those is put through
 *    `num()` rather than trusted to coerce.
 *  - "At risk" counts LIVE cases only. A recovered case is not at risk, and a
 *    lost one is not at risk either — it is gone. Conflating them is how
 *    recovery dashboards end up quoting a number nobody can reconcile.
 */

import { and, count, desc, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { paiseFromColumn } from '../util.js';
import { recoveryCases } from '../schema/cases.js';
import { merchantAlerts } from '../schema/ops.js';
import { customers } from '../schema/customers.js';
import type { CaseState } from '../../core/case/types.js';
import { priorRange, rangeSpanDays, type DateRange } from '../../lib/date-range.js';

const num = paiseFromColumn;

/** `createdAt` within `[range.from, range.to)`. */
function inRange(range: DateRange) {
  return and(gte(recoveryCases.createdAt, range.from), lt(recoveryCases.createdAt, range.to));
}

// ─── the hero figure ─────────────────────────────────────────────────────────

export interface RevenueAtRisk {
  /** Live, unresolved exposure right now. */
  atRiskPaise: number;
  atRiskCases: number;
  /** Recovered inside the window. */
  recoveredPaise: number;
  recoveredCases: number;
  /** Deadline passed or ladder exhausted, inside the window. */
  lostPaise: number;
  lostCases: number;
  customersAffected: number;
  /** Percentage-point change in exposure vs the preceding window of equal length. */
  deltaPct: number | null;
}

export async function getRevenueAtRisk(
  db: Database,
  merchantId: string,
  range: DateRange,
): Promise<RevenueAtRisk> {
  const scope = and(eq(recoveryCases.merchantId, merchantId), inRange(range));

  const [totals] = await db
    .select({
      atRisk: sql`coalesce(sum(case when ${recoveryCases.state} in ('detected','diagnosed','executing','paused') then ${recoveryCases.amountAtRiskPaise} else 0 end), 0)`,
      atRiskCases: sql`count(*) filter (where ${recoveryCases.state} in ('detected','diagnosed','executing','paused'))`,
      recovered: sql`coalesce(sum(case when ${recoveryCases.state} = 'recovered' then coalesce(${recoveryCases.recoveredAmountPaise}, ${recoveryCases.amountAtRiskPaise}) else 0 end), 0)`,
      recoveredCases: sql`count(*) filter (where ${recoveryCases.state} = 'recovered')`,
      lost: sql`coalesce(sum(case when ${recoveryCases.state} = 'lost' then ${recoveryCases.amountAtRiskPaise} else 0 end), 0)`,
      lostCases: sql`count(*) filter (where ${recoveryCases.state} = 'lost')`,
      // Scoped to LIVE cases, matching the hero figure. Counting every customer
      // in the window would put "189 open cases · 320 customers" in one sentence,
      // which reads as a contradiction because the two halves count different sets.
      customers: sql`count(distinct ${recoveryCases.customerId}) filter (where ${recoveryCases.state} in ('detected','diagnosed','executing','paused'))`,
    })
    .from(recoveryCases)
    .where(scope);

  // The preceding window of equal length, for the delta.
  const [prior] = await db
    .select({ total: sql`coalesce(sum(${recoveryCases.amountAtRiskPaise}), 0)` })
    .from(recoveryCases)
    .where(and(eq(recoveryCases.merchantId, merchantId), inRange(priorRange(range))));

  const current = num(totals?.atRisk) + num(totals?.recovered) + num(totals?.lost);
  const previous = num(prior?.total);

  return {
    atRiskPaise: num(totals?.atRisk),
    atRiskCases: num(totals?.atRiskCases),
    recoveredPaise: num(totals?.recovered),
    recoveredCases: num(totals?.recoveredCases),
    lostPaise: num(totals?.lost),
    lostCases: num(totals?.lostCases),
    customersAffected: num(totals?.customers),
    deltaPct: previous > 0 ? ((current - previous) / previous) * 100 : null,
  };
}

// ─── cause-class breakdown ───────────────────────────────────────────────────

export interface CauseClassRow {
  causeClass: string;
  cases: number;
  amountPaise: number;
  recoveredCases: number;
}

/**
 * Ranked by money, not by count.
 *
 * A hundred failed ₹99 orders matter less than three failed ₹40,000 ones, and a
 * dashboard sorted by frequency quietly tells the merchant to fix the wrong
 * thing first.
 */
export async function getCauseClassBreakdown(
  db: Database,
  merchantId: string,
  range: DateRange,
): Promise<CauseClassRow[]> {
  const rows = await db
    .select({
      causeClass: recoveryCases.causeClass,
      cases: count(),
      amount: sql`coalesce(sum(${recoveryCases.amountAtRiskPaise}), 0)`,
      recovered: sql`count(*) filter (where ${recoveryCases.state} = 'recovered')`,
    })
    .from(recoveryCases)
    .where(
      and(eq(recoveryCases.merchantId, merchantId), inRange(range), isNotNull(recoveryCases.causeClass)),
    )
    .groupBy(recoveryCases.causeClass)
    .orderBy(desc(sql`coalesce(sum(${recoveryCases.amountAtRiskPaise}), 0)`));

  return rows.map((r) => ({
    causeClass: r.causeClass ?? 'unknown',
    cases: Number(r.cases),
    amountPaise: num(r.amount),
    recoveredCases: num(r.recovered),
  }));
}

// ─── trend ───────────────────────────────────────────────────────────────────

export interface TrendPoint {
  date: string;
  atRiskPaise: number;
  recoveredPaise: number;
  cases: number;
}

/**
 * A dense daily series — days with no failures are emitted as zero rather than
 * skipped, so the line does not silently compress a quiet week into a straight
 * segment and misstate the shape.
 */
export async function getDailyTrend(
  db: Database,
  merchantId: string,
  range: DateRange,
): Promise<TrendPoint[]> {
  // Anchored on `to` and stepped back by the exact day count, rather than
  // flooring `from` independently: `from` is a raw instant (e.g. "7 days ago
  // right now"), and flooring both ends separately can straddle one more
  // calendar date than the window actually spans, padding a 7-day window
  // with an 8th day.
  const spanDays = rangeSpanDays(range);
  // `postgres` (the real driver, unlike the PGlite one the test suite runs
  // against) rejects a raw Date interpolated into a hand-written `sql`
  // template — it needs an ISO string here, unlike the typed-column
  // comparisons elsewhere in this file that take a Date natively.
  const to = range.to.toISOString();
  const rows = await db.execute(sql`
    with span as (
      select generate_series(
        date_trunc('day', ${to}::timestamptz - interval '1 second')
          - make_interval(days => ${spanDays - 1}::int),
        date_trunc('day', ${to}::timestamptz - interval '1 second'),
        interval '1 day'
      )::date as day
    )
    select
      span.day::text as date,
      coalesce(sum(c.amount_at_risk_paise), 0)::bigint as at_risk,
      coalesce(sum(case when c.state = 'recovered'
        then coalesce(c.recovered_amount_paise, c.amount_at_risk_paise) else 0 end), 0)::bigint as recovered,
      count(c.id)::int as cases
    from span
    left join recovery_cases c
      on date_trunc('day', c.created_at)::date = span.day
     and c.merchant_id = ${merchantId}
    group by span.day
    order by span.day
  `);

  const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? []);
  return (list as Record<string, unknown>[]).map((r) => ({
    date: String(r.date),
    atRiskPaise: num(r.at_risk),
    recoveredPaise: num(r.recovered),
    cases: Number(r.cases ?? 0),
  }));
}

// ─── method x bank ───────────────────────────────────────────────────────────

export interface HeatCell {
  method: string;
  bank: string;
  cases: number;
  amountPaise: number;
}

export async function getMethodBankHeatmap(
  db: Database,
  merchantId: string,
  range: DateRange,
): Promise<HeatCell[]> {
  const rows = await db
    .select({
      method: recoveryCases.method,
      bank: recoveryCases.bank,
      cases: count(),
      amount: sql`coalesce(sum(${recoveryCases.amountAtRiskPaise}), 0)`,
    })
    .from(recoveryCases)
    .where(and(eq(recoveryCases.merchantId, merchantId), inRange(range)))
    .groupBy(recoveryCases.method, recoveryCases.bank)
    .orderBy(desc(count()));

  return rows.map((r) => ({
    method: r.method ?? 'unknown',
    bank: r.bank ?? 'Unknown',
    cases: Number(r.cases),
    amountPaise: num(r.amount),
  }));
}

// ─── cases ───────────────────────────────────────────────────────────────────

export interface CaseListRow {
  id: string;
  state: string;
  type: string;
  causeClass: string | null;
  errorReason: string | null;
  method: string;
  bank: string | null;
  amountPaise: number;
  policyId: string | null;
  attended: boolean;
  cohort: string;
  createdAt: Date;
  deadlineAt: Date | null;
  customerContact: string | null;
}

export async function getRecentCases(
  db: Database,
  merchantId: string,
  opts: { limit?: number; state?: CaseState[]; causeClass?: string } = {},
): Promise<CaseListRow[]> {
  const filters = [eq(recoveryCases.merchantId, merchantId)];
  if (opts.state?.length) filters.push(inArray(recoveryCases.state, opts.state));
  if (opts.causeClass) filters.push(sql`${recoveryCases.causeClass} = ${opts.causeClass}`);

  const rows = await db
    .select({
      id: recoveryCases.id,
      state: recoveryCases.state,
      type: recoveryCases.type,
      causeClass: recoveryCases.causeClass,
      errorReason: recoveryCases.errorReason,
      method: recoveryCases.method,
      bank: recoveryCases.bank,
      amount: recoveryCases.amountAtRiskPaise,
      policyId: recoveryCases.policyId,
      attended: recoveryCases.attended,
      cohort: recoveryCases.cohort,
      createdAt: recoveryCases.createdAt,
      deadlineAt: recoveryCases.deadlineAt,
      phone: customers.phone,
      email: customers.email,
    })
    .from(recoveryCases)
    .leftJoin(customers, eq(customers.id, recoveryCases.customerId))
    .where(and(...filters))
    .orderBy(desc(recoveryCases.createdAt))
    .limit(opts.limit ?? 50);

  return rows.map((r) => ({
    id: r.id,
    state: r.state,
    type: r.type,
    causeClass: r.causeClass,
    errorReason: r.errorReason,
    method: r.method,
    bank: r.bank,
    amountPaise: num(r.amount),
    policyId: r.policyId,
    attended: r.attended,
    cohort: r.cohort,
    createdAt: r.createdAt,
    deadlineAt: r.deadlineAt,
    // Masked at the query layer, not the view: a support screenshot should
    // never carry a full phone number, and relying on every template to
    // remember that is how one eventually does.
    customerContact: maskContact(r.phone, r.email),
  }));
}

function maskContact(phone: string | null, email: string | null): string | null {
  if (phone) return `${phone.slice(0, 3)}•••••${phone.slice(-4)}`;
  if (email) {
    const [user, domain] = email.split('@');
    if (!user || !domain) return null;
    return `${user.slice(0, 2)}•••@${domain}`;
  }
  return null;
}

// ─── merchant alerts ─────────────────────────────────────────────────────────

export interface AlertRow {
  id: string;
  severity: string;
  signal: string;
  title: string;
  detail: string | null;
  affectedCases: number;
  amountPaise: number;
  onsetAt: Date;
  lastSeenAt: Date;
}

export async function getOpenAlerts(db: Database, merchantId: string): Promise<AlertRow[]> {
  const rows = await db
    .select()
    .from(merchantAlerts)
    .where(and(eq(merchantAlerts.merchantId, merchantId), sql`resolved_at is null`))
    .orderBy(desc(merchantAlerts.onsetAt));

  return rows.map((r) => ({
    id: r.id,
    severity: r.severity,
    signal: r.signal,
    title: r.title,
    detail: r.detail,
    affectedCases: r.affectedCases,
    amountPaise: num(r.amountAtRiskPaise),
    onsetAt: r.onsetAt,
    lastSeenAt: r.lastSeenAt,
  }));
}

// ─── top reasons ─────────────────────────────────────────────────────────────

export interface ReasonRow {
  errorReason: string;
  causeClass: string | null;
  cases: number;
  amountPaise: number;
}

export async function getTopReasons(
  db: Database,
  merchantId: string,
  range: DateRange,
  limit = 8,
): Promise<ReasonRow[]> {
  const rows = await db
    .select({
      errorReason: recoveryCases.errorReason,
      causeClass: recoveryCases.causeClass,
      cases: count(),
      amount: sql`coalesce(sum(${recoveryCases.amountAtRiskPaise}), 0)`,
    })
    .from(recoveryCases)
    .where(
      and(eq(recoveryCases.merchantId, merchantId), inRange(range), isNotNull(recoveryCases.errorReason)),
    )
    .groupBy(recoveryCases.errorReason, recoveryCases.causeClass)
    .orderBy(desc(sql`coalesce(sum(${recoveryCases.amountAtRiskPaise}), 0)`))
    .limit(limit);

  return rows.map((r) => ({
    errorReason: r.errorReason ?? 'unknown',
    causeClass: r.causeClass,
    cases: Number(r.cases),
    amountPaise: num(r.amount),
  }));
}

// ─── one merchant, for the shell ─────────────────────────────────────────────

/**
 * The merchant the dashboard shows.
 *
 * Ordered by creation, so it stays the same across page loads. An unordered
 * `limit(1)` is a coin flip once there is more than one row — the figures would
 * silently change between refreshes, which is worse than showing the wrong
 * merchant consistently.
 *
 * Single-tenant by design for now. A real merchant switcher is Stage 8 work,
 * alongside Partner OAuth.
 */
export async function getFirstMerchant(db: Database) {
  const { merchants } = await import('../schema/tenancy.js');
  const rows = await db
    .select()
    .from(merchants)
    .where(sql`deleted_at is null`)
    .orderBy(merchants.createdAt)
    .limit(1);
  return rows.at(0) ?? null;
}
