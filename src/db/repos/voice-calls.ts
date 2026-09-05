/**
 * The discount-caller agent's own repo.
 *
 * Everything here is scoped to `voice_calls`, keyed by Vapi's own call id.
 * Nothing here ever writes to `recovery_cases.rzp_payment_link_id/url` — see
 * the header comment on `db/schema/voice.ts` for why that boundary matters.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { voiceCalls } from '../schema/voice.js';

export interface CreateVoiceCallInput {
  caseId: string;
  merchantId: string;
  vapiCallId: string;
  customerPhone: string;
}

/** Idempotent on `vapiCallId` — a retried create returns the existing row. */
export async function createVoiceCall(
  db: Database,
  input: CreateVoiceCallInput,
): Promise<{ id: string; created: boolean }> {
  const inserted = await db
    .insert(voiceCalls)
    .values({
      caseId: input.caseId,
      merchantId: input.merchantId,
      vapiCallId: input.vapiCallId,
      customerPhone: input.customerPhone,
    })
    .onConflictDoNothing({ target: voiceCalls.vapiCallId })
    .returning({ id: voiceCalls.id });

  const row = inserted.at(0);
  if (row) return { id: row.id, created: true };

  const existing = await getVoiceCallByVapiId(db, input.vapiCallId);
  if (!existing) {
    throw new Error(`voice_calls insert conflicted but no row for vapiCallId ${input.vapiCallId} was found`);
  }
  return { id: existing.id, created: false };
}

export async function getVoiceCallByVapiId(db: Database, vapiCallId: string) {
  const rows = await db.select().from(voiceCalls).where(eq(voiceCalls.vapiCallId, vapiCallId)).limit(1);
  return rows.at(0) ?? null;
}

/**
 * Calls placed on this case, in ANY state.
 *
 * Counts failures and unanswered calls too, deliberately. What the per-case
 * limit bounds is how many times this person's phone rings — an unanswered call
 * rang exactly as often as an answered one. Counting only completed calls would
 * let three no-answers become an unbounded redial loop.
 */
export async function countCallsForCase(db: Database, caseId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(voiceCalls)
    .where(eq(voiceCalls.caseId, caseId));
  return Number(row?.n ?? 0);
}

export async function getVoiceCall(db: Database, id: string) {
  const rows = await db.select().from(voiceCalls).where(eq(voiceCalls.id, id)).limit(1);
  return rows.at(0) ?? null;
}

/**
 * The call a Razorpay payment link was created on.
 *
 * Lets an inbound `payment_link.paid` confirm a negotiated payment immediately,
 * rather than waiting for the end-of-call report (which fires before the
 * customer has usually paid) or the sweep behind it.
 */
export async function getVoiceCallByPaymentLinkId(
  db: Database,
  merchantId: string,
  paymentLinkId: string,
) {
  const rows = await db
    .select()
    .from(voiceCalls)
    .where(and(eq(voiceCalls.merchantId, merchantId), eq(voiceCalls.paymentLinkId, paymentLinkId)))
    .limit(1);
  return rows.at(0) ?? null;
}

/** Mark a call's link paid by the call's own row id, not Vapi's call id. */
export async function markPaymentConfirmedById(db: Database, id: string): Promise<void> {
  await db
    .update(voiceCalls)
    .set({ paymentConfirmedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(voiceCalls.id, id));
}

export async function updateVoiceCallStatus(
  db: Database,
  vapiCallId: string,
  status: 'queued' | 'ringing' | 'in_progress' | 'ended' | 'failed',
): Promise<void> {
  await db
    .update(voiceCalls)
    .set({
      status,
      updatedAt: sql`now()`,
      ...(status === 'in_progress' ? { startedAt: sql`coalesce(started_at, now())` } : {}),
    })
    .where(eq(voiceCalls.vapiCallId, vapiCallId));
}

export async function recordDiscountOffer(
  db: Database,
  vapiCallId: string,
  tier: 1 | 2,
  amountPaise: number,
): Promise<void> {
  await db
    .update(voiceCalls)
    .set({ discountTierOffered: tier, discountAmountPaise: amountPaise, updatedAt: sql`now()` })
    .where(eq(voiceCalls.vapiCallId, vapiCallId));
}

export async function recordPaymentLink(
  db: Database,
  vapiCallId: string,
  link: { id: string; url: string; amountPaise: number },
): Promise<void> {
  await db
    .update(voiceCalls)
    .set({
      discountAccepted: true,
      paymentLinkId: link.id,
      paymentLinkUrl: link.url,
      paymentLinkAmountPaise: link.amountPaise,
      updatedAt: sql`now()`,
    })
    .where(eq(voiceCalls.vapiCallId, vapiCallId));
}

export async function recordEndOfCall(
  db: Database,
  vapiCallId: string,
  input: {
    transcript: unknown;
    recordingUrl: string | null;
    endedReason: string | null;
    durationSeconds: number | null;
  },
): Promise<void> {
  await db
    .update(voiceCalls)
    .set({
      status: 'ended',
      transcript: (input.transcript ?? null) as never,
      recordingUrl: input.recordingUrl,
      endedReason: input.endedReason,
      durationSeconds: input.durationSeconds,
      endedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(eq(voiceCalls.vapiCallId, vapiCallId));
}

export async function markPaymentConfirmed(db: Database, vapiCallId: string): Promise<void> {
  await db
    .update(voiceCalls)
    .set({ paymentConfirmedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(voiceCalls.vapiCallId, vapiCallId));
}

/** Calls with no terminal status yet — what a status sync needs to check. */
export async function listPendingVoiceCalls(db: Database, merchantId: string) {
  return db
    .select()
    .from(voiceCalls)
    .where(
      and(
        eq(voiceCalls.merchantId, merchantId),
        sql`${voiceCalls.status} in ('queued', 'ringing', 'in_progress')`,
      ),
    );
}

/**
 * Apply a status snapshot fetched directly from Vapi's API.
 *
 * The fallback path for when Vapi's account-level Server URL was never
 * configured (or is briefly unreachable) and the normal webhook events never
 * arrive — see `/api/voice-agent/sync`. Deliberately narrower than
 * `recordEndOfCall`: no transcript or recording, because Vapi's `GET /call`
 * response doesn't carry the full artifact the webhook does.
 */
export async function syncVoiceCallFromVapi(
  db: Database,
  vapiCallId: string,
  snapshot: {
    status: 'queued' | 'ringing' | 'in_progress' | 'ended' | 'failed';
    endedReason: string | null;
    durationSeconds: number | null;
  },
): Promise<void> {
  await db
    .update(voiceCalls)
    .set({
      status: snapshot.status,
      endedReason: snapshot.endedReason,
      durationSeconds: snapshot.durationSeconds,
      updatedAt: sql`now()`,
      ...(snapshot.status === 'ended' || snapshot.status === 'failed' ? { endedAt: sql`now()` } : {}),
    })
    .where(eq(voiceCalls.vapiCallId, vapiCallId));
}

export async function listRecentVoiceCalls(db: Database, merchantId: string, limit = 50) {
  return db
    .select()
    .from(voiceCalls)
    .where(eq(voiceCalls.merchantId, merchantId))
    .orderBy(desc(voiceCalls.createdAt))
    .limit(limit);
}

export async function listVoiceCallsForCase(db: Database, caseId: string) {
  return db.select().from(voiceCalls).where(eq(voiceCalls.caseId, caseId)).orderBy(desc(voiceCalls.createdAt));
}

/** Calls that ended with a link created but never confirmed paid — the phase-2 sweep's input. */
export async function listUnconfirmedEndedCalls(db: Database, limit = 100) {
  return db
    .select()
    .from(voiceCalls)
    .where(
      and(
        eq(voiceCalls.status, 'ended'),
        isNull(voiceCalls.paymentConfirmedAt),
        sql`${voiceCalls.paymentLinkId} is not null`,
      ),
    )
    .limit(limit);
}
