/**
 * Redaction for anything shown in an audit trail.
 *
 * The console masks phone numbers and emails on the case table, at the query
 * layer, for a stated reason: a support screenshot should never carry a full
 * phone number, and relying on each view to remember that is how one eventually
 * does not.
 *
 * The activity feed is the place that rule is easiest to break, because almost
 * everything it renders is FREE TEXT WE DID NOT WRITE:
 *
 *   - `message_log.error` is the provider's sentence. Meta and Resend both
 *     echo the recipient back inside failure messages, so a delivery failure
 *     puts a real customer's phone number or email address in the feed.
 *   - `case_events.payload.note` carries a payment link on the events that
 *     created one, and a Razorpay short link is a per-customer bearer URL —
 *     anyone who reads it can open that customer's checkout.
 *   - Provider payloads change without warning. A field that holds nothing
 *     sensitive today can hold a name tomorrow, and nothing would fail.
 *
 * So this runs over every free-text field on the way OUT of the query layer,
 * rather than at each render site. It is deliberately blunt: it would rather
 * mask a harmless order id that looks like a phone number than let one real
 * number through.
 */

/**
 * One pass, four alternatives, tried in this order at every position.
 *
 * ── why one regex and not four passes ──
 *
 * The rules interfere. A UUID contains digit-and-hyphen runs that look exactly
 * like a formatted phone number — `27977061-2670` is twelve digits with a
 * separator — so a phone pass run over a case id chews the front off it and
 * produces `27•••••6704a1c-…`. That is worse than cosmetic: the id is what a
 * reader copies to go and look the case up.
 *
 * The first fix parked UUIDs behind sentinel characters between passes. It
 * worked and it was fragile in a way worth naming: the sentinels were
 * non-printing, so any tool that normalised the file — a formatter, an editor,
 * a copy through a terminal — would silently remove them and leave a restore
 * pattern matching every digit run in the string.
 *
 * Alternation removes the whole class of problem. `uuid` is listed first, so at
 * any position where a case id starts the engine commits to it and the phone
 * alternative is never tried there. No intermediate state, nothing to strip.
 *
 * Named groups rather than indices so adding a rule cannot silently renumber
 * the others.
 */
const SECRETS = new RegExp(
  [
    // Case and message ids. First, so nothing below can reach inside one.
    '(?<uuid>\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b)',
    // Local part kept to three characters, the same shape as the case table's mask.
    '(?<elocal>\\b[A-Za-z0-9._%+-]{1,64})@(?<edomain>[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b)',
    // A payment link is a per-customer bearer URL; its host is not.
    'https?://(?<host>[^\\s/]+)(?<path>/[^\\s]*)?',
    /*
     * Indian mobile numbers, with or without a country code or separators.
     *
     * Loose on formatting, strict on length — 10 to 13 digits once separators
     * are removed. Shorter runs are amounts, rung offsets and provider error
     * codes, and masking those would make the trail unreadable to protect
     * nothing.
     */
    '(?<phone>\\+?\\d[\\d\\s-]{8,17}\\d)',
  ].join('|'),
  'gi',
);

/** A run of digits long enough to be a phone number once separators are gone. */
function looksLikePhone(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 13;
}

function maskEmail(local: string, domain: string): string {
  return `${local.slice(0, 3)}•••@${domain}`;
}

function maskPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  return `${digits.slice(0, 2)}•••••${digits.slice(-4)}`;
}

/** Strip contact details and bearer URLs from a free-text string. */
export function redact(value: string | null | undefined): string | null {
  if (value == null) return null;

  return value.replace(SECRETS, (match, ...args) => {
    // Named groups arrive as the last argument, after the offset and the input.
    const g = args.at(-1) as Record<string, string | undefined>;

    // A case id. Returned untouched — this alternative exists only so the phone
    // rule can never reach inside one.
    if (g.uuid) return match;

    if (g.elocal && g.edomain) return maskEmail(g.elocal, g.edomain);

    // Host only. "https://rzp.io/i/aBc123" becomes "rzp.io/…" — enough to know
    // a link was created and which provider issued it, useless as a link.
    if (g.host) return g.path && g.path.length > 1 ? `${g.host}/…` : g.host;

    if (g.phone) return looksLikePhone(g.phone) ? maskPhone(g.phone) : match;

    return match;
  });
}

/**
 * Redact and clip, for a field rendered in one line.
 *
 * Clipping happens AFTER redaction, never before: truncating first can cut a
 * phone number in half and leave the surviving digits unmatched by the pattern
 * that would have masked them.
 */
export function redactShort(value: string | null | undefined, limit = 200): string | null {
  const clean = redact(value);
  if (clean == null) return null;
  return clean.length > limit ? `${clean.slice(0, limit).trimEnd()}…` : clean;
}
