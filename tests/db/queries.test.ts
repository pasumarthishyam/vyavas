/**
 * Dashboard aggregations.
 *
 * Every number a merchant sees comes from here, so the things worth pinning are
 * the ones that would quietly mislead: exposure that double-counts money already
 * recovered, a breakdown ranked by frequency instead of value, a trend that
 * skips quiet days and misstates its own shape.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import {
  getCauseClassBreakdown,
  getDailyTrend,
  getMethodBankHeatmap,
  getRecentCases,
  getRevenueAtRisk,
  getTopReasons,
} from '../../src/db/queries/dashboard.js';
import { getCaseDetail } from '../../src/db/queries/case-detail.js';
import { createTestDb, schema, seedCustomer, seedMerchant, type TestDb } from './harness.js';

let t: TestDb;
let merchantId: string;
let customerId: string;

beforeEach(async () => {
  t = await createTestDb();
  merchantId = await seedMerchant(t.db);
  customerId = await seedCustomer(t.db, merchantId, {
    phone: '+919876543210',
    email: 'rahul@example.com',
  });
});

afterEach(async () => {
  await t.close();
});

interface CaseSpec {
  amount: number;
  state?: 'detected' | 'diagnosed' | 'recovered' | 'lost';
  causeClass?: 'instrument_dead' | 'funds_limits' | 'transient_infra' | 'risk';
  reason?: string;
  method?: 'card' | 'upi' | 'netbanking';
  bank?: string;
  daysAgo?: number;
  recovered?: number;
}

async function addCase(spec: CaseSpec, i = 0): Promise<string> {
  const [row] = await t.db
    .insert(schema.recoveryCases)
    .values({
      merchantId,
      customerId,
      type: 'payment_failure',
      state: spec.state ?? 'diagnosed',
      amountAtRiskPaise: spec.amount,
      rzpOrderId: `order_${i}_${Math.random().toString(36).slice(2, 8)}`,
      causeClass: spec.causeClass ?? 'instrument_dead',
      errorReason: spec.reason ?? 'card_expired',
      method: spec.method ?? 'card',
      bank: spec.bank ?? 'HDFC',
      attended: true,
      policyId: 'instrument_dead.card_expired',
      policyVersion: 1,
      recoveredAmountPaise: spec.recovered ?? null,
    })
    .returning({ id: schema.recoveryCases.id });

  if (spec.daysAgo) {
    await t.db.execute(
      sql`update recovery_cases set created_at = now() - make_interval(days => ${spec.daysAgo}) where id = ${row!.id}`,
    );
  }
  return row!.id;
}

describe('getRevenueAtRisk', () => {
  it('counts only live cases as at risk', async () => {
    await addCase({ amount: 100_000, state: 'diagnosed' }, 1);
    await addCase({ amount: 200_000, state: 'recovered', recovered: 200_000 }, 2);
    await addCase({ amount: 50_000, state: 'lost' }, 3);

    const r = await getRevenueAtRisk(t.db, merchantId);

    // Money already recovered is not at risk, and money written off is gone —
    // rolling either into the headline is how a recovery dashboard ends up
    // quoting a number nobody can reconcile.
    expect(r.atRiskPaise).toBe(100_000);
    expect(r.recoveredPaise).toBe(200_000);
    expect(r.lostPaise).toBe(50_000);
    expect(r.atRiskCases).toBe(1);
  });

  it('falls back to the full amount when nothing partial was recorded', async () => {
    await addCase({ amount: 90_000, state: 'recovered' }, 1);
    expect((await getRevenueAtRisk(t.db, merchantId)).recoveredPaise).toBe(90_000);
  });

  it('counts distinct customers, not cases', async () => {
    await addCase({ amount: 1000 }, 1);
    await addCase({ amount: 1000 }, 2);
    expect((await getRevenueAtRisk(t.db, merchantId)).customersAffected).toBe(1);
  });

  it('excludes cases outside the window', async () => {
    await addCase({ amount: 100_000, daysAgo: 60 }, 1);
    expect((await getRevenueAtRisk(t.db, merchantId, 30)).atRiskPaise).toBe(0);
  });

  it('computes a delta against the preceding window', async () => {
    await addCase({ amount: 100_000, daysAgo: 5 }, 1); // current
    await addCase({ amount: 50_000, daysAgo: 40 }, 2); // prior
    const r = await getRevenueAtRisk(t.db, merchantId, 30);
    expect(r.deltaPct).toBeCloseTo(100, 0); // doubled
  });

  it('reports no delta rather than a fake one when there is no prior period', async () => {
    await addCase({ amount: 100_000 }, 1);
    expect((await getRevenueAtRisk(t.db, merchantId)).deltaPct).toBeNull();
  });

  it('returns zeroes for a merchant with nothing', async () => {
    const r = await getRevenueAtRisk(t.db, await seedMerchant(t.db));
    expect(r.atRiskPaise).toBe(0);
    expect(r.atRiskCases).toBe(0);
  });
});

describe('getCauseClassBreakdown', () => {
  it('ranks by money, not by frequency', async () => {
    // Five small typos against one large shortfall. Sorted by count, the typos
    // would lead and the merchant would fix the wrong thing first.
    for (let i = 0; i < 5; i++) {
      await addCase({ amount: 10_000, causeClass: 'instrument_dead' }, i);
    }
    await addCase({ amount: 500_000, causeClass: 'funds_limits' }, 99);

    const rows = await getCauseClassBreakdown(t.db, merchantId);
    expect(rows[0]!.causeClass).toBe('funds_limits');
    expect(rows[0]!.amountPaise).toBe(500_000);
    expect(rows[1]!.cases).toBe(5);
  });

  it('counts recoveries per class', async () => {
    await addCase({ amount: 1000, causeClass: 'risk', state: 'recovered' }, 1);
    await addCase({ amount: 1000, causeClass: 'risk' }, 2);
    const [row] = await getCauseClassBreakdown(t.db, merchantId);
    expect(row!.recoveredCases).toBe(1);
    expect(row!.cases).toBe(2);
  });
});

describe('getDailyTrend', () => {
  it('emits a dense series with zero-filled quiet days', async () => {
    await addCase({ amount: 100_000, daysAgo: 3 }, 1);
    const trend = await getDailyTrend(t.db, merchantId, 7);

    // A sparse series would compress a quiet week into a straight segment and
    // misstate the shape of the chart.
    expect(trend).toHaveLength(7);
    expect(trend.filter((p) => p.atRiskPaise === 0).length).toBe(6);
    expect(trend.some((p) => p.atRiskPaise === 100_000)).toBe(true);
  });

  it('returns chronological dates', async () => {
    const trend = await getDailyTrend(t.db, merchantId, 5);
    const dates = trend.map((p) => p.date);
    expect([...dates].sort()).toEqual(dates);
  });
});

describe('getMethodBankHeatmap', () => {
  it('groups by method and bank', async () => {
    await addCase({ amount: 1000, method: 'upi', bank: 'HDFC' }, 1);
    await addCase({ amount: 2000, method: 'upi', bank: 'HDFC' }, 2);
    await addCase({ amount: 3000, method: 'card', bank: 'ICIC' }, 3);

    const cells = await getMethodBankHeatmap(t.db, merchantId);
    const upi = cells.find((c) => c.method === 'upi' && c.bank === 'HDFC');
    expect(upi!.cases).toBe(2);
    expect(upi!.amountPaise).toBe(3000);
    expect(cells).toHaveLength(2);
  });
});

describe('getTopReasons', () => {
  it('ranks reasons by value', async () => {
    await addCase({ amount: 5000, reason: 'incorrect_otp' }, 1);
    await addCase({ amount: 5000, reason: 'incorrect_otp' }, 2);
    await addCase({ amount: 400_000, reason: 'insufficient_funds' }, 3);

    const rows = await getTopReasons(t.db, merchantId);
    expect(rows[0]!.errorReason).toBe('insufficient_funds');
  });
});

describe('getRecentCases', () => {
  it('masks the customer contact at the query layer', async () => {
    await addCase({ amount: 1000 }, 1);
    const [row] = await getRecentCases(t.db, merchantId);

    // Masked here rather than in the template: a support screenshot should
    // never carry a full phone number, and relying on every view to remember
    // that is how one eventually does not.
    expect(row!.customerContact).toBe('+91•••••3210');
    expect(row!.customerContact).not.toContain('9876543');
  });

  it('filters by state', async () => {
    await addCase({ amount: 1000, state: 'recovered' }, 1);
    await addCase({ amount: 1000, state: 'diagnosed' }, 2);
    const open = await getRecentCases(t.db, merchantId, { state: ['diagnosed'] });
    expect(open).toHaveLength(1);
    expect(open[0]!.state).toBe('diagnosed');
  });

  it('returns newest first', async () => {
    await addCase({ amount: 1000, daysAgo: 10 }, 1);
    await addCase({ amount: 2000, daysAgo: 1 }, 2);
    const rows = await getRecentCases(t.db, merchantId);
    expect(rows[0]!.amountPaise).toBe(2000);
  });
});

describe('getCaseDetail', () => {
  it('resolves the ladder from the policy STAMPED on the case', async () => {
    const id = await addCase({ amount: 184_300 }, 1);
    const detail = await getCaseDetail(t.db, id);

    // Looked up by the stamped id rather than re-resolved, so a case that
    // started under one ladder shows that ladder even after the table changes.
    expect(detail!.policyId).toBe('instrument_dead.card_expired');
    expect(detail!.policy).not.toBeNull();
    expect(detail!.policy!.ladder.length).toBeGreaterThan(0);
    expect(detail!.policy!.maxMessages).toBeGreaterThan(0);
  });

  it('survives a policy id that no longer exists in the table', async () => {
    const id = await addCase({ amount: 1000 }, 1);
    await t.db.execute(
      sql`update recovery_cases set policy_id = 'deleted.policy' where id = ${id}`,
    );
    const detail = await getCaseDetail(t.db, id);
    expect(detail!.policy).toBeNull();
    expect(detail!.policyId).toBe('deleted.policy');
  });

  it('returns null for an unknown case', async () => {
    expect(await getCaseDetail(t.db, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('includes the event ledger in order', async () => {
    const id = await addCase({ amount: 1000 }, 1);
    await t.db.insert(schema.caseEvents).values([
      { caseId: id, merchantId, kind: 'detected', toState: 'detected' },
      { caseId: id, merchantId, kind: 'diagnosed', toState: 'diagnosed' },
    ]);
    const detail = await getCaseDetail(t.db, id);
    expect(detail!.events.map((e) => e.kind)).toEqual(['detected', 'diagnosed']);
  });
});
