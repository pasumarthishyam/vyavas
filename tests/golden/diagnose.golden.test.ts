import { describe, expect, it } from 'vitest';
import { diagnose } from '@core/taxonomy/diagnose.js';
import { GOLDEN_CASES, makeCtx, makeTuple } from './fixtures.js';

describe('diagnose — golden fixtures', () => {
  it.each(GOLDEN_CASES.map((c) => [c.name, c] as const))('%s', (_name, gc) => {
    const tuple = makeTuple(gc.tuple);
    const ctx = makeCtx(gc.ctx);
    const d = diagnose(tuple, ctx);

    const e = gc.expect;

    expect(d.causeClass, 'causeClass').toBe(e.causeClass);

    if (e.caseType !== undefined) expect(d.caseType, 'caseType').toBe(e.caseType);
    if (e.attended !== undefined) expect(d.attended, 'attended').toBe(e.attended);
    if (e.sameInstrumentRetry !== undefined) {
      expect(d.sameInstrumentRetry, 'sameInstrumentRetry').toBe(e.sameInstrumentRetry);
    }
    if (e.contactCustomer !== undefined) {
      expect(d.contactCustomer, 'contactCustomer').toBe(e.contactCustomer);
    }
    if (e.alertMerchant !== undefined) expect(d.alertMerchant, 'alertMerchant').toBe(e.alertMerchant);
    if (e.shouldAbort !== undefined) expect(d.shouldAbort, 'shouldAbort').toBe(e.shouldAbort);
    if (e.maxCustomerTouches !== undefined) {
      expect(d.maxCustomerTouches, 'maxCustomerTouches').toBe(e.maxCustomerTouches);
    }
    if (e.minFirstTouchMinutes !== undefined) {
      expect(d.minFirstTouchMinutes, 'minFirstTouchMinutes').toBe(e.minFirstTouchMinutes);
    }
    if (e.downtimeGated !== undefined) expect(d.downtimeGated, 'downtimeGated').toBe(e.downtimeGated);
    if (e.confidence !== undefined) expect(d.confidence, 'confidence').toBe(e.confidence);

    if (e.rails !== undefined) expect(d.suggestedRails, 'rails (exact)').toEqual(e.rails);
    for (const rail of e.railsInclude ?? []) {
      expect(d.suggestedRails, `rails must include ${rail}`).toContain(rail);
    }
    for (const rail of e.railsExclude ?? []) {
      expect(d.suggestedRails, `rails must NOT include ${rail}`).not.toContain(rail);
    }
  });
});

describe('invariants that must hold for every fixture', () => {
  const diagnosed = GOLDEN_CASES.map((gc) => ({
    gc,
    d: diagnose(makeTuple(gc.tuple), makeCtx(gc.ctx)),
  }));

  it('never suggests retrying an instrument it has declared unusable', () => {
    for (const { gc, d } of diagnosed) {
      if (!d.sameInstrumentRetry) {
        expect(d.suggestedRails, gc.name).not.toContain('retry_same');
      }
    }
  });

  it('never suggests a rail to a customer it has decided not to contact', () => {
    for (const { gc, d } of diagnosed) {
      if (!d.contactCustomer) {
        expect(d.suggestedRails, gc.name).toHaveLength(0);
        expect(d.maxCustomerTouches, gc.name).toBe(0);
      }
    }
  });

  it('gives every case a deadline in the future — a case is never born lost', () => {
    for (const { gc, d } of diagnosed) {
      const ctx = makeCtx(gc.ctx);
      expect(d.deadlineAt.getTime(), gc.name).toBeGreaterThan(ctx.now.getTime());
    }
  });

  it('always decides attended vs unattended explicitly and justifies it', () => {
    for (const { gc, d } of diagnosed) {
      expect(typeof d.attended, gc.name).toBe('boolean');
      expect(d.rationale.some((r) => /attended/i.test(r)), gc.name).toBe(true);
    }
  });

  it('produces a non-empty rationale for the audit log', () => {
    for (const { gc, d } of diagnosed) {
      expect(d.rationale.length, gc.name).toBeGreaterThan(0);
      for (const line of d.rationale) expect(line.length).toBeGreaterThan(10);
    }
  });

  it('aborts if and only if the class is terminal', () => {
    for (const { gc, d } of diagnosed) {
      expect(d.shouldAbort, gc.name).toBe(d.causeClass === 'terminal_noop');
      if (d.shouldAbort) expect(d.abortReason, gc.name).not.toBeNull();
    }
  });

  it('never lets a risk decline exceed a single customer touch', () => {
    for (const { gc, d } of diagnosed) {
      if (d.causeClass === 'risk') {
        expect(d.maxCustomerTouches, gc.name).toBeLessThanOrEqual(1);
        expect(d.sameInstrumentRetry, gc.name).toBe(false);
      }
    }
  });

  it('never re-types a deliberate exit as a failure', () => {
    for (const { gc, d } of diagnosed) {
      if (d.causeClass === 'intent_exit') {
        expect(d.caseType, gc.name).toBe('intent_exit');
        expect(d.framing, gc.name).not.toBe('none');
      }
    }
  });
});
