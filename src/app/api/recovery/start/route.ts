import { NextResponse } from 'next/server';

import { getDb } from '../../../../db/client';
import { getConsoleMerchant } from '../../../../db/queries/recovery';
import { startRecovery } from '../../../../messaging/recovery-run';

/**
 * Start a recovery for one case.
 *
 * Sends WhatsApp immediately and schedules the email follow-up. Everything it
 * does goes through the same gate, composition and send path the real ladder
 * uses — the only difference is that a human decided when, instead of a timer.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json().catch(() => ({}))) as { caseId?: string };
  if (!body.caseId) {
    return NextResponse.json({ ok: false, reason: 'caseId is required' }, { status: 400 });
  }

  const db = getDb();
  const merchant = await getConsoleMerchant(db);
  if (!merchant) {
    return NextResponse.json({ ok: false, reason: 'no merchant' }, { status: 404 });
  }

  // Only 'off' is refused here. A DRY RUN is a legitimate thing to start —
  // it exercises the gate, the copy and the ledger and sends nothing — so
  // refusing it would make the console offer a button that cannot work.
  if (!merchant.executionEnabled) {
    return NextResponse.json(
      { ok: false, reason: 'Sending is off. Switch to Dry run or Live to start a recovery.' },
      { status: 409 },
    );
  }

  const result = await startRecovery(db, body.caseId);
  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}
