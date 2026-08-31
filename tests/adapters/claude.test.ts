/**
 * The Claude adapter.
 *
 * The behaviour worth pinning is not "it can call the API" — it is what happens
 * when it cannot. Every job in this directory is an enrichment on top of
 * something that must work without it, so the contract is:
 *
 *     ask() never throws, and every failure has a named cause.
 *
 * A thrown exception here would propagate into a ladder rung holding a workflow
 * step open, and turn "the brief is terse" into "the escalation never happened".
 *
 * Nothing here reaches the network. The client is injected.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

import { ask, claudeClient, clamp, resetClaudeClient } from '../../src/adapters/claude/client.js';
import { JSON_SCHEMA as ALERT_SCHEMA, fallbackProse } from '../../src/adapters/claude/alert.js';
import { JSON_SCHEMA as BRIEF_SCHEMA, fallbackBrief } from '../../src/adapters/claude/brief.js';
import { JSON_SCHEMA as AUDIT_SCHEMA, fallbackReport } from '../../src/adapters/claude/audit.js';
import { JSON_SCHEMA as TRIAGE_SCHEMA } from '../../src/adapters/claude/triage.js';
import type { Paise } from '../../src/core/money.js';
import { resetEnvCache } from '../../src/lib/env.js';

const schema = z.object({ answer: z.string(), score: z.number() });
const JSON_SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' }, score: { type: 'number' } },
  required: ['answer', 'score'],
  additionalProperties: false,
};

/** An Anthropic client whose `messages.create` returns or throws whatever we say. */
function fakeClient(impl: () => unknown): Anthropic {
  return { messages: { create: async () => impl() } } as unknown as Anthropic;
}

function textResponse(text: string, stop: string = 'end_turn') {
  return { content: [{ type: 'text', text }], stop_reason: stop, stop_details: null };
}

const call = (client: Anthropic) =>
  ask({
    system: 'system',
    user: 'user',
    schema: JSON_SCHEMA,
    validator: schema,
    client,
  });

let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.ANTHROPIC_API_KEY;
  resetClaudeClient();
  resetEnvCache();
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  resetClaudeClient();
  resetEnvCache();
});

describe('ask', () => {
  it('returns the validated object on a well-formed answer', async () => {
    const r = await call(fakeClient(() => textResponse('{"answer":"yes","score":3}')));

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.answer).toBe('yes');
      expect(r.value.score).toBe(3);
    }
  });

  it('concatenates multiple text blocks before parsing', async () => {
    const r = await call(
      fakeClient(() => ({
        content: [
          { type: 'text', text: '{"answer":"split' },
          { type: 'text', text: '","score":1}' },
        ],
        stop_reason: 'end_turn',
        stop_details: null,
      })),
    );

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.answer).toBe('split');
  });

  it('ignores thinking blocks when collecting the answer', async () => {
    const r = await call(
      fakeClient(() => ({
        content: [
          { type: 'thinking', thinking: 'not JSON at all' },
          { type: 'text', text: '{"answer":"ok","score":0}' },
        ],
        stop_reason: 'end_turn',
        stop_details: null,
      })),
    );

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.answer).toBe('ok');
  });

  /**
   * A safety refusal arrives as a normal 200 with an empty or partial body.
   * Checked before the content is read, so the failure names the real cause
   * rather than the schema mismatch it would otherwise produce.
   */
  it('names a refusal as a refusal, not as bad output', async () => {
    const r = await call(
      fakeClient(() => ({
        content: [],
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber', explanation: 'no' },
      })),
    );

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.failure).toBe('refused');
      expect(r.error.retryable).toBe(false);
      expect(r.error.detail).toContain('cyber');
    }
  });

  it('reports non-JSON as invalid_output rather than throwing', async () => {
    const r = await call(fakeClient(() => textResponse('I think the answer is yes.')));

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.failure).toBe('invalid_output');
  });

  /**
   * Structured outputs make this unlikely and it is still checked: the schema
   * the API enforces and the schema the caller believes are two artefacts, and
   * the day they drift is the day an unvalidated value reaches a database
   * column.
   */
  it('rejects JSON that does not match the caller schema', async () => {
    const r = await call(fakeClient(() => textResponse('{"answer":"yes","score":"three"}')));

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.failure).toBe('invalid_output');
      expect(r.error.detail).toContain('score');
    }
  });

  it('treats an empty body as invalid output', async () => {
    const r = await call(fakeClient(() => textResponse('', 'max_tokens')));

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.failure).toBe('invalid_output');
      expect(r.error.detail).toContain('max_tokens');
    }
  });

  it('classifies a rate limit as retryable and auth as not', async () => {
    const headers = new Headers();
    const rate = await call(
      fakeClient(() => {
        throw new Anthropic.RateLimitError(429, undefined, 'slow down', headers);
      }),
    );
    expect(rate.ok).toBe(false);
    if (!rate.ok) {
      expect(rate.error.failure).toBe('rate_limited');
      expect(rate.error.retryable).toBe(true);
    }

    const auth = await call(
      fakeClient(() => {
        throw new Anthropic.AuthenticationError(401, undefined, 'bad key', headers);
      }),
    );
    expect(auth.ok).toBe(false);
    if (!auth.ok) {
      expect(auth.error.failure).toBe('auth');
      expect(auth.error.retryable).toBe(false);
    }
  });

  it('does not let an unexpected exception escape', async () => {
    const r = await call(
      fakeClient(() => {
        throw new TypeError('something entirely unexpected');
      }),
    );

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.failure).toBe('unknown');
      expect(r.error.detail).toContain('unexpected');
    }
  });

  /**
   * The state of a fresh clone. `npm test` and the whole ladder must work with
   * no Anthropic key at all, so this is a named outcome rather than a throw.
   */
  it('reports not_configured when no key is set', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    resetEnvCache();
    resetClaudeClient();

    expect(claudeClient()).toBeNull();

    const r = await ask({ system: 's', user: 'u', schema: JSON_SCHEMA, validator: schema });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.failure).toBe('not_configured');
      expect(r.error.retryable).toBe(false);
    }
  });
});

/**
 * The output schemas.
 *
 * `output_config.format.schema` accepts only the STRUCTURAL half of JSON
 * Schema. The validation vocabulary — `maxItems`, `maxLength`, `minimum` and
 * friends — is rejected with a 400.
 *
 * This is a nasty class of bug because every layer above it says yes:
 * TypeScript compiles it, zod validates against it, the unit tests pass with an
 * injected client that never sees the schema, and in production the 400 is
 * swallowed by the fallback and surfaces as a report that merely looks
 * unconfigured. It cost one live run to find, via `npm run ai:smoke`.
 *
 * So the guard is here, where it is cheap and offline.
 */
describe('the output schemas stay within what structured outputs accept', () => {
  const ALLOWED = new Set([
    'type',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'enum',
    'description',
  ]);

  const schemas: [string, unknown][] = [
    ['alert', ALERT_SCHEMA],
    ['brief', BRIEF_SCHEMA],
    ['triage', TRIAGE_SCHEMA],
    ['audit', AUDIT_SCHEMA],
  ];

  /** Every key at every depth, with a path so a failure names the culprit. */
  function walk(node: unknown, path: string, found: string[]): void {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`, found));
      return;
    }
    if (node === null || typeof node !== 'object') return;

    for (const [key, value] of Object.entries(node)) {
      // Keys under `properties` are field names, not schema keywords.
      if (path.endsWith('.properties')) {
        walk(value, `${path}.${key}`, found);
        continue;
      }
      if (!ALLOWED.has(key)) found.push(`${path}.${key}`);
      walk(value, `${path}.${key}`, found);
    }
  }

  for (const [name, schema] of schemas) {
    it(`${name} uses only structural keywords`, () => {
      const offenders: string[] = [];
      walk(schema, name, offenders);
      expect(offenders, `unsupported schema keyword(s): ${offenders.join(', ')}`).toEqual([]);
    });

    it(`${name} is an object schema that forbids extra properties`, () => {
      const s = schema as Record<string, unknown>;
      expect(s.type).toBe('object');
      expect(s.additionalProperties).toBe(false);
      expect(Array.isArray(s.required)).toBe(true);
    });
  }
});

describe('clamp', () => {
  it('leaves a short value alone', () => {
    expect(clamp('short', 40)).toBe('short');
  });

  it('trims on a word boundary and marks the cut', () => {
    const out = clamp('the quick brown fox jumps over the lazy dog', 20);
    expect(out.length).toBeLessThanOrEqual(21);
    expect(out.endsWith('…')).toBe(true);
    // Cut between words, not mid-word.
    expect(out).not.toContain('ju…');
  });

  it('still cuts when there is no usable word boundary', () => {
    const out = clamp('a'.repeat(100), 10);
    expect(out).toBe('a'.repeat(10) + '…');
  });
});

/**
 * The fallbacks are a supported path, not a stub.
 *
 * They are what ships whenever the model is unconfigured, slow or refusing, so
 * each has to be genuinely usable on its own — and each must satisfy the same
 * schema the model's answer does, or a fallback would fail to persist for a
 * reason nobody would think to look for.
 */
describe('the deterministic fallbacks', () => {
  it('writes an alert that states the facts without the model', () => {
    const prose = fallbackProse({
      merchantName: 'Kirana Cloud',
      signal: 'bank_not_enabled:ICIC:netbanking',
      causeClass: 'merchant_config',
      errorReason: 'bank_not_enabled',
      method: 'netbanking',
      bank: 'ICIC',
      affectedCases: 47,
      amountAtRisk: 32_000_00 as Paise,
      onsetAt: new Date('2026-08-30T09:14:00Z'),
      windowHours: 6,
      baselineRateBps: 200,
      observedRateBps: 8_800,
      sampleRationale: [],
    });

    expect(prose.title).toContain('ICIC');
    expect(prose.detail).toContain('47');
    // Diagnostic, never prescriptive — the same rule the prompt enforces.
    expect(prose.detail.toLowerCase()).not.toContain('you should');
    expect(prose.detail.toLowerCase()).not.toContain('disable');
  });

  it('writes a brief that names the cause and the money', () => {
    const brief = fallbackBrief({
      queue: 'risk_review',
      merchantName: 'Kirana Cloud',
      caseType: 'payment_failure',
      causeClass: 'risk',
      errorReason: 'payment_risk_check_failed',
      rawErrorReason: null,
      errorSource: 'issuer',
      errorStep: 'payment_authorization',
      method: 'card',
      bank: 'HDFC',
      amountAtRisk: 184_300 as Paise,
      attended: true,
      confidence: 'high',
      policyId: 'risk.payment_risk_check_failed',
      diagnosisRationale: ['The issuer declined at authorisation.'],
      ageMinutes: 130,
      messagesSent: 1,
      priorAttempts: 2,
      ledger: [
        { at: new Date('2026-08-31T10:00:00Z'), kind: 'rung_fired', reason: null, note: 'nudge' },
      ],
      policyNote: 'Puts the case in front of a person, quietly.',
    });

    // Not "escalated by ladder" — the whole point of the queue is that an entry
    // says something before you open it.
    expect(brief.headline).toContain('risk');
    expect(brief.whatHappened).toContain('payment_risk_check_failed');
    expect(brief.whatIsBlocking).toContain('front of a person');
    expect(brief.confidence).toBe('low');
  });

  it('ranks audit buckets by money when it cannot analyse them', () => {
    const report = fallbackReport({
      windowDays: 7,
      generatedAt: new Date('2026-08-31T12:00:00Z'),
      totalCasesInWindow: 300,
      totalLostCases: 40,
      lostAmount: 1_000_000 as Paise,
      lostWithNoMessage: 12,
      lostWithNoMessageAmount: 600_000 as Paise,
      buckets: [
        {
          kind: 'rung_deferred',
          reason: 'within_frequency_cap',
          caseCount: 200,
          amountAtRisk: 10_000 as Paise,
          casesWithNoMessage: 0,
          distinctMerchants: 4,
          sampleCaseIds: ['a'],
          sampleNotes: [],
        },
        {
          kind: 'rung_uncomposable',
          reason: 'missing_payment_link',
          caseCount: 3,
          amountAtRisk: 500_000 as Paise,
          casesWithNoMessage: 3,
          distinctMerchants: 1,
          sampleCaseIds: ['b'],
          sampleNotes: [],
        },
      ],
    });

    // Three expensive defects outrank two hundred ordinary deferrals.
    expect(report.findings[0]?.title).toContain('rung_uncomposable');
    expect(report.findings[0]?.severity).toBe('high');
    expect(report.findings[1]?.severity).toBe('low');
    expect(report.findings[0]?.suggestedInvestigation).toContain('npm run replay');

    // `rung_uncomposable` cannot happen during correct operation, so the
    // fallback may call it a defect without a model. A deferral can and does,
    // so it must NOT be called one — a report that flags working behaviour as a
    // bug teaches its reader to ignore the report.
    expect(report.findings[0]?.kind).toBe('defect');
    expect(report.findings[1]?.kind).toBe('expected');
  });

  it('does not call a correct abort a defect', () => {
    const report = fallbackReport({
      windowDays: 7,
      generatedAt: new Date(),
      totalCasesInWindow: 10,
      totalLostCases: 0,
      lostAmount: 0 as Paise,
      lostWithNoMessage: 0 as Paise as number,
      lostWithNoMessageAmount: 0 as Paise,
      buckets: [
        {
          kind: 'rung_aborted',
          reason: 'order_unpaid',
          caseCount: 8,
          amountAtRisk: 90_000 as Paise,
          casesWithNoMessage: 8,
          distinctMerchants: 2,
          sampleCaseIds: [],
          sampleNotes: [],
        },
      ],
    });

    // Aborting because the order was paid is the kill switch working.
    expect(report.findings[0]?.kind).toBe('expected');
    // Still worth a look — every one of these sent nothing.
    expect(report.findings[0]?.severity).toBe('medium');
  });
});
