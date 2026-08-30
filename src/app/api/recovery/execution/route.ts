import { NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';

import { getDb } from '../../../../db/client';
import { merchants } from '../../../../db/schema/tenancy';
import { getConsoleMerchant } from '../../../../db/queries/recovery';
import { currentMerchantId } from '../../../../lib/merchant-context';

/**
 * The send mode.
 *
 * THREE states, not two, because the system genuinely has three and collapsing
 * them made the console lie — the button offered a dry run while the gate
 * refused it, since `execution_enabled: false` is an abort:
 *
 *   off       nothing runs. The gate aborts every rung.
 *   dry_run   everything runs — gate, composition, ledger — and nothing is
 *             sent. This is the useful middle: you see exactly what would go
 *             out, to whom, with the real copy.
 *   live      everything runs and messages reach real recipients.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A webhook or a console mutation is short work, but it must never be allowed to
// sit forever on a connection that stopped answering. A ceiling, not a target.
export const maxDuration = 30;

export type SendMode = 'off' | 'dry_run' | 'live';

export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json().catch(() => ({}))) as { mode?: SendMode };
  const mode: SendMode =
    body.mode === 'live' ? 'live' : body.mode === 'dry_run' ? 'dry_run' : 'off';

  const db = getDb();
  // The account the console is pointed at, never "the first one".
  const merchantId = await currentMerchantId(db);
  const merchant = merchantId ? await getConsoleMerchant(db, merchantId) : null;
  if (!merchant) {
    return NextResponse.json({ ok: false, reason: 'no merchant' }, { status: 404 });
  }

  const executionEnabled = mode !== 'off';
  const dryRun = mode !== 'live';

  await db
    .update(merchants)
    .set({ executionEnabled, dryRun, updatedAt: sql`now()` })
    .where(eq(merchants.id, merchant.id));

  return NextResponse.json({ ok: true, mode, executionEnabled, dryRun });
}
