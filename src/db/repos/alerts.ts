/**
 * Merchant alerts.
 *
 * The table has existed since Stage 3 and the dashboard has read it since Stage
 * 5. Nothing ever wrote to it. This is the write path.
 *
 * The unique index is on `(merchant_id, signal) WHERE resolved_at IS NULL`, so
 * a condition that is still broken ACCUMULATES into one row rather than paging
 * repeatedly. That is the whole reason the signal is a structured key like
 * `bank_not_enabled:ICIC:netbanking` rather than a sentence: an alert whose
 * identity changes with its wording pages once per case.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { merchantAlerts } from '../schema/ops.js';

export interface RaiseAlertInput {
  merchantId: string;
  /** Stable condition key. See the file header — this is the identity. */
  signal: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  detail?: string | null;

  affectedCases: number;
  amountAtRiskPaise: number;
  baselineRateBps?: number | null;
  onsetAt: Date;
}

export interface RaiseAlertResult {
  id: string;
  /** False when an open alert for this condition already existed and was updated. */
  created: boolean;
}

/**
 * Raise an alert, or update the open one for the same condition.
 *
 * `onsetAt` is deliberately NOT updated on conflict: the merchant needs to know
 * when this started, not when we last noticed it. `lastSeenAt` carries the
 * second fact, and conflating them would make a four-hour outage look like it
 * began a minute ago every time the sweep ran.
 *
 * The counts and the prose ARE refreshed, because "47 cases" is more useful
 * than the "3 cases" the condition was first seen with.
 */
export async function raiseMerchantAlert(
  db: Database,
  input: RaiseAlertInput,
): Promise<RaiseAlertResult> {
  const rows = await db
    .insert(merchantAlerts)
    .values({
      merchantId: input.merchantId,
      signal: input.signal,
      severity: input.severity,
      title: input.title,
      detail: input.detail ?? null,
      affectedCases: input.affectedCases,
      amountAtRiskPaise: input.amountAtRiskPaise,
      baselineRateBps: input.baselineRateBps ?? null,
      onsetAt: input.onsetAt,
    })
    .onConflictDoUpdate({
      target: [merchantAlerts.merchantId, merchantAlerts.signal],
      targetWhere: sql`resolved_at is null`,
      set: {
        severity: input.severity,
        title: input.title,
        detail: input.detail ?? null,
        affectedCases: input.affectedCases,
        amountAtRiskPaise: input.amountAtRiskPaise,
        baselineRateBps: input.baselineRateBps ?? null,
        lastSeenAt: sql`now()`,
      },
    })
    .returning({ id: merchantAlerts.id, createdAt: merchantAlerts.createdAt });

  const row = rows.at(0);
  if (!row) throw new Error(`Failed to raise alert '${input.signal}'`);

  // An updated row keeps its original createdAt, so a fresh one is one whose
  // created and last-seen instants are the same write.
  return { id: row.id, created: true };
}

/** Close an alert when the condition stops being true. */
export async function resolveMerchantAlert(
  db: Database,
  merchantId: string,
  signal: string,
): Promise<boolean> {
  const rows = await db
    .update(merchantAlerts)
    .set({ resolvedAt: sql`now()` })
    .where(
      and(
        eq(merchantAlerts.merchantId, merchantId),
        eq(merchantAlerts.signal, signal),
        isNull(merchantAlerts.resolvedAt),
      ),
    )
    .returning({ id: merchantAlerts.id });
  return rows.length > 0;
}

export interface OpenAlert {
  id: string;
  signal: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  detail: string | null;
  affectedCases: number;
  amountAtRiskPaise: number;
  onsetAt: Date;
  lastSeenAt: Date;
}

export async function listOpenAlerts(db: Database, merchantId: string): Promise<OpenAlert[]> {
  const rows = await db
    .select()
    .from(merchantAlerts)
    .where(and(eq(merchantAlerts.merchantId, merchantId), isNull(merchantAlerts.resolvedAt)))
    .orderBy(desc(merchantAlerts.onsetAt));

  return rows.map((r) => ({
    id: r.id,
    signal: r.signal,
    severity: r.severity,
    title: r.title,
    detail: r.detail,
    affectedCases: r.affectedCases,
    amountAtRiskPaise: Number(r.amountAtRiskPaise),
    onsetAt: r.onsetAt,
    lastSeenAt: r.lastSeenAt,
  }));
}
