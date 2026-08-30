import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';

import { getDb, isQueryTimeout } from '../../../db/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * Short, because this route's whole job is to answer.
 *
 * It used to have no ceiling at all, which meant that when the connection
 * wedged it did not report "db: down" — it reported nothing, for as long as
 * anyone was willing to wait. A health check that can hang is worse than none:
 * it turns a diagnosable fault into an unanswered request.
 */
export const maxDuration = 20;

/**
 * Liveness plus a real round trip to Postgres.
 *
 * A health check that never touches the database is a lie: the process can be
 * perfectly alive while every request that matters fails.
 */
export async function GET(): Promise<NextResponse> {
  const startedAt = Date.now();

  try {
    await getDb().execute(sql`select 1`);
    return NextResponse.json({ ok: true, db: 'up', latencyMs: Date.now() - startedAt });
  } catch (e) {
    // Two genuinely different faults, reported as such. `stale_connection` means
    // the socket stopped answering and has now been discarded, so the next
    // request reconnects — it is self-healing and a retry is the right response.
    // Anything else is the database actually refusing us.
    const stale = isQueryTimeout(e);
    return NextResponse.json(
      {
        ok: false,
        db: stale ? 'stale_connection' : 'down',
        latencyMs: Date.now() - startedAt,
        error: e instanceof Error ? e.message : String(e),
      },
      { status: 503 },
    );
  }
}
