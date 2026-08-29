import { NextResponse } from 'next/server';

import { getDb } from '../../../../db/client';
import {
  getConsoleMerchant,
  getRecentActivity,
  getRecoverableCases,
  getRecoverySummary,
} from '../../../../db/queries/recovery';
import { currentMerchantId } from '../../../../lib/merchant-context';
import { fireDueFollowUps } from '../../../../messaging/recovery-run';

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
  // The account the console is pointed at, never "the first one".
  const merchantId = await currentMerchantId(db);
  const merchant = merchantId ? await getConsoleMerchant(db, merchantId) : null;
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


  return NextResponse.json({
    ok: true,
    merchant,
    // Where messages will ACTUALLY land — read from the merchant's own routing
    // columns, the same ones the senders read. Reading it from environment
    // variables meant the banner could report a diversion the sender was not
    // applying, which is worse than showing nothing at all.
    routing: {
      whatsappRedirectTo: merchant.whatsappRedirectTo,
      emailRedirectTo: merchant.emailRedirectTo,
      emailFrom: merchant.emailFrom,
    },
    cases,
    activity,
    summary,
    fired,
    now: new Date().toISOString(),
  });
}
