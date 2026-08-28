/**
 * Inbound WhatsApp parsing and opt-out detection.
 *
 * The opt-out matcher is the part that matters. Too strict and we keep
 * messaging someone who asked us to stop; too loose and a customer who wrote
 * "I stopped at the shop, will pay tonight" is silenced forever.
 */

import { describe, expect, it } from 'vitest';

import { isOptOut, parseWebhook } from '@adapters/whatsapp/webhook.js';

const statusPayload = (over: Record<string, unknown> = {}) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '1768038367864723',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            statuses: [
              {
                id: 'wamid.ABC123',
                status: 'delivered',
                timestamp: '1787000000',
                recipient_id: '919876543210',
                ...over,
              },
            ],
          },
        },
      ],
    },
  ],
});

const messagePayload = (text: string) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          field: 'messages',
          value: {
            messages: [
              {
                from: '919876543210',
                id: 'wamid.INBOUND1',
                timestamp: '1787000000',
                type: 'text',
                text: { body: text },
              },
            ],
          },
        },
      ],
    },
  ],
});

describe('parseWebhook — delivery receipts', () => {
  it('reads a delivered status', () => {
    const { statuses } = parseWebhook(statusPayload());
    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.providerMessageId).toBe('wamid.ABC123');
    expect(statuses[0]!.status).toBe('delivered');
  });

  it('reads Meta second-precision timestamps without landing in 1970', () => {
    const { statuses } = parseWebhook(statusPayload());
    expect(statuses[0]!.at?.getUTCFullYear()).toBe(2026);
  });

  it('carries the error detail on a failure', () => {
    const { statuses } = parseWebhook(
      statusPayload({
        status: 'failed',
        errors: [{ code: 131026, title: 'Message undeliverable', message: 'not a WhatsApp user' }],
      }),
    );
    expect(statuses[0]!.status).toBe('failed');
    expect(statuses[0]!.errorCode).toBe(131026);
    expect(statuses[0]!.errorDetail).toBe('not a WhatsApp user');
  });

  it('ignores a status it does not recognise rather than throwing', () => {
    // Meta adds statuses. An unknown one must not take the endpoint down.
    const { statuses } = parseWebhook(statusPayload({ status: 'warp_speed' }));
    expect(statuses).toHaveLength(0);
  });
});

describe('parseWebhook — inbound messages', () => {
  it('reads the text and sender', () => {
    const { messages } = parseWebhook(messagePayload('STOP'));
    expect(messages).toHaveLength(1);
    expect(messages[0]!.from).toBe('919876543210');
    expect(messages[0]!.text).toBe('STOP');
  });

  it('reads a quick-reply button label', () => {
    // An opt-out button would otherwise be invisible to the STOP check.
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { from: '919876543210', id: 'wamid.B', type: 'button', button: { text: 'Stop' } },
                ],
              },
            },
          ],
        },
      ],
    };
    expect(parseWebhook(payload).messages[0]!.text).toBe('Stop');
  });
});

describe('parseWebhook — malformed input', () => {
  it('returns empty rather than throwing', () => {
    // A payload we failed to parse is a message whose fate we never learn —
    // but an exception here would break every OTHER event in the batch.
    for (const bad of [null, undefined, {}, { entry: null }, { entry: [{}] }, 'nonsense', 42]) {
      const r = parseWebhook(bad);
      expect(r.statuses).toEqual([]);
      expect(r.messages).toEqual([]);
    }
  });

  it('skips a status with no id', () => {
    const { statuses } = parseWebhook({
      entry: [{ changes: [{ value: { statuses: [{ status: 'delivered' }] } }] }],
    });
    expect(statuses).toHaveLength(0);
  });
});

describe('isOptOut', () => {
  it('catches the obvious forms', () => {
    for (const s of ['STOP', 'stop', 'Stop.', 'unsubscribe', 'UNSUBSCRIBE', 'opt out', 'remove me']) {
      expect(isOptOut(s), s).toBe(true);
    }
  });

  it('catches short phrases built around STOP', () => {
    for (const s of ['please stop', 'stop please', 'stop it']) {
      expect(isOptOut(s), s).toBe(true);
    }
  });

  it('catches Hindi forms', () => {
    expect(isOptOut('band karo')).toBe(true);
    expect(isOptOut('mat bhejo')).toBe(true);
  });

  it('does NOT silence someone who merely used the word', () => {
    // The failure mode that matters most: a customer trying to engage, muted
    // forever because their sentence contained "stopped".
    for (const s of [
      'I stopped at the shop, will pay tonight',
      'my card stopped working, can you help',
      'the payment stopped halfway through and I need a new link',
    ]) {
      expect(isOptOut(s), s).toBe(false);
    }
  });

  it('does not fire on an ordinary reply', () => {
    for (const s of ['already paid', 'wrong number', 'will pay friday', 'ok', 'thanks']) {
      expect(isOptOut(s), s).toBe(false);
    }
  });
});
