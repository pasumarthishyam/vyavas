/**
 * The action allowlist.
 *
 * This union is the entire vocabulary of things the agent can do in the world.
 * The planner — deterministic policy today, LLM-assisted later — may only emit
 * a value of this type. It never gets a generic tool handle on the Razorpay API.
 *
 * That is the whole of "bounded autonomy": not a prompt asking the model to be
 * careful, but a type that makes the dangerous thing unrepresentable.
 *
 * Adding a member here is a deliberate expansion of what the agent may do, and
 * should be reviewed as such.
 */

import type { Paise } from '../money.js';
import type { AlternateRail, PaymentMethod } from '../case/types.js';

export const CHANNELS = ['whatsapp', 'sms', 'email', 'in_app'] as const;
export type Channel = (typeof CHANNELS)[number];

/**
 * The *intent* of a message, not its text.
 *
 * Copy is generated later, inside an approved template, from this intent plus
 * the case. Keeping intent and copy separate is what stops a failure ladder
 * from ever sounding like a marketing blast — and what keeps every template in
 * the transactional/utility category where it belongs.
 */
export const MESSAGE_INTENTS = [
  /** Instrument is dead; ask for a different method. Educational, not apologetic. */
  'switch_method',
  /** Transient outage has cleared; the payment is ready to go through now. */
  'retry_now_service_restored',
  /** Neutral reminder with a working link. */
  'reminder',
  /** Last touch before we stop. Still calm. */
  'final_reminder',
  /** Deliberate exit — cart is saved. Never uses failure language. */
  'cart_saved',
  /** Upcoming mandate debit; RBI pre-debit notification. */
  'pre_debit_notice',
  /** A subscription is at risk of lapsing. */
  'subscription_at_risk',
  /** An invoice is due or past due. */
  'invoice_due',
  /** Guidance the customer must act on at their bank (e.g. enable online txns). */
  'bank_action_required',
] as const;
export type MessageIntent = (typeof MESSAGE_INTENTS)[number];

export const ACTION_KINDS = [
  'nudge',
  'create_payment_link',
  'expire_payment_link',
  'retry_debit',
  'send_pre_debit_notice',
  'merchant_alert',
  'await_downtime_resolution',
  'escalate_to_human',
  'close_case',
  'no_op',
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

interface ActionBase {
  readonly kind: ActionKind;
  /** Ladder rung this action belongs to. Part of the idempotency key. */
  readonly rung: number;
}

/** Contact the customer. Always passes the frequency lock before it is sent. */
export interface NudgeAction extends ActionBase {
  readonly kind: 'nudge';
  /** Ordered by preference; the channel layer takes the first that is eligible. */
  readonly channels: readonly Channel[];
  readonly intent: MessageIntent;
  readonly suggest: readonly AlternateRail[];
  readonly attachPaymentLink: boolean;
}

export interface CreatePaymentLinkAction extends ActionBase {
  readonly kind: 'create_payment_link';
  readonly amount: Paise;
  readonly preferMethod: PaymentMethod | null;
  readonly expiresInMinutes: number;
}

/** Exactly one live link per case. Creating a new one expires the previous. */
export interface ExpirePaymentLinkAction extends ActionBase {
  readonly kind: 'expire_payment_link';
  readonly paymentLinkId: string;
}

/**
 * Re-present a debit against an existing mandate. UNATTENDED ONLY.
 *
 * The workflow must refuse this action on any case where `attended` is true —
 * there is no lawful silent card retry in India without a mandate.
 */
export interface RetryDebitAction extends ActionBase {
  readonly kind: 'retry_debit';
  readonly mandateId: string;
  readonly amount: Paise;
}

/** RBI requires notice before an e-mandate debit. Scheduled ahead of retry_debit. */
export interface SendPreDebitNoticeAction extends ActionBase {
  readonly kind: 'send_pre_debit_notice';
  readonly mandateId: string;
  readonly amount: Paise;
  readonly debitAt: Date;
  readonly channels: readonly Channel[];
}

/**
 * Tell the merchant something is broken on their side.
 *
 * Diagnostic only. We state the fact, the onset time and the baseline — we do
 * not prescribe. Turning a payment method off is the merchant's commercial
 * decision and we are not in a position to make it for them.
 */
export interface MerchantAlertAction extends ActionBase {
  readonly kind: 'merchant_alert';
  readonly severity: 'info' | 'warning' | 'critical';
  readonly signal: string;
  readonly affectedCases: number;
  readonly amountAtRisk: Paise;
  readonly onsetAt: Date;
}

/**
 * Park until Razorpay reports the outage resolved (or the timeout fires).
 *
 * This is why we do not guess "retry in 2-3 hours": we wait for the bank to
 * actually come back, then strike. A message that says "your bank is back
 * online" is a different product from one that says "please try again".
 */
export interface AwaitDowntimeResolutionAction extends ActionBase {
  readonly kind: 'await_downtime_resolution';
  readonly bank: string | null;
  readonly method: PaymentMethod;
  readonly timeoutMinutes: number;
}

/**
 * The human queues.
 *
 * A const array rather than an inline union so `db/schema/enums.ts` can derive
 * the Postgres enum from it — the same discipline as every other vocabulary
 * here. Adding a queue in core and forgetting the migration becomes a type
 * error rather than a runtime insert failure.
 */
export const ESCALATION_QUEUES = ['merchant_review', 'risk_review', 'ar_collections'] as const;
export type EscalationQueue = (typeof ESCALATION_QUEUES)[number];

export interface EscalateToHumanAction extends ActionBase {
  readonly kind: 'escalate_to_human';
  readonly queue: EscalationQueue;
  readonly note: string;
}

export interface CloseCaseAction extends ActionBase {
  readonly kind: 'close_case';
  readonly outcome: 'recovered' | 'lost' | 'aborted';
  readonly note: string;
}

/**
 * Holdout cases run the whole ladder and emit `no_op` in place of every real
 * action, so we get a complete record of what *would* have happened without
 * anything reaching the customer. That record is what makes the incrementality
 * number honest.
 */
export interface NoOpAction extends ActionBase {
  readonly kind: 'no_op';
  readonly wouldHaveBeen: ActionKind;
  readonly reason: 'holdout' | 'dry_run' | 'suppressed';
}

export type Action =
  | NudgeAction
  | CreatePaymentLinkAction
  | ExpirePaymentLinkAction
  | RetryDebitAction
  | SendPreDebitNoticeAction
  | MerchantAlertAction
  | AwaitDowntimeResolutionAction
  | EscalateToHumanAction
  | CloseCaseAction
  | NoOpAction;

/** Does this action reach a customer? Determines frequency-lock participation. */
export function touchesCustomer(action: Action): boolean {
  return (
    action.kind === 'nudge' ||
    action.kind === 'send_pre_debit_notice' ||
    (action.kind === 'no_op' &&
      (action.wouldHaveBeen === 'nudge' || action.wouldHaveBeen === 'send_pre_debit_notice'))
  );
}

/** Does this action move money? Requires write scope + merchant budget headroom. */
export function movesMoney(action: Action): boolean {
  return action.kind === 'retry_debit';
}

/**
 * Stable idempotency key. Two attempts at the same rung must collapse to one.
 *
 * The ONLY place this string is built. That matters more than it looks: the
 * console's manual path used to compose its own key as
 * `caseId:rung:channel` while the ladder used this one, `caseId:rung:kind`.
 * Both formats were reasonable, neither ever collided with the other, and the
 * duplicate guard was therefore inert across the one boundary where it had to
 * hold — the autonomous ladder would send a rung and a human pressing Start
 * would send it again, to the same person, both recorded as first touches.
 *
 * Two callers, one function. A key format that lives in two places is a key
 * format that will disagree.
 */
export function messageKey(caseId: string, rung: number, kind: Action['kind']): string {
  return `${caseId}:${rung}:${kind}`;
}

export function idempotencyKey(caseId: string, action: Action): string {
  return messageKey(caseId, action.rung, action.kind);
}
