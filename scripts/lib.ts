/**
 * Shared bits for the operator scripts.
 *
 * Small on purpose. Scripts here are otherwise standalone — each one is meant
 * to be readable top to bottom without chasing a helper — so this holds only
 * the thing that would be genuinely bad to duplicate three times.
 */

/** Command-line flag: `--name=value`. */
export function flag(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
}

/** Walk a `cause` chain looking for a Postgres error code. */
function pgCode(error: unknown): string | null {
  let cursor: unknown = error;
  for (let depth = 0; cursor != null && depth < 5; depth++) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Turn a script failure into one useful line.
 *
 * The case this exists for is the first run after pulling this branch: the
 * tables are in the schema and the migration has not been applied, so every one
 * of these scripts dies in forty lines of DrizzleQueryError that never mention
 * the words `db:migrate`. Postgres already told us exactly what is wrong —
 * 42P01, undefined_table — and passing that through as a stack trace wastes it.
 */
export function explain(error: unknown): string {
  const code = pgCode(error);

  if (code === '42P01') {
    return (
      'A table this script needs does not exist yet.\n' +
      '  The escalation queue and taxonomy proposals arrived in migration 0005.\n\n' +
      '  Apply it:  npm run db:migrate\n' +
      '  Verify it: npm run db:doctor'
    );
  }

  if (code === '28P01' || code === '3D000') {
    return (
      'The database refused the connection.\n' +
      '  Check DATABASE_URL in .env.local — the app uses the POOLED string (port 6543).'
    );
  }

  if (error instanceof Error) return error.message;
  return String(error);
}

/** Print `explain()` and set a failing exit code. Never rethrows. */
export function die(error: unknown): void {
  console.error(`\n  ${explain(error)}\n`);
  process.exitCode = 1;
}
