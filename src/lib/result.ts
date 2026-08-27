/**
 * A tiny Result type.
 *
 * Used where a failure is an ordinary, expected outcome that a caller must
 * handle (an illegal state transition, an unparseable payload) rather than a
 * bug. Genuine invariant violations still throw.
 */

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E = string> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export function isOk<T, E>(r: Result<T, E>): r is Ok<T> {
  return r.ok;
}

export function isErr<T, E>(r: Result<T, E>): r is Err<E> {
  return !r.ok;
}

/** Unwrap or throw. Use only where a failure genuinely is a bug. */
export function unwrap<T, E>(r: Result<T, E>): T {
  if (r.ok) return r.value;
  throw new Error(`unwrap() on Err: ${JSON.stringify(r.error)}`);
}

/** Exhaustiveness helper — makes a missing switch case a compile error. */
export function assertNever(x: never, message = 'Unexpected value'): never {
  throw new Error(`${message}: ${JSON.stringify(x)}`);
}
