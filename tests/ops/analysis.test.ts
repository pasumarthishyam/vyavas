/**
 * The two offline analyses: the ledger self-audit and unknown-reason triage.
 *
 * These run hand-written SQL — CTEs, `distinct on`, aggregate filters, array
 * slices — so the tests exist mostly to prove the queries execute and COUNT
 * CORRECTLY against real Postgres. Both are exercised here with the model
 * skipped: what is under test is the arithmetic, not the prose.
 *
 * The double-counting case is the one that matters most. A single case emits a
 * `rung_deferred` event every time its gate says "not right now" — a dozen is
 * ordinary — and summing `amount_at_risk_paise` across events rather than
 * across cases would report twelve times the money at risk. A report that
 * overstates the loss is worse than no report, because somebody will act on it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type TestDb, createTestDb, schema, seedMerchant } from '../db/harness.js';
import { gatherAuditFacts, runSelfAudit } from '../../src/ops/self-audit.js';
import { findUnknownReasons, sampleUnknownReason } from '../../src/ops/triage.js';

let t: TestDb;
let merchantId: string;

const NOW = new Date('2026-08-31T12:00:00Z');

beforeEach(async () => {
  t = await createTestDb();
  merchantId = await seedMerchant(t.db);
});

afterEach(async () => {
  await t.close();
});

async function seedCase(over: Partial<typeof schema.recoveryCases.$inferInsert> = {}) {
  const [row] = await t.db
    .insert(schema.recoveryCases)
    .values({
      merchantId,
      type: 'payment_failure',
      amountAtRiskPaise: 100_000,
      attended: true,
      method: 'card',
      ...over,
    })
    .returning({ id: schema.recoveryCases.id });
  return row!.id;
}

async function seedEvent(caseId: string, kind: string, reason?: string, note?: string) {
  await t.db.insert(schema.caseEvents).values({
    caseId,
    merchantId,
    kind,
    reason: reason ?? null,
    actor: 'workflow',
    payload: note ? ({ note } as never) : null,
  });
}

async function seedMessage(caseId: string, customerId: string) {
  await t.db.insert(schema.messageLog).values({
    merchantId,
    customerId,
    caseId,
    channel: 'whatsapp',
    intent: 'switch_method',
    idempotencyKey: `${caseId}:0:nudge:${Math.random()}`,
  });
}

describe('the ledger self-audit', () => {
  it('counts lost cases and the subset that sent nothing', async () => {
    const [customer] = await t.db
      .insert(schema.customers)
      .values({ merchantId, phone: '+919800000001' })
      .returning({ id: schema.customers.id });

    // Lost with no message at all — the expensive subset this job exists for.
    await seedCase({ state: 'lost', amountAtRiskPaise: 400_000 });
    const messaged = await seedCase({ state: 'lost', amountAtRiskPaise: 100_000 });
    await seedCase({ state: 'recovered', amountAtRiskPaise: 999_999 });

    await seedMessage(messaged, customer!.id);

    const facts = await gatherAuditFacts({ db: t.db, now: NOW, windowDays: 7 });

    expect(facts.totalCasesInWindow).toBe(3);
    expect(facts.totalLostCases).toBe(2);
    expect(facts.lostAmount).toBe(500_000);
    // Only the one with no unsuppressed message in the ledger.
    expect(facts.lostWithNoMessage).toBe(1);
    expect(facts.lostWithNoMessageAmount).toBe(400_000);
  });

  /**
   * The arithmetic this whole design exists to protect.
   *
   * One case, twelve deferrals. The bucket must report one case and its amount
   * once — not twelve cases and twelve times the money.
   */
  it('counts each case once per bucket however many events it emitted', async () => {
    const caseId = await seedCase({ state: 'lost', amountAtRiskPaise: 250_000 });
    for (let i = 0; i < 12; i++) {
      await seedEvent(caseId, 'rung_deferred', 'within_frequency_cap');
    }

    const facts = await gatherAuditFacts({ db: t.db, now: NOW, windowDays: 7 });
    const bucket = facts.buckets.find((b) => b.kind === 'rung_deferred');

    expect(bucket).toBeDefined();
    expect(bucket!.caseCount).toBe(1);
    expect(bucket!.amountAtRisk).toBe(250_000);
    expect(bucket!.casesWithNoMessage).toBe(1);
    expect(bucket!.distinctMerchants).toBe(1);
  });

  it('separates buckets by reason and ranks them by money', async () => {
    const cheap = await seedCase({ state: 'lost', amountAtRiskPaise: 10_000 });
    const dear = await seedCase({ state: 'lost', amountAtRiskPaise: 900_000 });

    await seedEvent(cheap, 'rung_aborted', 'order_unpaid');
    await seedEvent(dear, 'rung_uncomposable', 'missing_payment_link', 'no link was created');

    const facts = await gatherAuditFacts({ db: t.db, now: NOW, windowDays: 7 });

    expect(facts.buckets).toHaveLength(2);
    // Ordered by amount, so the expensive defect leads.
    expect(facts.buckets[0]?.kind).toBe('rung_uncomposable');
    expect(facts.buckets[0]?.reason).toBe('missing_payment_link');
    expect(facts.buckets[0]?.sampleNotes).toContain('no link was created');
    expect(facts.buckets[0]?.sampleCaseIds).toContain(dear);
    expect(facts.buckets[1]?.kind).toBe('rung_aborted');
  });

  it('ignores event kinds that are not failures', async () => {
    const caseId = await seedCase({ state: 'lost' });
    await seedEvent(caseId, 'rung_fired');
    await seedEvent(caseId, 'diagnosed');

    const facts = await gatherAuditFacts({ db: t.db, now: NOW, windowDays: 7 });
    expect(facts.buckets).toHaveLength(0);
  });

  it('scopes to one merchant when asked', async () => {
    const other = await seedMerchant(t.db);
    const mine = await seedCase({ state: 'lost' });

    const [theirs] = await t.db
      .insert(schema.recoveryCases)
      .values({
        merchantId: other,
        type: 'payment_failure',
        amountAtRiskPaise: 1,
        attended: true,
        state: 'lost',
      })
      .returning({ id: schema.recoveryCases.id });

    await seedEvent(mine, 'rung_abandoned', 'deferral_limit');
    await t.db.insert(schema.caseEvents).values({
      caseId: theirs!.id,
      merchantId: other,
      kind: 'rung_abandoned',
      reason: 'deferral_limit',
      actor: 'workflow',
    });

    const scoped = await gatherAuditFacts({ db: t.db, now: NOW, windowDays: 7, merchantId });
    expect(scoped.totalCasesInWindow).toBe(1);
    expect(scoped.buckets[0]?.caseCount).toBe(1);

    const all = await gatherAuditFacts({ db: t.db, now: NOW, windowDays: 7 });
    expect(all.buckets[0]?.caseCount).toBe(2);
    expect(all.buckets[0]?.distinctMerchants).toBe(2);
  });

  /**
   * With no key configured — the state of a fresh clone — the audit must still
   * produce a usable report rather than throwing. The fallback is what ships
   * whenever the model is unavailable, so it is a supported path, not a stub.
   */
  it('returns a deterministic report when the analysis is skipped', async () => {
    const caseId = await seedCase({ state: 'lost', amountAtRiskPaise: 700_000 });
    // `rung_uncomposable`, not `no_channel`: only the four kinds `appendEvent`
    // actually writes can ever reach a bucket. This test used the latter and so
    // asserted on a bucket the query could never produce.
    await seedEvent(caseId, 'rung_uncomposable', 'missing_payment_link');

    const outcome = await runSelfAudit({ db: t.db, now: NOW, windowDays: 7, skipAnalysis: true });

    expect(outcome.source).toBe('fallback');
    expect(outcome.report.findings).toHaveLength(1);
    expect(outcome.report.findings[0]?.affectedCases).toBe(1);
    expect(outcome.report.summary).toContain('lost');
    // The one kind that cannot happen during correct operation, so the fallback
    // may call it a defect without a model.
    expect(outcome.report.findings[0]?.kind).toBe('defect');
  });

  it('handles an empty window without inventing buckets', async () => {
    const facts = await gatherAuditFacts({ db: t.db, now: NOW, windowDays: 7 });
    expect(facts.totalCasesInWindow).toBe(0);
    expect(facts.buckets).toEqual([]);
  });
});

describe('unknown-reason triage', () => {
  const seedUnknown = (raw: string, over: Partial<typeof schema.recoveryCases.$inferInsert> = {}) =>
    seedCase({ errorReason: 'unknown_reason', rawErrorReason: raw, confidence: 'low', ...over });

  it('groups unknown reasons and counts eventual payment', async () => {
    await seedUnknown('vpa_frequency_limit_exceeded', { method: 'upi' });
    await seedUnknown('vpa_frequency_limit_exceeded', { method: 'upi', state: 'recovered' });
    await seedUnknown('vpa_frequency_limit_exceeded', { method: 'upi' });

    const groups = await findUnknownReasons(t.db);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.rawErrorReason).toBe('vpa_frequency_limit_exceeded');
    expect(groups[0]?.occurrences).toBe(3);
    expect(groups[0]?.eventuallyPaidCount).toBe(1);
    expect(groups[0]?.distinctMerchants).toBe(1);
  });

  /**
   * Two occurrences is not a pattern. A model asked to classify a string it has
   * seen twice will write a confident paragraph anyway, and a reviewer will
   * read it — so the floor is enforced before the model is ever called.
   */
  it('ignores reasons below the occurrence floor', async () => {
    await seedUnknown('seen_twice_only');
    await seedUnknown('seen_twice_only');

    expect(await findUnknownReasons(t.db)).toHaveLength(0);
  });

  it('ignores reasons the taxonomy already knows', async () => {
    for (let i = 0; i < 5; i++) {
      await seedCase({ errorReason: 'card_expired', causeClass: 'instrument_dead' });
    }
    expect(await findUnknownReasons(t.db)).toHaveLength(0);
  });

  it('samples the tuple space behind one reason', async () => {
    await seedUnknown('gateway_shrugged', { method: 'upi', errorSource: 'gateway', bank: 'HDFC' });
    await seedUnknown('gateway_shrugged', { method: 'card', errorSource: 'issuer' });
    await seedUnknown('gateway_shrugged', { method: 'upi', state: 'recovered' });

    const samples = await sampleUnknownReason(t.db, 'gateway_shrugged');

    expect(samples).toHaveLength(3);
    expect(samples.map((s) => s.method).sort()).toEqual(['card', 'upi', 'upi']);
    expect(samples.filter((s) => s.eventuallyPaid)).toHaveLength(1);
    expect(samples.some((s) => s.bank === 'HDFC')).toBe(true);
  });

  it('orders groups by how often they occur', async () => {
    for (let i = 0; i < 3; i++) await seedUnknown('rare_thing');
    for (let i = 0; i < 9; i++) await seedUnknown('common_thing');

    const groups = await findUnknownReasons(t.db);
    expect(groups.map((g) => g.rawErrorReason)).toEqual(['common_thing', 'rare_thing']);
  });
});
