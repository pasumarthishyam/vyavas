import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';

import { getDb } from '../../../db/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Liveness plus a real round trip to Postgres.
 *
 * A health check that never touches the database is a lie: the process can be
 * perfectly alive while every request that matters fails.
 */
export async function GET(): Promise<NextResponse> {
  try {
    await getDb().execute(sql`select 1`);
    return NextResponse.json({ ok: true, db: 'up' });
  } catch (e) {
    return NextResponse.json(
      { ok: false, db: 'down', error: e instanceof Error ? e.message : String(e) },
      { status: 503 },
    );
  }
}
