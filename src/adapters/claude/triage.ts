/**
 * Triage for failure reasons the taxonomy does not know.
 *
 * `codes.ts` covers the documented Razorpay reasons. Razorpay ships new ones,
 * and gateways return undocumented strings. Today those land on
 * `unknown_reason`, get `confidence: 'low'`, and fall through to a cautious
 * ladder or the catch-all — which is the correct SAFE behaviour and a silent
 * one. Nobody finds out that a new code is quietly costing money until someone
 * goes looking, and nobody goes looking.
 *
 * This turns that silence into a queue: a proposal a human reviews, approves or
 * rejects, and only then hand-writes into `codes.ts` or `diagnose.ts`.
 *
 * ── the hard boundary ──
 *
 * **Nothing here is ever applied automatically.** The output is a row in
 * `taxonomy_proposals` with `status: 'pending'`. There is no code path that
 * reads an approved proposal and mutates the taxonomy — approval means a person
 * opens an editor. That is deliberate: the taxonomy is the safety ceiling for
 * the whole agent, `sameInstrumentRetry` and `contactCustomer` are derived from
 * it, and a wrong class there does not produce a bad message, it produces a
 * customer's card locked at the issuer.
 *
 * So the model's job is to do the reading — pull the pattern out of fifty raw
 * payloads and say what it looks like — not to make the decision.
 */

import { z } from 'zod';

import { CAUSE_CLASSES } from '../../core/taxonomy/cause-class.js';
import { MAX_FIELD, type ClaudeError, ask } from './client.js';
import type { Result } from '../../lib/result.js';
import type Anthropic from '@anthropic-ai/sdk';

/** One occurrence of the unknown reason, as observed. */
export interface UnknownSample {
  readonly rawErrorReason: string | null;
  readonly errorCode: string | null;
  readonly errorSource: string | null;
  readonly errorStep: string | null;
  readonly method: string;
  readonly bank: string | null;
  readonly network: string | null;
  /** Razorpay's own description field, where one came through. */
  readonly description: string | null;
  /** Did this order eventually get paid, by any route? Outcome evidence. */
  readonly eventuallyPaid: boolean | null;
}

export interface TriageFacts {
  /** The string being triaged — the group key for every sample below. */
  readonly rawErrorReason: string;
  readonly occurrences: number;
  readonly distinctMerchants: number;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  /** Where it currently lands with no rule: almost always unknown_reason. */
  readonly currentCauseClass: string;
  readonly samples: readonly UnknownSample[];
  /** How many of the sampled orders were eventually paid, by any route. */
  readonly eventuallyPaidCount: number;
}

export interface TriageProposal {
  readonly proposedCauseClass: (typeof CAUSE_CLASSES)[number];
  readonly confidence: 'high' | 'medium' | 'low';
  /** What the evidence actually shows. */
  readonly reasoning: string;
  /** Suggested rule id in the diagnose.ts style, e.g. `psp_declined.upi`. */
  readonly proposedRuleId: string;
  /** Which of source/step/method the classification should key on, if any. */
  readonly disambiguationNote: string;
  /**
   * Would re-presenting the same instrument be safe for this reason?
   *
   * Asked separately from the class because it is the field with teeth, and a
   * reviewer should see the model commit to it explicitly rather than infer it.
   */
  readonly sameInstrumentRetrySafe: boolean;
  /** What a reviewer should check before accepting this. Always populated. */
  readonly reviewerShouldVerify: string;
}

/**
 * Minimums are the gate; the maximum is only a runaway guard — see `MAX_FIELD`.
 * A tight cap here rejected a good 1400-character proposal for a 1200-character
 * limit that protected nothing.
 */
const proposalSchema = z.object({
  proposedCauseClass: z.enum(CAUSE_CLASSES as unknown as [string, ...string[]]),
  confidence: z.enum(['high', 'medium', 'low']),
  reasoning: z.string().min(20).max(MAX_FIELD),
  proposedRuleId: z.string().min(3).max(200),
  disambiguationNote: z.string().min(3).max(MAX_FIELD),
  sameInstrumentRetrySafe: z.boolean(),
  reviewerShouldVerify: z.string().min(10).max(MAX_FIELD),
}) as unknown as z.ZodType<TriageProposal>;

export const JSON_SCHEMA = {
  type: 'object',
  properties: {
    proposedCauseClass: {
      type: 'string',
      enum: [...CAUSE_CLASSES],
      description: 'Which of the nine cause classes this reason belongs in.',
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reasoning: {
      type: 'string',
      description:
        'What in the evidence supports this class, and what argues against it. ' +
        'A short paragraph — aim for under 200 words.',
    },
    proposedRuleId: {
      type: 'string',
      description: "Dotted rule id in the existing style, e.g. 'vpa_limit.upi'.",
    },
    disambiguationNote: {
      type: 'string',
      description:
        'Whether the class depends on errorSource, errorStep or method, and how. Say so ' +
        'explicitly if it does not.',
    },
    sameInstrumentRetrySafe: {
      type: 'boolean',
      description:
        'True only if re-presenting the same card, account or VPA could plausibly succeed.',
    },
    reviewerShouldVerify: {
      type: 'string',
      description: 'The specific thing a human should confirm before this is accepted.',
    },
  },
  required: [
    'proposedCauseClass',
    'confidence',
    'reasoning',
    'proposedRuleId',
    'disambiguationNote',
    'sameInstrumentRetrySafe',
    'reviewerShouldVerify',
  ],
  additionalProperties: false,
} as const;

const SYSTEM = `You classify undocumented payment failure reasons for Vyavas, a payment-recovery agent for Indian merchants on Razorpay. Your output is a PROPOSAL that a human engineer reviews before anything changes. Nothing you write is applied automatically.

The taxonomy groups every failure reason by one question only: WHAT HAS TO CHANGE FOR THE MONEY TO ARRIVE?

The nine classes:

- transient_infra — a bank, PSP or gateway had a problem. The instrument is fine, the timing was bad. Retrying later works. Nobody is at fault.
- instrument_dead — this specific card, account or VPA can never complete a payment: expired, blocked, deregistered, not enrolled for online use. Retrying is pointless. The customer must switch.
- customer_input — a typo the customer can fix in seconds: wrong CVV, wrong OTP, wrong PIN, malformed VPA. Intent is proven.
- auth_friction — 3DS or OTP did not complete. The SMS was late, the bank page timed out, the challenge was abandoned. In India this is very often delivery latency, not a refusal.
- funds_limits — insufficient balance, or a per-transaction or daily cap. The instrument works; the money or the headroom is not there right now.
- risk — an issuer or fraud system refused. Retrying raises the risk score, can get the card blocked, and degrades the merchant's authorisation rate for every other customer.
- merchant_config — the merchant's own setup is broken: a method not enabled, live mode off, a malformed request. Every affected customer is a total silent loss until the merchant acts.
- terminal_noop — already paid, or a duplicate. There is nothing at risk. Stop everything.
- intent_exit — the customer deliberately cancelled or abandoned. Not an error; a live intent signal.

RULES:

1. Bias toward the SAFE class when the evidence is ambiguous. The asymmetry is real and it is not close: classifying a risk decline as customer_input produces repeated attempts that can lock a real person's card and damage the merchant's authorisation rate; classifying a typo as risk costs one recoverable order. When torn, choose the class that acts less, set confidence to low, and say what would resolve it.

2. sameInstrumentRetrySafe must be false unless re-presenting the SAME card, account or VPA could plausibly succeed. False for anything structural, anything risk-related, and anything you are unsure about.

3. Use the outcome evidence. A reason where most orders were eventually paid by another route points to instrument_dead or merchant_config. One where orders were paid by retrying the same instrument points to transient_infra or funds_limits. Say when the sample is too small to carry this argument — under about ten occurrences it usually is.

4. Read errorSource carefully; it is the single most informative field. 'customer' means the payer did something. 'business' or 'internal' means the merchant's integration did. 'gateway', 'bank', 'issuer' and 'network' mean it happened upstream of both. The same reason string genuinely belongs in different classes depending on this, and if that is what the evidence shows, say so in disambiguationNote.

5. Never invent an interpretation to sound decisive. 'low' confidence with a clear statement of what is missing is a good answer and the reviewer can act on it. A confident wrong class is the expensive outcome.

Return only the JSON object.`;

function render(f: TriageFacts): string {
  const lines = [
    `Unknown failure reason: "${f.rawErrorReason}"`,
    `Currently classified as: ${f.currentCauseClass}`,
    ``,
    `Occurrences: ${f.occurrences} across ${f.distinctMerchants} merchant(s)`,
    `First seen: ${f.firstSeenAt.toISOString()}`,
    `Last seen: ${f.lastSeenAt.toISOString()}`,
    `Orders eventually paid by any route: ${f.eventuallyPaidCount} of ${f.samples.length} sampled`,
    ``,
    `── observed occurrences ──`,
  ];

  for (const [i, s] of f.samples.entries()) {
    const parts = [
      `code=${s.errorCode ?? '-'}`,
      `source=${s.errorSource ?? '-'}`,
      `step=${s.errorStep ?? '-'}`,
      `method=${s.method}`,
    ];
    if (s.bank) parts.push(`bank=${s.bank}`);
    if (s.network) parts.push(`network=${s.network}`);
    if (s.eventuallyPaid !== null) parts.push(`eventuallyPaid=${s.eventuallyPaid}`);
    lines.push(`  ${i + 1}. ${parts.join(' · ')}`);
    if (s.description) lines.push(`     description: ${s.description}`);
  }

  return lines.join('\n');
}

export async function triageUnknownReason(
  facts: TriageFacts,
  opts: { client?: Anthropic; timeoutMs?: number } = {},
): Promise<Result<TriageProposal, ClaudeError>> {
  return ask<TriageProposal>({
    system: SYSTEM,
    user: render(facts),
    schema: JSON_SCHEMA as unknown as Record<string, unknown>,
    validator: proposalSchema,
    // The one job here whose output shapes the safety ceiling, even with a
    // human in the loop. Reviewers trust a well-argued proposal more than they
    // should, so the argument had better be good.
    effort: 'high',
    maxTokens: 8_000,
    // Offline batch job, not a ladder rung. It can afford to wait.
    timeoutMs: opts.timeoutMs ?? 90_000,
    ...(opts.client ? { client: opts.client } : {}),
  });
}
