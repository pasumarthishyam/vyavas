/**
 * Composition: a case + an intent -> a template and its variables.
 *
 * PURE. No network, no clock, no database. Every value it needs is an argument,
 * so the full matrix of "what would we actually say to this person" is a table
 * of unit tests rather than a staging environment and a real phone.
 *
 * A note on where the LLM is, and is not.
 *
 * The Stage 7 plan said Claude would pick the template and fill the variables.
 * Building it made clear that is not true: the intent already determines the
 * template, the language is a lookup on the customer's locale, and every
 * variable is a deterministic projection of the case. There is no judgement
 * left for a model to make, and routing it through one would add latency, cost
 * and non-determinism to a function that is currently exhaustively testable.
 *
 * Claude earns its place in this product on inbound replies — "I already paid",
 * "wrong number", "we need a PO number" — which is genuinely open-ended. That is
 * the next stage, and it is a different function. Composition stays pure.
 */

import { formatINR, type Paise } from '../core/money.js';
import type { MessageIntent } from '../core/actions/types.js';
import {
  type TemplateDefinition,
  type TemplateLanguage,
  type VariableRole,
  templateFor,
} from './templates.js';

export interface ComposeContext {
  readonly intent: MessageIntent;
  /** BCP-47 from the customer record. Falls back to English. */
  readonly locale: string | null;
  readonly customerName: string | null;
  readonly merchantName: string;
  readonly amountPaise: Paise;
  /** Razorpay short URL. Null when the ladder has not created one. */
  readonly paymentLink: string | null;
  /** For pre-debit notices. */
  readonly debitAt?: Date | null;
  readonly planName?: string | null;
}

export interface ComposedMessage {
  readonly templateName: string;
  readonly language: TemplateLanguage;
  /** Positional, matching {{1}}…{{n}}. */
  readonly variables: readonly string[];
  /** The body with variables substituted. Audit trail and email fallback only. */
  readonly preview: string;
  readonly intent: MessageIntent;
}

export type ComposeFailure =
  | 'no_template'
  | 'missing_payment_link'
  | 'missing_debit_date'
  | 'variable_contract_mismatch';

export type ComposeResult =
  | { ok: true; message: ComposedMessage }
  | { ok: false; reason: ComposeFailure; detail: string };

/**
 * Language from locale.
 *
 * Only English ships in Stage 7. The lookup exists so adding Hindi is a
 * templates.ts change rather than a code change, and so the fallback is
 * explicit rather than accidental.
 */
export function languageFor(locale: string | null): TemplateLanguage {
  if (!locale) return 'en';
  const base = locale.toLowerCase().split('-')[0];
  return base === 'en' ? 'en' : 'en';
}

/**
 * A name safe to put in a message.
 *
 * Falls back to "there" rather than an empty string: "Hi , your payment…" is
 * worse than a generic greeting, and Meta rejects a send whose variable is
 * blank. Only the first name — a full legal name in a WhatsApp greeting reads
 * like a debt collector.
 */
export function greetingName(raw: string | null): string {
  if (!raw) return 'there';
  const first = raw.trim().split(/\s+/)[0] ?? '';
  const cleaned = first.replace(/[\r\n\t]+/g, ' ').trim();
  if (cleaned.length === 0 || cleaned.length > 24) return 'there';
  return cleaned;
}

/**
 * WhatsApp rejects a variable containing a newline, a tab, or a run of four or
 * more spaces — at SEND time, not at review. Which means an unsanitised value
 * fails in production, on a real case, at whatever hour the ladder fires.
 */
export function sanitizeVariable(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, ' ').trim();
}

function formatDebitDate(at: Date): string {
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'long',
    timeZone: 'Asia/Kolkata',
  }).format(at);
}

function resolveVariable(role: VariableRole, ctx: ComposeContext): string | null {
  switch (role) {
    case 'customer_name':
      return greetingName(ctx.customerName);
    // Compact: "Rs 1,843" not "Rs 1,843.00". Trailing zeros in a message read as
    // machine output, and the Indian lakh grouping is what a payer expects.
    case 'amount':
      return formatINR(ctx.amountPaise, { compact: true });
    case 'merchant_name':
      return ctx.merchantName;
    case 'payment_link':
      return ctx.paymentLink;
    case 'debit_date':
      return ctx.debitAt ? formatDebitDate(ctx.debitAt) : null;
    case 'plan_name':
      return ctx.planName ?? ctx.merchantName;
    default:
      return null;
  }
}

export function compose(ctx: ComposeContext): ComposeResult {
  const language = languageFor(ctx.locale);
  const template = templateFor(ctx.intent, language);

  if (!template) {
    return {
      ok: false,
      reason: 'no_template',
      detail: `No approved template for intent '${ctx.intent}' in '${language}'.`,
    };
  }

  const variables: string[] = [];

  for (const role of template.variables) {
    const value = resolveVariable(role, ctx);

    if (value === null || value.length === 0) {
      // A missing value is a refusal to send, never a blank substitution.
      // "Pay here: " with nothing after it is worse than no message at all.
      if (role === 'payment_link') {
        return {
          ok: false,
          reason: 'missing_payment_link',
          detail: `Template '${template.name}' needs a payment link and none was created.`,
        };
      }
      if (role === 'debit_date') {
        return {
          ok: false,
          reason: 'missing_debit_date',
          detail: `Template '${template.name}' needs a debit date.`,
        };
      }
      return {
        ok: false,
        reason: 'variable_contract_mismatch',
        detail: `Template '${template.name}' variable '${role}' resolved to nothing.`,
      };
    }

    variables.push(sanitizeVariable(value));
  }

  return {
    ok: true,
    message: {
      templateName: template.name,
      language,
      variables,
      preview: renderPreview(template, variables),
      intent: ctx.intent,
    },
  };
}

/**
 * Substitute variables into the body.
 *
 * The audit trail and the email fallback both use this — email has no template
 * concept, so the rendered text IS the email. WhatsApp never receives this
 * string; it receives the template name and the positional variables, and Meta
 * renders it from the approved copy on their side.
 */
export function renderPreview(
  template: TemplateDefinition,
  variables: readonly string[],
): string {
  return template.body.replace(/\{\{(\d+)\}\}/g, (_match, index: string) => {
    const value = variables[Number(index) - 1];
    return value ?? `{{${index}}}`;
  });
}

/** A short subject line for the email channel. */
export function emailSubject(intent: MessageIntent, merchantName: string): string {
  const subjects: Record<MessageIntent, string> = {
    switch_method: `Your payment to ${merchantName} didn't go through`,
    retry_now_service_restored: `You can complete your ${merchantName} payment now`,
    reminder: `Your ${merchantName} payment is still pending`,
    final_reminder: `Last reminder: your ${merchantName} order`,
    cart_saved: `Your ${merchantName} order is saved`,
    pre_debit_notice: `Upcoming debit for your ${merchantName} subscription`,
    subscription_at_risk: `Action needed: your ${merchantName} subscription`,
    invoice_due: `Invoice from ${merchantName} is due`,
    bank_action_required: `Your bank blocked the card for your ${merchantName} order`,
    call_follow_up: `Your payment link from ${merchantName}`,
  };
  return subjects[intent];
}
