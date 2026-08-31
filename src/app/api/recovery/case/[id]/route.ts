import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

import { getDb, isQueryTimeout } from '../../../../../db/client';
import { getCaseTrace, getConsoleMerchantBySlug } from '../../../../../db/queries/recovery';
import { MERCHANT_COOKIE } from '../../../../../lib/merchant-context';

/**
 * One case's full trace, for the console's side drawer.
 *
 * The row already carries the newest step; this is only ever fetched when
 * someone actually opens a case, so it costs nothing on the poll that drives
 * the rest of the page.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const db = getDb();
    const jar = await cookies();
    const merchant = await getConsoleMerchantBySlug(db, jar.get(MERCHANT_COOKIE)?.value ?? null);
    if (!merchant) {
      return NextResponse.json({ ok: false, reason: 'no merchant' }, { status: 404 });
    }

    const trace = await getCaseTrace(db, merchant.id, id);
    return NextResponse.json({ ok: true, trace });
  } catch (error) {
    if (isQueryTimeout(error)) {
      return NextResponse.json(
        { ok: false, reason: 'The database did not answer in time.' },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { ok: false, reason: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
