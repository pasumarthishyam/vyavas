import { describe, expect, it } from 'vitest';
import { assignCohort, cohortBucket, hash32, isHoldoutEligible, BUCKET_COUNT } from '@core/cohort.js';

const base = { merchantId: 'm_1', holdoutEnabled: true, eligible: true };

describe('determinism', () => {
  it('gives the same case the same bucket every time', () => {
    const a = cohortBucket('m_1', 'case_abc');
    const b = cohortBucket('m_1', 'case_abc');
    expect(a).toBe(b);
  });

  it('hashes to a stable 32-bit value', () => {
    expect(hash32('m_1:case_abc')).toBe(hash32('m_1:case_abc'));
    expect(hash32('a')).not.toBe(hash32('b'));
    expect(hash32('')).toBeGreaterThanOrEqual(0);
  });

  it('separates merchants — the same case id in two accounts is independent', () => {
    expect(cohortBucket('m_1', 'case_1')).not.toBe(cohortBucket('m_2', 'case_1'));
  });
});

describe('uniformity', () => {
  it('distributes evenly enough to be a fair control group', () => {
    const n = 50_000;
    let holdout = 0;
    for (let i = 0; i < n; i++) {
      if (assignCohort({ ...base, caseId: `case_${i}`, holdoutBasisPoints: 1000 }) === 'holdout') {
        holdout++;
      }
    }
    const share = holdout / n;
    // Target 10%; allow +/- 1pp for hash noise at this sample size.
    expect(share).toBeGreaterThan(0.09);
    expect(share).toBeLessThan(0.11);
  });

  it('spreads across the whole bucket range', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) seen.add(cohortBucket('m_1', `case_${i}`));
    expect(seen.size).toBeGreaterThan(4000);
    for (const b of seen) {
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(BUCKET_COUNT);
    }
  });
});

describe('stability under rate changes — the property that protects historical comparisons', () => {
  it('lowering the holdout rate only ever removes cases, never reshuffles them', () => {
    const ids = Array.from({ length: 5000 }, (_, i) => `case_${i}`);

    const at10pct = new Set(
      ids.filter(
        (caseId) => assignCohort({ ...base, caseId, holdoutBasisPoints: 1000 }) === 'holdout',
      ),
    );
    const at5pct = new Set(
      ids.filter(
        (caseId) => assignCohort({ ...base, caseId, holdoutBasisPoints: 500 }) === 'holdout',
      ),
    );

    // Every case in the smaller holdout must have been in the larger one. If
    // this ever failed, changing the rate would silently invalidate every
    // incrementality number we had already reported — and billed on.
    for (const id of at5pct) expect(at10pct.has(id)).toBe(true);
    expect(at5pct.size).toBeLessThan(at10pct.size);
  });
});

describe('opt-outs', () => {
  it('respects a merchant who refuses a holdout', () => {
    expect(
      assignCohort({ ...base, caseId: 'c', holdoutBasisPoints: 10000, holdoutEnabled: false }),
    ).toBe('treatment');
  });

  it('respects policy-level ineligibility', () => {
    expect(
      assignCohort({ ...base, caseId: 'c', holdoutBasisPoints: 10000, eligible: false }),
    ).toBe('treatment');
  });

  it('treats a zero or negative rate as no holdout', () => {
    expect(assignCohort({ ...base, caseId: 'c', holdoutBasisPoints: 0 })).toBe('treatment');
    expect(assignCohort({ ...base, caseId: 'c', holdoutBasisPoints: -5 })).toBe('treatment');
  });

  it('holds out everything at 100%', () => {
    expect(assignCohort({ ...base, caseId: 'c', holdoutBasisPoints: 10000 })).toBe('holdout');
  });
});

describe('isHoldoutEligible', () => {
  it('never holds out a case that does not contact the customer anyway', () => {
    expect(isHoldoutEligible({ contactsCustomer: false, alertsMerchant: false })).toBe(false);
  });

  it('never withholds a merchant breakage alert — that would be indefensible', () => {
    expect(isHoldoutEligible({ contactsCustomer: true, alertsMerchant: true })).toBe(false);
  });

  it('allows an ordinary customer-facing case', () => {
    expect(isHoldoutEligible({ contactsCustomer: true, alertsMerchant: false })).toBe(true);
  });
});
