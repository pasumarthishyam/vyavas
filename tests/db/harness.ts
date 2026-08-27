/**
 * The database test harness.
 *
 * Runs against PGlite — a real Postgres compiled to WASM, in-process. That
 * matters: these tests exercise partial unique indexes, `ON CONFLICT DO
 * NOTHING`, native enums and advisory locks, none of which a mock or an
 * in-memory stub reproduces faithfully. A fake would happily accept the
 * duplicate case that the real partial index rejects, and we would find out in
 * production.
 *
 * PGlite is single-connection, so it proves correctness but cannot demonstrate
 * contention. The true concurrency proofs live in `concurrency.integration.test.ts`,
 * which runs against a real multi-connection Postgres when DATABASE_URL is set.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';

import type { Database } from '../../src/db/client.js';
import * as schema from '../../src/db/schema/index.js';

const MIGRATIONS_DIR = resolve(process.cwd(), 'src/db/migrations');

/**
 * Every migration, in order.
 *
 * Reading the directory rather than naming one file: hardcoding 0000 meant the
 * whole suite broke the moment a second migration existed, and it broke as 106
 * unrelated-looking failures rather than as one obvious message.
 */
function migrationSql(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(resolve(MIGRATIONS_DIR, f), 'utf8'));
}

export interface TestDb {
  db: Database;
  client: PGlite;
  close: () => Promise<void>;
}

/** A fresh, migrated, empty database. */
export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as Database;

  // Apply the committed migrations rather than a schema push, so the tests
  // verify the SQL we will actually run against Supabase.
  for (const ddl of migrationSql()) {
    for (const statement of ddl.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed.length === 0) continue;
      await client.exec(trimmed);
    }
  }

  return {
    db,
    client,
    close: async () => {
      await client.close();
    },
  };
}

// ─── fixtures ────────────────────────────────────────────────────────────────

export async function seedMerchant(
  db: Database,
  over: Partial<typeof schema.merchants.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(schema.merchants)
    .values({
      name: 'Test Merchant',
      slug: `test-${Math.random().toString(36).slice(2, 10)}`,
      ...over,
    })
    .returning({ id: schema.merchants.id });
  return row!.id;
}

export async function seedCustomer(
  db: Database,
  merchantId: string,
  over: Partial<typeof schema.customers.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(schema.customers)
    .values({
      merchantId,
      phone: `+9198${Math.floor(10000000 + Math.random() * 89999999)}`,
      email: `t${Math.random().toString(36).slice(2, 10)}@example.com`,
      whatsappOptIn: true,
      smsOptIn: true,
      emailOptIn: true,
      ...over,
    })
    .returning({ id: schema.customers.id });
  return row!.id;
}

/** Backdate a message so tests can exercise the 24h frequency window. */
export async function backdateMessage(
  db: Database,
  messageId: string,
  hoursAgo: number,
): Promise<void> {
  await db
    .update(schema.messageLog)
    .set({ sentAt: sql`now() - make_interval(hours => ${hoursAgo})` })
    .where(sql`${schema.messageLog.id} = ${messageId}`);
}

export { schema };
