import { NextResponse } from 'next/server';

import { getDb } from '../../../../db/client';
import { appendEvent, getCase } from '../../../../db/repos/cases';
import { createVoiceCall } from '../../../../db/repos/voice-calls';
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
  const body = (await request.json().catch(() => ({}))) as { caseId?: string; vapiCallId?: string };
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
    actor: 'voice_agent',
    payload: { vapiCallId: body.vapiCallId, voiceCallId: created.id, channel: 'web' },
  });

  return NextResponse.json({ ok: true, voiceCallId: created.id });
}
