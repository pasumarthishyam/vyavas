/**
 * The overnight first touch, end to end.
 *
 * The gate's own decision is covered in `tests/core/guards.test.ts`. What is
 * proved here is the half that lives in the executor: that a gate saying
 * "proceed, email only" actually narrows what goes out, that a fanout rung
 * respects it (both halves are one decision, so both halves obey it), and that
 * a rung with nothing sendable overnight WAITS rather than being thrown away.
 *
 * The bug this whole path fixes: a payment failing at 01:30 produced nothing at
 * all until 08:00 for every class whose first rung is more than a few minutes
 * out, by which time the intent is long gone.
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

/** 01:30 IST — deep inside the 21:00→08:00 quiet window. */
const NIGHT = new Date('2026-09-01T20:00:00Z');
/** The same case, in the afternoon, as the control. */
const DAY = new Date('2026-09-01T10:00:00Z');

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
        return { ok: true, messageId: 'wamid.NIGHT', failure: null, detail: null, retryable: false };
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
        return { ok: true, messageId: 'resend.NIGHT', failure: null, detail: null, retryable: false };
      },
    },
  };
}

/** A fanout row (WhatsApp + email in one decision) and a WhatsApp-only row. */
const fanoutPolicy = (): PolicyRow => POLICY_TABLE.find((p) => p.id === 'customer_input.default')!;
const whatsappOnlyPolicy = (): PolicyRow =>
  POLICY_TABLE.find((p) => p.id === 'instrument_dead.card_expired')!;

async function seedCase(policy: PolicyRow, createdAt: Date) {
  const [c] = await t.db
    .insert(schema.recoveryCases)
    .values({
      merchantId,
      customerId,
      type: 'payment_failure',
      state: 'executing',
      amountAtRiskPaise: 598_800,
      rzpOrderId: `order_NIGHT_${Math.random().toString(36).slice(2, 9)}`,
      rzpPaymentLinkUrl: 'https://rzp.io/i/night',
      causeClass: policy.match.causeClass?.[0] ?? 'customer_input',
      errorReason: policy.match.errorReason ?? 'incorrect_cvv',
      method: 'card',
      attended: true,
      policyId: policy.id,
      policyVersion: 1,
      createdAt,
      deadlineAt: new Date(createdAt.getTime() + 3 * 86_400_000),
    })
    .returning({ id: schema.recoveryCases.id });
  return c!.id;
}

beforeEach(async () => {
  t = await createTestDb();
  merchantId = await seedMerchant(t.db, {
    executionEnabled: true,
    timezone: 'Asia/Kolkata',
    quietHoursStart: 21,
    quietHoursEnd: 8,
    // Well past the live-customer exemption, so nothing here is riding on it.
    liveCustomerWindowMinutes: 15,
  });
  customerId = await seedCustomer(t.db, merchantId, { transactionalBasisAt: DAY });
});

afterEach(async () => {
  await t.close();
});

async function fire(policy: PolicyRow, now: Date, channels: SendChannels) {
  const gathered = await gatherFacts({ db: t.db, caseId, now });
  return executeRung({
    db: t.db,
    caseId,
    merchantId,
    rungIndex: 0,
    rung: policy.ladder[0]!,
    policy,
    gathered: gathered!,
    cohort: 'treatment',
    diagnosisRails: ['upi_intent', 'other_card'] as never,
    sameInstrumentRetry: false,
    channels,
  });
}

describe('a first touch inside quiet hours', () => {
  it('sends the email and holds the WhatsApp back', async () => {
    // The failure is 90 minutes old: outside the live-customer window, so the
    // only thing letting this through is the overnight email rule.
    caseId = await seedCase(fanoutPolicy(), new Date(NIGHT.getTime() - 90 * 60_000));

    const wa = fakeWhatsApp();
    const mail = fakeEmail();
    const outcome = await fire(fanoutPolicy(), NIGHT, { whatsapp: wa.client, email: mail.client });

    expect(outcome.disposition).toBe('executed');
    expect(mail.sent).toHaveLength(1);
    // The half that would have rung a phone at 01:30.
    expect(wa.sent).toHaveLength(0);
  });

  it('records only the channel it actually used', async () => {
    caseId = await seedCase(fanoutPolicy(), new Date(NIGHT.getTime() - 90 * 60_000));

    const wa = fakeWhatsApp();
    const mail = fakeEmail();
    await fire(fanoutPolicy(), NIGHT, { whatsapp: wa.client, email: mail.client });

    const rows = await t.db.select().from(schema.messageLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.channel).toBe('email');
  });

  it('DEFERS a WhatsApp-only rung to the morning rather than skipping it', async () => {
    /*
     * The distinction that makes this safe. Skipping would silently lose the
     * first touch of every WhatsApp-only class on every overnight failure —
     * a strictly worse outcome than the one this whole change set out to fix.
     */
    caseId = await seedCase(whatsappOnlyPolicy(), new Date(NIGHT.getTime() - 90 * 60_000));

    const wa = fakeWhatsApp();
    const outcome = await fire(whatsappOnlyPolicy(), NIGHT, { whatsapp: wa.client });

    expect(outcome.disposition).toBe('deferred');
    expect(wa.sent).toHaveLength(0);
    expect(outcome.retryAt).not.toBeNull();
    // Morning, in the merchant's own zone — 08:00 IST is 02:30 UTC.
    expect(outcome.retryAt!.getTime()).toBeGreaterThan(NIGHT.getTime());
  });

  it('sends both channels in daylight, unchanged', async () => {
    // The control. The narrowing must be scoped to the quiet-hours branch, or
    // it would quietly turn every fanout rung into an email-only one.
    caseId = await seedCase(fanoutPolicy(), new Date(DAY.getTime() - 90 * 60_000));

    const wa = fakeWhatsApp();
    const mail = fakeEmail();
    const outcome = await fire(fanoutPolicy(), DAY, { whatsapp: wa.client, email: mail.client });

    expect(outcome.disposition).toBe('executed');
    expect(wa.sent).toHaveLength(1);
    expect(mail.sent).toHaveLength(1);
  });
});
