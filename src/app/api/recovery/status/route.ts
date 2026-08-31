import { NextResponse } from 'next/server';

import { getDb, isQueryTimeout } from '../../../../db/client';
import { cookies } from 'next/headers';

import {
  getConsoleMerchantBySlug,
  getRecentActivity,
  getRecoverableCases,
  getRecoverySummary,
} from '../../../../db/queries/recovery';
import { MERCHANT_COOKIE } from '../../../../lib/merchant-context';
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

export async function GET(request: Request): Promise<NextResponse> {
  try {
    return await status(request);
  } catch (error) {
    // Answer, always. A poll that throws leaves the console showing whatever it
    // last saw, with no indication the data has stopped moving — which is how a
    // wedged backend looked like a working page for four hours.
    if (isQueryTimeout(error)) {
      return NextResponse.json(
        {
          ok: false,
          // Deliberately does not blame a stale connection any more. It said
          // that for weeks while the real cause was a query queued behind a
          // cross-region round trip, and a confidently wrong error message sent
          // everyone looking in the wrong place. State the symptom only.
          reason: 'The database did not answer in time. Retrying.',
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

async function status(request: Request): Promise<NextResponse> {
  const db = getDb();
  // The account the console is pointed at, never "the first one" — resolved in
  // a single query rather than the two this route used to make on every poll.
  const jar = await cookies();
  const merchant = await getConsoleMerchantBySlug(db, jar.get(MERCHANT_COOKIE)?.value ?? null);
  if (!merchant) {
    return NextResponse.json({ ok: false, reason: 'no merchant' }, { status: 404 });
  }

  // Fire first, then read — so a follow-up that just went out is visible in
  // the same response rather than appearing one poll later.
  const fired = merchant.executionEnabled ? await fireDueFollowUps(db, merchant.id) : [];

  /*
   * Activity is fetched only when someone is looking at it.
   *
   * It is the most expensive read on this route — two queries, and the slowest
   * of the set — and the panel that displays it is collapsed by default. Every
   * poll was therefore paying for a table nobody had opened, four seconds
   * apart, forever. On a route this hot that is most of the budget spent on
   * none of the value.
   */
  const wantsActivity = new URL(request.url).searchParams.get('activity') === '1';

  const [cases, activity, summary] = await Promise.all([
    getRecoverableCases(db, merchant.id),
    wantsActivity ? getRecentActivity(db, merchant.id, 40) : Promise.resolve(null),
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
