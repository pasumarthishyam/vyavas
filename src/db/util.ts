/**
 * Driver shims.
 *
 * `db.execute()` returns different shapes per driver: postgres.js hands back a
 * row array directly, PGlite hands back `{ rows }`. Our repos run against both
 * — postgres.js in production, PGlite in tests so the suite exercises real
 * Postgres semantics (partial unique indexes, ON CONFLICT, enums, advisory
 * locks) with no external database to start.
 *
 * One shim here beats a per-call-site conditional everywhere.
 */

export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}

/** Paise columns are `bigint`; drivers may hand them back as string or bigint. */
export function paiseFromColumn(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number(value);
  return 0;
}
