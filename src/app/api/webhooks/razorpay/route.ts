import { NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';

import { getDb } from '../../../../db/client';
import { merchants } from '../../../../db/schema/tenancy';
import { razorpayConnections } from '../../../../db/schema/tenancy';
import { handleWebhookRequest, type MerchantSettings } from '../../../../ingest/webhook-handler';
import { requireWebhookSecret } from '../../../../lib/env';

/**
 * The Razorpay webhook endpoint.
 *
 * Five lines of transport around `handleWebhookRequest`, which is where the
 * whole contract lives and where it is tested. Deliberately so: signature
 * verification, dedupe and response semantics are the part that must not depend
 * on a framework, and the part that must be provable without a server running.
 *
 * `request.text()` — NOT `request.json()`. The signature is computed over the
 * exact bytes Razorpay sent, and parsing then re-serialising changes key order
 * and whitespace, so the HMAC no longer matches.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  let secret: string;
  try {
    secret = requireWebhookSecret();
  } catch {
    // Refuse to accept anything rather than accept it unverified. An endpoint
    // that skips verification because a secret is missing is an open endpoint.
    return NextResponse.json(
      { ok: false, reason: 'webhook_secret_not_configured' },
      { status: 503 },
    );
  }

  const rawBody = await request.text();

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  const db = getDb();

  const result = await handleWebhookRequest(rawBody, headers, {
    db,
    webhookSecret: secret,
    now: () => new Date(),
    resolveMerchant: async (accountId): Promise<MerchantSettings | null> => {
      const settings = (row: typeof merchants.$inferSelect): MerchantSettings => ({
        merchantId: row.id,
        holdoutBasisPoints: row.holdoutBasisPoints,
        holdoutEnabled: row.holdoutEnabled,
      });

      if (accountId) {
        const joined = await db
          .select({ m: merchants })
          .from(razorpayConnections)
          .innerJoin(merchants, eq(merchants.id, razorpayConnections.merchantId))
          .where(eq(razorpayConnections.rzpAccountId, accountId))
          .limit(1);
        const found = joined.at(0)?.m;
        if (found) return settings(found);
      }

      // Single-merchant install talking to its own keys — how the first design
      // partners run. Multi-tenant installs always carry an account id.
      const only = await db.select().from(merchants).where(sql`deleted_at is null`).limit(2);
      return only.length === 1 && only[0] ? settings(only[0]) : null;
    },
  });

  return NextResponse.json(result.body, { status: result.status });
}

/** Razorpay's dashboard pings the URL before saving a webhook. */
export function GET(): NextResponse {
  return NextResponse.json({ ok: true, endpoint: 'razorpay-webhook' });
}
