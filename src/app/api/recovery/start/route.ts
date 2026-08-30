import { NextResponse } from 'next/server';

import { getDb, isQueryTimeout } from '../../../../db/client';
import { getConsoleMerchant } from '../../../../db/queries/recovery';
import { currentMerchantId } from '../../../../lib/merchant-context';
import { startRecovery } from '../../../../messaging/recovery-run';

/**
 * Start a recovery for one case.
 *
 * Sends WhatsApp immediately and schedules the email follow-up. Everything it
 * does goes through the same gate, composition and send path the real ladder
 * uses — the only difference is that a human decided when, instead of a timer.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * This route makes real outbound calls — a Razorpay payment link, then a
 * WhatsApp send — so it needs more than the platform default. 60s is the
 * ceiling every Vercel plan allows, Hobby included; a value the plan refuses
 * fails the deployment rather than degrading.
 */
export const maxDuration = 60;

/**
 * The server's own budget, deliberately under the console's 45s abort.
 *
 * The console gives up at 45s. If the server has no deadline of its own, that
 * abort is all there is — the browser shows "the request never came back" and
 * there is nothing anywhere saying why, because the route was still running
 * when its only observer left. A server-side deadline turns the same failure
 * into a response the UI can render and a log line that names the stage.
 *
 * Work already done is not rolled back, and must not be: a message that reached
 * a real person is recorded in `message_log` whatever this route returns. The
 * ledger is the truth, not the HTTP status.
 */
const BUDGET_MS = 38_000;

function deadline<T>(work: Promise<T>, ms: number): Promise<T | 'timed-out'> {
  return Promise.race([
    work,
    new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), ms)),
  ]);
}

export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json().catch(() => ({}))) as { caseId?: string; force?: boolean };
  if (!body.caseId) {
    return NextResponse.json({ ok: false, reason: 'caseId is required' }, { status: 400 });
  }

  try {
    const db = getDb();
    // The account the console is pointed at, never "the first one".
    const merchantId = await currentMerchantId(db);
    const merchant = merchantId ? await getConsoleMerchant(db, merchantId) : null;
    if (!merchant) {
      return NextResponse.json({ ok: false, reason: 'no merchant' }, { status: 404 });
    }

    // Only 'off' is refused here. A DRY RUN is a legitimate thing to start —
    // it exercises the gate, the copy and the ledger and sends nothing — so
    // refusing it would make the console offer a button that cannot work.
    if (!merchant.executionEnabled) {
      return NextResponse.json(
        { ok: false, reason: 'Sending is off. Switch to Dry run or Live to start a recovery.' },
        { status: 409 },
      );
    }

    // `force` only ever arrives from an explicit confirm in the console. It
    // relaxes the duplicate guard and nothing else — every other precondition,
    // including consent and the kill switch, is evaluated exactly as normal.
    const result = await deadline(
      startRecovery(db, body.caseId, { force: body.force === true }),
      BUDGET_MS,
    );

    if (result === 'timed-out') {
      return NextResponse.json(
        {
          ok: false,
          reason:
            `Gave up after ${BUDGET_MS / 1000}s waiting on Razorpay or WhatsApp. ` +
            'Anything that did go out is in the activity log below — check there before retrying.',
        },
        { status: 504 },
      );
    }

    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
  } catch (error) {
    // A connection that stopped answering is not a bug in this route, and it
    // clears on its own: the client has already been discarded, so the next
    // request builds a fresh one. Say that, rather than a bare 500.
    if (isQueryTimeout(error)) {
      return NextResponse.json(
        {
          ok: false,
          reason:
            'The database did not respond. The stale connection has been dropped — ' +
            'try again and it will reconnect.',
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
