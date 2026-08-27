import { describe, expect, it } from 'vitest';
import { POLICY_TABLE } from '@core/policy/index.js';
import {
  type PolicyMatchInput,
  PolicyResolutionError,
  customerTouchRungs,
  effectiveRails,
  matchInputFrom,
  matchesPolicy,
  resolvePolicy,
} from '@core/policy/resolve.js';
import { specificityOf } from '@core/policy/specificity.js';
import { compilePolicyTable } from '@core/policy/compile.js';
import { diagnose } from '@core/taxonomy/diagnose.js';
import { paise } from '@core/money.js';
import { makeCtx, makeTuple } from '../golden/fixtures.js';

function input(over: Partial<PolicyMatchInput> = {}): PolicyMatchInput {
  return {
    errorReason: 'card_expired',
    errorSource: 'customer',
    errorStep: 'payment_authorization',
    method: 'card',
    bank: 'HDFC',
    causeClass: 'instrument_dead',
    caseType: 'payment_failure',
    amountBand: 'small',
    attended: true,
    ...over,
  };
}

describe('matchesPolicy', () => {
  it('an empty match matches everything', () => {
    expect(matchesPolicy({}, input())).toBe(true);
  });

  it('matches on each dimension', () => {
    expect(matchesPolicy({ errorReason: 'card_expired' }, input())).toBe(true);
    expect(matchesPolicy({ errorReason: 'incorrect_cvv' }, input())).toBe(false);
    expect(matchesPolicy({ method: ['card', 'upi'] }, input())).toBe(true);
    expect(matchesPolicy({ method: ['upi'] }, input())).toBe(false);
    expect(matchesPolicy({ attended: true }, input())).toBe(true);
    expect(matchesPolicy({ attended: false }, input())).toBe(false);
  });

  it('a constrained dimension never matches a null value', () => {
    // A row naming specific banks must not match a case with no bank at all.
    expect(matchesPolicy({ bank: ['HDFC'] }, input({ bank: null }))).toBe(false);
    expect(matchesPolicy({}, input({ bank: null }))).toBe(true);
  });

  it('requires every constrained dimension to match', () => {
    expect(
      matchesPolicy({ errorReason: 'card_expired', method: ['upi'] }, input()),
    ).toBe(false);
  });
});

describe('specificity ordering', () => {
  it('a named errorReason outranks every other dimension combined', () => {
    const reasonOnly = specificityOf({ errorReason: 'card_expired' });
    const everythingElse = specificityOf({
      errorSource: ['customer'],
      errorStep: ['payment_authorization'],
      method: ['card'],
      bank: ['HDFC'],
      causeClass: ['instrument_dead'],
      caseType: ['payment_failure'],
      amountBand: ['small'],
      attended: true,
    });
    expect(reasonOnly).toBeGreaterThan(everythingElse);
  });

  it('adding a constraint always increases specificity', () => {
    expect(specificityOf({ causeClass: ['risk'], method: ['card'] })).toBeGreaterThan(
      specificityOf({ causeClass: ['risk'] }),
    );
  });
});

describe('resolvePolicy against the real table', () => {
  it('picks the reason-specific row over the class row', () => {
    const r = resolvePolicy(POLICY_TABLE, input());
    expect(r.row.id).toBe('instrument_dead.card_expired');
    expect(r.candidates.length).toBeGreaterThan(1);
    expect(r.candidates[0]?.id).toBe('instrument_dead.card_expired');
  });

  it('falls back to the class row when no reason-specific row exists', () => {
    const r = resolvePolicy(
      POLICY_TABLE,
      input({ errorReason: 'debit_instrument_blocked' }),
    );
    expect(r.row.id).toBe('instrument_dead.default');
  });

  it('routes an unattended case to the mandate ladder, not the attended one', () => {
    const attended = resolvePolicy(
      POLICY_TABLE,
      input({ errorReason: 'insufficient_funds', causeClass: 'funds_limits', attended: true }),
    );
    const unattended = resolvePolicy(
      POLICY_TABLE,
      input({ errorReason: 'insufficient_funds', causeClass: 'funds_limits', attended: false }),
    );
    expect(attended.row.id).toBe('funds_limits.insufficient_funds');
    expect(unattended.row.id).toBe('unattended.mandate_retry');
    expect(unattended.row.ladder.some((r) => r.action === 'retry_debit')).toBe(true);
    expect(attended.row.ladder.some((r) => r.action === 'retry_debit')).toBe(false);
  });

  it('gives a terminal case an empty ladder', () => {
    const r = resolvePolicy(
      POLICY_TABLE,
      input({ errorReason: 'order_already_paid', causeClass: 'terminal_noop' }),
    );
    expect(r.row.ladder).toHaveLength(0);
    expect(r.row.maxMessages).toBe(0);
    expect(customerTouchRungs(r.row)).toHaveLength(0);
  });

  it('caps a risk case at one touch', () => {
    const r = resolvePolicy(POLICY_TABLE, input({ causeClass: 'risk', errorReason: 'card_declined' }));
    expect(r.row.maxMessages).toBe(1);
    expect(customerTouchRungs(r.row)).toHaveLength(1);
  });

  it('is deterministic', () => {
    const a = resolvePolicy(POLICY_TABLE, input());
    const b = resolvePolicy(POLICY_TABLE, input());
    expect(a.row.id).toBe(b.row.id);
  });
});

describe('the catch-all', () => {
  it('wins only when nothing else matches', () => {
    // A table of just the catch-all: it must still resolve rather than throw.
    const table = compilePolicyTable([
      ...['transient_infra', 'instrument_dead', 'customer_input', 'auth_friction', 'funds_limits',
        'risk', 'merchant_config', 'terminal_noop', 'intent_exit'].map((cc) => ({
        id: `${cc}.row`,
        version: 1,
        description: `Ladder for ${cc}.`,
        match: { causeClass: [cc] },
        ladder: [],
        maxMessages: 0,
      })),
      {
        id: 'catchall',
        version: 1,
        description: 'Last-resort row that reaches nobody.',
        match: {},
        ladder: [],
        maxMessages: 0,
        catchAll: true,
      },
    ]);
    const r = resolvePolicy(table, input());
    expect(r.row.id).toBe('instrument_dead.row');
    expect(r.specificity).toBeGreaterThan(-1);
  });

  it('never wins against a real row in the shipped table', () => {
    const r = resolvePolicy(POLICY_TABLE, input());
    expect(r.row.catchAll).toBe(false);
  });

  it('throws loudly on a table built without compilePolicyTable', () => {
    // Unreachable through the supported path — POLICY_TABLE is compiled and a
    // compiled table always has a catch-all. Pinned so the failure mode stays a
    // loud throw rather than a silently dropped case.
    expect(() => resolvePolicy([], input())).toThrow(PolicyResolutionError);
    expect(() => resolvePolicy([], input())).toThrow(/catch-all/);
  });
});

describe('matchInputFrom', () => {
  it('takes the cause class from the DIAGNOSIS, not the raw tuple', () => {
    // A card_declined during a confirmed HDFC outage has been reclassified to
    // transient_infra. The ladder must follow the reclassification, not the
    // way the failure originally looked.
    const tuple = makeTuple({
      errorReason: 'card_declined',
      errorSource: 'issuer',
      errorStep: 'payment_authorization',
      bank: 'HDFC',
    });
    const ctx = makeCtx({
      activeDowntime: [
        {
          method: 'card',
          bank: 'HDFC',
          network: null,
          severity: 'high',
          startedAt: new Date('2026-08-27T13:30:00Z'),
        },
      ],
    });
    const d = diagnose(tuple, ctx);
    const mi = matchInputFrom(tuple, d, paise(184300));

    expect(d.causeClass).toBe('transient_infra');
    expect(mi.causeClass).toBe('transient_infra');

    const r = resolvePolicy(POLICY_TABLE, mi);
    expect(r.row.id).toBe('transient_infra.default');
  });

  it('carries the re-typed case type for a deliberate exit', () => {
    const tuple = makeTuple({ errorReason: 'payment_cancelled', errorSource: 'customer' });
    const d = diagnose(tuple, makeCtx({ caseType: 'payment_failure' }));
    const mi = matchInputFrom(tuple, d, paise(184300));

    expect(mi.caseType).toBe('intent_exit');
    expect(resolvePolicy(POLICY_TABLE, mi).row.id).toBe('intent_exit.payment_cancelled');
  });

  it('derives the amount band', () => {
    const tuple = makeTuple({ errorReason: 'card_expired' });
    const d = diagnose(tuple, makeCtx());
    expect(matchInputFrom(tuple, d, paise(19900)).amountBand).toBe('micro');
    expect(matchInputFrom(tuple, d, paise(50000000)).amountBand).toBe('enterprise');
  });
});

describe('effectiveRails — live context overrides the static table', () => {
  const otpTuple = makeTuple({
    errorReason: 'incorrect_otp',
    errorSource: 'customer',
    method: 'card',
  });

  it('honours the rung suggestion on a first failure', () => {
    const d = diagnose(otpTuple, makeCtx());
    const row = resolvePolicy(POLICY_TABLE, matchInputFrom(otpTuple, d, paise(184300))).row;
    const firstNudge = row.ladder.find((r) => r.action === 'nudge');
    const rails = effectiveRails(
      firstNudge?.action === 'nudge' ? firstNudge.suggest : undefined,
      d,
    );
    expect(rails).toContain('retry_same');
  });

  it('strips retry_same once the diagnosis has withdrawn it', () => {
    // Two prior wrong OTPs. A third attempt commonly locks the card at the
    // issuer, so the policy table's static suggestion must be overruled.
    const d = diagnose(
      otpTuple,
      makeCtx({
        priorAttempts: [
          { at: new Date('2026-08-27T14:00:00Z'), method: 'card', errorReason: 'incorrect_otp' },
          { at: new Date('2026-08-27T14:05:00Z'), method: 'card', errorReason: 'incorrect_otp' },
        ],
      }),
    );
    expect(d.sameInstrumentRetry).toBe(false);

    const row = resolvePolicy(POLICY_TABLE, matchInputFrom(otpTuple, d, paise(184300))).row;
    const firstNudge = row.ladder.find((r) => r.action === 'nudge');
    const staticSuggest = firstNudge?.action === 'nudge' ? firstNudge.suggest : undefined;

    expect(staticSuggest).toContain('retry_same'); // the table still says so
    expect(effectiveRails(staticSuggest, d)).not.toContain('retry_same'); // the diagnosis wins
  });

  it('inherits the diagnosis rails when a rung omits suggest', () => {
    const vpaTuple = makeTuple({
      errorReason: 'invalid_vpa',
      errorSource: 'bank',
      method: 'upi',
      bank: null,
      network: null,
    });
    const d = diagnose(vpaTuple, makeCtx());
    const rails = effectiveRails(undefined, d);
    expect(rails).toEqual(d.suggestedRails);
    // A dead handle is never answered with UPI of either kind.
    expect(rails).not.toContain('upi_intent');
    expect(rails).not.toContain('upi_collect');
  });

  it('can only ever remove rails, never add them', () => {
    const d = diagnose(otpTuple, makeCtx());
    const rails = effectiveRails(['retry_same', 'upi_intent'], d);
    expect(rails.length).toBeLessThanOrEqual(2);
    for (const r of rails) expect(['retry_same', 'upi_intent']).toContain(r);
  });
});
