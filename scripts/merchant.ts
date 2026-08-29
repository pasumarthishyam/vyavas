/**
 * Merchant administration.
 *
 * The only way credentials get into the system. Runs from a trusted machine
 * against the database — never a browser form, never a Vercel environment
 * variable, never git.
 *
 *   npm run merchant -- list
 *
 *   npm run merchant -- create --slug sandbox --name "Sandbox"
 *
 *   npm run merchant -- connect --slug sandbox --mode test \
 *       --key rzp_test_xxx --secret yyy --webhook-secret zzz
 *
 *   npm run merchant -- email --slug tradesmetrix \
 *       --resend-key re_xxx --from "Tradesmetrix <payments@updates.tradesmetrix.com>"
 *
 *   npm run merchant -- routing --slug sandbox \
 *       --whatsapp-to 918977629575 --email-to you@example.com
 *   npm run merchant -- routing --slug tradesmetrix --whatsapp-to none --email-to none
 *
 * Secrets are encrypted with ENCRYPTION_KEY before they touch a column and are
 * only ever echoed back masked. Nothing here prints a secret in full, because
 * a terminal scrollback is a place secrets get copied out of.
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();

import { and, eq, sql } from 'drizzle-orm';

import { createClient } from '../src/db/client.js';
import { merchants, razorpayConnections } from '../src/db/schema/tenancy.js';
import { encryptSecret } from '../src/lib/crypto.js';

// ─── arg parsing ─────────────────────────────────────────────────────────────
//
// npm on Windows swallows `--flag=value` before it reaches process.argv, so
// every flag is read from argv AND from the npm_config_* variables npm sets.

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith('--')) return argv[i + 1];

  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);

  const npm = process.env[`npm_config_${name.replace(/-/g, '_')}`];
  return npm && npm.length > 0 ? npm : undefined;
}

function required(name: string): string {
  const v = arg(name);
  if (!v) {
    console.error(`\n  Missing --${name}\n`);
    process.exit(1);
  }
  return v;
}

/** Masked so a scrollback never carries a usable credential. */
function mask(secret: string): string {
  if (secret.length <= 8) return '••••••••';
  return `${secret.slice(0, 4)}…${secret.slice(-4)} (${secret.length} chars)`;
}

const command = process.argv[2] ?? 'list';
const { sql: rawSql, db } = createClient({ max: 1 });

async function main(): Promise<void> {
  switch (command) {
    case 'list':
      return list();
    case 'create':
      return create();
    case 'connect':
      return connect();
    case 'email':
      return email();
    case 'routing':
      return routing();
    default:
      console.error(`\n  Unknown command '${command}'. Try: list | create | connect | email | routing\n`);
      process.exit(1);
  }
}

async function list(): Promise<void> {
  const rows = await db
    .select({ m: merchants, c: razorpayConnections })
    .from(merchants)
    .leftJoin(
      razorpayConnections,
      and(eq(razorpayConnections.merchantId, merchants.id), eq(razorpayConnections.status, 'active')),
    )
    .where(sql`${merchants.deletedAt} is null`)
    .orderBy(merchants.createdAt);

  if (rows.length === 0) {
    console.log('\n  No merchants. Create one with:  npm run merchant -- create --slug x --name "X"\n');
    return;
  }

  console.log('');
  for (const { m, c } of rows) {
    const mode = !m.executionEnabled ? 'OFF' : m.dryRun ? 'DRY RUN' : 'LIVE';
    console.log(`  ${m.name}  (${m.slug})`);
    console.log(`    sending    ${mode}`);
    console.log(
      `    razorpay   ${c?.keyId ? `${c.keyId}  [${c.mode}]` : '— not connected (falls back to env)'}`,
    );
    console.log(`    webhook    ${c?.webhookSecretEnc ? 'stored' : '— not set'}`);
    console.log(`    email      ${m.resendApiKeyEnc ? 'stored' : '— not set (falls back to env)'}`);
    console.log(`    from       ${m.emailFrom ?? '—'}`);
    console.log(
      `    routing    whatsapp → ${m.whatsappRedirectTo ?? 'REAL CUSTOMER'}   email → ${m.emailRedirectTo ?? 'REAL CUSTOMER'}`,
    );
    console.log('');
  }
}

async function create(): Promise<void> {
  const slug = required('slug');
  const name = arg('name') ?? slug;

  const existing = await db.select().from(merchants).where(eq(merchants.slug, slug)).limit(1);
  if (existing.length > 0) {
    console.log(`\n  '${slug}' already exists.\n`);
    return;
  }

  const [row] = await db
    .insert(merchants)
    .values({
      name,
      slug,
      // A new merchant starts switched off and in dry run. Turning it on is a
      // deliberate act, never a default.
      executionEnabled: false,
      dryRun: true,
    })
    .returning({ id: merchants.id });

  console.log(`\n  Created ${name} (${slug})  ${row!.id}`);
  console.log('  Sending is OFF and dry run is ON. Connect credentials next.\n');
}

async function connect(): Promise<void> {
  const slug = required('slug');
  const mode = required('mode');
  const keyId = required('key');
  const keySecret = required('secret');
  const webhookSecret = arg('webhook-secret');

  if (mode !== 'test' && mode !== 'live') {
    console.error("\n  --mode must be 'test' or 'live'\n");
    process.exit(1);
  }

  // A key id declares its own mode. Trusting the flag over the key is how a
  // live account ends up labelled 'test' in the UI and treated as safe.
  const keyMode = keyId.startsWith('rzp_live') ? 'live' : 'test';
  if (keyMode !== mode) {
    console.error(`\n  Refusing: --mode ${mode} but the key '${keyId}' is a ${keyMode} key.\n`);
    process.exit(1);
  }

  const merchant = await bySlug(slug);

  await db
    .update(razorpayConnections)
    .set({ status: 'revoked', updatedAt: sql`now()` })
    .where(
      and(
        eq(razorpayConnections.merchantId, merchant.id),
        eq(razorpayConnections.mode, mode),
        eq(razorpayConnections.status, 'active'),
      ),
    );

  await db.insert(razorpayConnections).values({
    merchantId: merchant.id,
    mode,
    scope: 'read_write',
    status: 'active',
    keyId,
    keySecretEnc: encryptSecret(keySecret),
    ...(webhookSecret ? { webhookSecretEnc: encryptSecret(webhookSecret) } : {}),
  });

  console.log(`\n  ${merchant.name} → Razorpay ${mode}`);
  console.log(`    key id   ${keyId}`);
  console.log(`    secret   ${mask(keySecret)}  encrypted`);
  console.log(`    webhook  ${webhookSecret ? `${mask(webhookSecret)}  encrypted` : '— not set'}`);
  if (mode === 'live') {
    console.log('\n  This is a LIVE key. Check routing before enabling live sending:');
    console.log(`    npm run merchant -- routing --slug ${slug}`);
  }
  console.log('');
}

async function email(): Promise<void> {
  const slug = required('slug');
  const key = required('resend-key');
  const from = arg('from');

  const merchant = await bySlug(slug);

  await db
    .update(merchants)
    .set({
      resendApiKeyEnc: encryptSecret(key),
      ...(from ? { emailFrom: from } : {}),
      updatedAt: sql`now()`,
    })
    .where(eq(merchants.id, merchant.id));

  console.log(`\n  ${merchant.name} → email`);
  console.log(`    resend key  ${mask(key)}  encrypted`);
  console.log(`    from        ${from ?? '(unchanged)'}\n`);
}

async function routing(): Promise<void> {
  const slug = required('slug');
  const whatsappTo = arg('whatsapp-to');
  const emailTo = arg('email-to');

  const merchant = await bySlug(slug);

  // 'none' clears a diversion. Distinct from omitting the flag, which leaves it
  // alone — otherwise there would be no way to say "send to real customers".
  const patch: Record<string, unknown> = { updatedAt: sql`now()` };
  if (whatsappTo) patch.whatsappRedirectTo = whatsappTo === 'none' ? null : whatsappTo;
  if (emailTo) patch.emailRedirectTo = emailTo === 'none' ? null : emailTo;

  if (Object.keys(patch).length === 1) {
    console.log(`\n  ${merchant.name} routing`);
    console.log(`    whatsapp → ${merchant.whatsappRedirectTo ?? 'REAL CUSTOMER'}`);
    console.log(`    email    → ${merchant.emailRedirectTo ?? 'REAL CUSTOMER'}`);
    console.log('\n  Change with --whatsapp-to <number|none> --email-to <address|none>\n');
    return;
  }

  await db.update(merchants).set(patch).where(eq(merchants.id, merchant.id));

  const [after] = await db.select().from(merchants).where(eq(merchants.id, merchant.id)).limit(1);

  console.log(`\n  ${merchant.name} routing updated`);
  console.log(`    whatsapp → ${after!.whatsappRedirectTo ?? 'REAL CUSTOMER'}`);
  console.log(`    email    → ${after!.emailRedirectTo ?? 'REAL CUSTOMER'}`);

  if (!after!.whatsappRedirectTo || !after!.emailRedirectTo) {
    console.log('\n  ⚠  At least one channel now reaches real customers when sending is LIVE.');
  }
  console.log('');
}

async function bySlug(slug: string) {
  const rows = await db.select().from(merchants).where(eq(merchants.slug, slug)).limit(1);
  const row = rows.at(0);
  if (!row) {
    console.error(`\n  No merchant with slug '${slug}'. Run:  npm run merchant -- list\n`);
    process.exit(1);
  }
  return row;
}

main()
  .then(async () => {
    await rawSql.end({ timeout: 5 });
    process.exit(0);
  })
  .catch(async (e: unknown) => {
    console.error('\n ', e instanceof Error ? e.message : e, '\n');
    await rawSql.end({ timeout: 5 });
    process.exit(1);
  });
