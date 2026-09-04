/**
 * The abandoned-cart agent's honesty about delivery.
 *
 * One bug is worth naming, because every test here exists to keep it dead: the
 * console showed `emailed` for a cart whose email was never sent. `status` on
 * `abandoned_carts` is the CART's lifecycle — a payment link is live and
 * something has to watch it for payment — and it was being read as though it
 * were a delivery receipt, while the actual send outcome (suppressed by a dry
 * run, refused by the frequency cap, rejected by the provider) was computed and
 * thrown away.
 *
 * So: the lifecycle and the delivery are two facts, they are recorded
 * separately, and neither is allowed to stand in for the other.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import {
  createAbandonedCart,
  getAbandonedCart,
  listPendingAbandonedCartsForMerchant,
  recordCartLinkIssued,
} from '../../src/db/repos/abandoned-carts.js';
import {
  getAbandonedCartSummary,
  getRecentAbandonedCarts,
} from '../../src/db/queries/abandoned-cart-agent.js';
import { lastNDays } from '../../src/lib/date-range.js';
import { createTestDb, schema, seedCustomer, seedMerchant, type TestDb } from './harness.js';

let t: TestDb;
let merchantId: string;
let customerId: string;

beforeEach(async () => {
  t = await createTestDb();
  merchantId = await seedMerchant(t.db);
  customerId = await seedCustomer(t.db, merchantId);
});

afterEach(async () => {
  await t.close();
});

async function seedCart(externalCartId = `cart-${Math.random().toString(36).slice(2, 8)}`) {
  const { id } = await createAbandonedCart(t.db, {
    merchantId,
    externalCartId,
    customerName: 'Test Customer',
    customerEmail: 'customer@example.com',
    customerPhone: null,
    amountPaise: 598800,
  });
  return id;
}

const link = {
  customerId: null as string | null,
  discountAmountPaise: 20000,
  paymentLinkId: 'plink_TEST',
  paymentLinkUrl: 'https://rzp.io/i/test',
  paymentLinkAmountPaise: 578800,
  paymentLinkExpiresAt: new Date(Date.now() + 86_400_000),
};

describe('recordCartLinkIssued', () => {
  it('stamps emailSentAt only when an email actually left', async () => {
    const id = await seedCart();
    await recordCartLinkIssued(t.db, id, { ...link, emailStatus: 'sent', emailDetail: null });

    const row = await getAbandonedCart(t.db, id);
    expect(row?.emailStatus).toBe('sent');
    expect(row?.emailSentAt).not.toBeNull();
  });

  it('records the refusal, and leaves emailSentAt null', async () => {
    const id = await seedCart();
    await recordCartLinkIssued(t.db, id, {
      ...link,
      emailStatus: 'refused',
      emailDetail: 'frequency_cap',
    });

    const row = await getAbandonedCart(t.db, id);
    // The claim the old code made, and could not support.
    expect(row?.emailSentAt).toBeNull();
    expect(row?.emailStatus).toBe('refused');
    expect(row?.emailDetail).toBe('frequency_cap');
  });

  it('still parks the cart in `emailed`, because the link is live either way', async () => {
    // The lifecycle is not "did we email"; it is "is there a payment link that
    // something must sweep for payment". Moving an undelivered cart out of this
    // state would strand a live link nobody ever checks again.
    const id = await seedCart();
    await recordCartLinkIssued(t.db, id, {
      ...link,
      emailStatus: 'no_channel',
      emailDetail: 'email client not configured',
    });

    const row = await getAbandonedCart(t.db, id);
    expect(row?.status).toBe('emailed');

    const pending = await listPendingAbandonedCartsForMerchant(t.db, merchantId);
    expect(pending.map((p) => p.id)).toContain(id);
  });
});

describe('getRecentAbandonedCarts', () => {
  it('carries the ledger row for the cart, so a suppressed send reads as skipped', async () => {
    const id = await seedCart();
    await recordCartLinkIssued(t.db, id, {
      ...link,
      customerId,
      emailStatus: 'suppressed',
      emailDetail: 'dry_run',
    });

    // Exactly what the send path writes for a planned-but-not-delivered
    // message, keyed the way `workflows/abandoned-cart.ts` keys it.
    await t.db.insert(schema.messageLog).values({
      merchantId,
      customerId,
      caseId: null,
      channel: 'email',
      intent: 'cart_abandoned_discount',
      status: 'suppressed',
      suppressedReason: 'dry_run',
      body: 'Your cart is saved — ₹200 off inside.',
      idempotencyKey: `abandoned-cart:${id}:email`,
    });

    const [row] = await getRecentAbandonedCarts(t.db, merchantId);
    expect(row?.status).toBe('emailed');
    expect(row?.deliveryStatus).toBe('suppressed');
    expect(row?.deliverySuppressedReason).toBe('dry_run');
    expect(row?.emailBody).toContain('₹200 off');
  });

  it('leaves the delivery fields null for a cart that never reached the send path', async () => {
    await seedCart();

    const [row] = await getRecentAbandonedCarts(t.db, merchantId);
    expect(row?.status).toBe('detected');
    expect(row?.emailStatus).toBeNull();
    expect(row?.deliveryStatus).toBeNull();
  });

  it('does not multiply rows when another cart has its own ledger entry', async () => {
    // The join is on this cart's own idempotency key. A `1 = 1`-ish mistake
    // here would silently duplicate every cart once per message in the table.
    const first = await seedCart('cart-a');
    const second = await seedCart('cart-b');
    for (const id of [first, second]) {
      await t.db.insert(schema.messageLog).values({
        merchantId,
        customerId,
        channel: 'email',
        intent: 'cart_abandoned_discount',
        status: 'sent',
        idempotencyKey: `abandoned-cart:${id}:email`,
      });
    }

    const rows = await getRecentAbandonedCarts(t.db, merchantId);
    expect(rows).toHaveLength(2);
  });
});

describe('getAbandonedCartSummary', () => {
  it('counts links whose email never went out, and ignores carts that recorded no verdict', async () => {
    const undelivered = await seedCart('cart-undelivered');
    await recordCartLinkIssued(t.db, undelivered, {
      ...link,
      emailStatus: 'failed',
      emailDetail: 'undeliverable: mailbox does not exist',
    });

    const delivered = await seedCart('cart-delivered');
    await recordCartLinkIssued(t.db, delivered, { ...link, emailStatus: 'sent', emailDetail: null });

    // A row from before delivery tracking: no verdict either way. It must not
    // be accused of a failure nobody can verify.
    const legacy = await seedCart('cart-legacy');
    await t.db
      .update(schema.abandonedCarts)
      .set({ status: 'emailed', emailSentAt: new Date() })
      .where(eq(schema.abandonedCarts.id, legacy));

    const summary = await getAbandonedCartSummary(t.db, merchantId, lastNDays(30));
    expect(summary.notDeliveredCount).toBe(1);
    expect(summary.totalCount).toBe(3);
  });
});
