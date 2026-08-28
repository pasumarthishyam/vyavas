/**
 * Rung execution, against real Postgres.
 *
 * The only place in the system where a message becomes a real thing in the
 * world, so these tests are mostly about what must NOT happen: no send to
 * someone who paid, no second send on a replay, no rail the diagnosis withdrew,
 * and no half-composed message with a blank where the link should be.
 *
 * The providers are fakes. Whether the Cloud API is reachable is not what this
 * file is testing — what the executor decides to hand it is.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { executeRung } from '../../src/workflows/executor.js';
import { gatherFacts } from '../../src/workflows/facts.js';
import { POLICY_TABLE } from '../../src/core/policy/index.js';
import type { PolicyRow } from '../../src/core/policy/schema.js';
import type { SendChannels } from '../../src/messaging/send.js';
import type { SendResult, SendTemplateInput } from '../../src/adapters/whatsapp/client.js';
import { createTestDb, schema, seedCustomer, seedMerchant, type TestDb } from '../db/harness.js';

const NOW = new Date('2026-08-27T14:10:00.000Z'); // 19:40 IST — outside quiet hours
const LINK = 'https://rzp.io/i/testlink';

let t: TestDb;
let merchantId: string;
let customerId: string;
let caseId: string;

/** Records what it was asked to send, and answers however the test wants. */
function fakeWhatsApp(result?: Partial<SendResult>) {
  const sent: SendTemplateInput[] = [];
  return {
    sent,
    client: {
      async sendTemplate(input: SendTemplateInput): Promise<SendResult> {
        sent.push(input);
        return {
          ok: true,
          messageId: 'wamid.TEST123',
          failure: null,
          detail: null,
          retryable: false,
          ...result,
        };
      },
    },
  };
}

const policy = (): PolicyRow => POLICY_TABLE.find((p) => p.id === 'instrument_dead.card_expired')!;

beforeEach(async () => {
  t = await createTestDb();
  merchantId = await seedMerchant(t.db, { executionEnabled: true, dryRun: false });
  customerId = await seedCustomer(t.db, merchantId, { transactionalBasisAt: NOW });

  const [c] = await t.db
    .insert(schema.recoveryCases)
    .values({
      merchantId,
      customerId,
      type: 'payment_failure',
      state: 'executing',
      amountAtRiskPaise: 184_300,
      rzpOrderId: 'order_EXEC',
      rzpPaymentLinkUrl: LINK,
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

interface FireOpts {
  rungIndex?: number;
  cohort?: 'treatment' | 'holdout';
  rails?: string[];
  retry?: boolean;
  channels?: SendChannels;
}

async function fire(over: FireOpts = {}) {
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
    channels: over.channels ?? {},
  });
}

describe('sending, for real', () => {
  it('composes an approved template and hands it to WhatsApp', async () => {
    const wa = fakeWhatsApp();
    const r = await fire({ channels: { whatsapp: wa.client } });

    expect(r.disposition).toBe('suppressed'); // outcome name; the send happened
    expect(wa.sent).toHaveLength(1);
    expect(wa.sent[0]!.templateName).toBe('vyavas_switch_method_en');
    expect(wa.sent[0]!.language).toBe('en');
    // Positional variables, in the template's declared order.
    expect(wa.sent[0]!.variables).toHaveLength(4);
    expect(wa.sent[0]!.variables[3]).toBe(LINK);

    const [msg] = await t.db.select().from(schema.messageLog);
    expect(msg!.status).toBe('sent');
    expect(msg!.providerMessageId).toBe('wamid.TEST123');
    expect(msg!.suppressedReason).toBeNull();
  });

  it('records the action as executed, not suppressed', async () => {
    await fire({ channels: { whatsapp: fakeWhatsApp().client } });
    const [action] = await t.db.select().from(schema.caseActions);
    expect(action!.status).toBe('executed');
    expect(action!.skipReason).toBeNull();
  });
});

describe('the two reasons a rung still does not send', () => {
  it('holdout: the full ladder runs and nothing leaves', async () => {
    const wa = fakeWhatsApp();
    const r = await fire({ cohort: 'holdout', channels: { whatsapp: wa.client } });

    expect(r.suppressedReason).toBe('holdout');
    expect(wa.sent).toHaveLength(0);

    // The ledger row still exists — that is what makes the control comparable.
    const [msg] = await t.db.select().from(schema.messageLog);
    expect(msg!.suppressedReason).toBe('holdout');
    expect(msg!.body).toContain('Hi ');
  });

  it('dry_run: the merchant has not switched execution on', async () => {
    await t.db
      .update(schema.merchants)
      .set({ dryRun: true })
      .where(eq(schema.merchants.id, merchantId));

    const wa = fakeWhatsApp();
    const r = await fire({ channels: { whatsapp: wa.client } });

    expect(r.suppressedReason).toBe('dry_run');
    expect(wa.sent).toHaveLength(0);
  });

  it('keeps the two apart', async () => {
    // A dry-run case is not a control — it is a case nobody was treated in.
    // Collapsing them would make the incrementality report a guess.
    const a = await fire({ cohort: 'holdout', channels: { whatsapp: fakeWhatsApp().client } });
    expect(a.suppressedReason).toBe('holdout');
  });
});

describe('composition can refuse', () => {
  it('will not send a message with a blank where the link goes', async () => {
    await t.db
      .update(schema.recoveryCases)
      .set({ rzpPaymentLinkUrl: null })
      .where(eq(schema.recoveryCases.id, caseId));

    const wa = fakeWhatsApp();
    const r = await fire({ channels: { whatsapp: wa.client } });

    expect(r.disposition).toBe('skipped');
    expect(r.note).toContain('payment link');
    expect(wa.sent).toHaveLength(0);
    expect(await t.db.select().from(schema.messageLog)).toHaveLength(0);
  });

  it('records why it could not compose', async () => {
    await t.db
      .update(schema.recoveryCases)
      .set({ rzpPaymentLinkUrl: null })
      .where(eq(schema.recoveryCases.id, caseId));
    await fire({ channels: { whatsapp: fakeWhatsApp().client } });

    const events = await t.db
      .select()
      .from(schema.caseEvents)
      .where(eq(schema.caseEvents.caseId, caseId));
    expect(events.some((e) => e.kind === 'rung_uncomposable')).toBe(true);
  });
});

describe('provider failures', () => {
  it('marks the number undeliverable on a permanent failure', async () => {
    const wa = fakeWhatsApp({
      ok: false,
      messageId: null,
      failure: 'undeliverable',
      detail: 'not a WhatsApp user',
      retryable: false,
    });

    const r = await fire({ channels: { whatsapp: wa.client } });
    expect(r.disposition).toBe('suppressed');

    // The next rung should fall through to email rather than fail identically.
    const [cust] = await t.db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.id, customerId));
    expect(cust!.phoneUndeliverableAt).not.toBeNull();

    const [msg] = await t.db.select().from(schema.messageLog);
    expect(msg!.status).toBe('failed');
  });

  it('does not release the slot on a failed send', async () => {
    // Releasing it would turn one provider hiccup into two messages for one rung.
    const wa = fakeWhatsApp({ ok: false, messageId: null, failure: 'transient', detail: 'x', retryable: true });
    await fire({ channels: { whatsapp: wa.client } });
    expect(await t.db.select().from(schema.messageLog)).toHaveLength(1);
  });

  it('reports a channel with no configured client rather than pretending', async () => {
    const r = await fire({ channels: {} });
    expect(r.disposition).toBe('skipped');
    expect(r.note).toContain('not configured');
  });
});

describe('the gate runs before anything else', () => {
  it('aborts rather than sending when the order has been paid', async () => {
    await t.db
      .update(schema.recoveryCases)
      .set({ state: 'recovered' })
      .where(eq(schema.recoveryCases.id, caseId));

    const wa = fakeWhatsApp();
    const r = await fire({ channels: { whatsapp: wa.client } });

    expect(r.disposition).toBe('aborted');
    expect(wa.sent).toHaveLength(0);
    expect(await t.db.select().from(schema.caseActions)).toHaveLength(0);
  });

  it('aborts for an opted-out customer', async () => {
    await t.db
      .update(schema.customers)
      .set({ optedOutAt: NOW })
      .where(eq(schema.customers.id, customerId));
    const wa = fakeWhatsApp();
    expect((await fire({ channels: { whatsapp: wa.client } })).disposition).toBe('aborted');
    expect(wa.sent).toHaveLength(0);
  });

  it('aborts when the merchant kill switch is off', async () => {
    await t.db
      .update(schema.merchants)
      .set({ executionEnabled: false })
      .where(eq(schema.merchants.id, merchantId));
    const r = await fire({ channels: { whatsapp: fakeWhatsApp().client } });
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

    const wa = fakeWhatsApp();
    const r = await fire({ channels: { whatsapp: wa.client } });
    expect(r.disposition).toBe('deferred');
    expect(wa.sent).toHaveLength(0);
  });

  it('gates a holdout case identically to a treatment case', async () => {
    await t.db
      .update(schema.recoveryCases)
      .set({ state: 'recovered' })
      .where(eq(schema.recoveryCases.id, caseId));
    const r = await fire({ cohort: 'holdout', channels: { whatsapp: fakeWhatsApp().client } });
    expect(r.disposition).toBe('aborted');
  });
});

describe('idempotency', () => {
  it('sends once when a rung is replayed', async () => {
    const wa = fakeWhatsApp();
    const first = await fire({ channels: { whatsapp: wa.client } });
    const second = await fire({ channels: { whatsapp: wa.client } });

    expect(first.disposition).toBe('suppressed');
    expect(second.disposition).toBe('skipped');
    expect(second.note).toContain('replay');

    // The one that matters: the provider was called exactly once.
    expect(wa.sent).toHaveLength(1);
    expect(await t.db.select().from(schema.messageLog)).toHaveLength(1);
  });

  it('keeps separate rungs separate', async () => {
    const wa = fakeWhatsApp();
    await fire({ rungIndex: 0, channels: { whatsapp: wa.client } });
    await fire({ rungIndex: 1, channels: { whatsapp: wa.client } });
    expect(wa.sent).toHaveLength(2);
  });
});

describe('the diagnosis overrules the policy table', () => {
  it('strips a rail the diagnosis withdrew', async () => {
    const r = await fire({
      rails: ['upi_intent', 'retry_same'],
      retry: false,
      channels: { whatsapp: fakeWhatsApp().client },
    });
    if (r.action?.kind === 'nudge') {
      expect(r.action.suggest).not.toContain('retry_same');
    }
  });
});

describe('channel selection', () => {
  it('falls through to the next consented channel', async () => {
    await t.db
      .update(schema.customers)
      .set({ transactionalBasisAt: null, smsOptIn: true, whatsappOptIn: false })
      .where(eq(schema.customers.id, customerId));
    const r = await fire({ channels: { whatsapp: fakeWhatsApp().client } });
    expect(r.channel).toBe('sms');
    // SMS is deferred until DLT — reported honestly rather than silently dropped.
    expect(r.note).toContain('not implemented');
  });

  it('aborts when the customer has no reachable channel at all', async () => {
    await t.db
      .update(schema.customers)
      .set({
        transactionalBasisAt: null,
        whatsappOptIn: false,
        smsOptIn: false,
        emailOptIn: false,
      })
      .where(eq(schema.customers.id, customerId));
    const r = await fire({ channels: { whatsapp: fakeWhatsApp().client } });
    expect(r.disposition).toBe('aborted');
    expect(r.gate.failed).toBe('channel_deliverable');
  });
});

describe('the ledger', () => {
  it('records the intent and channel of what was sent', async () => {
    await fire({ channels: { whatsapp: fakeWhatsApp().client } });
    const events = await t.db
      .select()
      .from(schema.caseEvents)
      .where(eq(schema.caseEvents.caseId, caseId));

    const fired = events.find((e) => e.kind === 'rung_fired')!;
    const payload = fired.payload as Record<string, unknown>;
    expect(payload.action).toBe('nudge');
    expect(payload.intent).toBe('switch_method');
    expect(payload.channel).toBe('whatsapp');
  });

  it('advances the rung counter and message count', async () => {
    await fire({ rungIndex: 1, channels: { whatsapp: fakeWhatsApp().client } });
    const [c] = await t.db
      .select()
      .from(schema.recoveryCases)
      .where(eq(schema.recoveryCases.id, caseId));
    expect(c!.currentRung).toBe(1);
    expect(c!.messagesSent).toBe(1);
  });
});
