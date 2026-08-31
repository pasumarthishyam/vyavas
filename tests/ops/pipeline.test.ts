/**
 * Escalating and alerting, end to end, with the model skipped.
 *
 * What is under test is the part that must never depend on Claude: the facts
 * are gathered, the fallback is used, and the row is written. If the model is
 * unreachable the queue entry and the alert still exist — the prose is the
 * improvement, the row is the fix.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { type TestDb, createTestDb, schema, seedMerchant } from '../db/harness.js';
import { escalateCase, gatherBriefFacts } from '../../src/ops/escalation.js';
import { alertSignal, gatherAlertFacts, raiseAlertForCluster } from '../../src/ops/merchant-alert.js';
import { listOpenEscalations } from '../../src/db/repos/escalations.js';
import { listOpenAlerts } from '../../src/db/repos/alerts.js';

let t: TestDb;
let merchantId: string;

const NOW = new Date('2026-08-31T12:00:00Z');

beforeEach(async () => {
  t = await createTestDb();
  merchantId = await seedMerchant(t.db, { name: 'Kirana Cloud' });
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
      amountAtRiskPaise: 184_300,
      attended: true,
      method: 'card',
      bank: 'HDFC',
      errorReason: 'payment_risk_check_failed',
      errorSource: 'issuer',
      causeClass: 'risk',
      confidence: 'high',
      policyId: 'risk.payment_risk_check_failed',
      diagnosisRationale: ['The issuer declined at authorisation.'] as never,
      ...over,
    })
    .returning({ id: schema.recoveryCases.id });
  return row!.id;
}

describe('escalateCase', () => {
  it('gathers the case, the rationale and the ledger', async () => {
    const caseId = await seedCase();
    await t.db.insert(schema.caseEvents).values([
      { caseId, merchantId, kind: 'detected', actor: 'webhook' },
      { caseId, merchantId, kind: 'rung_fired', actor: 'workflow', payload: { note: 'nudge' } as never },
    ]);

    const facts = await gatherBriefFacts({
      db: t.db,
      caseId,
      queue: 'risk_review',
      policyNote: 'Puts the case in front of a person, quietly.',
      now: NOW,
    });

    expect(facts).not.toBeNull();
    expect(facts!.merchantName).toBe('Kirana Cloud');
    expect(facts!.causeClass).toBe('risk');
    expect(facts!.diagnosisRationale).toEqual(['The issuer declined at authorisation.']);
    expect(facts!.ledger).toHaveLength(2);
    expect(facts!.ledger[1]?.note).toBe('nudge');
  });

  it('writes the queue row using the fallback when the brief is skipped', async () => {
    const caseId = await seedCase();

    const r = await escalateCase({
      db: t.db,
      caseId,
      merchantId,
      queue: 'risk_review',
      rung: 1,
      idempotencyKey: `${caseId}:1:escalate_to_human`,
      policyNote: 'Not a customer touch.',
      now: NOW,
      skipBrief: true,
    });

    expect(r.created).toBe(true);
    expect(r.briefSource).toBe('fallback');

    /*
     * The audit trail entry, written by `escalateCase` itself.
     *
     * It used to be written by the executor at the call site, so the ladder's
     * escalations reached the trail and the console script's did not — a manual
     * escalation created a queue entry and a Claude call the trail had no
     * record of.
     */
    const events = await t.db
      .select()
      .from(schema.caseEvents)
      .where(eq(schema.caseEvents.caseId, caseId));
    const escalatedEvent = events.find((e) => e.kind === 'escalated');

    expect(escalatedEvent, 'no audit event was written').toBeDefined();
    expect(escalatedEvent?.actor).toBe('workflow');
    expect((escalatedEvent?.payload as Record<string, unknown>)?.briefSource).toBe('fallback');

    const open = await listOpenEscalations(t.db, { merchantId });
    expect(open).toHaveLength(1);
    expect(open[0]?.headline).toContain('risk');
    expect(open[0]?.amountAtRiskPaise).toBe(184_300);
    expect(open[0]?.causeClass).toBe('risk');
    // The reason for the terse brief is recorded, so a week of nothing but
    // fallbacks is discoverable rather than merely disappointing.
    expect(open[0]?.whatIsBlocking).toBe('Not a customer touch.');
  });

  it('reports a vanished case instead of throwing', async () => {
    const r = await escalateCase({
      db: t.db,
      caseId: '00000000-0000-0000-0000-000000000000',
      merchantId,
      queue: 'merchant_review',
      rung: 0,
      idempotencyKey: 'nope:0:escalate_to_human',
      policyNote: null,
      now: NOW,
      skipBrief: true,
    });

    expect(r.created).toBe(false);
    expect(r.briefError).toBe('case not found');
  });

  /**
   * A busy case can carry a hundred near-identical `rung_deferred` rows. The
   * window is taken from BOTH ends — the oldest events explain the case, the
   * newest explain why it stopped, and the middle is the part that repeats.
   */
  it('keeps both ends of a long ledger', async () => {
    const caseId = await seedCase();
    await t.db.insert(schema.caseEvents).values(
      Array.from({ length: 60 }, (_, i) => ({
        caseId,
        merchantId,
        kind: i === 0 ? 'detected' : i === 59 ? 'ladder_complete' : 'rung_deferred',
        actor: 'workflow',
      })),
    );

    const facts = await gatherBriefFacts({
      db: t.db,
      caseId,
      queue: 'risk_review',
      policyNote: null,
      now: NOW,
    });

    expect(facts!.ledger.length).toBeLessThan(60);
    expect(facts!.ledger[0]?.kind).toBe('detected');
    expect(facts!.ledger.at(-1)?.kind).toBe('ladder_complete');
  });
});

describe('raiseAlertForCluster', () => {
  const key = {
    causeClass: 'merchant_config' as const,
    errorReason: 'bank_not_enabled',
    bank: 'ICIC',
    method: 'netbanking',
  };

  const seedFailures = (n: number, over: Partial<typeof schema.recoveryCases.$inferInsert> = {}) =>
    Promise.all(
      Array.from({ length: n }, () =>
        seedCase({
          method: 'netbanking',
          bank: 'ICIC',
          errorReason: 'bank_not_enabled',
          causeClass: 'merchant_config',
          amountAtRiskPaise: 100_000,
          ...over,
        }),
      ),
    );

  it('builds a stable signal key', () => {
    expect(alertSignal(key)).toBe('bank_not_enabled:ICIC:netbanking');
    expect(alertSignal({ ...key, bank: null })).toBe('bank_not_enabled:all:netbanking');
  });

  it('counts the cluster and excludes money that already arrived', async () => {
    await seedFailures(5);
    await seedFailures(2, { state: 'recovered' });

    const facts = await gatherAlertFacts({ db: t.db, key: { merchantId, ...key }, now: NOW });

    expect(facts).not.toBeNull();
    // Recovered cases are not at risk, and counting them would overstate the
    // loss to a merchant who can check.
    expect(facts!.affectedCases).toBe(5);
    expect(facts!.amountAtRisk).toBe(500_000);
    expect(facts!.sampleRationale).toEqual(['The issuer declined at authorisation.']);
  });

  it('raises an alert a merchant can act on', async () => {
    await seedFailures(47);

    const outcome = await raiseAlertForCluster({
      db: t.db,
      key: { merchantId, ...key },
      severity: 'critical',
      now: NOW,
      skipProse: true,
    });

    expect(outcome.raised).toBe(true);
    expect(outcome.affectedCases).toBe(47);
    expect(outcome.proseSource).toBe('fallback');

    const alerts = await listOpenAlerts(t.db, merchantId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.signal).toBe('bank_not_enabled:ICIC:netbanking');
    expect(alerts[0]?.affectedCases).toBe(47);
    expect(alerts[0]?.amountAtRiskPaise).toBe(4_700_000);
    // Severity comes from the policy rung, never from the prose generator.
    expect(alerts[0]?.severity).toBe('critical');
  });

  /**
   * The alert fires on a PATTERN. One case failing is a case, not a breakage,
   * and an alert per case is how a merchant learns to filter the alerts.
   */
  it('raises nothing when there is no cluster', async () => {
    const outcome = await raiseAlertForCluster({
      db: t.db,
      key: { merchantId, ...key },
      severity: 'warning',
      now: NOW,
      skipProse: true,
    });

    expect(outcome.raised).toBe(false);
    expect(outcome.affectedCases).toBe(0);
    expect(await listOpenAlerts(t.db, merchantId)).toHaveLength(0);
  });

  it('says so in the detail when the prose was written without the model', async () => {
    await seedFailures(3);

    await raiseAlertForCluster({
      db: t.db,
      key: { merchantId, ...key },
      severity: 'warning',
      now: NOW,
      skipProse: true,
    });

    const [alert] = await listOpenAlerts(t.db, merchantId);
    expect(alert?.detail).toContain('Written without analysis');
  });

  it('does not count another merchant’s failures into this cluster', async () => {
    const other = await seedMerchant(t.db);
    await seedFailures(2);
    await t.db.insert(schema.recoveryCases).values({
      merchantId: other,
      type: 'payment_failure',
      amountAtRiskPaise: 999_999,
      attended: true,
      method: 'netbanking',
      bank: 'ICIC',
      errorReason: 'bank_not_enabled',
      causeClass: 'merchant_config',
    });

    const facts = await gatherAlertFacts({ db: t.db, key: { merchantId, ...key }, now: NOW });
    expect(facts!.affectedCases).toBe(2);
  });
});
