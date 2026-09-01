import { NextResponse } from 'next/server';

import { getDb } from '../../../../db/client';
import { appendEvent } from '../../../../db/repos/cases';
import { listPendingVoiceCalls, syncVoiceCallFromVapi } from '../../../../db/repos/voice-calls';
import { currentMerchantId } from '../../../../lib/merchant-context';
import { requireVapiConfig } from '../../../../lib/env';
import { createVapiClient, getCall } from '../../../../adapters/vapi/client';

/**
 * Pull live status for every non-terminal call directly from Vapi's API.
 *
 * A deliberate fallback, not the primary path — the primary path is Vapi's
 * own webhook (`/api/voice-agent/webhook`), which requires the assistant's
 * Server URL to be configured in the Vapi dashboard. This route exists so the
 * dashboard is never silently frozen while that's unset or briefly down: a
 * call stuck at `queued` gets its real status the moment someone clicks
 * "Sync status", rather than staying a mystery.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function mapStatus(raw: string | undefined): 'queued' | 'ringing' | 'in_progress' | 'ended' | 'failed' {
  const s = (raw ?? '').replace(/-/g, '_');
  if (s === 'queued' || s === 'ringing' || s === 'in_progress' || s === 'ended' || s === 'failed') return s;
  return 'queued';
}

export async function POST(): Promise<NextResponse> {
  const db = getDb();
  const merchantId = await currentMerchantId(db);
  if (!merchantId) {
    return NextResponse.json({ ok: false, reason: 'no merchant' }, { status: 404 });
  }

  let vapi;
  try {
    vapi = requireVapiConfig();
  } catch (e) {
    return NextResponse.json({ ok: false, reason: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }

  const client = createVapiClient({ apiKey: vapi.apiKey });
  const pending = await listPendingVoiceCalls(db, merchantId);

  let synced = 0;
  const errors: string[] = [];

  for (const row of pending) {
    try {
      const call = await getCall(client, row.vapiCallId);
      // `ended` on Vapi's side but no `endedReason` we recognise as an error
      // still counts as ended — the important distinction for the dashboard
      // is "this is not going anywhere", not the exact taxonomy of why.
      const status =
        call.status === 'ended'
          ? typeof call['endedReason'] === 'string' && call['endedReason'].length > 0
            ? 'failed'
            : 'ended'
          : mapStatus(call.status);

      const endedReason = typeof call['endedReason'] === 'string' ? call['endedReason'] : null;
      const durationSeconds =
        typeof call['startedAt'] === 'string' && typeof call['endedAt'] === 'string'
          ? Math.max(
              0,
              Math.round(
                (new Date(call['endedAt'] as string).getTime() - new Date(call['startedAt'] as string).getTime()) /
                  1000,
              ),
            )
          : null;

      await syncVoiceCallFromVapi(db, row.vapiCallId, { status, endedReason, durationSeconds });

      if (status === 'ended' || status === 'failed') {
        await appendEvent(db, {
          caseId: row.caseId,
          merchantId,
          kind: 'voice_call_synced',
          actor: 'voice_agent',
          payload: { vapiCallId: row.vapiCallId, status, endedReason },
        });
      }

      synced++;
    } catch (e) {
      errors.push(`${row.vapiCallId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return NextResponse.json({ ok: true, checked: pending.length, synced, errors });
}
