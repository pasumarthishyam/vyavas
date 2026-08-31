/**
 * The escalation queue.
 *
 * Writes are idempotent on the SAME key the action row uses, built by the same
 * `idempotencyKey()` in core. A workflow replay after a deploy re-runs the rung
 * and must not produce a second queue entry — and the reason the key comes from
 * one function rather than being rebuilt here is written up on `messageKey`:
 * two callers composing the same key in two formats is a guard that is inert
 * across exactly the boundary it exists to hold.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import type { CauseClass } from '../../core/taxonomy/cause-class.js';
import type { EscalationQueue } from '../../core/actions/types.js';
import type { Database } from '../client.js';
import { escalations } from '../schema/queues.js';

export interface CreateEscalationInput {
  caseId: string;
  merchantId: string;
  queue: EscalationQueue;
  rung: number;
  /** From `idempotencyKey(caseId, action)`. Never rebuilt locally. */
  idempotencyKey: string;

  headline: string;
  whatHappened?: string | null;
  whatWeTried?: string | null;
  whatIsBlocking?: string | null;
  recommendedAction?: string | null;
  briefConfidence?: string | null;
  /** `claude` when the model wrote it, `fallback` when it did not. */
  briefSource: 'claude' | 'fallback';
  briefError?: string | null;

  amountAtRiskPaise: number;
  causeClass?: CauseClass | null;
}

export interface CreateEscalationResult {
  /** Null when this rung had already been escalated — a replay. */
  id: string | null;
  created: boolean;
}

/**
 * Queue a case for a human.
 *
 * `ON CONFLICT DO NOTHING` rather than an upsert: once a person has been asked
 * to look at a rung, re-running the rung must not overwrite the brief they are
 * reading, or reopen something they already resolved.
 */
export async function createEscalation(
  db: Database,
  input: CreateEscalationInput,
): Promise<CreateEscalationResult> {
  const inserted = await db
    .insert(escalations)
    .values({
      caseId: input.caseId,
      merchantId: input.merchantId,
      queue: input.queue,
      rung: input.rung,
      idempotencyKey: input.idempotencyKey,
      headline: input.headline,
      whatHappened: input.whatHappened ?? null,
      whatWeTried: input.whatWeTried ?? null,
      whatIsBlocking: input.whatIsBlocking ?? null,
      recommendedAction: input.recommendedAction ?? null,
      briefConfidence: input.briefConfidence ?? null,
      briefSource: input.briefSource,
      briefError: input.briefError ?? null,
      amountAtRiskPaise: input.amountAtRiskPaise,
      causeClass: input.causeClass ?? null,
    })
    .onConflictDoNothing({ target: escalations.idempotencyKey })
    .returning({ id: escalations.id });

  const id = inserted.at(0)?.id ?? null;
  return { id, created: id !== null };
}

export interface OpenEscalation {
  id: string;
  caseId: string;
  merchantId: string;
  queue: EscalationQueue;
  status: 'open' | 'acknowledged';
  headline: string;
  whatHappened: string | null;
  whatWeTried: string | null;
  whatIsBlocking: string | null;
  recommendedAction: string | null;
  briefConfidence: string | null;
  briefSource: string;
  amountAtRiskPaise: number;
  causeClass: CauseClass | null;
  assignedTo: string | null;
  createdAt: Date;
}

/** The queue view. Newest first — an escalation is most actionable when fresh. */
export async function listOpenEscalations(
  db: Database,
  opts: { merchantId?: string; queue?: EscalationQueue; limit?: number } = {},
): Promise<OpenEscalation[]> {
  const filters = [inArray(escalations.status, ['open', 'acknowledged'] as const)];
  if (opts.merchantId) filters.push(eq(escalations.merchantId, opts.merchantId));
  if (opts.queue) filters.push(eq(escalations.queue, opts.queue));

  const rows = await db
    .select()
    .from(escalations)
    .where(and(...filters))
    .orderBy(desc(escalations.createdAt))
    .limit(opts.limit ?? 100);

  return rows.map((r) => ({
    id: r.id,
    caseId: r.caseId,
    merchantId: r.merchantId,
    queue: r.queue,
    status: r.status as 'open' | 'acknowledged',
    headline: r.headline,
    whatHappened: r.whatHappened,
    whatWeTried: r.whatWeTried,
    whatIsBlocking: r.whatIsBlocking,
    recommendedAction: r.recommendedAction,
    briefConfidence: r.briefConfidence,
    briefSource: r.briefSource,
    amountAtRiskPaise: Number(r.amountAtRiskPaise),
    causeClass: r.causeClass,
    assignedTo: r.assignedTo,
    createdAt: r.createdAt,
  }));
}

export async function acknowledgeEscalation(
  db: Database,
  id: string,
  assignedTo: string,
): Promise<boolean> {
  const rows = await db
    .update(escalations)
    .set({ status: 'acknowledged', assignedTo, acknowledgedAt: sql`now()` })
    .where(and(eq(escalations.id, id), eq(escalations.status, 'open')))
    .returning({ id: escalations.id });
  return rows.length > 0;
}

/**
 * Close an escalation.
 *
 * `dismissed` and `resolved` are kept apart deliberately: "I looked and there
 * was nothing to do" and "I fixed it" are different facts, and a queue that is
 * mostly the former is a queue that should not exist in its current form.
 */
export async function closeEscalation(
  db: Database,
  id: string,
  outcome: 'resolved' | 'dismissed',
  note: string,
): Promise<boolean> {
  const rows = await db
    .update(escalations)
    .set({ status: outcome, resolutionNote: note, resolvedAt: sql`now()` })
    .where(and(eq(escalations.id, id), inArray(escalations.status, ['open', 'acknowledged'])))
    .returning({ id: escalations.id });
  return rows.length > 0;
}

/** Queue depth by queue, for the dashboard and for the self-audit. */
export async function countOpenEscalations(
  db: Database,
  merchantId?: string,
): Promise<{ queue: EscalationQueue; count: number }[]> {
  const filters = [inArray(escalations.status, ['open', 'acknowledged'] as const)];
  if (merchantId) filters.push(eq(escalations.merchantId, merchantId));

  const rows = await db
    .select({ queue: escalations.queue, n: sql<number>`count(*)::int` })
    .from(escalations)
    .where(and(...filters))
    .groupBy(escalations.queue);

  return rows.map((r) => ({ queue: r.queue, count: Number(r.n) }));
}
