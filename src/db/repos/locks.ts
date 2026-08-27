/**
 * The customer lock — the single most important query in the product.
 *
 * The problem it solves: a customer can have several live cases at once (a
 * failed payment AND an overdue invoice AND a lapsing subscription), each
 * driven by an independent workflow that wakes on its own timer. Each workflow
 * checks the frequency cap, sees room, and sends. The person receives three
 * messages in the same minute and concludes we are spam.
 *
 * A per-case lock does not help — the cases are different rows. A table lock is
 * far too coarse. What is needed is a lock keyed on the PERSON, held for the
 * duration of the check-and-send, across every case and every workflow.
 *
 * `pg_advisory_xact_lock` is exactly that: a lock on an arbitrary integer,
 * scoped to the transaction, released automatically on commit or rollback —
 * including if the process dies mid-transaction, which a manually-released lock
 * would not survive.
 *
 * No ORM abstracts this. It is one line of raw SQL inside a typed transaction,
 * which is the argument for Drizzle in miniature.
 */

import { sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { rowsOf } from '../util.js';

/**
 * Advisory lock keys are bigints. `hashtextextended` gives a stable 64-bit hash
 * of the key with a fixed seed, so the same customer always maps to the same
 * lock across processes and restarts.
 *
 * Namespaced so a customer id and (say) a merchant id can never collide on the
 * same lock number.
 */
function lockKey(namespace: string, id: string) {
  return sql`hashtextextended(${`${namespace}:${id}`}, 0)`;
}

/**
 * Run `fn` while holding the exclusive lock for this customer.
 *
 * Blocks other holders until the transaction commits. Everything that could
 * result in a message — reading the recent-message count, deciding, and writing
 * the message_log row — must happen INSIDE this callback, or the check and the
 * write can interleave and the cap leaks.
 */
export async function withCustomerLock<T>(
  db: Database,
  customerId: string,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${lockKey('customer', customerId)})`);
    return fn(tx as unknown as Database);
  });
}

/**
 * Non-blocking variant. Returns `null` immediately if another transaction holds
 * the lock.
 *
 * Preferred in the workflow: a rung that cannot get the lock right now should
 * defer and retry rather than pile up blocked transactions against the pooler.
 */
export async function tryWithCustomerLock<T>(
  db: Database,
  customerId: string,
  fn: (tx: Database) => Promise<T>,
): Promise<T | null> {
  return db.transaction(async (tx) => {
    const result = await tx.execute(
      sql`select pg_try_advisory_xact_lock(${lockKey('customer', customerId)}) as locked`,
    );
    const locked = rowsOf<{ locked: boolean }>(result).at(0)?.locked === true;
    if (!locked) return null;
    return fn(tx as unknown as Database);
  });
}

/** Same mechanism, keyed on a case — for guarding a single case's rung execution. */
export async function withCaseLock<T>(
  db: Database,
  caseId: string,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${lockKey('case', caseId)})`);
    return fn(tx as unknown as Database);
  });
}
