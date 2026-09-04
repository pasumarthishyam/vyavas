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
import {
  markCartSuppressed,
  recordCartLinkIssued,
  type CartEmailStatus,
} from '../db/repos/abandoned-carts.js';
import { recentCaseActivityForCustomer } from '../db/repos/cases.js';
import { shouldSuppressCart } from '../core/guards/cart-suppression.js';
import { razorpayForMerchant, channelsForMerchant } from './merchant-clients.js';
import { createPaymentLink } from '../adapters/razorpay/resources.js';
import { proposeCartDiscount } from '../core/guards/cart-discount.js';
import { formatINR, paise, subPaise, type Paise } from '../core/money.js';
import { compose } from '../messaging/compose.js';
import { sendMessage, type SendOutcome } from '../messaging/send.js';

/** Razorpay's payment-link minimum. Below this there is nothing to pay. */
const MIN_PAYABLE_PAISE = 100;
const LINK_VALID_HOURS = 24;

export interface ProcessCartInput {
  cartRowId: string;
  merchantId: string;
  merchantName: string;
  frequencyCapPerDay: number;
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
      /** True only when an email genuinely left for the customer. */
      emailed: boolean;
      /** What the send path did, and why, when it did not send. */
      emailStatus: CartEmailStatus;
      emailDetail: string | null;
    }
  /**
   * Deliberately not acted on. Not an error and not a send.
   *
   * The one case today is a customer who already has a payment failure being
   * recovered: the merchant's app cannot see the decline, so it reports a
   * perfectly reasonable "abandoned cart" for a checkout the person was
   * actively trying to pay. See `core/guards/cart-suppression.ts`.
   */
  | { ok: true; suppressed: true; reason: string }
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

  /*
   * Is this a cart at all, or a payment that already failed?
   *
   * Checked here — after the customer is resolved, before a Razorpay link is
   * created — because the customer row is the only thing the two agents share
   * and because a link we are not going to send should never be created. It is
   * one query, and it runs before anything external happens.
   */
  const activity = await recentCaseActivityForCustomer(db, input.merchantId, customerId);
  const verdict = shouldSuppressCart({
    now: new Date(),
    hasLiveCase: activity.hasLiveCase,
    mostRecentCaseAt: activity.mostRecentCaseAt,
  });

  if (verdict.suppress) {
    await markCartSuppressed(db, input.cartRowId, customerId, verdict.reason);
    return { ok: true, suppressed: true, reason: verdict.reason };
  }

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

  /*
   * The send, and what it actually did.
   *
   * Every branch below is a real outcome this agent has hit, and every one of
   * them used to be recorded identically as "emailed": refused (this customer
   * had already had their allowance of messages today), failed (Resend rejected
   * the address), no_channel (no email credentials on the merchant at all). A
   * console cannot be trusted about what it DID send if it cannot be honest
   * about what it did not.
   *
   * `suppressed` is still in the union but is now unreachable from here. It
   * covered the merchant being in a dry run, and dry run is gone — an account is
   * paused or live, and a paused one never reaches this function.
   */
  let emailStatus: CartEmailStatus = 'not_composed';
  let emailDetail: string | null = composed.ok ? null : 'could not compose the email for this cart';

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
      // Never suppressed: the caller does not reach this function at all while
      // the merchant is paused, so by here the send is meant to happen.
      suppressedReason: null,
      channels,
    });

    emailStatus = outcome.status;
    emailDetail = describeOutcome(outcome);
  }

  await recordCartLinkIssued(db, input.cartRowId, {
    customerId,
    discountAmountPaise: discount.amountPaise,
    paymentLinkId: linkId,
    paymentLinkUrl: url,
    paymentLinkAmountPaise: payable,
    paymentLinkExpiresAt: expiresAt,
    emailStatus,
    emailDetail,
  });

  return {
    ok: true,
    discountAmountPaise: discount.amountPaise,
    payableAmountPaise: payable,
    paymentLinkUrl: url,
    emailed: emailStatus === 'sent',
    emailStatus,
    emailDetail,
  };
}

/** The one-line why, kept in the send path's own words rather than re-invented. */
function describeOutcome(outcome: SendOutcome): string | null {
  switch (outcome.status) {
    case 'sent':
      return null;
    case 'suppressed':
      return outcome.reason;
    case 'refused':
      return outcome.reason;
    case 'failed':
      return `${outcome.failure}: ${outcome.detail}`;
    case 'no_channel':
      return outcome.detail;
  }
}
