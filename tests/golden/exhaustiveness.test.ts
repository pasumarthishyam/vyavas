/**
 * The tests that make Stage 1 *finished* rather than merely written.
 *
 * Each of these fails CI on the day someone adds a code without classifying it,
 * writes a rule that shadows another, or leaves an ambiguous reason with no way
 * to disambiguate it. Without them, this taxonomy degrades within a quarter
 * into "a dozen codes handled properly, everything else gets a generic email".
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_ERROR_REASONS,
  DOCUMENTED_ERROR_REASONS,
  ERROR_REASONS,
  OVERLAPPING_REASONS,
  descriptorFor,
  isKnownReason,
} from '@core/taxonomy/codes.js';
import { CAUSE_CLASSES, CAUSE_CLASS_TRAITS } from '@core/taxonomy/cause-class.js';
import {
  ERROR_SOURCES,
  ERROR_STEPS,
  PAYMENT_METHODS,
  type ErrorTuple,
} from '@core/case/types.js';
import { diagnose, matchingRules } from '@core/taxonomy/diagnose.js';
import { GOLDEN_CASES, makeCtx, makeTuple } from './fixtures.js';

describe('every error code is covered by a golden fixture', () => {
  const covered = new Set(GOLDEN_CASES.map((c) => c.covers));

  it.each(ALL_ERROR_REASONS)('%s has at least one fixture', (reason) => {
    expect(
      covered.has(reason),
      `No golden fixture covers '${reason}'. Add one to tests/golden/fixtures.ts — ` +
        `an unclassified code means a real customer gets a generic message.`,
    ).toBe(true);
  });

  it('has no fixtures for codes that do not exist', () => {
    for (const c of GOLDEN_CASES) {
      expect(isKnownReason(c.covers), `Fixture '${c.name}' covers an unknown reason`).toBe(true);
    }
  });
});

describe('taxonomy integrity', () => {
  it('every reason maps to a real cause class', () => {
    for (const reason of ALL_ERROR_REASONS) {
      expect(CAUSE_CLASSES).toContain(ERROR_REASONS[reason].baseCauseClass);
    }
  });

  it('every descriptor carries a usable plain-language meaning', () => {
    for (const reason of ALL_ERROR_REASONS) {
      const d = ERROR_REASONS[reason];
      expect(d.meaning.length, reason).toBeGreaterThan(15);
      expect(d.reason, reason).toBe(reason);
    }
  });

  it('every documented reason declares which Razorpay list it came from', () => {
    for (const reason of DOCUMENTED_ERROR_REASONS) {
      expect(ERROR_REASONS[reason].lists.length, reason).toBeGreaterThan(0);
    }
  });

  it('records the overlapping reasons that make error_reason unusable as a key', () => {
    // These appear in more than one of Razorpay's lists with different meanings.
    // They are the reason the routing key is a tuple, not a string.
    expect(OVERLAPPING_REASONS).toContain('authentication_failed');
    expect(OVERLAPPING_REASONS).toContain('bank_technical_error');
    expect(OVERLAPPING_REASONS).toContain('payment_failed');
    expect(OVERLAPPING_REASONS).toContain('incorrect_cvv');
  });

  it('every cause class defines complete, self-consistent traits', () => {
    for (const cc of CAUSE_CLASSES) {
      const t = CAUSE_CLASS_TRAITS[cc];
      expect(t.id).toBe(cc);
      expect(t.description.length).toBeGreaterThan(30);
      expect(t.maxCustomerTouches).toBeGreaterThanOrEqual(0);
      expect(t.minFirstTouchMinutes).toBeGreaterThanOrEqual(0);

      // A class that does not contact the customer must not carry rails,
      // touches, or a way of speaking to them.
      if (!t.contactCustomer) {
        expect(t.maxCustomerTouches, cc).toBe(0);
        expect(t.defaultRails, cc).toHaveLength(0);
        expect(t.framing, cc).toBe('none');
      } else {
        expect(t.maxCustomerTouches, cc).toBeGreaterThan(0);
        expect(t.framing, cc).not.toBe('none');
      }

      // A class that forbids re-presenting must not offer it as a default.
      if (!t.sameInstrumentRetry) {
        expect(t.defaultRails, cc).not.toContain('retry_same');
      }
    }
  });

  it('reasons flagged ambiguous actually have a rule that can disambiguate them', () => {
    for (const reason of ALL_ERROR_REASONS) {
      if (!ERROR_REASONS[reason].requiresSourceDisambiguation) continue;
      const hasRule = ERROR_SOURCES.some(
        (source) =>
          matchingRules(makeTuple({ errorReason: reason, errorSource: source })).length > 0,
      );
      expect(
        hasRule,
        `'${reason}' is flagged requiresSourceDisambiguation but no rule in diagnose.ts ` +
          `refines it. Either add a rule or clear the flag.`,
      ).toBe(true);
    }
  });

  it('descriptorFor degrades unknown strings instead of throwing', () => {
    expect(descriptorFor('utterly_made_up').reason).toBe('unknown_reason');
  });
});

describe('rule table has no ambiguity', () => {
  /**
   * Brute-force every reachable tuple. If two rules ever tie at maximum
   * specificity for the same tuple, classification depends on declaration
   * order — which means a harmless-looking reorder would silently change how
   * real customers are treated.
   */
  it('no two rules tie at maximum specificity for any tuple', () => {
    const collisions: string[] = [];

    for (const errorReason of ALL_ERROR_REASONS) {
      for (const errorSource of ERROR_SOURCES) {
        for (const errorStep of ERROR_STEPS) {
          for (const method of PAYMENT_METHODS) {
            const tuple: ErrorTuple = {
              errorCode: null,
              errorSource,
              errorStep,
              errorReason,
              method,
              bank: 'HDFC',
              network: 'VISA',
            };
            const matches = matchingRules(tuple);
            if (matches.length < 2) continue;

            const spec = (r: (typeof matches)[number]) =>
              (r.source ? 1 : 0) + (r.step ? 1 : 0) + (r.method ? 1 : 0);
            const top = Math.max(...matches.map(spec));
            const tied = matches.filter((r) => spec(r) === top);

            if (tied.length > 1) {
              const classes = new Set(tied.map((r) => r.causeClass));
              // A tie is only dangerous when the tied rules disagree.
              if (classes.size > 1) {
                collisions.push(
                  `${errorReason}/${errorSource}/${errorStep}/${method} -> ` +
                    tied.map((r) => `${r.id}(${r.causeClass})`).join(' vs '),
                );
              }
            }
          }
        }
      }
    }

    expect(collisions, `Ambiguous rule matches:\n${collisions.join('\n')}`).toEqual([]);
  });
});

describe('total coverage — every reachable tuple produces a usable diagnosis', () => {
  it('classifies every reason under every source without throwing', () => {
    for (const errorReason of ALL_ERROR_REASONS) {
      for (const errorSource of ERROR_SOURCES) {
        for (const method of PAYMENT_METHODS) {
          const d = diagnose(
            makeTuple({ errorReason, errorSource, method }),
            makeCtx(),
          );
          expect(CAUSE_CLASSES, `${errorReason}/${errorSource}/${method}`).toContain(d.causeClass);
          expect(d.rationale.length).toBeGreaterThan(0);
          expect(d.deadlineAt.getTime()).toBeGreaterThan(makeCtx().now.getTime());

          // The consistency guard, asserted across the entire input space rather
          // than only on hand-written fixtures.
          if (!d.sameInstrumentRetry) expect(d.suggestedRails).not.toContain('retry_same');
          if (!d.contactCustomer) expect(d.suggestedRails).toHaveLength(0);
        }
      }
    }
  });

  it('never contacts a customer about a terminal no-op, under any source or method', () => {
    for (const errorReason of ['order_already_paid', 'duplicate_request', 'duplicate_refund_id'] as const) {
      for (const errorSource of ERROR_SOURCES) {
        const d = diagnose(makeTuple({ errorReason, errorSource }), makeCtx());
        expect(d.shouldAbort, `${errorReason}/${errorSource}`).toBe(true);
        expect(d.contactCustomer).toBe(false);
        expect(d.maxCustomerTouches).toBe(0);
      }
    }
  });
});
