/**
 * The ingest pipeline.
 *
 * Deliberately separated from any HTTP framework. The route's only job is:
 * verify the signature, claim the delivery, hand off, return 200 — and it must
 * do that in under 200ms, because Razorpay retries on timeout and a retry is a
 * duplicate we then have to dedupe.
 *
 * Everything that takes real time lives here, and because it is a plain
 * function over a `Database`, the whole pipeline is testable end to end against
 * PGlite with no server running.
 */

import {
  type RazorpayWebhookEnvelope,
  type RazorpayDowntimeEntity,
  type RazorpayPaymentEntity,
  isSubscribedEvent,
} from '../adapters/razorpay/types.js';
import { extractEntity } from '../adapters/razorpay/webhook.js';
import type { Database } from '../db/client.js';
import { markWebhookFailed, markWebhookProcessed } from '../db/repos/webhooks.js';
import { handleDowntime } from './handlers/downtime.js';
import { type HandlerContext, handlePaymentFailed } from './handlers/payment-failed.js';
import { handleCaseAborted, handlePaymentSucceeded } from './handlers/payment-succeeded.js';

export interface ProcessResult {
  event: string;
  handled: boolean;
  outcome: string;
  caseId?: string | null;
  detail?: Record<string, unknown>;
}

/**
 * Route one verified envelope to its handler.
 *
 * Unhandled events return `handled: false` rather than throwing. Razorpay adds
 * events, and an event we do not yet handle is a gap to notice, not an incident
 * that should make the endpoint start failing and trigger a retry storm.
 */
export async function processEvent(
  ctx: HandlerContext,
  envelope: RazorpayWebhookEnvelope,
): Promise<ProcessResult> {
  const event = envelope.event ?? 'unknown';

  if (!isSubscribedEvent(event)) {
    return { event, handled: false, outcome: 'not_subscribed' };
  }

  switch (event) {
    // ── failures ──
    case 'payment.failed': {
      const entity = extractEntity<RazorpayPaymentEntity>(envelope, 'payment');
      if (!entity) return { event, handled: false, outcome: 'missing_payment_entity' };
      const r = await handlePaymentFailed(ctx, entity);

      // START THE LADDER.
      //
      // This is the line that turns a diagnosed case into a running recovery.
      // Without it the pipeline does everything correctly and then stops: the
      // case exists, the ladder is stamped on it, and nothing ever fires.
      //
      // Guarded on `aborted` because a terminal case (already paid, duplicate)
      // legitimately has no ladder, and on `policyId` because a case with no
      // stamped policy has nothing to run. `publishCaseDiagnosed` checks the
      // latter too, and `run-ladder` refuses an empty ladder, and Inngest's
      // idempotency key stops a duplicate event starting a second run — three
      // independent guards, because the failure mode is doubled messages to a
      // real person.
      if (!r.aborted && r.policyId) {
        await ctx.publish?.caseDiagnosed({
          caseId: r.caseId,
          merchantId: ctx.merchantId,
          causeClass: r.causeClass,
          policyId: r.policyId,
          policyVersion: r.policyVersion,
          cohort: r.cohort,
          attended: r.attended,
        });
      }

      return {
        event,
        handled: true,
        outcome: r.aborted ? 'aborted' : 'diagnosed',
        caseId: r.caseId,
        detail: {
          causeClass: r.causeClass,
          policyId: r.policyId,
          attended: r.attended,
          cohort: r.cohort,
          created: r.created,
          unrecognisedReason: r.unrecognisedReason,
        },
      };
    }

    // ──he money arrived: close the case before anything can be sent ──
    case 'order.paid':
    case 'payment.captured':
    case 'payment_link.paid':
    case 'subscription.charged': {
      const payment = extractEntity<RazorpayPaymentEntity>(envelope, 'payment');
      const order = extractEntity<Record<string, unknown>>(envelope, 'order');
      const orderId =
        (typeof order?.id === 'string' ? order.id : null) ??
        (typeof payment?.order_id === 'string' ? payment.order_id : null);

      if (!payment) return { event, handled: false, outcome: 'missing_payment_entity' };
      const r = await handlePaymentSucceeded(ctx, payment, { orderId });

      // STOP THE LADDER, immediately.
      //
      // `run-ladder` declares `cancelOn` for this event, so it dies wherever it
      // is sleeping — no polling, no check to forget on a new rung type. This
      // is why the money arriving must publish promptly: the gate would also
      // catch it at the next rung, but "the next rung" can be 26 hours away,
      // and a recovery message sent to someone who already paid is the mistake
      // that ends the merchant relationship.
      if (r.closed && r.caseId) {
        await ctx.publish?.caseResolved({
          caseId: r.caseId,
          merchantId: ctx.merchantId,
          outcome: 'recovered',
          reason: event,
        });
      }

      return { event, handled: true, outcome: r.reason, caseId: r.caseId };
    }

    case 'invoice.paid': {
      const payment = extractEntity<RazorpayPaymentEntity>(envelope, 'payment');
      const invoice = extractEntity<Record<string, unknown>>(envelope, 'invoice');
      const orderId = typeof invoice?.order_id === 'string' ? invoice.order_id : null;
      if (!payment) return { event, handled: false, outcome: 'missing_payment_entity' };
      const r = await handlePaymentSucceeded(ctx, payment, { orderId });
      return { event, handled: true, outcome: r.reason, caseId: r.caseId };
    }

    // ── deliberate endings ──
    case 'subscription.cancelled':
    case 'payment_link.cancelled': {
      const entity =
        extractEntity<Record<string, unknown>>(envelope, 'subscription') ??
        extractEntity<Record<string, unknown>>(envelope, 'payment_link');
      const orderId = typeof entity?.order_id === 'string' ? entity.order_id : null;
      if (!orderId) return { event, handled: false, outcome: 'no_order_reference' };
      const r = await handleCaseAborted(ctx, orderId, 'subscription_cancelled');
      return { event, handled: true, outcome: r.closed ? 'aborted' : 'no_live_case', caseId: r.caseId };
    }

    // ── the downtime feed ──
    case 'payment.downtime.started':
    case 'payment.downtime.updated':
    case 'payment.downtime.resolved': {
      const entity = extractEntity<RazorpayDowntimeEntity>(envelope, 'payment.downtime');
      if (!entity) return { event, handled: false, outcome: 'missing_downtime_entity' };
      const r = await handleDowntime(ctx.db, entity, event, ctx.now);
      return {
        event,
        handled: true,
        outcome: r.action,
        detail: { id: r.id, method: r.method, bank: r.bank },
      };
    }

    // ── observed, not yet acted on ──
    // Deliberately explicit rather than a silent default, so the list of what
    // we are not yet doing is visible in the code.
    case 'payment.authorized':
    case 'payment_link.expired':
    case 'invoice.partially_paid':
    case 'invoice.expired':
    case 'subscription.pending':
    case 'subscription.halted':
    case 'refund.created':
      return { event, handled: false, outcome: 'observed_not_implemented' };

    default:
      return { event, handled: false, outcome: 'unrouted' };
  }
}

/**
 * Process a claimed delivery and mark it done.
 *
 * A failure here is recorded on the webhook row rather than rethrown: the event
 * has already been claimed, so Razorpay will not resend it, and the redrive
 * sweep is what recovers it. Throwing would lose the event entirely.
 */
export async function processClaimedEvent(
  db: Database,
  ctx: HandlerContext,
  eventId: string,
  envelope: RazorpayWebhookEnvelope,
): Promise<ProcessResult> {
  try {
    const result = await processEvent(ctx, envelope);
    await markWebhookProcessed(db, eventId);
    return result;
  } catch (e) {
    const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    await markWebhookFailed(db, eventId, message);
    return {
      event: envelope.event ?? 'unknown',
      handled: false,
      outcome: 'error',
      detail: { error: message },
    };
  }
}

export type { HandlerContext };
