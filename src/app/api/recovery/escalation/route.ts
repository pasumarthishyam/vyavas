import { NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';

import { getDb } from '../../../../db/client';
import { escalations } from '../../../../db/schema/queues';
import { acknowledgeEscalation, closeEscalation } from '../../../../db/repos/escalations';
import { currentMerchantId } from '../../../../lib/merchant-context';

/**
 * Acting on an escalation from the console.
 *
 * The rest of the console is read-only by design, and this is a deliberate
 * exception rather than a drift: an escalation queue nobody can clear is the
 * same failure as the `case_actions` row nobody read, one layer up. A queue
 * that only accumulates gets ignored within a week, and an ignored queue is
 * worse than no queue because it looks like coverage.
 *
 * Three transitions, and the distinction between the last two is kept because
 * it is the one that tells you whether the queue is worth having:
 *
 *   acknowledge  a person has picked this up. Needs a name.
 *   resolve      a person acted and it is done.
 *   dismiss      a person looked and there was nothing to do.
 *
 * Every write is scoped to the merchant the console is pointed at, checked
 * against the row rather than trusted from the request. Without that check an
 * id from one account would close an escalation on another — the same class of
 * bug as a Start click on the Sandbox page running against the live account.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export type EscalationAction = 'acknowledge' | 'resolve' | 'dismiss';

interface Body {
  id?: string;
  action?: EscalationAction;
  by?: string;
  note?: string;
}

export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json().catch(() => ({}))) as Body;
  const { id, action } = body;

  if (!id || !action || !['acknowledge', 'resolve', 'dismiss'].includes(action)) {
    return NextResponse.json(
      { ok: false, reason: 'id and a valid action are required' },
      { status: 400 },
    );
  }

  const db = getDb();
  const merchantId = await currentMerchantId(db);
  if (!merchantId) {
    return NextResponse.json({ ok: false, reason: 'no merchant' }, { status: 404 });
  }

  // Ownership, from the row. The id in the request proves nothing about which
  // account it belongs to.
  const [row] = await db
    .select({ id: escalations.id })
    .from(escalations)
    .where(
      and(
        eq(escalations.id, id),
        eq(escalations.merchantId, merchantId),
        inArray(escalations.status, ['open', 'acknowledged']),
      ),
    )
    .limit(1);

  if (!row) {
    return NextResponse.json(
      { ok: false, reason: 'not found, or already closed' },
      { status: 404 },
    );
  }

  if (action === 'acknowledge') {
    // A name, because an unassigned acknowledgement tells the next person
    // nothing except that the row has been touched.
    const by = body.by?.trim() || 'console';
    const ok = await acknowledgeEscalation(db, id, by);
    return NextResponse.json({ ok, action, by });
  }

  const note = body.note?.trim() || `${action} from the console`;
  const ok = await closeEscalation(db, id, action === 'resolve' ? 'resolved' : 'dismissed', note);
  return NextResponse.json({ ok, action, note });
}
