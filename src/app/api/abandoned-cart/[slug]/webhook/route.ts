import { NextResponse } from 'next/server';
import { and, inArray, sql } from 'drizzle-orm';

import { getDb, type Database } from '../../../../../db/client';
import { getMerchant } from '../../../../../db/queries/dashboard';
import { merchants } from '../../../../../db/schema/tenancy';
import { createAbandonedCart, getAbandonedCart, recordCartFailure } from '../../../../../db/repos/abandoned-carts';
import {
  getAbandonedCartApiKey,
  verifyAbandonedCartWebhookAuth,
} from '../../../../../db/repos/abandoned-cart-auth';
import { slugCandidates } from '../../../../../db/repos/credentials';
import { processAbandonedCart } from '../../../../../workflows/abandoned-cart';

/**
 * Where a merchant's OWN application reports an abandoned cart.
 *
 *     https://www.vyavas.com/api/abandoned-cart/tradesmetrix/webhook
 *
 * The direction of trust is the opposite of every other webhook in this
 * codebase: those verify that WE are talking to the right provider; this one
 * verifies that the CALLER is really the merchant, via a key issued on the
 * `/agents/abandoned-cart` page. There is no Razorpay signature to lean on —
 * Razorpay was never involved in this cart at all, which is the entire reason
 * this endpoint has to exist.
 *
 * Idempotent on the merchant's own `cartId`, but not in the naive "reject a
 * repeat" sense — see the status branch below. A cart that failed partway
 * through (Razorpay down, a bad address) must still be retryable by the same
 * webhook call, or the merchant's one honest retry would be silently
 * swallowed as "already handled" while nothing was ever actually sent.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface WebhookBody {
  cartId?: unknown;
  customerName?: unknown;
  customerEmail?: unknown;
  customerPhone?: unknown;
  amountPaise?: unknown;
}

function badRequest(reason: string): NextResponse {
  return NextResponse.json({ ok: false, reason }, { status: 400 });
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await ctx.params;
  const db = getDb();

  const auth = request.headers.get('authorization') ?? request.headers.get('Authorization');
  const presentedKey = auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null;

  const verified = await verifyAbandonedCartWebhookAuth(db, slug, presentedKey);
  if (!verified.ok) {
    const status = verified.reason === 'no merchant for this URL' ? 404 : 401;
    return NextResponse.json({ ok: false, reason: verified.reason }, { status });
  }

  const body = (await request.json().catch(() => null)) as WebhookBody | null;
  if (!body) return badRequest('invalid JSON body');

  const cartId = typeof body.cartId === 'string' ? body.cartId.trim() : '';
  if (cartId.length === 0) return badRequest('cartId is required');
  if (cartId.length > 200) return badRequest('cartId is too long (max 200 characters)');

  const customerEmail = typeof body.customerEmail === 'string' ? body.customerEmail.trim().toLowerCase() : '';
  if (!customerEmail.includes('@')) {
    return badRequest('customerEmail is required — this agent only ever reaches the customer by email');
  }

  const amountPaise = body.amountPaise;
  if (typeof amountPaise !== 'number' || !Number.isInteger(amountPaise) || amountPaise <= 0) {
    return badRequest('amountPaise is required and must be a positive whole number (the cart total, in paise)');
  }

  const customerName =
    typeof body.customerName === 'string' && body.customerName.trim().length > 0
      ? body.customerName.trim().slice(0, 200)
      : null;
  const customerPhone =
    typeof body.customerPhone === 'string' && body.customerPhone.trim().length > 0
      ? body.customerPhone.trim()
      : null;

  const { id: cartRowId } = await createAbandonedCart(db, {
    merchantId: verified.merchantId,
    externalCartId: cartId,
    customerName,
    customerEmail,
    customerPhone,
    amountPaise,
  });

  const row = await getAbandonedCart(db, cartRowId);
  if (!row) {
    return NextResponse.json(
      { ok: false, reason: 'internal: row vanished immediately after insert' },
      { status: 500 },
    );
  }

  // Already fully processed on an earlier call — a real idempotent no-op.
  // `detected` and `failed` are the two states worth retrying: `detected`
  // means the row was created but the process never ran (or never finished),
  // and `failed` means it ran and lost partway through. Either way, the
  // merchant's own retry of the same cartId is what should complete it —
  // treating EVERY repeat as "already handled" would silently drop the one
  // case that most needs the retry to work.
  if (row.status === 'emailed' || row.status === 'recovered' || row.status === 'expired') {
    return NextResponse.json({ ok: true, cartId: row.id, alreadyProcessed: true, status: row.status });
  }

  const merchant = await getMerchant(db, verified.merchantId);
  if (!merchant) {
    return NextResponse.json({ ok: false, reason: 'merchant not found' }, { status: 404 });
  }

  /*
   * Paused. The row is recorded — the merchant's app did its job — and nothing
   * external happens.
   *
   * Worth being plain about the limit here, because it differs from the failed-
   * payment agent. A recovery case parks in `paused` and is picked up again on
   * resume; a cart does not. It stays `detected`, and going live does not go
   * back for it. The merchant's app fires this webhook once per cart, and
   * emailing someone about a cart they abandoned days ago, whenever an operator
   * happened to unpause, is worse than not emailing them at all.
   *
   * The row is still retryable by the same `cartId` if they want it: `detected`
   * is one of the two statuses this endpoint will process on a repeat call.
   */
  if (!merchant.executionEnabled) {
    return NextResponse.json({ ok: true, cartId: row.id, skipped: 'agent_paused', status: row.status });
  }

  const result = await processAbandonedCart(db, {
    cartRowId: row.id,
    merchantId: merchant.id,
    merchantName: merchant.name,
    frequencyCapPerDay: merchant.frequencyCapPerDay,
    amountPaise: row.amountPaise,
    customerName: row.customerName,
    customerEmail: row.customerEmail,
    customerPhone: row.customerPhone,
  });

  if (!result.ok) {
    await recordCartFailure(db, row.id, result.reason);
    return NextResponse.json({ ok: false, cartId: row.id, reason: result.reason }, { status: result.status });
  }

  return NextResponse.json({
    ok: true,
    cartId: row.id,
    discountAmountPaise: result.discountAmountPaise,
    payableAmountPaise: result.payableAmountPaise,
    paymentLinkUrl: result.paymentLinkUrl,
    // `emailed` is the merchant's own integration test: false with a reason
    // beside it, rather than a bare true that only meant "we got as far as
    // trying". Their app can log this and see a dry run or a capped customer
    // for what it is.
    emailed: result.emailed,
    emailStatus: result.emailStatus,
    ...(result.emailDetail ? { emailDetail: result.emailDetail } : {}),
  });
}

/** A quick way for a merchant's own app to check the URL and key are wired up correctly. */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await ctx.params;
  const db = getDb();

  const found = await resolveMerchantIdBySlug(db, slug);
  if (!found) {
    return NextResponse.json({ ok: false, reason: 'unknown_merchant', slug }, { status: 404 });
  }

  const configured = (await getAbandonedCartApiKey(db, found.merchantId)) !== null;

  return NextResponse.json({
    ok: true,
    endpoint: 'abandoned-cart-webhook',
    merchant: found.name,
    slug: found.slug,
    apiKeyConfigured: configured,
    hint: configured
      ? 'POST { cartId, customerEmail, amountPaise, customerName?, customerPhone? } with Authorization: Bearer <key>'
      : 'No key generated yet — open Abandoned Cart Agent in the dashboard and generate one first.',
  });
}

async function resolveMerchantIdBySlug(
  db: Database,
  slug: string,
): Promise<{ merchantId: string; slug: string; name: string } | null> {
  const rows = await db
    .select({ id: merchants.id, slug: merchants.slug, name: merchants.name })
    .from(merchants)
    .where(and(inArray(merchants.slug, slugCandidates(slug)), sql`deleted_at is null`))
    .limit(1);
  const row = rows.at(0);
  return row ? { merchantId: row.id, slug: row.slug, name: row.name } : null;
}
