/**
 * The database guarantees.
 *
 * Everything here is enforced by Postgres itself, not by application care. The
 * distinction matters: application care is one forgotten `if` away from failing,
 * and every one of these failures reaches a real customer.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

import { createTestDb, schema, seedCustomer, seedMerchant, type TestDb } from './harness.js';

let t: TestDb;
let merchantId: string;

beforeEach(async () => {
  t = await createTestDb();
  merchantId = await seedMerchant(t.db);
});

afterEach(async () => {
  await t.close();
});

const baseCase = (over: Partial<typeof schema.recoveryCases.$inferInsert> = {}) => ({
  merchantId,
  type: 'payment_failure' as const,
  amountAtRiskPaise: 184300,
  attended: true,
  rzpOrderId: 'order_TEST123',
  ...over,
});

describe('the duplicate-case guard', () => {
  it('allows exactly one live case per order', async () => {
    await t.db.insert(schema.recoveryCases).values(baseCase());

    // Two failed attempts on one order arrive milliseconds apart. Without this
    // index the customer gets two ladders and twice the messages.
    const second = await t.db
      .insert(schema.recoveryCases)
      .values(baseCase())
      .onConflictDoNothing()
      .returning({ id: schema.recoveryCases.id });

    expect(second).toHaveLength(0);

    const all = await t.db.select().from(schema.recoveryCases);
    expect(all).toHaveLength(1);
  });

  it('allows a new case once the previous one is terminal', async () => {
    const [first] = await t.db
      .insert(schema.recoveryCases)
      .values(baseCase())
      .returning({ id: schema.recoveryCases.id });

    await t.db
      .update(schema.recoveryCases)
      .set({ state: 'recovered' })
      .where(eq(schema.recoveryCases.id, first!.id));

    // The customer ordered again later. That is a genuinely new case.
    const second = await t.db
      .insert(schema.recoveryCases)
      .values(baseCase())
      .onConflictDoNothing()
      .returning({ id: schema.recoveryCases.id });

    expect(second).toHaveLength(1);
  });

  it('does not conflate orders across merchants', async () => {
    const other = await seedMerchant(t.db);
    await t.db.insert(schema.recoveryCases).values(baseCase());
    const second = await t.db
      .insert(schema.recoveryCases)
      .values({ ...baseCase(), merchantId: other })
      .onConflictDoNothing()
      .returning({ id: schema.recoveryCases.id });
    expect(second).toHaveLength(1);
  });

  it('does not collapse cases that have no order id', async () => {
    // Subscription and invoice cases may have no order. NULLs must not collide.
    await t.db.insert(schema.recoveryCases).values(baseCase({ rzpOrderId: null }));
    const second = await t.db
      .insert(schema.recoveryCases)
      .values(baseCase({ rzpOrderId: null }))
      .onConflictDoNothing()
      .returning({ id: schema.recoveryCases.id });
    expect(second).toHaveLength(1);
  });

  it('guards invoices the same way', async () => {
    const v = baseCase({ rzpOrderId: null, rzpInvoiceId: 'inv_1', type: 'receivable_overdue' });
    await t.db.insert(schema.recoveryCases).values(v);
    const second = await t.db
      .insert(schema.recoveryCases)
      .values(v)
      .onConflictDoNothing()
      .returning({ id: schema.recoveryCases.id });
    expect(second).toHaveLength(0);
  });
});

describe('idempotency keys', () => {
  it('collapses a replayed action to one row', async () => {
    const [c] = await t.db
      .insert(schema.recoveryCases)
      .values(baseCase())
      .returning({ id: schema.recoveryCases.id });

    const action = {
      caseId: c!.id,
      merchantId,
      rung: 1,
      kind: 'nudge' as const,
      idempotencyKey: `${c!.id}:1:nudge`,
    };

    await t.db.insert(schema.caseActions).values(action);
    // A workflow replay after a deploy must not fire the same rung twice.
    const replay = await t.db
      .insert(schema.caseActions)
      .values(action)
      .onConflictDoNothing()
      .returning({ id: schema.caseActions.id });

    expect(replay).toHaveLength(0);
  });

  it('keeps different rungs separate', async () => {
    const [c] = await t.db
      .insert(schema.recoveryCases)
      .values(baseCase())
      .returning({ id: schema.recoveryCases.id });

    await t.db.insert(schema.caseActions).values({
      caseId: c!.id,
      merchantId,
      rung: 1,
      kind: 'nudge',
      idempotencyKey: `${c!.id}:1:nudge`,
    });
    const rung2 = await t.db
      .insert(schema.caseActions)
      .values({
        caseId: c!.id,
        merchantId,
        rung: 2,
        kind: 'nudge',
        idempotencyKey: `${c!.id}:2:nudge`,
      })
      .onConflictDoNothing()
      .returning({ id: schema.caseActions.id });

    expect(rung2).toHaveLength(1);
  });
});

describe('customer identity', () => {
  it('will not store the same phone twice for one merchant', async () => {
    await seedCustomer(t.db, merchantId, { phone: '+919876543210', email: null });
    // A duplicate person defeats the cross-case frequency cap, which is keyed
    // on customer id — the same human stored twice gets messaged twice.
    await expect(
      seedCustomer(t.db, merchantId, { phone: '+919876543210', email: null }),
    ).rejects.toThrow();
  });

  it('allows the same phone across different merchants', async () => {
    const other = await seedMerchant(t.db);
    await seedCustomer(t.db, merchantId, { phone: '+919876543210', email: null });
    await expect(
      seedCustomer(t.db, other, { phone: '+919876543210', email: null }),
    ).resolves.toBeTruthy();
  });

  it('allows many customers with no phone at all', async () => {
    await seedCustomer(t.db, merchantId, { phone: null });
    await expect(seedCustomer(t.db, merchantId, { phone: null })).resolves.toBeTruthy();
  });
});

describe('money is stored exactly', () => {
  it('round-trips large paise amounts without loss', async () => {
    // Rs 5,00,00,000.00 — well past where a float starts lying.
    const amount = 5_000_000_000;
    const [c] = await t.db
      .insert(schema.recoveryCases)
      .values(baseCase({ amountAtRiskPaise: amount }))
      .returning({ id: schema.recoveryCases.id });

    const [read] = await t.db
      .select({ amt: schema.recoveryCases.amountAtRiskPaise })
      .from(schema.recoveryCases)
      .where(eq(schema.recoveryCases.id, c!.id));

    expect(read!.amt).toBe(amount);
    expect(Number.isInteger(read!.amt)).toBe(true);
  });
});

describe('operational guarantees', () => {
  it('keeps exactly one open alert per condition per merchant', async () => {
    const alert = {
      merchantId,
      severity: 'critical' as const,
      signal: 'bank_not_enabled:ICIC:netbanking',
      title: 'ICICI netbanking failing',
      onsetAt: new Date(),
    };
    await t.db.insert(schema.merchantAlerts).values(alert);
    // A fault that is still broken accumulates into the existing row rather
    // than paging the merchant every minute.
    const dup = await t.db
      .insert(schema.merchantAlerts)
      .values(alert)
      .onConflictDoNothing()
      .returning({ id: schema.merchantAlerts.id });
    expect(dup).toHaveLength(0);
  });

  it('allows a new alert after the previous one resolved', async () => {
    const alert = {
      merchantId,
      severity: 'critical' as const,
      signal: 'bank_not_enabled:ICIC:netbanking',
      title: 'ICICI netbanking failing',
      onsetAt: new Date(),
    };
    const [first] = await t.db
      .insert(schema.merchantAlerts)
      .values(alert)
      .returning({ id: schema.merchantAlerts.id });
    await t.db
      .update(schema.merchantAlerts)
      .set({ resolvedAt: sql`now()` })
      .where(eq(schema.merchantAlerts.id, first!.id));

    const again = await t.db
      .insert(schema.merchantAlerts)
      .values(alert)
      .onConflictDoNothing()
      .returning({ id: schema.merchantAlerts.id });
    expect(again).toHaveLength(1);
  });

  it('allows one active Razorpay connection per merchant per mode', async () => {
    const conn = {
      merchantId,
      mode: 'live' as const,
      keyId: 'rzp_live_x',
      keySecretEnc: 'enc:…',
    };
    await t.db.insert(schema.razorpayConnections).values(conn);
    // Two live connections would double-process every webhook.
    const dup = await t.db
      .insert(schema.razorpayConnections)
      .values(conn)
      .onConflictDoNothing()
      .returning({ id: schema.razorpayConnections.id });
    expect(dup).toHaveLength(0);

    // Test mode alongside live is legitimate.
    const test = await t.db
      .insert(schema.razorpayConnections)
      .values({ ...conn, mode: 'test', keyId: 'rzp_test_x' })
      .onConflictDoNothing()
      .returning({ id: schema.razorpayConnections.id });
    expect(test).toHaveLength(1);
  });
});

describe('defaults are safe', () => {
  it('starts a new merchant PAUSED', async () => {
    const [m] = await t.db
      .select()
      .from(schema.merchants)
      .where(eq(schema.merchants.id, merchantId));

    // A merchant who connects must not have anything sent on their behalf
    // until they explicitly turn it on. This is the guarantee that survived
    // the removal of dry run: `execution_enabled` false IS paused.
    expect(m!.executionEnabled).toBe(false);
    expect(m!.holdoutEnabled).toBe(true);
    expect(m!.frequencyCapPerDay).toBeGreaterThan(0);
    expect(m!.dailyDebitBudgetPaise).toBe(0);
  });

  it('starts a Razorpay connection read-only', async () => {
    const [conn] = await t.db
      .insert(schema.razorpayConnections)
      .values({ merchantId, mode: 'live', keyId: 'k', keySecretEnc: 'e' })
      .returning({ scope: schema.razorpayConnections.scope });
    expect(conn!.scope).toBe('read_only');
  });

  it('defaults a case to attended — the safe side of the RBI boundary', async () => {
    const [c] = await t.db
      .insert(schema.recoveryCases)
      .values({ merchantId, type: 'payment_failure', amountAtRiskPaise: 1 })
      .returning({ attended: schema.recoveryCases.attended });
    expect(c!.attended).toBe(true);
  });
});

describe('the append-only ledger', () => {
  it('records events in order', async () => {
    const [c] = await t.db
      .insert(schema.recoveryCases)
      .values(baseCase())
      .returning({ id: schema.recoveryCases.id });

    await t.db.insert(schema.caseEvents).values([
      { caseId: c!.id, merchantId, kind: 'detected', toState: 'detected' },
      { caseId: c!.id, merchantId, kind: 'diagnosed', toState: 'diagnosed' },
    ]);

    const events = await t.db
      .select()
      .from(schema.caseEvents)
      .where(and(eq(schema.caseEvents.caseId, c!.id)))
      .orderBy(schema.caseEvents.occurredAt);

    expect(events.map((e) => e.kind)).toEqual(['detected', 'diagnosed']);
  });
});
