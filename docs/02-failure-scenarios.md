# Failure scenarios

44 documented Razorpay failure reasons, grouped into 9 cause classes by one
question and one question only:

> **What has to change for the money to arrive?**

Grouping by anything else — severity, payment method, error text — produces
buckets that all get the same generic "your payment failed" email. That is the
failure mode of every dunning tool on the market, and the taxonomy exists to
avoid it.

---

## The nine classes at a glance

| | Class | What has to change | Retry same? | Touches | Wait | Tone |
|---|---|---|---|---|---|---|
| A | `transient_infra` | Nothing — wait for the bank | yes | 3 | 20 min | reassuring |
| B | `instrument_dead` | The instrument | **no** | 3 | 3 min | educational |
| C | `customer_input` | A typo | yes | 4 | **0 min** | neutral |
| D | `auth_friction` | Complete the challenge | once | 3 | 3 min | reassuring |
| E | `funds_limits` | Money or headroom | yes | 4 | 3 hours | neutral |
| F | `risk` | Almost nothing we control | **no** | **1** | 15 min | neutral |
| G | `merchant_config` | The merchant's setup | **no** | 1 | 2 min | reassuring |
| H | `terminal_noop` | Nothing — already paid | — | **0** | — | silent |
| I | `intent_exit` | The customer's mind | yes | 3 | 20 min | informational |

"Touches" is the **class ceiling**, not a target. A policy row may lower it and
may never raise it — the compiler rejects a table that tries.

---

## A · `transient_infra` — the bank or gateway broke

**7 reasons:** `bank_technical_error`, `bank_not_available`,
`bank_cutoff_in_progress`, `gateway_technical_error`,
`authorisation_declined_by_psp`, `payment_failed`, `unknown_reason`

Nobody's fault. The instrument is fine; only the timing was bad.

**What makes this class different:** it is *downtime-gated*. Rather than
guessing "retry in 2–3 hours", the case parks until Razorpay's downtime feed
reports the outage resolved, then strikes. "Your bank is back online" is a
different product from "please try again" — and it is only honest because we
waited for confirmation instead of a timer.

The 20-minute floor exists because messaging someone while their bank is still
down walks them straight into a second failure.

---

## B · `instrument_dead` — this card will never work

**8 reasons:** `card_expired`, `card_not_enrolled`,
`card_disabled_for_online_payments`, `debit_instrument_blocked`,
`debit_instrument_inactive`, `bank_account_invalid`,
`bank_account_validation_failed`, `invalid_vpa` (when rejected upstream)

No amount of retrying changes this. The customer must switch.

**Educational, not apologetic.** "Your bank has online payments switched off for
this card" is actionable; "payment failed, please try again" is not. Most Indian
debit-card holders do not know this is a setting, which is why
`card_not_enrolled` and `card_disabled_for_online_payments` get their own
template offering UPI as the immediate path — most people will take it now and
fix the card later.

**A mandate on a dead instrument is itself dead.** It needs re-registration with
AFA, not a retry, so such a case is forced back to *attended* even though a
mandate exists.

**A dead UPI handle is never answered with "try UPI collect"** — collect sends a
request to the very VPA that just failed.

---

## C · `customer_input` — a typo

**9 reasons (the largest class):** `incorrect_otp`, `incorrect_cvv`,
`incorrect_pin`, `incorrect_atm_pin`, `incorrect_card_details`,
`incorrect_card_expiry_date`, `incorrect_cardholder_name`,
`invalid_user_details`, `mobile_number_invalid`

The highest-recovery class in the taxonomy: intent is proven, the fix takes
seconds, and the customer is very often still on the page.

**The only rule that matters here is speed.** Intent decays in minutes, so the
floor is zero — the one class where it is. A ladder that opens at 30 minutes has
already lost most of what it could have recovered.

**Both channels, at once.** The opening rung is a `fanout` rung: WhatsApp and
email go out together at 0m, in one gate decision. See
[how it works](./01-how-it-works.md#fanout-one-rung-two-channels) for why this
could not be two rungs.

**The attempt cap has teeth here.** Three wrong OTPs commonly locks a card at
the issuer, and repeated wrong UPI PINs lock the handle at NPCI. So
`incorrect_otp`, `incorrect_pin` and `authentication_failed` cap at 2
same-instrument attempts and `incorrect_cvv` at 3, after which same-instrument
retry is withdrawn and the copy moves the customer to another rail. Exceeding
these does not just fail — it takes the customer's payment instrument away.

---

## D · `auth_friction` — the challenge did not complete

**2 reasons:** `authentication_failed` (from anywhere upstream of the customer),
`payment_timed_out`

The SMS was late, the bank page timed out, the challenge was abandoned. In India
this is very often **delivery latency rather than a real refusal**, which is why
exactly one same-instrument retry is justified — and why the second touch moves
to UPI rather than sending them into the same 3DS page a third time.

The floor is 3 minutes, not 10. Nothing is down: the customer is sitting on a
failed checkout with live intent and a working instrument, which is the
`customer_input` situation rather than the outage one. Ten minutes of silence is
long enough to close the tab. It is kept above zero only so the live-attempt
lock has a window to notice someone already retrying on another rail.

---

## E · `funds_limits` — no money, or no headroom

**4 reasons:** `insufficient_funds`, `transaction_limit_exceeded`,
`emi_greater_than_max_amount`, `emi_plan_unavailable`

The instrument works. **Timing is the entire lever**, which is why this class has
the longest floor (3 hours) and the most touches. Messaging someone twenty
minutes after their balance ran out achieves nothing except irritation.

`transaction_limit_exceeded` is one of the few genuinely deterministic retry
windows in payments: daily limits reset at midnight, so the second touch lands
past midnight and deliberately offers **the same instrument again** — unusual
for a declined card, and correct here.

EMI and pay-later are stripped from the suggested rails on small tickets, where
they do not exist.

---

## F · `risk` — the issuer or a fraud system refused

**3 reasons:** `card_declined` (from an issuer at authorisation),
`payment_risk_check_failed`, `mismatch_in_transaction_details`

**The one class where trying harder makes things worse.** Repeated attempts
raise the issuer's risk score, can get the card blocked, and degrade the
merchant's authorisation rate **across every other customer**. The cost of
over-trying is not borne by this case alone.

So the ceiling is one touch on one alternate rail — UPI only — and the compiler
refuses any row here that exceeds it. Offering another card invites a second
decline against the same risk profile, which is worse than saying nothing.

**We never tell a customer they were flagged.** "Your bank couldn't complete
this — UPI usually works" is the whole permitted vocabulary.

`payment_risk_check_failed` additionally escalates to a human review queue: a
burst of these is a signal about the merchant's own risk rules, not about any
one payer.

---

## G · `merchant_config` — the merchant's setup is broken

**7 reasons:** `live_mode_not_enabled`, `merchant_not_activated`,
`bank_not_enabled`, `invalid_request`, `input_validation_failed`,
`amount_less_than_minimum_amount`, `order_payment_method_mismatch`

Every customer hitting this is a **total, ongoing, silent loss** until the
merchant acts.

Two tracks run in parallel:

1. **The customer is not the problem and must never be told they are.** They may
   still be rescued onto a working rail — one touch, reassuring framing.
2. **The merchant is alerted with facts, not prescriptions.** We state what
   broke, when it started, how many cases, how much money, and what the normal
   rate is. We do **not** say "disable UPI". Turning off a payment method is a
   commercial decision that can cost far more than the outage, and we do not
   have the merchant's context.

This is the class where Claude adds the most — see [the AI](./03-ai.md#1-merchant-alerts).

---

## H · `terminal_noop` — already paid, or a duplicate

**3 reasons:** `order_already_paid`, `duplicate_request`, `duplicate_refund_id`

There is no revenue at risk. Close the case and cancel every queued action
immediately.

`contactCustomer` is **false**, `maxCustomerTouches` is **0**, and the suggested
rails are empty — the last guarded specifically, because the "UPI is the escape
hatch" boost is unconditional on method and without it an `order_already_paid`
case would arrive carrying a suggestion to go and pay again.

Messaging someone who has already paid is the one mistake that ends the merchant
relationship. The gate checks `orderPaid` unconditionally on every rung, whether
or not the policy listed it.

---

## I · `intent_exit` — the customer chose to leave

**1 reason:** `payment_cancelled`

**Not an error.** A cancelled payment is a live intent signal: they were on the
page, they decided not to proceed, and they may well come back.

So it gets its own case type, never enters failure-rate alerting, and never
receives failure language. The template says the cart is saved and contains no
failure wording at all. Telling someone their payment "failed" when they pressed
Back is both wrong and the fastest way to be marked as spam.

---

## Cross-cutting scenarios

Several situations cut across the classes.

### The same reason means different things

The routing key is the whole tuple, and these pairs are why:

| Reason | From `customer` | From upstream |
|---|---|---|
| `authentication_failed` | `customer_input` — a mistyped OTP | `auth_friction` — the 3DS path failed |
| `invalid_vpa` | `customer_input` — a typo | `instrument_dead` — deregistered handle |
| `card_declined` | — | `risk` from an issuer, `transient_infra` from a gateway |
| `bank_not_enabled` | `merchant_config` from `business` | `transient_infra` from a gateway |
| `authorisation_declined_by_psp` | `risk` on cards | `transient_infra` on UPI |

That last one matters commercially: on UPI, an issuer decline is routine PSP
behaviour rather than a judgement about the payer, and treating it as `risk`
would cap a recoverable case at a single touch.

### A confirmed outage rewrites the diagnosis

If Razorpay reports an open outage matching this bank and method, an eligible
failure is reclassified as `transient_infra` — but only for reasons an outage
can plausibly explain. An expired card during an HDFC outage is still an expired
card.

### Attempt history tightens as it goes

Same-instrument retry is withdrawn once the per-reason attempt cap is reached,
regardless of what the class or the policy row says. A policy can never
re-authorise something the diagnosis has ruled out — `effectiveRails()` may only
ever *remove* rails.

### Attended vs unattended

Under RBI rules there is no silent card retry in India without a mandate, and no
third option. It is decided explicitly on every case and always justified in the
rationale. A `retry_debit` requires an active mandate *and* a preceding
pre-debit notice; the compiler refuses a ladder that schedules one without both.

### An unknown code

Preserved verbatim, classified `unknown_reason` with low confidence, routed to a
cautious ladder. Then surfaced: `npm run triage` groups the unknowns and asks
Claude to propose a classification for a human to review. See
[the AI](./03-ai.md#2-unknown-code-triage).

### A code that matches nothing at all

Exactly one row in the table carries `catchAll: true`, and the compiler refuses
to build a table without it. It reaches **no customer** — an input we did not
anticipate is the last one that should be messaged, because we do not know what
went wrong and so cannot know what would be true to say. It escalates to a human
and stops. Reaching it is itself a defect worth investigating.
