/**
 * `payment.downtime.started` / `.updated` / `.resolved`.
 *
 * The feed that makes the transient-infrastructure ladder honest.
 *
 * Without it, "the bank is having trouble" means guessing a retry delay and
 * hoping. With it, a case parks until Razorpay says the outage cleared and then
 * strikes — and "your bank is back online, tap to finish" is a message we can
 * actually stand behind, rather than "please try again" sent into an outage
 * that is still ongoing.
 */

import type { PaymentMethod } from '../../core/case/types.js';
import { normalizeBank, normalizeMethod, normalizeTimestamp } from '../../core/taxonomy/normalize.js';
import type { Database } from '../../db/client.js';
import { resolveDowntime, upsertDowntime } from '../../db/repos/downtime.js';
import type { RazorpayDowntimeEntity } from '../../adapters/razorpay/types.js';

export interface DowntimeResult {
  id: string | null;
  action: 'opened' | 'updated' | 'resolved' | 'ignored';
  method: PaymentMethod;
  bank: string | null;
}

function severityOf(entity: RazorpayDowntimeEntity): 'low' | 'medium' | 'high' {
  const s = entity.severity;
  return s === 'low' || s === 'medium' || s === 'high' ? s : 'medium';
}

export async function handleDowntime(
  db: Database,
  entity: RazorpayDowntimeEntity,
  event: string,
  now: Date,
): Promise<DowntimeResult> {
  const id = typeof entity.id === 'string' ? entity.id : null;
  const method = normalizeMethod(entity.method);

  // The bank sits in different places depending on the rail: `instrument.bank`
  // for netbanking, `instrument.issuer` for cards. Both normalise to the same
  // uppercase code the diagnosis tuple carries, or they would never join.
  const instrument = entity.instrument ?? {};
  const bank = normalizeBank(instrument.bank ?? instrument.issuer);
  const network = normalizeBank(instrument.network);

  if (!id) return { id: null, action: 'ignored', method, bank };

  if (event === 'payment.downtime.resolved' || entity.status === 'resolved') {
    const resolvedAt = normalizeTimestamp(entity.end) ?? now;
    await resolveDowntime(db, id, resolvedAt);
    return { id, action: 'resolved', method, bank };
  }

  const startedAt = normalizeTimestamp(entity.begin) ?? now;
  await upsertDowntime(db, {
    id,
    method,
    bank,
    network,
    issuer: normalizeBank(instrument.issuer),
    psp: typeof instrument.psp === 'string' ? instrument.psp : null,
    severity: severityOf(entity),
    status: typeof entity.status === 'string' ? entity.status : 'started',
    startedAt,
    resolvedAt: null,
  });

  return {
    id,
    action: event === 'payment.downtime.started' ? 'opened' : 'updated',
    method,
    bank,
  };
}
