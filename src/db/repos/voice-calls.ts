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

export async function getVoiceCall(db: Database, id: string) {
  const rows = await db.select().from(voiceCalls).where(eq(voiceCalls.id, id)).limit(1);
  return rows.at(0) ?? null;
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
