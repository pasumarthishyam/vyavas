import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import {
  claimExpiredCases,
  createCase,
  findActiveDowntime,
  findUnprocessed,
  getCase,
  hasLiveAttempt,
  listCaseEvents,
  markWebhookFailed,
  markWebhookProcessed,
  recordAttempt,
  recordMessageIfPermitted,
  recordWebhook,
  resolveDowntime,
  transitionCase,
  upsertDowntime,
  withCustomerLock,
} from '../../src/db/repos/index.js';
import {
  backdateMessage,
  createTestDb,
  schema,
  seedCustomer,
  seedMerchant,
  type TestDb,
} from './harness.js';

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

// ─── webhooks ────────────────────────────────────────────────────────────────

describe('recordWebhook', () => {
  const evt = {
    eventId: 'evt_abc123',
    eventType: 'payment.failed',
    payload: { entity: 'event' },
  };

  it('claims a new event', async () => {
    expect((await recordWebhook(t.db, evt)).isNew).toBe(true);
  });

  it('refuses to claim a replay', async () => {
    await recordWebhook(t.db, evt);
    // Razorpay delivers at-least-once and retries on timeout. Without this the
    // retry creates a second recovery case for the same order.
    expect((await recordWebhook(t.db, evt)).isNew).toBe(false);
  });

  it('stores the payload once, not twice', async () => {
    await recordWebhook(t.db, evt);
    await recordWebhook(t.db, { ...evt, payload: { tampered: true } });
    const rows = await t.db.select().from(schema.webhookEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toEqual({ entity: 'event' });
  });

  it('tracks processing outcome', async () => {
    await recordWebhook(t.db, evt);
    await markWebhookProcessed(t.db, evt.eventId);
    const [row] = await t.db
      .select()
      .from(schema.webhookEvents)
      .where(eq(schema.webhookEvents.eventId, evt.eventId));
    expect(row!.processedAt).not.toBeNull();
  });

  it('counts failures for the redrive queue', async () => {
    await recordWebhook(t.db, evt);
    await markWebhookFailed(t.db, evt.eventId, 'boom');
    await markWebhookFailed(t.db, evt.eventId, 'boom again');
    const [row] = await t.db
      .select()
      .from(schema.webhookEvents)
      .where(eq(schema.webhookEvents.eventId, evt.eventId));
    expect(row!.attempts).toBe(2);
    expect(row!.processingError).toBe('boom again');
  });

  it('finds events claimed but never processed', async () => {
    await recordWebhook(t.db, evt);
    // Dedupe means Razorpay's own retry cannot rescue a claimed-then-crashed
    // event. We have to sweep for it ourselves.
    expect(await findUnprocessed(t.db, 0)).toHaveLength(1);
    await markWebhookProcessed(t.db, evt.eventId);
    expect(await findUnprocessed(t.db, 0)).toHaveLength(0);
  });
});

// ─── the frequency cap ───────────────────────────────────────────────────────

describe('recordMessageIfPermitted', () => {
  const msg = (over: Record<string, unknown> = {}) => ({
    merchantId,
    customerId,
    caseId: null,
    rung: 1,
    channel: 'whatsapp' as const,
    intent: 'switch_method',
    idempotencyKey: `k-${Math.random()}`,
    ...over,
  });

  it('permits a send under the cap', async () => {
    const d = await recordMessageIfPermitted(t.db, msg(), 2);
    expect(d.permitted).toBe(true);
  });

  it('refuses once the cap is reached', async () => {
    await recordMessageIfPermitted(t.db, msg(), 2);
    await recordMessageIfPermitted(t.db, msg(), 2);
    const third = await recordMessageIfPermitted(t.db, msg(), 2);
    expect(third.permitted).toBe(false);
    if (!third.permitted) {
      expect(third.reason).toBe('frequency_cap');
      expect(third.recentCount).toBe(2);
    }
  });

  it('caps across cases, not per case', async () => {
    // The whole point: a customer with a failed payment AND an overdue invoice
    // has two independent workflows. Without a shared ledger they each send
    // politely and the person receives four messages.
    const [a] = await t.db
      .insert(schema.recoveryCases)
      .values({ merchantId, type: 'payment_failure', amountAtRiskPaise: 1, rzpOrderId: 'o1' })
      .returning({ id: schema.recoveryCases.id });
    const [b] = await t.db
      .insert(schema.recoveryCases)
      .values({ merchantId, type: 'receivable_overdue', amountAtRiskPaise: 1, rzpInvoiceId: 'i1' })
      .returning({ id: schema.recoveryCases.id });

    expect((await recordMessageIfPermitted(t.db, msg({ caseId: a!.id }), 2)).permitted).toBe(true);
    expect((await recordMessageIfPermitted(t.db, msg({ caseId: b!.id }), 2)).permitted).toBe(true);
    expect((await recordMessageIfPermitted(t.db, msg({ caseId: a!.id }), 2)).permitted).toBe(false);
  });

  it('lets the window roll forward', async () => {
    const first = await recordMessageIfPermitted(t.db, msg(), 1);
    expect(first.permitted).toBe(true);
    expect((await recordMessageIfPermitted(t.db, msg(), 1)).permitted).toBe(false);

    if (first.permitted) await backdateMessage(t.db, first.messageId, 25);
    expect((await recordMessageIfPermitted(t.db, msg(), 1)).permitted).toBe(true);
  });

  it('refuses a customer who has opted out, whatever the cap says', async () => {
    await t.db
      .update(schema.customers)
      .set({ optedOutAt: new Date() })
      .where(eq(schema.customers.id, customerId));

    const d = await recordMessageIfPermitted(t.db, msg(), 99);
    expect(d.permitted).toBe(false);
    if (!d.permitted) expect(d.reason).toBe('opted_out');
  });

  it('refuses a replayed rung as a duplicate, not as a new send', async () => {
    const key = 'case1:1:nudge';
    expect((await recordMessageIfPermitted(t.db, msg({ idempotencyKey: key }), 5)).permitted).toBe(
      true,
    );
    const replay = await recordMessageIfPermitted(t.db, msg({ idempotencyKey: key }), 5);
    expect(replay.permitted).toBe(false);
    if (!replay.permitted) expect(replay.reason).toBe('duplicate');
  });

  it('exempts suppressed messages from the cap but still records them', async () => {
    // Holdout and dry-run rows must not consume a real customer's budget, or
    // the holdout would suppress the treatment group too.
    await recordMessageIfPermitted(t.db, msg({ suppressedReason: 'holdout' }), 1);
    await recordMessageIfPermitted(t.db, msg({ suppressedReason: 'holdout' }), 1);
    await recordMessageIfPermitted(t.db, msg({ suppressedReason: 'holdout' }), 1);

    const rows = await t.db.select().from(schema.messageLog);
    expect(rows).toHaveLength(3);
    // A real send is still permitted — nothing reached the customer.
    expect((await recordMessageIfPermitted(t.db, msg(), 1)).permitted).toBe(true);
  });

  it('still refuses a suppressed message to an opted-out customer', async () => {
    await t.db
      .update(schema.customers)
      .set({ optedOutAt: new Date() })
      .where(eq(schema.customers.id, customerId));
    const d = await recordMessageIfPermitted(t.db, msg({ suppressedReason: 'holdout' }), 99);
    expect(d.permitted).toBe(false);
  });
});

describe('withCustomerLock', () => {
  it('runs the callback inside a transaction and returns its value', async () => {
    const result = await withCustomerLock(t.db, customerId, async () => 'done');
    expect(result).toBe('done');
  });

  it('rolls back on throw, releasing the lock with the transaction', async () => {
    const created = await createCase(t.db, {
      merchantId,
      customerId,
      type: 'payment_failure',
      amountAtRiskPaise: 1,
      rzpOrderId: 'order_rollback',
      attended: true,
    });
    const before = (await listCaseEvents(t.db, created.id)).length;

    await expect(
      withCustomerLock(t.db, customerId, async (tx) => {
        await tx
          .insert(schema.caseEvents)
          .values({ caseId: created.id, merchantId, kind: 'should_not_persist' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // The write inside the transaction is gone, and so is the lock — an
    // advisory *xact* lock is released by the rollback itself, which is why it
    // survives a process that dies mid-transaction.
    const after = await listCaseEvents(t.db, created.id);
    expect(after).toHaveLength(before);
    expect(after.some((e) => e.kind === 'should_not_persist')).toBe(false);

    await expect(withCustomerLock(t.db, customerId, async () => 'ok')).resolves.toBe('ok');
  });

  it('can be taken again after release', async () => {
    await withCustomerLock(t.db, customerId, async () => 1);
    await expect(withCustomerLock(t.db, customerId, async () => 2)).resolves.toBe(2);
  });
});

// ─── cases ───────────────────────────────────────────────────────────────────

describe('createCase', () => {
  const input = {
    merchantId: '',
    customerId: null as string | null,
    type: 'payment_failure' as const,
    amountAtRiskPaise: 184300,
    rzpOrderId: 'order_X',
    errorReason: 'card_expired',
    causeClass: 'instrument_dead' as const,
    attended: true,
  };

  it('creates a case and its first ledger entry', async () => {
    const r = await createCase(t.db, { ...input, merchantId, customerId });
    expect(r.created).toBe(true);

    const events = await listCaseEvents(t.db, r.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('detected');
  });

  it('returns the incumbent instead of creating a second live case', async () => {
    const first = await createCase(t.db, { ...input, merchantId, customerId });
    const second = await createCase(t.db, { ...input, merchantId, customerId });

    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(await t.db.select().from(schema.recoveryCases)).toHaveLength(1);
  });
});

describe('transitionCase', () => {
  let caseId: string;

  beforeEach(async () => {
    const r = await createCase(t.db, {
      merchantId,
      customerId,
      type: 'payment_failure',
      amountAtRiskPaise: 184300,
      rzpOrderId: 'order_T',
      attended: true,
    });
    caseId = r.id;
  });

  it('walks the happy path and writes the ledger', async () => {
    expect((await transitionCase(t.db, caseId, 'diagnosed', 'diagnosed')).ok).toBe(true);
    expect((await transitionCase(t.db, caseId, 'executing', 'ladder_started')).ok).toBe(true);
    expect(
      (await transitionCase(t.db, caseId, 'recovered', 'payment_received', {
        recoveredAmountPaise: 184300,
      })).ok,
    ).toBe(true);

    const c = await getCase(t.db, caseId);
    expect(c!.state).toBe('recovered');
    expect(c!.recoveredAmountPaise).toBe(184300);
    expect(c!.resolvedAt).not.toBeNull();

    const kinds = (await listCaseEvents(t.db, caseId)).map((e) => e.kind);
    expect(kinds).toEqual(['detected', 'state_changed', 'state_changed', 'state_changed']);
  });

  it('refuses to reopen a recovered case', async () => {
    await transitionCase(t.db, caseId, 'diagnosed', 'diagnosed');
    await transitionCase(t.db, caseId, 'recovered', 'payment_received');

    // The guard against messaging someone who has already paid.
    const r = await transitionCase(t.db, caseId, 'executing', 'resumed');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('terminal');

    expect((await getCase(t.db, caseId))!.state).toBe('recovered');
  });

  it('refuses an illegal transition without touching the row', async () => {
    const r = await transitionCase(t.db, caseId, 'executing', 'ladder_started');
    expect(r.ok).toBe(false);
    expect((await getCase(t.db, caseId))!.state).toBe('detected');
  });

  it('refuses a reason that does not justify the destination', async () => {
    await transitionCase(t.db, caseId, 'diagnosed', 'diagnosed');
    await transitionCase(t.db, caseId, 'executing', 'ladder_started');
    const r = await transitionCase(t.db, caseId, 'recovered', 'ladder_exhausted');
    expect(r.ok).toBe(false);
  });
});

describe('payment attempts', () => {
  it('dedupes on the Razorpay payment id', async () => {
    const attempt = {
      merchantId,
      rzpOrderId: 'order_A',
      rzpPaymentId: 'pay_1',
      amountPaise: 100,
      attemptedAt: new Date(),
    };
    await recordAttempt(t.db, attempt);
    await recordAttempt(t.db, attempt);
    expect(await t.db.select().from(schema.paymentAttempts)).toHaveLength(1);
  });

  it('detects a live attempt so we do not interrupt someone mid-retry', async () => {
    await recordAttempt(t.db, {
      merchantId,
      rzpOrderId: 'order_A',
      rzpPaymentId: 'pay_1',
      amountPaise: 100,
      attemptedAt: new Date(),
    });
    expect(await hasLiveAttempt(t.db, merchantId, 'order_A', 3)).toBe(true);
  });

  it('does not treat an old attempt as live', async () => {
    await recordAttempt(t.db, {
      merchantId,
      rzpOrderId: 'order_A',
      rzpPaymentId: 'pay_old',
      amountPaise: 100,
      attemptedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    expect(await hasLiveAttempt(t.db, merchantId, 'order_A', 3)).toBe(false);
  });
});

describe('claimExpiredCases', () => {
  it('finds live cases past their deadline and ignores fresh ones', async () => {
    await t.db.insert(schema.recoveryCases).values([
      {
        merchantId,
        type: 'payment_failure',
        amountAtRiskPaise: 1,
        rzpOrderId: 'expired',
        deadlineAt: new Date(Date.now() - 1000),
      },
      {
        merchantId,
        type: 'payment_failure',
        amountAtRiskPaise: 1,
        rzpOrderId: 'fresh',
        deadlineAt: new Date(Date.now() + 3_600_000),
      },
    ]);

    const claimed = await claimExpiredCases(t.db);
    expect(claimed.map((c) => c.rzpOrderId)).toEqual(['expired']);
  });

  it('ignores cases that already ended', async () => {
    await t.db.insert(schema.recoveryCases).values({
      merchantId,
      type: 'payment_failure',
      amountAtRiskPaise: 1,
      rzpOrderId: 'done',
      state: 'recovered',
      deadlineAt: new Date(Date.now() - 1000),
    });
    expect(await claimExpiredCases(t.db)).toHaveLength(0);
  });
});

// ─── downtime ────────────────────────────────────────────────────────────────

describe('downtime feed', () => {
  const dt = {
    id: 'down_1',
    method: 'netbanking' as const,
    bank: 'icic',
    status: 'started',
    severity: 'high' as const,
    startedAt: new Date(),
  };

  it('upserts started then updated into one row', async () => {
    await upsertDowntime(t.db, dt);
    await upsertDowntime(t.db, { ...dt, status: 'updated', severity: 'medium' });
    const rows = await t.db.select().from(schema.downtimeWindows);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.severity).toBe('medium');
  });

  it('uppercases the bank so it joins against the normalised tuple', async () => {
    await upsertDowntime(t.db, dt);
    const active = await findActiveDowntime(t.db);
    expect(active[0]!.bank).toBe('ICIC');
  });

  it('drops out of the active set once resolved', async () => {
    await upsertDowntime(t.db, dt);
    expect(await findActiveDowntime(t.db)).toHaveLength(1);
    await resolveDowntime(t.db, dt.id, new Date());
    expect(await findActiveDowntime(t.db)).toHaveLength(0);
  });

  it('shapes rows for DiagnoseContext', async () => {
    await upsertDowntime(t.db, dt);
    const [w] = await findActiveDowntime(t.db);
    expect(w).toMatchObject({ method: 'netbanking', bank: 'ICIC', severity: 'high' });
    expect(w!.startedAt).toBeInstanceOf(Date);
  });
});
