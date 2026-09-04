/**
 * The join between the two agents.
 *
 * `abandoned_carts` carries no order id and no payment reference — there was no
 * payment, which is the entire reason that table exists — so the customer row
 * is the only thing the failed-payment agent and the cart agent share. This
 * pins that the lookup finds what it needs to, because if it silently returned
 * "no case" the cart agent would email every declined customer a discount and
 * nothing would look wrong.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { recentCaseActivityForCustomer } from '../../src/db/repos/cases.js';
import { shouldSuppressCart } from '../../src/core/guards/cart-suppression.js';
import { createTestDb, schema, seedCustomer, seedMerchant, type TestDb } from './harness.js';

const NOW = new Date('2026-08-27T14:10:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

let t: TestDb;
let merchantId: string;
let customerId: string;

async function seedCase(over: Partial<typeof schema.recoveryCases.$inferInsert> = {}) {
  const [c] = await t.db
    .insert(schema.recoveryCases)
    .values({
      merchantId,
      customerId,
      type: 'payment_failure',
      state: 'executing',
      amountAtRiskPaise: 184_300,
      rzpOrderId: `order_${Math.random().toString(36).slice(2, 10)}`,
      method: 'card',
      attended: true,
      ...over,
    })
    .returning({ id: schema.recoveryCases.id });
  return c!.id;
}

beforeEach(async () => {
  t = await createTestDb();
  merchantId = await seedMerchant(t.db, { executionEnabled: true });
  customerId = await seedCustomer(t.db, merchantId, { transactionalBasisAt: NOW });
});

afterEach(async () => {
  await t.close();
});

describe('finding the failure behind a "cart"', () => {
  it('reports nothing for a customer who has never had a case', async () => {
    const a = await recentCaseActivityForCustomer(t.db, merchantId, customerId);
    expect(a.hasLiveCase).toBe(false);
    expect(a.mostRecentCaseAt).toBeNull();
    expect(shouldSuppressCart({ now: NOW, ...a }).suppress).toBe(false);
  });

  it('sees a case still being recovered', async () => {
    await seedCase({ state: 'executing' });
    const a = await recentCaseActivityForCustomer(t.db, merchantId, customerId);
    expect(a.hasLiveCase).toBe(true);
    expect(shouldSuppressCart({ now: NOW, ...a }).suppress).toBe(true);
  });

  it('counts every live state, including paused', async () => {
    // A paused case is still this person's open failure. Emailing them a
    // discount because an operator happened to pause the agent would be the
    // same collision by another route.
    //
    // One database, one customer per state — spinning up four PGlite instances
    // for this took longer than the whole rest of the file.
    for (const state of ['detected', 'diagnosed', 'executing', 'paused'] as const) {
      const who = await seedCustomer(t.db, merchantId, { transactionalBasisAt: NOW });
      await t.db.insert(schema.recoveryCases).values({
        merchantId,
        customerId: who,
        type: 'payment_failure',
        state,
        amountAtRiskPaise: 1000,
        rzpOrderId: `o_${state}`,
        method: 'card',
        attended: true,
      });
      const a = await recentCaseActivityForCustomer(t.db, merchantId, who);
      expect(a.hasLiveCase, state).toBe(true);
    }
  });

  it('does NOT count a terminal state as live', async () => {
    for (const state of ['recovered', 'lost', 'aborted'] as const) {
      const who = await seedCustomer(t.db, merchantId, { transactionalBasisAt: NOW });
      await t.db.insert(schema.recoveryCases).values({
        merchantId,
        customerId: who,
        type: 'payment_failure',
        state,
        amountAtRiskPaise: 1000,
        rzpOrderId: `t_${state}`,
        method: 'card',
        attended: true,
        resolvedAt: NOW,
      });
      const a = await recentCaseActivityForCustomer(t.db, merchantId, who);
      expect(a.hasLiveCase, state).toBe(false);
    }
  });

  it('still reports a RESOLVED case, so a recent failure is not forgotten', async () => {
    // The person paid or was written off, but the failure still happened. A
    // cart reported minutes later is that same session.
    await seedCase({ state: 'recovered', resolvedAt: NOW, createdAt: hoursAgo(1) });
    const a = await recentCaseActivityForCustomer(t.db, merchantId, customerId);
    expect(a.hasLiveCase).toBe(false);
    expect(a.mostRecentCaseAt).not.toBeNull();
    expect(shouldSuppressCart({ now: NOW, ...a }).suppress).toBe(true);
  });

  it('takes the MOST RECENT case when there are several', async () => {
    await seedCase({ state: 'lost', createdAt: hoursAgo(24 * 40) });
    await seedCase({ state: 'lost', createdAt: hoursAgo(2) });
    const a = await recentCaseActivityForCustomer(t.db, merchantId, customerId);
    // An old case must not make a fresh one invisible.
    expect(shouldSuppressCart({ now: NOW, ...a }).suppress).toBe(true);
  });

  it('lets an old failure go, so a genuinely new basket still gets emailed', async () => {
    await seedCase({ state: 'lost', createdAt: hoursAgo(24 * 30) });
    const a = await recentCaseActivityForCustomer(t.db, merchantId, customerId);
    expect(a.hasLiveCase).toBe(false);
    expect(shouldSuppressCart({ now: NOW, ...a }).suppress).toBe(false);
  });

  it('does not see another CUSTOMER’s failure', async () => {
    const other = await seedCustomer(t.db, merchantId, { transactionalBasisAt: NOW });
    await seedCase({ state: 'executing' });

    const a = await recentCaseActivityForCustomer(t.db, merchantId, other);
    expect(a.hasLiveCase).toBe(false);
    expect(a.mostRecentCaseAt).toBeNull();
  });

  it('does not see another MERCHANT’s failure for the same person', async () => {
    // Two tenants can hold the same email. One merchant's decline must never
    // silence another merchant's cart.
    const otherMerchant = await seedMerchant(t.db, { slug: 'other', executionEnabled: true });
    await seedCase({ state: 'executing' });

    const a = await recentCaseActivityForCustomer(t.db, otherMerchant, customerId);
    expect(a.hasLiveCase).toBe(false);
    expect(a.mostRecentCaseAt).toBeNull();
  });
});

describe('the suppressed status', () => {
  it('is a real enum value the database accepts', async () => {
    // Added by migration 0011. Without it the write throws and the agent would
    // fall through to emailing exactly the customer it meant to skip.
    const [cart] = await t.db
      .insert(schema.abandonedCarts)
      .values({
        merchantId,
        externalCartId: 'cart-suppressed',
        customerEmail: 'rahul@example.com',
        amountPaise: 184_300,
        status: 'suppressed',
      })
      .returning({ id: schema.abandonedCarts.id });

    const [row] = await t.db
      .select()
      .from(schema.abandonedCarts)
      .where(eq(schema.abandonedCarts.id, cart!.id));
    expect(row!.status).toBe('suppressed');
  });

  it('is excluded from the payment-confirmation sweep', async () => {
    // The sweep scans `emailed` rows with a link. A suppressed cart has neither,
    // so it must never be polled at Razorpay for a link that was never created.
    const { listPendingAbandonedCarts } = await import('../../src/db/repos/abandoned-carts.js');
    await t.db.insert(schema.abandonedCarts).values({
      merchantId,
      externalCartId: 'cart-x',
      customerEmail: 'rahul@example.com',
      amountPaise: 1000,
      status: 'suppressed',
    });
    expect(await listPendingAbandonedCarts(t.db)).toHaveLength(0);
  });
});
