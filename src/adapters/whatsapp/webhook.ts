/**
 * Inbound WhatsApp: delivery receipts and customer replies.
 *
 * Two payload shapes arrive on the same endpoint, and they do very different
 * things:
 *
 *   statuses[]  sent -> delivered -> read, or failed. Feeds the message ledger,
 *               and a permanent failure marks the number undeliverable so the
 *               next rung falls through to email.
 *
 *   messages[]  the customer wrote back. "STOP" is the one we must honour
 *               immediately and globally; everything else is triage for later.
 *
 * Meta retries a non-2xx delivery, so this endpoint answers 200 for anything it
 * has accepted — the same discipline as the Razorpay webhook, for the same
 * reason.
 */

export interface WhatsAppStatusUpdate {
  /** `wamid.…` — matches `message_log.provider_message_id`. */
  providerMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  recipient: string;
  errorCode: number | null;
  errorDetail: string | null;
  at: Date | null;
}

export interface WhatsAppInboundMessage {
  from: string;
  text: string;
  messageId: string;
  at: Date | null;
}

export interface ParsedWebhook {
  statuses: WhatsAppStatusUpdate[];
  messages: WhatsAppInboundMessage[];
}

function toDate(ts: unknown): Date | null {
  const n = typeof ts === 'string' ? Number(ts) : typeof ts === 'number' ? ts : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  // Meta sends seconds, like Razorpay. Milliseconds here would land in 1970.
  return new Date(n * 1000);
}

/**
 * Everything is optional and defensively read. A payment webhook is not a place
 * where an unexpected shape may throw: a status we failed to parse is a message
 * whose fate we never learn.
 */
export function parseWebhook(payload: unknown): ParsedWebhook {
  const statuses: WhatsAppStatusUpdate[] = [];
  const messages: WhatsAppInboundMessage[] = [];

  // `null` and a bare string both reach here from a malformed POST, and
  // `null.entry` throws — which would take down every OTHER event in the same
  // batch, not just the bad one.
  if (payload === null || typeof payload !== 'object') return { statuses, messages };

  const body = payload as {
    entry?: { changes?: { value?: Record<string, unknown> }[] }[];
  };

  for (const entry of Array.isArray(body.entry) ? body.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const value = change.value ?? {};

      for (const s of (value.statuses as Record<string, unknown>[] | undefined) ?? []) {
        const id = typeof s.id === 'string' ? s.id : null;
        const status = typeof s.status === 'string' ? s.status : null;
        if (!id || !status) continue;
        if (!['sent', 'delivered', 'read', 'failed'].includes(status)) continue;

        const errors = (s.errors as { code?: number; title?: string; message?: string }[]) ?? [];
        const first = errors[0];

        statuses.push({
          providerMessageId: id,
          status: status as WhatsAppStatusUpdate['status'],
          recipient: typeof s.recipient_id === 'string' ? s.recipient_id : '',
          errorCode: first?.code ?? null,
          errorDetail: first?.message ?? first?.title ?? null,
          at: toDate(s.timestamp),
        });
      }

      for (const m of (value.messages as Record<string, unknown>[] | undefined) ?? []) {
        const from = typeof m.from === 'string' ? m.from : null;
        const id = typeof m.id === 'string' ? m.id : null;
        if (!from || !id) continue;

        const text = (m.text as { body?: string } | undefined)?.body ?? '';
        // Button replies carry their label rather than free text; an opt-out
        // button would otherwise be invisible to the STOP check.
        const buttonText = (m.button as { text?: string } | undefined)?.text ?? '';

        messages.push({
          from,
          text: (text || buttonText).trim(),
          messageId: id,
          at: toDate(m.timestamp),
        });
      }
    }
  }

  return { statuses, messages };
}

/**
 * Opt-out keywords.
 *
 * Matched on the WHOLE message, case-insensitively, not as a substring — so
 * "please stop sending" opts out but "I stopped at the shop" does not. Erring
 * toward opting people out is the safer direction, but not so loose that any
 * sentence containing the word silences a customer who wanted to reply.
 */
const OPT_OUT = new Set([
  'stop',
  'unsubscribe',
  'opt out',
  'optout',
  'remove me',
  'do not message',
  "don't message",
  'band karo',
  'mat bhejo',
]);

export function isOptOut(text: string): boolean {
  const normalised = text.toLowerCase().replace(/[.!,]/g, '').trim();
  if (OPT_OUT.has(normalised)) return true;
  // "please stop", "stop please" — a short message whose only real word is STOP.
  const words = normalised.split(/\s+/).filter((w) => w.length > 0);
  return words.length <= 3 && words.some((w) => w === 'stop' || w === 'unsubscribe');
}
