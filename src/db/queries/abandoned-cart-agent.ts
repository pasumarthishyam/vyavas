/**
 * Read-side queries for the abandoned-cart dashboard.
 *
 * Separate from `db/queries/dashboard.ts` for the same reason
 * `queries/voice-agent.ts` is: this agent has its own page and its own idea of
 * what's worth showing.
 */

import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { abandonedCarts } from '../schema/abandoned-cart.js';
import { paiseFromColumn } from '../util.js';
import { priorRange, rangeSpanDays, type DateRange } from '../../lib/date-range.js';

const num = paiseFromColumn;

function inRange(range: DateRange) {
  return and(gte(abandonedCarts.createdAt, range.from), lt(abandonedCarts.createdAt, range.to));
}

// ─── the summary a human monitors ───────────────────────────────────────────

export interface AbandonedCartSummary {
  /** Reported, not yet resolved either way. */
  atRiskPaise: number;
  atRiskCount: number;
  recoveredPaise: number;
  recoveredCount: number;
  /** Link created but the 24h window passed unpaid. */
  expiredPaise: number;
  expiredCount: number;
  /** Never got as far as a link — Razorpay down, no provider, amount too small. */
  failedCount: number;
  totalCount: number;
  /** Distinct people this agent actually reached a contact record for. */
  customersReached: number;
  /** Percentage-point change in total cart value reported vs the preceding window of equal length. */
  deltaPct: number | null;
}

export async function getAbandonedCartSummary(
  db: Database,
  merchantId: string,
  range: DateRange,
): Promise<AbandonedCartSummary> {
  const scope = and(eq(abandonedCarts.merchantId, merchantId), inRange(range));

  const [totals] = await db
    .select({
      atRisk: sql`coalesce(sum(case when ${abandonedCarts.status} in ('detected','emailed') then ${abandonedCarts.amountPaise} else 0 end), 0)`,
      atRiskCount: sql`count(*) filter (where ${abandonedCarts.status} in ('detected','emailed'))`,
      recovered: sql`coalesce(sum(case when ${abandonedCarts.status} = 'recovered' then coalesce(${abandonedCarts.paymentLinkAmountPaise}, ${abandonedCarts.amountPaise}) else 0 end), 0)`,
      recoveredCount: sql`count(*) filter (where ${abandonedCarts.status} = 'recovered')`,
      expired: sql`coalesce(sum(case when ${abandonedCarts.status} = 'expired' then ${abandonedCarts.amountPaise} else 0 end), 0)`,
      expiredCount: sql`count(*) filter (where ${abandonedCarts.status} = 'expired')`,
      failedCount: sql`count(*) filter (where ${abandonedCarts.status} = 'failed')`,
      totalCount: sql`count(*)`,
      customers: sql`count(distinct ${abandonedCarts.customerId}) filter (where ${abandonedCarts.customerId} is not null)`,
    })
    .from(abandonedCarts)
    .where(scope);

  const [prior] = await db
    .select({ total: sql`coalesce(sum(${abandonedCarts.amountPaise}), 0)` })
    .from(abandonedCarts)
    .where(and(eq(abandonedCarts.merchantId, merchantId), inRange(priorRange(range))));

  const current = num(totals?.atRisk) + num(totals?.recovered) + num(totals?.expired);
  const previous = num(prior?.total);

  return {
    atRiskPaise: num(totals?.atRisk),
    atRiskCount: num(totals?.atRiskCount),
    recoveredPaise: num(totals?.recovered),
    recoveredCount: num(totals?.recoveredCount),
    expiredPaise: num(totals?.expired),
    expiredCount: num(totals?.expiredCount),
    failedCount: num(totals?.failedCount),
    totalCount: num(totals?.totalCount),
    customersReached: num(totals?.customers),
    deltaPct: previous > 0 ? ((current - previous) / previous) * 100 : null,
  };
}

// ─── trend ───────────────────────────────────────────────────────────────────

export interface AbandonedCartTrendPoint {
  date: string;
  amountPaise: number;
  count: number;
}

/** A dense daily series — days with nothing reported are emitted as zero, same reasoning as the main dashboard's trend. */
export async function getAbandonedCartDailyTrend(
  db: Database,
  merchantId: string,
  range: DateRange,
): Promise<AbandonedCartTrendPoint[]> {
  const spanDays = rangeSpanDays(range);
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
      coalesce(sum(c.amount_paise), 0)::bigint as amount,
      count(c.id)::int as cnt
    from span
    left join abandoned_carts c
      on date_trunc('day', c.created_at)::date = span.day
     and c.merchant_id = ${merchantId}
    group by span.day
    order by span.day
  `);

  const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? []);
  return (list as Record<string, unknown>[]).map((r) => ({
    date: String(r.date),
    amountPaise: num(r.amount),
    count: Number(r.cnt ?? 0),
  }));
}

export interface AbandonedCartRow {
  id: string;
  externalCartId: string;
  status: string;
  customerName: string | null;
  customerEmail: string;
  customerPhone: string | null;
  amountPaise: number;
  discountAmountPaise: number | null;
  paymentLinkUrl: string | null;
  paymentLinkAmountPaise: number | null;
  paymentLinkExpiresAt: Date | null;
  paymentConfirmedAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
}

export async function getRecentAbandonedCarts(
  db: Database,
  merchantId: string,
  limit = 50,
): Promise<AbandonedCartRow[]> {
  const rows = await db
    .select()
    .from(abandonedCarts)
    .where(eq(abandonedCarts.merchantId, merchantId))
    .orderBy(desc(abandonedCarts.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    externalCartId: r.externalCartId,
    status: r.status,
    customerName: r.customerName,
    customerEmail: r.customerEmail,
    customerPhone: r.customerPhone,
    amountPaise: num(r.amountPaise),
    discountAmountPaise: r.discountAmountPaise != null ? num(r.discountAmountPaise) : null,
    paymentLinkUrl: r.paymentLinkUrl,
    paymentLinkAmountPaise: r.paymentLinkAmountPaise != null ? num(r.paymentLinkAmountPaise) : null,
    paymentLinkExpiresAt: r.paymentLinkExpiresAt,
    paymentConfirmedAt: r.paymentConfirmedAt,
    failureReason: r.failureReason,
    createdAt: r.createdAt,
  }));
}
