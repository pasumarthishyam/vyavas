/**
 * Composition.
 *
 * Pure, so the whole matrix of "what would we actually say to this person" is a
 * table of unit tests rather than a staging environment and a real phone.
 */

import { describe, expect, it } from 'vitest';

import {
  compose,
  emailSubject,
  greetingName,
  languageFor,
  renderPreview,
  sanitizeVariable,
  type ComposeContext,
} from '@messaging/compose.js';
import { TEMPLATES, placeholderCount, templateFor } from '@messaging/templates.js';
import { MESSAGE_INTENTS } from '@core/actions/types.js';
import { paise } from '@core/money.js';

function ctx(over: Partial<ComposeContext> = {}): ComposeContext {
  return {
    intent: 'switch_method',
    locale: 'en-IN',
    customerName: 'Rahul Sharma',
    merchantName: 'Kirana Cloud',
    amountPaise: paise(184_300),
    paymentLink: 'https://rzp.io/i/abc123',
    ...over,
  };
}

describe('every intent has a template', () => {
  it.each(MESSAGE_INTENTS)('%s', (intent) => {
    // A ladder can emit any intent. One without a template is a rung that
    // silently never fires.
    expect(templateFor(intent)).not.toBeNull();
  });
});

describe('templates satisfy Metaʼs rules', () => {
  it.each(TEMPLATES.map((t) => [t.name, t] as const))('%s', (_name, t) => {
    // These are rejected at review, days after you wrote them.
    expect(t.category).toBe('UTILITY');
    expect(t.name).toMatch(/^[a-z0-9_]+$/);
    expect(t.body.trimStart().startsWith('{{'), 'must not START with a variable').toBe(false);
    expect(t.body.trimEnd().endsWith('}}'), 'must not END with a variable').toBe(false);
    expect(t.body.length).toBeLessThanOrEqual(1024);

    // Placeholder count, variable roles and example values must all agree, or
    // the send fails at runtime with a parameter-mismatch error.
    expect(placeholderCount(t.body)).toBe(t.variables.length);
    expect(t.examples).toHaveLength(t.variables.length);
  });

  it('never mentions a discount, which would reclassify it as MARKETING', () => {
    for (const t of TEMPLATES) {
      // Narrow on purpose: a bare /off/ matches "switched off" in the bank
      // template, which is not a discount. Match the vocabulary of an actual
      // offer instead.
      expect(t.body.toLowerCase()).not.toMatch(
        /discount|coupon|voucher|cashback|promo code|\d+%\s*off|save (₹|rs)/,
      );
    }
  });
});

describe('compose', () => {
  it('produces a template name, language and positional variables', () => {
    const r = compose(ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.message.templateName).toBe('vyavas_switch_method_en');
    expect(r.message.language).toBe('en');
    expect(r.message.variables).toEqual([
      'Rahul',
      '₹1,843',
      'Kirana Cloud',
      'https://rzp.io/i/abc123',
    ]);
  });

  it('renders a preview with the values substituted', () => {
    const r = compose(ctx());
    if (!r.ok) throw new Error('expected ok');
    expect(r.message.preview).toContain('Hi Rahul');
    expect(r.message.preview).toContain('₹1,843');
    expect(r.message.preview).toContain('https://rzp.io/i/abc123');
    expect(r.message.preview).not.toContain('{{');
  });

  it('refuses rather than sending a message with a blank link', () => {
    // "You can complete it in a few seconds here: " with nothing after it is
    // worse than no message at all.
    const r = compose(ctx({ paymentLink: null }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('missing_payment_link');
  });

  it('refuses a pre-debit notice with no date', () => {
    const r = compose(ctx({ intent: 'pre_debit_notice', debitAt: null }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('missing_debit_date');
  });

  it('composes a pre-debit notice, which carries no payment link', () => {
    // Deliberate: it is a notification. A link would invite a duplicate payment
    // for a debit that is about to happen anyway.
    const r = compose({
      ...ctx({ intent: 'pre_debit_notice', paymentLink: null }),
      debitAt: new Date('2026-09-03T00:00:00Z'),
      planName: 'Pro plan',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.message.preview).toContain('3 September');
    expect(r.message.preview).not.toContain('http');
  });

  it('composes every intent that has a link', () => {
    for (const intent of MESSAGE_INTENTS) {
      if (intent === 'pre_debit_notice') continue;
      const r = compose(ctx({ intent }));
      expect(r.ok, `${intent} failed to compose`).toBe(true);
    }
  });
});

describe('cart_saved never wears failure language', () => {
  it('says nothing about a payment failing', () => {
    const r = compose(ctx({ intent: 'cart_saved' }));
    if (!r.ok) throw new Error('expected ok');
    const text = r.message.preview.toLowerCase();
    // The customer chose to leave. Nothing broke.
    expect(text).not.toContain('failed');
    expect(text).not.toContain("didn't go through");
    expect(text).not.toContain('declined');
    expect(text).not.toContain('sorry');
  });
});

describe('greetingName', () => {
  it('takes only the first name', () => {
    expect(greetingName('Rahul Sharma')).toBe('Rahul');
  });

  it('falls back to "there" rather than leaving a blank', () => {
    // Meta rejects a send whose variable is empty, and "Hi , your payment…"
    // is worse than a generic greeting anyway.
    expect(greetingName(null)).toBe('there');
    expect(greetingName('   ')).toBe('there');
    expect(greetingName('x'.repeat(40))).toBe('there');
  });

  it('strips characters that would break the send', () => {
    expect(greetingName('Rahul\nSharma')).toBe('Rahul');
  });
});

describe('sanitizeVariable', () => {
  it('removes what WhatsApp rejects at send time', () => {
    // Newlines and long space runs fail at SEND, not at review — so they fail
    // on a real case, at whatever hour the ladder fires.
    expect(sanitizeVariable('a\nb')).toBe('a b');
    expect(sanitizeVariable('a\t\tb')).toBe('a b');
    expect(sanitizeVariable('a      b')).toBe('a b');
    expect(sanitizeVariable('  padded  ')).toBe('padded');
  });
});

describe('languageFor', () => {
  it('resolves to English for now, including unknown locales', () => {
    expect(languageFor('en-IN')).toBe('en');
    expect(languageFor('hi-IN')).toBe('en');
    expect(languageFor(null)).toBe('en');
  });
});

describe('renderPreview', () => {
  it('leaves an unfilled placeholder visible rather than blank', () => {
    const t = templateFor('switch_method')!;
    // Visible {{4}} in an audit trail is a bug you can see; a silent blank is
    // one you cannot.
    expect(renderPreview(t, ['Rahul', '₹1,843', 'Kirana'])).toContain('{{4}}');
  });
});

describe('emailSubject', () => {
  it('names the merchant, never us', () => {
    for (const intent of MESSAGE_INTENTS) {
      const s = emailSubject(intent, 'Kirana Cloud');
      expect(s).toContain('Kirana Cloud');
      expect(s.toLowerCase()).not.toContain('vyavas');
    }
  });
});
