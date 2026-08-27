# Taxonomy

## Why `error_reason` is not a key

Razorpay publishes failure reasons across three overlapping lists — general
payment, card-specific, gateway. Several reasons appear in more than one, with
materially different meanings:

| Reason | From `customer` | From `gateway` / `bank` |
|---|---|---|
| `authentication_failed` | a mistyped OTP — recoverable in seconds | the 3DS path itself failed — infrastructure |
| `bank_not_enabled` | — | a temporary delisting during an outage |
| `invalid_vpa` | a typo | a deregistered handle that will never work |
| `payment_failed` | an abandoned auth step | a bank-side failure |

Treating those as one thing produces one generic message for all of them, which
is precisely why most recovery tooling underperforms.

**The routing key is the tuple:**

```
(error_code, error_source, error_step, error_reason, method, bank, network)
```

Store all of it. Never collapse it.

## The nine cause classes

Grouped by the only question that changes what we do: **what has to change for
the money to arrive?**

| Class | What is wrong | Same instrument? | Who acts |
|---|---|---|---|
| `transient_infra` | bank/gateway is down | ✅ later | nobody — wait |
| `instrument_dead` | card/account/VPA unusable | ❌ never | customer switches |
| `customer_input` | a typo | ✅ now | customer, in seconds |
| `auth_friction` | 3DS/OTP did not complete | ✅ once | customer retries |
| `funds_limits` | no money or no headroom | ✅ later | customer, on a cycle |
| `risk` | fraud/risk decline | ❌ never | one alternate rail, then stop |
| `merchant_config` | merchant setup broken | ❌ | **merchant** |
| `terminal_noop` | already paid / duplicate | ❌ | nobody — close it |
| `intent_exit` | customer chose to leave | ✅ | customer, if they want |

## Rules that are not tuning knobs

**Attempt caps** (`SAME_INSTRUMENT_ATTEMPT_CAP` in `diagnose.ts`) exist because
three wrong OTPs commonly locks a card at the issuer, and repeated wrong UPI
PINs lock the handle at NPCI. Exceeding them does not merely fail — it takes the
customer's payment instrument away. These are safety limits.

**Risk gets one touch.** Repeated attempts after a risk decline raise the score,
can blacklist the card, and degrade the merchant's overall authorisation rate
across every customer. The cost of over-trying is not borne by this case alone.

**`terminal_noop` never contacts anyone.** `railsFor()` returns `[]` before any
other logic runs, because the UPI-preference boost is unconditional on method
and would otherwise attach "pay by UPI" to an already-paid order.

## The downtime override

A decline during a **confirmed** outage is an outage. Razorpay publishes a
Payment Downtime API plus `payment.downtime.started` / `.resolved` webhooks, so
we do not guess "retry in 2–3 hours" — we wait for the bank to actually come
back, then strike.

`DOWNTIME_ELIGIBLE_REASONS` is deliberately narrow. An expired card is expired
whether or not HDFC is down, and a typo is a typo. Reclassifying those would
produce a message telling the customer to wait for a bank that was never their
problem. There is a golden fixture for exactly this.

## Attended vs unattended

Under RBI rules there is no silent card-on-file retry in India. Every unattended
debit needs a mandate — UPI Autopay, e-mandate or eNACH — with AFA at
registration and a pre-debit notification before each charge.

- **Attended** — no mandate. "Retry" means getting a human back to a payment
  surface.
- **Unattended** — a mandate exists and the debit may be re-presented.

One subtlety worth knowing: a mandate riding a **dead instrument is itself
dead**. `card_expired` on an e-mandate needs re-registration with AFA, not a
re-presentment, so `diagnose()` forces `attended: true` for
`instrument_dead` regardless of mandate. Re-presenting would burn attempts
against something that can never succeed.

## Adding a code

Razorpay adds codes without notice. Anything unrecognised maps to
`unknown_reason`, is flagged on `NormalizedFailure.unrecognisedReason` for an
internal alert, and gets the most cautious ladder — it is never dropped.

To add one properly:

1. Add a descriptor to `ERROR_REASONS` in `codes.ts` with a `baseCauseClass`
   and a note explaining the mapping.
2. If the reason means different things by source/step/method, add rules to
   `RULES` in `diagnose.ts` and set `requiresSourceDisambiguation: true`.
3. Add a golden fixture in `tests/golden/fixtures.ts`.
4. `npm run verify`.

Step 3 is not optional — the exhaustiveness test fails CI without it.
