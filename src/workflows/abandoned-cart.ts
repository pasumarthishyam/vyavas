/**
 * The abandoned-cart agent's actual work: discount, payment link, email.
 *
 * Pulled out of `app/api/abandoned-cart/[slug]/webhook/route.ts` so the
 * webhook's own auth/idempotency/status branching stays readable and this
 * stays independently testable. Also briefly shared with a dashboard
 * "Send test email" action while the feature was being built and verified
 * end-to-end; that action has since been removed, but the separation was
 * worth keeping.
 */

import type { Database } from '../db/client.js';
import { getCustomer, upsertCustomer } from '../db/repos/customers.js';
import { recordCartEmailSent } from '../db/repos/abandoned-carts.js';
import { razorpayForMerchant, channelsForMerchant } from './merchant-clients.js';
import { createPaymentLink } from '../adapters/razorpay/resources.js';
import { proposeCartDiscount } from '../core/guards/cart-discount.js';
import { formatINR, paise, subPaise, type Paise } from '../core/money.js';
import { compose } from '../messaging/compose.js';
import { sendMessage } from '../messaging/send.js';

/** Razorpay's payment-link minimum. Below this there is nothing to pay. */
const MIN_PAYABLE_PAISE = 100;
const LINK_VALID_HOURS = 24;

export interface ProcessCartInput {
  cartRowId: string;
  merchantId: string;
  merchantName: string;
  frequencyCapPerDay: number;
  dryRun: boolean;
  amountPaise: number;
  customerName: string | null;
  customerEmail: string;
  customerPhone: string | null;
}

export type ProcessCartResult =
  | {
      ok: true;
      discountAmountPaise: number;
      payableAmountPaise: number;
      paymentLinkUrl: string;
      emailed: boolean;
    }
  | { ok: false; status: number; reason: string };

export async function processAbandonedCart(db: Database, input: ProcessCartInput): Promise<ProcessCartResult> {
  const cartAmount = paise(input.amountPaise);
  const discount = proposeCartDiscount(cartAmount);
  const payable: Paise = subPaise(cartAmount, discount.amountPaise);

  if (payable < MIN_PAYABLE_PAISE) {
    return {
      ok: false,
      status: 422,
      reason: 'cart amount is too small to create a payment link after the discount',
    };
  }

  const razorpay = await razorpayForMerchant(db, input.merchantId);
  if (!razorpay) {
    return { ok: false, status: 502, reason: 'no payment provider configured for this merchant' };
  }

  const customerId = await upsertCustomer(db, {
    merchantId: input.merchantId,
    email: input.customerEmail,
    phone: input.customerPhone,
    name: input.customerName,
  });
  if (!customerId) {
    return { ok: false, status: 422, reason: 'could not resolve a customer record from the email/phone given' };
  }
  const customer = await getCustomer(db, customerId);

  let link;
  const expiresAt = new Date(Date.now() + LINK_VALID_HOURS * 60 * 60 * 1000);
  try {
    link = await createPaymentLink(razorpay, {
      amountPaise: payable,
      currency: 'INR',
      // The cart row's own UUID, alone — 36 characters, always under
      // Razorpay's 40-character reference_id limit. A compound key
      // (`${caseId}:...`) is what broke this exact call on the voice agent;
      // see that webhook's header comment.
      referenceId: input.cartRowId,
      description: `Abandoned cart — ${formatINR(payable, { compact: true })}`,
      customer: {
        ...(customer?.name ? { name: customer.name } : {}),
        email: input.customerEmail,
        ...(input.customerPhone ? { contact: input.customerPhone } : {}),
      },
      expireBy: expiresAt,
      notifySms: false,
      notifyEmail: false,
      notes: { vyavas_abandoned_cart_id: input.cartRowId },
    });
  } catch (e) {
    return {
      ok: false,
      status: 502,
      reason: `could not create payment link: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const url = typeof link.short_url === 'string' ? link.short_url : null;
  const linkId = typeof link.id === 'string' ? link.id : null;
  if (!url || !linkId) {
    return { ok: false, status: 502, reason: 'Razorpay did not return a usable payment link' };
  }

  const composed = compose({
    intent: 'cart_abandoned_discount',
    locale: customer?.locale ?? null,
    customerName: input.customerName,
    merchantName: input.merchantName,
    amountPaise: payable,
    paymentLink: url,
  });

  let emailed = false;
  if (composed.ok) {
    const channels = await channelsForMerchant(db, input.merchantId);
    const outcome = await sendMessage({
      db,
      merchantId: input.merchantId,
      customerId,
      caseId: null,
      rung: 0,
      channel: 'email',
      message: composed.message,
      merchantName: input.merchantName,
      phone: null,
      email: input.customerEmail,
      frequencyCap: input.frequencyCapPerDay,
      idempotencyKey: `abandoned-cart:${input.cartRowId}:email`,
      // Nothing external happens under dry-run: the link above carries no
      // notify flags so it never reached anyone on its own, and this is the
      // one step that would.
      suppressedReason: input.dryRun ? 'dry_run' : null,
      channels,
    });
    emailed = outcome.status === 'sent';
  }

  await recordCartEmailSent(db, input.cartRowId, {
    customerId,
    discountAmountPaise: discount.amountPaise,
    paymentLinkId: linkId,
    paymentLinkUrl: url,
    paymentLinkAmountPaise: payable,
    paymentLinkExpiresAt: expiresAt,
  });

  return {
    ok: true,
    discountAmountPaise: discount.amountPaise,
    payableAmountPaise: payable,
    paymentLinkUrl: url,
    emailed,
  };
}
