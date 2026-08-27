/**
 * The concurrency proofs.
 *
 * These are the tests that actually matter, and they cannot run against PGlite:
 * it is single-connection, so nothing can contend with anything. Proving that
 * the customer lock SERIALISES requires real, simultaneous Postgres sessions.
 *
 * Runs when TEST_DATABASE_URL is set; skipped otherwise with a visible note.
 * Point it at a scratch database — these tests create and drop their own rows,
 * but never aim them at production.
 *
 *   TEST_DATABASE_URL="postgresql://…:5432/postgres" npm run test:integration
 *
 * Use the DIRECT connection (5432), not the pooler: Supavisor's transaction
 * mode does not hold session state across statements, and an advisory lock
 * taken on one backend would be invisible to the next.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import type { Database } from '../../src/db/client.js';
import * as schema from '../../src/db/schema/index.js';
import { createCase, recordMessageIfPermitted, withCustomerLock } from '../../src/db/repos/index.js';

const URL = process.env.TEST_DATABASE_URL;
// Supabase session-mode pooling caps concurrent clients (15 on the default
// plan), and exceeding it is a FATAL EMAXCONNSESSION rather than a queue. Ten
// leaves headroom for drizzle-kit or a studio session running alongside.
//
// This is also the production argument for transaction mode (6543) with
// max: 1 per invocation: session mode simply does not have the client slots
// for a serverless fan-out.
const POOL_SIZE = 10;

const SCHEMA = `vyavas_test_${Math.random().toString(36).slice(2, 8)}`;

const run = URL ? describe : describe.skip;

if (!URL) {
  console.warn(
    '\n  [skipped] concurrency proofs need a real multi-connection Postgres.\n' +
      '  Set TEST_DATABASE_URL to the DIRECT (5432) connection string and re-run.\n',
  );
}

run('concurrency (real Postgres)', () => {
  let sqlClient: postgres.Sql;
  let db: Database;
  let merchantId: string;
  let customerId: string;

  beforeAll(async () => {
    // An isolated schema, so the suite never touches anything that matters.
    //
    // drizzle-kit qualifies enum types as `"public"."x"` but leaves tables
    // unqualified. Applying the migration verbatim would therefore try to
    // recreate the types that already exist in public, while putting the tables
    // wherever search_path pointed. Rewriting the qualifier moves the whole
    // migration — types, tables and indexes — into the throwaway schema.
    const bootstrap = postgres(URL!, { max: 1, prepare: false, onnotice: () => {} });

    // A run that crashes before afterAll leaves its schema behind. Sweep any
    // debris from previous runs so the database does not slowly fill with it.
    const stale = await bootstrap<{ nspname: string }[]>`
      select nspname from pg_namespace where nspname like 'vyavas_test_%'`;
    for (const s of stale) {
      await bootstrap.unsafe(`drop schema if exists "${s.nspname}" cascade`);
    }

    await bootstrap.unsafe(`create schema "${SCHEMA}"`);
    await bootstrap.end();

    sqlClient = postgres(URL!, {
      max: POOL_SIZE,
      prepare: false,
      onnotice: () => {},
      connection: { search_path: SCHEMA },
    });

    const ddl = readFileSync(
      resolve(process.cwd(), 'src/db/migrations/0000_init.sql'),
      'utf8',
    ).replaceAll('"public".', `"${SCHEMA}".`);

    for (const statement of ddl.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) await sqlClient.unsafe(trimmed);
    }

    db = drizzle(sqlClient, { schema }) as unknown as Database;
  }, 120_000);

  afterAll(async () => {
    if (sqlClient) {
      await sqlClient.unsafe(`drop schema if exists "${SCHEMA}" cascade`);
      await sqlClient.end({ timeout: 5 });
    }
  });

  beforeEach(async () => {
    await sqlClient.unsafe(
      `truncate ${['message_log', 'case_events', 'case_actions', 'recovery_cases', 'customers', 'merchants']
        .map((t) => `"${SCHEMA}"."${t}"`)
        .join(', ')} cascade`,
    );

    const [m] = await db
      .insert(schema.merchants)
      .values({ name: 'T', slug: `t-${Math.random().toString(36).slice(2, 8)}` })
      .returning({ id: schema.merchants.id });
    merchantId = m!.id;

    const [c] = await db
      .insert(schema.customers)
      .values({ merchantId, phone: '+919876543210', whatsappOptIn: true })
      .returning({ id: schema.customers.id });
    customerId = c!.id;
  });

  it('serialises concurrent holders of the customer lock', async () => {
    // If the lock did not serialise, the interleaved sections would overlap and
    // `maxConcurrent` would exceed 1.
    let inside = 0;
    let maxConcurrent = 0;

    await Promise.all(
      Array.from({ length: 10 }, () =>
        withCustomerLock(db, customerId, async () => {
          inside += 1;
          maxConcurrent = Math.max(maxConcurrent, inside);
          await new Promise((r) => setTimeout(r, 25));
          inside -= 1;
        }),
      ),
    );

    expect(maxConcurrent).toBe(1);
  }, 60_000);

  it('does not serialise different customers against each other', async () => {
    const [other] = await db
      .insert(schema.customers)
      .values({ merchantId, phone: '+919999999999' })
      .returning({ id: schema.customers.id });

    const HOLD = 600;
    const time = async (fn: () => Promise<unknown>) => {
      const t = Date.now();
      await fn();
      return Date.now() - t;
    };

    const hold = () => new Promise((r) => setTimeout(r, HOLD));

    // Measured by SUBTRACTION, not by ratio.
    //
    // The database is in Mumbai and each transaction costs several round trips,
    // so every measurement here is `work + a large constant`. A ratio compares
    // (2H + c) against (H + c), which collapses toward 1 as latency grows and
    // makes the test fail on a slow connection rather than on a real defect.
    // Subtracting cancels the constant, so the assertion measures the lock.
    const baseline = await time(() => withCustomerLock(db, customerId, hold));

    const differentCustomers = await time(() =>
      Promise.all([
        withCustomerLock(db, customerId, hold),
        withCustomerLock(db, other!.id, hold),
      ]),
    );

    const sameCustomer = await time(() =>
      Promise.all([withCustomerLock(db, customerId, hold), withCustomerLock(db, customerId, hold)]),
    );

    // Two holders on the SAME customer queue, so the pair costs one extra hold.
    expect(sameCustomer - differentCustomers).toBeGreaterThan(HOLD * 0.6);

    // Two holders on DIFFERENT customers overlap, so the pair costs about what
    // one alone costs. Serialising unrelated customers would throttle the whole
    // system during an outage, exactly when throughput matters most.
    expect(differentCustomers - baseline).toBeLessThan(HOLD * 0.5);
  }, 90_000);

  it('lets EXACTLY ONE of twenty-five concurrent sends through a cap of one', async () => {
    // The bug this whole design exists to prevent: two workflows both read
    // "0 messages today, cap is 1", both decide there is room, and the customer
    // gets two messages within the same second.
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        recordMessageIfPermitted(
          db,
          {
            merchantId,
            customerId,
            caseId: null,
            rung: i,
            channel: 'whatsapp',
            intent: 'switch_method',
            idempotencyKey: `race:${i}`,
          },
          1,
        ),
      ),
    );

    expect(results.filter((r) => r.permitted)).toHaveLength(1);

    const sent = await db
      .select()
      .from(schema.messageLog)
      .where(sql`${schema.messageLog.suppressedReason} is null`);
    expect(sent).toHaveLength(1);
  }, 120_000);

  it('creates exactly one case when the same order fails concurrently', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        createCase(db, {
          merchantId,
          customerId,
          type: 'payment_failure',
          amountAtRiskPaise: 184300,
          rzpOrderId: 'order_RACE',
          attended: true,
        }),
      ),
    );

    expect(results.filter((r) => r.created)).toHaveLength(1);
    // Every caller gets the same case id back, so twenty webhook deliveries
    // drive one ladder rather than twenty.
    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(1);

    expect(await db.select().from(schema.recoveryCases)).toHaveLength(1);
  }, 60_000);

  it('claims a duplicated webhook exactly once under concurrency', async () => {
    const { recordWebhook } = await import('../../src/db/repos/webhooks.js');
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        recordWebhook(db, {
          eventId: 'evt_race',
          eventType: 'payment.failed',
          payload: { n: 1 },
        }),
      ),
    );
    expect(results.filter((r) => r.isNew)).toHaveLength(1);
  }, 60_000);
});
