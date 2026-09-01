/**
 * Fanout: one rung, one gate decision, both channels.
 *
 * The `customer_input` class is belt-and-braces by design — the customer is
 * looking at a failed checkout, so they get WhatsApp AND the same link in their
 * inbox while they still care. Expressed as two rungs that never worked: the
 * second rung is a SECOND GATE EVALUATION, and the live-attempt lock and the
 * cool-off both apply again, so the "pair" arrived about three minutes apart on
 * a real account and could arrive much later or never.
 *
 * These tests pin the two things that make the single-rung version safe:
 * both messages actually go out together, and the ledger still counts them
 * honestly as two rather than as one.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type TestDb, createTestDb, schema, seedCustomer, seedMerchant } from '../db/harness.js';
import { POLICY_TABLE } from '../../src/core/policy/index.js';
import type { PolicyRow } from '../../src/core/policy/schema.js';
import { executeRung } from '../../src/workflows/executor.js';
import { gatherFacts } from '../../src/workflows/facts.js';
import type { SendChannels } from '../../src/messaging/send.js';
import type { SendResult, SendTemplateInput } from '../../src/adapters/whatsapp/client.js';
import type { EmailResult, SendEmailInput } from '../../src/adapters/email/resend.js';

const NOW = new Date('2026-09-01T10:00:00Z');
const LINK = 'https://rzp.io/i/fanout';

let t: TestDb;
let merchantId: string;
let customerId: string;
let caseId: string;

function fakeWhatsApp() {
  const sent: SendTemplateInput[] = [];
  return {
    sent,
    client: {
      async sendTemplate(input: SendTemplateInput): Promise<SendResult> {
        sent.push(input);
        return { ok: true, messageId: 'wamid.FAN', failure: null, detail: null, retryable: false };
      },
      async sendText(): Promise<SendResult> {
        throw new Error('a ladder must never send free-form text');
      },
    },
  };
}

function fakeEmail() {
  const sent: SendEmailInput[] = [];
  return {
    sent,
    client: {
      async send(input: SendEmailInput): Promise<EmailResult> {
        sent.push(input);
        return { ok: true, messageId: 'resend.FAN', failure: null, detail: null, retryable: false };
      },
    },
  };
}

/** The row the customer_input ladders resolve to. Rung 0 is the fanout pair. */
const policy = (): PolicyRow =>
  POLICY_TABLE.find((p) => p.id === 'customer_input.incorrect_card_details') ??
  POLICY_TABLE.find((p) => p.id === 'customer_input.default')!;

beforeEach(async () => {
  t = await createTestDb();
  merchantId = await seedMerchant(t.db, {
    executionEnabled: true,
    dryRun: false,
    // The two settings that used to split the pair. Left at real values so the
    // test proves the fanout rung is immune to them, rather than sidestepping.
    minGapMinutes: 15,
    liveAttemptLockMinutes: 3,
  });
  customerId = await seedCustomer(t.db, merchantId, { transactionalBasisAt: NOW });

  const [c] = await t.db
    .insert(schema.recoveryCases)
    .values({
      merchantId,
      customerId,
      type: 'payment_failure',
      state: 'executing',
      amountAtRiskPaise: 958_800,
      rzpOrderId: 'order_FANOUT',
      rzpPaymentLinkUrl: LINK,
      causeClass: 'customer_input',
      errorReason: 'incorrect_card_details',
      method: 'card',
      attended: true,
      policyId: policy().id,
      policyVersion: 1,
      deadlineAt: new Date(NOW.getTime() + 86_400_000),
    })
    .returning({ id: schema.recoveryCases.id });
  caseId = c!.id;
});

afterEach(async () => {
  await t.close();
});

async function fire(channels: SendChannels) {
  const gathered = await gatherFacts({ db: t.db, caseId, now: NOW });
  return executeRung({
    db: t.db,
    caseId,
    merchantId,
    rungIndex: 0,
    rung: policy().ladder[0]!,
    policy: policy(),
    gathered: gathered!,
    cohort: 'treatment',
    diagnosisRails: ['retry_same', 'upi_intent'] as never,
    sameInstrumentRetry: true,
    channels,
  });
}

describe('the customer_input ladder', () => {
  it('opens on a single fanout rung, not a pair of rungs', () => {
    const rung = policy().ladder[0]!;
    expect(rung.action).toBe('nudge');
    if (rung.action === 'nudge') {
      expect(rung.at).toBe('0m');
      expect(rung.fanout).toBe(true);
      expect(rung.channels).toContain('whatsapp');
      expect(rung.channels).toContain('email');
    }
  });

  /**
   * The whole point. Before this, the email was a second rung whose gate
   * evaluation the live-attempt lock deferred by three minutes.
   */
  it('sends WhatsApp and email in the same rung', async () => {
    const wa = fakeWhatsApp();
    const em = fakeEmail();

    const r = await fire({ whatsapp: wa.client, email: em.client });

    expect(r.disposition).toBe('executed');
    expect(wa.sent).toHaveLength(1);
    expect(em.sent).toHaveLength(1);

    // Same link in both, because it is one message on two channels.
    expect(wa.sent[0]!.variables[3]).toBe(LINK);
    expect(em.sent[0]!.text).toContain(LINK);
  });

  it('writes one ledger row per channel, with distinct keys', async () => {
    await fire({ whatsapp: fakeWhatsApp().client, email: fakeEmail().client });

    const rows = await t.db.select().from(schema.messageLog);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.channel).sort()).toEqual(['email', 'whatsapp']);

    // Distinct keys, or the second send collapses into the first one's row and
    // the ledger under-reports what the customer received.
    const keys = new Set(rows.map((r) => r.idempotencyKey));
    expect(keys.size).toBe(2);
    for (const k of keys) expect(k).toContain(`${caseId}:0:nudge:`);
  });

  /** One rung is one action, however many messages it produced. */
  it('records a single action row for the pair', async () => {
    await fire({ whatsapp: fakeWhatsApp().client, email: fakeEmail().client });

    const actions = await t.db.select().from(schema.caseActions);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.idempotencyKey).toBe(`${caseId}:0:nudge`);
  });

  it('counts the pair as two messages on the case, not one', async () => {
    await fire({ whatsapp: fakeWhatsApp().client, email: fakeEmail().client });

    const [row] = await t.db.select().from(schema.recoveryCases);
    expect(row!.messagesSent).toBe(2);
  });

  /**
   * Half a pair is better than none. The reason to send on two channels is
   * that either one might not land.
   */
  it('still sends the other channel when one has no client', async () => {
    const em = fakeEmail();
    const r = await fire({ email: em.client });

    expect(r.disposition).toBe('executed');
    expect(em.sent).toHaveLength(1);

    const rows = await t.db.select().from(schema.messageLog);
    expect(rows.filter((x) => x.channel === 'email')).toHaveLength(1);
  });

  it('falls back to one channel when the customer has no email', async () => {
    await t.db.update(schema.customers).set({ email: null });

    const wa = fakeWhatsApp();
    const em = fakeEmail();
    const r = await fire({ whatsapp: wa.client, email: em.client });

    expect(r.disposition).toBe('executed');
    expect(wa.sent).toHaveLength(1);
    expect(em.sent).toHaveLength(0);

    const [row] = await t.db.select().from(schema.recoveryCases);
    expect(row!.messagesSent).toBe(1);
  });

  /**
   * Two independent guards stop a replay, and they fire in this order.
   *
   * First the gate: having just sent, the cool-off defers anything else to this
   * person. That is the outer guard and it never reaches the send path.
   */
  it('the cool-off defers a replay before it can reach the send path', async () => {
    const wa = fakeWhatsApp();
    const em = fakeEmail();

    await fire({ whatsapp: wa.client, email: em.client });
    const replay = await fire({ whatsapp: wa.client, email: em.client });

    expect(replay.disposition).toBe('deferred');
    expect(wa.sent).toHaveLength(1);
    expect(em.sent).toHaveLength(1);
  });

  /**
   * And underneath it, the idempotency key — which is the guard that has to
   * hold when the cool-off does NOT apply, as on an account that has turned it
   * off. A workflow replay after a deploy re-runs the rung with a clear gate,
   * and the pair must still collapse to the messages already sent.
   */
  it('the idempotency key collapses a replay the gate would have allowed', async () => {
    const wa = fakeWhatsApp();
    const em = fakeEmail();

    await fire({ whatsapp: wa.client, email: em.client });

    // Clear BOTH outer gates so the inner guard is the only thing left
    // standing between a replay and a second pair. The cap has to be lifted as
    // well as the cool-off, because the pair has already consumed two slots of
    // the default cap of two — see the test below.
    await t.db.update(schema.merchants).set({ minGapMinutes: 0, frequencyCapPerDay: 10 });

    const replay = await fire({ whatsapp: wa.client, email: em.client });

    expect(replay.disposition).toBe('skipped');
    expect(replay.note).toContain('replay');
    expect(wa.sent).toHaveLength(1);
    expect(em.sent).toHaveLength(1);
    expect(await t.db.select().from(schema.messageLog)).toHaveLength(2);
  });

  /**
   * The consequence of fanout that a merchant will actually feel.
   *
   * The per-person daily cap counts MESSAGES, not rungs, so a pair spends two
   * slots at once. On the default cap of 2 that means the pair is the whole
   * day's budget for this person — which is the honest accounting (they did
   * receive two messages) and is worth knowing before raising a ladder to
   * three rungs on an account that has not raised its cap.
   */
  it('spends two slots of the per-person daily cap', async () => {
    await t.db.update(schema.merchants).set({ minGapMinutes: 0, frequencyCapPerDay: 2 });

    await fire({ whatsapp: fakeWhatsApp().client, email: fakeEmail().client });

    const gathered = await gatherFacts({ db: t.db, caseId, now: NOW });
    expect(gathered!.facts.recentMessageCount).toBe(2);
    expect(gathered!.facts.frequencyCap).toBe(2);

    // The next rung for this person is now capped, not merely cooled off.
    const next = await fire({ whatsapp: fakeWhatsApp().client, email: fakeEmail().client });
    expect(next.disposition).toBe('deferred');
    expect(next.gate.failed).toBe('within_frequency_cap');
  });

  it('suppresses both halves on a holdout, and sends neither', async () => {
    const wa = fakeWhatsApp();
    const em = fakeEmail();

    const gathered = await gatherFacts({ db: t.db, caseId, now: NOW });
    const r = await executeRung({
      db: t.db,
      caseId,
      merchantId,
      rungIndex: 0,
      rung: policy().ladder[0]!,
      policy: policy(),
      gathered: gathered!,
      cohort: 'holdout',
      diagnosisRails: ['retry_same'] as never,
      sameInstrumentRetry: true,
      channels: { whatsapp: wa.client, email: em.client },
    });

    expect(r.disposition).toBe('suppressed');
    expect(wa.sent).toHaveLength(0);
    expect(em.sent).toHaveLength(0);

    // Both are still PLANNED and recorded, so the holdout stays comparable to
    // a treatment case that sent two.
    const rows = await t.db.select().from(schema.messageLog);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.suppressedReason).toBe('holdout');
  });
});
