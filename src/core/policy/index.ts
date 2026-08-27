/**
 * The compiled policy table.
 *
 * Compiled once at module load. If the committed table ever violates an
 * integrity check the process fails immediately and loudly at startup, rather
 * than degrading quietly at the moment a real customer would have been messaged.
 * That is the intended failure mode: a policy table that could instruct the
 * agent to do something indefensible should stop the deploy, not the case.
 */

import { compilePolicyTable } from './compile.js';
import { RAW_POLICY_ROWS } from './generated.js';
import type { PolicyRow } from './schema.js';

export const POLICY_TABLE: readonly PolicyRow[] = compilePolicyTable(RAW_POLICY_ROWS);

export function policyById(id: string): PolicyRow | undefined {
  return POLICY_TABLE.find((r) => r.id === id);
}

export * from './duration.js';
export * from './schema.js';
export * from './specificity.js';
export * from './resolve.js';
export * from './compile.js';
