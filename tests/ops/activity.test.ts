/**
 * The audit trail.
 *
 * Two properties, and both were broken before:
 *
 *   COMPLETE   every event kind the system persists reaches the feed. The old
 *              allowlist silently dropped five of fifteen — including
 *              `payment_received`, the moment money arrives, and both events
 *              the Claude jobs write. A trail that omits the AI's own actions
 *              is not a trail.
 *
 *   REDACTED   nothing personal leaves the query layer. The rendered message
 *              body is never selected, and provider text is masked before any
 *              component sees it.
 *
 * Both fail silently in production — a missing event looks like a quiet system,
 * and a leaked phone number renders exactly as well as a masked one — so they
 * are pinned here.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type TestDb, createTestDb, schema, seedMerchant } from '../db/harness.js';
import {
  EVENT_CATEGORY,
  categoryFor,
  getCaseTrace,
  getRecentActivity,
} from '../../src/db/queries/recovery.js';

let t: TestDb;
let merchantId: string;
let caseId: string;
let customerId: string;

beforeEach(async () => {
  t = await createTestDb();
  merchantId = await seedMerchant(t.db);

  const [cust] = await t.db
    .insert(schema.customers)
    .values({ merchantId, phone: '+919876543210', email: 'rahul@example.com' })
    .returning({ id: schema.customers.id });
  customerId = cust!.id;

  const [c] = await t.db
    .insert(schema.recoveryCases)
    .values({
      merchantId,
      customerId,
      type: 'payment_failure',
      amountAtRiskPaise: 958_800,
      attended: true,
      method: 'card',
    })
    .returning({ id: schema.recoveryCases.id });
  caseId = c!.id;
});

afterEach(async () => {
  await t.close();
});

const event = (kind: string, over: Record<string, unknown> = {}) =>
  t.db.insert(schema.caseEvents).values({ caseId, merchantId, kind, actor: 'workflow', ...over });

describe('the category map', () => {
  /**
   * The guard that keeps the trail complete as the system grows. Adding an
   * `appendEvent` kind without a lane here is how the feed quietly started
   * dropping events the first time.
   */
  it('covers every event kind the system persists', () => {
    const PERSISTED = [
      'aborted',
      'detected',
      'diagnosed',
      'escalated',
      'ladder_complete',
      'ladder_paused',
      'merchant_alerted',
      'payment_link_created',
      'payment_received',
      'recovery_started',
      'rung_abandoned',
      'rung_aborted',
      'rung_deferred',
      'rung_fired',
      'rung_paused',
      'rung_uncomposable',
      'state_changed',
    ];

    for (const kind of PERSISTED) {
      expect(EVENT_CATEGORY[kind], `'${kind}' has no lane`).toBeDefined();
    }
    // And nothing in the map that the system never writes, which would show a
    // reader a lane that can never fill.
    for (const kind of Object.keys(EVENT_CATEGORY)) {
      expect(PERSISTED, `'${kind}' is mapped but never persisted`).toContain(kind);
    }
  });

  it('puts both AI events in the ai lane', () => {
    expect(categoryFor('escalated')).toBe('ai');
    expect(categoryFor('merchant_alerted')).toBe('ai');
  });

  /** An unrecognised kind must still render. Hiding it is the old failure. */
  it('falls an unknown kind back to system rather than dropping it', () => {
    expect(categoryFor('something_added_next_year')).toBe('system');
  });
});

describe('getRecentActivity', () => {
  it('includes the events the old allowlist dropped', async () => {
    await event('payment_received');
    await event('escalated', {
      payload: { queue: 'risk_review', briefSource: 'claude' } as never,
    });
    await event('merchant_alerted', {
      payload: { signal: 'bank_not_enabled:ICIC:netbanking', raised: true, affectedCases: 47, proseSource: 'claude' } as never,
    });
    await event('detected');
    await event('aborted', { reason: 'already_paid' });

    const rows = (await getRecentActivity(t.db, merchantId, 50)).rows;
    const kinds = rows.filter((r) => r.kind === 'decision').map((r) => r.event);

    for (const k of ['payment_received', 'escalated', 'merchant_alerted', 'detected', 'aborted']) {
      expect(kinds, k).toContain(k);
    }
  });

  it('explains an escalation instead of showing a bare verb', async () => {
    await event('escalated', {
      payload: { queue: 'risk_review', briefSource: 'claude' } as never,
    });

    const [row] = (await getRecentActivity(t.db, merchantId, 50)).rows;
    expect(row?.kind).toBe('decision');
    if (row?.kind === 'decision') {
      expect(row.category).toBe('ai');
      expect(row.detail).toContain('Claude wrote the brief');
      expect(row.detail).toContain('risk review');
    }
  });

  /**
   * The signal that a broken integration is visible in the trail, not only on
   * the queue card. A run of these is what an expired key looks like.
   */
  it('names the reason a brief fell back', async () => {
    await event('escalated', {
      payload: {
        queue: 'merchant_review',
        briefSource: 'fallback',
        briefError: 'auth: invalid x-api-key',
      } as never,
    });

    const [row] = (await getRecentActivity(t.db, merchantId, 50)).rows;
    if (row?.kind === 'decision') {
      expect(row.detail).toContain('fell back');
      expect(row.detail).toContain('invalid x-api-key');
    }
  });

  it('says when a merchant alert found no cluster', async () => {
    await event('merchant_alerted', {
      payload: { signal: 'bank_not_enabled:all:upi', raised: false } as never,
    });

    const [row] = (await getRecentActivity(t.db, merchantId, 50)).rows;
    if (row?.kind === 'decision') expect(row.detail).toContain('nothing raised');
  });
});

describe('the trail cannot leak personal data', () => {
  async function messageWith(over: Partial<typeof schema.messageLog.$inferInsert>) {
    await t.db.insert(schema.messageLog).values({
      merchantId,
      customerId,
      caseId,
      channel: 'whatsapp',
      intent: 'switch_method',
      idempotencyKey: `k-${Math.random()}`,
      ...over,
    });
  }

  /**
   * `body` is the rendered message: the customer's first name, the amount, and
   * the payment link — which is a per-customer bearer URL. It belongs in the
   * ledger for a compliance review and on no screen anyone might share.
   */
  it('never returns the rendered message body', async () => {
    await messageWith({
      body: 'Hi Rahul, your payment of Rs 9,588 failed. Pay here: https://rzp.io/i/SECRET99',
    });

    const rows = (await getRecentActivity(t.db, merchantId, 50)).rows;
    const serialised = JSON.stringify(rows);

    expect(serialised).not.toContain('Rahul');
    expect(serialised).not.toContain('SECRET99');
    expect(serialised).not.toContain('body');
  });

  it('masks a recipient echoed back inside a provider error', async () => {
    await messageWith({
      status: 'failed',
      error: 'Message undeliverable to +919876543210 (131026)',
    });

    const rows = (await getRecentActivity(t.db, merchantId, 50)).rows;
    const msg = rows.find((r) => r.kind === 'message');

    expect(msg?.kind).toBe('message');
    if (msg?.kind === 'message') {
      expect(msg.error).not.toContain('9876543210');
      expect(msg.error).toContain('•');
      // The error code survives — it is what tells you the number is dead
      // rather than the send being retryable.
      expect(msg.error).toContain('131026');
    }
  });

  it('masks contact details that reach an event payload', async () => {
    await event('rung_uncomposable', {
      reason: 'variable_contract_mismatch',
      payload: { note: 'could not reach rahul@example.com or +919876543210' } as never,
    });

    const rows = (await getRecentActivity(t.db, merchantId, 50)).rows;
    const serialised = JSON.stringify(rows);

    expect(serialised).not.toContain('rahul@example.com');
    expect(serialised).not.toContain('9876543210');
    // The domain survives: a run of failures to one domain is a deliverability
    // problem worth seeing, and it is not personal on its own.
    expect(serialised).toContain('example.com');
  });

  it('leaves the case id intact so it can still be looked up', async () => {
    await event('rung_deferred', { reason: 'inside the merchant quiet-hours window' });

    const rows = (await getRecentActivity(t.db, merchantId, 50)).rows;
    expect(rows[0]?.caseId).toBe(caseId);
  });

  it('applies the same rules to one case’s own trace', async () => {
    await messageWith({ status: 'failed', error: 'failed for rahul@example.com' });
    await event('escalated', { payload: { queue: 'risk_review', briefSource: 'claude' } as never });

    const rows = await getCaseTrace(t.db, merchantId, caseId, 50);
    const serialised = JSON.stringify(rows);

    expect(rows.length).toBe(2);
    expect(serialised).not.toContain('rahul@example.com');
  });
});
