import { describe, expect, it } from 'vitest';

import { QueryTimeoutError, isQueryTimeout } from '../../src/db/client.js';

/*
 * The check every route uses to tell "the connection stopped answering" from
 * "we sent a bad query".
 *
 * It exists because the obvious version does not work. Drizzle rewraps every
 * driver failure as a `DrizzleQueryError` and hangs the original off `cause`,
 * so `error instanceof QueryTimeoutError` at a call site is always false — the
 * one check anybody would reach for silently never matches, and a wedged
 * connection gets reported as a 500 that looks like a bug in the route.
 */
describe('isQueryTimeout', () => {
  it('recognises the error directly', () => {
    expect(isQueryTimeout(new QueryTimeoutError(10_000, 'select 1'))).toBe(true);
  });

  it('recognises it through the wrapper drizzle actually throws', () => {
    const wrapped = new Error('Failed query: select 1');
    wrapped.cause = new QueryTimeoutError(10_000, 'select 1');
    expect(isQueryTimeout(wrapped)).toBe(true);
  });

  it('recognises it several layers down', () => {
    const inner = new Error('driver');
    inner.cause = new QueryTimeoutError(10_000, 'select 1');
    const outer = new Error('Failed query');
    outer.cause = inner;
    expect(isQueryTimeout(outer)).toBe(true);
  });

  it('does not mistake a real Postgres error for one', () => {
    // A syntax error means the server DID answer. Retrying cannot help, and
    // discarding the connection over it would throw away a healthy one.
    const pgError = new Error('syntax error at or near "slect"');
    const wrapped = new Error('Failed query');
    wrapped.cause = pgError;
    expect(isQueryTimeout(wrapped)).toBe(false);
  });

  it('handles non-errors and cycles without hanging', () => {
    expect(isQueryTimeout(null)).toBe(false);
    expect(isQueryTimeout('timeout')).toBe(false);

    const loop = new Error('a');
    loop.cause = loop;
    expect(isQueryTimeout(loop)).toBe(false);
  });
});
