import { NextResponse } from 'next/server';

import { getDb, isQueryTimeout } from '../../../../db/client';
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
/**
 * The console polls this every 2.5s, so it is the route most likely to land on
 * a warm instance and the one that must never sit there. 30s is a ceiling, not
 * a target — the queries below run in well under a second when the connection
 * is healthy, and the client-side query timeout fails them at 10s when it is
 * not.
 */
export const maxDuration = 30;

export async function GET(): Promise<NextResponse> {
  try {
    return await status();
  } catch (error) {
    // Answer, always. A poll that throws leaves the console showing whatever it
    // last saw, with no indication the data has stopped moving — which is how a
    // wedged backend looked like a working page for four hours.
    if (isQueryTimeout(error)) {
      return NextResponse.json(
        {
          ok: false,
          reason:
            'The database did not respond. The stale connection has been dropped; ' +
            'the next poll will reconnect.',
        },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { ok: false, reason: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

async function status(): Promise<NextResponse> {
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
