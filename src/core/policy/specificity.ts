/**
 * Specificity scoring — how the resolver decides which of several matching
 * rows actually applies.
 *
 * A weighted sum, not a count. Counting constrained dimensions would make
 * `{causeClass, amountBand}` beat `{errorReason}`, which is backwards: knowing
 * the exact failure reason tells you far more about what to do than knowing the
 * ticket size. The weights encode how much each dimension narrows the world.
 *
 * Weights are spaced so that no combination of weaker dimensions can outrank a
 * stronger one on its own — `errorReason` (100) beats every other dimension
 * combined (76). That keeps the ordering legible: a row naming the exact reason
 * always wins over a row generalising about the class.
 */

import type { PolicyMatch, PolicyRow } from './schema.js';

export const MATCH_WEIGHTS = {
  errorReason: 100,
  bank: 30,
  errorSource: 15,
  errorStep: 12,
  method: 8,
  causeClass: 6,
  amountBand: 3,
  caseType: 1,
  attended: 1,
} as const satisfies Record<keyof PolicyMatch, number>;

export const MAX_NON_REASON_WEIGHT = Object.entries(MATCH_WEIGHTS)
  .filter(([k]) => k !== 'errorReason')
  .reduce((sum, [, w]) => sum + w, 0);

export function specificityOf(match: PolicyMatch): number {
  let score = 0;
  for (const key of Object.keys(MATCH_WEIGHTS) as (keyof PolicyMatch)[]) {
    if (match[key] !== undefined) score += MATCH_WEIGHTS[key];
  }
  return score;
}

export function rowSpecificity(row: PolicyRow): number {
  return row.catchAll ? -1 : specificityOf(row.match);
}

/** Which dimensions a row constrains — for the UI and for ambiguity reporting. */
export function constrainedDimensions(match: PolicyMatch): readonly (keyof PolicyMatch)[] {
  return (Object.keys(MATCH_WEIGHTS) as (keyof PolicyMatch)[]).filter(
    (k) => match[k] !== undefined,
  );
}
