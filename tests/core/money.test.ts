import { describe, expect, it } from 'vitest';
import {
  amountBand,
  addPaise,
  comparePaise,
  formatINR,
  fromRupees,
  MoneyError,
  paise,
  paiseFromUnknown,
  shareOf,
  subPaise,
  sumPaise,
  toRupees,
} from '@core/money.js';

describe('paise construction', () => {
  it('accepts whole paise', () => {
    expect(paise(184300)).toBe(184300);
    expect(paise(0)).toBe(0);
  });

  it('rejects fractional paise — the class of bug that ends credibility', () => {
    expect(() => paise(100.5)).toThrow(MoneyError);
    expect(() => paise(0.1 + 0.2)).toThrow(MoneyError);
  });

  it('rejects non-finite and unsafe values', () => {
    expect(() => paise(Number.NaN)).toThrow(MoneyError);
    expect(() => paise(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
    expect(() => paise(Number.MAX_SAFE_INTEGER + 2)).toThrow(MoneyError);
  });

  it('reads amounts from external systems in any plausible encoding', () => {
    expect(paiseFromUnknown(184300)).toBe(184300);
    expect(paiseFromUnknown('184300')).toBe(184300);
    expect(paiseFromUnknown(' 184300 ')).toBe(184300);
    expect(paiseFromUnknown(184300n)).toBe(184300);
    expect(() => paiseFromUnknown('1843.00')).toThrow(MoneyError);
    expect(() => paiseFromUnknown(null)).toThrow(MoneyError);
  });
});

describe('rupee conversion', () => {
  it('round-trips', () => {
    expect(fromRupees(1843)).toBe(184300);
    expect(toRupees(paise(184300))).toBe(1843);
  });

  it('survives float representation error', () => {
    // 19.99 * 100 is 1998.9999999999998 in IEEE754. Naive truncation loses a paisa.
    expect(fromRupees(19.99)).toBe(1999);
    expect(fromRupees(0.07)).toBe(7);
    // 1.005 * 100 is 100.49999999999999 in IEEE754. A naive Math.round returns
    // 100 and quietly loses a paisa on exactly the half-way value where the
    // rounding rule is supposed to decide.
    expect(fromRupees(1.005)).toBe(101);
    expect(fromRupees(2.675)).toBe(268);
    expect(fromRupees(1234.565)).toBe(123457);
  });

  it('rounds half away from zero for negatives', () => {
    expect(fromRupees(-19.99)).toBe(-1999);
  });
});

describe('arithmetic', () => {
  it('adds, subtracts and sums', () => {
    expect(addPaise(paise(100), paise(250))).toBe(350);
    expect(subPaise(paise(350), paise(100))).toBe(250);
    expect(sumPaise([paise(100), paise(250), paise(1)])).toBe(351);
    expect(sumPaise([])).toBe(0);
  });

  it('compares', () => {
    expect(comparePaise(paise(1), paise(2))).toBe(-1);
    expect(comparePaise(paise(2), paise(2))).toBe(0);
    expect(comparePaise(paise(3), paise(2))).toBe(1);
  });
});

describe('shareOf — commission on recovered revenue', () => {
  it('computes basis points exactly', () => {
    expect(shareOf(paise(184300), 1500)).toBe(27645); // 15%
    expect(shareOf(paise(100), 10000)).toBe(100); // 100%
    expect(shareOf(paise(100), 0)).toBe(0);
  });

  it('always returns whole paise', () => {
    // 15% of 1 paisa is 0.15 paise — must not leak a fraction into the ledger.
    const r = shareOf(paise(1), 1500);
    expect(Number.isInteger(r)).toBe(true);
  });

  it('rejects nonsense rates', () => {
    expect(() => shareOf(paise(100), -1)).toThrow(MoneyError);
    expect(() => shareOf(paise(100), 12.5)).toThrow(MoneyError);
  });
});

describe('formatINR — Indian numbering', () => {
  it('groups in lakhs, not thousands', () => {
    // Rs 1,84,300.00 — NOT Rs 184,300.00
    expect(formatINR(paise(18430000))).toContain('1,84,300');
  });

  it('drops paise for whole rupees when compact', () => {
    expect(formatINR(paise(184300), { compact: true })).toContain('1,843');
    expect(formatINR(paise(184300), { compact: true })).not.toContain('.00');
    expect(formatINR(paise(184350), { compact: true })).toContain('.50');
  });

  it('formats crores correctly', () => {
    expect(formatINR(paise(1000000000), { compact: true })).toContain('1,00,00,000');
  });
});

describe('amountBand', () => {
  it('bands by ticket size', () => {
    expect(amountBand(paise(19900))).toBe('micro'); // Rs 199
    expect(amountBand(paise(184300))).toBe('small'); // Rs 1,843
    expect(amountBand(paise(1500000))).toBe('medium'); // Rs 15,000
    expect(amountBand(paise(10000000))).toBe('large'); // Rs 1,00,000
    expect(amountBand(paise(50000000))).toBe('enterprise'); // Rs 5,00,000
  });

  it('is exhaustive at boundaries', () => {
    expect(amountBand(paise(0))).toBe('micro');
    expect(amountBand(paise(49999))).toBe('micro');
    expect(amountBand(paise(50000))).toBe('small');
  });
});
