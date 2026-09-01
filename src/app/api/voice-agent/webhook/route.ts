import { NextResponse } from 'next/server';

import { getDb, type Database } from '../../../../db/client';
import { appendEvent, getCase, transitionCase } from '../../../../db/repos/cases';
import { getCustomer } from '../../../../db/repos/customers';
import { getMerchant } from '../../../../db/queries/dashboard';
import {
  getVoiceCallByVapiId,
  markPaymentConfirmed,
  recordDiscountOffer,
  recordEndOfCall,
  recordPaymentLink,
  updateVoiceCallStatus,
} from '../../../../db/repos/voice-calls';
import { vapiServerSecret } from '../../../../lib/env';
import { SECRET_HEADER, verifyVapiWebhook } from '../../../../adapters/vapi/webhook';
import { parseEnvelope, type ParsedVapiMessage, type VapiToolCall } from '../../../../adapters/vapi/types';
import { razorpayForMerchant } from '../../../../workflows/merchant-clients';
import { cancelPaymentLink, createPaymentLink, fetchPaymentLink } from '../../../../adapters/razorpay/resources';
import { proposeDiscount } from '../../../../core/guards/discount';
import type { CauseClass } from '../../../../core/taxonomy/cause-class';
import { formatINR, paise, type Paise } from '../../../../core/money';

/**
 * Everything Vapi calls back into.
 *
 * `tool-calls` messages are answered synchronously while a live call is
 * paused waiting — everything on that path is deterministic (the guardrail,
 * one DB read/write, one Razorpay call) and must stay fast. `end-of-call-
 * report` is where this agent closes its own loop: it asks Razorpay directly
 * whether the link it created was paid, rather than depending on the shared
 * `payment_link.paid` webhook — see the header comment on `db/schema/voice.ts`
 * for why that link cannot be resolved the normal way.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 25;

type ToolResult = { toolCallId: string; result: string };

export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = await request.text();

  const verify = verifyVapiWebhook(request.headers.get(SECRET_HEADER), vapiServerSecret());
  if (!verify.ok) {
    return NextResponse.json({ ok: false, reason: verify.reason }, { status: 401 });
  }
  if (!verify.verified) {
    // Deliberately not fatal during the trial phase — see webhook.ts. Logged
    // so it stays visible rather than silently normal.
    console.warn(`[voice-agent webhook] ${verify.reason}`);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, reason: 'invalid JSON' }, { status: 400 });
  }

  const message = parseEnvelope(payload);
  const db = getDb();

  if (message.type === 'status-update') {
    if (message.call.id && message.status) {
      await updateVoiceCallStatus(db, message.call.id, mapStatus(message.status));
    }
    return NextResponse.json({ ok: true });
  }

  if (message.type === 'tool-calls') {
    if (!message.call.id) {
      return NextResponse.json({ ok: false, reason: 'no call id on tool-calls message' }, { status: 400 });
    }
    const results: ToolResult[] = [];
    for (const call of message.toolCalls) {
      results.push(await handleToolCall(db, message.call.id, call));
    }
    return NextResponse.json({ results });
  }

  if (message.type === 'end-of-call-report') {
    if (message.call.id) {
      await handleEndOfCall(db, message.call.id, message);
    }
    return NextResponse.json({ ok: true });
  }

  // Unrecognised message types are acknowledged, not failed — Vapi has more
  // event types than this agent currently acts on, and a 4xx/5xx here would
  // make Vapi retry a webhook this code was never going to do anything with.
  return NextResponse.json({ ok: true, note: 'unrecognised message type, ignored' });
}

function mapStatus(raw: string): 'queued' | 'ringing' | 'in_progress' | 'ended' | 'failed' {
  const s = raw.replace(/-/g, '_');
  if (s === 'queued' || s === 'ringing' || s === 'in_progress' || s === 'ended' || s === 'failed') return s;
  return 'in_progress';
}

// ─── tool calls ──────────────────────────────────────────────────────────────

async function handleToolCall(
  db: Database,
  vapiCallId: string,
  call: VapiToolCall,
): Promise<ToolResult> {
  if (call.name === 'propose_discount') {
    return { toolCallId: call.id, result: await handleProposeDiscount(db, vapiCallId) };
  }
  if (call.name === 'create_payment_link') {
    return { toolCallId: call.id, result: await handleCreatePaymentLink(db, vapiCallId) };
  }
  return { toolCallId: call.id, result: `Unknown tool '${call.name}' — no action taken.` };
}

async function handleProposeDiscount(db: Database, vapiCallId: string): Promise<string> {
  const voiceCall = await getVoiceCallByVapiId(db, vapiCallId);
  if (!voiceCall) return 'Could not look up this call. Do not offer a discount.';

  const recoveryCase = await getCase(db, voiceCall.caseId);
  if (!recoveryCase) return 'Could not look up the case for this call. Do not offer a discount.';

  // The model never chooses the tier — the next one is always exactly one
  // past whatever this call has already been granted. Asking twice at the
  // same tier, or asking for tier 2 before tier 1, both refuse on their own.
  const requestedTier = Math.min(voiceCall.discountTierOffered + 1, 2) as 1 | 2;

  const decision = proposeDiscount({
    orderAmountPaise: paise(Number(recoveryCase.amountAtRiskPaise)),
    requestedTier,
    alreadyOfferedTier: voiceCall.discountTierOffered as 0 | 1 | 2,
    causeClass: (recoveryCase.causeClass ?? null) as CauseClass | null,
  });

  await appendEvent(db, {
    caseId: recoveryCase.id,
    merchantId: recoveryCase.merchantId,
    kind: 'voice_discount_proposed',
    actor: 'voice_agent',
    payload: { vapiCallId, requestedTier, decision },
  });

  if (!decision.approved) {
    return `Not approved: ${decision.reason}. Do not offer a discount to the customer.`;
  }

  await recordDiscountOffer(db, vapiCallId, decision.tier, decision.amountPaise);

  return (
    `Approved: you may offer exactly ${formatINR(decision.amountPaise)} off (tier ${decision.tier}). ` +
    `Do not offer more than this.`
  );
}

async function handleCreatePaymentLink(db: Database, vapiCallId: string): Promise<string> {
  const voiceCall = await getVoiceCallByVapiId(db, vapiCallId);
  if (!voiceCall) return 'Could not look up this call. Tell the customer someone will follow up.';

  const recoveryCase = await getCase(db, voiceCall.caseId);
  if (!recoveryCase) return 'Could not look up the case. Tell the customer someone will follow up.';

  const merchant = await getMerchant(db, recoveryCase.merchantId);
  if (!merchant) return 'Could not look up the merchant. Tell the customer someone will follow up.';

  const customer = recoveryCase.customerId ? await getCustomer(db, recoveryCase.customerId) : null;

  const razorpay = await razorpayForMerchant(db, recoveryCase.merchantId);
  if (!razorpay) return 'No payment provider configured. Tell the customer someone will follow up.';

  const amountPaise: Paise =
    voiceCall.discountTierOffered > 0 && voiceCall.discountAmountPaise != null
      ? paise(Number(recoveryCase.amountAtRiskPaise) - Number(voiceCall.discountAmountPaise))
      : paise(Number(recoveryCase.amountAtRiskPaise));

  if (amountPaise < 100) {
    return 'The payable amount is below the minimum payment link amount. Tell the customer someone will follow up.';
  }

  try {
    // A separate link from the ladder's — never touches recoveryCases's own
    // payment-link columns. See db/schema/voice.ts for why.
    const link = await createPaymentLink(razorpay, {
      amountPaise,
      currency: 'INR',
      description: `Payment to ${merchant.name} — ${formatINR(amountPaise, { compact: true })}`,
      referenceId: recoveryCase.id,
      customer: {
        ...(customer?.name ? { name: customer.name } : {}),
        ...(customer?.email ? { email: customer.email } : {}),
        ...(voiceCall.customerPhone ? { contact: voiceCall.customerPhone } : {}),
      },
      notifySms: false,
      notifyEmail: false,
      notes: { vyavas_case_id: recoveryCase.id, vyavas_voice_call_id: voiceCall.id },
    });

    const url = typeof link.short_url === 'string' ? link.short_url : null;
    const id = typeof link.id === 'string' ? link.id : null;
    if (!url || !id) return 'Razorpay did not return a usable link. Tell the customer someone will follow up.';

    // Exactly one payable link per call: if a previous one exists on this
    // same call (e.g. a retried tool call), cancel it first rather than
    // leaving two ways to pay the same negotiated amount live at once.
    if (voiceCall.paymentLinkId && voiceCall.paymentLinkId !== id) {
      await cancelPaymentLink(razorpay, voiceCall.paymentLinkId).catch(() => undefined);
    }

    await recordPaymentLink(db, vapiCallId, { id, url, amountPaise });

    await appendEvent(db, {
      caseId: recoveryCase.id,
      merchantId: recoveryCase.merchantId,
      kind: 'voice_payment_link_created',
      actor: 'voice_agent',
      payload: { vapiCallId, paymentLinkId: id, url, amountPaise },
    });

    return `Payment link created for ${formatINR(amountPaise)}: ${url} — read this link to the customer clearly, slowly, and offer to text it as well.`;
  } catch (e) {
    return `Could not create the payment link (${e instanceof Error ? e.message : String(e)}). Tell the customer someone will follow up.`;
  }
}

// ─── end of call ─────────────────────────────────────────────────────────────

async function handleEndOfCall(
  db: Database,
  vapiCallId: string,
  message: Extract<ParsedVapiMessage, { type: 'end-of-call-report' }>,
): Promise<void> {
  const voiceCall = await getVoiceCallByVapiId(db, vapiCallId);
  if (!voiceCall) return;

  await recordEndOfCall(db, vapiCallId, {
    transcript: message.transcript,
    recordingUrl: message.recordingUrl,
    endedReason: message.endedReason,
    durationSeconds: message.durationSeconds,
  });

  await appendEvent(db, {
    caseId: voiceCall.caseId,
    merchantId: voiceCall.merchantId,
    kind: 'voice_call_ended',
    actor: 'voice_agent',
    payload: { vapiCallId, endedReason: message.endedReason, durationSeconds: message.durationSeconds },
  });

  // No link was ever created on this call — nothing to reconcile.
  if (!voiceCall.paymentLinkId) return;

  const razorpay = await razorpayForMerchant(db, voiceCall.merchantId);
  if (!razorpay) return;

  try {
    const link = await fetchPaymentLink(razorpay, voiceCall.paymentLinkId);
    if (link.status !== 'paid') return; // not yet — the phase-2 sweep re-checks later

    await markPaymentConfirmed(db, vapiCallId);

    await appendEvent(db, {
      caseId: voiceCall.caseId,
      merchantId: voiceCall.merchantId,
      kind: 'payment_received',
      actor: 'voice_agent',
      payload: {
        vapiCallId,
        paymentLinkId: voiceCall.paymentLinkId,
        amountPaise: voiceCall.paymentLinkAmountPaise,
      },
    });

    // `transitionCase` no-ops safely (ok:false) if the case is already
    // terminal — a race with the ladder's own webhook, or a replay, is not
    // an error here.
    await transitionCase(db, voiceCall.caseId, 'recovered', 'payment_received', {
      recoveredAmountPaise: voiceCall.paymentLinkAmountPaise ?? undefined,
      actor: 'voice_agent',
    });
  } catch {
    // Razorpay being briefly unreachable at exactly the end of a call must
    // not lose the record of the call itself — the row above is already
    // written. The phase-2 sweep is what catches this.
  }
}
