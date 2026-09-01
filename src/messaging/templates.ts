/**
 * The message templates.
 *
 * Every WhatsApp message we send is a pre-approved template. Outside a 24-hour
 * window opened by the CUSTOMER messaging US first, free-form text is simply
 * rejected — and a customer who abandoned a payment has not messaged us. So:
 * templates, always, with variables filled in.
 *
 * That constraint is doing us a favour. It means no message can be improvised,
 * every word a customer sees was reviewed once, and the whole surface is
 * auditable. The rules it imposes on the text below:
 *
 *   - Category UTILITY. These are about a payment the customer just attempted,
 *     which is what makes them sendable at all. The moment one carries a
 *     discount it becomes MARKETING: different consent, worse delivery, higher
 *     cost. That is why no template here mentions one.
 *   - A body may not START or END with a variable. Every template below closes
 *     on real words.
 *   - No newlines inside a variable value — Meta rejects the send, not the
 *     template, so it fails at 3am rather than at review.
 *   - Four variables maximum. A body that is mostly placeholders gets rejected
 *     at review as low quality.
 *
 * One template per MessageIntent. The reason-specific wording lives in the
 * template rather than in a variable, because a variable cannot carry a whole
 * sentence and because Meta reviews the words, not the values.
 */

import type { MessageIntent } from '../core/actions/types.js';

export const TEMPLATE_LANGUAGES = ['en', 'en_US'] as const;
export type TemplateLanguage = (typeof TEMPLATE_LANGUAGES)[number];

/** What each numbered placeholder means. Enforced by `compose.ts`. */
export type VariableRole =
  | 'customer_name'
  | 'amount'
  | 'merchant_name'
  | 'payment_link'
  | 'debit_date'
  | 'plan_name';

export interface TemplateDefinition {
  /** Meta template name: lowercase, underscores, unique per WABA. */
  readonly name: string;
  readonly intent: MessageIntent;
  readonly category: 'UTILITY';
  readonly language: TemplateLanguage;
  /** Body text with {{1}}…{{n}} placeholders. */
  readonly body: string;
  /** Role of each placeholder, in order. Length must equal the placeholder count. */
  readonly variables: readonly VariableRole[];
  /** Sample values Meta requires when submitting for review. */
  readonly examples: readonly string[];
  /** Why this wording, for whoever edits it next. */
  readonly rationale: string;
}

const T = (t: TemplateDefinition) => t;

export const TEMPLATES: readonly TemplateDefinition[] = [
  T({
    name: 'vyavas_switch_method_en',
    intent: 'switch_method',
    category: 'UTILITY',
    language: 'en',
    body:
      "Hi {{1}}, your payment of {{2}} to {{3}} didn't go through.\n\n" +
      'You can complete it in a few seconds here: {{4}}\n\n' +
      'Your order is saved.',
    variables: ['customer_name', 'amount', 'merchant_name', 'payment_link'],
    examples: ['Rahul', 'Rs 1,843', 'Kirana Cloud', 'https://rzp.io/i/example'],
    rationale:
      'Neutral, no blame, no urgency. "Your order is saved" is the line that actually reduces ' +
      'anxiety — the common fear after a failed payment is that the order is gone.',
  }),

  T({
    name: 'vyavas_service_restored_en',
    intent: 'retry_now_service_restored',
    category: 'UTILITY',
    language: 'en',
    body:
      'Hi {{1}}, good news — the bank issue that stopped your {{2}} payment to {{3}} has been resolved.\n\n' +
      'You can complete it now: {{4}}\n\n' +
      'Sorry for the trouble.',
    variables: ['customer_name', 'amount', 'merchant_name', 'payment_link'],
    examples: ['Rahul', 'Rs 1,843', 'Kirana Cloud', 'https://rzp.io/i/example'],
    rationale:
      'The single highest-value message in the set, and the reason the downtime feed exists. ' +
      '"The bank is back" is a different proposition from "please try again" — it tells the ' +
      'customer the thing that blocked them is gone, and it is only honest because we waited ' +
      'for Razorpay to confirm resolution rather than guessing at a timer.',
  }),

  T({
    name: 'vyavas_bank_action_required_en',
    intent: 'bank_action_required',
    category: 'UTILITY',
    language: 'en',
    body:
      'Hi {{1}}, your bank has online payments switched off for the card you used for your {{2}} order with {{3}}.\n\n' +
      'You can turn it on in your banking app, or pay by UPI here: {{4}}\n\n' +
      'Either works.',
    variables: ['customer_name', 'amount', 'merchant_name', 'payment_link'],
    examples: ['Rahul', 'Rs 1,843', 'Kirana Cloud', 'https://rzp.io/i/example'],
    rationale:
      'For card_not_enrolled and card_disabled_for_online_payments — enormous on Indian debit ' +
      'cards. Educational rather than apologetic: most customers do not know this is a setting. ' +
      'Offers UPI as the immediate path because most people will take it now and fix the card later.',
  }),

  T({
    name: 'vyavas_reminder_en',
    intent: 'reminder',
    category: 'UTILITY',
    language: 'en',
    body:
      'Hi {{1}}, a quick reminder that your {{2}} payment to {{3}} is still pending.\n\n' +
      "Here's the link when you're ready: {{4}}\n\n" +
      'No rush.',
    variables: ['customer_name', 'amount', 'merchant_name', 'payment_link'],
    examples: ['Rahul', 'Rs 1,843', 'Kirana Cloud', 'https://rzp.io/i/example'],
    rationale: 'Deliberately low-pressure. "No rush" is doing real work on the second touch.',
  }),

  T({
    name: 'vyavas_final_reminder_en',
    intent: 'final_reminder',
    category: 'UTILITY',
    language: 'en',
    body:
      'Hi {{1}}, last reminder about your {{2}} order with {{3}}.\n\n' +
      'The payment link expires soon: {{4}}\n\n' +
      "We won't message again about this.",
    variables: ['customer_name', 'amount', 'merchant_name', 'payment_link'],
    examples: ['Rahul', 'Rs 1,843', 'Kirana Cloud', 'https://rzp.io/i/example'],
    rationale:
      'The closing line is a promise the ladder actually keeps — max_messages caps it. Saying so ' +
      'converts better than an unbounded sequence and is the honest thing to say.',
  }),

  T({
    name: 'vyavas_cart_saved_en',
    intent: 'cart_saved',
    category: 'UTILITY',
    language: 'en',
    body:
      'Hi {{1}}, your {{2}} order with {{3}} is still saved.\n\n' +
      'Pick up where you left off: {{4}}\n\n' +
      "It'll be here when you're ready.",
    variables: ['customer_name', 'amount', 'merchant_name', 'payment_link'],
    examples: ['Rahul', 'Rs 1,843', 'Kirana Cloud', 'https://rzp.io/i/example'],
    rationale:
      'For intent_exit ONLY — a customer who chose to leave. Contains no failure language at all: ' +
      'nothing broke, they made a decision. Telling someone their payment "failed" when they ' +
      'pressed Back is both wrong and the fastest way to be marked as spam.',
  }),

  T({
    name: 'vyavas_subscription_at_risk_en',
    intent: 'subscription_at_risk',
    category: 'UTILITY',
    language: 'en',
    body:
      "Hi {{1}}, we couldn't collect {{2}} for your {{3}} subscription.\n\n" +
      'Update your payment method here to keep it active: {{4}}\n\n' +
      'Your access continues in the meantime.',
    variables: ['customer_name', 'amount', 'merchant_name', 'payment_link'],
    examples: ['Rahul', 'Rs 499', 'Kirana Cloud', 'https://rzp.io/i/example'],
    rationale:
      'The closing line matters commercially: a grace period beats a hard cutoff, and saying so ' +
      'removes the panic that makes people cancel outright.',
  }),

  T({
    name: 'vyavas_pre_debit_notice_en',
    intent: 'pre_debit_notice',
    category: 'UTILITY',
    language: 'en',
    body:
      'Hi {{1}}, this is advance notice that {{2}} will be debited for your {{3}} subscription on {{4}}.\n\n' +
      'No action is needed if this is expected.',
    variables: ['customer_name', 'amount', 'plan_name', 'debit_date'],
    examples: ['Rahul', 'Rs 499', 'Pro plan', '3 September'],
    rationale:
      'Required by RBI ahead of any e-mandate debit, not optional and not a courtesy. Carries no ' +
      'payment link on purpose — it is a notification, and a link would invite a duplicate payment.',
  }),

  T({
    name: 'vyavas_invoice_due_en',
    intent: 'invoice_due',
    category: 'UTILITY',
    language: 'en',
    body:
      'Hi {{1}}, your invoice of {{2}} from {{3}} is due.\n\n' +
      'You can pay it here: {{4}}\n\n' +
      'Reply here if you need anything.',
    variables: ['customer_name', 'amount', 'merchant_name', 'payment_link'],
    examples: ['Rahul', 'Rs 24,500', 'Kirana Cloud', 'https://rzp.io/i/example'],
    rationale:
      'B2B receivables. The invitation to reply is deliberate — in AR the blocker is usually a ' +
      'process question ("send it to our AP portal", "we need a PO"), and inviting it opens the ' +
      '24-hour window where a human can answer freely.',
  }),
  T({
    name: 'vyavas_call_follow_up_en',
    intent: 'call_follow_up',
    category: 'UTILITY',
    language: 'en',
    body:
      'Hi {{1}}, as discussed on the call, here is your payment link for {{2}} to {{3}}: {{4}}\n\n' +
      'Thanks for your time today.',
    variables: ['customer_name', 'amount', 'merchant_name', 'payment_link'],
    examples: ['Rahul', 'Rs 1,843', 'Kirana Cloud', 'https://rzp.io/i/example'],
    rationale:
      'The email follow-up after a discount-caller call. States the final payable amount only — ' +
      'never the word "discount" — for the same reason every other template here avoids it: it is ' +
      'what keeps this in the UTILITY category rather than MARKETING.',
  }),
];

// ─── lookup ──────────────────────────────────────────────────────────────────

const BY_INTENT = new Map<string, TemplateDefinition>();
for (const t of TEMPLATES) {
  const key = `${t.intent}:${t.language}`;
  if (BY_INTENT.has(key)) {
    throw new Error(`Duplicate template for ${key}: ${t.name}`);
  }
  BY_INTENT.set(key, t);
}

export function templateFor(
  intent: MessageIntent,
  language: TemplateLanguage = 'en',
): TemplateDefinition | null {
  return BY_INTENT.get(`${intent}:${language}`) ?? BY_INTENT.get(`${intent}:en`) ?? null;
}

export function templateByName(name: string): TemplateDefinition | null {
  return TEMPLATES.find((t) => t.name === name) ?? null;
}

/** Placeholder count actually present in the body. */
export function placeholderCount(body: string): number {
  const matches = body.match(/\{\{(\d+)\}\}/g) ?? [];
  const numbers = new Set(matches.map((m) => Number(m.slice(2, -2))));
  return numbers.size;
}
