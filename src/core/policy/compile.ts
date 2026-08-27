/**
 * Compiling the policy table.
 *
 * This is the most important file in Stage 2. It is the difference between "the
 * YAML parsed" and "the table cannot instruct the agent to do something
 * indefensible".
 *
 * Every check here failed CI at least once while the table was being written.
 * They are not hypothetical: a ladder that nudges a customer three times when
 * its cause class allows one, or that offers `retry_same` on an expired card,
 * or that re-presents a debit on an attended case, are all one careless YAML
 * edit away — and none of them would throw at runtime. They would just quietly
 * reach a real person.
 *
 * The governing rule: **a policy may tighten a safety limit, never loosen one.**
 * Cause-class traits are the ceiling; policy rows live under them.
 */

import { CAUSE_CLASSES, CAUSE_CLASS_TRAITS, type CauseClass } from '../taxonomy/cause-class.js';
import { durationToMinutes, parseDuration } from './duration.js';
import { type PolicyMatch, type PolicyRow, policyTableSchema } from './schema.js';
import { rowSpecificity } from './specificity.js';

export interface CompileIssue {
  readonly rowId: string | null;
  readonly message: string;
}

export class PolicyCompileError extends Error {
  readonly issues: readonly CompileIssue[];

  constructor(issues: readonly CompileIssue[]) {
    const body = issues.map((i) => `  - ${i.rowId ? `[${i.rowId}] ` : ''}${i.message}`).join('\n');
    super(`Policy table failed to compile:\n${body}`);
    this.name = 'PolicyCompileError';
    this.issues = issues;
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function customerTouchRungs(row: PolicyRow) {
  return row.ladder.filter((r) => r.action === 'nudge' || r.action === 'send_pre_debit_notice');
}

/** Which cause classes a row can apply to. Unconstrained means all of them. */
function applicableClasses(match: PolicyMatch): readonly CauseClass[] {
  return match.causeClass ?? CAUSE_CLASSES;
}

/**
 * Could any single input match both rows?
 *
 * Per dimension: either one side is unconstrained, or their value sets
 * intersect. If every dimension can overlap, an overlapping input exists.
 * Checking rows pairwise is O(n^2) over ~40 rows — brute-forcing the actual
 * input space would be ~40M combinations for the same answer.
 */
function canOverlap(a: PolicyMatch, b: PolicyMatch): boolean {
  if (a.errorReason !== undefined && b.errorReason !== undefined && a.errorReason !== b.errorReason) {
    return false;
  }
  if (a.attended !== undefined && b.attended !== undefined && a.attended !== b.attended) {
    return false;
  }

  const listKeys = [
    'errorSource',
    'errorStep',
    'method',
    'bank',
    'causeClass',
    'caseType',
    'amountBand',
  ] as const;

  for (const key of listKeys) {
    const av = a[key];
    const bv = b[key];
    if (av === undefined || bv === undefined) continue;
    const bSet = new Set<string>(bv);
    if (!av.some((v) => bSet.has(v))) return false;
  }

  return true;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

// ─── integrity checks ────────────────────────────────────────────────────────

function checkRow(row: PolicyRow, issues: CompileIssue[]): void {
  const add = (message: string) => issues.push({ rowId: row.id, message });
  const touches = customerTouchRungs(row);
  const nudges = row.ladder.filter((r) => r.action === 'nudge');

  // Rungs are offsets from detection, so a non-increasing ladder means a later
  // rung fires before an earlier one — silently reordering the whole ladder.
  let previous = -1;
  for (const rung of row.ladder) {
    const at = parseDuration(rung.at);
    if (at <= previous) {
      add(
        `ladder rungs must be strictly increasing offsets from detection; ` +
          `'${rung.at}' (${rung.action}) does not come after the previous rung`,
      );
    }
    previous = at;
  }

  if (touches.length > row.maxMessages) {
    add(
      `ladder has ${touches.length} customer touch(es) but maxMessages is ${row.maxMessages}. ` +
        `The trailing rungs can never fire — either raise the cap deliberately or drop them.`,
    );
  }

  // A row that reaches a customer must say which classes it applies to, or its
  // safety ceiling is undefined and the cross-check below cannot run.
  if (touches.length > 0 && row.match.causeClass === undefined && !row.catchAll) {
    add(
      `constrains no causeClass but contacts the customer. Every customer-facing row must ` +
        `declare its cause class so its safety ceiling is well defined.`,
    );
  }

  if (row.catchAll && touches.length > 0) {
    add(
      `the catch-all row must never contact a customer — it exists to catch inputs we did not ` +
        `anticipate, and an unanticipated case is the last one that should be messaged.`,
    );
  }

  // ── the ceiling cross-check ──
  for (const cc of applicableClasses(row.match)) {
    const traits = CAUSE_CLASS_TRAITS[cc];
    if (row.catchAll) continue;

    if (row.maxMessages > traits.maxCustomerTouches) {
      add(
        `maxMessages ${row.maxMessages} exceeds the ceiling of ${traits.maxCustomerTouches} ` +
          `for cause class '${cc}'. A policy may tighten a safety limit, never loosen one.`,
      );
    }

    if (!traits.contactCustomer && touches.length > 0) {
      add(`cause class '${cc}' must never produce a customer message, but this ladder has ${touches.length}`);
    }

    const firstNudge = nudges[0];
    if (firstNudge) {
      const minutes = durationToMinutes(parseDuration(firstNudge.at));
      if (minutes < traits.minFirstTouchMinutes) {
        add(
          `first nudge at ${firstNudge.at} is earlier than the ${traits.minFirstTouchMinutes}-minute ` +
            `floor for '${cc}'. That floor exists so we do not message someone mid-retry, or while ` +
            `their bank is still down.`,
        );
      }
    }

    if (!traits.sameInstrumentRetry) {
      for (const rung of nudges) {
        if (rung.suggest?.includes('retry_same')) {
          add(
            `suggests 'retry_same' but cause class '${cc}' forbids re-presenting the instrument. ` +
              `Retrying here cannot succeed and degrades the merchant's authorisation rate.`,
          );
        }
      }
      if (row.ladder.some((r) => r.action === 'retry_debit')) {
        add(`schedules retry_debit but cause class '${cc}' forbids re-presenting the instrument`);
      }
    }
  }

  // ── attended / unattended ──

  // Attended vs unattended is a compliance boundary, not a preference, so any
  // row that acts on a customer must say which side it is on. Without this a
  // reason-specific attended row (specificity ~107) silently out-ranks the
  // mandate ladder (specificity ~7) and an unattended subscription failure gets
  // the attended treatment — which is both wrong and unlawful to correct later.
  const actsOnCustomer =
    touches.length > 0 || row.ladder.some((r) => r.action === 'retry_debit');
  if (actsOnCustomer && row.match.attended === undefined && !row.catchAll) {
    add(
      `acts on the customer but does not declare 'attended'. Every such row must state whether ` +
        `it applies to attended cases (no mandate — recovery means bringing a human back) or ` +
        `unattended ones (a mandate exists and the debit may be re-presented).`,
    );
  }

  const unattendedActions = row.ladder.filter(
    (r) => r.action === 'retry_debit' || r.action === 'send_pre_debit_notice',
  );
  if (unattendedActions.length > 0 && row.match.attended !== false) {
    add(
      `schedules ${unattendedActions[0]?.action} but does not constrain 'attended: false'. ` +
        `Under RBI rules an unattended debit requires a mandate; a row that can match an ` +
        `attended case must never contain one.`,
    );
  }

  if (row.ladder.some((r) => r.action === 'retry_debit')) {
    const hasNotice = row.ladder.some((r) => r.action === 'send_pre_debit_notice');
    if (!hasNotice) {
      add(
        `schedules retry_debit without a preceding send_pre_debit_notice. RBI requires notice ` +
          `before an e-mandate debit.`,
      );
    }
    if (!row.preconditions.includes('mandate_active')) {
      add(`schedules retry_debit but does not require the 'mandate_active' precondition`);
    }
  }

  // ── the kill switch ──
  if (touches.length > 0) {
    if (!row.abortOn.includes('order_paid')) {
      add(
        `contacts the customer but does not abort on 'order_paid'. Messaging someone who has ` +
          `already paid is the one mistake that ends the relationship.`,
      );
    }
    if (!row.abortOn.includes('customer_optout')) {
      add(`contacts the customer but does not abort on 'customer_optout'`);
    }
    if (!row.preconditions.includes('order_unpaid')) {
      add(
        `contacts the customer but does not re-check 'order_unpaid' before each rung. ` +
          `Local state goes stale while a case sleeps.`,
      );
    }
    if (!row.preconditions.includes('within_frequency_cap')) {
      add(`contacts the customer but does not enforce 'within_frequency_cap'`);
    }
  }

  // Withholding a breakage alert from a merchant to measure incrementality
  // would be indefensible, so those rows are never held out.
  if (row.ladder.some((r) => r.action === 'merchant_alert') && row.holdoutEligible) {
    add(`carries a merchant alert and so must set holdoutEligible: false`);
  }
}

function checkTable(rows: readonly PolicyRow[], issues: CompileIssue[]): void {
  const add = (message: string) => issues.push({ rowId: null, message });

  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) add(`duplicate policy id '${row.id}'`);
    seen.add(row.id);
  }

  const catchAlls = rows.filter((r) => r.catchAll);
  if (catchAlls.length === 0) {
    add(
      `no catch-all row. Without one, an unanticipated input resolves to nothing and the case is ` +
        `silently dropped — money lost without anyone noticing.`,
    );
  } else if (catchAlls.length > 1) {
    add(`more than one catch-all row: ${catchAlls.map((r) => r.id).join(', ')}`);
  }

  // Total coverage. With every class explicitly covered, the catch-all becomes
  // genuinely unreachable rather than merely improbable.
  for (const cc of CAUSE_CLASSES) {
    const covered = rows.some(
      (r) => !r.catchAll && r.match.causeClass !== undefined && r.match.causeClass.includes(cc),
    );
    if (!covered) {
      add(`cause class '${cc}' has no policy row. Every class must have an explicit ladder.`);
    }
  }

  // Ambiguity: equal specificity, overlapping match, different behaviour.
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i];
      const b = rows[j];
      if (!a || !b || a.catchAll || b.catchAll) continue;
      if (rowSpecificity(a) !== rowSpecificity(b)) continue;
      if (!canOverlap(a.match, b.match)) continue;

      const sameBehaviour =
        JSON.stringify(a.ladder) === JSON.stringify(b.ladder) && a.maxMessages === b.maxMessages;
      if (!sameBehaviour) {
        add(
          `'${a.id}' and '${b.id}' have equal specificity (${rowSpecificity(a)}), can match the ` +
            `same input, and behave differently. Which one applies would depend on declaration ` +
            `order — narrow one of them.`,
        );
      }
    }
  }
}

// ─── entry point ─────────────────────────────────────────────────────────────

/**
 * Validate, normalise and freeze a raw policy table.
 *
 * `raw` is already-parsed data — core never reads a file. The YAML lives in
 * `table/`, `scripts/compile-policy.ts` parses it, and this function is the
 * only way a table becomes usable.
 */
export function compilePolicyTable(raw: unknown): readonly PolicyRow[] {
  const parsed = policyTableSchema.safeParse(raw);
  if (!parsed.success) {
    const issues: CompileIssue[] = parsed.error.issues.map((i) => ({
      rowId: typeof i.path[0] === 'number' ? `row ${i.path[0]}` : null,
      message: `${i.path.join('.')}: ${i.message}`,
    }));
    throw new PolicyCompileError(issues);
  }

  // Bank codes are uppercase everywhere else (normalize.ts uppercases them), so
  // a lowercase entry in YAML would silently never match.
  const rows: PolicyRow[] = parsed.data.map((row) => {
    const bank = row.match.bank;
    if (!bank) return row;
    // The schema types this as a non-empty tuple, which `.map` does not preserve.
    const upper = bank.map((b) => b.toUpperCase()) as [string, ...string[]];
    return { ...row, match: { ...row.match, bank: upper } };
  });

  const issues: CompileIssue[] = [];
  for (const row of rows) checkRow(row, issues);
  checkTable(rows, issues);

  if (issues.length > 0) throw new PolicyCompileError(issues);

  return deepFreeze(rows) as readonly PolicyRow[];
}
