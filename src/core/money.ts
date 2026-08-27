/**
 * Money.
 *
 * Written before anything else, on purpose. This product charges a percentage
 * of recovered revenue; a rounding bug is not a bug, it is an existential
 * credibility problem.
 *
 * Rules, without exception:
 *   1. All amounts are integer PAISE. Never rupees, never floats.
 *   2. Razorpay already speaks paise (`amount: 184300` is Rs 1,843.00), so we
 *      keep its native unit end to end and only format at the very edge.
 *   3. The `Paise` brand makes `amount + 0.5` a compile error.
 *
 * Note for the persistence layer (Stage 3): the DB column is `bigint`. The
 * repo layer converts at the boundary. In core we use `number`, which is exact
 * for integers up to 2^53 - 1 — about Rs 90,000 crore in a single case. If a
 * single RecoveryCase ever exceeds that, we have better problems.
 */

declare const PAISE_BRAND: unique symbol;

/** An integer number of paise. Construct only via the helpers below. */
export type Paise = number & { readonly [PAISE_BRAND]: true };

export const ZERO_PAISE = 0 as Paise;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Construct Paise from an integer count of paise. Throws on non-integers. */
export function paise(value: number): Paise {
  if (!Number.isFinite(value)) {
    throw new MoneyError(`Amount must be finite, received ${String(value)}`);
  }
  if (!Number.isInteger(value)) {
    throw new MoneyError(
      `Amount must be a whole number of paise, received ${value}. ` +
        `Rupee values must be converted with fromRupees().`,
    );
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`Amount ${value} exceeds safe integer range`);
  }
  return value as Paise;
}

/** Parse an amount that arrived from an external system (may be a string). */
export function paiseFromUnknown(value: unknown): Paise {
  if (typeof value === 'number') return paise(value);
  if (typeof value === 'bigint') return paise(Number(value));
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return paise(Number(value.trim()));
  }
  throw new MoneyError(`Cannot read a paise amount from ${JSON.stringify(value)}`);
}

/**
 * Rupees -> Paise. Rounds half away from zero at 2dp.
 *
 * The `toFixed(4)` step is not decoration. `1.005 * 100` is 100.49999999999999
 * in IEEE754, so a naive `Math.round` silently loses a paisa on exactly the
 * half-way values where rounding is supposed to be decided. Normalising the
 * product to four decimals first collapses that representation error before the
 * rounding decision is made.
 */
export function fromRupees(rupees: number): Paise {
  if (!Number.isFinite(rupees)) {
    throw new MoneyError(`Rupee amount must be finite, received ${String(rupees)}`);
  }
  const magnitude = Math.abs(rupees) * 100;
  const settled = Number(magnitude.toFixed(4));
  const rounded = Math.round(settled);
  return paise(rupees < 0 ? -rounded : rounded);
}

/** Paise -> rupees as a number. For display and analytics only, never for math. */
export function toRupees(amount: Paise): number {
  return amount / 100;
}

export function addPaise(a: Paise, b: Paise): Paise {
  return paise(a + b);
}

export function subPaise(a: Paise, b: Paise): Paise {
  return paise(a - b);
}

export function sumPaise(amounts: readonly Paise[]): Paise {
  let total = 0;
  for (const a of amounts) total += a;
  return paise(total);
}

/**
 * Take a share of an amount, expressed in basis points (1 bp = 0.01%).
 * Rounds half up. This is how commission on recovered revenue is computed,
 * so it is deliberately explicit rather than a float multiply.
 *
 *   shareOf(paise(184300), 1500) -> 27645  (15% of Rs 1,843.00)
 */
export function shareOf(amount: Paise, basisPoints: number): Paise {
  if (!Number.isInteger(basisPoints) || basisPoints < 0) {
    throw new MoneyError(`basisPoints must be a non-negative integer, got ${basisPoints}`);
  }
  const product = amount * basisPoints;
  const rounded = Math.round(product / 10_000);
  return paise(rounded);
}

export function isZero(amount: Paise): boolean {
  return amount === 0;
}

export function isPositive(amount: Paise): boolean {
  return amount > 0;
}

/** -1 | 0 | 1 */
export function comparePaise(a: Paise, b: Paise): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function maxPaise(a: Paise, b: Paise): Paise {
  return a >= b ? a : b;
}

export function minPaise(a: Paise, b: Paise): Paise {
  return a <= b ? a : b;
}

/**
 * Format for display using the Indian numbering system (lakh/crore grouping):
 *   formatINR(paise(18430000)) -> "Rs 1,84,300.00"
 *
 * `compact: true` drops the paise when the amount is whole rupees, which is
 * what merchant-facing dashboards and customer messages want.
 */
export function formatINR(
  amount: Paise,
  opts: { compact?: boolean; symbol?: boolean } = {},
): string {
  const { compact = false, symbol = true } = opts;
  const rupees = toRupees(amount);
  const wholeRupees = amount % 100 === 0;
  const fractionDigits = compact && wholeRupees ? 0 : 2;

  const formatted = new Intl.NumberFormat('en-IN', {
    style: symbol ? 'currency' : 'decimal',
    currency: 'INR',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(rupees);

  return formatted;
}

/**
 * Amount bands.
 *
 * Recovery behaviour is genuinely different by ticket size — a Rs 199 order
 * does not justify a WhatsApp + SMS + email ladder, and a Rs 2,00,000 B2B
 * invoice deserves a human. Bands are a first-class policy match dimension,
 * so they live here rather than being re-derived per call site.
 */
export const AMOUNT_BANDS = ['micro', 'small', 'medium', 'large', 'enterprise'] as const;
export type AmountBand = (typeof AMOUNT_BANDS)[number];

const BAND_CEILINGS: ReadonlyArray<readonly [AmountBand, number]> = [
  ['micro', 50_000], // < Rs 500
  ['small', 500_000], // < Rs 5,000
  ['medium', 2_500_000], // < Rs 25,000
  ['large', 20_000_000], // < Rs 2,00,000
];

export function amountBand(amount: Paise): AmountBand {
  for (const [band, ceiling] of BAND_CEILINGS) {
    if (amount < ceiling) return band;
  }
  return 'enterprise';
}
