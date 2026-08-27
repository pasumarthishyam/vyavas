/**
 * The nine cause classes.
 *
 * Razorpay's ~43 documented error reasons collapse into nine buckets, grouped
 * by the only question that changes what we do:
 *
 *      what has to change for the money to arrive?
 *
 * Grouping by anything else (severity, payment method, error text) produces
 * buckets that all get the same generic "your payment failed" email, which is
 * the failure mode of every dunning tool on the market.
 *
 * Each class carries *traits* — the behavioural facts that are true for every
 * member of the class. Policy rows may narrow these; they may never widen the
 * dangerous ones (`sameInstrumentRetry`, `contactCustomer`).
 */

import type { AlternateRail } from '../case/types.js';

export const CAUSE_CLASSES = [
  'transient_infra', // A - bank/gateway is down. Nobody's fault. Wait for it.
  'instrument_dead', // B - this card/account/VPA will never work. Switch.
  'customer_input', // C - a typo. Highest recovery rate in the taxonomy.
  'auth_friction', // D - OTP/3DS did not complete.
  'funds_limits', // E - money or limits. Timing is the whole game.
  'risk', // F - fraud/risk decline. The one place aggression backfires.
  'merchant_config', // G - the merchant's setup is broken. Not the customer.
  'terminal_noop', // H - already paid / duplicate. Stop everything.
  'intent_exit', // I - the customer chose to leave. Not an error.
] as const;

export type CauseClass = (typeof CAUSE_CLASSES)[number];

export interface CauseClassTraits {
  readonly id: CauseClass;
  readonly label: string;
  readonly description: string;

  /**
   * May we present the SAME instrument again?
   *
   * False for anything where the instrument is structurally unusable. Retrying
   * a `card_expired` or a `lost_card` cannot succeed, annoys the customer, and
   * degrades the merchant's authorisation rate with the issuer.
   */
  readonly sameInstrumentRetry: boolean;

  /** Should the customer hear from us at all? False for merchant-side faults. */
  readonly contactCustomer: boolean;

  /** Should the merchant be alerted? True where the merchant must fix something. */
  readonly alertMerchant: boolean;

  /**
   * Hard ceiling on customer touches for this class, before any policy row is
   * consulted. Policy may lower it; policy may not raise it.
   */
  readonly maxCustomerTouches: number;

  /**
   * Minimum wait before the first customer contact.
   *
   * Zero for typos (the customer is right there, staring at the error). Non-zero
   * for infrastructure, because messaging someone while their bank is still down
   * walks them straight into a second failure.
   */
  readonly minFirstTouchMinutes: number;

  /** Rails worth suggesting for this class, best first. */
  readonly defaultRails: readonly AlternateRail[];

  /**
   * How we are permitted to talk about it.
   *
   * `neutral` matters for `risk`: we never tell a customer their bank flagged
   * them as fraud. `none` means we do not speak to the customer at all.
   */
  readonly framing: 'neutral' | 'educational' | 'reassuring' | 'informational' | 'none';

  /** True where waiting on Razorpay's downtime feed beats waiting on a clock. */
  readonly downtimeGated: boolean;
}

const T = (t: CauseClassTraits) => t;

export const CAUSE_CLASS_TRAITS: Readonly<Record<CauseClass, CauseClassTraits>> = {
  transient_infra: T({
    id: 'transient_infra',
    label: 'Transient infrastructure',
    description:
      "The bank, PSP or gateway had a problem. The customer did nothing wrong and neither did " +
      'the merchant. The instrument is fine — only the timing was bad.',
    sameInstrumentRetry: true,
    contactCustomer: true,
    alertMerchant: true, // only when concentrated; the workflow decides
    maxCustomerTouches: 3,
    // Never message inside the first 20 minutes: they may still be retrying,
    // and the bank is probably still down.
    minFirstTouchMinutes: 20,
    defaultRails: ['upi_intent', 'retry_same', 'other_card'],
    framing: 'reassuring',
    downtimeGated: true,
  }),

  instrument_dead: T({
    id: 'instrument_dead',
    label: 'Instrument unusable',
    description:
      'This card, account or VPA cannot complete a payment — expired, blocked, not enrolled for ' +
      'online use, or invalid. No amount of retrying changes that. The customer must switch.',
    sameInstrumentRetry: false,
    contactCustomer: true,
    alertMerchant: false,
    maxCustomerTouches: 3,
    // Short, not zero: a live-attempt lock upstream stops us interrupting
    // someone who is already mid-retry on another card.
    minFirstTouchMinutes: 3,
    defaultRails: ['upi_intent', 'other_card', 'netbanking'],
    // Educational, not apologetic. "Your bank has online payments switched off
    // for this card" is actionable; "payment failed, please try again" is not.
    framing: 'educational',
    downtimeGated: false,
  }),

  customer_input: T({
    id: 'customer_input',
    label: 'Customer input error',
    description:
      'A typo — wrong CVV, wrong OTP, wrong PIN, malformed VPA. The highest-recovery class in ' +
      'the taxonomy: intent is proven and the fix takes seconds.',
    sameInstrumentRetry: true,
    contactCustomer: true,
    alertMerchant: false,
    maxCustomerTouches: 2,
    // Zero. The customer is present and just made a mistake. Intent decays in
    // minutes, not hours.
    minFirstTouchMinutes: 0,
    defaultRails: ['retry_same', 'upi_intent', 'other_card'],
    framing: 'neutral',
    downtimeGated: false,
  }),

  auth_friction: T({
    id: 'auth_friction',
    label: 'Authentication friction',
    description:
      '3DS/OTP did not complete — the SMS was late, the bank page timed out, the challenge was ' +
      'abandoned. In India this is very often delivery latency rather than a real refusal.',
    sameInstrumentRetry: true, // exactly once; see diagnose.ts attempt guard
    contactCustomer: true,
    alertMerchant: false,
    maxCustomerTouches: 3,
    minFirstTouchMinutes: 10,
    defaultRails: ['upi_intent', 'retry_same', 'other_card'],
    framing: 'reassuring',
    downtimeGated: false,
  }),

  funds_limits: T({
    id: 'funds_limits',
    label: 'Funds or limits',
    description:
      'Insufficient balance, or a per-transaction/daily limit. The instrument works; the money or ' +
      'the headroom is not there right now. Timing is the entire lever.',
    sameInstrumentRetry: true,
    contactCustomer: true,
    alertMerchant: false,
    maxCustomerTouches: 4,
    minFirstTouchMinutes: 180,
    defaultRails: ['upi_intent', 'other_card', 'emi', 'paylater'],
    framing: 'neutral',
    downtimeGated: false,
  }),

  risk: T({
    id: 'risk',
    label: 'Risk or fraud decline',
    description:
      'The issuer or a risk system refused. Repeated attempts raise the risk score, can get the ' +
      'card blocked, and degrade the merchant’s overall authorisation rate.',
    // Hard cap: one attempt on a DIFFERENT rail, then stop. Never re-present.
    sameInstrumentRetry: false,
    contactCustomer: true,
    alertMerchant: false,
    maxCustomerTouches: 1,
    minFirstTouchMinutes: 15,
    defaultRails: ['upi_intent'],
    // Never reveal a risk decline. "Your bank couldn't complete this - UPI
    // usually works" is the whole permitted vocabulary.
    framing: 'neutral',
    downtimeGated: false,
  }),

  merchant_config: T({
    id: 'merchant_config',
    label: 'Merchant configuration',
    description:
      'The merchant’s own setup is broken — a method not enabled, live mode off, a malformed ' +
      'request. Every customer hitting this is a total, ongoing, silent loss.',
    sameInstrumentRetry: false,
    // The customer is not the problem and must never be told they are. They may
    // still be rescued onto a working rail — that is a separate, parallel track.
    contactCustomer: true,
    alertMerchant: true,
    maxCustomerTouches: 1,
    minFirstTouchMinutes: 2,
    defaultRails: ['upi_intent', 'other_card'],
    framing: 'reassuring',
    downtimeGated: false,
  }),

  terminal_noop: T({
    id: 'terminal_noop',
    label: 'Terminal / no action',
    description:
      'Already paid, or a duplicate request. There is no revenue at risk. Close the case and ' +
      'cancel every queued action immediately.',
    sameInstrumentRetry: false,
    contactCustomer: false, // absolutely never
    alertMerchant: false,
    maxCustomerTouches: 0,
    minFirstTouchMinutes: 0,
    defaultRails: [],
    framing: 'none',
    downtimeGated: false,
  }),

  intent_exit: T({
    id: 'intent_exit',
    label: 'Deliberate exit',
    description:
      'The customer chose to leave — cancelled the payment or abandoned checkout. This is a live ' +
      'intent signal, not a malfunction. It never enters failure-rate alerting and it never gets ' +
      'failure language.',
    sameInstrumentRetry: true,
    contactCustomer: true,
    alertMerchant: false,
    maxCustomerTouches: 3,
    // Long enough that we are not chasing someone who stepped away for a minute.
    minFirstTouchMinutes: 20,
    defaultRails: ['upi_intent', 'retry_same'],
    framing: 'informational',
    downtimeGated: false,
  }),
};

export function traitsFor(causeClass: CauseClass): CauseClassTraits {
  return CAUSE_CLASS_TRAITS[causeClass];
}

/** True for classes where the merchant must act for the loss to stop. */
export function isMerchantFault(causeClass: CauseClass): boolean {
  return causeClass === 'merchant_config';
}

/** True for classes that must never produce a customer message. */
export function isSilent(causeClass: CauseClass): boolean {
  return !CAUSE_CLASS_TRAITS[causeClass].contactCustomer;
}
