/**
 * The database client.
 *
 * Three settings here are the difference between working and falling over under
 * load, and the first two are Supabase-pooler specific:
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
 *   query timeout   A CLIENT-side ceiling on every query, and the eviction of
 *                   the memoised client when one is hit. See below — this is
 *                   the one that stops a warm instance becoming a black hole.
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

/**
 * A query that got no answer at all inside its budget.
 *
 * Distinct from a Postgres error on purpose: a `PostgresError` means the server
 * received the query and refused it, which is a bug in the query. This means
 * the server never answered, which is a bug in the connection — different
 * cause, different fix, and only this one warrants throwing the client away.
 */
export class QueryTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly query: string;

  constructor(timeoutMs: number, query: string) {
    super(
      `Database gave no response within ${timeoutMs}ms. The connection is not ` +
        `answering; it has been discarded and the next request will build a new ` +
        `one. Query: ${query}`,
    );
    this.name = 'QueryTimeoutError';
    this.timeoutMs = timeoutMs;
    this.query = query;
  }
}

/**
 * Did this failure come from a connection that stopped answering?
 *
 * Walks the `cause` chain, because drizzle rewraps every driver error as a
 * `DrizzleQueryError` — so `instanceof QueryTimeoutError` at a call site is
 * always false, and the one check anybody would reach for silently never
 * matches. Callers use this to answer 503 (try again, the database is not
 * responding) rather than 500 (we are broken).
 */
export function isQueryTimeout(error: unknown): boolean {
  let cursor: unknown = error;
  for (let depth = 0; cursor instanceof Error && depth < 5; depth++) {
    if (cursor instanceof QueryTimeoutError || cursor.name === 'QueryTimeoutError') return true;
    cursor = cursor.cause;
  }
  return false;
}

/** Client-side ceiling on one statement. */
const QUERY_TIMEOUT_MS = 10_000;
/** Transactions do several statements behind one lock; a larger, still finite, budget. */
const TRANSACTION_TIMEOUT_MS = 20_000;

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
  /** Client-side ceiling on one query. Raise for batch scripts, never for a route. */
  queryTimeoutMs?: number;
  /** Client-side ceiling on one transaction. */
  transactionTimeoutMs?: number;
  /**
   * Called when a query gets no answer inside its budget.
   *
   * `getDb` uses this to throw the memoised client away. Scripts leave it unset:
   * they own their client's lifecycle and a timeout there should surface as an
   * error, not silently swap the connection underneath them.
   */
  onTimeout?: (error: QueryTimeoutError) => void;
}

/**
 * Race a driver call against the clock.
 *
 * The rejection path still attaches a handler to the underlying promise even
 * after the timeout has won, so a query that answers late — which it will, on a
 * connection that was merely slow rather than dead — cannot surface as an
 * unhandled rejection and take the process down.
 */
function guard<T>(
  start: () => PromiseLike<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: (error: QueryTimeoutError) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new QueryTimeoutError(timeoutMs, label);
      // Eviction must never mask the timeout: the caller needs the error even
      // if tearing the old client down goes wrong.
      try {
        onTimeout?.(error);
      } catch {
        /* ignored */
      }
      reject(error);
    }, timeoutMs);

    // A pending guard must not be the reason a script stays alive.
    timer.unref?.();

    Promise.resolve(start()).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Keep the log line readable; the full statement is on the error. */
function label(query: string): string {
  const flat = query.replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
}

/**
 * Wrap one pending postgres.js query.
 *
 * Drizzle consumes a query in two shapes — `await client.unsafe(q, p)` and
 * `await client.unsafe(q, p).values()` — so the wrapper has to be both a
 * thenable and a carrier of `.values()` / `.execute()`. The settled promise is
 * memoised so awaiting twice does not start two clocks.
 */
interface PendingQuery {
  values: (...args: unknown[]) => PendingQuery;
  execute: (...args: unknown[]) => PendingQuery;
  then: (onOk?: unknown, onErr?: unknown) => Promise<unknown>;
  catch: (onErr?: unknown) => Promise<unknown>;
  finally: (onDone?: () => void) => Promise<unknown>;
}

/**
 * Loose on purpose. postgres.js narrows a query's type as it is refined —
 * `.values()` returns a shape that no longer offers `.values()` — and the
 * wrapper does not care, because it only ever forwards whatever is there.
 */
type RawQuery = PromiseLike<unknown> & {
  values?: (...args: unknown[]) => RawQuery;
  execute?: (...args: unknown[]) => RawQuery;
};

function wrapPending(
  pending: RawQuery,
  timeoutMs: number,
  queryLabel: string,
  onTimeout?: (error: QueryTimeoutError) => void,
): PendingQuery {
  let settled: Promise<unknown> | null = null;
  const run = (): Promise<unknown> =>
    (settled ??= guard(() => pending, timeoutMs, queryLabel, onTimeout));

  /** Forward a refinement (`.values()`, `.execute()`) and re-wrap the result. */
  const refine = (method: 'values' | 'execute') => (...args: unknown[]) => {
    const next = pending[method];
    if (typeof next !== 'function') {
      throw new TypeError(`postgres.js query has no ${method}() to forward`);
    }
    return wrapPending(next.call(pending, ...args), timeoutMs, queryLabel, onTimeout);
  };

  return {
    values: refine('values'),
    execute: refine('execute'),
    then: (onOk, onErr) => run().then(onOk as never, onErr as never),
    catch: (onErr) => run().catch(onErr as never),
    finally: (onDone) => run().finally(onDone),
  };
}

/**
 * The client drizzle is handed: the real one, with `unsafe` and `begin` shadowed.
 *
 * `Object.create` rather than a Proxy or a mutation of `sql` itself, for two
 * reasons. Drizzle's driver writes to `client.options.parsers` at construction,
 * and prototype lookup lands that on the real options object, so type parsing
 * still works. And postgres.js's own internals — the transaction machinery
 * calls `sql.unsafe('begin …')` — keep using the untouched original, so nothing
 * about how a transaction is driven changes.
 *
 * Drizzle's postgres-js session reaches for exactly two methods, `unsafe` and
 * `begin`, and never calls the client as a template tag. Both are covered here;
 * a future SDK that reached for a third would bypass the timeout, which is why
 * this comment names the assumption.
 */
function guardClient(
  sql: postgres.Sql,
  queryTimeoutMs: number,
  transactionTimeoutMs: number,
  onTimeout?: (error: QueryTimeoutError) => void,
): postgres.Sql {
  const guarded = Object.create(sql) as postgres.Sql;

  Object.assign(guarded, {
    unsafe: (query: string, params?: unknown[], options?: unknown) =>
      wrapPending(
        (sql.unsafe as (...a: unknown[]) => RawQuery)(query, params, options),
        queryTimeoutMs,
        label(query),
        onTimeout,
      ),

    begin: (...args: unknown[]) =>
      guard(
        () => (sql.begin as (...a: unknown[]) => Promise<unknown>)(...args),
        transactionTimeoutMs,
        'transaction',
        onTimeout,
      ),
  });

  return guarded;
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
     * Recycle connections, and cap what the SERVER will run.
     *
     * Both are defence in depth, and neither is sufficient — see the client-side
     * timeout below for the one that actually closes the hole.
     *
     *   max_lifetime      a connection is retired after 5 minutes regardless of
     *                     health, so a half-dead socket cannot outlive one
     *                     deployment's idle period.
     *   statement_timeout Postgres aborts any single statement past 15s, which
     *                     turns a contended advisory lock from "hangs" into
     *                     "fails and retries" — behaviour the ladder handles.
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

  const client = guardClient(
    sql,
    opts.queryTimeoutMs ?? QUERY_TIMEOUT_MS,
    opts.transactionTimeoutMs ?? TRANSACTION_TIMEOUT_MS,
    opts.onTimeout,
  );

  return { sql, db: drizzle(client, { schema }) };
}

let cached: { sql: postgres.Sql; db: Database } | null = null;

/**
 * Lazy singleton for the app. Tests build their own client instead.
 *
 * ── why the eviction below exists ──
 *
 * The failure it fixes is invisible until production and then looks like
 * nothing at all: requests that hang, on no particular route, with a healthy
 * database, no locks held, and no error anywhere. Measured from outside, the
 * same pooled connection string answers `select 1` in ~220ms while the
 * deployment's own `/api/health` — which is that exact query — never answers at
 * all.
 *
 * The cause is a memoised client on a platform that freezes instances. Between
 * invocations the process is suspended, and Supavisor (or any hop in between)
 * is free to drop the idle connection without the frozen process ever seeing
 * the FIN. On thaw the client still believes it is connected, writes to a
 * socket nobody is listening on, and waits.
 *
 * Every guard that looks like it should catch this misses:
 *
 *   statement_timeout is SERVER-side. It can only cancel a query Postgres
 *                     actually received, and this one never arrives.
 *   connect_timeout   only covers establishing a NEW connection. The wedged
 *                     client never reconnects, because it does not know it
 *                     should.
 *   max_lifetime      is a timer, and timers do not advance while an instance
 *                     is frozen. The check also runs when a connection is
 *                     released rather than before a query is issued, so a
 *                     connection frozen for twenty minutes is handed straight
 *                     to the next query with no liveness check.
 *
 * With `max: 1` the first wedged query then blocks every later one on that
 * instance, and because the platform keeps routing traffic to a warm instance,
 * a poisoned one stays warm and keeps attracting requests. It never recovers on
 * its own.
 *
 * So: a client-side deadline on every query, and on the first one that expires
 * the client is thrown away. The next request builds a fresh one and pays about
 * 200ms for it. That is the whole fix — the instance heals itself instead of
 * staying a black hole.
 */
export function getDb(): Database {
  if (cached) return cached.db;

  // Declared before the client so the timeout callback can name the exact entry
  // it belongs to. Without that check a slow query on the OLD client would
  // evict a healthy NEW one that had already replaced it.
  const entry: { sql: postgres.Sql; db: Database } = createClient({
    onTimeout: () => discard(entry),
  });

  cached = entry;
  return entry.db;
}

/**
 * Throw away a client that stopped answering.
 *
 * The close is deliberately not awaited: the socket is very likely already
 * dead, and waiting on a graceful shutdown of a dead socket is the same hang
 * we are escaping.
 */
function discard(entry: { sql: postgres.Sql }): void {
  if (cached !== entry) return;
  cached = null;
  void entry.sql.end({ timeout: 0 }).catch(() => {});
}

export async function closeDb(): Promise<void> {
  if (cached) {
    const entry = cached;
    cached = null;
    await entry.sql.end({ timeout: 5 });
  }
}

export { schema };
