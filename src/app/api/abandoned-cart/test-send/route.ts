import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';

import { getDb } from '../../../../db/client';
import { getMerchant } from '../../../../db/queries/dashboard';
import { createAbandonedCart, getAbandonedCart, recordCartFailure } from '../../../../db/repos/abandoned-carts';
import { currentMerchantId } from '../../../../lib/merchant-context';
import { processAbandonedCart } from '../../../../workflows/abandoned-cart';

/**
 * Send yourself a real abandoned-cart email without wiring up any storefront.
 *
 * Runs through the EXACT same `processAbandonedCart` the real webhook uses —
 * discount, Razorpay link, `compose()` + `sendMessage()` — the only thing
 * synthetic about it is the cart id and the email address, which the person
 * on the dashboard supplies themselves. This exists because the useful test
 * of "does this whole pipeline work" was, until now, wiring up a real
 * storefront first — the exact gap that made the discount-caller agent
 * impossible to test before its own "Web call" button existed.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface TestSendBody {
  email?: unknown;
  amountPaise?: unknown;
}

const DEFAULT_TEST_AMOUNT_PAISE = 99_900; // Rs 999

export async function POST(request: Request): Promise<NextResponse> {
  const db = getDb();
  const merchantId = await currentMerchantId(db);
  if (!merchantId) {
    return NextResponse.json({ ok: false, reason: 'no merchant' }, { status: 404 });
  }

  const merchant = await getMerchant(db, merchantId);
  if (!merchant) {
    return NextResponse.json({ ok: false, reason: 'merchant not found' }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as TestSendBody;
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email.includes('@')) {
    return NextResponse.json({ ok: false, reason: 'a valid email is required' }, { status: 400 });
  }

  const amountPaise =
    typeof body.amountPaise === 'number' && Number.isInteger(body.amountPaise) && body.amountPaise > 0
      ? body.amountPaise
      : DEFAULT_TEST_AMOUNT_PAISE;

  // A fresh synthetic cart id every time, so a test send is never swallowed by
  // the idempotency guard the real webhook relies on — each click is meant to
  // actually send.
  const externalCartId = `test-${randomUUID()}`;

  const { id: cartRowId } = await createAbandonedCart(db, {
    merchantId,
    externalCartId,
    customerName: 'Test Customer',
    customerEmail: email,
    customerPhone: null,
    amountPaise,
  });

  const row = await getAbandonedCart(db, cartRowId);
  if (!row) {
    return NextResponse.json({ ok: false, reason: 'internal: row vanished immediately after insert' }, { status: 500 });
  }

  const result = await processAbandonedCart(db, {
    cartRowId: row.id,
    merchantId: merchant.id,
    merchantName: merchant.name,
    frequencyCapPerDay: merchant.frequencyCapPerDay,
    dryRun: merchant.dryRun,
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
    emailed: result.emailed,
    dryRun: merchant.dryRun,
  });
}
