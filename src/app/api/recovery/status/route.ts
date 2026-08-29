import { NextResponse } from 'next/server';

import { getDb } from '../../../../db/client';
import {
  getConsoleMerchant,
  getRecentActivity,
  getRecoverableCases,
  getRecoverySummary,
} from '../../../../db/queries/recovery';
import { fireDueFollowUps } from '../../../../messaging/recovery-run';
import { env } from '../../../../lib/env';

/**
 * Live state for the console, and the thing that fires due follow-ups.
 *
 * The console polls this, so the poll IS the scheduler for the email step.
 * That is honest for a test surface and stated plainly in the UI: close the
 * page and a pending follow-up waits rather than firing. The real ladder uses
 * Inngest, which does not care whether anyone is watching.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const db = getDb();
  const merchant = await getConsoleMerchant(db);
  if (!merchant) {
    return NextResponse.json({ ok: false, reason: 'no merchant' }, { status: 404 });
  }

  // Fire first, then read — so a follow-up that just went out is visible in
  // the same response rather than appearing one poll later.
  const fired = merchant.executionEnabled ? await fireDueFollowUps(db, merchant.id) : [];

  const [cases, activity, summary] = await Promise.all([
    getRecoverableCases(db, merchant.id),
    getRecentActivity(db, merchant.id, 25),
    getRecoverySummary(db, merchant.id),
  ]);

  const e = env();

  return NextResponse.json({
    ok: true,
    merchant,
    // Where messages will ACTUALLY land. Without this the console can say
    // "sending is on" while every WhatsApp message is quietly diverted — or,
    // worse, while it is not and a real customer is about to be messaged.
    routing: {
      whatsappRedirectTo: e.WHATSAPP_REDIRECT_TO ?? null,
      emailFrom: e.EMAIL_FROM ?? null,
    },
    cases,
    activity,
    summary,
    fired,
    now: new Date().toISOString(),
  });
}
