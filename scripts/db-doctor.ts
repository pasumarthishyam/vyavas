/**
 * Checks that the deployed database actually has the guarantees the code
 * assumes.
 *
 * Migrations "applying successfully" is not the same as the constraints being
 * present — a partial index silently omitted still lets every INSERT through,
 * and the first symptom would be a customer receiving two recovery ladders for
 * one order. This asserts the guarantees exist, by name, in the live database.
 *
 *   npm run db:doctor
 */

import { config as loadEnv } from 'dotenv';
import postgres from 'postgres';

loadEnv({ path: '.env.local' });
loadEnv();

/** Index name -> what breaks in the real world if it is missing. */
const REQUIRED_INDEXES: Record<string, string> = {
  recovery_cases_live_order_key:
    'two failed attempts on one order would create two cases, and the customer would get two ladders',
  recovery_cases_live_invoice_key: 'one invoice could spawn multiple concurrent collection ladders',
  case_actions_idempotency_key: 'a workflow replay after a deploy could fire the same rung twice',
  message_log_idempotency_key: 'a workflow replay could send the same message twice',
  message_log_customer_recent_idx:
    'the cross-case frequency cap would table-scan, then time out under load',
  merchant_alerts_open_signal_key:
    'a merchant would be paged repeatedly about one ongoing configuration fault',
  customers_merchant_phone_key:
    'the same person stored twice would receive twice the messages, since the cap is keyed on customer id',
  rzp_conn_merchant_mode_key: 'two live connections would double-process every webhook',
  downtime_open_idx: 'the downtime lookup on every diagnosis would scan resolved outages too',
};

const REQUIRED_TABLES = [
  'merchants',
  'razorpay_connections',
  'customers',
  'recovery_cases',
  'case_events',
  'case_actions',
  'payment_attempts',
  'message_log',
  'webhook_events',
  'downtime_windows',
  'merchant_alerts',
];

async function main(): Promise<void> {
  const url = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('Set DIRECT_DATABASE_URL in .env.local');
    process.exit(1);
  }

  const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
  const problems: string[] = [];

  try {
    const versionRows = await sql<{ version: string }[]>`select version()`;
    console.log(versionRows[0]?.version.split(' on ')[0] ?? 'unknown server');

    const tables = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' order by table_name`;
    const tableNames = new Set(tables.map((t) => t.table_name));
    console.log(`\nTables: ${tables.length}`);
    for (const t of REQUIRED_TABLES) {
      if (!tableNames.has(t)) problems.push(`missing table: ${t}`);
    }

    const enums = await sql<{ typname: string; n: number }[]>`
      select t.typname, count(e.enumlabel)::int as n
      from pg_type t
      join pg_enum e on e.enumtypid = t.oid
      join pg_namespace ns on ns.oid = t.typnamespace
      where ns.nspname = 'public'
      group by t.typname order by t.typname`;
    console.log(`Enums:  ${enums.length}  (${enums.map((e) => `${e.typname}:${e.n}`).join(', ')})`);

    const indexes = await sql<{ indexname: string; indexdef: string }[]>`
      select indexname, indexdef from pg_indexes
      where schemaname = 'public' order by indexname`;
    const byName = new Map(indexes.map((i) => [i.indexname, i.indexdef]));
    const partial = indexes.filter((i) => i.indexdef.includes(' WHERE '));
    console.log(`Indexes: ${indexes.length} (${partial.length} partial)`);

    console.log('\nGuarantees:');
    for (const [name, consequence] of Object.entries(REQUIRED_INDEXES)) {
      const def = byName.get(name);
      if (!def) {
        problems.push(`missing index ${name} — without it, ${consequence}`);
        console.log(`  MISSING  ${name}`);
      } else {
        console.log(`  ok       ${name}`);
      }
    }

    // The advisory-lock primitive the frequency cap depends on. Session state is
    // not available through a transaction-mode pooler, so this doubles as a
    // check that we are connected on the right port.
    const lockRows = await sql<{ locked: boolean }[]>`
      select pg_try_advisory_lock(hashtextextended('db-doctor', 0)) as locked`;
    const locked = lockRows[0]?.locked === true;
    if (locked) {
      await sql`select pg_advisory_unlock(hashtextextended('db-doctor', 0))`;
      console.log('\n  ok       advisory locks available on this connection');
    } else {
      problems.push('could not take an advisory lock on this connection');
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('\nAll guarantees present.');
}

void main();
