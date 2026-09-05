import { NextResponse } from 'next/server';

import { getDb } from '../../../../db/client';
import { appendEvent, getCase } from '../../../../db/repos/cases';
import { countCallsForCase, createVoiceCall } from '../../../../db/repos/voice-calls';
import { MAX_CALLS_PER_CASE } from '../../../../core/guards/call-limit';
import { currentMerchantId } from '../../../../lib/merchant-context';

/**
 * Register a browser-based (WebRTC) call the client already started.
 *
 * Vapi's Web SDK starts a call directly from the browser — there is no
 * server-side "place this call" step the way there is for a real phone call,
 * so nothing here creates a call. It only records the mapping from the call
 * id the browser was handed back to the case it's about, the moment the call
 * starts, so the webhook (`tool-calls`, `end-of-call-report`) can find the
 * right case the same way it does for a real phone call — same guardrail,
 * same payment-link logic, same dashboard row. The only thing that differs
 * is the transport.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json().catch(() => ({}))) as {
    caseId?: string;
    vapiCallId?: string;
    /** True when the operator passed the per-case call limit knowingly. */
    override?: boolean;
  };
  if (!body.caseId || !body.vapiCallId) {
    return NextResponse.json({ ok: false, reason: 'caseId and vapiCallId are required' }, { status: 400 });
  }

  const db = getDb();
  const merchantId = await currentMerchantId(db);
  if (!merchantId) {
    return NextResponse.json({ ok: false, reason: 'no merchant' }, { status: 404 });
  }

  const recoveryCase = await getCase(db, body.caseId);
  if (!recoveryCase || recoveryCase.merchantId !== merchantId) {
    return NextResponse.json({ ok: false, reason: 'case not found' }, { status: 404 });
  }

  /*
   * The limit is enforced at `/authorize-call`, before the browser dials. By
   * the time we are here the phone has already rung, so refusing would only
   * orphan a live call — the webhook would have no case to attach the
   * conversation, the discount guard or the payment link to, which is strictly
   * worse than the extra call.
   *
   * What this DOES do is record the truth: how many calls this case had when
   * the call started, and whether a person overrode the ceiling to place it.
   * An override that leaves no trace is indistinguishable from no ceiling.
   */
  const callsBefore = await countCallsForCase(db, recoveryCase.id);
  const pastLimit = callsBefore >= MAX_CALLS_PER_CASE;

  const created = await createVoiceCall(db, {
    caseId: recoveryCase.id,
    merchantId,
    vapiCallId: body.vapiCallId,
    customerPhone: 'web-call',
  });

  await appendEvent(db, {
    caseId: recoveryCase.id,
    merchantId,
    kind: 'voice_call_placed',
    // The reason field is what the case timeline shows, so an overridden call
    // reads as one at a glance rather than only in the payload.
    reason: pastLimit ? 'call_limit_override' : null,
    // 'merchant' is the actor this codebase already uses for a person's own
    // decision (see the resume path), so an overridden call is attributed the
    // same way a manual resume is.
    actor: pastLimit ? 'merchant' : 'voice_agent',
    payload: {
      vapiCallId: body.vapiCallId,
      voiceCallId: created.id,
      channel: 'web',
      callsBefore,
      limit: MAX_CALLS_PER_CASE,
      override: pastLimit && body.override === true,
    },
  });

  return NextResponse.json({ ok: true, voiceCallId: created.id, callsBefore, overLimit: pastLimit });
}
