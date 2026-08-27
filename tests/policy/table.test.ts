/**
 * The shipped table, exercised against the whole input space.
 *
 * `compile.test.ts` proves the guards reject bad tables. This file proves the
 * table we actually ship is good — that every case diagnose() can produce
 * resolves to a ladder, and that the ladder never contradicts the diagnosis.
 *
 * This is the Stage 2 equivalent of Stage 1's exhaustiveness suite, and it is
 * what makes the policy engine finished rather than merely written.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { POLICY_TABLE, policyById } from '@core/policy/index.js';
import {
  customerTouchRungs,
  effectiveRails,
  matchInputFrom,
  resolvePolicy,
} from '@core/policy/resolve.js';
import { CAUSE_CLASSES, CAUSE_CLASS_TRAITS } from '@core/taxonomy/cause-class.js';
import { ALL_ERROR_REASONS } from '@core/taxonomy/codes.js';
import { ERROR_SOURCES, PAYMENT_METHODS } from '@core/case/types.js';
import { diagnose } from '@core/taxonomy/diagnose.js';
import { paise } from '@core/money.js';
import { parseDuration } from '@core/policy/duration.js';
import { makeCtx, makeTuple } from '../golden/fixtures.js';
import { OUT_FILE, readYamlRows, renderGenerated } from '../../scripts/compile-policy.js';

const AMOUNT = paise(184300);

/** Every (reason x source x method) the ingestion pipeline can produce. */
function* allInputs() {
  for (const errorReason of ALL_ERROR_REASONS) {
    for (const errorSource of ERROR_SOURCES) {
      for (const method of PAYMENT_METHODS) {
        for (const hasMandate of [false, true]) {
          const tuple = makeTuple({ errorReason, errorSource, method });
          const ctx = makeCtx({
            hasMandate,
            caseType: hasMandate ? 'subscription_failure' : 'payment_failure',
          });
          yield { tuple, ctx, label: `${errorReason}/${errorSource}/${method}/mandate=${hasMandate}` };
        }
      }
    }
  }
}

describe('the shipped table compiles and is complete', () => {
  it('loads without throwing', () => {
    expect(POLICY_TABLE.length).toBeGreaterThan(0);
  });

  it('covers every cause class explicitly', () => {
    for (const cc of CAUSE_CLASSES) {
      const covered = POLICY_TABLE.some(
        (r) => !r.catchAll && r.match.causeClass?.includes(cc),
      );
      expect(covered, `cause class '${cc}' has no ladder`).toBe(true);
    }
  });

  it('has exactly one catch-all, and it reaches nobody', () => {
    const catchAlls = POLICY_TABLE.filter((r) => r.catchAll);
    expect(catchAlls).toHaveLength(1);
    expect(customerTouchRungs(catchAlls[0]!)).toHaveLength(0);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(POLICY_TABLE)).toBe(true);
  });
});

describe('total coverage — every producible case resolves to a usable ladder', () => {
  it('resolves, and never falls through to the catch-all', () => {
    const fellThrough: string[] = [];
    for (const { tuple, ctx, label } of allInputs()) {
      const d = diagnose(tuple, ctx);
      const r = resolvePolicy(POLICY_TABLE, matchInputFrom(tuple, d, AMOUNT));
      if (r.row.catchAll) fellThrough.push(label);
    }
    expect(
      fellThrough.slice(0, 10),
      `${fellThrough.length} input(s) fell through to the catch-all — a cause class is missing a ladder`,
    ).toEqual([]);
  });

  it('never contradicts the diagnosis', () => {
    const violations: string[] = [];

    for (const { tuple, ctx, label } of allInputs()) {
      const d = diagnose(tuple, ctx);
      const row = resolvePolicy(POLICY_TABLE, matchInputFrom(tuple, d, AMOUNT)).row;
      const touches = customerTouchRungs(row);

      // A diagnosis that says do not contact this customer must not meet a
      // ladder that does.
      if (!d.contactCustomer && touches.length > 0) {
        violations.push(`${label}: contactCustomer=false but ladder has ${touches.length} touch(es)`);
      }

      // The class ceiling must survive resolution, not just compilation.
      if (row.maxMessages > d.maxCustomerTouches) {
        violations.push(
          `${label}: maxMessages ${row.maxMessages} > diagnosis ceiling ${d.maxCustomerTouches}`,
        );
      }

      // No effective rail may re-present an instrument the diagnosis has ruled out.
      for (const rung of row.ladder) {
        if (rung.action !== 'nudge') continue;
        if (effectiveRails(rung.suggest, d).includes('retry_same') && !d.sameInstrumentRetry) {
          violations.push(`${label}: rung at ${rung.at} suggests retry_same after it was withdrawn`);
        }
      }

      // The compliance boundary. An attended case must never meet a debit.
      if (d.attended && row.ladder.some((r) => r.action === 'retry_debit')) {
        violations.push(`${label}: attended case resolved to a ladder containing retry_debit`);
      }

      // A terminal case must resolve to doing nothing at all.
      if (d.shouldAbort && row.ladder.length > 0) {
        violations.push(`${label}: terminal case resolved to a non-empty ladder`);
      }

      // No touch may land before the class floor.
      const firstNudge = row.ladder.find((r) => r.action === 'nudge');
      if (firstNudge) {
        const minutes = parseDuration(firstNudge.at) / 60000;
        if (minutes < d.minFirstTouchMinutes) {
          violations.push(
            `${label}: first nudge at ${firstNudge.at} precedes the ${d.minFirstTouchMinutes}m floor`,
          );
        }
      }
    }

    expect(violations.slice(0, 10), `${violations.length} violation(s)`).toEqual([]);
  });
});

describe('the rows that carry the most risk', () => {
  it('every customer-facing row aborts on order_paid', () => {
    for (const row of POLICY_TABLE) {
      if (customerTouchRungs(row).length === 0) continue;
      expect(row.abortOn, row.id).toContain('order_paid');
      expect(row.abortOn, row.id).toContain('customer_optout');
      expect(row.preconditions, row.id).toContain('order_unpaid');
      expect(row.preconditions, row.id).toContain('within_frequency_cap');
    }
  });

  it('only unattended rows contain a debit, and each is fully guarded', () => {
    for (const row of POLICY_TABLE) {
      const debits = row.ladder.filter((r) => r.action === 'retry_debit');
      if (debits.length === 0) continue;

      expect(row.match.attended, row.id).toBe(false);
      expect(row.preconditions, row.id).toContain('mandate_active');
      expect(
        row.ladder.some((r) => r.action === 'send_pre_debit_notice'),
        `${row.id} must give RBI pre-debit notice`,
      ).toBe(true);

      // The notice must actually precede the first debit.
      const firstNotice = row.ladder.findIndex((r) => r.action === 'send_pre_debit_notice');
      const firstDebit = row.ladder.findIndex((r) => r.action === 'retry_debit');
      expect(firstNotice, row.id).toBeLessThan(firstDebit);
    }
  });

  it('no row exceeds its cause class ceiling', () => {
    for (const row of POLICY_TABLE) {
      if (row.catchAll) continue;
      for (const cc of row.match.causeClass ?? []) {
        expect(row.maxMessages, `${row.id} / ${cc}`).toBeLessThanOrEqual(
          CAUSE_CLASS_TRAITS[cc].maxCustomerTouches,
        );
      }
    }
  });

  it('the terminal row does nothing at all', () => {
    const row = policyById('terminal_noop.default');
    expect(row?.ladder).toEqual([]);
    expect(row?.maxMessages).toBe(0);
  });

  it('the risk rows never offer a second card', () => {
    for (const row of POLICY_TABLE) {
      if (!row.match.causeClass?.includes('risk')) continue;
      for (const rung of row.ladder) {
        if (rung.action !== 'nudge') continue;
        expect(rung.suggest ?? [], row.id).not.toContain('other_card');
      }
    }
  });

  it('no merchant-alert row is holdout eligible', () => {
    for (const row of POLICY_TABLE) {
      if (row.ladder.some((r) => r.action === 'merchant_alert')) {
        expect(row.holdoutEligible, row.id).toBe(false);
      }
    }
  });
});

describe('generated.ts drift guard', () => {
  it('matches a fresh compile of the YAML table', () => {
    const current = readFileSync(OUT_FILE, 'utf8');
    const fresh = renderGenerated(readYamlRows());
    expect(
      current === fresh,
      'src/core/policy/generated.ts is stale. Run: npm run policy:build',
    ).toBe(true);
  });
});
