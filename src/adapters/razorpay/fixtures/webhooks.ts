/**
 * Webhook fixtures.
 *
 * Hand-built to Razorpay's documented shapes so the pipeline can be tested
 * before any live traffic exists. `scripts/capture-fixtures.ts` replaces these
 * with payloads captured from real test-mode failures — that matters, because
 * documentation and reality diverge (fields Razorpay adds without notice,
 * `error_source` values outside the documented set, issuers returning
 * `payment_failed` where the docs promise something specific).
 *
 * Treat these as a starting point, not as truth. The captured ones are the
 * regression suite.
 */

import type { RazorpayWebhookEnvelope } from '../types.js';

interface FailureOverrides {
  paymentId?: string;
  orderId?: string | null;
  amount?: number;
  method?: string;
  errorReason?: string;
  errorSource?: string;
  errorStep?: string;
  errorCode?: string;
  errorDescription?: string;
  bank?: string;
  issuer?: string;
  network?: string;
  email?: string;
  contact?: string;
  vpa?: string;
  createdAt?: number;
  notes?: Record<string, unknown>;
}

const AUG_2026 = 1_787_000_000; // seconds, well inside the fixture era

export function paymentFailedEnvelope(over: FailureOverrides = {}): RazorpayWebhookEnvelope {
  const method = over.method ?? 'card';
  const entity: Record<string, unknown> = {
    id: over.paymentId ?? 'pay_TEST0000000001',
    entity: 'payment',
    amount: over.amount ?? 184300,
    currency: 'INR',
    status: 'failed',
    order_id: over.orderId === undefined ? 'order_TEST000000001' : over.orderId,
    invoice_id: null,
    international: false,
    method,
    amount_refunded: 0,
    captured: false,
    description: 'Order #1042',
    email: over.email ?? 'rahul@example.com',
    contact: over.contact ?? '+919876543210',
    fee: null,
    tax: null,
    error_code: over.errorCode ?? 'BAD_REQUEST_ERROR',
    error_description: over.errorDescription ?? 'Payment failed',
    error_source: over.errorSource ?? 'customer',
    error_step: over.errorStep ?? 'payment_authorization',
    error_reason: over.errorReason ?? 'card_expired',
    notes: over.notes ?? {},
    created_at: over.createdAt ?? AUG_2026,
  };

  if (method === 'card') {
    entity.card_id = 'card_TEST00000001';
    entity.card = {
      id: 'card_TEST00000001',
      entity: 'card',
      name: 'Rahul Sharma',
      last4: '1111',
      network: over.network ?? 'Visa',
      type: 'debit',
      issuer: over.issuer ?? 'HDFC',
      international: false,
    };
  } else if (method === 'netbanking') {
    entity.bank = over.bank ?? 'ICIC';
  } else if (method === 'upi') {
    entity.vpa = over.vpa ?? 'rahul@okhdfcbank';
  }

  return {
    entity: 'event',
    account_id: 'acc_TEST000000001',
    event: 'payment.failed',
    contains: ['payment'],
    payload: { payment: { entity } },
    created_at: over.createdAt ?? AUG_2026,
  };
}

export function orderPaidEnvelope(
  over: { orderId?: string; paymentId?: string; amount?: number; method?: string } = {},
): RazorpayWebhookEnvelope {
  const amount = over.amount ?? 184300;
  const orderId = over.orderId ?? 'order_TEST000000001';
  return {
    entity: 'event',
    account_id: 'acc_TEST000000001',
    event: 'order.paid',
    contains: ['payment', 'order'],
    payload: {
      payment: {
        entity: {
          id: over.paymentId ?? 'pay_TEST0000000002',
          entity: 'payment',
          amount,
          currency: 'INR',
          status: 'captured',
          order_id: orderId,
          method: over.method ?? 'upi',
          captured: true,
          email: 'rahul@example.com',
          contact: '+919876543210',
          vpa: 'rahul@okhdfcbank',
          created_at: AUG_2026 + 600,
        },
      },
      order: {
        entity: {
          id: orderId,
          entity: 'order',
          amount,
          amount_paid: amount,
          amount_due: 0,
          currency: 'INR',
          status: 'paid',
          attempts: 2,
          created_at: AUG_2026 - 60,
        },
      },
    },
    created_at: AUG_2026 + 600,
  };
}

export function downtimeEnvelope(
  over: {
    id?: string;
    event?: 'payment.downtime.started' | 'payment.downtime.updated' | 'payment.downtime.resolved';
    method?: string;
    bank?: string;
    issuer?: string;
    severity?: 'low' | 'medium' | 'high';
    begin?: number;
    end?: number | null;
    status?: string;
  } = {},
): RazorpayWebhookEnvelope {
  const event = over.event ?? 'payment.downtime.started';
  const resolved = event === 'payment.downtime.resolved';
  return {
    entity: 'event',
    account_id: 'acc_TEST000000001',
    event,
    contains: ['payment.downtime'],
    payload: {
      'payment.downtime': {
        entity: {
          id: over.id ?? 'down_TEST00000001',
          entity: 'payment.downtime',
          method: over.method ?? 'netbanking',
          begin: over.begin ?? AUG_2026 - 1800,
          end: resolved ? (over.end ?? AUG_2026) : null,
          status: over.status ?? (resolved ? 'resolved' : 'started'),
          scheduled: false,
          severity: over.severity ?? 'high',
          instrument: {
            bank: over.bank ?? 'ICIC',
            issuer: over.issuer,
          },
          created_at: over.begin ?? AUG_2026 - 1800,
        },
      },
    },
    created_at: AUG_2026,
  };
}

/**
 * One fixture per cause class, so the pipeline test covers the full spread of
 * behaviour rather than only the happy path.
 */
export const FAILURE_SCENARIOS = {
  card_expired: () => paymentFailedEnvelope({ errorReason: 'card_expired' }),

  bank_technical_error: () =>
    paymentFailedEnvelope({
      errorReason: 'bank_technical_error',
      errorSource: 'bank',
      method: 'netbanking',
      bank: 'ICIC',
      errorDescription: 'Payment processing failed due to error at bank',
    }),

  incorrect_otp: () =>
    paymentFailedEnvelope({
      errorReason: 'incorrect_otp',
      errorSource: 'customer',
      errorStep: 'payment_authentication',
    }),

  insufficient_funds: () =>
    paymentFailedEnvelope({ errorReason: 'insufficient_funds', errorSource: 'bank' }),

  payment_risk_check_failed: () =>
    paymentFailedEnvelope({ errorReason: 'payment_risk_check_failed', errorSource: 'bank' }),

  payment_cancelled: () =>
    paymentFailedEnvelope({ errorReason: 'payment_cancelled', errorSource: 'customer' }),

  order_already_paid: () =>
    paymentFailedEnvelope({ errorReason: 'order_already_paid', errorSource: 'business' }),

  bank_not_enabled: () =>
    paymentFailedEnvelope({
      errorReason: 'bank_not_enabled',
      errorSource: 'business',
      method: 'netbanking',
      bank: 'ICIC',
    }),

  invalid_vpa_dead: () =>
    paymentFailedEnvelope({
      errorReason: 'invalid_vpa',
      errorSource: 'bank',
      method: 'upi',
      vpa: 'gone@okaxis',
    }),

  undocumented_code: () =>
    paymentFailedEnvelope({ errorReason: 'brand_new_code_from_razorpay' }),
} as const;

export type FailureScenario = keyof typeof FAILURE_SCENARIOS;
