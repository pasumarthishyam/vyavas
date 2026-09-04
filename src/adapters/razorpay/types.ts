/**
 * Razorpay entity shapes.
 *
 * Deliberately loose. Razorpay adds fields without notice and omits others
 * depending on method, so every field is optional and nothing here is trusted
 * to exist. `src/core/taxonomy/normalize.ts` is what turns this into a closed,
 * validated `ErrorTuple` — the job of these types is only to describe what the
 * wire looks like, not to guarantee it.
 *
 * A payments integration is not a place where an unexpected shape may throw:
 * a payload we failed to parse is still money at risk.
 */

/** Every webhook arrives wrapped in this. */
export interface RazorpayWebhookEnvelope {
  entity?: string;
  account_id?: string;
  event?: string;
  contains?: string[];
  payload?: Record<string, { entity?: Record<string, unknown> } | undefined>;
  created_at?: number;
}

export interface RazorpayPaymentEntity extends Record<string, unknown> {
  id?: string;
  entity?: string;
  amount?: number;
  currency?: string;
  status?: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
  order_id?: string | null;
  invoice_id?: string | null;
  method?: string;
  amount_refunded?: number;
  captured?: boolean;
  description?: string | null;
  card_id?: string | null;
  card?: { id?: string; network?: string; type?: string; issuer?: string; last4?: string };
  bank?: string | null;
  wallet?: string | null;
  vpa?: string | null;
  email?: string;
  contact?: string;
  notes?: Record<string, unknown>;
  fee?: number;
  tax?: number;
  error_code?: string | null;
  error_description?: string | null;
  error_source?: string | null;
  error_step?: string | null;
  error_reason?: string | null;
  acquirer_data?: Record<string, unknown>;
  created_at?: number;
}

export interface RazorpayOrderEntity extends Record<string, unknown> {
  id?: string;
  entity?: string;
  amount?: number;
  amount_paid?: number;
  amount_due?: number;
  currency?: string;
  receipt?: string | null;
  /** `created` | `attempted` | `paid`. The pre-send guard reads this. */
  status?: 'created' | 'attempted' | 'paid';
  attempts?: number;
  notes?: Record<string, unknown>;
  created_at?: number;
}

export interface RazorpayInvoiceEntity extends Record<string, unknown> {
  id?: string;
  entity?: string;
  customer_id?: string;
  order_id?: string | null;
  payment_id?: string | null;
  status?: 'draft' | 'issued' | 'partially_paid' | 'paid' | 'cancelled' | 'expired' | 'deleted';
  amount?: number;
  amount_paid?: number;
  amount_due?: number;
  currency?: string;
  customer_details?: { email?: string; contact?: string; name?: string };
  short_url?: string;
  date?: number;
  expire_by?: number;
  issued_at?: number;
  paid_at?: number;
}

export interface RazorpaySubscriptionEntity extends Record<string, unknown> {
  id?: string;
  entity?: string;
  plan_id?: string;
  customer_id?: string;
  /**
   * `pending` means a charge failed and Razorpay is running its OWN retry
   * schedule. `halted` means those retries are exhausted — the highest-priority
   * case class we have, because the alternative is involuntary churn.
   */
  status?:
    | 'created'
    | 'authenticated'
    | 'active'
    | 'pending'
    | 'halted'
    | 'cancelled'
    | 'completed'
    | 'expired';
  current_start?: number;
  current_end?: number;
  charge_at?: number;
  paid_count?: number;
  remaining_count?: number;
  notes?: Record<string, unknown>;
}

export interface RazorpayDowntimeEntity extends Record<string, unknown> {
  id?: string;
  entity?: string;
  method?: string;
  /** `started` | `resolved` | `scheduled` */
  status?: string;
  scheduled?: boolean;
  begin?: number;
  end?: number | null;
  severity?: 'low' | 'medium' | 'high';
  /** Present for card outages. */
  instrument?: { issuer?: string; bank?: string; network?: string; psp?: string; vpa_handle?: string };
  created_at?: number;
}

export interface RazorpayPaymentLinkEntity extends Record<string, unknown> {
  id?: string;
  amount?: number;
  /** What has actually been collected. A link may be partially paid. */
  amount_paid?: number;
  currency?: string;
  status?: 'created' | 'partially_paid' | 'expired' | 'cancelled' | 'paid';
  short_url?: string;
  /**
   * OUR id for whatever this link is recovering, set at creation.
   *
   * The only reliable way back from a paid link to the thing it belongs to.
   * Three different agents create links and each puts its own row's UUID here:
   * the ladder writes a `recovery_cases.id`, the abandoned-cart agent an
   * `abandoned_carts.id`, the discount caller a `voice_calls.id`. The
   * `order_id` below is the link's OWN order, created by Razorpay when the link
   * was paid — it is never the order that originally failed, which is why
   * resolving a `payment_link.paid` by order id never found anything.
   */
  reference_id?: string;
  order_id?: string | null;
  expire_by?: number;
  notes?: Record<string, unknown>;
}

/**
 * The webhook events we subscribe to.
 *
 * Kept as a closed list so an unrecognised event type is visible rather than
 * silently ignored — Razorpay adds events, and one we do not handle is a
 * recovery opportunity we are not seeing.
 */
export const SUBSCRIBED_EVENTS = [
  'payment.failed',
  'payment.authorized',
  'payment.captured',
  'order.paid',
  'payment_link.paid',
  'payment_link.expired',
  'payment_link.cancelled',
  'invoice.paid',
  'invoice.partially_paid',
  'invoice.expired',
  'subscription.pending',
  'subscription.halted',
  'subscription.charged',
  'subscription.cancelled',
  'refund.created',
  'payment.downtime.started',
  'payment.downtime.updated',
  'payment.downtime.resolved',
] as const;

export type SubscribedEvent = (typeof SUBSCRIBED_EVENTS)[number];

export function isSubscribedEvent(event: string): event is SubscribedEvent {
  return (SUBSCRIBED_EVENTS as readonly string[]).includes(event);
}
