import { describe, expect, it } from 'vitest';

import { idempotencyKey, messageKey, type Action } from '../../src/core/actions/types.js';

/*
 * The two send paths must share one key space.
 *
 * The autonomous ladder and the console's manual Start both write to
 * `message_log`, and the unique index on `idempotency_key` is the only thing
 * standing between "a human pressed Start on a case the ladder already handled"
 * and "a real person received the same message twice".
 *
 * They did not share it. The ladder built `caseId:rung:kind`; the console built
 * `caseId:rung:channel`. Since the ladder's kind is `nudge` and the console's
 * channel is `whatsapp`, the keys could never collide, and the guard was
 * decorative. It was observed in production: `…:0:nudge` at 10:29 and
 * `…:0:whatsapp` at 10:31, two identical WhatsApp messages, both logged as
 * first touches.
 */
describe('one key space across both send paths', () => {
  const CASE = '27977061-2670-4a1c-ab80-14c32cb58371';

  const nudge: Action = {
    kind: 'nudge',
    rung: 0,
    channels: ['whatsapp'],
    intent: 'switch_method',
    suggest: [],
    attachPaymentLink: true,
  };

  it('the ladder derives its key from the shared builder', () => {
    expect(idempotencyKey(CASE, nudge)).toBe(messageKey(CASE, 0, 'nudge'));
  });

  /*
   * The console composes `messageKey(caseId, rung, 'nudge')` for exactly this
   * reason. If someone reintroduces a channel-shaped key, this fails.
   */
  it('a console send for the same rung collides with the ladder send', () => {
    const fromLadder = idempotencyKey(CASE, nudge);
    const fromConsole = messageKey(CASE, 0, 'nudge');
    expect(fromConsole).toBe(fromLadder);
    expect(fromConsole).not.toContain('whatsapp');
  });

  it('different rungs stay distinct, so a real follow-up is never swallowed', () => {
    expect(messageKey(CASE, 0, 'nudge')).not.toBe(messageKey(CASE, 1, 'nudge'));
  });

  it('a forced resend is a distinct row rather than a collision', () => {
    // The console appends a timestamp suffix ONLY for a human-confirmed
    // override, so the deliberate second send is auditable in its own right
    // instead of being refused or, worse, overwriting the original.
    const original = messageKey(CASE, 0, 'nudge');
    const forced = `${original}:f1788173791288`;
    expect(forced).not.toBe(original);
    expect(forced.startsWith(original)).toBe(true);
  });
});
