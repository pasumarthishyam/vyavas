import { NextResponse } from 'next/server';

import { getDb } from '../../../../../db/client';
import { merchants } from '../../../../../db/schema/tenancy';
import { eq, sql } from 'drizzle-orm';
import { handleWebhookRequest, type MerchantSettings } from '../../../../../ingest/webhook-handler';
import { loadWebhookSecret } from '../../../../../db/repos/credentials';
import { workflowPublisher } from '../../../../../workflows/publish';

/**
 * The Razorpay webhook endpoint, one URL per merchant.
 *
 *     https://www.vyavas.com/api/webhooks/razorpay/sandbox
 *     https://www.vyavas.com/api/webhooks/razorpay/rzp-tradesmetrix
 *
 * The path names the tenant, and it has to, because of a genuine chicken and
 * egg: the signature cannot be verified without knowing whose secret to use,
 * and the payload cannot be trusted enough to tell us whose it is until the
 * signature has been verified. Razorpay's `account_id` is inside the body — the
 * part we are trying to authenticate.
 *
 * The previous single endpoint resolved the merchant by falling back to "if
 * there is exactly one merchant, it must be that one", which silently returned
 * nothing the moment a second merchant existed. Every delivery for both
 * accounts would have been accepted and dropped as unattributable.
 *
 * `request.text()` — NOT `request.json()`. The signature is computed over the
 * exact bytes Razorpay sent, and parsing then re-serialising changes key order
 * and whitespace, so the HMAC no longer matches.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await ctx.params;
  const db = getDb();

  // ── two failures that look identical and are not ──
  //
  // A wrong slug in the Razorpay dashboard and a merchant with no stored secret
  // both used to return the same 503, so a typo'd URL was indistinguishable
  // from a configuration gap — and neither said which merchant it was looking
  // for. Deliveries fail, the dashboard shows a red dot, and nothing anywhere
  // says the word "slug".
  //
  // They are reported separately now, and both name the slugs that DO exist,
  // because that is the one thing that turns this into a fix instead of an
  // investigation.
  const known = await db
    .select({ slug: merchants.slug })
    .from(merchants)
    .where(sql`deleted_at is null`)
    .orderBy(merchants.createdAt);

  if (!known.some((m) => m.slug === slug)) {
    return NextResponse.json(
      {
        ok: false,
        reason: 'unknown_merchant',
        slug,
        hint: 'The URL path must match a merchant slug exactly.',
        known: known.map((m) => m.slug),
      },
      { status: 404 },
    );
  }

  // Which secret to verify against. Stored per connection and encrypted; falls
  // back to the single global secret only while exactly one merchant exists.
  const resolved = await loadWebhookSecret(db, slug);

  if (!resolved) {
    // Refuse rather than accept unverified. An endpoint that skips verification
    // because a secret is missing is an open endpoint: anyone who learns the
    // URL can post fake payment failures and drive real messages to real people.
    return NextResponse.json(
      {
        ok: false,
        reason: 'no_webhook_secret_for_merchant',
        slug,
        hint: `Store it with: npm run merchant -- connect --slug ${slug} --mode <test|live> --key … --secret … --webhook-secret …`,
      },
      { status: 503 },
    );
  }

  const rawBody = await request.text();

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  const result = await handleWebhookRequest(rawBody, headers, {
    db,
    webhookSecret: resolved.secret,
    now: () => new Date(),
    // Starts the ladder on a diagnosed failure and cancels it the moment the
    // money arrives. This is what makes the system autonomous rather than a
    // very well-tested set of parts that nothing ever runs.
    publish: workflowPublisher,
    // The merchant is already known from the URL and confirmed by the fact that
    // its own secret verified the signature. No payload field is consulted.
    resolveMerchant: async (): Promise<MerchantSettings | null> => {
      const rows = await db
        .select()
        .from(merchants)
        .where(eq(merchants.id, resolved.merchantId))
        .limit(1);
      const m = rows.at(0);
      if (!m || m.deletedAt) return null;
      return {
        merchantId: m.id,
        holdoutBasisPoints: m.holdoutBasisPoints,
        holdoutEnabled: m.holdoutEnabled,
      };
    },
  });

  return NextResponse.json(result.body, { status: result.status });
}

/** Razorpay's dashboard pings the URL before saving a webhook. */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await ctx.params;
  const db = getDb();

  const rows = await db
    .select({ id: merchants.id, name: merchants.name })
    .from(merchants)
    .where(sql`${merchants.slug} = ${slug} and ${merchants.deletedAt} is null`)
    .limit(1);

  const merchant = rows.at(0);
  if (!merchant) {
    return NextResponse.json({ ok: false, reason: 'unknown_merchant', slug }, { status: 404 });
  }

  const secret = await loadWebhookSecret(db, slug);
  return NextResponse.json({
    ok: true,
    endpoint: 'razorpay-webhook',
    merchant: merchant.name,
    slug,
    // Stated plainly so a misconfigured endpoint is visible from a browser
    // rather than discovered when a delivery is rejected at 3am.
    secretConfigured: secret !== null,
  });
}
