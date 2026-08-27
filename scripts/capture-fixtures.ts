/**
 * Capture real failure payloads from Razorpay test mode.
 *
 *   npm run fixtures:capture
 *
 * Why this exists, and why it matters more than it looks:
 *
 * The hand-built fixtures in `src/adapters/razorpay/fixtures/webhooks.ts` are
 * written to Razorpay's *documentation*. Documentation and reality diverge —
 * fields appear that are not listed, `error_source` carries values outside the
 * documented set, issuers return `payment_failed` where a specific reason was
 * promised, and the same reason means different things on different rails.
 *
 * Captured payloads are the regression suite. Every real failure shape we have
 * ever seen stays in the repo, so a taxonomy change can be replayed against all
 * of them before it reaches a customer.
 *
 * Secrets are never written to the fixture files: emails, phone numbers, card
 * details and VPAs are redacted on the way out. A fixture is committed, and a
 * committed file must be safe to share.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });
loadEnv();

import { createRazorpayClient } from '../src/adapters/razorpay/client.js';
import { isTestMode, requireRazorpayCredentials } from '../src/lib/env.js';
import type { RazorpayPaymentEntity } from '../src/adapters/razorpay/types.js';

const OUT_DIR = resolve(process.cwd(), 'src/adapters/razorpay/fixtures/captured');
const INDEX = resolve(OUT_DIR, 'index.json');

/** Redact anything that identifies a real person before the file is written. */
function redact(entity: RazorpayPaymentEntity): RazorpayPaymentEntity {
  const card = entity.card ? { ...entity.card } : undefined;
  if (card) {
    card.last4 = '1111';
    if ('name' in card) (card as Record<string, unknown>).name = 'Test Customer';
  }

  return {
    ...entity,
    email: entity.email ? 'captured@example.com' : entity.email,
    contact: entity.contact ? '+919876543210' : entity.contact,
    vpa: entity.vpa ? 'captured@okhdfcbank' : entity.vpa,
    card,
    notes: {},
  };
}

interface CapturedIndexEntry {
  errorReason: string;
  errorSource: string | null;
  errorStep: string | null;
  method: string | null;
  file: string;
  capturedAt: string;
}

async function main(): Promise<void> {
  const creds = requireRazorpayCredentials();

  if (!isTestMode()) {
    console.error(
      'Refusing to run: RAZORPAY_API_KEY is not a test-mode key (rzp_test_…).\n' +
        'Capturing from live mode would write real customer payment data into files that get committed.',
    );
    process.exit(1);
  }

  console.log(`Capturing from Razorpay test mode (${creds.keyId.slice(0, 14)}…)`);
  mkdirSync(OUT_DIR, { recursive: true });

  const client = createRazorpayClient();
  const res = await client.get<{ items?: RazorpayPaymentEntity[]; count?: number }>('/payments', {
    count: 100,
  });
  const payments = res.items ?? [];
  console.log(`Fetched ${payments.length} payment(s).`);

  const failures = payments.filter((p) => p.status === 'failed');
  console.log(`${failures.length} failed.`);

  if (failures.length === 0) {
    console.log(
      '\nNothing to capture yet. To generate failures in test mode, run a checkout with\n' +
        "Razorpay's test cards — the 'failure' card numbers in their docs produce specific\n" +
        'error reasons, which is exactly what we want one of each of.',
    );
  }

  // One fixture per distinct tuple, not per payment: the tuple is the routing
  // key, so that is the unit of coverage we actually care about.
  const existing: CapturedIndexEntry[] = (() => {
    try {
      return JSON.parse(readFileSync(INDEX, 'utf8')) as CapturedIndexEntry[];
    } catch {
      return [];
    }
  })();

  const seen = new Set(existing.map((e) => e.file));
  const added: CapturedIndexEntry[] = [];

  for (const payment of failures) {
    const reason = payment.error_reason ?? 'unknown_reason';
    const source = payment.error_source ?? 'unknown';
    const step = payment.error_step ?? 'unknown';
    const method = payment.method ?? 'unknown';

    const file = `${reason}__${source}__${step}__${method}.json`;
    if (seen.has(file)) continue;

    writeFileSync(resolve(OUT_DIR, file), JSON.stringify(redact(payment), null, 2) + '\n', 'utf8');
    seen.add(file);
    added.push({
      errorReason: reason,
      errorSource: payment.error_source ?? null,
      errorStep: payment.error_step ?? null,
      method: payment.method ?? null,
      file,
      capturedAt: new Date().toISOString(),
    });
    console.log(`  + ${file}`);
  }

  if (added.length > 0) {
    const index = [...existing, ...added].sort((a, b) => a.file.localeCompare(b.file));
    writeFileSync(INDEX, JSON.stringify(index, null, 2) + '\n', 'utf8');
  }

  console.log(
    `\n${added.length} new fixture(s); ${seen.size} distinct failure tuple(s) captured in total.`,
  );

  // Coverage against the taxonomy, so the gap is visible rather than assumed.
  const { DOCUMENTED_ERROR_REASONS } = await import('../src/core/taxonomy/codes.js');
  const capturedReasons = new Set([...existing, ...added].map((e) => e.errorReason));
  const missing = DOCUMENTED_ERROR_REASONS.filter((r) => !capturedReasons.has(r));

  console.log(
    `\nTaxonomy coverage: ${DOCUMENTED_ERROR_REASONS.length - missing.length}/${DOCUMENTED_ERROR_REASONS.length} documented reasons have a captured payload.`,
  );
  if (missing.length > 0) {
    console.log('Not yet captured (hand-built fixtures still cover these):');
    for (const r of missing) console.log(`  - ${r}`);
  }
}

void main();
