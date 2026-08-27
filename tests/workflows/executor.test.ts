/**
 * Rung execution, against real Postgres.
 *
 * This is the only place in the system where an action becomes a real thing in
 * the world, so the tests are about what must NOT happen: no send to someone who
 * paid, no second send on a replay, no rail the diagnosis withdrew, and — for
 * the whole of Stage 6 — no send at all.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { executeRung } from '../../src/workflows/executor.js';
import { gatherFacts } from '../../src/workflows/facts.js';
import { POLICY_TABLE } from '../../src/core/policy/index.js';
import type { PolicyRow } from '../../src/core/policy/schema.js';
import { createTestDb, schema, seedCustomer, seedMerchant, type TestDb } from '../db/harness.js';

const NOW = new Date('2026-08-27T14:10:00.000Z'); // 19:40 IST — not quiet hours

let t: TestDb;
let merchantId: string;
let customerId: string;
let caseId: string;

const policy = (): PolicyRow =>
  POLICY_TABLE.find((p) => p.id === 'instrument_dead.card_expired')!;

beforeEach(async () => {
  t = await createTestDb();
  merchantId = await seedMerchant(t.db, { executionEnabled: true, dryRun: true });
  customerId = await seedCustomer(t.db, merchantId);

  const [c] = await t.db
    .insert(schema.recoveryCases)
    .values({
      merchantId,
      customerId,
      type: 'payment_failure',
      state: 'executing',
      amountAtRiskPaise: 184_300,
      rzpOrderId: 'order_EXEC',
      causeClass: 'instrument_dead',
      errorReason: 'card_expired',
      method: 'card',
      attended: true,
      policyId: 'instrument_dead.card_expired',
      policyVersion: 1,
      deadlineAt: new Date(NOW.getTime() + 86_400_000),
    })
    .returning({ id: schema.recoveryCases.id });
  caseId = c!.id;
});

afterEach(async () => {
  await t.close();
});

async function fire(over: { rungIndex?: number; cohort?: 'treatment' | 'holdout'; rails?: string[]; retry?: boolean } = {}) {
  const gathered = await gatherFacts({ db: t.db, caseId, now: NOW });
  return executeRung({
    db: t.db,
    caseId,
    merchantId,
    rungIndex: over.rungIndex ?? 0,
    rung: policy().ladder[over.rungIndex ?? 0]!,
    policy: policy(),
    gathered: gathered!,
    cohort: over.cohort ?? 'treatment',
    diagnosisRails: (over.rails ?? ['upi_intent', 'other_card']) as never,
    sameInstrumentRetry: over.retry ?? false,
  });
}

describe('nothing is sent in Stage 6', () => {
  it('plans and records the rung but suppresses the send', async () => {
    const r = await fire();
    expect(r.disposition).toBe('suppressed');
    expect(r.action?.kind).toBe('nudge');
    expect(r.channel).toBe('whatsapp');

    const [action] = await t.db.select().from(schema.caseActions);
    expect(action!.status).toBe('suppressed');
    expect(action!.skipReason).toBe('dry_run');
  });

  it('writes a message-log row so the two cohorts stay comparable', async () => {
    await fire();
    const [msg] = await t.db.select().from(schema.messageLog);
    expect(msg!.suppressedReason).toBe('dry_run');
    expect(msg!.status).toBe('suppressed');
    expect(msg!.channel).toBe('whatsapp');
  });

  it('distinguishes holdout from dry-run', async () => {
    // Not the same thing: a dry-run case is one we never treated, a holdout is
    // a real control. Collapsing them makes the incrementality report a guess.
    const r = await fire({ cohort: 'holdout' });
    expect(r.suppressedReason).toBe('holdout');
  });

  it('marks it not_built once the merchant is live but the channels are not', async () => {
    await t.db
      .update(schema.merchants)
      .set({ dryRun: false })
      .where(eq(schema.merchants.id, merchantId));
    const r = await fire();
    expect(r.suppressedReason).toBe('not_built');
  });
});

describe('the gate runs before anything else', () => {
  it('aborts rather than sending when the order has been paid', async () => {
    await t.db
      .update(schema.recoveryCases)
      .set({ state: 'recovered' })
      .where(eq(schema.recoveryCases.id, caseId));

    const r = await fire();
    expect(r.disposition).toBe('aborted');
    expect(await t.db.select().from(schema.messageLog)).toHaveLength(0);
    expect(await t.db.select().from(schema.caseActions)).toHaveLength(0);
  });

  it('aborts for an opted-out customer', async () => {
    await t.db
      .update(schema.customers)
      .set({ optedOutAt: NOW })
      .where(eq(schema.customers.id, customerId));
    const r = await fire();
    expect(r.disposition).toBe('aborted');
    expect(await t.db.select().from(schema.messageLog)).toHaveLength(0);
  });

  it('aborts when the merchant kill switch is off', async () => {
    await t.db
      .update(schema.merchants)
      .set({ executionEnabled: false })
      .where(eq(schema.merchants.id, merchantId));
    const r = await fire();
    expect(r.disposition).toBe('aborted');
    expect(r.gate.failed).toBe('execution_disabled');
  });

  it('defers rather than interrupting a live attempt', async () => {
    await t.db.insert(schema.paymentAttempts).values({
      merchantId,
      rzpOrderId: 'order_EXEC',
      rzpPaymentId: 'pay_live',
      amountPaise: 184_300,
      attemptedAt: new Date(NOW.getTime() - 30_000),
    });

    const r = await fire();
    expect(r.disposition).toBe('deferred');
    expect(r.retryAt).not.toBeNull();
    // Deferred, not aborted: someone mid-retry is the most recoverable
    // customer there is.
    expect(await t.db.select().from(schema.messageLog)).toHaveLength(0);
  });

  it('gates a holdout case identically to a treatment case', async () => {
    // If the two cohorts were gated differently they would not be comparable,
    // and the incrementality number would measure the gate rather than the
    // treatment.
    await t.db
      .update(schema.recoveryCases)
      .set({ state: 'recovered' })
      .where(eq(schema.recoveryCases.id, caseId));
    const r = await fire({ cohort: 'holdout' });
    expect(r.disposition).toBe('aborted');
  });
});

describe('idempotency', () => {
  it('records a replayed rung once', async () => {
    const first = await fire();
    const second = await fire();

    expect(first.disposition).toBe('suppressed');
    expect(second.disposition).toBe('skipped');
    expect(second.note).toContain('replay');

    expect(await t.db.select().from(schema.caseActions)).toHaveLength(1);
    expect(await t.db.select().from(schema.messageLog)).toHaveLength(1);
  });

  it('keeps separate rungs separate', async () => {
    await fire({ rungIndex: 0 });
    await fire({ rungIndex: 1 });
    expect(await t.db.select().from(schema.caseActions)).toHaveLength(2);
  });
});

describe('the diagnosis overrules the policy table', () => {
  it('strips a rail the diagnosis withdrew', async () => {
    // `instrument_dead.card_expired` offers upi_intent and other_card, and the
    // class forbids re-presenting — so retry_same must never survive even if a
    // caller passes it in.
    const r = await fire({ rails: ['upi_intent', 'retry_same'], retry: false });
    expect(r.action?.kind).toBe('nudge');
    if (r.action?.kind === 'nudge') {
      expect(r.action.suggest).not.toContain('retry_same');
    }
  });

  it('honours the rung suggestion when the diagnosis still permits it', async () => {
    const r = await fire({ rails: ['upi_intent'], retry: true });
    if (r.action?.kind === 'nudge') {
      expect(r.action.suggest.length).toBeGreaterThan(0);
    }
  });
});

describe('channel selection', () => {
  it('falls through to the next consented channel', async () => {
    await t.db
      .update(schema.customers)
      .set({ whatsappOptIn: false })
      .where(eq(schema.customers.id, customerId));
    const r = await fire();
    expect(r.channel).toBe('sms');
  });

  it('aborts when the customer has consented to nothing', async () => {
    await t.db
      .update(schema.customers)
      .set({ whatsappOptIn: false, smsOptIn: false, emailOptIn: false })
      .where(eq(schema.customers.id, customerId));
    const r = await fire();
    expect(r.disposition).toBe('aborted');
    expect(r.gate.failed).toBe('channel_deliverable');
  });

  it('falls through to a later rung that offers a deliverable channel', async () => {
    // The phone is dead, so rung 0 (whatsapp, sms) has nothing to use. Rung 2
    // offers email, which the customer can still receive.
    await t.db
      .update(schema.customers)
      .set({ phoneUndeliverableAt: NOW })
      .where(eq(schema.customers.id, customerId));

    const blocked = await fire({ rungIndex: 0 });
    expect(blocked.disposition).toBe('skipped');
    expect(blocked.note).toContain('no eligible channel');

    const sent = await fire({ rungIndex: 2 });
    expect(sent.channel).toBe('email');
    expect(sent.disposition).toBe('suppressed');
  });

  it('does not record an action for a rung it could not deliver', async () => {
    // A skipped rung must leave no trace that looks like a send — the dry-run
    // report would otherwise claim a message that never had a channel.
    await t.db
      .update(schema.customers)
      .set({ phoneUndeliverableAt: NOW })
      .where(eq(schema.customers.id, customerId));
    await fire({ rungIndex: 0 });
    expect(await t.db.select().from(schema.caseActions)).toHaveLength(0);
    expect(await t.db.select().from(schema.messageLog)).toHaveLength(0);
  });
});

describe('the ledger', () => {
  it('records what would have been said, for the dry-run report', async () => {
    await fire();
    const events = await t.db
      .select()
      .from(schema.caseEvents)
      .where(eq(schema.caseEvents.caseId, caseId));

    const fired = events.find((e) => e.kind === 'rung_fired');
    expect(fired).toBeDefined();
    const payload = fired!.payload as Record<string, unknown>;
    expect(payload.action).toBe('nudge');
    expect(payload.intent).toBe('switch_method');
    expect(payload.suppressedReason).toBe('dry_run');
  });

  it('advances the case rung counter', async () => {
    await fire({ rungIndex: 1 });
    const [c] = await t.db
      .select()
      .from(schema.recoveryCases)
      .where(eq(schema.recoveryCases.id, caseId));
    expect(c!.currentRung).toBe(1);
    expect(c!.messagesSent).toBe(1);
  });
});
