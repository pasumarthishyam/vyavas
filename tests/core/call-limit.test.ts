/**
 * The per-case call ceiling.
 *
 * Before this guard there was none at all: the console displayed a call count
 * and enforced nothing, so one case could be called as many times as somebody
 * clicked. A phone call is the most intrusive thing this product does and it
 * was the only action with no limit on it.
 */

import { describe, expect, it } from 'vitest';

import { MAX_CALLS_PER_CASE, authorizeCall, callLimitWarning } from '../../src/core/guards/call-limit.js';

describe('authorizeCall', () => {
  it('allows the first call', () => {
    const d = authorizeCall({ callsPlaced: 0, override: false });
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.override).toBe(false);
  });

  it('allows the second', () => {
    const d = authorizeCall({ callsPlaced: 1, override: false });
    expect(d.allowed).toBe(true);
  });

  it('refuses the third, and says so in a way a person can act on', () => {
    const d = authorizeCall({ callsPlaced: 2, override: false });
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.overridable).toBe(true);
      expect(d.reason).toContain('limit is 2');
    }
  });

  it('lets a person through, and marks the call as theirs', () => {
    // The override is the point of the design, not a hole in it: a ceiling
    // nobody can pass is one people route around on their own phone, where
    // nothing records it at all.
    const d = authorizeCall({ callsPlaced: 2, override: true });
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.override).toBe(true);
  });

  it('keeps asking on every further call, not just the first one past the line', () => {
    // A single confirmation must not become standing permission to redial.
    const fifth = authorizeCall({ callsPlaced: 4, override: false });
    expect(fifth.allowed).toBe(false);
  });

  it('counts unanswered calls too', () => {
    // What the ceiling bounds is how often this person's phone RINGS. Counting
    // only answered calls would make three no-answers an unbounded redial loop.
    expect(authorizeCall({ callsPlaced: MAX_CALLS_PER_CASE, override: false }).allowed).toBe(false);
  });

  it('is not confused by a nonsense count', () => {
    expect(authorizeCall({ callsPlaced: -3, override: false }).allowed).toBe(true);
    expect(authorizeCall({ callsPlaced: 2.7, override: false }).allowed).toBe(false);
  });
});

describe('callLimitWarning', () => {
  it('names the real limit, so the dialog cannot drift from the rule', () => {
    expect(callLimitWarning(2)).toContain(`stops at ${MAX_CALLS_PER_CASE}`);
    expect(callLimitWarning(2)).toContain('recorded');
  });

  it('gets its plural right', () => {
    expect(callLimitWarning(1)).toContain('1 time ');
    expect(callLimitWarning(3)).toContain('3 times');
  });
});
