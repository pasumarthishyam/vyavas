import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';

import { getDb } from '../../../../db/client';
import { merchants } from '../../../../db/schema/tenancy';

/**
 * The old single-merchant webhook URL.
 *
 * Superseded by `/api/webhooks/razorpay/[slug]`, because the merchant a
 * delivery belongs to has to be known BEFORE the signature can be verified,
 * and the only trustworthy place to put that is the URL.
 *
 * Kept rather than deleted, and kept LOUD rather than quietly accepting: if
 * this URL is still configured in a Razorpay dashboard somewhere, the failure
 * has to be visible. A 404 would look like a deploy problem, and silently
 * accepting would mean every delivery is dropped as unattributable while
 * Razorpay reports 200 and the merchant sees no cases at all — which is the
 * worst of the three outcomes, because nothing anywhere says it is broken.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function guidance() {
  const db = getDb();
  const rows = await db
    .select({ slug: merchants.slug, name: merchants.name })
    .from(merchants)
    .where(sql`deleted_at is null`)
    .orderBy(merchants.createdAt);

  return {
    ok: false,
    reason: 'endpoint_moved',
    detail:
      'This URL no longer accepts deliveries. Each Razorpay account has its own endpoint, ' +
      'because the signature must be verified with that account’s own secret.',
    useInstead: rows.map((m) => ({
      merchant: m.name,
      url: `/api/webhooks/razorpay/${m.slug}`,
    })),
  };
}

export async function POST(): Promise<NextResponse> {
  // 410, not 404: the endpoint existed and is deliberately gone. Razorpay does
  // not retry a 410, which is right — retrying cannot fix a wrong URL.
  return NextResponse.json(await guidance(), { status: 410 });
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(await guidance(), { status: 410 });
}
