/**
 * The downtime feed.
 *
 * Maintained from Razorpay's Payment Downtime API and its `payment.downtime.*`
 * webhooks. `findActiveDowntime` is read on every diagnosis, which is why the
 * index covers open rows only.
 *
 * This is the table that lets a ladder say "your bank is back online" instead
 * of "please try again" — and that stops us nudging someone into a second
 * failure while the outage is still open.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';

import type { DowntimeWindow } from '../../core/taxonomy/diagnose.js';
import type { PaymentMethod } from '../../core/case/types.js';
import type { Database } from '../client.js';
import { downtimeWindows } from '../schema/ops.js';

export interface UpsertDowntimeInput {
  id: string;
  method: PaymentMethod;
  bank?: string | null;
  network?: string | null;
  issuer?: string | null;
  psp?: string | null;
  severity?: 'low' | 'medium' | 'high';
  status: string;
  startedAt: Date;
  resolvedAt?: Date | null;
}

/** Idempotent: `downtime.started` and `.updated` for one outage are one row. */
export async function upsertDowntime(db: Database, input: UpsertDowntimeInput): Promise<void> {
  const values = {
    id: input.id,
    method: input.method as never,
    bank: input.bank ? input.bank.toUpperCase() : null,
    network: input.network ? input.network.toUpperCase() : null,
    issuer: input.issuer ? input.issuer.toUpperCase() : null,
    psp: input.psp ?? null,
    severity: (input.severity ?? 'medium') as never,
    status: input.status,
    startedAt: input.startedAt,
    resolvedAt: input.resolvedAt ?? null,
  };

  await db
    .insert(downtimeWindows)
    .values(values)
    .onConflictDoUpdate({
      target: downtimeWindows.id,
      set: {
        status: values.status,
        severity: values.severity,
        resolvedAt: values.resolvedAt,
        updatedAt: sql`now()`,
      },
    });
}

export async function resolveDowntime(db: Database, id: string, at: Date): Promise<void> {
  await db
    .update(downtimeWindows)
    .set({ resolvedAt: at, status: 'resolved', updatedAt: sql`now()` })
    .where(and(eq(downtimeWindows.id, id), isNull(downtimeWindows.resolvedAt)));
}

/** Open outages, shaped for `DiagnoseContext.activeDowntime`. */
export async function findActiveDowntime(db: Database): Promise<DowntimeWindow[]> {
  const rows = await db
    .select()
    .from(downtimeWindows)
    .where(isNull(downtimeWindows.resolvedAt));

  return rows.map((r) => ({
    method: r.method as PaymentMethod,
    bank: r.bank,
    network: r.network,
    severity: r.severity,
    startedAt: r.startedAt,
  }));
}

/** Is a specific outage still open? Read before a parked case resumes. */
export async function isDowntimeOpen(db: Database, id: string): Promise<boolean> {
  const rows = await db
    .select({ id: downtimeWindows.id })
    .from(downtimeWindows)
    .where(and(eq(downtimeWindows.id, id), isNull(downtimeWindows.resolvedAt)))
    .limit(1);
  return rows.length > 0;
}
