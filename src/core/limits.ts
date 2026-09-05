/**
 * Hard bounds on the per-merchant dials.
 *
 * ── why this file exists ──
 *
 * The dials in `merchants` are operational: an operator can change the
 * frequency cap or the daily budget from a SQL prompt, instantly, with no
 * review and no deploy. That flexibility is the point — a sandbox account and a
 * live one legitimately want different numbers, and an incident at 3am should
 * not need a release.
 *
 * What it cost: `frequency_cap_per_day` is a `smallint`, so it accepted 1000.
 * It was set to 1000 during testing, which turned the per-customer 24h cap off
 * entirely, and it then sat that way in production for weeks. Nothing in the
 * repository mentioned it, no screen showed it, and no test could have caught
 * it — the value was correct as far as every layer of the code was concerned.
 *
 * So the rule these bounds encode is:
 *
 *   **A database dial may make a limit stricter than the code's default. It may
 *   loosen one only as far as the code says is still defensible.**
 *
 * The bounds are deliberately generous — they are not the recommended values,
 * they are the edge of the range where an operator no longer gets to decide
 * alone. Wanting to go past one is a legitimate thing to want; it just has to
 * be a code change with a diff and a reviewer, not an UPDATE statement.
 *
 * Pure, and applied at every point where a dial is read for a decision, not at
 * write time. Clamping on write would leave existing out-of-range rows live and
 * would silently rewrite an operator's value; clamping on read means the stored
 * number stays visible for what it is and the behaviour is safe regardless.
 */

export interface DialBound {
  readonly min: number;
  readonly max: number;
  /** Used when the stored value is null, NaN or otherwise unusable. */
  readonly fallback: number;
  /** Shown to an operator when a stored value is out of range. */
  readonly label: string;
}

export const DIAL_BOUNDS = {
  /**
   * Messages to ONE person in a rolling 24h, across every case and agent.
   *
   * Max 10 rather than 3 or 4: a merchant running several agents for a customer
   * with genuinely separate problems can justify more than the default, and the
   * class ceilings (max 4) plus the cool-off floor already bound any single
   * ladder. Ten is where "this person is hearing from us a lot" becomes "this
   * person is being harassed", and that judgement should not be one UPDATE away.
   */
  frequencyCapPerDay: { min: 1, max: 10, fallback: 3, label: 'frequency cap per day' },

  /**
   * The floor between two messages to one person, in minutes.
   *
   * Min 0, deliberately. Zero is what allowed two messages ninety seconds apart
   * during testing, so a floor of 5 was the obvious guard — and it was wrong.
   * Zero is a value someone chooses on purpose: a sandbox account demonstrating
   * the whole ladder in two minutes needs it, and so does any test that
   * exercises two rungs back to back. Refusing it would not have prevented the
   * testing configuration, it would only have moved the workaround somewhere
   * less visible.
   *
   * What protects a real customer here is the DEFAULT of 15 plus the daily cap,
   * not a prohibition on a setting with a legitimate use. Max 12h, because past
   * that the cool-off is doing the frequency cap's job and should be expressed
   * as the cap instead.
   */
  minGapMinutes: { min: 0, max: 720, fallback: 15, label: 'minimum gap between messages' },

  /** Everything this merchant sends to everyone, per merchant-local day. */
  dailyMessageBudget: { min: 1, max: 5000, fallback: 1000, label: 'daily message budget' },

  /** How long a payment attempt is treated as still in flight. */
  liveAttemptLockMinutes: { min: 0, max: 120, fallback: 3, label: 'live attempt lock' },

  /**
   * How long after a failure the customer counts as still at the checkout.
   *
   * Bounded at 4h because this is what buys an exemption from quiet hours for a
   * WhatsApp message. A wide window here is a licence to ring a phone at 3am,
   * which is the one thing quiet hours exist to prevent.
   */
  liveCustomerWindowMinutes: { min: 0, max: 240, fallback: 15, label: 'live customer window' },
} as const satisfies Record<string, DialBound>;

export type DialName = keyof typeof DIAL_BOUNDS;

/**
 * One dial, clamped into its permitted range.
 *
 * A value outside the range is not an error — it is an older row, or a
 * deliberate operator choice that has since gone out of bounds. It is brought
 * back to the edge rather than replaced by the default, so "1000" becomes 10
 * (still the loosest permitted setting, which is plainly what was intended)
 * rather than snapping to 3 and surprising someone mid-incident.
 */
export function clampDial(name: DialName, value: number | null | undefined): number {
  const bound = DIAL_BOUNDS[name];
  if (value == null || !Number.isFinite(value)) return bound.fallback;
  return Math.min(bound.max, Math.max(bound.min, Math.trunc(value)));
}

/** True when the stored value is not the value that will actually be used. */
export function isDialOutOfBounds(name: DialName, value: number | null | undefined): boolean {
  return clampDial(name, value) !== value;
}

/** The raw shape read off a `merchants` row. */
export interface MerchantDials {
  frequencyCapPerDay: number;
  minGapMinutes: number;
  dailyMessageBudget: number;
  liveAttemptLockMinutes: number;
  liveCustomerWindowMinutes: number;
}

/**
 * Every dial clamped at once.
 *
 * Call this wherever a merchant row is about to inform a send decision. There
 * is deliberately no variant that reads the columns directly — a caller that
 * wanted one would be one refactor away from restoring the hole this closes.
 */
export function effectiveDials(m: MerchantDials): MerchantDials {
  return {
    frequencyCapPerDay: clampDial('frequencyCapPerDay', m.frequencyCapPerDay),
    minGapMinutes: clampDial('minGapMinutes', m.minGapMinutes),
    dailyMessageBudget: clampDial('dailyMessageBudget', m.dailyMessageBudget),
    liveAttemptLockMinutes: clampDial('liveAttemptLockMinutes', m.liveAttemptLockMinutes),
    liveCustomerWindowMinutes: clampDial('liveCustomerWindowMinutes', m.liveCustomerWindowMinutes),
  };
}
