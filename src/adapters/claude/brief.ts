/**
 * The escalation brief.
 *
 * `escalate_to_human` used to build an action, write a `case_actions` row, and
 * end. There was no queue, nothing read the row, and the only note on it was a
 * static string copied out of the YAML — so every `risk_review` case in the
 * system arrived looking exactly like every other one.
 *
 * Building the queue is the fix for the first half. This is the fix for the
 * second: a queue whose entries all say "escalated by ladder" will be ignored
 * within a week, and an ignored queue is worse than no queue because it looks
 * like coverage.
 *
 * ── why a model, for this specifically ──
 *
 * The facts of an escalation are spread across four tables: the tuple and
 * rationale on `recovery_cases`, what was planned on `case_actions`, what
 * happened on `case_events`, what was said on `message_log`. A human triaging
 * has to reassemble that before they can think. Everything needed is present
 * and structured; what is missing is the sentence that says what it means.
 *
 * That is the shape of task a model is genuinely good at, and the blast radius
 * is one paragraph read by one colleague.
 *
 * ── the recommendation field ──
 *
 * `recommendedAction` is advice to a person who decides, and it is labelled as
 * such in the UI. Nothing reads it back into the agent, and no action is ever
 * taken from it. The model is explicitly told it is briefing a human with more
 * context and authority than it has.
 */

import { z } from 'zod';

import { formatINR, type Paise } from '../../core/money.js';
import type { CauseClass } from '../../core/taxonomy/cause-class.js';
import { MAX_FIELD, type ClaudeError, ask, clamp } from './client.js';
import { type Result, ok } from '../../lib/result.js';
import type Anthropic from '@anthropic-ai/sdk';

export type EscalationQueue = 'merchant_review' | 'risk_review' | 'ar_collections';

/** One line from the case ledger, already ordered oldest first. */
export interface LedgerEntry {
  readonly at: Date;
  readonly kind: string;
  readonly reason: string | null;
  readonly note: string | null;
}

export interface BriefFacts {
  readonly queue: EscalationQueue;
  readonly merchantName: string;
  readonly caseType: string;
  readonly causeClass: CauseClass | null;
  readonly errorReason: string | null;
  readonly rawErrorReason: string | null;
  readonly errorSource: string | null;
  readonly errorStep: string | null;
  readonly method: string;
  readonly bank: string | null;
  readonly amountAtRisk: Paise;
  readonly attended: boolean;
  readonly confidence: string | null;
  readonly policyId: string | null;
  /** Plain-language decision trace from diagnose(). */
  readonly diagnosisRationale: readonly string[];
  readonly ageMinutes: number;
  readonly messagesSent: number;
  readonly priorAttempts: number;
  readonly ledger: readonly LedgerEntry[];
  /** Why the ladder escalated, from the policy row. */
  readonly policyNote: string | null;
}

export interface Brief {
  /** One line a human scans in a queue list. No trailing full stop. */
  readonly headline: string;
  readonly whatHappened: string;
  readonly whatWeTried: string;
  /** The specific thing stopping this case from resolving itself. */
  readonly whatIsBlocking: string;
  /** Advice to the human. Never executed by anything. */
  readonly recommendedAction: string;
  /** How sure the model is that it read the case correctly. */
  readonly confidence: 'high' | 'medium' | 'low';
}

/** The headline fills one line of the queue list; it is clamped, not rejected. */
const HEADLINE_DISPLAY_LIMIT = 140;

/** Minimums gate quality; the maximum is only a runaway guard. See `MAX_FIELD`. */
const briefSchema = z.object({
  headline: z.string().min(8).max(MAX_FIELD),
  whatHappened: z.string().min(20).max(MAX_FIELD),
  whatWeTried: z.string().min(10).max(MAX_FIELD),
  whatIsBlocking: z.string().min(10).max(MAX_FIELD),
  recommendedAction: z.string().min(10).max(MAX_FIELD),
  confidence: z.enum(['high', 'medium', 'low']),
});

export const JSON_SCHEMA = {
  type: 'object',
  properties: {
    headline: {
      type: 'string',
      description: 'One scannable line naming the case and the problem. No trailing full stop.',
    },
    whatHappened: { type: 'string', description: 'Why this payment failed, in plain language.' },
    whatWeTried: {
      type: 'string',
      description: 'What the agent actually did — rungs fired, messages sent, what was skipped.',
    },
    whatIsBlocking: {
      type: 'string',
      description: 'The specific reason this case cannot resolve without a person.',
    },
    recommendedAction: {
      type: 'string',
      description: 'What you would suggest the human consider. Advice only.',
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
      description: 'How confident you are that you read the case correctly from the evidence given.',
    },
  },
  required: [
    'headline',
    'whatHappened',
    'whatWeTried',
    'whatIsBlocking',
    'recommendedAction',
    'confidence',
  ],
  additionalProperties: false,
} as const;

const SYSTEM = `You brief a human operator on one failed-payment recovery case that an automated agent has escalated, at an Indian payments company called Vyavas built on Razorpay.

Your reader is a colleague who will decide what to do. They have more context and more authority than you. Write for someone who has ten seconds to decide whether this case needs them right now.

RULES:

1. Use only the evidence given. Never invent an event, a message, a customer action, or a timestamp. If the ledger does not say something happened, it did not happen. Where the evidence is thin, say so and lower your confidence rather than filling the gap.

2. Distinguish "the agent chose not to act" from "the agent failed to act" from "the agent acted and it did not work". These are completely different problems and the ledger tells you which one this is — a rung_aborted is a deliberate stop, a rung_deferred is a wait, a rung_uncomposable or no_channel is a defect, a rung_fired that led nowhere is a customer who did not respond.

3. Your recommendation is advice, not an instruction, and nothing automated will read it. Suggest what a person should consider. It is correct and useful to recommend closing the case or doing nothing when that is right.

4. Never recommend contacting the customer again if the evidence shows they opted out, the order is paid, or the cause class forbids it. Never recommend re-presenting an instrument the diagnosis has ruled out.

5. On a risk_review queue: the case was declined by an issuer or a fraud system. Never suggest re-presenting the card or increasing pressure — repeated attempts raise the risk score and degrade the merchant's authorisation rate across every other customer. A burst of these is a signal about the merchant's own risk rules, not about this payer.

6. Plain language. No jargon beyond the payment terms in the input, no filler, no restating the whole ledger. Amounts are pre-formatted; reproduce them exactly.

Return only the JSON object.`;

function render(f: BriefFacts): string {
  const lines = [
    `Queue: ${f.queue}`,
    `Merchant: ${f.merchantName}`,
    `Case type: ${f.caseType}`,
    `Amount at risk: ${formatINR(f.amountAtRisk)}`,
    `Age: ${f.ageMinutes} minutes`,
    `Attended: ${f.attended} (${f.attended ? 'no mandate — a human must return to a payment surface' : 'a mandate exists and the debit may be re-presented'})`,
    ``,
    `── the failure ──`,
    `Cause class: ${f.causeClass ?? 'unclassified'}`,
    `Razorpay reason: ${f.errorReason ?? 'unknown'}${f.rawErrorReason && f.rawErrorReason !== f.errorReason ? ` (raw: ${f.rawErrorReason})` : ''}`,
    `Source: ${f.errorSource ?? 'unknown'} · Step: ${f.errorStep ?? 'unknown'}`,
    `Method: ${f.method}${f.bank ? ` · Bank: ${f.bank}` : ''}`,
    `Diagnosis confidence: ${f.confidence ?? 'unknown'}`,
    `Policy row: ${f.policyId ?? 'none'}`,
  ];

  if (f.diagnosisRationale.length > 0) {
    lines.push(``, `── why the agent classified it this way ──`);
    for (const line of f.diagnosisRationale) lines.push(`  - ${line}`);
  }

  lines.push(
    ``,
    `── activity ──`,
    `Real messages sent to the customer: ${f.messagesSent}`,
    `Prior payment attempts on this order: ${f.priorAttempts}`,
  );

  if (f.ledger.length > 0) {
    lines.push(``, `── the case ledger, oldest first ──`);
    for (const e of f.ledger) {
      const parts = [e.at.toISOString(), e.kind];
      if (e.reason) parts.push(`reason=${e.reason}`);
      if (e.note) parts.push(e.note);
      lines.push(`  ${parts.join(' · ')}`);
    }
  } else {
    lines.push(``, `The case ledger is empty. Nothing has been recorded against this case.`);
  }

  if (f.policyNote) {
    lines.push(``, `── why the ladder escalated ──`, f.policyNote);
  }

  return lines.join('\n');
}

/**
 * A usable brief with no model involved.
 *
 * Deliberately not "escalated by ladder". Even the fallback names the cause,
 * the money and the activity, because the whole point of the queue is that an
 * entry tells you something before you open it.
 */
export function fallbackBrief(f: BriefFacts): Brief {
  const cause = f.causeClass ?? 'unclassified';
  const lastEvent = f.ledger.at(-1);

  return {
    headline: `${formatINR(f.amountAtRisk)} ${f.method} case in ${cause} needs review`,
    whatHappened:
      `A ${f.method} payment of ${formatINR(f.amountAtRisk)} failed with ` +
      `'${f.errorReason ?? 'an unknown reason'}'${f.bank ? ` on ${f.bank}` : ''}, ` +
      `classified as ${cause} with ${f.confidence ?? 'unknown'} confidence.`,
    whatWeTried:
      `${f.messagesSent} message(s) sent across ${f.ledger.length} ledger event(s) under policy ` +
      `'${f.policyId ?? 'none'}'.` +
      (lastEvent ? ` Most recent event: ${lastEvent.kind}${lastEvent.reason ? ` (${lastEvent.reason})` : ''}.` : ''),
    whatIsBlocking:
      f.policyNote ?? `The ladder routed this case to ${f.queue} and stopped.`,
    recommendedAction:
      'Automated brief unavailable — review the case timeline directly before deciding.',
    confidence: 'low',
  };
}

export async function writeBrief(
  facts: BriefFacts,
  opts: { client?: Anthropic; timeoutMs?: number } = {},
): Promise<Result<Brief, ClaudeError>> {
  const result = await ask<Brief>({
    system: SYSTEM,
    user: render(facts),
    schema: JSON_SCHEMA as unknown as Record<string, unknown>,
    validator: briefSchema,
    // Reading a ledger and working out which of several similar-looking failure
    // modes actually occurred is analysis, not phrasing. Worth the extra effort.
    effort: 'high',
    maxTokens: 6_000,
    ...(opts.client ? { client: opts.client } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });

  if (!result.ok) return result;
  return ok({ ...result.value, headline: clamp(result.value.headline, HEADLINE_DISPLAY_LIMIT) });
}
