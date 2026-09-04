# How it works

From a failed payment to a recovered one, or to an honest decision to stop.

---

## The pipeline

```
Razorpay webhook
      │
      ├─ 1. verify      HMAC-SHA256 over the raw bytes
      ├─ 2. claim       ON CONFLICT DO NOTHING on the event id — a retry is a no-op
      │
      ├─ 3. normalize   raw payload → ErrorTuple (reason, source, step, method, bank)
      ├─ 4. diagnose    tuple + context → cause class, rails, attended, deadline
      ├─ 5. resolve     diagnosis → the one policy row that governs this case
      ├─ 6. persist     one live case per order, enforced by a partial unique index
      │
      └─ 7. publish     `case/diagnosed` → the Inngest ladder
                              │
                              ▼
                        for each rung:
                          gather facts  (re-read the world)
                          evaluate gate (proceed / defer / abort)
                          execute       (compose → send → record)
```

Steps 3–6 are `src/ingest/pipeline.ts`, written as a plain function over a
`Database` rather than a Next.js route, so the whole contract is testable
without a server. The HTTP layer is five lines of wrapper.

---

## 1–2. Accepting the webhook

The endpoint verifies Razorpay's signature over the **raw request bytes** — not
the parsed body, because re-serialising JSON changes the bytes and breaks the
signature. Without this the endpoint is open: anyone who learns the URL can post
fake payment failures and drive real messages to real customers.

It then claims the delivery by inserting the provider's event id, and **answers
200 for anything it has accepted**. This looks wrong and is deliberate: a 500
after the claim makes Razorpay resend an event we already recorded, the dedupe
swallows the resend, and the event is lost forever. The redrive sweep recovers
processing failures; Razorpay's retry is not the mechanism we rely on.

## 3. Normalize

Razorpay's payload becomes an `ErrorTuple`:

```
{ errorReason, errorSource, errorStep, method, bank, network }
```

The routing key is the whole tuple, never `reason` alone. `authentication_failed`
from `customer` is a mistyped OTP; the same reason from `gateway` is a 3DS path
that did not complete. Same string, different class, different ladder.

An undocumented reason is preserved verbatim in `raw_error_reason` and
classified as `unknown_reason` with low confidence, so a new Razorpay code
degrades to a cautious ladder instead of being dropped.

## 4. Diagnose

`diagnose()` is pure — it takes the time, the downtime feed, the attempt history
and whether a mandate exists as arguments. Six layers, in this order:

| # | Layer | What it does |
|---|---|---|
| 1 | Classify | Most-specific disambiguation rule wins; falls back to the code's base class |
| 2 | Downtime override | A decline during a *confirmed* bank outage is an outage, not a customer problem |
| 3 | Attempt tightening | Withdraws same-instrument retry before a third wrong OTP locks the card |
| 4 | Attended / unattended | Under RBI rules there is no third option. A compliance boundary, not a preference |
| 5 | Rails | Which alternates are worth suggesting, given the class, method and amount |
| 6 | Re-typing | A cancelled payment becomes `intent_exit` — a live intent signal, not a failure |

Every decision appends a plain-language line to `rationale[]`, which is what the
case detail page shows and what the escalation brief reads.

The downtime override is deliberately narrow. An expired card is expired whether
or not HDFC is down, so only reasons an outage can plausibly explain are
eligible — otherwise a customer would be told to wait for a bank that was never
their problem.

## 5. Resolve

The diagnosis picks one row from a table of **27 policy rows**, authored as YAML
(one file per cause class) and compiled to a frozen artefact. Selection is
weighted most-specific-wins, and the compiler refuses any table where two rows
of equal specificity could match the same input and behave differently — so
which row applies never depends on declaration order.

The chosen row's id and version are **stamped on the case**. A case that started
under `v3` finishes under `v3`, even if the table is edited mid-flight.

## 6. Persist

One live case per order, enforced by a partial unique index rather than by
application care. See [safety](./04-safety.md).

## 7. The ladder

One durable Inngest run per case. It sleeps for hours between rungs, races those
sleeps against the case being resolved, and **re-gathers every fact before each
step** — because the world moves while a case sleeps. The customer may have paid
through another channel, opted out, or started a fresh attempt.

Inngest specifically, rather than a cron loop:

- `step.sleepUntil` survives deploys. A case parked for 26 hours does not care
  that we shipped twice.
- `cancelOn` a `case/resolved` event kills the run wherever it is sleeping — the
  kill switch is declarative rather than a check we might forget somewhere.
- Every `step.run` is memoised, so a retry replays completed steps rather than
  re-executing them. That is the difference between a retry and a second message.

Rung offsets are measured **from detection, not from the previous rung**, so a
rung that was deferred does not push everything after it down the line.

---

## The gate

Re-checked immediately before every rung. The distinction that matters most is
**abort vs defer**, and getting it backwards is expensive in both directions.

**ABORT** — the reason will never stop being true, or acting would be wrong
regardless of when:

| Condition | Why it is terminal |
|---|---|
| `orderPaid` | Checked unconditionally, even if the policy forgot to list it. The one mistake that ends the relationship must not be opt-out-able |
| `paymentLinkPaid` | Also unconditional. A payment link creates its **own** order when it is paid, so the original order stays `created` forever and `orderPaid` never notices — the customer pays and keeps getting messaged |
| `deadlinePassed` | Intent has decayed past the point of recovery |
| `customerOptedOut` | Global and immediate |
| `mandateActive: false` | Re-presenting would fail and is not permitted |
| No deliverable channel | No amount of waiting produces a phone number we never had |

**PAUSE** — its own disposition, and neither of the above:

| Condition | What happens |
|---|---|
| `executionEnabled: false` | The case is parked in `paused`, keeping its rung, deadline and ledger, and the run ends. Resuming starts a fresh run from the same rung |

Pause used to be an abort, and an abort is terminal — so pausing an account
destroyed every case in flight and switching back recovered none of them. It is
not a defer either: a defer names a time to try again, and a pause ends when a
person ends it, which might be an hour or a month.

**DEFER** — the reason is about *right now*:

| Condition | Retries at |
|---|---|
| Live payment attempt in flight | Just past the lock window — do not interrupt someone mid-retry |
| Cool-off since the last touch | The exact minute the gap clears |
| Daily frequency cap | Exactly 24h after the oldest message still in the rolling window |
| Merchant budget exhausted | Six hours |
| Quiet hours | The next allowed minute in the merchant's timezone |

Deferral times are **computed, not guessed**. The frequency window is rolling,
so a slot frees exactly 24 hours after the oldest message in it — knowable to
the second from a row we already have. This is not a detail: an earlier version
deferred a capped rung by a flat hour, the real wait was three hours, the ladder
exhausted its retries an hour early and left a recoverable case pinned in
`executing` with nothing sent and no alert.

### The live-customer exemption

Quiet hours exist to stop us **waking people up**. Someone who tapped Pay ninety
seconds ago is awake, holding their phone, looking at an error message. Telling
them "your card details didn't go through — UPI will work" is help, and it is a
response to something they just did, not an outbound campaign at 22:47.

Scoped so it cannot become a 3am loophole: **first touch only**, and only inside
a short window after the failure. Every later rung obeys quiet hours normally.

---

## Sending

**Every WhatsApp message is a pre-approved template.** Outside a 24-hour window
opened by the customer messaging us first, free-form text is simply rejected —
and a customer who abandoned a payment has not messaged us.

That constraint is doing us a favour. No message can be improvised, every word a
customer sees was reviewed once, and the whole surface is auditable.

Composition (`compose.ts`) is **pure**: a case plus an intent produces a template
name and positional variables. It can refuse — no approved template for the
intent, or no payment link where the copy needs one — and a refusal is a **skip,
never a partial send**. "Pay here: " with nothing after it is worse than silence.

There are **9 templates**, one per message intent, all category UTILITY. The
moment one carries a discount it becomes MARKETING: different consent, worse
delivery, higher cost. None mentions one.

### Two channels, and only two

WhatsApp and email. A ladder cannot name anything else: the policy schema
validates a rung's `channels` against `SENDABLE_CHANNELS`, so `sms` is a build
failure rather than a runtime shrug.

That check exists because the alternative was invisible. Eighteen rungs across
the table listed `sms`, there has never been an SMS client (transactional SMS in
India needs DLT registration of the sender and every template), and the failure
mode was silent: `send.ts` answered `no_channel`, `selectChannel` fell through
to the next entry, and a rung whose only channel was `sms` reported "no eligible
channel" and lost the touch. Worse, `gatherFacts` counted `sms` as an eligible
channel, so a customer with a phone number and no email passed
`channel_deliverable` and was never actually reachable.

### Fanout: one rung, two channels

Most rungs pick **one** channel from the policy's preference list. A rung marked
`fanout: true` sends on **every** eligible channel at once, inside a single gate
decision.

This exists for `customer_input`. That class is belt-and-braces by design — the
customer is looking at a failed checkout, so they get WhatsApp *and* the same
link in their inbox while they still care. Expressed as two rungs it never
worked: a second rung is a second gate evaluation, and the live-attempt lock and
the cool-off both apply again, so the "pair" arrived about three minutes apart
on a real account and could arrive much later, or never.

One rung means one gate decision. Deferral can still move the pair; it can no
longer split it.

Each channel keeps its own `message_log` row and its own idempotency key, so the
ledger stays truthful about how many messages a person received — and the
compiler counts a fanout rung as its channel count against `maxMessages` and the
class ceiling, not as one. **The per-person daily cap counts messages, so a pair
spends two slots at once.**

---

## One way a rung runs and still does not send

- **holdout** — a real control group. Runs the identical ladder through the
  identical gate, sends nothing, and is the only honest way to know what the
  treatment was worth. Cohort assignment is deterministic and stable under rate
  changes, so historical numbers stay valid.

Suppression happens **after** the gate on purpose, so a holdout case is gated
identically to a treatment case and the two groups stay comparable.

There used to be a second reason, `dry_run`, for a merchant who had not switched
sending on. It went with the three-state send mode: an account is now paused or
live, and a paused account never reaches the executor at all — the gate parks
the case first. Keeping the two apart mattered while both existed, because a
dry-run case is not a control, it is a case nobody was ever treated in.

A new merchant sends nothing: `execution_enabled: false` is the database
default, and that means PAUSED.
