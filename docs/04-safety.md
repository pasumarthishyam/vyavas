# Safety and guarantees

What must never happen, and what stops it. Almost none of these are enforced by
application care — they are enforced by Postgres, by the type system, or by a
compiler that refuses to build.

---

## Enforced by the database

| Guarantee | Mechanism |
|---|---|
| One live case per order | Partial unique index on live states |
| A replayed rung never fires twice | Unique `idempotency_key` on actions and messages |
| A retried webhook is a no-op | `ON CONFLICT DO NOTHING … RETURNING` on the event id |
| A customer is never messaged twice at once | `pg_advisory_xact_lock` keyed on the person |
| The cap is global per person, not per case | `message_log` keyed on `customer_id` |
| Holdouts don't eat the treatment budget | Partial index excluding suppressed rows |
| One open alert per condition | Partial unique index on unresolved alerts |
| One escalation per rung | Unique `idempotency_key`, same format as the action row |
| One pending taxonomy proposal per reason | Partial unique index on `status = 'pending'` |
| A new merchant sends nothing | `dry_run: true`, `execution_enabled: false` by default |

`npm run db:doctor` checks each of these **by name** and prints what breaks in
the real world if one is missing. It exists because "migrations applied
successfully" is not the same as the constraints being there: a partial index
silently omitted still lets every INSERT through, and the first symptom would be
a customer receiving two recovery ladders for one order.

### One key format, one function

`messageKey()` is the only place an idempotency key is built, and that matters
more than it looks. The console's manual path once composed its own key as
`caseId:rung:channel` while the ladder used `caseId:rung:kind`. Both were
reasonable, neither ever collided with the other, and the duplicate guard was
therefore **inert across the one boundary where it had to hold** — the ladder
would send a rung and a human pressing Start would send it again, to the same
person, both recorded as first touches.

A key format that lives in two places is a key format that will disagree.

---

## Enforced by the compiler

`compilePolicyTable()` refuses any table that could instruct the agent to do
something indefensible. Every check below failed CI at least once while the
table was being written; none of them would throw at runtime — they would just
quietly reach a real person.

- A ladder exceeding its cause class's **touch ceiling**
- A nudge landing **before the class floor**
- `retry_same` on an instrument the class says can never work
- A `retry_debit` on an **attended** case, or without a preceding RBI pre-debit
  notice, or without requiring `mandate_active`
- A customer-facing row that does not abort on `order_paid` or
  `customer_optout`, or does not re-check `order_unpaid` before each rung
- Two rows whose winner would depend on **declaration order**
- Any cause class with no policy row
- A missing catch-all, or a catch-all that contacts a customer
- A merchant-alert row that is `holdoutEligible` — withholding a breakage alert
  to measure incrementality would be indefensible
- Non-increasing rung offsets, which would silently reorder the ladder

**The governing rule:** *a policy may tighten a safety limit, never loosen one.*
Cause-class traits are the ceiling; policy rows live under them.

`effectiveRails()` is the runtime counterpart: where the static table and the
live diagnosis disagree, the diagnosis wins and may only ever **remove** rails.
A policy can never re-authorise something the diagnosis has ruled out.

### Counting messages, not rungs

A `fanout` rung sends on every eligible channel at once, so the compiler counts
it as its **channel count** against `maxMessages` and the class ceiling. Counting
it as one would let a row declare `maxMessages: 2` and legally send four, with
the ceiling cross-check reporting everything within limits.

---

## Enforced by the type system

**The action allowlist.** `core/actions/types.ts` is a closed union — the entire
vocabulary of things the agent can do in the world. The planner may only emit a
value of this type; it never gets a generic handle on the Razorpay API. Bounded
autonomy as a type, not as a prompt.

**Money is integer paise, branded.** `amount + 0.5` is a compile error. Never a
float, anywhere.

**`attended` is `NOT NULL`.** Under RBI rules there is no third option, so the
column cannot express one.

**The core boundary.** ESLint forbids `src/core` from importing `db`,
`adapters`, `workflows` or `app`, from importing Node built-ins, and from calling
`new Date()`, `Date.now()` or `Math.random()`. Time is an input, never an
ambient fact.

---

## The non-negotiables

- **Money is integer paise.** Never a float. Anywhere.
- **`attended` is decided explicitly on every case.** Getting this wrong is a
  compliance incident, not a bug.
- **`order_already_paid` closes the case and cancels everything queued.**
  Messaging a customer who has already paid is the one mistake that ends the
  relationship.
- **A deliberate exit is never dressed as a failure.** `payment_cancelled` is a
  live intent signal; it gets its own case type and never sees failure language.
- **Risk declines get one touch on one alternate rail.** Re-presenting raises the
  risk score and degrades the merchant's authorisation rate.
- **Merchant-fault classes alert the merchant with facts, not prescriptions.**
  Turning off a payment method is their commercial decision.

---

## Privacy

### At the query layer, never the template

The rule, stated in the code: *a support screenshot should never carry a full
phone number, and relying on each view to remember that is how one eventually
does not.*

So masking happens on the way **out of the query layer**:

- Phone numbers and emails are masked on the case table.
- The **audit trail never selects `message_log.body`** — the rendered message
  contains the customer's first name, the amount, and the payment link. Columns
  are named explicitly rather than `select()`, so that is a decision rather than
  something one refactor away from being undone.
- Every free-text field the trail renders passes through `redact()`.

### Why redaction is necessary at all

Almost everything the audit trail displays is text **we did not write**:

- `message_log.error` is the provider's sentence, and Meta and Resend both echo
  the recipient back inside failure messages.
- Event payloads carry a payment link on the events that created one — and a
  Razorpay short link is a **per-customer bearer URL**. Anyone who reads it can
  open that customer's checkout.
- Provider payloads change without warning. A field that holds nothing sensitive
  today can hold a name tomorrow, and nothing would fail.

`redact()` masks emails (keeping the domain — a run of failures to one domain is
a real deliverability signal), masks 10–13 digit runs in any format, and reduces
URLs to their host. It is deliberately blunt: it would rather mask a harmless
order id than let one real number through.

Two things it must **not** do, both pinned by tests:

- **Mangle a case id.** `27977061-2670` is twelve digits with a separator and
  matched the phone pattern, which chewed the front off every UUID in the trail.
  The id is what a reader copies to look a case up.
- **Mask short digit runs.** Amounts, HTTP codes, rung offsets and provider error
  codes are all short digit runs, and masking them makes the trail unreadable to
  protect nothing.

### Live-message routing is per merchant

Where a message actually lands is read from the **merchant's own routing
columns**, the same ones the senders read — not from environment variables. An
env-based banner could report a diversion the sender was not applying, which is
worse than showing nothing. A sandbox merchant can divert while a live merchant
does not, both in production.

The `WHATSAPP_REDIRECT_TO` test escape hatch is deliberately refused when
`NODE_ENV=production`: a diversion left on in production would silently send
every customer's message to one phone.

---

## What is deliberately *not* guaranteed

Worth stating, so nobody assumes otherwise:

- **The console's poll is the scheduler for its own follow-ups.** Close the page
  and a pending console follow-up waits rather than firing. That is honest for a
  test surface and stated in the UI. The real ladder uses Inngest, which does not
  care whether anyone is watching.
- **Incrementality is not reported until there is treatment volume.** While
  nothing sends, the two cohorts received identical treatment, so any difference
  between them is noise.
- **A Claude failure is invisible except through provenance.** Every AI job fails
  soft by design. `briefSource`, the alert detail suffix, and the console's AI
  badge are the only things that distinguish a working integration from a dead
  one — which is why they exist.
