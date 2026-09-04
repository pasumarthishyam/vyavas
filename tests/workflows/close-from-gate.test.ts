/**
 * How a ladder ends.
 *
 * Every abort the gate can produce used to become `aborted` with reason
 * `already_paid`. Three different truths collapsed into one lie: a case whose
 * money had arrived, a case that ran out of runway, and a customer who opted
 * out. The first of those is the outcome this whole product exists to produce,
 * and it was recorded as an abort with no recovered amount against it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { closeCaseFromGate } from '../../src/workflows/case-run.js';
import { createTestDb, schema, seedCustomer, seedMerchant, type TestDb } from '../db/harness.js';

const NOW = new Date('2026-08-27T14:10:00.000Z');

let t: TestDb;
let merchantId: string;
let caseId: string;

beforeEach(async () => {
  t = await createTestDb();
  merchantId = await seedMerchant(t.db, { executionEnabled: true });
  const customerId = await seedCustomer(t.db, merchantId, { transactionalBasisAt: NOW });

  const [c] = await t.db
    .insert(schema.recoveryCases)
    .values({
      merchantId,
      customerId,
      type: 'payment_failure',
      state: 'executing',
      amountAtRiskPaise: 184_300,
      rzpOrderId: 'order_CLOSE',
      causeClass: 'instrument_dead',
      errorReason: 'card_expired',
      method: 'card',
      attended: true,
      deadlineAt: new Date(NOW.getTime() + 86_400_000),
    })
    .returning({ id: schema.recoveryCases.id });
  caseId = c!.id;
});

afterEach(async () => {
  await t.close();
});

const caseRow = async () => {
  const [row] = await t.db
    .select()
    .from(schema.recoveryCases)
    .where(eq(schema.recoveryCases.id, caseId));
  return row!;
};

const close = (over: Parameters<typeof closeCaseFromGate>[1] extends infer T ? Partial<T> : never) =>
  closeCaseFromGate(t.db, {
    caseId,
    merchantId,
    failed: null,
    note: 'test',
    paidAmountPaise: null,
    paidConfirmed: false,
    ...over,
  });

describe('the money arrived', () => {
  it('records a confirmed payment-link payment as recovered, with the amount', async () => {
    const r = await close({
      failed: 'payment_link_paid',
      paidAmountPaise: 164_300,
      paidConfirmed: true,
    });

    expect(r.outcome).toBe('recovered');
    const c = await caseRow();
    expect(c.state).toBe('recovered');
    // The DISCOUNTED amount, not the amount at risk.
    expect(c.recoveredAmountPaise).toBe(164_300);
    expect(c.resolvedAt).not.toBeNull();
  });

  it('records a confirmed order payment as recovered', async () => {
    const r = await close({ failed: 'order_paid', paidAmountPaise: 184_300, paidConfirmed: true });
    expect(r.outcome).toBe('recovered');
    expect((await caseRow()).state).toBe('recovered');
  });

  it('writes a payment_received event so the trace shows how it closed', async () => {
    await close({ failed: 'payment_link_paid', paidAmountPaise: 164_300, paidConfirmed: true });
    const events = await t.db
      .select()
      .from(schema.caseEvents)
      .where(eq(schema.caseEvents.caseId, caseId));
    const received = events.find((e) => e.kind === 'payment_received');
    expect(received).toBeDefined();
    expect((received!.payload as Record<string, unknown>).via).toBe('payment_link');
    expect((received!.payload as Record<string, unknown>).detectedBy).toBe('gate');
  });
});

describe('we only THINK the money arrived', () => {
  it('does NOT book a recovery when Razorpay could not be reached', async () => {
    /*
     * The regression this test exists for.
     *
     * `isOrderPaid` answers "paid" when the API is unreachable, so the ladder
     * stays silent rather than messaging someone who may have paid. Treating
     * that answer as a real payment would close a batch of live cases as
     * recovered every time Razorpay had a bad minute, and book revenue that
     * never arrived — in the one number a merchant is asked to trust.
     */
    const r = await close({ failed: 'order_paid', paidAmountPaise: null, paidConfirmed: false });

    expect(r.outcome).toBe('aborted');
    expect(r.reason).toBe('assumed_paid_unconfirmed');
    const c = await caseRow();
    expect(c.state).toBe('aborted');
    expect(c.recoveredAmountPaise).toBeNull();
  });
});

describe('the other ways a ladder ends', () => {
  it('marks a case past its deadline as lost, not aborted', async () => {
    // The same state the deadline sweep uses, so whichever gets there first
    // leaves the same record. `aborted` means we stopped deliberately; `lost`
    // means we tried and ran out of runway.
    const r = await close({ failed: 'deadline_passed' });
    expect(r.outcome).toBe('lost');
    const c = await caseRow();
    expect(c.state).toBe('lost');
    expect(c.recoveredAmountPaise).toBeNull();
  });

  it('records an opt-out as an opt-out, not as a payment', async () => {
    const r = await close({ failed: 'consent_ok' });
    expect(r.outcome).toBe('aborted');
    expect(r.reason).toBe('customer_opted_out');
    expect((await caseRow()).state).toBe('aborted');
  });

  it('aborts on an unreachable customer without claiming they paid', async () => {
    const r = await close({ failed: 'channel_deliverable' });
    expect(r.outcome).toBe('aborted');
    expect(r.reason).toBe('manual_abort');
  });

  it('is a safe no-op on a case that is already terminal', async () => {
    // The ordinary case, not an exception: the webhook usually closes a case a
    // moment before the ladder's gate notices.
    await close({ failed: 'order_paid', paidAmountPaise: 184_300, paidConfirmed: true });
    const again = await close({ failed: 'deadline_passed' });

    expect(again.outcome).toBe('unchanged');
    const c = await caseRow();
    expect(c.state).toBe('recovered');
    expect(c.recoveredAmountPaise).toBe(184_300);
  });
});
