/**
 * Razorpay resource calls.
 *
 * The one that matters most is `isOrderPaid`. It is the precondition re-checked
 * immediately before EVERY customer touch, and it deliberately asks Razorpay
 * rather than reading our own row: a case can sleep for six hours, the customer
 * can pay through another channel in that window, and local state would say
 * nothing happened. Messaging someone who has already paid is the single
 * mistake that ends the relationship.
 */

import type { RazorpayClient } from './client.js';
import type {
  RazorpayDowntimeEntity,
  RazorpayInvoiceEntity,
  RazorpayOrderEntity,
  RazorpayPaymentEntity,
  RazorpayPaymentLinkEntity,
  RazorpaySubscriptionEntity,
} from './types.js';

export function fetchOrder(client: RazorpayClient, orderId: string) {
  return client.get<RazorpayOrderEntity>(`/orders/${orderId}`);
}

export function fetchPayment(client: RazorpayClient, paymentId: string) {
  return client.get<RazorpayPaymentEntity>(`/payments/${paymentId}`);
}

export function fetchInvoice(client: RazorpayClient, invoiceId: string) {
  return client.get<RazorpayInvoiceEntity>(`/invoices/${invoiceId}`);
}

export function fetchSubscription(client: RazorpayClient, subscriptionId: string) {
  return client.get<RazorpaySubscriptionEntity>(`/subscriptions/${subscriptionId}`);
}

/** Payments made against an order — the source for `payment_attempts`. */
export async function fetchOrderPayments(
  client: RazorpayClient,
  orderId: string,
): Promise<RazorpayPaymentEntity[]> {
  const res = await client.get<{ items?: RazorpayPaymentEntity[] }>(
    `/orders/${orderId}/payments`,
  );
  return res.items ?? [];
}

export interface OrderPaidCheck {
  paid: boolean;
  status: string | null;
  amountPaise: number;
  amountPaidPaise: number;
}

/**
 * THE PRE-SEND GUARD.
 *
 * Treats an API failure as "paid" — deliberately. If we cannot confirm the
 * order is still unpaid, the safe action is to stay silent: a recovery message
 * we failed to send costs one order, and a message to someone who already paid
 * costs the merchant relationship.
 */
export async function isOrderPaid(
  client: RazorpayClient,
  orderId: string,
): Promise<OrderPaidCheck> {
  try {
    const order = await fetchOrder(client, orderId);
    const amountPaid = typeof order.amount_paid === 'number' ? order.amount_paid : 0;
    return {
      paid: order.status === 'paid' || amountPaid > 0,
      status: order.status ?? null,
      amountPaise: typeof order.amount === 'number' ? order.amount : 0,
      amountPaidPaise: amountPaid,
    };
  } catch {
    return { paid: true, status: 'unknown', amountPaise: 0, amountPaidPaise: 0 };
  }
}

/**
 * Open outages.
 *
 * This is what lets a ladder wait for the bank to actually recover instead of
 * guessing "retry in 2-3 hours", and what makes "your bank is back online" a
 * message we can honestly send.
 */
export async function fetchActiveDowntimes(
  client: RazorpayClient,
): Promise<RazorpayDowntimeEntity[]> {
  const res = await client.get<{ items?: RazorpayDowntimeEntity[] }>('/payments/downtimes');
  return (res.items ?? []).filter((d) => d.status !== 'resolved');
}

export interface CreatePaymentLinkInput {
  amountPaise: number;
  currency?: string;
  description: string;
  /** Our case id, so an inbound `payment_link.paid` maps straight back. */
  referenceId: string;
  customer: { name?: string; email?: string; contact?: string };
  expireBy?: Date;
  callbackUrl?: string;
  notes?: Record<string, string>;
  /** We do our own sending, with consent checks and the frequency cap. */
  notifySms?: boolean;
  notifyEmail?: boolean;
}

/**
 * The recovery instrument.
 *
 * `notify` defaults to OFF: Razorpay would happily send its own SMS and email,
 * bypassing our consent checks, quiet hours and cross-case frequency cap. Every
 * customer touch has to go through one gate or the cap is not a cap.
 */
export function createPaymentLink(client: RazorpayClient, input: CreatePaymentLinkInput) {
  return client.post<RazorpayPaymentLinkEntity>('/payment_links', {
    amount: input.amountPaise,
    currency: input.currency ?? 'INR',
    description: input.description,
    reference_id: input.referenceId,
    customer: {
      name: input.customer.name,
      email: input.customer.email,
      contact: input.customer.contact,
    },
    notify: { sms: input.notifySms ?? false, email: input.notifyEmail ?? false },
    reminder_enable: false,
    expire_by: input.expireBy ? Math.floor(input.expireBy.getTime() / 1000) : undefined,
    callback_url: input.callbackUrl,
    callback_method: input.callbackUrl ? 'get' : undefined,
    notes: input.notes,
  });
}

/** Exactly one live link per case: creating a new one cancels the previous. */
export function cancelPaymentLink(client: RazorpayClient, linkId: string) {
  return client.post<RazorpayPaymentLinkEntity>(`/payment_links/${linkId}/cancel`, {});
}

/**
 * Fetch a payment link's current status directly.
 *
 * Used by the voice agent to confirm payment on a link it created itself,
 * rather than depending on the shared `payment_link.paid` webhook — that
 * webhook resolves back to a case by the ORIGINAL failed order's id, and a
 * link created fresh mid-call does not carry one. Asking Razorpay directly
 * for the status of the specific link this agent made is unambiguous.
 */
export function fetchPaymentLink(client: RazorpayClient, linkId: string) {
  return client.get<RazorpayPaymentLinkEntity>(`/payment_links/${linkId}`);
}
