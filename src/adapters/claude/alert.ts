/**
 * Merchant alert prose.
 *
 * The one output in this system a merchant reads while something of theirs is
 * actively broken. Until now it was `signal: 'ladder'` with `amountAtRisk: 0` —
 * a row in a table with nothing in it worth reading.
 *
 * ── what the model is and is not allowed to decide ──
 *
 * Every NUMBER in the alert is computed before this is called: how many cases,
 * how much money, when it started, what the baseline is. The model receives
 * them as facts and may only restate them. It never counts anything, and it is
 * told not to introduce a figure that is not in its input.
 *
 * `severity` likewise comes from the policy row, not from here. Whether a
 * condition is `warning` or `critical` decides whether somebody's phone buzzes
 * at 2am, and that belongs in a reviewed YAML table rather than in a paragraph
 * generator.
 *
 * So the model's whole job is the sentence: turn a correct set of facts into
 * something a merchant understands in five seconds. That is a real job — the
 * facts alone read like a log line — and it is one where being wrong costs a
 * confusing alert rather than a wrong action.
 *
 * ── the house style, and why it is a hard rule ──
 *
 * Diagnostic, never prescriptive. We say what broke and what it is costing.
 * We do not say "disable UPI". Turning off a payment method is a commercial
 * decision that can cost a merchant far more than the outage, we do not have
 * their context, and a recovery agent that starts issuing operational orders is
 * one bad paragraph away from doing real damage.
 */

import { z } from 'zod';

import { formatINR, type Paise } from '../../core/money.js';
import type { CauseClass } from '../../core/taxonomy/cause-class.js';
import { MAX_FIELD, type ClaudeError, ask, clamp } from './client.js';
import { type Result, ok } from '../../lib/result.js';
import type Anthropic from '@anthropic-ai/sdk';

export interface AlertFacts {
  readonly merchantName: string;
  /** Stable condition key, e.g. `bank_not_enabled:ICIC:netbanking`. */
  readonly signal: string;
  readonly causeClass: CauseClass;
  readonly errorReason: string | null;
  readonly method: string;
  readonly bank: string | null;
  /** Counted, not estimated. */
  readonly affectedCases: number;
  readonly amountAtRisk: Paise;
  readonly onsetAt: Date;
  readonly windowHours: number;
  /** This merchant's normal failure rate for the method, in basis points. */
  readonly baselineRateBps: number | null;
  /** Observed failure rate over the window, in basis points. */
  readonly observedRateBps: number | null;
  /** Rationale lines from diagnose() on a representative case. */
  readonly sampleRationale: readonly string[];
}

export interface AlertProse {
  /** One line, no trailing full stop. Shown in the alert list. */
  readonly title: string;
  /** Two or three sentences. Facts, cost, and what is knowable — no advice. */
  readonly detail: string;
}

/**
 * The title is CLAMPED after validation, not rejected for being long.
 *
 * It fills a single line in the alert list, so a 300-character title is a
 * layout problem — but throwing away a correct alert during an outage to
 * enforce a column width would be a much worse one. See `MAX_FIELD`.
 */
const TITLE_DISPLAY_LIMIT = 120;

const alertSchema = z.object({
  title: z.string().min(8).max(MAX_FIELD),
  detail: z.string().min(40).max(MAX_FIELD),
});

export const JSON_SCHEMA = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description:
        'One line naming what is broken and where. No trailing full stop. Max 120 characters.',
    },
    detail: {
      type: 'string',
      description:
        'Two or three sentences: what is failing, what it has cost so far, when it started, ' +
        'and how that compares to normal. No recommendations.',
    },
  },
  required: ['title', 'detail'],
  additionalProperties: false,
} as const;

const SYSTEM = `You write operational alerts for Indian merchants using Razorpay, on behalf of a payment-recovery agent called Vyavas.

Your alert is read by a merchant while something of theirs is actively losing money. Optimise for being understood in five seconds.

RULES, in order of importance:

1. Never state a number that is not in the input. You may restate the counts, amounts, times and rates you are given. You may not estimate, extrapolate, round in a way that changes meaning, or infer a trend from a single window.

2. Never recommend an action. Do not tell the merchant to disable a payment method, switch a provider, contact anyone, or change a setting. State what is broken and what it is costing; the decision is theirs and they have context you do not. This rule holds even when the fix looks obvious.

3. Distinguish fault correctly. A merchant_config cause means the merchant's own setup is rejecting payments and every affected customer is a silent total loss until they act. A transient_infra cause means a bank or gateway is down and nobody did anything wrong. Never imply the merchant caused an outage, and never imply an outage caused a misconfiguration.

4. Plain language, no jargon, no marketing tone, no exclamation marks, no apologising. Write like a colleague reporting a fact. Indian number formatting is already applied to the amounts you are given — reproduce them exactly as written.

5. If the input contains a bank or method name, name it. "HDFC netbanking" is actionable; "a payment method" is not.

Return only the JSON object.`;

function render(f: AlertFacts): string {
  const lines = [
    `Merchant: ${f.merchantName}`,
    `Condition key: ${f.signal}`,
    `Cause class: ${f.causeClass}`,
    `Razorpay failure reason: ${f.errorReason ?? 'unknown'}`,
    `Payment method: ${f.method}`,
    `Bank: ${f.bank ?? 'not method-specific'}`,
    ``,
    `Affected cases in the last ${f.windowHours}h: ${f.affectedCases}`,
    `Amount at risk: ${formatINR(f.amountAtRisk)}`,
    `First seen: ${f.onsetAt.toISOString()}`,
  ];

  if (f.observedRateBps !== null) {
    lines.push(`Observed failure rate over the window: ${(f.observedRateBps / 100).toFixed(1)}%`);
  }
  if (f.baselineRateBps !== null) {
    lines.push(`This merchant's normal rate for this method: ${(f.baselineRateBps / 100).toFixed(1)}%`);
  }

  if (f.sampleRationale.length > 0) {
    lines.push(``, `Diagnosis of a representative case:`);
    for (const line of f.sampleRationale) lines.push(`  - ${line}`);
  }

  return lines.join('\n');
}

/**
 * A correct, readable alert with no model involved.
 *
 * Not a placeholder — this is what ships whenever Claude is unconfigured, slow,
 * or down, and it has to be genuinely usable on its own. The model improves the
 * sentence; it is not what makes the alert true.
 */
export function fallbackProse(f: AlertFacts): AlertProse {
  const where = f.bank ? `${f.bank} ${f.method}` : f.method;
  const title =
    f.causeClass === 'merchant_config'
      ? `${where} payments are being rejected by your account configuration`
      : `Elevated ${where} payment failures`;

  const rate =
    f.observedRateBps !== null
      ? ` Failure rate over the window is ${(f.observedRateBps / 100).toFixed(1)}%${
          f.baselineRateBps !== null ? ` against a normal ${(f.baselineRateBps / 100).toFixed(1)}%` : ''
        }.`
      : '';

  return {
    title,
    detail:
      `${f.affectedCases} case(s) worth ${formatINR(f.amountAtRisk)} have failed with ` +
      `'${f.errorReason ?? 'an unknown reason'}' since ${f.onsetAt.toISOString()}.${rate}`,
  };
}

export async function writeAlertProse(
  facts: AlertFacts,
  opts: { client?: Anthropic; timeoutMs?: number } = {},
): Promise<Result<AlertProse, ClaudeError>> {
  const result = await ask<AlertProse>({
    system: SYSTEM,
    user: render(facts),
    schema: JSON_SCHEMA as unknown as Record<string, unknown>,
    validator: alertSchema,
    // Prose from facts that are already correct. The judgement is in the
    // wording, not in the analysis, and `high` buys nothing here.
    effort: 'medium',
    maxTokens: 4_000,
    ...(opts.client ? { client: opts.client } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });

  if (!result.ok) return result;
  return ok({ ...result.value, title: clamp(result.value.title, TITLE_DISPLAY_LIMIT) });
}
