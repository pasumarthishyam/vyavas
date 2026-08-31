/**
 * The agent's self-audit.
 *
 * `case_events` is append-only and records thirty kinds of event, including
 * every way a rung can fail to become a message: `rung_aborted`,
 * `rung_deferred`, `rung_abandoned` and `rung_uncomposable`. Nothing read them.
 *
 * The dashboard answers "how much did we recover?" It cannot answer the
 * question that actually costs money:
 *
 *     which cases did we lose WITHOUT THE AGENT EVER ACTING, and why?
 *
 * Those are the fixable losses. A customer who got three good messages and did
 * not pay is a customer who did not want to pay. A case that sent nothing
 * because the payment link could not be composed is a bug with a price tag.
 *
 * ── this is not a hypothetical failure mode ──
 *
 * run-ladder.ts carries the post-mortem of one: a case whose frequency cap
 * cleared three hours out, deferred twice against a flat one-hour guess, and
 * abandoned 57 minutes early having sent nothing. No message, no alert, "no
 * trace except four rung_deferred rows that all say the same thing". It was
 * found by a person reading the ledger by hand. This is that person, weekly.
 *
 * ── what the model adds over a GROUP BY ──
 *
 * The counts are computed in SQL before this is called and passed in as facts;
 * the model never counts. What it adds is the join a query cannot make: that
 * forty `channel_deliverable` aborts and one merchant's onboarding date are the
 * same story, that `deferral_limit` and `within_frequency_cap` appearing
 * together means the cap arithmetic is wrong rather than the merchant being
 * busy. That is pattern-reading over a heterogeneous trace, and it is exactly
 * the work a person does by hand today.
 *
 * Read-only. It writes a report; it changes nothing.
 */

import { z } from 'zod';

import { formatINR, type Paise } from '../../core/money.js';
import { MAX_FIELD, type ClaudeError, ask } from './client.js';
import { type Result, ok } from '../../lib/result.js';
import type Anthropic from '@anthropic-ai/sdk';

/** One aggregated failure mode, counted in SQL. */
export interface FailureBucket {
  /** Event kind, e.g. `rung_aborted`. */
  readonly kind: string;
  /** The `reason` column, e.g. `channel_deliverable`. Null when unset. */
  readonly reason: string | null;
  readonly caseCount: number;
  readonly amountAtRisk: Paise;
  /** How many of these cases sent NO real message at all. The expensive subset. */
  readonly casesWithNoMessage: number;
  readonly distinctMerchants: number;
  /** A handful of case ids, so a human can go and look. */
  readonly sampleCaseIds: readonly string[];
  /** Distinct `note` / payload strings seen, deduplicated and capped. */
  readonly sampleNotes: readonly string[];
}

export interface AuditFacts {
  readonly windowDays: number;
  readonly generatedAt: Date;
  readonly totalCasesInWindow: number;
  readonly totalLostCases: number;
  readonly lostAmount: Paise;
  /** Lost cases where the message log holds no real send. */
  readonly lostWithNoMessage: number;
  readonly lostWithNoMessageAmount: Paise;
  readonly buckets: readonly FailureBucket[];
}

export interface AuditFinding {
  readonly title: string;
  /** How urgent, for triage ordering. Not a pager severity. */
  readonly severity: 'critical' | 'high' | 'medium' | 'low';
  /** 'defect' = our bug. 'config' = a merchant/setup problem. 'expected' = working as designed. */
  readonly kind: 'defect' | 'config' | 'expected';
  readonly affectedCases: number;
  /** Which buckets this draws on. Keeps the finding traceable. */
  readonly evidence: string;
  readonly likelyCause: string;
  readonly suggestedInvestigation: string;
}

export interface AuditReport {
  /** Two or three sentences. What a person needs to know before the findings. */
  readonly summary: string;
  readonly findings: readonly AuditFinding[];
  /** Explicitly stated so a quiet week reads as quiet, not as a broken report. */
  readonly nothingElseNotable: boolean;
}

/**
 * No `.max()` on the array.
 *
 * The finding cap is a nicety, not a safety property, and rejecting an
 * otherwise-good thirteen-finding report would throw the whole analysis away to
 * enforce a cosmetic limit. The prompt asks for at most twelve; the caller
 * slices. Validation here is for shapes that would break a consumer.
 */
const reportSchema = z.object({
  summary: z.string().min(20).max(MAX_FIELD),
  findings: z.array(
    z.object({
      title: z.string().min(8).max(MAX_FIELD),
      severity: z.enum(['critical', 'high', 'medium', 'low']),
      kind: z.enum(['defect', 'config', 'expected']),
      affectedCases: z.number().int().min(0),
      evidence: z.string().min(10).max(MAX_FIELD),
      likelyCause: z.string().min(10).max(MAX_FIELD),
      suggestedInvestigation: z.string().min(10).max(MAX_FIELD),
    }),
  ),
  nothingElseNotable: z.boolean(),
}) as unknown as z.ZodType<AuditReport>;

/**
 * Structural keywords only.
 *
 * Structured outputs reject the JSON Schema validation vocabulary — `maxItems`
 * on an array comes back as a 400, and the same is true of the numeric and
 * string bounds. This cost a live run: the schema was accepted by TypeScript,
 * accepted by zod, and rejected by the API, which the fallback then swallowed
 * into a report that looked merely unconfigured.
 *
 * So limits live in two places that do work — the prompt asks for them, and the
 * zod validator enforces the ones worth failing over. Keep this object to
 * `type`, `properties`, `required`, `additionalProperties`, `items`, `enum` and
 * `description`.
 */
export const JSON_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: 'Two or three sentences framing the window before the findings.',
    },
    findings: {
      type: 'array',
      description: 'At most twelve findings. Fewer is better; an empty array is a valid answer.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          kind: { type: 'string', enum: ['defect', 'config', 'expected'] },
          affectedCases: { type: 'integer', description: 'Zero or more.' },
          evidence: {
            type: 'string',
            description: 'Which buckets and counts support this, named explicitly.',
          },
          likelyCause: { type: 'string' },
          suggestedInvestigation: {
            type: 'string',
            description: 'The specific next check — a file, a query, a merchant to look at.',
          },
        },
        required: [
          'title',
          'severity',
          'kind',
          'affectedCases',
          'evidence',
          'likelyCause',
          'suggestedInvestigation',
        ],
        additionalProperties: false,
      },
    },
    nothingElseNotable: {
      type: 'boolean',
      description: 'True when the remaining buckets are ordinary and need no attention.',
    },
  },
  required: ['summary', 'findings', 'nothingElseNotable'],
  additionalProperties: false,
} as const;

const SYSTEM = `You audit the event ledger of Vyavas, an automated payment-recovery agent for Indian merchants on Razorpay. You are looking for cases the agent LOST WITHOUT EVER ACTING, and for what caused that.

The agent runs a "ladder": a sequence of timed rungs per failed payment. Before each rung a gate re-evaluates preconditions and returns proceed, defer (not right now — quiet hours, a live payment attempt, the frequency cap) or abort (never — order paid, customer opted out, deadline passed, no deliverable channel).

The ledger event kinds that matter to you:

- rung_fired — a rung became a real action. The agent worked.
- rung_deferred — the gate said "not now" and named a retry time. Normal in small numbers.
- rung_aborted — the gate said "never". Correct when the order was paid or the customer opted out; a DEFECT when the reason is channel_deliverable, because that means we never had a way to contact this person and should have known earlier.
- rung_abandoned — the ladder gave up on a rung. reason=deferral_limit means the gate kept deferring and the ladder ran out of patience; reason=deferred_past_deadline means the retry time fell past the case deadline. Both usually mean the gate's retry arithmetic is wrong, not that waiting was wrong.
- rung_uncomposable — the message could not be built. Almost always a missing payment link or a missing template. Always a defect.

Those four are the only failure kinds recorded. If a bucket you would expect is absent, it is absent from the data, not withheld from you — say so rather than inferring that it did not happen.

RULES:

1. Never state a count that is not in the input. Every number you use must come from a bucket you were given. Do not add buckets together unless you say that is what you are doing.

2. Rank by MONEY AND FIXABILITY, not by raw count. Three uncomposable cases worth ₹40,000 each outrank two hundred ordinary deferrals. A bucket you can name a code fix for outranks one you cannot.

3. Separate our defects from merchants' configuration from working-as-designed. An abort on order_paid is the system working correctly and should be reported as 'expected', not as a problem. Say so plainly — a report that treats correct behaviour as a finding trains its reader to ignore it.

4. Concentration is the strongest signal you have. A bucket spread across many merchants points at our code. A bucket concentrated in one merchant points at that merchant's setup or onboarding. Always say which, and say when the data cannot tell you.

5. suggestedInvestigation must name a specific next step — a file to read, a merchant to check, a query to run. "Investigate further" is not a finding.

6. Fewer, better findings. Do not pad to fill the array. If the window is genuinely uneventful, return a short summary, the findings that do matter, and nothingElseNotable=true. An empty findings array is a valid and useful answer.

Return only the JSON object.`;

function render(f: AuditFacts): string {
  const lines = [
    `Window: the last ${f.windowDays} day(s), generated ${f.generatedAt.toISOString()}`,
    ``,
    `Cases created in window: ${f.totalCasesInWindow}`,
    `Cases lost: ${f.totalLostCases} (${formatINR(f.lostAmount)})`,
    `Of those, lost having sent NO real message: ${f.lostWithNoMessage} (${formatINR(f.lostWithNoMessageAmount)})`,
    ``,
    `── failure buckets from case_events ──`,
  ];

  if (f.buckets.length === 0) {
    lines.push(`  (none — no rung failed to fire in this window)`);
    return lines.join('\n');
  }

  for (const b of f.buckets) {
    lines.push(
      ``,
      `${b.kind}${b.reason ? ` · reason=${b.reason}` : ''}`,
      `  cases: ${b.caseCount} · amount at risk: ${formatINR(b.amountAtRisk)}`,
      `  of those, sent no real message at all: ${b.casesWithNoMessage}`,
      `  spread across ${b.distinctMerchants} merchant(s)`,
    );
    if (b.sampleNotes.length > 0) {
      lines.push(`  distinct notes seen:`);
      for (const n of b.sampleNotes) lines.push(`    - ${n}`);
    }
    if (b.sampleCaseIds.length > 0) {
      lines.push(`  sample case ids: ${b.sampleCaseIds.join(', ')}`);
    }
  }

  return lines.join('\n');
}

/**
 * Event kinds that are a defect whatever the count.
 *
 * `rung_uncomposable` cannot occur during correct operation: a rung was reached,
 * the gate let it through, and then the message could not be built. Every other
 * recorded kind is conditional — a `rung_aborted` on `order_paid` is the system
 * working, and a handful of `rung_deferred` is a quiet-hours window doing its
 * job — so the fallback must not call those defects.
 *
 * A set rather than a comparison because more kinds will earn a place here; it
 * held three others until they turned out never to be persisted at all.
 */
const ALWAYS_DEFECT: ReadonlySet<string> = new Set(['rung_uncomposable']);

/**
 * A report with no model involved: the buckets, ranked by money, stated plainly.
 *
 * The `kind` on each finding is derived from the set above rather than
 * defaulted, because the alternative was labelling every bucket a defect — and
 * a report that calls a working quiet-hours deferral a bug is one that teaches
 * its reader to ignore it. Where the fallback cannot know, it says `expected`
 * and leaves `likelyCause` explicitly unanalysed rather than guessing.
 */
export function fallbackReport(f: AuditFacts): AuditReport {
  const ranked = [...f.buckets].sort((a, b) => b.amountAtRisk - a.amountAtRisk);

  return {
    summary:
      `${f.totalLostCases} case(s) worth ${formatINR(f.lostAmount)} were lost in the last ` +
      `${f.windowDays} day(s). ${f.lostWithNoMessage} of them ` +
      `(${formatINR(f.lostWithNoMessageAmount)}) sent no message at all. ` +
      `Buckets are ranked by money at risk; nothing below has been analysed.`,
    findings: ranked.slice(0, 12).map((b) => {
      const certain = ALWAYS_DEFECT.has(b.kind);
      return {
        title: `${b.kind}${b.reason ? ` (${b.reason})` : ''}`,
        // Silence is the expensive symptom: a bucket where cases sent nothing
        // is worth a look even when the kind alone is not damning.
        severity: certain ? ('high' as const) : b.casesWithNoMessage > 0 ? ('medium' as const) : ('low' as const),
        kind: certain ? ('defect' as const) : ('expected' as const),
        affectedCases: b.caseCount,
        evidence:
          `${b.caseCount} case(s), ${formatINR(b.amountAtRisk)} at risk, ` +
          `${b.casesWithNoMessage} with no message, across ${b.distinctMerchants} merchant(s).`,
        likelyCause: certain
          ? `${b.kind} cannot occur during correct operation and is always worth a fix.`
          : 'Not analysed — set ANTHROPIC_API_KEY for the reading that separates these.',
        suggestedInvestigation:
          b.sampleCaseIds.length > 0
            ? `Inspect case ${b.sampleCaseIds[0]} with: npm run replay -- --case=${b.sampleCaseIds[0]}`
            : 'No sample case ids were captured for this bucket.',
      };
    }),
    nothingElseNotable: false,
  };
}

/** The prompt asks for at most twelve; this is what makes it true. */
const MAX_FINDINGS = 12;

export async function auditLedger(
  facts: AuditFacts,
  opts: { client?: Anthropic; timeoutMs?: number } = {},
): Promise<Result<AuditReport, ClaudeError>> {
  const result = await ask<AuditReport>({
    system: SYSTEM,
    user: render(facts),
    schema: JSON_SCHEMA as unknown as Record<string, unknown>,
    validator: reportSchema,
    effort: 'high',
    // The longest output in this directory — a dozen findings with evidence,
    // plus the reasoning to get there.
    maxTokens: 16_000,
    // Offline weekly job. Latency is irrelevant; a truncated analysis is not.
    timeoutMs: opts.timeoutMs ?? 180_000,
    ...(opts.client ? { client: opts.client } : {}),
  });

  if (!result.ok) return result;
  if (result.value.findings.length <= MAX_FINDINGS) return result;

  return ok({ ...result.value, findings: result.value.findings.slice(0, MAX_FINDINGS) });
}
