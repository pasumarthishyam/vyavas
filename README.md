# Vyavas

**An AI revenue-recovery agent for merchants on Razorpay.**

A payment fails, a checkout is abandoned, a customer walks away with a full
cart. Vyavas notices, works out *why*, and runs a bounded recovery workflow —
the right message, on the right channel, at a defensible time, or a phone call
that may offer a discount it is not allowed to exceed.

Every decision it makes is recorded. Every limit it operates under is enforced
by code or by the database, not by a prompt.

```
Next.js 15 · React 19 · TypeScript · Drizzle + Postgres (Supabase, ap-south-1)
Inngest (durable workflows) · Razorpay · WhatsApp Cloud API · Resend · Vapi
Claude (claude-sonnet/Opus-5) via the Anthropic SDK
```

---

## Contents

- [The one idea](#the-one-idea) · [The one rule](#the-one-rule)
- [The three agents](#the-three-agents)
- [How a recovery actually happens](#how-a-recovery-actually-happens)
- [Architecture](#architecture)
- [The policy ladder](#the-policy-ladder)
- [What guards the agent](#what-guards-the-agent)
- [Where the AI is, and where it is not](#where-the-ai-is-and-where-it-is-not)
- [The audit trail](#the-audit-trail)
- [Pause and Live](#pause-and-live)
- [Run it on your laptop](#run-it-on-your-laptop)
- [Testing it with no real failures](#testing-it-with-no-real-failures)
- [Command reference](#command-reference)
- [Things that will bite you](#things-that-will-bite-you)
- [Non-negotiables](#non-negotiables)

---

## The one idea

Failed payments, checkout drop-off, failed subscriptions and overdue
receivables look like four products. They are one object:

> **A known customer, with known intent, owes a known amount, and something
> broke.**

That object is a `RecoveryCase`. The engine is built once; sources are added to
it. An abandoned cart and a declined card enter through different doors and then
travel the same rails — the same frequency cap, the same quiet hours, the same
ledger, the same console.

## The one rule

Most of the design falls out of a single asymmetry:

> **A message we failed to send costs one order. A message sent to someone who
> already paid costs the relationship.**

That is why the order state is re-fetched from Razorpay before *every* customer
touch instead of being read from our own row, why the gate distinguishes
*abort* from *defer*, why a policy may tighten a safety limit but never loosen
one, and why Claude is kept away from every decision about whether to contact
a human being.

---

## The three agents

Three agents share one spine: one customer table, one message ledger, one
frequency cap, one pause switch, one audit trail. They differ in what wakes
them and what they are allowed to do.

| | **Failed Payment Agent** | **Abandoned Cart Agent** | **Discount Caller Agent** |
|---|---|---|---|
| **Console** | `/recovery` | `/agents/abandoned-cart` | `/agents/discount-caller` |
| **Woken by** | Razorpay `payment.failed` webhook | The merchant's own app, via an authenticated webhook | A person, from the console |
| **What it does** | Diagnoses the failure, resolves a ladder, sends nudges and payment links over hours | Issues a flat ₹200 discount link and emails it | Places a voice call and may negotiate a discount |
| **Channels** | WhatsApp, email | Email only | Voice (telephony or in-browser WebRTC) |
| **Autonomy** | Fully automatic once a case exists | Fully automatic per reported cart | Never automatic — a human starts every call |
| **Hard ceiling** | ≤ 4 touches, set by cause class | One email per cart | 2 calls per case; ₹500 and 30% of order |
| **Money it can move** | None | ₹200 flat, capped at 30% of the cart | Tiered ₹200 → ₹500, capped at 30% |

**Why the caller is a separate agent and not a rung.** It is the only surface in
the product that can move a price, and it is the most intrusive thing the system
does. It gets its own page, its own credentials, its own call ceiling, and it
inherits nothing by accident from the messaging config sitting next to it.

---

## How a recovery actually happens

```
  Razorpay                 merchant's app              a person
  payment.failed           cart abandoned              clicks "Call"
       │                        │                            │
       ▼                        ▼                            ▼
  ╔═══════════════════════════════════════════════════════════════════╗
  ║  1. VERIFY   HMAC-SHA256 over the raw bytes / bearer key / Vapi   ║
  ║              secret. An unsigned delivery never reaches step 2.   ║
  ╚═══════════════════════════════════════════════════════════════════╝
       │
  ╔═══════════════════════════════════════════════════════════════════╗
  ║  2. CLAIM    ON CONFLICT DO NOTHING … RETURNING on the event id.  ║
  ║              Razorpay delivers at least once; this makes the      ║
  ║              second delivery a no-op instead of a second message. ║
  ╚═══════════════════════════════════════════════════════════════════╝
       │
  ╔═══════════════════════════════════════════════════════════════════╗
  ║  3. NORMALIZE   (reason, source, step, method) → a routing tuple. ║
  ║  4. DIAGNOSE    tuple + context → one of 9 cause classes, plus    ║
  ║                 rails: may we retry the same instrument? may we   ║
  ║                 contact the customer? is this attended?           ║
  ║  5. RESOLVE     the compiled policy table picks a ladder, most-   ║
  ║                 specific-wins. The chosen row is STAMPED on the   ║
  ║                 case, so it replays identically forever.          ║
  ║  6. PERSIST     one live case per order (partial unique index).   ║
  ╚═══════════════════════════════════════════════════════════════════╝
       │  publish case/diagnosed
       ▼
  ╔═══════════════════════════════════════════════════════════════════╗
  ║  7. THE LADDER — a durable Inngest run, one per case.             ║
  ║                                                                   ║
  ║     for each rung:                                                ║
  ║        sleepUntil(rung.delay)        ← survives deploys           ║
  ║        gatherFacts()                 ← re-read the world          ║
  ║        evaluatePreconditions()       ← proceed│defer│abort│paused ║
  ║        executeRung()                 ← compose, lock, send        ║
  ║                                                                   ║
  ║     Every step is memoised. A retry replays a completed step;     ║
  ║     it does not re-send the message.                              ║
  ╚═══════════════════════════════════════════════════════════════════╝
       │
       ├─ order.paid / payment_link.paid → case closed, everything queued cancelled
       ├─ gate says abort               → case closed with the reason recorded
       ├─ ladder exhausted              → deadline sweep closes it
       └─ escalate_to_human             → a queue row with a written brief
```

Two backstops run on a 15-minute cron, because a workflow that has already
returned cannot clean up after itself:

- **`sweep-deadlines`** closes cases past their intent deadline, confirms
  payment links, redrives stranded webhook deliveries, and resumes merchants.
- **`sweep-abandoned-carts`** asks Razorpay directly whether each pending cart
  link has been paid. Cart links have no original order to match back to, so
  nothing else would ever close them.

---

## Architecture

```
src/
├── core/         ◄── THE BRAIN. Pure: no I/O, no clock, no randomness.
│   ├── money.ts       Integer paise, branded — `amount + 0.5` is a type error
│   ├── case/          Types, state machine, intent-decay deadlines
│   ├── taxonomy/      44 failure reasons → 9 cause classes → diagnose()
│   ├── policy/        YAML ladder table, compiler, most-specific-wins resolver
│   ├── guards/        The gate, discounts, quiet hours, call limits, resume
│   └── limits.ts      Hard bounds on every per-merchant dial
│
├── db/           Drizzle + Postgres. 17 tables, 12 migrations, driver-agnostic repos
├── adapters/     razorpay · whatsapp · email · vapi · claude  (thin, no business logic)
├── ingest/       normalize → diagnose → resolve → persist, as a plain function
├── messaging/    compose (pure) and send (locks, caps, ledger)
├── workflows/    Inngest orchestration. Sequences steps; decides nothing.
├── ops/          Human-in-the-loop jobs: escalations, alerts, triage, self-audit
├── components/   The console
├── app/          Next.js App Router — pages, API routes, webhooks
└── middleware.ts The session gate. Its location is part of the feature.
```

### The boundary rule

`src/core` may not import from `db`, `adapters`, `workflows` or `app`. It may
not call `new Date()`, `Date.now()` or `Math.random()`. Every function takes
what it needs as an argument and returns a decision.

**This is enforced by ESLint, not by convention.** Two consequences, and they
are the entire point:

1. **The brain is testable with zero infrastructure.** "9:04pm IST on a Sunday
   during an ICICI netbanking outage, third attempt, mandate present" is a table
   row in a test file, not a staging environment.
2. **Nothing built later can break what is built now.** Nothing downstream can
   import into core, so the parts that decide whether a human gets messaged
   cannot acquire a dependency on the parts that change weekly.

---

## The policy ladder

**What the ladder is.** A sequence of rungs — *wait this long, then do this
thing, on these channels, unless one of these conditions holds.* One ladder per
kind of failure. A typo in a card number and a bank outage should not get the
same email at the same interval, and on most dunning tools they do.

**Where it is written.** As YAML, one file per cause class, in
[`src/core/policy/table/`](src/core/policy/table/):

```yaml
# customer-input.yaml — a typo. The highest-recovery class in the taxonomy:
# intent is proven, the fix takes seconds, and they are often still on the page.
- id: customer_input.default
  version: 1
  match:
    causeClass: [customer_input]
    attended: true
  ladder:
    - at: 0m
      action: nudge
      channels: [whatsapp, email]
      fanout: true            # one gate decision, so the pair cannot be split
      intent: switch_method
  preconditions:
    [order_unpaid, no_live_attempt, consent_ok, not_quiet_hours,
     within_frequency_cap, channel_deliverable]
  abortOn: [order_paid, payment_link_paid, customer_optout, deadline_passed]
  maxMessages: 2
  holdoutEligible: true
```

Each file is heavily commented with the reasoning behind its numbers — the one
above carries about sixty lines explaining why the two channels fire on a single
rung rather than five minutes apart, and what that costs against the daily cap.
The argument lives next to the rule.

YAML rather than code for one reason: **this table is the part a non-programmer
has to be able to read and argue with.** It is the product's judgement about how
often a stranger may be messaged, and that judgement should be reviewable in a
pull request by someone who does not write TypeScript.

**How it becomes safe.** `npm run policy:build` compiles all 27 rows into a
frozen artefact (`core/policy/generated.ts`), and the compiler *refuses* any
table that could instruct the agent to do something indefensible:

- a ladder exceeding its cause class's touch ceiling
- a nudge landing before the class's cool-off floor
- `retry_same` on an instrument that can never work again
- a silent debit on an attended case, or without RBI pre-debit notice
- a customer-facing rung that does not abort on `order_paid`
- two rows whose winner would depend on declaration order

A bad edit fails `npm run verify` at build time, not at 3am against a real
customer. `npm run policy:check` fails CI if the committed artefact is stale.

**The governing rule: a policy may tighten a safety limit, never loosen one.**
Cause-class traits are the ceiling; policy rows live underneath them.
`effectiveRails()` is the runtime counterpart — where the static table and the
live diagnosis disagree, the diagnosis wins and may only ever *remove* rails.
A policy can never re-authorise something the diagnosis has ruled out.

---

## What guards the agent

### The gate, re-run before every rung

A case sleeps for hours between rungs and the world moves while it does. So
`evaluatePreconditions()` runs again immediately before each one — never once
when the ladder starts — and returns one of four dispositions.

| | Meaning | Examples |
|---|---|---|
| **proceed** | Send it. | — |
| **defer** | True *right now*, will stop being true. Names the exact instant to retry. | Quiet hours, a live attempt in flight, today's frequency cap |
| **abort** | Will never stop being true, or acting would be wrong whenever we did it. Terminal. | Order paid, recovery link paid, customer opted out, deadline passed |
| **paused** | The merchant pressed pause. Park the case; do not destroy it. | — |

Getting abort and defer backwards is expensive in both directions. Deferring an
abort eventually messages someone who already paid; aborting a defer throws away
a recoverable case because we happened to look at 11pm.

`paused` had to become its own disposition. It was originally treated as an
abort, which destroyed every in-flight case the moment anyone pressed the
switch, and turning the account back on recovered none of them.

### The limits, and who enforces them

| Limit | Default | Enforced by |
|---|---|---|
| Messages to one person, rolling 24h | 2 | `message_log` keyed on `customer_id`, clamped to ≤ 10 |
| Minimum gap between two messages | 15 min | `minGapMinutes`, a hard floor in the gate |
| Quiet hours, merchant-local | 21:00 – 08:00 | `quiet-hours.ts`, with one narrow live-customer exemption |
| Touches per case | ≤ 4 | The cause class's ceiling, checked at policy compile time |
| Voice calls per case | 2 | `call-limit.ts`, checked *before* the browser dials |
| Discount ceiling | ₹500 and 30% of order | `discount.ts` — the model reads the number, never computes it |
| Holdout cohort | 5% | Deterministic assignment, stable under rate changes |
| A new merchant sends nothing | — | `execution_enabled: false` by default, which means **paused** |

`core/limits.ts` exists because a `smallint` column accepted `frequency_cap_per_day = 1000`
during testing, and that sat in production for weeks with nothing to notice it.
Dials are now clamped **on read**, so the stored value stays visible for what it
is and the behaviour is safe regardless. **A dial may make a limit stricter than
the code's default; it may loosen one only as far as the code says is still
defensible.** Wanting to go further is legitimate — it just has to be a diff
with a reviewer, not an `UPDATE` statement.

### The guarantees Postgres enforces, not application care

| Guarantee | Mechanism |
|---|---|
| Only signed-in people reach the console | HMAC-verified session cookie, checked in middleware |
| A user only ever sees their own merchants | `merchant_members` join on every merchant lookup |
| One live case per order | Partial unique index on live states |
| A replayed rung never fires twice | Unique `idempotency_key` on actions and messages |
| A retried webhook is a no-op | `ON CONFLICT DO NOTHING … RETURNING` on the event id |
| A customer is never messaged twice at once | `pg_advisory_xact_lock` keyed on the person |
| The cap is global per person, not per case | `message_log` keyed on `customer_id` |
| Holdouts don't eat the treatment budget | Partial index excluding suppressed rows |
| One open alert per condition | Partial unique index on unresolved alerts |
| A paid recovery link closes its case | `payment_link.paid` resolved by `reference_id` |

`npm run db:doctor` asserts each of these by name, because "migrations applied
successfully" is not the same as the constraints being present. A silently
omitted partial index still lets every `INSERT` through, and the first symptom
would be a customer receiving two recovery ladders for one order.

### The action allowlist

`core/actions/types.ts` is the complete vocabulary of things the agent may do:

```
nudge · create_payment_link · expire_payment_link · retry_debit
send_pre_debit_notice · merchant_alert · await_downtime_resolution
escalate_to_human · close_case · no_op
```

The planner emits a value of this union and nothing else. **It never gets a
generic handle on the Razorpay API.** Bounded autonomy expressed as a type
rather than as a paragraph in a prompt.

---

## Where the AI is, and where it is not

Vyavas uses **Claude (`claude-opus-5`)** through the official Anthropic
TypeScript SDK, in `src/adapters/claude/`. One rule holds across every job:

> **Claude reads a structured trace and returns a small structured judgement
> that a human or a deterministic guard consumes. It never chooses whether to
> contact a customer, never sets a safety limit, and never mutates the
> taxonomy.**

### The four jobs

| Job | Input | Output lands in | If the model is down |
|---|---|---|---|
| **Merchant alert prose** | A counted cluster of failing cases | `merchant_alerts` | Deterministic title + facts |
| **Escalation brief** | One case's tuple, rationale and full ledger | `escalations` | A brief naming cause, money, activity |
| **Unknown-reason triage** | Sampled tuples for a reason we don't recognise | `taxonomy_proposals`, always *pending* | The job reports it could not run |
| **Ledger self-audit** | Failure buckets counted in SQL | A terminal report | Buckets ranked by money |

### What makes that safe rather than decorative

- **Nothing is load-bearing.** `ANTHROPIC_API_KEY` is optional. Every job has a
  deterministic fallback that is a *supported path*, not a stub, and `ask()`
  returns a `Result` rather than throwing. A model failure downgrades the prose,
  never the recovery.
- **The model never counts.** Every number in an alert or an audit finding is a
  SQL aggregate computed *before* the call and passed in as fact. The prompts
  forbid introducing a figure that is not in the input. A model that invents
  "roughly 50 cases" in an alert a merchant acts on is worse than no alert at
  all, and the fix is not a better prompt — it is not asking it to count.
- **Severity is the policy's.** Whether a condition is `warning` or `critical`
  decides whether a person is woken at 2am. That lives in a reviewed YAML table,
  not in a paragraph generator's judgement on the night.
- **Every output is validated twice** — the API enforces a JSON schema, and the
  caller re-validates with zod. Output that does not match is `invalid_output`
  and takes the fallback path, exactly like the model being unreachable.
- **Which one you got is recorded.** `briefSource` and the alert detail say
  whether the model wrote it or the fallback did, so a week of nothing but
  fallbacks is discoverable rather than merely disappointing.

**The taxonomy boundary is absolute.** There is deliberately no code path from
an accepted `taxonomy_proposals` row to a change in `codes.ts` or `diagnose.ts`.
Accepting a proposal means a person opens an editor and writes the rule by hand,
with a golden fixture, like every other entry. The taxonomy is the safety
ceiling for the whole agent — `sameInstrumentRetry` and `contactCustomer` are
derived from the cause class — so a wrong class there does not produce a badly
worded message. It produces a customer's card locked at the issuer after a third
automated retry.

### Where Claude is deliberately absent

- **`compose.ts`** — the intent already determines the template, the language is
  a lookup, and every variable is a projection of the case. There is no
  judgement left to make, and WhatsApp templates are pre-approved by Meta
  anyway, so improvised copy is unsendable.
- **`preconditions.ts`** — a safety limit is a comparison. A model that is right
  99% of the time still double-messages someone once every hundred runs. `<`
  does not.
- **`diagnose.ts`** — 44 documented codes with an exhaustive golden suite
  already beat a model, and they replay identically forever.
- **`discount.ts`** — the voice agent *says* a number the guard returned. There
  is no path from a live conversation to a figure this pure function did not
  produce, which is what makes "the AI can offer up to ₹500" a guarantee rather
  than a prompt asking a model to behave.

### Proving the AI is actually working

Failing soft is right, and it makes a dead integration look exactly like a quiet
one. Three ways to tell them apart, cheapest first:

1. **The console.** `/recovery` → **Needs a person**. Every brief carries a
   badge: `Claude · high` when the model wrote it, `Fallback` when it did not —
   hover for the reason. The panel header shows the running count and turns red
   if every brief has fallen back.
2. **End to end, on a real case.** `npm run queue -- --escalate=<caseId>` reads
   that case's real ledger, asks Claude for a brief and writes the queue row —
   the exact path a policy rung takes, minus the waiting. Nobody is contacted.
3. **All four jobs.** `npm run ai:smoke`.

`ai:smoke` exists for a specific reason: `output_config.format.schema` accepts
only the structural half of JSON Schema — `maxItems`, `maxLength` and `minimum`
are all 400s — and TypeScript, zod and the unit tests all say yes to a schema
the API rejects. In production that 400 becomes a fallback, and a fallback looks
exactly like "no API key set". One live run is the only thing that separates
them.

---

## The audit trail

**Everything is append-only, and the trail includes the AI's own actions.**

### Four tables

| Table | Holds | Why it exists separately |
|---|---|---|
| `case_events` | Every state change and decision, with `actor` (`workflow` / `webhook` / `merchant:<id>` / `system`), a reason, a JSON payload and a timestamp | The narrative. Append-only; nothing updates a row here |
| `case_actions` | Every action the agent *planned*, and what became of it — `planned` / `executed` / `skipped` / `failed` / `suppressed` | Holdout cases write full rows here with nothing sent. That record is what makes the incrementality number honest rather than a claim |
| `message_log` | Every message, its channel, its idempotency key, its provider status, and who it was *for* | The frequency cap reads this. It is keyed on the customer, so the cap is global per person rather than per case |
| `webhook_events` | Every delivery, claimed before processing | Makes at-least-once delivery safe to receive twice |

### The event vocabulary

Every kind the system persists, mapped to one of three lanes in
`EVENT_CATEGORY`:

```
system    detected · diagnosed · state_changed · payment_received
          aborted · ladder_complete
decision  recovery_started · rung_fired · rung_deferred · rung_aborted
          rung_abandoned · rung_uncomposable · payment_link_created
          rung_paused · ladder_paused
ai        escalated · merchant_alerted
```

This is a **complete map, not a filter**, and a golden test fails if an event
kind is added to the system without a lane here. An unrecognised kind still
renders — it falls to `system` rather than vanishing.

That inversion was a bug fix. The old version was a short allowlist that
silently dropped a third of the kinds that reach the database, including
`payment_received` (the moment the money arrives) and both events the Claude
jobs write. *An audit trail that omits the AI's own actions is not an audit
trail.*

### What you actually see

- **Overview** — recovered amount, recovery rate, written off, failure classes,
  open alerts, the Live/Paused switch, and a card per agent.
- **Failed Payment Agent (`/recovery`)** — revenue at risk, cause-class
  breakdown, the **Needs a person** queue with its Claude/Fallback badges, and a
  recent-activity feed.
- **Cases (`/cases`)** — every case, filterable, with its state and cause class.
- **Case detail** — the raw failure tuple, the diagnosis rationale in plain
  language, **the exact ladder that was stamped on it**, and the full
  append-only timeline with its entry count shown honestly.

The activity feed reads `case_events` **and** `message_log`, not just the
latter. When the gate defers every rung nothing is ever written to
`message_log`, so a feed reading messages alone showed "Nothing sent yet" while
`case_events` held four precisely timestamped `rung_deferred` rows naming the
frequency cap and the exact instant it would clear. The data was always there;
the feed simply never looked at it.

That case-detail ladder view is also what makes this shippable before a merchant
grants write access to anything: **they can see exactly what the agent would
say, to whom, and when, before it is allowed to say it.**

---

## Pause and Live

One switch, on the Overview page, applying to all three agents.

**Pause is not a kill switch that discards work.** Cases in flight are parked in
`paused` with a `ladder_paused` event on the timeline, and the case row shows
*why* it is sitting still rather than appearing to have stopped for no stated
reason.

**Going live asks first.** Resuming does not silently fire a week of parked
messages at people. An overlay appears every time — including when there are
zero parked cases, so the control behaves the same way regardless of state — and
tells you exactly how many cases would resume.

**Cases older than three days are never resumed.** If someone paused the account
for a week, the customer who failed on day one has moved on; emailing them about
it because an operator happened to unpause is worse than not emailing them at
all. `classifyPausedCase()` sorts each parked case into `resume`, `too_old` or
`past_deadline`, and the overlay shows the split before you commit.

**The abandoned-cart agent behaves differently on purpose.** A cart that arrives
while paused is *recorded* and nothing is sent, and going live does not go back
for it. The merchant's app fires that webhook once per cart, and the same
staleness argument applies with no ladder to park.

```bash
npx tsx scripts/merchant.ts mode --slug <merchant> --set paused
npx tsx scripts/merchant.ts mode --slug <merchant> --set live
```

---

## Run it on your laptop

### 0. What you need

- **Node 20+**
- **A Postgres database.** Supabase is what this runs on (project in
  `ap-south-1`), but any Postgres 15+ works.
- **A Razorpay account in TEST mode.** Free. Dashboard → Account & Settings →
  API Keys.
- Optional: Resend (email), WhatsApp Cloud API, Vapi (voice), an Anthropic API
  key. **All four are optional** — the system runs without them and reports
  honestly that it had no channel, rather than pretending it sent something.

### 1. Install and configure

```bash
git clone <this repo> && cd Vyavas_AIrecovery
npm install
cp .env.example .env.local
```

Fill in `.env.local`. The three that matter to get *anything* running:

```bash
DATABASE_URL="postgresql://…:6543/postgres"          # POOLED, port 6543
DIRECT_DATABASE_URL="postgresql://…:5432/postgres"   # DIRECT, migrations only

# 32 bytes, base64. Wraps Razorpay secrets before they touch the database.
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
ENCRYPTION_KEY="…"

# Signs the session cookie. Without it the app refuses EVERY request.
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
SESSION_SECRET="…"

INNGEST_DEV="1"          # required locally; never set in production
```

Then Razorpay test keys (`RAZORPAY_API_KEY`, `RAZORPAY_API_SECRET`,
`RAZORPAY_WEBHOOK_SECRET`) and, if you want them, `RESEND_API_KEY` +
`EMAIL_FROM`, the four `WHATSAPP_*` variables, the `VAPI_*` set, and
`ANTHROPIC_API_KEY`. Every variable the app reads is declared and documented in
[`src/lib/env.ts`](src/lib/env.ts), validated with zod at boot — a missing
secret fails loudly at startup rather than at 2am, three layers down.

**`SESSION_SECRET` unset means the app is shut, not open.** No token can be
verified, and the safe reading of that is "nobody is signed in", never
"everybody is".

### 2. Create the schema

```bash
npm run db:migrate     # apply migrations (uses DIRECT_DATABASE_URL, port 5432)
npm run db:doctor      # assert the guarantees are actually present
```

`db:migrate` is quiet on success, so an apparently empty finish is the expected
one. It also prints two `NOTICE` blocks on every run after the first —
`42P06 schema "drizzle" already exists` and `42P07 relation "__drizzle_migrations"
already exists`. Those are drizzle-kit creating its bookkeeping with
`IF NOT EXISTS`. `severity: 'NOTICE'` is the tell; a real failure raises
`severity: 'ERROR'` and a non-zero exit code.

### 3. Get an account

The console is behind authentication and **there is no sign-up page anywhere in
the app** — a public URL with a sign-up form is a public URL anyone can get an
account on. Accounts are provisioned from a trusted machine with
`npm run user`; run it with `--help` for the arguments.

### 4. Load data and start

```bash
npm run seed:demo -- --reset     # 320 cases, through the REAL pipeline
```

The seed calls `processEvent` — the same function the webhook route calls — so
the console shows data the system genuinely produced, and seeding doubles as an
end-to-end smoke test against your database.

Then **two terminals**, and you need both or no rung ever fires:

```bash
INNGEST_DEV=1 npm run dev        # terminal 1 → http://localhost:3000
npm run dev:inngest              # terminal 2 → the local Inngest executor
```

Check the wiring with `curl localhost:3000/api/inngest` — you want
`"mode":"dev"` and a non-zero `function_count`. Without `INNGEST_DEV=1` the SDK
defaults to cloud mode, refuses to serve without a signing key, answers 500, and
**no ladder ever runs** — which looks exactly like a gate that deferred.

### 5. Verify your checkout before you trust it

```bash
npm run verify    # policy:check + typecheck + lint + test
```

That is the gate. It must be green.

---

## Testing it with no real failures

You cannot test a recovery agent without a failed payment, and Razorpay will not
fail one on request. Test mode gives you declining cards, but driving a checkout
by hand for every scenario is slow, and several of the interesting cases — a
bank outage, a risk decline, a third wrong OTP — cannot be produced from a card
number at all.

```bash
npx tsx scripts/simulate.ts --list                                   # every scenario
npx tsx scripts/simulate.ts --slug sandbox --scenario card_expired   # make a case
npx tsx scripts/simulate.ts --slug sandbox --order <orderId> --paid  # close it
npx tsx scripts/simulate.ts --slug sandbox --link-paid --reference <caseId>
```

That signs a real Razorpay-shaped payload with the merchant's **own** stored
webhook secret and POSTs it to the merchant's **own** endpoint. Nothing is
stubbed and nothing is bypassed: the signature is verified, the delivery is
claimed and deduped, the tuple is normalised, `diagnose()` runs, a policy row is
stamped, the case is created and the ladder is published. It is the path a live
delivery takes, because it *is* that path.

Two rails on it. It **refuses any merchant connected in live mode** — a
fabricated failure on a live account creates a real case about a customer whose
payment never failed, and the agent will then message them. And it never writes
to the database directly; a script that inserted cases would prove the console
renders and nothing else.

Watch `/recovery`: the case appears with its cause class and stamped ladder, the
rungs fire, and closing it moves the **Recovered** tile. `--link-paid` is the
one worth exercising deliberately — paying a recovery link is the outcome the
whole product exists to produce, and the path most likely to regress.

**Use `npx tsx`, not `npm run`, for anything that takes flags.** On PowerShell
npm claims `--slug` as one of its own boolean options, sets `npm_config_slug=true`
and passes the bare value through as a positional — so the script reads `true`
as the merchant name and reports `No merchant 'true'`. The scripts detect this
and print the working command, but the direct form always works.

**Holdout is on at 5% by default.** Roughly one simulated case in twenty will
deliberately send nothing and be marked `holdout`. If a case sits there having
done nothing, check that before anything else. Set `holdout_basis_points` to 0
on a test account.

### The tests

783 tests across 44 files. Database tests run against **PGlite** — real Postgres compiled to
WASM, in-process — so `npm test` exercises partial unique indexes, `ON CONFLICT`,
native enums and advisory locks with no external database to start. PGlite is
single-connection, so the contention proofs live in
`tests/db/concurrency.integration.test.ts` and run against a real Postgres when
`TEST_DATABASE_URL` is set.

Two files carry more weight than the rest:

- `tests/golden/fixtures.ts` — one fixture per error code, plus scenarios for
  downtime, attempt history and mandates.
- `tests/golden/exhaustiveness.test.ts` — **fails CI if any code lacks a
  fixture**, if two rules tie ambiguously, or if any reachable tuple produces an
  inconsistent diagnosis. It brute-forces the entire
  reason × source × step × method space.

That second file is what makes the taxonomy *finished* rather than merely
written. It is the thing standing between this and the fate of every dunning
tool on the market: a dozen codes handled properly and a generic email for
everything else.

---

## Command reference

```bash
# The gate
npm run verify            # policy:check + typecheck + lint + test
npm run typecheck · lint · test · test:watch · test:coverage
npm run test:integration  # concurrency proofs — needs TEST_DATABASE_URL

# Policy
npm run policy:build      # regenerate generated.ts after editing any YAML
npm run policy:check      # fail if the committed artefact is stale

# Database
npm run db:generate       # new migration from the Drizzle schema
npm run db:migrate        # apply (DIRECT_DATABASE_URL, port 5432)
npm run db:doctor         # assert the guarantees are present
npm run db:studio         # browse it

# Running
npm run dev · build · start
npm run dev:inngest       # local Inngest executor, alongside npm run dev
npm run seed:demo -- --reset

# Understanding what it would do
npm run replay                 # what the CURRENT policy table would do to real cases
npm run replay -- --case=<id>  # one case, rung by rung, with the gate's reasoning
npm run dry-run:report         # what would have been sent, and what the gate stopped

# Operating it
npm run queue                            # cases waiting on a person
npm run queue -- --escalate=<caseId>     # queue one now, with a real brief
npm run queue -- --ack=<id> --by=<name>
npm run queue -- --resolve=<id> --note="…"
npm run audit                            # cases lost WITHOUT ever acting, and why
npm run triage                           # propose classes for unknown reasons
npm run triage -- --list                 # pending proposals; none is auto-applied
npm run ai:smoke                         # call all four Claude jobs for real

# Channels
npm run templates:status                     # Meta review status for the 9 templates
npm run templates:submit
npm run send:test -- --to=91XXXXXXXXXX       # one real message, end to end

# Scripts that take flags — npx, not npm run (see the PowerShell note above)
npx tsx scripts/merchant.ts list
npx tsx scripts/merchant.ts mode --slug <merchant> --set paused|live
npx tsx scripts/simulate.ts --list
npx tsx scripts/redrive.ts --dry             # stranded webhook deliveries
npx tsx scripts/redrive.ts                   # reprocess them
npx tsx scripts/redrive.ts --publish         # …and restart ladders for failures
```

---

## Things that will bite you

### A real Razorpay webhook cannot reach your laptop

Every delivery goes to the URL configured in the Razorpay dashboard, which is
the deployed site. Paying a test link while `npm run dev` is running does not
touch your dev server at all: the event lands on production, and **production is
the code that decides what happens to it.**

> A fix that is not deployed does not exist, however green your local tests are.
> The payment arrives, production handles it with the old code, and your local
> console shows nothing — because both are reading the same database and only
> one of them ran.

Three ways to work with that:

- `npx tsx scripts/simulate.ts --url http://localhost:3000` — a properly signed
  payload straight at your dev server. No tunnel, no dashboard change.
- A tunnel (`cloudflared tunnel --url http://localhost:3000`) with the Razorpay
  **test-mode** webhook pointed at it, when you want the real thing.
- Deploy, and test against production with a sandbox merchant.

### `APP_URL` must not be the production host in development

The Inngest route pins its callback origin to `APP_URL` for a real production
reason (the Vercel apex→www redirect). That pin is disabled in dev — without the
fix, a local dev server registered `https://www.vyavas.com/api/inngest`, so every
locally triggered run executed **against the live site** and came back 401. The
local Next log showed nothing at all, because nothing ever reached it.

### Never run `npm run build` while `npm run dev` is up

They share `.next`, and the build rewrites chunk files under the running dev
server. You get a burst of `MODULE_NOT_FOUND` on `_document.js` and
`./vendor-chunks/*.js`, plus `Cannot read properties of undefined (reading '/_app')`,
and every page 500s. Nothing is permanently broken — stop the dev server, then:

```bash
rm -rf .next && npm run dev
```

### `src/middleware.ts` — the location is part of the feature

This project has a `src` directory, so Next.js looks for middleware beside
`app/`. **A middleware at the repository root is silently ignored** — no error,
no warning, `next build` succeeds, and every page serves to anyone. The tell is
the absence of a `Middleware` line in the build output:

```bash
npm run build | grep Middleware
# ƒ Middleware    33.1 kB     <- registered
# (nothing)                   <- NOT registered; the app is wide open
```

Public paths are listed explicitly in that file: the Razorpay, WhatsApp, Vapi
and abandoned-cart webhooks, the Inngest endpoint, and `/api/health`. Each has
its own authentication. Everything else needs a session, so **a page added later
is protected by default**.

### Pooled versus direct connections

- **The app uses the POOLED string (6543); migrations use the DIRECT one (5432).**
  Supavisor's transaction mode cannot hold the session state that DDL and
  advisory locks need.
- **`prepare: false`** in `db/client.ts`. Supavisor multiplexes clients onto few
  backends, so a prepared statement created on one invocation may not exist on
  the backend the next one lands on. Leaving it on produces intermittent
  failures that appear only under concurrency — during a merchant's outage, when
  it matters most.
- **Session mode caps concurrent clients at 15** on the default plan, and
  exceeding it is a FATAL `EMAXCONNSESSION` rather than a queue. That is the
  hard argument for transaction mode with `max: 1` per invocation.

### When a webhook delivery gets stranded

The endpoint *claims* a delivery before processing it, which is what makes
at-least-once delivery safe to receive twice. The cost is that a claim outlives
the process that made it: if the function dies between the claim and the
"processed" mark, the row sits marked as seen, dedupe turns Razorpay's own retry
into a no-op, and the event is lost silently — with no error recorded, because
whatever would have recorded one died too.

`sweep-deadlines` redrives every fifteen minutes. On demand, use
`scripts/redrive.ts`. `--publish` is off by default because reprocessing a
`payment.failed` starts a ladder, and a terminal is the wrong place to do that
by accident. Success events only ever close cases, so clearing a backlog of
those needs no publisher.

### SMS is not a channel

`CHANNELS` still contains `sms` because it is the source of a Postgres enum and
`message_log` holds rows naming it. But `policy/schema.ts` validates a rung's
channels against a **narrower** list, so a YAML edit naming SMS fails the build
rather than failing at 3am. Transactional SMS in India requires DLT registration
of the sender header and of every template, and that has not been done. Its
absence used to be invisible: `send.ts` returned `no_channel` and the touch was
lost silently.

---

## Non-negotiables

- **Money is integer paise.** Never a float. Anywhere. The type makes
  `amount + 0.5` a compile error.
- **`attended` is decided explicitly on every case.** Under RBI rules there is
  no lawful silent card retry in India without a mandate. Getting this wrong is
  a compliance incident, not a bug.
- **`order_already_paid` closes the case and cancels everything queued.**
  Messaging someone who has already paid is the one mistake that ends the
  relationship.
- **A deliberate exit is never dressed as a failure.** `payment_cancelled` is a
  live intent signal; it gets its own case type and never sees failure language.
- **Risk declines get one touch on one alternate rail.** Re-presenting raises the
  risk score and degrades the merchant's authorisation rate.
- **Merchant-fault classes alert the merchant with facts, not prescriptions.**
  Turning off a payment method is their commercial decision, not ours.
- **No card data is ever stored.** Under the RBI tokenisation mandate we hold
  Razorpay tokens, never PANs. Provider secrets are encrypted with
  `ENCRYPTION_KEY` before they are written to the database.

---

## Further reading

The code is the source of truth; where a document and the code disagree, the
code is right and the document is a bug.

| Document | Answers |
|---|---|
| [How it works](docs/01-how-it-works.md) | What happens between a failed payment and a recovered one |
| [Failure scenarios](docs/02-failure-scenarios.md) | All 44 failure reasons, the 9 classes, and what each one does |
| [Where the AI is](docs/03-ai.md) | What Claude does, what it is forbidden from doing, and why |
| [Safety and guarantees](docs/04-safety.md) | The invariants, and what enforces each one |
| [Operating it](docs/05-operations.md) | Commands, verification, and what to check when something looks wrong |
| [Regions](REGIONS.md) | Why ap-south-1, and what depends on it |
