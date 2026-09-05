import { NextResponse } from 'next/server';

import { getDb } from '../../../../db/client';
import { getCase } from '../../../../db/repos/cases';
import { countCallsForCase } from '../../../../db/repos/voice-calls';
import { authorizeCall, callLimitWarning, MAX_CALLS_PER_CASE } from '../../../../core/guards/call-limit';
import { currentMerchantId } from '../../../../lib/merchant-context';

/**
 * May this case be called right now?
 *
 * Asked BEFORE the browser starts a Vapi call, because a web call is started
 * client-side — by the time `/web-calls` registers it, the customer's phone has
 * already rung. A guard that ran at registration would be a record of a rule
 * being broken, not a rule.
 *
 * The count comes from the database, not from the console's own state. The page
 * holds a `callCount` from whenever it last rendered, and two operators on two
 * screens would each see "1 call" and each place a second one.
 *
 * `override: true` is only ever sent after a person has read the warning and
 * confirmed. It is not a parameter any automated path passes, and the decision
 * comes back marked as an override so the caller records it as one.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json().catch(() => ({}))) as {
    caseId?: unknown;
    override?: unknown;
  };

  const caseId = typeof body.caseId === 'string' ? body.caseId : '';
  if (caseId.length === 0) {
    return NextResponse.json({ ok: false, reason: 'caseId is required' }, { status: 400 });
  }

  const db = getDb();
  const merchantId = await currentMerchantId(db);
  if (!merchantId) {
    return NextResponse.json({ ok: false, reason: 'no merchant' }, { status: 404 });
  }

  const recoveryCase = await getCase(db, caseId);
  if (!recoveryCase || recoveryCase.merchantId !== merchantId) {
    return NextResponse.json({ ok: false, reason: 'case not found' }, { status: 404 });
  }

  const callsPlaced = await countCallsForCase(db, caseId);
  const decision = authorizeCall({ callsPlaced, override: body.override === true });

  return NextResponse.json({
    ok: true,
    callsPlaced,
    limit: MAX_CALLS_PER_CASE,
    allowed: decision.allowed,
    // The console needs three states, not two: go ahead, stop, and "stop unless
    // a person says otherwise" — which is the one that opens the warning.
    requiresOverride: !decision.allowed,
    usedOverride: decision.allowed && decision.override,
    reason: decision.allowed && !decision.override ? null : callLimitWarning(callsPlaced),
  });
}
