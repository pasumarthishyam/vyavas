/**
 * The webhook contract.
 *
 * Response codes here are not cosmetic. Each one changes what Razorpay does
 * next, and getting one wrong either loses an event permanently or produces a
 * retry storm.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { computeSignature } from '@adapters/razorpay/webhook.js';
import { FAILURE_SCENARIOS } from '@adapters/razorpay/fixtures/webhooks.js';
import {
  type MerchantSettings,
  type WebhookDeps,
  handleWebhookRequest,
} from '@ingest/webhook-handler.js';
import { createTestDb, schema, seedMerchant, type TestDb } from '../db/harness.js';

const SECRET = 'whsec_test_abcdef123456';
const NOW = new Date('2026-08-27T14:10:00.000Z');

let t: TestDb;
let merchant: MerchantSettings;
let deps: WebhookDeps;

beforeEach(async () => {
  t = await createTestDb();
  merchant = {
    merchantId: await seedMerchant(t.db),
    holdoutBasisPoints: 0,
    holdoutEnabled: false,
  };
  deps = {
    db: t.db,
    webhookSecret: SECRET,
    resolveMerchant: async () => merchant,
    now: () => NOW,
  };
});

afterEach(async () => {
  await t.close();
});

function signed(body: string, eventId = 'evt_1') {
  return {
    'x-razorpay-signature': computeSignature(body, SECRET),
    'x-razorpay-event-id': eventId,
  };
}

const failureBody = () => JSON.stringify(FAILURE_SCENARIOS.card_expired());

describe('authentication', () => {
  it('accepts a correctly signed delivery', async () => {
    const body = failureBody();
    const res = await handleWebhookRequest(body, signed(body), deps);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.result?.handled).toBe(true);
  });

  it('returns 401 for a bad signature and writes nothing', async () => {
    const body = failureBody();
    const res = await handleWebhookRequest(
      body,
      { 'x-razorpay-signature': 'deadbeef', 'x-razorpay-event-id': 'evt_1' },
      deps,
    );
    expect(res.status).toBe(401);
    // An unauthenticated request must not leave a trace in the event log, or
    // an attacker could fill it at will.
    expect(await t.db.select().from(schema.webhookEvents)).toHaveLength(0);
    expect(await t.db.select().from(schema.recoveryCases)).toHaveLength(0);
  });

  it('returns 401 when the signature header is absent', async () => {
    const res = await handleWebhookRequest(failureBody(), {}, deps);
    expect(res.status).toBe(401);
  });

  it('returns 400 for a signed body that is not JSON', async () => {
    const body = '{not json';
    const res = await handleWebhookRequest(body, signed(body), deps);
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('malformed_json');
  });

  it('is case-insensitive about header names', async () => {
    const body = failureBody();
    const res = await handleWebhookRequest(
      body,
      { 'X-Razorpay-Signature': computeSignature(body, SECRET) },
      deps,
    );
    expect(res.status).toBe(200);
  });
});

describe('dedupe', () => {
  it('processes once and reports the replay as a duplicate', async () => {
    const body = failureBody();
    const first = await handleWebhookRequest(body, signed(body, 'evt_dup'), deps);
    const second = await handleWebhookRequest(body, signed(body, 'evt_dup'), deps);

    expect(first.body.duplicate).toBe(false);
    expect(second.body.duplicate).toBe(true);
    // 200 on the replay: anything else makes Razorpay retry a delivery we have
    // definitively handled.
    expect(second.status).toBe(200);
    expect(await t.db.select().from(schema.recoveryCases)).toHaveLength(1);
  });

  it('dedupes on the body when the event id header is missing', async () => {
    const body = failureBody();
    const h = { 'x-razorpay-signature': computeSignature(body, SECRET) };
    await handleWebhookRequest(body, h, deps);
    const second = await handleWebhookRequest(body, h, deps);
    expect(second.body.duplicate).toBe(true);
  });

  it('treats genuinely different deliveries as distinct', async () => {
    const a = JSON.stringify(FAILURE_SCENARIOS.card_expired());
    const b = JSON.stringify(FAILURE_SCENARIOS.bank_technical_error());
    await handleWebhookRequest(a, signed(a, 'evt_a'), deps);
    const second = await handleWebhookRequest(b, signed(b, 'evt_b'), deps);
    expect(second.body.duplicate).toBe(false);
  });
});

describe('failure handling', () => {
  it('still returns 200 when processing throws', async () => {
    // A 500 would make Razorpay resend an event we have already CLAIMED. The
    // dedupe would then swallow the resend, losing it entirely. The redrive
    // sweep is what recovers a failed process — not Razorpay's retry.
    const body = failureBody();
    const failing: WebhookDeps = {
      ...deps,
      enqueue: async (job) => {
        await job().catch(() => null);
        throw new Error('queue exploded');
      },
    };
    await expect(handleWebhookRequest(body, signed(body), failing)).rejects.toThrow();

    // With the inline path, a handler error is recorded rather than thrown.
    const body2 = JSON.stringify(FAILURE_SCENARIOS.incorrect_otp());
    const broken: WebhookDeps = {
      ...deps,
      resolveMerchant: async () => ({
        merchantId: '00000000-0000-0000-0000-000000000000', // no such merchant
        holdoutBasisPoints: 0,
        holdoutEnabled: false,
      }),
    };
    const res = await handleWebhookRequest(body2, signed(body2, 'evt_broken'), broken);
    expect(res.status).toBe(200);
    expect(res.body.result?.outcome).toBe('error');

    const [row] = await t.db
      .select()
      .from(schema.webhookEvents)
      .where(eq(schema.webhookEvents.eventId, 'evt_broken'));
    expect(row!.processingError).not.toBeNull();
    expect(row!.processedAt).toBeNull(); // stays on the redrive queue
  });

  it('accepts but parks a delivery it cannot attribute to a merchant', async () => {
    const body = failureBody();
    const orphan: WebhookDeps = { ...deps, resolveMerchant: async () => null };
    const res = await handleWebhookRequest(body, signed(body, 'evt_orphan'), orphan);
    expect(res.status).toBe(200);
    expect(res.body.reason).toBe('unknown_merchant');
    // Retrying will not make the merchant exist; the row is on disk to inspect.
    expect(await t.db.select().from(schema.webhookEvents)).toHaveLength(1);
  });
});

describe('marking processed', () => {
  it('stamps processedAt on success', async () => {
    const body = failureBody();
    await handleWebhookRequest(body, signed(body, 'evt_ok'), deps);
    const [row] = await t.db
      .select()
      .from(schema.webhookEvents)
      .where(eq(schema.webhookEvents.eventId, 'evt_ok'));
    expect(row!.processedAt).not.toBeNull();
    expect(row!.processingError).toBeNull();
  });
});

describe('enqueue handoff', () => {
  it('defers the slow work when a queue is supplied', async () => {
    const deferred: (() => Promise<unknown>)[] = [];
    const queued: WebhookDeps = {
      ...deps,
      enqueue: async (job) => {
        deferred.push(job);
        return null;
      },
    };

    const body = failureBody();
    const res = await handleWebhookRequest(body, signed(body), queued);

    // 200 came back without the pipeline having run — which is the whole point
    // of the handoff once volume is real.
    expect(res.status).toBe(200);
    expect(res.body.result).toBeNull();
    expect(await t.db.select().from(schema.recoveryCases)).toHaveLength(0);

    await deferred[0]!();
    expect(await t.db.select().from(schema.recoveryCases)).toHaveLength(1);
  });
});
