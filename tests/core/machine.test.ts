import { describe, expect, it } from 'vitest';
import { CASE_STATES, TERMINAL_STATES, isTerminal } from '@core/case/types.js';
import {
  allowedTransitions,
  canTransition,
  haltsExecution,
  transition,
} from '@core/case/machine.js';

describe('terminal states are terminal', () => {
  it.each(TERMINAL_STATES)('%s cannot move anywhere', (from) => {
    expect(allowedTransitions(from)).toHaveLength(0);
    for (const to of CASE_STATES) {
      expect(canTransition(from, to)).toBe(false);
    }
  });

  it('refuses to reopen a recovered case — the guard against messaging someone who paid', () => {
    const r = transition('recovered', 'executing', 'resumed');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('terminal_state');
      expect(r.error.message).toContain('terminal');
    }
  });

  it.each(TERMINAL_STATES)('%s is reported terminal', (s) => {
    expect(isTerminal(s)).toBe(true);
  });
});

describe('legal transitions', () => {
  it('walks the happy path', () => {
    expect(transition('detected', 'diagnosed', 'diagnosed').ok).toBe(true);
    expect(transition('diagnosed', 'executing', 'ladder_started').ok).toBe(true);
    expect(transition('executing', 'recovered', 'payment_received').ok).toBe(true);
  });

  it('allows pause and resume', () => {
    expect(transition('executing', 'paused', 'paused_by_merchant').ok).toBe(true);
    expect(transition('paused', 'executing', 'resumed').ok).toBe(true);
  });

  it('lets a diagnosed case abort straight away (terminal_noop / already paid)', () => {
    expect(transition('diagnosed', 'aborted', 'already_paid').ok).toBe(true);
  });

  it('lets a case recover before the ladder ever starts', () => {
    // The customer retried on their own between detection and the first rung.
    expect(transition('diagnosed', 'recovered', 'payment_received').ok).toBe(true);
  });
});

describe('illegal transitions', () => {
  it('rejects skipping diagnosis', () => {
    const r = transition('detected', 'executing', 'ladder_started');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('illegal_transition');
  });

  it('rejects a reason that does not justify the destination', () => {
    const r = transition('executing', 'recovered', 'ladder_exhausted');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('reason_mismatch');
      expect(r.error.message).toContain('payment_received');
    }
  });

  it('will not mark a case recovered on a deadline', () => {
    expect(transition('executing', 'recovered', 'deadline_passed').ok).toBe(false);
  });
});

describe('haltsExecution', () => {
  it('halts on every terminal state and on pause', () => {
    for (const s of TERMINAL_STATES) expect(haltsExecution(s)).toBe(true);
    expect(haltsExecution('paused')).toBe(true);
  });

  it('does not halt on live states', () => {
    expect(haltsExecution('executing')).toBe(false);
    expect(haltsExecution('diagnosed')).toBe(false);
    expect(haltsExecution('detected')).toBe(false);
  });
});

describe('reachability', () => {
  it('every non-terminal state can reach a terminal state', () => {
    for (const s of CASE_STATES) {
      if (isTerminal(s)) continue;
      const reachesTerminal = allowedTransitions(s).some(isTerminal);
      expect(reachesTerminal, `${s} must be able to terminate`).toBe(true);
    }
  });
});
