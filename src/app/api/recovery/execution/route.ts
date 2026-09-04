import { NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';

import { getDb } from '../../../../db/client';
import { merchants } from '../../../../db/schema/tenancy';
import { getConsoleMerchant } from '../../../../db/queries/recovery';
import { currentMerchantId } from '../../../../lib/merchant-context';
import { apply, preview, type ResumeChoice } from '../../../../workflows/resume';

/**
 * The send mode. Two states, and the pause is a real pause.
 *
 *   paused   the agent does nothing. Cases already in flight are PARKED in the
 *            `paused` state, keeping their rung, deadline and ledger.
 *   live     everything runs and messages reach whoever the routing points at.
 *
 * ── going live is a decision, not a toggle ──
 *
 * GET returns a preview: every parked case, and what resuming would do to each.
 * POST applies a choice. The two are separate on purpose — opening a dialog to
 * look at your options must not be the same act as taking them.
 *
 * The reason it needs a choice at all only shows up on a long pause. Rung times
 * are measured from when the payment failed, so a case parked past its rung
 * times fires the instant it is woken. Pause for a week, press Live, and a
 * hundred people hear from you at once about checkouts they abandoned last
 * Tuesday. Nobody asked for that; they asked to turn the agent back on.
 *
 * ── what changed before this ──
 *
 * There were three states and the first one was a trap. `off` made the gate
 * ABORT, and an abort is terminal, so pausing an account permanently destroyed
 * every case in flight. The middle state, `dry_run`, ran the whole ladder and
 * skipped only the provider call; it is gone, and its one safety guarantee
 * survives without it — a new merchant defaults to `execution_enabled: false`,
 * which is paused, and sends nothing until a person says otherwise.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * Applying publishes one Inngest event per woken case, so this is no longer a
 * single UPDATE. A ceiling, not a target.
 */
export const maxDuration = 60;

export type SendMode = 'paused' | 'live';

/** What resuming would do, so the console can ask before it does it. */
export async function GET(): Promise<NextResponse> {
  const db = getDb();
  const merchantId = await currentMerchantId(db);
  if (!merchantId) {
    return NextResponse.json({ ok: false, reason: 'no merchant' }, { status: 404 });
  }

  return NextResponse.json({ ok: true, preview: await preview(db, merchantId) });
}

export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json().catch(() => ({}))) as {
    mode?: string;
    resume?: string;
  };

  // Anything that is not explicitly 'live' is a pause. The safe direction: a
  // malformed request must never switch an account on.
  const mode: SendMode = body.mode === 'live' ? 'live' : 'paused';

  /*
   * And anything that is not explicitly 'resume' reaches nobody.
   *
   * Same reasoning in the other axis. A request that failed to say what it
   * wanted done with waiting customers must not be read as permission to
   * message them.
   */
  const choice: ResumeChoice = body.resume === 'resume' ? 'resume' : 'none';

  const db = getDb();
  const merchantId = await currentMerchantId(db);
  const merchant = merchantId ? await getConsoleMerchant(db, merchantId) : null;
  if (!merchant) {
    return NextResponse.json({ ok: false, reason: 'no merchant' }, { status: 404 });
  }

  const executionEnabled = mode === 'live';

  await db
    .update(merchants)
    .set({ executionEnabled, updatedAt: sql`now()` })
    .where(eq(merchants.id, merchant.id));

  /*
   * Going live: act on the parked cases.
   *
   * Deliberately AFTER the flag is written. A woken ladder re-reads the
   * merchant on its first rung, so publishing before the update would race it
   * and the case would park itself again immediately.
   *
   * Failure here is not failure of the switch. The account is live either way,
   * and the sweep resumes whatever this missed — so the mode change is reported
   * as the success it is, with the resume result beside it.
   */
  let applied: Awaited<ReturnType<typeof apply>> | null = null;
  if (executionEnabled) {
    try {
      applied = await apply(db, merchant.id, choice);
    } catch (e) {
      applied = {
        examined: 0,
        resumed: 0,
        closed: 0,
        skipped: 0,
        errors: [e instanceof Error ? e.message : String(e)],
      };
    }
  }

  return NextResponse.json({
    ok: true,
    mode,
    executionEnabled,
    ...(applied
      ? {
          resumed: applied.resumed,
          closed: applied.closed,
          examinedPaused: applied.examined,
        }
      : {}),
  });
}
