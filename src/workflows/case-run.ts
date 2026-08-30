/**
 * Reload the diagnosis facts a running ladder needs.
 *
 * The diagnosis was computed once, at ingest, and its conclusions were written
 * to the case. The workflow needs two of them back — the permitted rails and
 * whether same-instrument retry survived the attempt history — because a rung's
 * `suggest` list must be filtered through them before it becomes a message.
 *
 * Read from the ledger rather than recomputed: re-running `diagnose()` now
 * would use TODAY's attempt history and downtime feed, and could quietly
 * re-authorise something the original diagnosis ruled out. The case is executed
 * under the diagnosis it was given, exactly like the policy version stamped
 * beside it.
 */

import { and, desc, eq } from 'drizzle-orm';

import type { AlternateRail } from '../core/case/types.js';
import type { Database } from '../db/client.js';
import { caseEvents, recoveryCases } from '../db/schema/cases.js';

export interface CaseRunContext {
  createdAt: Date;
  /**
   * The point past which this case is closed regardless.
   *
   * The ladder needs it to know how long a deferred rung is worth waiting for.
   * Without it the workflow has no way to distinguish "wait three hours for the
   * frequency cap to clear" from "wait past the end of the case", and it
   * guessed — which is how a recoverable case was abandoned an hour before its
   * gate would have opened.
   */
  deadlineAt: Date | null;
  rails: AlternateRail[];
  sameInstrumentRetry: boolean;
}

export async function loadCaseForRun(
  db: Database,
  caseId: string,
): Promise<CaseRunContext | null> {
  const rows = await db
    .select({ createdAt: recoveryCases.createdAt, deadlineAt: recoveryCases.deadlineAt })
    .from(recoveryCases)
    .where(eq(recoveryCases.id, caseId))
    .limit(1);

  const row = rows.at(0);
  if (!row) return null;

  // The most recent `diagnosed` entry. There can be several when an order
  // failed repeatedly, and the latest is the one the ladder is running under.
  const events = await db
    .select({ payload: caseEvents.payload })
    .from(caseEvents)
    .where(and(eq(caseEvents.caseId, caseId), eq(caseEvents.kind, 'diagnosed')))
    .orderBy(desc(caseEvents.occurredAt))
    .limit(1);

  const payload = (events.at(0)?.payload ?? {}) as Record<string, unknown>;
  const rails = Array.isArray(payload.suggestedRails)
    ? (payload.suggestedRails as AlternateRail[])
    : [];

  return {
    createdAt: row.createdAt,
    deadlineAt: row.deadlineAt,
    rails,
    // Defaults to FALSE when the ledger does not say. The conservative
    // direction: never re-present an instrument we cannot confirm is safe to
    // re-present.
    sameInstrumentRetry: payload.sameInstrumentRetry === true,
  };
}
