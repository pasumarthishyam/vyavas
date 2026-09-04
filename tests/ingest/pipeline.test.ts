/**
 * The pipeline, end to end.
 *
 * Real Razorpay-shaped payloads through normalize -> diagnose -> resolve ->
 * persist, against real Postgres (PGlite). This is the first test in the
 * project where the whole brain runs against the whole body, and it is what
 * proves Stages 1-3 actually compose rather than merely each passing alone.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import {
  FAILURE_SCENARIOS,
  downtimeEnvelope,
  orderPaidEnvelope,
  paymentFailedEnvelope,
  paymentLinkPaidEnvelope,
} from '@adapters/razorpay/fixtures/webhooks.js';
import { processEvent } from '@ingest/pipeline.js';
import type { HandlerContext } from '@ingest/pipeline.js';
import { listCasesAwaitingLinkPayment } from '../../src/db/repos/cases.js';
import { listPendingAbandonedCarts } from '../../src/db/repos/abandoned-carts.js';
import { createTestDb, schema, seedMerchant, type TestDb } from '../db/harness.js';

const NOW = new Date('2026-08-27T14:10:00.000Z');

let t: TestDb;
let ctx: HandlerContext;

beforeEach(async () => {
  t = await createTestDb();
  const merchantId = await seedMerchant(t.db);
  ctx = { db: t.db, merchantId, now: NOW, holdoutBasisPoints: 0, holdoutEnabled: false };
});

afterEach(async () => {
  await t.close();
});

const caseRow = async (id: string) => {
  const [row] = await t.db
    .select()
    .from(schema.recoveryCases)
    .where(eq(schema.recoveryCases.id, id));
  return row!;
};

describe('payment.failed — the full path', () => {
  it('turns a raw webhook into a diagnosed, policy-stamped case', async () => {
    const r = await processEvent(ctx, FAILURE_SCENARIOS.card_expired());

    expect(r.handled).toBe(true);
    expect(r.outcome).toBe('diagnosed');

    const c = await caseRow(r.caseId!);
    expect(c.state).toBe('diagnosed');
    expect(c.causeClass).toBe('instrument_dead');
    expect(c.policyId).toBe('instrument_dead.card_expired');
    expect(c.policyVersion).toBe(1);
    expect(c.attended).toBe(true);
    expect(c.amountAtRiskPaise).toBe(184300);
    expect(c.deadlineAt!.getTime()).toBeGreaterThan(NOW.getTime());

    // The full tuple survives, uncollapsed — it is the routing key.
    expect(c.errorReason).toBe('card_expired');
    expect(c.errorSource).toBe('customer');
    expect(c.errorStep).toBe('payment_authorization');
    expect(c.method).toBe('card');
    expect(c.bank).toBe('HDFC');
    expect(c.network).toBe('VISA');
  });

  it('resolves the customer and links them to the case', async () => {
    const r = await processEvent(ctx, FAILURE_SCENARIOS.card_expired());
    const c = await caseRow(r.caseId!);
    expect(c.customerId).not.toBeNull();

    const [cust] = await t.db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.id, c.customerId!));
    expect(cust!.phone).toBe('+919876543210');
    expect(cust!.email).toBe('rahul@example.com');
  });

  it('writes the diagnosis rationale to the ledger', async () => {
    const r = await processEvent(ctx, FAILURE_SCENARIOS.card_expired());
    const events = await t.db
      .select()
      .from(schema.caseEvents)
      .where(eq(schema.caseEvents.caseId, r.caseId!))
      .orderBy(schema.caseEvents.occurredAt);

    expect(events.map((e) => e.kind)).toEqual(['detected', 'diagnosed', 'state_changed']);

    const diagnosed = events.find((e) => e.kind === 'diagnosed')!;
    const payload = diagnosed.payload as Record<string, unknown>;
    expect(payload.causeClass).toBe('instrument_dead');
    expect(payload.policyId).toBe('instrument_dead.card_expired');
    expect(Array.isArray(payload.rationale)).toBe(true);
    expect((payload.rationale as string[]).length).toBeGreaterThan(0);
    // Never re-present a dead instrument.
    expect(payload.sameInstrumentRetry).toBe(false);
  });

  it('records the attempt so the caps can count', async () => {
    await processEvent(ctx, FAILURE_SCENARIOS.card_expired());
    const attempts = await t.db.select().from(schema.paymentAttempts);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.succeeded).toBe(false);
    expect(attempts[0]!.errorReason).toBe('card_expired');
  });
});

describe('the cause classes route to the right ladders', () => {
  const expected: Record<string, { causeClass: string; policyId: string }> = {
    card_expired: { causeClass: 'instrument_dead', policyId: 'instrument_dead.card_expired' },
    bank_technical_error: {
      causeClass: 'transient_infra',
      policyId: 'transient_infra.bank_technical_error',
    },
    incorrect_otp: { causeClass: 'customer_input', policyId: 'customer_input.incorrect_otp' },
    insufficient_funds: {
      causeClass: 'funds_limits',
      policyId: 'funds_limits.insufficient_funds',
    },
    payment_risk_check_failed: {
      causeClass: 'risk',
      policyId: 'risk.payment_risk_check_failed',
    },
    payment_cancelled: { causeClass: 'intent_exit', policyId: 'intent_exit.payment_cancelled' },
    bank_not_enabled: {
      causeClass: 'merchant_config',
      policyId: 'merchant_config.bank_not_enabled',
    },
    invalid_vpa_dead: { causeClass: 'instrument_dead', policyId: 'instrument_dead.invalid_vpa' },
  };

  it.each(Object.entries(expected))('%s', async (name, want) => {
    const envelope = FAILURE_SCENARIOS[name as keyof typeof FAILURE_SCENARIOS]();
    const r = await processEvent(ctx, envelope);
    const c = await caseRow(r.caseId!);
    expect(c.causeClass).toBe(want.causeClass);
    expect(c.policyId).toBe(want.policyId);
  });
});

describe('a deliberate exit is never dressed as a failure', () => {
  it('re-types payment_cancelled to intent_exit', async () => {
    const r = await processEvent(ctx, FAILURE_SCENARIOS.payment_cancelled());
    const c = await caseRow(r.caseId!);
    // The architectural separation: this never wears failure language and
    // never counts toward failure-rate alerting.
    expect(c.type).toBe('intent_exit');
    expect(c.causeClass).toBe('intent_exit');
  });
});

describe('order_already_paid closes immediately', () => {
  it('aborts without ever reaching a ladder', async () => {
    const r = await processEvent(ctx, FAILURE_SCENARIOS.order_already_paid());
    expect(r.outcome).toBe('aborted');

    const c = await caseRow(r.caseId!);
    expect(c.state).toBe('aborted');
    expect(c.resolvedAt).not.toBeNull();
    expect(c.policyId).toBe('terminal_noop.default');
  });
});

describe('an undocumented code never drops the case', () => {
  it('buckets it as unknown, flags it, and applies a cautious ladder', async () => {
    const r = await processEvent(ctx, FAILURE_SCENARIOS.undocumented_code());
    expect(r.handled).toBe(true);
    expect(r.detail?.unrecognisedReason).toBe(true);

    const c = await caseRow(r.caseId!);
    expect(c.errorReason).toBe('unknown_reason');
    // The original string is kept for forensics.
    expect(c.rawErrorReason).toBe('brand_new_code_from_razorpay');
    expect(c.confidence).toBe('low');
    expect(c.causeClass).not.toBeNull();
  });
});

describe('duplicate deliveries', () => {
  it('produce one case, not two ladders', async () => {
    const envelope = FAILURE_SCENARIOS.card_expired();
    const first = await processEvent(ctx, envelope);
    const second = await processEvent(ctx, envelope);

    expect(second.caseId).toBe(first.caseId);
    expect(second.detail?.created).toBe(false);
    expect(await t.db.select().from(schema.recoveryCases)).toHaveLength(1);
    // And the same payment id is not double-counted as two attempts.
    expect(await t.db.select().from(schema.paymentAttempts)).toHaveLength(1);
  });
});

describe('attempt history tightens the diagnosis', () => {
  it('withdraws same-instrument retry after repeated OTP failures', async () => {
    // Three separate attempts on the same order, same reason. The third must
    // not send the customer back for a fourth try — that commonly locks the
    // card at the issuer.
    for (const paymentId of ['pay_1', 'pay_2', 'pay_3']) {
      await processEvent(
        ctx,
        paymentFailedEnvelope({
          paymentId,
          errorReason: 'incorrect_otp',
          errorSource: 'customer',
          orderId: 'order_OTP',
        }),
      );
    }

    const [c] = await t.db
      .select()
      .from(schema.recoveryCases)
      .where(eq(schema.recoveryCases.rzpOrderId, 'order_OTP'));

    const events = await t.db
      .select()
      .from(schema.caseEvents)
      .where(eq(schema.caseEvents.caseId, c!.id));

    const diagnoses = events
      .filter((e) => e.kind === 'diagnosed')
      .map((e) => e.payload as Record<string, unknown>);

    expect(diagnoses).toHaveLength(3);
    expect(diagnoses[0]!.sameInstrumentRetry).toBe(true);
    expect(diagnoses[2]!.sameInstrumentRetry).toBe(false);
    expect(diagnoses[2]!.suggestedRails).not.toContain('retry_same');
  });
});

describe('the downtime feed changes the diagnosis', () => {
  it('reclassifies a decline during a confirmed outage and picks the outage ladder', async () => {
    await processEvent(
      ctx,
      downtimeEnvelope({ method: 'card', bank: 'HDFC', severity: 'high' }),
    );

    const r = await processEvent(
      ctx,
      paymentFailedEnvelope({
        errorReason: 'card_declined',
        errorSource: 'issuer',
        errorStep: 'payment_authorization',
        issuer: 'HDFC',
      }),
    );

    const c = await caseRow(r.caseId!);
    // Without the outage this would be a risk decline capped at one touch.
    expect(c.causeClass).toBe('transient_infra');
    expect(c.policyId).toBe('transient_infra.default');
  });

  it('does not reclassify an expired card during an outage', async () => {
    await processEvent(ctx, downtimeEnvelope({ method: 'card', bank: 'HDFC' }));
    const r = await processEvent(ctx, FAILURE_SCENARIOS.card_expired());
    const c = await caseRow(r.caseId!);
    // A card is expired whether or not HDFC is down.
    expect(c.causeClass).toBe('instrument_dead');
  });

  it('opens and resolves an outage', async () => {
    const opened = await processEvent(ctx, downtimeEnvelope({ id: 'down_1' }));
    expect(opened.outcome).toBe('opened');
    expect(await t.db.select().from(schema.downtimeWindows)).toHaveLength(1);

    const resolved = await processEvent(
      ctx,
      downtimeEnvelope({ id: 'down_1', event: 'payment.downtime.resolved' }),
    );
    expect(resolved.outcome).toBe('resolved');

    const [row] = await t.db.select().from(schema.downtimeWindows);
    expect(row!.resolvedAt).not.toBeNull();
  });
});

describe('order.paid is the kill switch', () => {
  it('closes the live case the moment the money arrives', async () => {
    const failed = await processEvent(ctx, FAILURE_SCENARIOS.card_expired());
    expect((await caseRow(failed.caseId!)).state).toBe('diagnosed');

    const paid = await processEvent(ctx, orderPaidEnvelope());
    expect(paid.outcome).toBe('recovered');
    expect(paid.caseId).toBe(failed.caseId);

    const c = await caseRow(failed.caseId!);
    expect(c.state).toBe('recovered');
    expect(c.recoveredAmountPaise).toBe(184300);
    expect(c.resolvedAt).not.toBeNull();
  });

  it('is a no-op when there was never a case', async () => {
    const r = await processEvent(ctx, orderPaidEnvelope({ orderId: 'order_NEVER_FAILED' }));
    expect(r.outcome).toBe('no_live_case');
  });

  it('refuses to reopen a case after it recovered', async () => {
    const failed = await processEvent(ctx, FAILURE_SCENARIOS.card_expired());
    await processEvent(ctx, orderPaidEnvelope());

    // A late-arriving duplicate failure for the same order must not resurrect
    // the case and start messaging someone who has already paid.
    const late = await processEvent(ctx, FAILURE_SCENARIOS.card_expired());
    expect(late.caseId).not.toBe(failed.caseId);

    const original = await caseRow(failed.caseId!);
    expect(original.state).toBe('recovered');
  });
});

/**
 * The recovery link is the whole product working, and until this suite existed
 * it was the one outcome the system could not record.
 *
 * A payment link creates its OWN order when paid, so `payload.order.entity.id`
 * on this event is not the order that failed. The handler used to resolve by
 * that id, find nothing, and report `no_live_case` — for a customer who had
 * just paid. The case then received every remaining rung and was written off as
 * lost, with no recovered amount anywhere.
 */
describe('payment_link.paid — the recovery link was paid', () => {
  it('closes the case the link was created for, and records what arrived', async () => {
    const failed = await processEvent(ctx, FAILURE_SCENARIOS.card_expired());
    const caseId = failed.caseId!;

    // The ladder stores the link on the case when it creates it.
    await t.db
      .update(schema.recoveryCases)
      .set({ rzpPaymentLinkId: 'plink_TEST00000001', rzpPaymentLinkUrl: 'https://rzp.io/i/testlink' })
      .where(eq(schema.recoveryCases.id, caseId));

    const paid = await processEvent(ctx, paymentLinkPaidEnvelope({ referenceId: caseId }));

    expect(paid.handled).toBe(true);
    expect(paid.outcome).toBe('case_recovered');
    expect(paid.caseId).toBe(caseId);

    const c = await caseRow(caseId);
    expect(c.state).toBe('recovered');
    expect(c.recoveredAmountPaise).toBe(184300);
    expect(c.resolvedAt).not.toBeNull();
  });

  it('does NOT resolve by the order id on the event', async () => {
    // The regression guard. The link's own order is a real order id that
    // belongs to nothing we track; resolving by it is what silently lost every
    // link payment. The failed order is `order_TEST000000001`.
    const failed = await processEvent(ctx, FAILURE_SCENARIOS.card_expired());

    const paid = await processEvent(
      ctx,
      paymentLinkPaidEnvelope({ referenceId: failed.caseId!, linkOrderId: 'order_TEST000000001' }),
    );

    // Still resolved — by reference_id, which is the point. If this ever starts
    // depending on the order id it will pass here and fail the test above.
    expect(paid.outcome).toBe('case_recovered');
    expect((await caseRow(failed.caseId!)).state).toBe('recovered');
  });

  it('records the DISCOUNTED amount, not the amount at risk', async () => {
    // A discount-caller link is deliberately less than the order. The recovered
    // figure must be what the customer actually paid, or the dashboard reports
    // revenue that never arrived.
    const failed = await processEvent(ctx, FAILURE_SCENARIOS.card_expired());

    await processEvent(
      ctx,
      paymentLinkPaidEnvelope({ referenceId: failed.caseId!, amount: 184300, amountPaid: 164300 }),
    );

    const c = await caseRow(failed.caseId!);
    expect(c.state).toBe('recovered');
    expect(c.recoveredAmountPaise).toBe(164300);
    expect(c.amountAtRiskPaise).toBe(184300);
  });

  it('falls back to the stored link id when the link carries no reference', async () => {
    const failed = await processEvent(ctx, FAILURE_SCENARIOS.card_expired());
    await t.db
      .update(schema.recoveryCases)
      .set({ rzpPaymentLinkId: 'plink_NOREFERENCE' })
      .where(eq(schema.recoveryCases.id, failed.caseId!));

    const paid = await processEvent(
      ctx,
      paymentLinkPaidEnvelope({ referenceId: '', linkId: 'plink_NOREFERENCE' }),
    );

    expect(paid.outcome).toBe('case_recovered');
    expect((await caseRow(failed.caseId!)).state).toBe('recovered');
  });

  it('closes an abandoned cart whose link was paid', async () => {
    const [cart] = await t.db
      .insert(schema.abandonedCarts)
      .values({
        merchantId: ctx.merchantId,
        externalCartId: 'cart-1',
        customerEmail: 'rahul@example.com',
        amountPaise: 184300,
        status: 'emailed',
        paymentLinkId: 'plink_CART000000001',
      })
      .returning({ id: schema.abandonedCarts.id });

    const paid = await processEvent(ctx, paymentLinkPaidEnvelope({ referenceId: cart!.id }));
    expect(paid.outcome).toBe('cart_recovered');

    const [row] = await t.db
      .select()
      .from(schema.abandonedCarts)
      .where(eq(schema.abandonedCarts.id, cart!.id));
    expect(row!.status).toBe('recovered');
    expect(row!.paymentConfirmedAt).not.toBeNull();
  });

  it('closes a discount call and its case when the negotiated link is paid', async () => {
    const failed = await processEvent(ctx, FAILURE_SCENARIOS.card_expired());

    const [call] = await t.db
      .insert(schema.voiceCalls)
      .values({
        caseId: failed.caseId!,
        merchantId: ctx.merchantId,
        vapiCallId: 'call_TEST0001',
        customerPhone: '+919876543210',
        status: 'ended',
        discountTierOffered: 1,
        discountAmountPaise: 20_000,
        paymentLinkId: 'plink_VOICE00000001',
        paymentLinkAmountPaise: 164_300,
      })
      .returning({ id: schema.voiceCalls.id });

    const paid = await processEvent(
      ctx,
      paymentLinkPaidEnvelope({ referenceId: call!.id, amount: 164_300, amountPaid: 164_300 }),
    );

    expect(paid.outcome).toBe('voice_call_recovered');

    const [row] = await t.db
      .select()
      .from(schema.voiceCalls)
      .where(eq(schema.voiceCalls.id, call!.id));
    expect(row!.paymentConfirmedAt).not.toBeNull();

    // Both halves close: the call's own confirmation column AND the recovery
    // case it was placed against. Before this, a customer who paid after the
    // call ended was never confirmed at all — `end-of-call-report` fires while
    // they are still reading the link out, and the "phase-2 sweep" its comment
    // refers to was never written.
    const c = await caseRow(failed.caseId!);
    expect(c.state).toBe('recovered');
    expect(c.recoveredAmountPaise).toBe(164_300);
  });

  it('is idempotent — a replayed delivery does not double-close', async () => {
    const failed = await processEvent(ctx, FAILURE_SCENARIOS.card_expired());
    const first = await processEvent(ctx, paymentLinkPaidEnvelope({ referenceId: failed.caseId! }));
    const second = await processEvent(ctx, paymentLinkPaidEnvelope({ referenceId: failed.caseId! }));

    expect(first.outcome).toBe('case_recovered');
    // Terminal states never reopen, so the second delivery is a recorded no-op
    // rather than a second recovery counted twice.
    expect(second.outcome).toBe('case_already_closed');
    expect((await caseRow(failed.caseId!)).state).toBe('recovered');
  });

  it('is a harmless no-op for a link that belongs to nothing we track', async () => {
    // A merchant may create their own payment links. Not an error, and it must
    // not fail the delivery.
    const r = await processEvent(ctx, paymentLinkPaidEnvelope({ referenceId: 'not-a-uuid' }));
    expect(r.handled).toBe(true);
    expect(r.outcome).toBe('unmatched');
  });

  it('does not touch another merchant’s case', async () => {
    const failed = await processEvent(ctx, FAILURE_SCENARIOS.card_expired());
    const otherMerchantId = await seedMerchant(t.db, { slug: 'other' });
    const otherCtx: HandlerContext = { ...ctx, merchantId: otherMerchantId };

    const r = await processEvent(otherCtx, paymentLinkPaidEnvelope({ referenceId: failed.caseId! }));
    expect(r.outcome).toBe('unmatched');
    expect((await caseRow(failed.caseId!)).state).toBe('diagnosed');
  });
});

/**
 * The webhook and the sweeps must not fight.
 *
 * Both close a paid link, deliberately: the webhook is the fast path, the
 * sweeps are the backstop for a delivery that never arrived. The risk in adding
 * the fast path is that the two now race on the same rows, so what matters is
 * that whichever wins takes the other's work off the queue.
 */
describe('the webhook and the reconciliation sweeps agree', () => {
  it('takes a case off the link-reconciliation queue once the webhook closes it', async () => {
    const failed = await processEvent(ctx, FAILURE_SCENARIOS.card_expired());
    await t.db
      .update(schema.recoveryCases)
      .set({ rzpPaymentLinkId: 'plink_TEST00000001' })
      .where(eq(schema.recoveryCases.id, failed.caseId!));

    // Before: the sweep would pick this up and ask Razorpay about the link.
    expect((await listCasesAwaitingLinkPayment(t.db)).map((r) => r.id)).toContain(failed.caseId);

    await processEvent(ctx, paymentLinkPaidEnvelope({ referenceId: failed.caseId! }));

    // After: nothing left to reconcile. The case is no longer live and carries
    // a resolvedAt, so the sweep skips it rather than re-closing it.
    expect((await listCasesAwaitingLinkPayment(t.db)).map((r) => r.id)).not.toContain(failed.caseId);
  });

  it('takes a cart off the confirmation sweep once the webhook closes it', async () => {
    const [cart] = await t.db
      .insert(schema.abandonedCarts)
      .values({
        merchantId: ctx.merchantId,
        externalCartId: 'cart-sweep',
        customerEmail: 'rahul@example.com',
        amountPaise: 184300,
        status: 'emailed',
        paymentLinkId: 'plink_CARTSWEEP001',
      })
      .returning({ id: schema.abandonedCarts.id });

    expect((await listPendingAbandonedCarts(t.db)).map((r) => r.id)).toContain(cart!.id);

    await processEvent(ctx, paymentLinkPaidEnvelope({ referenceId: cart!.id }));

    // The 15-minute sweep in `sweep-abandoned-carts` scans exactly this set, so
    // an emptied queue is what proves it will not double-handle the row.
    expect((await listPendingAbandonedCarts(t.db)).map((r) => r.id)).not.toContain(cart!.id);
  });

  it('leaves an unpaid case on the queue for the sweep to pick up', async () => {
    // The other direction: the webhook must not remove work it did not do.
    const failed = await processEvent(ctx, FAILURE_SCENARIOS.card_expired());
    await t.db
      .update(schema.recoveryCases)
      .set({ rzpPaymentLinkId: 'plink_STILLUNPAID' })
      .where(eq(schema.recoveryCases.id, failed.caseId!));

    // A link paid for something else entirely.
    await processEvent(ctx, paymentLinkPaidEnvelope({ referenceId: 'not-ours' }));

    expect((await listCasesAwaitingLinkPayment(t.db)).map((r) => r.id)).toContain(failed.caseId);
    expect((await caseRow(failed.caseId!)).state).toBe('diagnosed');
  });
});

describe('holdout assignment', () => {
  it('splits deterministically and records the cohort', async () => {
    const held: HandlerContext = { ...ctx, holdoutBasisPoints: 10_000, holdoutEnabled: true };
    const r = await processEvent(held, FAILURE_SCENARIOS.card_expired());
    expect((await caseRow(r.caseId!)).cohort).toBe('holdout');
  });

  it('never holds out a merchant-fault case', async () => {
    const held: HandlerContext = { ...ctx, holdoutBasisPoints: 10_000, holdoutEnabled: true };
    const r = await processEvent(held, FAILURE_SCENARIOS.bank_not_enabled());
    // Withholding a breakage alert to measure incrementality is indefensible.
    expect((await caseRow(r.caseId!)).cohort).toBe('treatment');
  });
});

describe('unrouted and unsubscribed events', () => {
  it('reports an unsubscribed event without throwing', async () => {
    const r = await processEvent(ctx, { entity: 'event', event: 'settlement.processed' });
    expect(r.handled).toBe(false);
    expect(r.outcome).toBe('not_subscribed');
  });

  it('reports a subscribed-but-unimplemented event honestly', async () => {
    const r = await processEvent(ctx, { entity: 'event', event: 'subscription.halted', payload: {} });
    expect(r.handled).toBe(false);
    expect(r.outcome).toBe('observed_not_implemented');
  });

  it('does not throw on a subscribed event with a missing entity', async () => {
    const r = await processEvent(ctx, { entity: 'event', event: 'payment.failed', payload: {} });
    expect(r.handled).toBe(false);
    expect(r.outcome).toBe('missing_payment_entity');
  });
});

/**
 * Starting and stopping the ladder.
 *
 * These exist because the system spent its entire life with this wire missing.
 * `publishCaseDiagnosed` was written, documented and tested-adjacent, and had
 * ZERO callers — so every failure was ingested, diagnosed, stamped with a
 * ladder, and then nothing ran it. Nothing failed; nothing happened.
 *
 * A test that only checks the returned `ProcessResult` cannot catch that: the
 * result was always correct. The only way to notice is to assert on the seam
 * itself.
 */
describe('the workflow seam', () => {
  function spyPublisher() {
    const diagnosed: unknown[] = [];
    const resolved: unknown[] = [];
    return {
      diagnosed,
      resolved,
      publish: {
        caseDiagnosed: async (d: unknown) => {
          diagnosed.push(d);
        },
        caseResolved: async (d: unknown) => {
          resolved.push(d);
        },
      },
    };
  }

  it('starts a ladder for a diagnosed failure', async () => {
    const spy = spyPublisher();
    const r = await processEvent({ ...ctx, publish: spy.publish }, FAILURE_SCENARIOS.card_expired());

    expect(spy.diagnosed).toHaveLength(1);
    expect(spy.diagnosed[0]).toMatchObject({
      caseId: r.caseId,
      merchantId: ctx.merchantId,
      causeClass: 'instrument_dead',
      cohort: 'treatment',
      attended: true,
    });
  });

  it('carries the stamped policy, so the ladder runs the one the case was given', async () => {
    const spy = spyPublisher();
    const r = await processEvent({ ...ctx, publish: spy.publish }, FAILURE_SCENARIOS.card_expired());

    const c = await caseRow(r.caseId!);
    expect(spy.diagnosed[0]).toMatchObject({
      policyId: c.policyId,
      policyVersion: c.policyVersion,
    });
  });

  it('does NOT start a ladder for a terminal case', async () => {
    // `order_already_paid` has no ladder. Publishing would start a run that
    // immediately does nothing, and burn an Inngest idempotency key on a case
    // that must never reach a rung.
    const spy = spyPublisher();
    await processEvent({ ...ctx, publish: spy.publish }, FAILURE_SCENARIOS.order_already_paid());
    expect(spy.diagnosed).toHaveLength(0);
  });

  it('cancels the ladder the moment the money arrives', async () => {
    const spy = spyPublisher();
    const failed = await processEvent(
      { ...ctx, publish: spy.publish },
      FAILURE_SCENARIOS.card_expired(),
    );
    const c = await caseRow(failed.caseId!);

    await processEvent(
      { ...ctx, publish: spy.publish },
      orderPaidEnvelope({ orderId: c.rzpOrderId!, amount: Number(c.amountAtRiskPaise) }),
    );

    // The gate would also catch this at the next rung — but the next rung can
    // be 26 hours away, and a recovery message to someone who already paid is
    // the mistake that ends the merchant relationship.
    expect(spy.resolved).toHaveLength(1);
    expect(spy.resolved[0]).toMatchObject({ caseId: failed.caseId, outcome: 'recovered' });
  });

  it('works with no publisher at all', async () => {
    // The ingest tests run without a workflow engine, and must keep doing so.
    const r = await processEvent(ctx, FAILURE_SCENARIOS.card_expired());
    expect(r.outcome).toBe('diagnosed');
  });
});
