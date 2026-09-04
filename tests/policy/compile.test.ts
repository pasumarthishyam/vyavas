/**
 * Proving the integrity checks actually fire.
 *
 * A validation layer nobody has watched reject anything is a validation layer
 * you do not have. Each test here constructs a table that violates exactly one
 * rule and asserts the compiler refuses it — because every one of these is a
 * plausible YAML edit that would otherwise reach a real customer.
 */

import { describe, expect, it } from 'vitest';
import { PolicyCompileError, compilePolicyTable } from '@core/policy/compile.js';
import { CAUSE_CLASSES } from '@core/taxonomy/cause-class.js';

/** A minimal valid table: one row per cause class, plus a catch-all. */
function baseTable(): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = CAUSE_CLASSES.map((cc) => ({
    id: `${cc}.row`,
    version: 1,
    description: `Ladder for the ${cc} class.`,
    match: { causeClass: [cc] },
    ladder: [],
    preconditions: [],
    abortOn: [],
    maxMessages: 0,
    holdoutEligible: true,
  }));

  rows.push({
    id: 'catchall',
    version: 1,
    description: 'Last-resort row that reaches nobody.',
    match: {},
    ladder: [],
    preconditions: [],
    abortOn: [],
    maxMessages: 0,
    holdoutEligible: false,
    catchAll: true,
  });

  return rows;
}

/** A well-formed customer-facing ladder, for mutating in individual tests. */
function nudgeRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'test.row',
    version: 1,
    description: 'A customer-facing ladder used to exercise one check at a time.',
    // Names an errorReason so it out-ranks the class-level row in baseTable()
    // instead of tying with it — a tie is itself a compile error, as the
    // ambiguity test below shows.
    match: { errorReason: 'card_expired', causeClass: ['instrument_dead'], attended: true },
    ladder: [
      { at: '5m', action: 'nudge', channels: ['whatsapp'], intent: 'switch_method' },
      { at: '8h', action: 'nudge', channels: ['whatsapp'], intent: 'reminder' },
    ],
    preconditions: ['order_unpaid', 'within_frequency_cap'],
    abortOn: ['order_paid', 'customer_optout'],
    maxMessages: 2,
    holdoutEligible: true,
    ...over,
  };
}

function expectIssue(rows: unknown[], fragment: string): void {
  try {
    compilePolicyTable(rows);
    throw new Error(`Expected compilation to fail with an issue matching: ${fragment}`);
  } catch (e) {
    if (!(e instanceof PolicyCompileError)) throw e;
    const messages = e.issues.map((i) => i.message).join('\n');
    expect(messages, `Issues raised:\n${messages}`).toContain(fragment);
  }
}

describe('the base table is valid', () => {
  it('compiles', () => {
    expect(compilePolicyTable(baseTable())).toHaveLength(CAUSE_CLASSES.length + 1);
  });

  it('compiles with a well-formed nudge row added', () => {
    expect(() => compilePolicyTable([...baseTable(), nudgeRow()])).not.toThrow();
  });
});

describe('schema violations', () => {
  it('rejects an unknown field rather than silently ignoring it', () => {
    // A typo'd key in YAML must not pass as "no constraint".
    expectIssue([...baseTable(), nudgeRow({ match: { casueClass: ['risk'] } })], 'Unrecognized');
  });

  it('rejects an unreadable duration', () => {
    expect(() =>
      compilePolicyTable([
        ...baseTable(),
        nudgeRow({
          ladder: [{ at: 'soon', action: 'nudge', channels: ['whatsapp'], intent: 'reminder' }],
        }),
      ]),
    ).toThrow(PolicyCompileError);
  });

  it('rejects an id that is not dot-separated lowercase', () => {
    expectIssue([...baseTable(), nudgeRow({ id: 'Card Expired!' })], 'dot-separated lowercase');
  });
});

describe('table-level integrity', () => {
  it('refuses a table with no catch-all — an unmatched case is money lost silently', () => {
    expectIssue(baseTable().filter((r) => r.catchAll !== true), 'no catch-all row');
  });

  it('refuses two catch-alls', () => {
    const rows = baseTable();
    rows.push({ ...rows[rows.length - 1], id: 'catchall2' });
    expectIssue(rows, 'more than one catch-all');
  });

  it('refuses duplicate ids', () => {
    expectIssue([...baseTable(), nudgeRow(), nudgeRow()], "duplicate policy id 'test.row'");
  });

  it('refuses a table where any cause class has no ladder', () => {
    expectIssue(
      baseTable().filter((r) => r.id !== 'risk.row'),
      "cause class 'risk' has no policy row",
    );
  });

  it('refuses two equally specific rows that overlap and behave differently', () => {
    const a = nudgeRow({ id: 'a.row', match: { causeClass: ['instrument_dead', 'risk'] } });
    const b = nudgeRow({
      id: 'b.row',
      match: { causeClass: ['instrument_dead'] },
      maxMessages: 1,
      ladder: [{ at: '5m', action: 'nudge', channels: ['email'], intent: 'reminder' }],
    });
    expectIssue([...baseTable(), a, b], 'would depend on declaration');
  });
});

describe('ladder integrity', () => {
  it('refuses rungs that are not strictly increasing', () => {
    expectIssue(
      [
        ...baseTable(),
        nudgeRow({
          ladder: [
            { at: '8h', action: 'nudge', channels: ['whatsapp'], intent: 'switch_method' },
            { at: '5m', action: 'nudge', channels: ['whatsapp'], intent: 'reminder' },
          ],
        }),
      ],
      'strictly increasing',
    );
  });

  it('refuses a ladder with more touches than its own cap allows', () => {
    expectIssue([...baseTable(), nudgeRow({ maxMessages: 1 })], 'can never fire');
  });
});

describe('the safety ceiling — a policy may tighten a limit, never loosen one', () => {
  it('refuses maxMessages above the cause class ceiling', () => {
    // risk allows exactly one customer touch, ever.
    expectIssue(
      [
        ...baseTable(),
        nudgeRow({
          match: { causeClass: ['risk'] },
          maxMessages: 3,
          ladder: [
            { at: '15m', action: 'nudge', channels: ['whatsapp'], intent: 'switch_method' },
            { at: '6h', action: 'nudge', channels: ['whatsapp'], intent: 'reminder' },
            { at: '26h', action: 'nudge', channels: ['email'], intent: 'final_reminder' },
          ],
        }),
      ],
      'never loosen one',
    );
  });

  it('refuses a first nudge earlier than the class floor', () => {
    // funds_limits will not be messaged inside three hours.
    expectIssue(
      [
        ...baseTable(),
        nudgeRow({
          match: { causeClass: ['funds_limits'] },
          ladder: [{ at: '5m', action: 'nudge', channels: ['whatsapp'], intent: 'switch_method' }],
          maxMessages: 1,
        }),
      ],
      'is earlier than the',
    );
  });

  it('refuses any customer message on a class that must stay silent', () => {
    expectIssue(
      [
        ...baseTable(),
        nudgeRow({
          match: { causeClass: ['terminal_noop'] },
          ladder: [{ at: '0m', action: 'nudge', channels: ['whatsapp'], intent: 'reminder' }],
          maxMessages: 1,
        }),
      ],
      'must never produce a customer message',
    );
  });

  it('refuses retry_same on a class that forbids re-presenting the instrument', () => {
    expectIssue(
      [
        ...baseTable(),
        nudgeRow({
          ladder: [
            {
              at: '5m',
              action: 'nudge',
              channels: ['whatsapp'],
              intent: 'switch_method',
              suggest: ['retry_same'],
            },
          ],
          maxMessages: 1,
        }),
      ],
      "forbids re-presenting the instrument",
    );
  });

  it('refuses a customer-facing row that does not declare its cause class', () => {
    expectIssue([...baseTable(), nudgeRow({ match: {} })], 'constrains no causeClass');
  });

  it('refuses a catch-all that contacts a customer', () => {
    const rows = baseTable().filter((r) => r.catchAll !== true);
    rows.push(nudgeRow({ id: 'catchall', catchAll: true, match: {} }));
    expectIssue(rows, 'must never contact a customer');
  });
});

describe('attended vs unattended — the compliance boundary', () => {
  const unattendedLadder = [
    { at: '0m', action: 'send_pre_debit_notice', channels: ['whatsapp'], leadTime: '24h' },
    { at: '25h', action: 'retry_debit' },
  ];

  it('accepts a correctly guarded unattended row', () => {
    expect(() =>
      compilePolicyTable([
        ...baseTable(),
        nudgeRow({
          id: 'unattended.ok',
          match: { causeClass: ['funds_limits'], attended: false },
          ladder: unattendedLadder,
          preconditions: ['order_unpaid', 'within_frequency_cap', 'mandate_active'],
          maxMessages: 1,
        }),
      ]),
    ).not.toThrow();
  });

  it('refuses any customer-facing row that does not declare which side it is on', () => {
    // Without this, a reason-specific attended row (specificity ~107) silently
    // out-ranks the mandate ladder (~7), and an unattended subscription failure
    // gets treated as if a human were standing at the checkout.
    expectIssue(
      [
        ...baseTable(),
        nudgeRow({ match: { errorReason: 'card_expired', causeClass: ['instrument_dead'] } }),
      ],
      "does not declare 'attended'",
    );
  });

  it('refuses a debit re-presentment on a row that can match an attended case', () => {
    expectIssue(
      [
        ...baseTable(),
        nudgeRow({
          id: 'unattended.bad',
          match: { causeClass: ['funds_limits'] },
          ladder: unattendedLadder,
          preconditions: ['order_unpaid', 'within_frequency_cap', 'mandate_active'],
          maxMessages: 1,
        }),
      ],
      "does not constrain 'attended: false'",
    );
  });

  it('refuses a debit without the RBI pre-debit notice', () => {
    expectIssue(
      [
        ...baseTable(),
        nudgeRow({
          id: 'unattended.nonotice',
          match: { causeClass: ['funds_limits'], attended: false },
          ladder: [{ at: '0m', action: 'retry_debit' }],
          preconditions: ['order_unpaid', 'mandate_active'],
          maxMessages: 0,
        }),
      ],
      'RBI requires notice',
    );
  });

  it('refuses a debit that does not re-check the mandate is still active', () => {
    expectIssue(
      [
        ...baseTable(),
        nudgeRow({
          id: 'unattended.nomandate',
          match: { causeClass: ['funds_limits'], attended: false },
          ladder: unattendedLadder,
          preconditions: ['order_unpaid', 'within_frequency_cap'],
          maxMessages: 1,
        }),
      ],
      "'mandate_active' precondition",
    );
  });

  it('refuses a debit on a class whose instrument is unusable', () => {
    expectIssue(
      [
        ...baseTable(),
        nudgeRow({
          id: 'unattended.dead',
          match: { causeClass: ['instrument_dead'], attended: false },
          ladder: unattendedLadder,
          preconditions: ['order_unpaid', 'within_frequency_cap', 'mandate_active'],
          maxMessages: 1,
        }),
      ],
      'forbids re-presenting the instrument',
    );
  });
});

describe('the kill switch', () => {
  it('refuses a customer-facing ladder that does not abort on order_paid', () => {
    expectIssue(
      [...baseTable(), nudgeRow({ abortOn: ['customer_optout'] })],
      "does not abort on 'order_paid'",
    );
  });

  it('refuses one that does not abort on customer opt-out', () => {
    expectIssue([...baseTable(), nudgeRow({ abortOn: ['order_paid'] })], "'customer_optout'");
  });

  it('refuses one that does not re-check order_unpaid before each rung', () => {
    expectIssue(
      [...baseTable(), nudgeRow({ preconditions: ['within_frequency_cap'] })],
      "does not re-check 'order_unpaid'",
    );
  });

  it('refuses one that does not enforce the frequency cap', () => {
    expectIssue(
      [...baseTable(), nudgeRow({ preconditions: ['order_unpaid'] })],
      "'within_frequency_cap'",
    );
  });
});

describe('holdout discipline', () => {
  it('refuses to hold out a row that carries a merchant breakage alert', () => {
    expectIssue(
      [
        ...baseTable(),
        nudgeRow({
          match: { causeClass: ['merchant_config'] },
          ladder: [{ at: '0m', action: 'merchant_alert', severity: 'critical' }],
          maxMessages: 0,
          holdoutEligible: true,
        }),
      ],
      'holdoutEligible: false',
    );
  });
});

describe('normalisation and immutability', () => {
  it('uppercases bank codes so they match the normalised tuple', () => {
    const [row] = compilePolicyTable([
      ...baseTable(),
      nudgeRow({
        match: { causeClass: ['instrument_dead'], bank: ['hdfc', 'icic'], attended: true },
      }),
    ]).filter((r) => r.id === 'test.row');
    expect(row?.match.bank).toEqual(['HDFC', 'ICIC']);
  });

  it('freezes the compiled table so a caller cannot mutate policy at runtime', () => {
    const table = compilePolicyTable(baseTable());
    expect(Object.isFrozen(table)).toBe(true);
    expect(Object.isFrozen(table[0])).toBe(true);
    expect(Object.isFrozen(table[0]?.match)).toBe(true);
  });
});
