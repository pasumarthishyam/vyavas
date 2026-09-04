import { NextResponse } from 'next/server';

import { getDb } from '../../../../db/client';
import { appendEvent, getCase } from '../../../../db/repos/cases';
import { getCustomer } from '../../../../db/repos/customers';
import { getMerchant } from '../../../../db/queries/dashboard';
import { isTerminal } from '../../../../core/case/types';
import { RESUME_MAX_AGE_DAYS } from '../../../../core/guards/resume';
import { createVoiceCall, listRecentVoiceCalls } from '../../../../db/repos/voice-calls';
import { currentMerchantId } from '../../../../lib/merchant-context';
import { allowedTestNumbers, isAllowedTestNumber, requireVapiConfig, voiceAgentEnabled } from '../../../../lib/env';
import { createCall, createVapiClient } from '../../../../adapters/vapi/client';

/**
 * Place an outbound discount-negotiation call for one case.
 *
 * Deliberately separate from `/api/recovery/start` — this is a different
 * agent, with a different risk profile (it can move a price), and it must
 * never inherit the ladder's execution-enabled flag or anything else from
 * that surface by accident.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json().catch(() => ({}))) as { caseId?: string };
  if (!body.caseId) {
    return NextResponse.json({ ok: false, reason: 'caseId is required' }, { status: 400 });
  }

  if (!voiceAgentEnabled()) {
    return NextResponse.json(
      { ok: false, reason: 'VOICE_AGENT_ENABLED is not set to true. This agent is off.' },
      { status: 409 },
    );
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
   * The same two rules the ladder obeys, enforced here rather than assumed.
   *
   * This route checked neither, so a discount call could be placed on a case
   * whose account was paused, or on one whose payment failed a fortnight ago —
   * both of which the failed-payment agent refuses. A second agent that can
   * reach the same customer must not be the way around the first one's gate.
   *
   * Read from the merchant and the case rather than from what the console sent:
   * the button is disabled for these, and a disabled button is a courtesy, not
   * a control.
   */
  const merchant = await getMerchant(db, merchantId);
  if (!merchant?.executionEnabled) {
    return NextResponse.json(
      { ok: false, reason: 'this agent is paused for this account' },
      { status: 409 },
    );
  }

  if (isTerminal(recoveryCase.state)) {
    return NextResponse.json(
      { ok: false, reason: `this case is ${recoveryCase.state} — there is nothing to recover` },
      { status: 409 },
    );
  }

  const ageDays = Math.floor((Date.now() - recoveryCase.createdAt.getTime()) / 86_400_000);
  if (ageDays > RESUME_MAX_AGE_DAYS) {
    return NextResponse.json(
      {
        ok: false,
        reason: `the payment failed ${ageDays} days ago — too long ago to call about`,
      },
      { status: 409 },
    );
  }

  const customer = recoveryCase.customerId ? await getCustomer(db, recoveryCase.customerId) : null;
  if (!customer?.phone) {
    return NextResponse.json({ ok: false, reason: 'no phone number on file for this customer' }, { status: 409 });
  }

  // THE hard safety rail — independent of anything configured in Vapi,
  // Twilio or Telnyx. A wrong caseId or a bug upstream can never result in
  // dialing a number that isn't explicitly allow-listed.
  if (!isAllowedTestNumber(customer.phone)) {
    return NextResponse.json(
      {
        ok: false,
        reason: `${customer.phone} is not in VOICE_AGENT_ALLOWED_TEST_NUMBERS. Allowed: ${allowedTestNumbers().join(', ') || '(none configured)'}`,
      },
      { status: 403 },
    );
  }

  let vapi;
  try {
    vapi = requireVapiConfig();
  } catch (e) {
    return NextResponse.json({ ok: false, reason: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }

  try {
    const client = createVapiClient({ apiKey: vapi.apiKey });
    const call = await createCall(client, {
      assistantId: vapi.assistantId,
      phoneNumberId: vapi.phoneNumberId,
      customerNumber: customer.phone,
      metadata: { caseId: recoveryCase.id },
    });

    if (!call.id) {
      return NextResponse.json({ ok: false, reason: 'Vapi did not return a call id' }, { status: 502 });
    }

    const created = await createVoiceCall(db, {
      caseId: recoveryCase.id,
      merchantId,
      vapiCallId: call.id,
      customerPhone: customer.phone,
    });

    await appendEvent(db, {
      caseId: recoveryCase.id,
      merchantId,
      kind: 'voice_call_placed',
      actor: 'voice_agent',
      payload: { vapiCallId: call.id, voiceCallId: created.id },
    });

    return NextResponse.json({ ok: true, voiceCallId: created.id, vapiCallId: call.id });
  } catch (e) {
    return NextResponse.json(
      { ok: false, reason: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  const db = getDb();
  const merchantId = await currentMerchantId(db);
  if (!merchantId) {
    return NextResponse.json({ ok: false, reason: 'no merchant' }, { status: 404 });
  }

  const url = new URL(request.url);
  const limit = Number(url.searchParams.get('limit') ?? '50');

  const calls = await listRecentVoiceCalls(db, merchantId, Number.isFinite(limit) ? limit : 50);
  return NextResponse.json({ ok: true, calls });
}
