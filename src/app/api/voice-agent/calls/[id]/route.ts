import { NextResponse } from 'next/server';

import { getDb } from '../../../../../db/client';
import { getVoiceCall } from '../../../../../db/repos/voice-calls';
import { currentMerchantId } from '../../../../../lib/merchant-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const db = getDb();
  const merchantId = await currentMerchantId(db);
  if (!merchantId) {
    return NextResponse.json({ ok: false, reason: 'no merchant' }, { status: 404 });
  }

  const call = await getVoiceCall(db, id);
  if (!call || call.merchantId !== merchantId) {
    return NextResponse.json({ ok: false, reason: 'not found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true, call });
}
