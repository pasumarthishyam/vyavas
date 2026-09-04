/**
 * Drive a real failure through a real webhook endpoint.
 *
 *   npm run simulate -- --slug sandbox --scenario card_expired
 *   npm run simulate -- --slug sandbox --scenario incorrect_otp --amount 249900
 *   npm run simulate -- --slug sandbox --order order_abc123 --paid
 *   npm run simulate -- --list
 *
 * The problem this exists for: you cannot test a recovery agent without a
 * failed payment, and Razorpay will not fail one on request. Test mode gives
 * you declining cards, but driving a checkout by hand for every scenario is
 * slow, and several of the interesting cases (a bank outage, a risk decline, a
 * third wrong OTP) cannot be produced from a card number at all.
 *
 * So this signs a real Razorpay-shaped payload with the merchant's OWN stored
 * webhook secret and POSTs it to the merchant's OWN endpoint. Nothing is
 * stubbed and nothing is bypassed: the signature is verified, the delivery is
 * claimed and deduped, the tuple is normalised, `diagnose()` runs, a policy row
 * is stamped, the case is created and the ladder is published. It is exactly
 * the path a live delivery takes, because it IS that path.
 *
 * ── the two rails on it ──
 *
 * It refuses a merchant whose Razorpay connection is `live` mode. A fabricated
 * payment failure against a live account creates a real case about a customer
 * whose payment did not fail, and the agent will then message them about it.
 *
 * And it only ever talks to the endpoint you point it at. There is no path
 * where this writes to the database directly, which is the whole point — a
 * script that inserted cases would prove the console renders and nothing else.
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();

import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';

import { createClient } from '../src/db/client.js';
import { merchants, razorpayConnections } from '../src/db/schema/tenancy.js';
import { decryptSecret } from '../src/lib/crypto.js';
import { computeSignature } from '../src/adapters/razorpay/webhook.js';
import {
  FAILURE_SCENARIOS,
  orderPaidEnvelope,
  paymentLinkPaidEnvelope,
  type FailureScenario,
} from '../src/adapters/razorpay/fixtures/webhooks.js';
import { appUrl } from '../src/lib/env.js';
import { slugCandidates } from '../src/db/repos/credentials.js';

/*
 * ── npm eats these flags on PowerShell ──
 *
 * `npm run simulate -- --slug sandbox` reaches this script intact under bash
 * and MANGLED under PowerShell: npm treats `--slug` as one of its own boolean
 * options, sets `npm_config_slug=true`, and passes the bare value through as a
 * positional. The script then reads "true" as the merchant slug and reports
 * `No merchant 'true'`, which names neither the real problem nor the fix.
 *
 * So `npm_config_*` is read only when it holds a real value, never when it is
 * npm's boolean `true`, and `mangledByNpm` turns the whole situation into one
 * sentence that says what to run instead.
 */
function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith('--')) return argv[i + 1];
  const eq_ = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq_) return eq_.slice(name.length + 3);

  const npm = process.env[`npm_config_${name.replace(/-/g, '_')}`];
  // 'true' is npm having swallowed the flag, not a value anyone typed.
  return npm && npm.length > 0 && npm !== 'true' ? npm : undefined;
}
const has = (n: string) => process.argv.slice(2).includes(`--${n}`);

/** Did npm strip our flags before we ever saw them? */
function mangledByNpm(): boolean {
  const named = ['slug', 'scenario', 'url', 'order', 'amount', 'reference'];
  const sawAnyFlag = process.argv.slice(2).some((a) => a.startsWith('--'));
  const npmAte = named.some((n) => process.env[`npm_config_${n}`] === 'true');
  return npmAte && !sawAnyFlag;
}

const { db } = createClient({ max: 1 });

async function main(): Promise<void> {
  if (mangledByNpm()) {
    const passed = process.argv.slice(2).join(' ');
    console.error(
      '\n  npm removed the flags before this script ran (it does that on PowerShell).\n' +
        `  It received: ${passed || '(nothing)'}\n\n` +
        '  Run it directly instead — same arguments, no npm in the middle:\n\n' +
        `    npx tsx scripts/simulate.ts ${passed ? `--slug ${passed.split(' ')[0]}` : '--slug sandbox --scenario card_expired'}\n`,
    );
    process.exit(1);
  }

  if (has('list')) {
    console.log('\n  Scenarios:\n');
    for (const k of Object.keys(FAILURE_SCENARIOS)) console.log(`    ${k}`);
    console.log('\n  Closing events:');
    console.log('    --paid            order.paid for an order id you already simulated');
    console.log('    --link-paid       payment_link.paid, to close a case by its recovery link\n');
    return;
  }

  const slug = arg('slug') ?? 'sandbox';
  const base = (arg('url') ?? appUrl()).replace(/\/$/, '');

  // ── resolve the merchant and its secret ──
  const rows = await db
    .select({
      id: merchants.id,
      slug: merchants.slug,
      name: merchants.name,
      executionEnabled: merchants.executionEnabled,
      mode: razorpayConnections.mode,
      webhookSecretEnc: razorpayConnections.webhookSecretEnc,
    })
    .from(merchants)
    .leftJoin(
      razorpayConnections,
      and(
        eq(razorpayConnections.merchantId, merchants.id),
        eq(razorpayConnections.status, 'active'),
      ),
    )
    .where(and(sql`${merchants.deletedAt} is null`, sql`${merchants.slug} = ${slug}`))
    .limit(1);

  const m = rows.at(0);
  if (!m) {
    const all = await db
      .select({ slug: merchants.slug })
      .from(merchants)
      .where(sql`${merchants.deletedAt} is null`);
    console.error(`\n  No merchant '${slug}'. Known: ${all.map((x) => x.slug).join(', ')}\n`);
    process.exit(1);
  }

  /*
   * THE RAIL. A fabricated failure against a live account creates a real case
   * about a customer whose payment never failed, and the agent then messages
   * them about it.
   */
  if (m.mode === 'live') {
    console.error(
      `\n  REFUSED: '${m.slug}' is connected in LIVE mode.\n` +
        `  Simulating a failure there would create a real case about a payment that\n` +
        `  never failed, and the agent would message that customer about it.\n\n` +
        `  Point this at a test-mode merchant instead.\n`,
    );
    process.exit(1);
  }

  if (!m.webhookSecretEnc) {
    console.error(
      `\n  '${m.slug}' has no stored webhook secret, so the endpoint cannot verify anything.\n` +
        `  Store it with: npm run merchant -- connect --slug ${m.slug} --mode test \\\n` +
        `      --key rzp_test_… --secret … --webhook-secret …\n`,
    );
    process.exit(1);
  }

  const secret = decryptSecret(m.webhookSecretEnc);
  const endpoint = `${base}/api/webhooks/razorpay/${slugCandidates(m.slug)[0]}`;

  // ── build the payload ──
  const orderId = arg('order') ?? `order_sim_${Date.now().toString(36)}`;
  const amount = Number(arg('amount') ?? 184300);

  let envelope: Record<string, unknown>;
  let label: string;

  if (has('paid')) {
    envelope = orderPaidEnvelope({ orderId, amount }) as unknown as Record<string, unknown>;
    label = `order.paid on ${orderId}`;
  } else if (has('link-paid')) {
    const ref = arg('reference');
    if (!ref) {
      console.error('\n  --link-paid needs --reference <caseId | cartId | voiceCallId>\n');
      process.exit(1);
    }
    envelope = paymentLinkPaidEnvelope({
      referenceId: ref,
      amount,
      amountPaid: Number(arg('paid-amount') ?? amount),
    }) as unknown as Record<string, unknown>;
    label = `payment_link.paid on reference ${ref}`;
  } else {
    const scenario = (arg('scenario') ?? 'card_expired') as FailureScenario;
    const build = FAILURE_SCENARIOS[scenario];
    if (!build) {
      console.error(
        `\n  Unknown scenario '${scenario}'. Run with --list to see them all.\n`,
      );
      process.exit(1);
    }
    const built = build() as unknown as Record<string, unknown>;
    // Give every run its own order and payment, or the live-case unique index
    // collapses the second simulation into the first and it looks like nothing
    // happened.
    const payload = built.payload as { payment?: { entity?: Record<string, unknown> } };
    if (payload?.payment?.entity) {
      payload.payment.entity.order_id = orderId;
      payload.payment.entity.id = `pay_sim_${Date.now().toString(36)}`;
      payload.payment.entity.amount = amount;
      const phone = arg('phone');
      const email = arg('email');
      if (phone) payload.payment.entity.contact = phone;
      if (email) payload.payment.entity.email = email;
    }
    envelope = built;
    label = `payment.failed (${scenario}) on ${orderId}`;
  }

  // ── sign and send, exactly as Razorpay would ──
  const rawBody = JSON.stringify(envelope);
  const signature = computeSignature(rawBody, secret);
  const eventId = `evt_sim_${randomUUID()}`;

  console.log(`\n  ${m.name} (${m.slug})  ·  ${m.executionEnabled ? 'LIVE' : 'PAUSED'}`);
  console.log(`  ${endpoint}`);
  console.log(`  → ${label}\n`);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-razorpay-signature': signature,
      'x-razorpay-event-id': eventId,
    },
    body: rawBody,
  });

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text.slice(0, 500);
  }

  console.log(`  ${res.status}`, JSON.stringify(parsed, null, 2).split('\n').join('\n  '));

  if (!res.ok) {
    console.log('\n  The endpoint refused it. The usual causes, in order of likelihood:');
    console.log('    · the stored webhook secret is not the one this endpoint verifies against');
    console.log('    · the URL is wrong — open it in a browser, it names the slugs that exist');
    console.log('    · APP_URL points somewhere other than the deployment you meant\n');
    process.exit(1);
  }

  if (!has('paid') && !has('link-paid')) {
    console.log('\n  Watch it from here:');
    console.log(`    the console      ${base}/recovery`);
    console.log(`    close it         npm run simulate -- --slug ${m.slug} --order ${orderId} --paid`);
    console.log(`    or by its link   npm run simulate -- --slug ${m.slug} --link-paid --reference <caseId>\n`);
  }
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(`\n  ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
