import { NextResponse } from 'next/server';

import { getDb } from '../../../../db/client';
import { parseWebhook, isOptOut } from '../../../../adapters/whatsapp/webhook';
import { optOutByPhone, recordDeliveryStatus } from '../../../../messaging/send';
import { normalizePhone } from '../../../../db/repos/customers';
import { requireWhatsAppVerifyToken } from '../../../../lib/env';

/**
 * The WhatsApp webhook.
 *
 * GET  — Meta's one-time subscription handshake. It sends a challenge and our
 *        verify token; we echo the challenge back as PLAIN TEXT if the token
 *        matches. JSON here fails the handshake with no useful error.
 *
 * POST — delivery receipts and customer replies.
 *
 * Always 200 on anything accepted. A non-2xx makes Meta retry, and a retried
 * "STOP" that fails twice is a customer we kept messaging.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A webhook or a console mutation is short work, but it must never be allowed to
// sit forever on a connection that stopped answering. A ceiling, not a target.
export const maxDuration = 30;

export function GET(request: Request): Response {
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  let expected: string;
  try {
    expected = requireWhatsAppVerifyToken();
  } catch {
    return new Response('verify token not configured', { status: 503 });
  }

  if (mode === 'subscribe' && token === expected && challenge) {
    // Plain text, not JSON — Meta compares the body byte for byte.
    return new Response(challenge, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  return new Response('forbidden', { status: 403 });
}

export async function POST(request: Request): Promise<NextResponse> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    // Malformed body: accept it so Meta stops retrying, and say so.
    return NextResponse.json({ ok: false, reason: 'malformed_json' }, { status: 200 });
  }

  const { statuses, messages } = parseWebhook(payload);
  const db = getDb();

  let matched = 0;
  let optedOut = 0;

  for (const s of statuses) {
    // `sent` adds nothing — the send path already recorded it. Only the
    // outcomes we did not already know are worth a write.
    if (s.status === 'sent') continue;

    const r = await recordDeliveryStatus(
      db,
      s.providerMessageId,
      s.status,
      s.errorDetail ?? undefined,
    );
    if (r.matched) matched++;
  }

  for (const m of messages) {
    if (!isOptOut(m.text)) continue;

    // Meta reports the sender without a leading '+'; the same normaliser the
    // ingest path uses is what makes this match the stored customer.
    const phone = normalizePhone(m.from);
    if (!phone) continue;

    const r = await optOutByPhone(db, phone, `replied "${m.text.slice(0, 60)}"`);
    optedOut += r.optedOut;
  }

  return NextResponse.json({
    ok: true,
    statuses: statuses.length,
    matched,
    messages: messages.length,
    optedOut,
  });
}
