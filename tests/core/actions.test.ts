import { describe, expect, it } from 'vitest';
import {
  type Action,
  ACTION_KINDS,
  idempotencyKey,
  movesMoney,
  touchesCustomer,
} from '@core/actions/types.js';
import {
  CAUSE_CLASSES,
  isMerchantFault,
  isSilent,
  traitsFor,
} from '@core/taxonomy/cause-class.js';
import { isPositive, isZero, maxPaise, minPaise, paise, ZERO_PAISE } from '@core/money.js';

const nudge: Action = {
  kind: 'nudge',
  rung: 1,
  channels: ['whatsapp', 'sms'],
  intent: 'switch_method',
  suggest: ['upi_intent'],
  attachPaymentLink: true,
};

const retryDebit: Action = {
  kind: 'retry_debit',
  rung: 2,
  mandateId: 'mandate_1',
  amount: paise(184300),
};

describe('action classification', () => {
  it('identifies actions that reach a customer', () => {
    expect(touchesCustomer(nudge)).toBe(true);
    expect(
      touchesCustomer({
        kind: 'send_pre_debit_notice',
        rung: 0,
        mandateId: 'm',
        amount: paise(100),
        debitAt: new Date('2026-09-01T00:00:00Z'),
        channels: ['sms'],
      }),
    ).toBe(true);
    expect(touchesCustomer(retryDebit)).toBe(false);
    expect(
      touchesCustomer({ kind: 'close_case', rung: 9, outcome: 'lost', note: 'deadline' }),
    ).toBe(false);
  });

  it('counts a suppressed nudge as touching the customer for frequency accounting', () => {
    // A holdout no_op must still consume nothing but must be *comparable* to a
    // real send, so the two groups are measured on the same basis.
    expect(
      touchesCustomer({ kind: 'no_op', rung: 1, wouldHaveBeen: 'nudge', reason: 'holdout' }),
    ).toBe(true);
    expect(
      touchesCustomer({ kind: 'no_op', rung: 1, wouldHaveBeen: 'retry_debit', reason: 'holdout' }),
    ).toBe(false);
  });

  it('identifies the only action that moves money', () => {
    expect(movesMoney(retryDebit)).toBe(true);
    expect(movesMoney(nudge)).toBe(false);
    // A no_op standing in for a debit must never be treated as moving money.
    expect(
      movesMoney({ kind: 'no_op', rung: 1, wouldHaveBeen: 'retry_debit', reason: 'dry_run' }),
    ).toBe(false);
  });
});

describe('idempotency', () => {
  it('collapses two attempts at the same rung to one key', () => {
    expect(idempotencyKey('case_1', nudge)).toBe(idempotencyKey('case_1', { ...nudge }));
  });

  it('separates rungs, kinds and cases', () => {
    expect(idempotencyKey('case_1', nudge)).not.toBe(
      idempotencyKey('case_1', { ...nudge, rung: 2 }),
    );
    expect(idempotencyKey('case_1', nudge)).not.toBe(idempotencyKey('case_2', nudge));
    expect(idempotencyKey('case_1', nudge)).not.toBe(idempotencyKey('case_1', retryDebit));
  });
});

describe('the action allowlist is closed', () => {
  it('enumerates exactly the kinds the agent may perform', () => {
    // Adding a member here is a deliberate expansion of what the agent may do
    // in the world, and this assertion is where that decision gets noticed.
    expect([...ACTION_KINDS].sort()).toEqual(
      [
        'await_downtime_resolution',
        'close_case',
        'create_payment_link',
        'escalate_to_human',
        'expire_payment_link',
        'merchant_alert',
        'no_op',
        'nudge',
        'retry_debit',
        'send_pre_debit_notice',
      ].sort(),
    );
  });
});

describe('cause class helpers', () => {
  it('returns traits for every class', () => {
    for (const cc of CAUSE_CLASSES) expect(traitsFor(cc).id).toBe(cc);
  });

  it('identifies merchant faults', () => {
    expect(isMerchantFault('merchant_config')).toBe(true);
    expect(isMerchantFault('instrument_dead')).toBe(false);
  });

  it('identifies classes that must never produce a customer message', () => {
    expect(isSilent('terminal_noop')).toBe(true);
    expect(isSilent('customer_input')).toBe(false);
  });
});

describe('money predicates', () => {
  it('tests zero and positive', () => {
    expect(isZero(ZERO_PAISE)).toBe(true);
    expect(isZero(paise(1))).toBe(false);
    expect(isPositive(paise(1))).toBe(true);
    expect(isPositive(ZERO_PAISE)).toBe(false);
    expect(isPositive(paise(-1))).toBe(false);
  });

  it('picks max and min', () => {
    expect(maxPaise(paise(100), paise(250))).toBe(250);
    expect(minPaise(paise(100), paise(250))).toBe(100);
    expect(maxPaise(paise(100), paise(100))).toBe(100);
  });
});
