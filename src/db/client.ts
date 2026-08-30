/**
 * The database client.
 *
 * Two settings here are the difference between working and falling over under
 * load, and both are Supabase-pooler specific:
 *
 *   prepare: false  Supavisor in transaction mode multiplexes many clients onto
 *                   few Postgres backends, so a prepared statement created on
 *                   one invocation may not exist on the backend the next
 *                   invocation lands on. Leaving this on produces intermittent
 *                   "prepared statement does not exist" errors that only appear
 *                   under concurrency — i.e. exactly during a merchant's outage,
 *                   when we most need to work.
 *
 *   max: 1          Each serverless invocation is its own process. A pool of 10
 *                   per invocation times a few hundred concurrent invocations
 *                   exhausts the database.
 *
 * Use the POOLED connection string (port 6543), not the direct one (5432).
 * Direct is for migrations only.
 */

import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { requireDatabaseUrl } from '../lib/env.js';
import * as schema from './schema/index.js';

/**
 * Driver-agnostic on purpose: postgres.js in production, PGlite in tests. The
 * repos are written against this type so the test suite exercises the same code
 * path the webhook handler will.
 */
export type Database = PgDatabase<
  PgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

export interface ClientOptions {
  connectionString?: string;
  /** Raise only for long-lived processes (a worker, a script), never serverless. */
  max?: number;
  idleTimeout?: number;
  connectTimeout?: number;
  /** Seconds before a connection is retired regardless of health. */
  maxLifetime?: number;
  /** Postgres aborts any statement running longer than this. */
  statementTimeoutMs?: number;
}

export function createClient(opts: ClientOptions = {}) {
  const connectionString = opts.connectionString ?? requireDatabaseUrl();

  const sql = postgres(connectionString, {
    // Non-negotiable with Supavisor transaction mode.
    prepare: false,
    max: opts.max ?? 1,
    idle_timeout: opts.idleTimeout ?? 20,
    connect_timeout: opts.connectTimeout ?? 10,

    /**
     * Recycle connections, and never let a query hang forever.
     *
     * These two exist because of a failure that is invisible until production
     * and then looks like nothing at all: requests that hang, on no particular
     * route, moving around between deploys, with a healthy database and no
     * locks held.
     *
     * The cause is the combination of a module-scoped client and a serverless
     * platform. `getDb()` memoises the client so warm invocations reuse it —
     * correct, and much faster than reconnecting. But between invocations the
     * instance is frozen, and Supavisor (or any hop in between) is free to drop
     * an idle connection without the frozen process ever seeing the FIN. The
     * next invocation writes to a socket nobody is listening on and waits.
     * There is no error to log, because nothing failed; it simply never
     * answers, until the platform kills the request.
     *
     *   max_lifetime      a connection is retired after 5 minutes regardless of
     *                     health, so a half-dead socket cannot outlive one
     *                     deployment's idle period.
     *   statement_timeout Postgres aborts any single statement past 15s. A
     *                     query that cannot finish becomes a fast, loud error
     *                     instead of a hung request — which also converts a
     *                     contended advisory lock from "hangs" into "fails and
     *                     retries", the behaviour the ladder already handles.
     */
    max_lifetime: opts.maxLifetime ?? 60 * 5,
    connection: {
      statement_timeout: opts.statementTimeoutMs ?? 15_000,
    },

    // Money is read as integer paise; never let a driver hand back a float.
    types: {
      bigint: postgres.BigInt,
    },
  });

  return { sql, db: drizzle(sql, { schema }) };
}

let cached: { sql: postgres.Sql; db: Database } | null = null;

/** Lazy singleton for the app. Tests build their own client instead. */
export function getDb(): Database {
  cached ??= createClient();
  return cached.db;
}

export async function closeDb(): Promise<void> {
  if (cached) {
    await cached.sql.end({ timeout: 5 });
    cached = null;
  }
}

export { schema };
