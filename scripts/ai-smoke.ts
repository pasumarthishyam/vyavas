/**
 * Live smoke test for the four Claude jobs.
 *
 *   npm run ai:smoke
 *
 * Calls the real API once per job with synthetic input and reports whether each
 * one came back validated. No database, no customer, no writes.
 *
 * ── why this exists ──
 *
 * Every one of these jobs is designed to fail soft: a bad request, an
 * unreachable model or output that does not validate all take the deterministic
 * fallback, and the caller carries on. That is the right behaviour in
 * production and it is exactly what hides a broken request shape during
 * development — a malformed schema looked identical to "no API key set" in the
 * audit report, and the 400 only surfaced because someone read the fallback
 * reason.
 *
 * The specific failure this was written for: `output_config.format.schema`
 * rejects the JSON Schema validation vocabulary. `maxItems` on an array is a
 * 400, and so are the numeric and string bounds. TypeScript accepted it, zod
 * accepted it, the API did not.
 *
 * Run it after touching any schema in src/adapters/claude/.
 */

import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });
loadEnv();

import type { Paise } from '../src/core/money.js';
import { auditLedger } from '../src/adapters/claude/audit.js';
import { triageUnknownReason } from '../src/adapters/claude/triage.js';
import { writeAlertProse } from '../src/adapters/claude/alert.js';
import { writeBrief } from '../src/adapters/claude/brief.js';
import { claudeClient } from '../src/adapters/claude/client.js';

type Job = { name: string; run: () => Promise<{ ok: boolean; detail: string }> };

const show = (v: unknown) => JSON.stringify(v).slice(0, 160);

const JOBS: Job[] = [
  {
    name: 'alert prose',
    run: async () => {
      const r = await writeAlertProse({
        merchantName: 'Kirana Cloud',
        signal: 'bank_not_enabled:ICIC:netbanking',
        causeClass: 'merchant_config',
        errorReason: 'bank_not_enabled',
        method: 'netbanking',
        bank: 'ICIC',
        affectedCases: 47,
        amountAtRisk: 3_200_000 as Paise,
        onsetAt: new Date('2026-08-30T09:14:00Z'),
        windowHours: 6,
        baselineRateBps: 200,
        observedRateBps: 8_800,
        sampleRationale: ['The bank is not enabled on the merchant account.'],
      });
      return r.ok
        ? { ok: true, detail: r.value.title }
        : { ok: false, detail: `${r.error.failure}: ${r.error.detail}` };
    },
  },
  {
    name: 'escalation brief',
    run: async () => {
      const r = await writeBrief({
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
        diagnosisRationale: ['The issuer declined at authorisation without detail.'],
        ageMinutes: 130,
        messagesSent: 1,
        priorAttempts: 2,
        ledger: [
          { at: new Date('2026-08-31T10:00:00Z'), kind: 'detected', reason: null, note: null },
          { at: new Date('2026-08-31T10:15:00Z'), kind: 'rung_fired', reason: null, note: 'switch_method' },
          { at: new Date('2026-08-31T12:00:00Z'), kind: 'rung_aborted', reason: 'within_frequency_cap', note: null },
        ],
        policyNote: 'Not a customer touch. Puts the case in front of a person, quietly.',
      });
      return r.ok
        ? { ok: true, detail: `${r.value.headline} [${r.value.confidence}]` }
        : { ok: false, detail: `${r.error.failure}: ${r.error.detail}` };
    },
  },
  {
    name: 'unknown-reason triage',
    run: async () => {
      const r = await triageUnknownReason({
        rawErrorReason: 'vpa_frequency_limit_exceeded',
        occurrences: 34,
        distinctMerchants: 5,
        firstSeenAt: new Date('2026-08-01T00:00:00Z'),
        lastSeenAt: new Date('2026-08-30T00:00:00Z'),
        currentCauseClass: 'unknown_reason (no descriptor)',
        eventuallyPaidCount: 21,
        samples: [
          {
            rawErrorReason: 'vpa_frequency_limit_exceeded',
            errorCode: 'BAD_REQUEST_ERROR',
            errorSource: 'bank',
            errorStep: 'payment_authorization',
            method: 'upi',
            bank: 'HDFC',
            network: null,
            description: null,
            eventuallyPaid: true,
          },
          {
            rawErrorReason: 'vpa_frequency_limit_exceeded',
            errorCode: 'BAD_REQUEST_ERROR',
            errorSource: 'bank',
            errorStep: 'payment_authorization',
            method: 'upi',
            bank: 'SBIN',
            network: null,
            description: null,
            eventuallyPaid: false,
          },
        ],
      });
      return r.ok
        ? {
            ok: true,
            detail: `${r.value.proposedCauseClass} [${r.value.confidence}] retrySafe=${r.value.sameInstrumentRetrySafe}`,
          }
        : { ok: false, detail: `${r.error.failure}: ${r.error.detail}` };
    },
  },
  {
    name: 'ledger self-audit',
    run: async () => {
      const r = await auditLedger({
        windowDays: 7,
        generatedAt: new Date(),
        totalCasesInWindow: 412,
        totalLostCases: 63,
        lostAmount: 8_400_000 as Paise,
        lostWithNoMessage: 41,
        lostWithNoMessageAmount: 6_100_000 as Paise,
        buckets: [
          {
            kind: 'rung_uncomposable',
            reason: 'missing_payment_link',
            caseCount: 12,
            amountAtRisk: 4_000_000 as Paise,
            casesWithNoMessage: 12,
            distinctMerchants: 1,
            sampleCaseIds: ['aaaaaaaa-0000-0000-0000-000000000001'],
            sampleNotes: ["Template needs a payment link and none was created."],
          },
          {
            kind: 'rung_aborted',
            reason: 'channel_deliverable',
            caseCount: 29,
            amountAtRisk: 2_100_000 as Paise,
            casesWithNoMessage: 29,
            distinctMerchants: 1,
            sampleCaseIds: ['aaaaaaaa-0000-0000-0000-000000000002'],
            sampleNotes: ['no consented, deliverable channel for this customer'],
          },
          {
            kind: 'rung_deferred',
            reason: 'not_quiet_hours',
            caseCount: 180,
            amountAtRisk: 900_000 as Paise,
            casesWithNoMessage: 0,
            distinctMerchants: 6,
            sampleCaseIds: ['aaaaaaaa-0000-0000-0000-000000000003'],
            sampleNotes: [],
          },
        ],
      });
      return r.ok
        ? { ok: true, detail: `${r.value.findings.length} finding(s): ${show(r.value.findings.map((f) => f.title))}` }
        : { ok: false, detail: `${r.error.failure}: ${r.error.detail}` };
    },
  },
];

async function main(): Promise<void> {
  if (!claudeClient()) {
    console.error('\n  ANTHROPIC_API_KEY is not set. Nothing to smoke-test.\n');
    process.exitCode = 1;
    return;
  }

  console.log('\n  Claude jobs — live smoke test');
  console.log('  ' + '─'.repeat(70));

  let failed = 0;

  for (const job of JOBS) {
    const started = Date.now();
    const r = await job.run();
    const ms = Date.now() - started;

    if (r.ok) {
      console.log(`  ✓ ${job.name.padEnd(24)} ${String(ms).padStart(6)}ms  ${r.detail}`);
    } else {
      failed++;
      console.error(`  ✗ ${job.name.padEnd(24)} ${String(ms).padStart(6)}ms  ${r.detail}`);
    }
  }

  console.log('');
  if (failed > 0) {
    console.error(`  ${failed} of ${JOBS.length} job(s) failed.\n`);
    process.exitCode = 1;
  } else {
    console.log(`  All ${JOBS.length} jobs returned validated output.\n`);
  }
}

void main();
