/**
 * The two human queues and the alert write path.
 *
 * Runs against PGlite, so the partial unique indexes are the real ones: the
 * open-alert-per-condition guard and the one-pending-proposal-per-reason guard
 * are enforced by Postgres here exactly as they will be in Supabase. A mock
 * would happily accept the duplicates these tests exist to reject.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type TestDb, createTestDb, schema, seedMerchant } from '../db/harness.js';
import { idempotencyKey } from '../../src/core/actions/types.js';
import {
  acknowledgeEscalation,
  closeEscalation,
  countOpenEscalations,
  createEscalation,
  listOpenEscalations,
} from '../../src/db/repos/escalations.js';
import {
  listPendingProposals,
  reviewProposal,
  upsertProposal,
} from '../../src/db/repos/proposals.js';
import { listOpenAlerts, raiseMerchantAlert, resolveMerchantAlert } from '../../src/db/repos/alerts.js';
import {
  getAiHealth,
  getEscalatedCaseIds,
  getOpenEscalations,
} from '../../src/db/queries/recovery.js';

let t: TestDb;
let merchantId: string;

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
      amountAtRiskPaise: 184_300,
      attended: true,
      method: 'card',
      errorReason: 'card_declined',
      causeClass: 'risk',
      ...over,
    })
    .returning({ id: schema.recoveryCases.id });
  return row!.id;
}

describe('the escalation queue', () => {
  it('queues a case and returns it in the open list', async () => {
    const caseId = await seedCase();

    const r = await createEscalation(t.db, {
      caseId,
      merchantId,
      queue: 'risk_review',
      rung: 1,
      idempotencyKey: idempotencyKey(caseId, {
        kind: 'escalate_to_human',
        rung: 1,
        queue: 'risk_review',
        note: '',
      }),
      headline: 'Rs 1,843 card case in risk needs review',
      whatHappened: 'The issuer declined at authorisation.',
      briefSource: 'claude',
      amountAtRiskPaise: 184_300,
      causeClass: 'risk',
    });

    expect(r.created).toBe(true);
    expect(r.id).not.toBeNull();

    const open = await listOpenEscalations(t.db, { merchantId });
    expect(open).toHaveLength(1);
    expect(open[0]?.queue).toBe('risk_review');
    expect(open[0]?.amountAtRiskPaise).toBe(184_300);
    expect(open[0]?.briefSource).toBe('claude');
  });

  /**
   * The guard that matters. A workflow replay after a deploy re-runs the rung,
   * and a second queue entry would put the same case in front of a person
   * twice — with a freshly generated brief that may not even agree with the
   * one they already read.
   */
  it('is idempotent on the rung, so a replay does not queue twice', async () => {
    const caseId = await seedCase();
    const key = idempotencyKey(caseId, {
      kind: 'escalate_to_human',
      rung: 2,
      queue: 'merchant_review',
      note: '',
    });

    const input = {
      caseId,
      merchantId,
      queue: 'merchant_review' as const,
      rung: 2,
      idempotencyKey: key,
      headline: 'first',
      briefSource: 'claude' as const,
      amountAtRiskPaise: 1_000,
    };

    const first = await createEscalation(t.db, input);
    const replay = await createEscalation(t.db, { ...input, headline: 'second' });

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.id).toBeNull();

    const open = await listOpenEscalations(t.db, { merchantId });
    expect(open).toHaveLength(1);
    // The brief a person is reading is not overwritten by a replay.
    expect(open[0]?.headline).toBe('first');
  });

  it('uses the same key format as the action row', async () => {
    const caseId = await seedCase();
    const action = {
      kind: 'escalate_to_human' as const,
      rung: 3,
      queue: 'risk_review' as const,
      note: '',
    };
    // The point of the assertion: the queue and the action ledger must collide
    // on the same string, or the duplicate guard is inert across the boundary
    // it exists to hold.
    expect(idempotencyKey(caseId, action)).toBe(`${caseId}:3:escalate_to_human`);
  });

  it('acknowledges, then closes, and drops out of the open list', async () => {
    const caseId = await seedCase();
    const { id } = await createEscalation(t.db, {
      caseId,
      merchantId,
      queue: 'ar_collections',
      rung: 0,
      idempotencyKey: `${caseId}:0:escalate_to_human`,
      headline: 'invoice overdue',
      briefSource: 'fallback',
      amountAtRiskPaise: 2_450_000,
    });

    expect(await acknowledgeEscalation(t.db, id!, 'shyam')).toBe(true);
    // Already acknowledged — the transition only fires from `open`.
    expect(await acknowledgeEscalation(t.db, id!, 'someone-else')).toBe(false);

    const stillOpen = await listOpenEscalations(t.db, { merchantId });
    expect(stillOpen).toHaveLength(1);
    expect(stillOpen[0]?.assignedTo).toBe('shyam');

    expect(await closeEscalation(t.db, id!, 'resolved', 'customer paid by NEFT')).toBe(true);
    expect(await listOpenEscalations(t.db, { merchantId })).toHaveLength(0);
    // Closing twice is not a second resolution.
    expect(await closeEscalation(t.db, id!, 'resolved', 'again')).toBe(false);
  });

  it('counts queue depth per queue', async () => {
    const a = await seedCase();
    const b = await seedCase({ rzpOrderId: 'order_b' });

    await createEscalation(t.db, {
      caseId: a,
      merchantId,
      queue: 'risk_review',
      rung: 0,
      idempotencyKey: `${a}:0:escalate_to_human`,
      headline: 'a',
      briefSource: 'fallback',
      amountAtRiskPaise: 1,
    });
    await createEscalation(t.db, {
      caseId: b,
      merchantId,
      queue: 'risk_review',
      rung: 0,
      idempotencyKey: `${b}:0:escalate_to_human`,
      headline: 'b',
      briefSource: 'fallback',
      amountAtRiskPaise: 1,
    });

    const depth = await countOpenEscalations(t.db, merchantId);
    expect(depth).toEqual([{ queue: 'risk_review', count: 2 }]);
  });
});

describe('taxonomy proposals', () => {
  const base = {
    rawErrorReason: 'vpa_frequency_limit_exceeded',
    proposedCauseClass: 'funds_limits' as const,
    confidence: 'medium',
    reasoning: 'Looks like an NPCI per-VPA velocity cap rather than a decline about this payer.',
    proposedRuleId: 'vpa_limit.upi',
    sameInstrumentRetrySafe: true,
    occurrences: 12,
    distinctMerchants: 3,
    eventuallyPaidCount: 7,
    firstSeenAt: new Date('2026-08-01T00:00:00Z'),
    lastSeenAt: new Date('2026-08-20T00:00:00Z'),
    evidence: [{ method: 'upi' }],
  };

  it('records a proposal as pending', async () => {
    await upsertProposal(t.db, base);

    const pending = await listPendingProposals(t.db);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.proposedCauseClass).toBe('funds_limits');
    expect(pending[0]?.sameInstrumentRetrySafe).toBe(true);
  });

  /**
   * The triage job runs repeatedly over a growing sample. A second run must
   * sharpen the open proposal, not stack a second one behind it — otherwise the
   * review queue fills with six versions of the same question.
   */
  it('refreshes the open proposal instead of stacking a second one', async () => {
    await upsertProposal(t.db, base);
    await upsertProposal(t.db, {
      ...base,
      occurrences: 48,
      confidence: 'high',
      reasoning: 'At four times the sample the velocity-cap reading holds.',
    });

    const pending = await listPendingProposals(t.db);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.occurrences).toBe(48);
    expect(pending[0]?.confidence).toBe('high');
  });

  /**
   * A rejected proposal must not block a fresh one. The same string at ten
   * times the volume can genuinely look different, and the partial index is
   * scoped to `status = 'pending'` precisely so that re-proposal is possible.
   */
  it('allows a new proposal once the old one has been reviewed', async () => {
    await upsertProposal(t.db, base);
    const [first] = await listPendingProposals(t.db);

    expect(await reviewProposal(t.db, first!.id, 'rejected', 'shyam', 'too few samples')).toBe(true);
    expect(await listPendingProposals(t.db)).toHaveLength(0);

    await upsertProposal(t.db, { ...base, occurrences: 300, confidence: 'high' });
    const pending = await listPendingProposals(t.db);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.occurrences).toBe(300);

    // Reviewing an already-reviewed proposal is not a second decision.
    expect(await reviewProposal(t.db, first!.id, 'accepted', 'shyam', 'changed my mind')).toBe(false);
  });
});

describe('merchant alerts', () => {
  const signal = 'bank_not_enabled:ICIC:netbanking';

  it('raises an alert the dashboard can read', async () => {
    await raiseMerchantAlert(t.db, {
      merchantId,
      signal,
      severity: 'critical',
      title: 'ICICI netbanking is not enabled on your account',
      detail: '12 cases worth Rs 48,000 have failed since 09:14.',
      affectedCases: 12,
      amountAtRiskPaise: 4_800_000,
      onsetAt: new Date('2026-08-30T09:14:00Z'),
    });

    const open = await listOpenAlerts(t.db, merchantId);
    expect(open).toHaveLength(1);
    expect(open[0]?.severity).toBe('critical');
    expect(open[0]?.affectedCases).toBe(12);
  });

  /**
   * The reason the signal is a structured key and not a sentence: a condition
   * that is still broken has to accumulate into ONE row. An alert whose
   * identity changed with its wording would page once per case, during exactly
   * the incident where that is least welcome.
   */
  it('accumulates a still-broken condition into one row, keeping the original onset', async () => {
    const onset = new Date('2026-08-30T09:14:00Z');

    await raiseMerchantAlert(t.db, {
      merchantId,
      signal,
      severity: 'warning',
      title: 'first',
      affectedCases: 3,
      amountAtRiskPaise: 100,
      onsetAt: onset,
    });
    await raiseMerchantAlert(t.db, {
      merchantId,
      signal,
      severity: 'critical',
      title: 'second',
      affectedCases: 47,
      amountAtRiskPaise: 320_000,
      onsetAt: new Date('2026-08-30T13:00:00Z'),
    });

    const open = await listOpenAlerts(t.db, merchantId);
    expect(open).toHaveLength(1);
    // Counts and prose refresh...
    expect(open[0]?.affectedCases).toBe(47);
    expect(open[0]?.title).toBe('second');
    expect(open[0]?.severity).toBe('critical');
    // ...but "when did this start" is not overwritten by "when did we last look".
    expect(open[0]?.onsetAt.toISOString()).toBe(onset.toISOString());
  });

  it('lets a resolved condition raise a fresh alert if it recurs', async () => {
    const raise = () =>
      raiseMerchantAlert(t.db, {
        merchantId,
        signal,
        severity: 'warning',
        title: 'broken',
        affectedCases: 1,
        amountAtRiskPaise: 1,
        onsetAt: new Date(),
      });

    await raise();
    expect(await resolveMerchantAlert(t.db, merchantId, signal)).toBe(true);
    expect(await listOpenAlerts(t.db, merchantId)).toHaveLength(0);

    await raise();
    expect(await listOpenAlerts(t.db, merchantId)).toHaveLength(1);
  });
});

/**
 * What the console reads.
 *
 * The CLI-only version of this queue was invisible from the product, which is
 * the same failure one layer up as the `case_actions` row nobody read. These
 * back the "Needs a person" panel and its filter.
 */
describe('the console view of the queue', () => {
  async function escalate(over: Partial<Parameters<typeof createEscalation>[1]> = {}) {
    const caseId = await seedCase();
    await createEscalation(t.db, {
      caseId,
      merchantId,
      queue: 'risk_review',
      rung: 0,
      idempotencyKey: `${caseId}:0:escalate_to_human`,
      headline: 'needs a look',
      briefSource: 'claude',
      amountAtRiskPaise: 184_300,
      causeClass: 'risk',
      ...over,
    });
    return caseId;
  }

  it('returns open escalations with the brief and its provenance', async () => {
    await escalate({
      whatHappened: 'The issuer declined at authorisation.',
      recommendedAction: 'Consider closing — a second attempt raises the risk score.',
      briefConfidence: 'high',
    });

    const rows = await getOpenEscalations(t.db, merchantId);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.whatHappened).toContain('issuer');
    expect(rows[0]?.recommendedAction).toContain('risk score');
    // The field the panel leads with: a queue that is all `fallback` is a
    // broken integration, and it would otherwise look identical to a working one.
    expect(rows[0]?.briefSource).toBe('claude');
    expect(rows[0]?.briefConfidence).toBe('high');
  });

  it('drops an escalation from the console once it is closed', async () => {
    await escalate();
    const [open] = await getOpenEscalations(t.db, merchantId);
    await closeEscalation(t.db, open!.id, 'resolved', 'done');

    expect(await getOpenEscalations(t.db, merchantId)).toHaveLength(0);
    expect(await getEscalatedCaseIds(t.db, merchantId)).toEqual([]);
  });

  it('lists the case ids behind the "Needs a person" filter', async () => {
    const a = await escalate();
    await seedCase({ rzpOrderId: 'not_escalated' });

    const ids = await getEscalatedCaseIds(t.db, merchantId);
    expect(ids).toEqual([a]);
  });

  it('does not leak another merchant’s escalations into the console', async () => {
    const other = await seedMerchant(t.db);
    await escalate();

    expect(await getOpenEscalations(t.db, other)).toHaveLength(0);
    expect(await getEscalatedCaseIds(t.db, other)).toEqual([]);
  });

  /**
   * Every Claude job fails soft: an unreachable model, an expired key, a
   * rejected schema and a validation failure all end in the same fallback and
   * the queue entry still appears. This count is the only thing that
   * distinguishes a working integration from a dead one without calling the API.
   */
  it('counts written briefs against fallbacks, and carries the last error', async () => {
    await escalate({ briefSource: 'claude' });
    await escalate({ briefSource: 'fallback', briefError: 'not_configured: no key' });
    await escalate({ briefSource: 'fallback', briefError: '400: schema rejected' });

    const health = await getAiHealth(t.db, merchantId);

    expect(health.briefsByClaude).toBe(1);
    expect(health.briefsByFallback).toBe(2);
    // The difference between "no key" and "bad request", which look identical
    // from anywhere else in the UI.
    expect(health.lastError).toBeTruthy();
    expect(health.lastWrittenAt).not.toBeNull();
  });

  it('reports zeroes rather than failing when nothing has escalated', async () => {
    const health = await getAiHealth(t.db, merchantId);
    expect(health.briefsByClaude).toBe(0);
    expect(health.briefsByFallback).toBe(0);
    expect(health.lastError).toBeNull();
    expect(health.lastWrittenAt).toBeNull();
  });
});
