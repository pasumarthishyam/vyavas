/**
 * Pause and resume.
 *
 * The switch used to be labelled Off and behaved like "cancel everything": a
 * paused merchant made the gate abort, an abort is terminal, so pausing an
 * account for an afternoon destroyed every case in flight and switching back
 * recovered none of them.
 *
 * These tests pin the two properties that make it a real pause. Nothing is lost
 * while paused, and resuming cannot start two ladders on one case.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import {
  claimPausedCaseForResume,
  listPausedCases,
  listResumableCases,
} from '../../src/db/repos/cases.js';
import { runKeyFor } from '../../src/workflows/client.js';
import { apply, preview, resumeAllLiveMerchants } from '../../src/workflows/resume.js';
import type { CaseDiagnosedData } from '../../src/workflows/client.js';
import { createTestDb, schema, seedCustomer, seedMerchant, type TestDb } from '../db/harness.js';

const NOW = new Date('2026-08-27T14:10:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const daysAgo = (d: number) => hoursAgo(d * 24);

/**
 * Stands in for Inngest, and records what each woken case was told.
 *
 * Injected rather than mocked at the module level so the assertions can be
 * about the DECISION — which cases woke, under which run key — rather than
 * about whether a workflow engine happened to be reachable.
 */
function recorder() {
  const sent: CaseDiagnosedData[] = [];
  return {
    sent,
    publish: async (d: CaseDiagnosedData) => {
      sent.push(d);
      return undefined;
    },
  };
}

let t: TestDb;
let merchantId: string;

async function seedCase(over: Partial<typeof schema.recoveryCases.$inferInsert> = {}) {
  const customerId = await seedCustomer(t.db, merchantId, { transactionalBasisAt: NOW });
  const [c] = await t.db
    .insert(schema.recoveryCases)
    .values({
      merchantId,
      customerId,
      type: 'payment_failure',
      state: 'paused',
      amountAtRiskPaise: 184_300,
      rzpOrderId: `order_${Math.random().toString(36).slice(2, 10)}`,
      causeClass: 'instrument_dead',
      errorReason: 'card_expired',
      method: 'card',
      attended: true,
      policyId: 'instrument_dead.card_expired',
      policyVersion: 1,
      currentRung: 1,
      messagesSent: 1,
      deadlineAt: new Date(NOW.getTime() + 86_400_000),
      ...over,
    })
    .returning({ id: schema.recoveryCases.id });
  return c!.id;
}

beforeEach(async () => {
  t = await createTestDb();
  merchantId = await seedMerchant(t.db, { executionEnabled: false });
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

describe('a paused case keeps everything', () => {
  it('is still live, still counted, and still carries its rung and deadline', async () => {
    const id = await seedCase();
    const c = await caseRow(id);

    // `paused` is one of the LIVE states, so a paused case is still at risk on
    // the dashboard rather than vanishing into a terminal bucket.
    expect(c.state).toBe('paused');
    expect(c.resolvedAt).toBeNull();
    expect(c.currentRung).toBe(1);
    expect(c.messagesSent).toBe(1);
    expect(c.deadlineAt).not.toBeNull();
  });
});

describe('resuming', () => {
  it('claims the case, moves it to executing, and bumps the resume count', async () => {
    const id = await seedCase();

    const claimed = await claimPausedCaseForResume(t.db, id);
    expect(claimed).not.toBeNull();
    expect(claimed!.resumeCount).toBe(1);
    expect(claimed!.policyId).toBe('instrument_dead.card_expired');

    const c = await caseRow(id);
    expect(c.state).toBe('executing');
    // The rung it had reached is untouched, so the restarted ladder replays the
    // rungs that already fired as no-ops and carries on from there.
    expect(c.currentRung).toBe(1);
  });

  it('gives the restarted run a DIFFERENT key from the one that was paused', async () => {
    /*
     * The subtle failure this prevents.
     *
     * `run-ladder` is declared `idempotency: 'event.data.runKey'`, which is what
     * stops a duplicate event doubling every message. Republishing under the
     * original key to resume would be swallowed by that very guard: the case
     * would sit in `executing` with no run behind it, paused forever, and the
     * console would show it as running.
     */
    const id = await seedCase();
    const first = runKeyFor(id, 0);

    const claimed = await claimPausedCaseForResume(t.db, id);
    const second = runKeyFor(id, claimed!.resumeCount);

    expect(first).toBe(id);
    expect(second).toBe(`${id}:r1`);
    expect(second).not.toBe(first);
  });

  it('gives every subsequent pause its own key too', async () => {
    const id = await seedCase();
    await claimPausedCaseForResume(t.db, id);

    // Paused again, resumed again.
    await t.db
      .update(schema.recoveryCases)
      .set({ state: 'paused' })
      .where(eq(schema.recoveryCases.id, id));
    const second = await claimPausedCaseForResume(t.db, id);

    expect(second!.resumeCount).toBe(2);
    expect(runKeyFor(id, second!.resumeCount)).toBe(`${id}:r2`);
  });

  it('records the resume in the ledger', async () => {
    const id = await seedCase();
    await claimPausedCaseForResume(t.db, id);

    const events = await t.db
      .select()
      .from(schema.caseEvents)
      .where(eq(schema.caseEvents.caseId, id));
    const resumed = events.find((e) => e.reason === 'resumed');
    expect(resumed).toBeDefined();
    expect(resumed!.fromState).toBe('paused');
    expect(resumed!.toState).toBe('executing');
  });
});

describe('only one caller can resume a case', () => {
  it('refuses the second claim, so two resumers cannot start two ladders', async () => {
    /*
     * The switch and the sweep both resume, and they can fire on the same case
     * at the same moment. The claim is a conditional UPDATE on `state =
     * 'paused'`, so exactly one wins and the other must get nothing. If both
     * got a row, both would publish, Inngest would start two ladders under two
     * different run keys, and the customer would get every remaining message
     * twice.
     */
    const id = await seedCase();

    const first = await claimPausedCaseForResume(t.db, id);
    const second = await claimPausedCaseForResume(t.db, id);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect((await caseRow(id)).resumeCount).toBe(1);
  });

  it('refuses to resume a case that is not paused', async () => {
    for (const state of ['executing', 'recovered', 'lost', 'aborted'] as const) {
      const id = await seedCase({ state });
      expect(await claimPausedCaseForResume(t.db, id)).toBeNull();
    }
  });
});

describe('going live is a decision, and the preview is what it is made on', () => {
  it('splits parked cases into what will be messaged and what will be closed', async () => {
    const fresh = await seedCase({ createdAt: hoursAgo(2) });
    const stale = await seedCase({ createdAt: daysAgo(6) });
    const expired = await seedCase({ createdAt: daysAgo(1), deadlineAt: hoursAgo(1) });

    const p = await preview(t.db, merchantId, NOW);

    expect(p.paused).toBe(3);
    expect(p.resumable).toBe(1);
    expect(p.tooOld).toBe(1);
    expect(p.pastDeadline).toBe(1);

    const by = new Map(p.cases.map((c) => [c.id, c.disposition]));
    expect(by.get(fresh)).toBe('resume');
    expect(by.get(stale)).toBe('too_old');
    expect(by.get(expired)).toBe('past_deadline');
  });

  it('changes nothing — a person opening the dialog has not decided yet', async () => {
    const id = await seedCase({ createdAt: daysAgo(6) });
    await preview(t.db, merchantId, NOW);
    // Still parked. If the preview closed the stale ones, looking at your
    // options would be the same act as taking them.
    expect((await caseRow(id)).state).toBe('paused');
  });

  it('masks the contact, because this list gets screenshotted', async () => {
    await seedCase({ createdAt: hoursAgo(2) });
    const p = await preview(t.db, merchantId, NOW);
    const contact = p.cases[0]!.customerContact ?? '';
    expect(contact).toContain('•');
  });
});

describe('applying the decision', () => {
  it('resumes the fresh and closes the stale, on the resume choice', async () => {
    const fresh = await seedCase({ createdAt: hoursAgo(2) });
    const stale = await seedCase({ createdAt: daysAgo(6) });

    const pub = recorder();
    const out = await apply(t.db, merchantId, 'resume', NOW, pub.publish);

    expect(out.resumed).toBe(1);
    expect(out.closed).toBe(1);
    expect((await caseRow(fresh)).state).toBe('executing');

    // `aborted`, not `lost`. We chose not to treat it rather than tried and
    // failed, and the incrementality report must not count it as a failure.
    const s = await caseRow(stale);
    expect(s.state).toBe('aborted');
    expect(s.resolvedAt).not.toBeNull();
  });

  it('closes EVERYTHING on the contact-nobody choice, including the fresh ones', async () => {
    const fresh = await seedCase({ createdAt: hoursAgo(2) });
    const stale = await seedCase({ createdAt: daysAgo(6) });

    const out = await apply(t.db, merchantId, 'none', NOW, recorder().publish);

    expect(out.resumed).toBe(0);
    expect(out.closed).toBe(2);
    expect((await caseRow(fresh)).state).toBe('aborted');
    expect((await caseRow(stale)).state).toBe('aborted');
  });

  it('marks a past-deadline case lost rather than aborted', async () => {
    // It DID run out of runway, which is what `lost` means. Recording it as an
    // abort would say we stopped deliberately, and we did not.
    const id = await seedCase({ createdAt: daysAgo(1), deadlineAt: hoursAgo(1) });
    await apply(t.db, merchantId, 'resume', NOW, recorder().publish);
    expect((await caseRow(id)).state).toBe('lost');
  });

  it('records why each case was closed, in its own ledger', async () => {
    const stale = await seedCase({ createdAt: daysAgo(6) });
    await apply(t.db, merchantId, 'resume', NOW, recorder().publish);

    const events = await t.db
      .select()
      .from(schema.caseEvents)
      .where(eq(schema.caseEvents.caseId, stale));
    const closed = events.find((e) => e.reason === 'stale_after_pause');
    expect(closed).toBeDefined();
    expect(closed!.fromState).toBe('paused');
    expect(closed!.toState).toBe('aborted');
  });

  it('re-decides at apply time, not from the preview the browser was holding', async () => {
    // A dialog can sit open for an hour. A case that was resumable when it was
    // drawn may not be when the button is finally pressed.
    const id = await seedCase({ createdAt: daysAgo(2) });

    const early = await preview(t.db, merchantId, NOW);
    expect(early.cases.find((c) => c.id === id)!.disposition).toBe('resume');

    const muchLater = new Date(NOW.getTime() + 5 * 24 * 3_600_000);
    await apply(t.db, merchantId, 'resume', muchLater, recorder().publish);

    expect((await caseRow(id)).state).not.toBe('executing');
  });
});

describe('when the ladder cannot actually be started', () => {
  it('puts the case back to paused instead of stranding it in executing', async () => {
    /*
     * The claim and the publish are two steps, and the second one can fail:
     * Inngest unreachable, a missing event key, a network blip.
     *
     * Leaving the case `executing` after that is the worst of both worlds. The
     * state says a ladder is running, none is, and nothing looks for it —
     * every sweep and every resume path scans `paused`. The case would sit
     * there until its deadline quietly wrote it off, having sent nothing and
     * reported nothing.
     */
    const id = await seedCase({ createdAt: hoursAgo(2) });

    const out = await apply(t.db, merchantId, 'resume', NOW, async () => {
      throw new Error('Inngest is unreachable');
    });

    expect(out.resumed).toBe(0);
    expect(out.errors).toHaveLength(1);

    const c = await caseRow(id);
    expect(c.state).toBe('paused');
    // The counter is NOT rolled back: it has already been spent as a run key,
    // and reusing it could collide with a run the failed attempt may yet have
    // started before it threw.
    expect(c.resumeCount).toBe(1);
  });

  it('leaves it retryable, so the sweep picks it up on the next pass', async () => {
    await t.db
      .update(schema.merchants)
      .set({ executionEnabled: true })
      .where(eq(schema.merchants.id, merchantId));
    const id = await seedCase({ createdAt: hoursAgo(2) });

    await apply(t.db, merchantId, 'resume', NOW, async () => {
      throw new Error('down');
    }).catch(() => undefined);

    expect((await listResumableCases(t.db)).map((r) => r.id)).toContain(id);

    // And the retry works once the engine is back, under a fresh run key.
    const pub = recorder();
    const out = await resumeAllLiveMerchants(t.db, 200, NOW, pub.publish);
    expect(out.resumed).toBe(1);
    expect(pub.sent[0]!.runKey).toBe(`${id}:r2`);
  });
});

describe('the sweep applies the same rule as the button', () => {
  it('wakes the fresh and closes the stale, with no person involved', async () => {
    await t.db
      .update(schema.merchants)
      .set({ executionEnabled: true })
      .where(eq(schema.merchants.id, merchantId));

    const fresh = await seedCase({ createdAt: hoursAgo(2) });
    const stale = await seedCase({ createdAt: daysAgo(9) });

    const out = await resumeAllLiveMerchants(t.db, 200, NOW, recorder().publish);

    expect(out.resumed).toBe(1);
    expect(out.closed).toBe(1);
    expect((await caseRow(fresh)).state).toBe('executing');
    expect((await caseRow(stale)).state).toBe('aborted');
  });
});

describe('what the resume paths scan', () => {
  it('lists this merchant’s paused cases', async () => {
    const a = await seedCase();
    const b = await seedCase();
    await seedCase({ state: 'executing' });

    const paused = (await listPausedCases(t.db, merchantId)).map((r) => r.id).sort();
    expect(paused).toEqual([a, b].sort());
  });

  it('leaves a paused merchant’s cases alone in the cross-tenant sweep', async () => {
    // The join is the whole point. Pausing an account and leaving it paused
    // must not slowly leak its cases back into execution fifteen minutes later.
    await seedCase();
    expect(await listResumableCases(t.db)).toHaveLength(0);

    await t.db
      .update(schema.merchants)
      .set({ executionEnabled: true })
      .where(eq(schema.merchants.id, merchantId));
    expect(await listResumableCases(t.db)).toHaveLength(1);
  });

  it('does not resume cases belonging to a different, still-paused merchant', async () => {
    const otherId = await seedMerchant(t.db, { slug: 'other', executionEnabled: true });
    await seedCase(); // this merchant is paused

    const otherCustomer = await seedCustomer(t.db, otherId, { transactionalBasisAt: NOW });
    const [live] = await t.db
      .insert(schema.recoveryCases)
      .values({
        merchantId: otherId,
        customerId: otherCustomer,
        type: 'payment_failure',
        state: 'paused',
        amountAtRiskPaise: 1000,
        rzpOrderId: 'order_OTHER',
        method: 'card',
        attended: true,
        policyId: 'instrument_dead.card_expired',
        policyVersion: 1,
      })
      .returning({ id: schema.recoveryCases.id });

    const resumable = await listResumableCases(t.db);
    expect(resumable.map((r) => r.id)).toEqual([live!.id]);
  });
});
